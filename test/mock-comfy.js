// mock-comfy.js - a fake ComfyUI for development and tests.
// -----------------------------------------------------------------------------
// Implements the endpoints the app uses, with the same shapes as real
// ComfyUI, so the app code cannot tell the difference:
//   POST /prompt {prompt, client_id}  -> {prompt_id, number, node_errors}
//   GET  /ws?clientId=..              -> websocket: status, execution_start,
//        executing{node}, progress{value,max}, executed{output.images},
//        executing{node:null}, execution_success / execution_interrupted
//   GET  /history/<id>, /history      GET /view?filename&subfolder&type
//   POST /upload/image (multipart)    GET/POST /queue   POST /interrupt
//   GET  /system_stats                GET / (a stub "ComfyUI" page)
//   GET  /object_info, /models, /models/<folder>  (fixtures trimmed from the
//        real ComfyUI 0.46.2 on the PC: test/fixtures/object-info.json,
//        models.json), GET /internal/folder_paths ({} unless given)
//   SaveImage / SaveGLB / Save3DAdvanced / SaveVideo / SaveAudio outputs
// Plus test helpers: GET /mock/requests (headers seen), POST /mock/reset.
// Like real ComfyUI it rejects requests whose Origin does not match Host.
// Images are generated placeholder PNGs (colour from the seed).
// -----------------------------------------------------------------------------
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from '../scripts/png.js';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { readBody, parseMultipart } from '../server/multipart.js';

import { makeGlb, makeWav, makeVideo } from './fixtures/media.js';
const GLB = makeGlb(), WAV = makeWav(), VIDEO = makeVideo();
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

export function createMockComfy({ stepMs = Number(process.env.MOCK_STEP_MS) || 120, imageScale = 0.25, objectInfo = fixture('object-info.json'), models = fixture('models.json'), folderPaths = {} } = {}) {
  const files = new Map();        // "type/subfolder/filename" -> Buffer
  const history = {};             // prompt_id -> history record
  const queue = [];               // pending jobs
  let running = null;
  let counter = 0, imgCounter = 0;
  const sockets = new Map();      // clientId -> Set<socket>
  const requests = [];

  // ---- minimal websocket (server side) ----------------------------------
  function wsSend(sock, obj) {
    const payload = Buffer.from(JSON.stringify(obj));
    let header;
    if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
    else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
    try { sock.write(Buffer.concat([header, payload])); } catch {}
  }
  function emit(clientId, type, data) {
    // Real ComfyUI sends job events to the client that queued it (client_id),
    // and "status" to everyone.
    const targets = clientId && sockets.has(clientId) ? sockets.get(clientId) : (type === 'status' ? [...sockets.values()].flatMap((s) => [...s]) : []);
    for (const s of targets) wsSend(s, { type, data });
  }
  function broadcastStatus() {
    for (const set of sockets.values()) for (const s of set) wsSend(s, { type: 'status', data: { status: { exec_info: { queue_remaining: queue.length + (running ? 1 : 0) } } } });
  }

  // ---- job runner ----------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function runNext() {
    if (running || !queue.length) return;
    running = queue.shift();
    const job = running;
    const { prompt_id: pid, prompt: wf, client_id: cid } = job;
    broadcastStatus();
    emit(cid, 'execution_start', { prompt_id: pid, timestamp: Date.now() });
    const ids = Object.keys(wf);
    const findNum = (keys) => { for (const n of Object.values(wf)) for (const k of keys) if (typeof n.inputs?.[k] === 'number') return n.inputs[k]; };
    const steps = findNum(['steps']) || 4;
    let w = findNum(['width']) || 1024, h = findNum(['height']) || 1024;
    const seed = findNum(['seed', 'noise_seed']) || 0;
    const sampler = ids.find((id) => /Sampler(Custom)?Advanced|KSampler$/.test(wf[id].class_type)) || ids[0];
    const outputs = ids.filter((id) => ['SaveImage', 'PreviewImage', 'SaveGLB', 'Save3DAdvanced', 'SaveVideo', 'SaveAudio'].includes(wf[id].class_type));
    try {
      for (const id of ids) {
        if (job.interrupted) throw new Error('interrupted');
        emit(cid, 'executing', { node: id, display_node: id, prompt_id: pid });
        if (id === sampler) {
          for (let i = 1; i <= steps; i++) {
            await sleep(stepMs);
            if (job.interrupted) throw new Error('interrupted');
            emit(cid, 'progress', { value: i, max: steps, prompt_id: pid, node: id });
          }
        }
      }
      const out = {};
      for (const id of outputs) {
        // GLB, audio and video results are real, tiny files (a cube; a tone; a 2 s clip) so the viewers can load them.
        const fileOut = { SaveGLB: ['3d', 'glb', GLB], Save3DAdvanced: ['3d', 'glb', GLB], SaveVideo: ['images', 'mp4', VIDEO], SaveAudio: ['audio', 'flac', WAV] }[wf[id].class_type];
        if (fileOut) {
          // Like real ComfyUI 0.46: SaveGLB -> {"3d": [...]}, SaveVideo -> {images: [...], animated: [true]}, SaveAudio -> {audio: [...]}.
          const prefix = String(wf[id].inputs.filename_prefix || 'out');
          const subfolder = prefix.includes('/') ? prefix.split('/').slice(0, -1).join('/') : '';
          const filename = `${prefix.split('/').pop()}_${String(++imgCounter).padStart(5, '0')}_.${fileOut[1]}`;
          files.set(`output/${subfolder}/${filename}`, Buffer.isBuffer(fileOut[2]) ? fileOut[2] : Buffer.from(fileOut[2]));
          out[id] = { [fileOut[0]]: [{ filename, subfolder, type: 'output' }] };
          if (fileOut[1] === 'mp4') out[id].animated = [true];
          emit(cid, 'executed', { node: id, display_node: id, output: out[id], prompt_id: pid });
          continue;
        }
        const type = wf[id].class_type === 'SaveImage' ? 'output' : 'temp';
        const prefix = String(wf[id].inputs.filename_prefix || 'ComfyUI');
        const subfolder = prefix.includes('/') ? prefix.split('/').slice(0, -1).join('/') : '';
        const filename = `${prefix.split('/').pop()}_${String(++imgCounter).padStart(5, '0')}_.png`;
        const [r0, g0, b0] = [seed % 256, (seed >> 8) % 256, (seed >> 16) % 256];
        const sw = Math.max(16, Math.round(w * imageScale)), sh = Math.max(16, Math.round(h * imageScale));
        const png = encodePng(sw, sh, (x, y) => [(r0 + x) % 256, (g0 + y) % 256, (b0 + ((x ^ y) & 32 ? 80 : 0)) % 256]);
        files.set(`${type}/${subfolder}/${filename}`, png);
        out[id] = { images: [{ filename, subfolder, type }] };
        emit(cid, 'executed', { node: id, display_node: id, output: out[id], prompt_id: pid });
      }
      history[pid] = { prompt: [job.number, pid, wf, {}, outputs], outputs: out, status: { status_str: 'success', completed: true, messages: [] } };
      emit(cid, 'executing', { node: null, prompt_id: pid });
      emit(cid, 'execution_success', { prompt_id: pid, timestamp: Date.now() });
    } catch {
      history[pid] = { prompt: [job.number, pid, wf, {}, outputs], outputs: {}, status: { status_str: 'error', completed: false, messages: [['execution_interrupted', {}]] } };
      emit(cid, 'execution_interrupted', { prompt_id: pid, node_id: sampler, timestamp: Date.now() });
    }
    running = null;
    broadcastStatus();
    runNext();
  }

  const json = (res, s, b) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    requests.push({ t: Date.now(), method: req.method, path: url.pathname, headers: { ...req.headers } });
    if (requests.length > 200) requests.shift();
    // Same protection as real ComfyUI: Origin host must equal Host.
    if (req.headers.origin) {
      try { if (new URL(req.headers.origin).host !== req.headers.host) return json(res, 403, { error: 'origin mismatch' }); } catch { return json(res, 403, {}); }
    }
    const p = url.pathname;
    if (p === '/system_stats') return json(res, 200, { system: { os: 'mock', comfyui_version: 'mock-0.0', python_version: '3' }, devices: [{ name: 'mock-gpu', type: 'cuda', vram_total: 1, vram_free: 1 }] });
    if (p === '/prompt' && req.method === 'POST') {
      let body;
      try { body = JSON.parse((await readBody(req)).toString()); } catch { return json(res, 400, { error: { type: 'invalid_prompt', message: 'bad json' } }); }
      const wf = body.prompt;
      if (!wf || typeof wf !== 'object') return json(res, 400, { error: { type: 'invalid_prompt', message: 'no prompt' }, node_errors: {} });
      for (const [id, n] of Object.entries(wf)) if (!n?.class_type) return json(res, 400, { error: { type: 'invalid_prompt', message: `Cannot execute because node ${id} has no class_type` }, node_errors: {} });
      if (!Object.values(wf).some((n) => /^(Save|Preview)/.test(n.class_type))) return json(res, 400, { error: { type: 'prompt_no_outputs', message: 'Prompt has no outputs' }, node_errors: {} });
      const job = { prompt_id: crypto.randomUUID(), number: counter++, prompt: wf, client_id: body.client_id };
      queue.push(job);
      broadcastStatus();
      setImmediate(runNext);
      return json(res, 200, { prompt_id: job.prompt_id, number: job.number, node_errors: {} });
    }
    if (p === '/queue' && req.method === 'GET') {
      const row = (j) => [j.number, j.prompt_id, j.prompt, { client_id: j.client_id }, []];
      return json(res, 200, { queue_running: running ? [row(running)] : [], queue_pending: queue.map(row) });
    }
    if (p === '/queue' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      if (body.clear) queue.length = 0;
      if (Array.isArray(body.delete)) for (const id of body.delete) { const i = queue.findIndex((j) => j.prompt_id === id); if (i >= 0) queue.splice(i, 1); }
      broadcastStatus();
      return json(res, 200, {});
    }
    if (p === '/interrupt' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      if (running && (!body.prompt_id || body.prompt_id === running.prompt_id)) running.interrupted = true;
      res.writeHead(200).end();
      return;
    }
    if (p === '/history') return json(res, 200, history);
    if (p.startsWith('/history/')) { const id = decodeURIComponent(p.slice(9)); return json(res, 200, history[id] ? { [id]: history[id] } : {}); }
    if (p === '/view') {
      const key = `${url.searchParams.get('type') || 'output'}/${url.searchParams.get('subfolder') || ''}/${url.searchParams.get('filename')}`;
      const f = files.get(key);
      if (!f) return json(res, 404, { error: 'not found', key });
      const head = f.subarray(0, 4).toString('latin1');
      const type = head === '\x1aE\xdf\xa3' ? 'video/webm' : head === 'RIFF' ? 'audio/wav' : head === 'glTF' ? 'model/gltf-binary' : head === '\x89PNG' ? 'image/png' : 'application/octet-stream';
      // Range requests like ComfyUI's aiohttp file responses (the audio player seeks with them).
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (m && (m[1] || m[2])) {
        const start = m[1] ? Number(m[1]) : Math.max(0, f.length - Number(m[2])), end = m[1] && m[2] ? Math.min(Number(m[2]), f.length - 1) : f.length - 1;
        if (start >= f.length || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${f.length}` }); return res.end(); }
        res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${f.length}`, 'Accept-Ranges': 'bytes' });
        return res.end(f.subarray(start, end + 1));
      }
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': f.length, 'Accept-Ranges': 'bytes' });
      return res.end(f);
    }
    if (p === '/upload/image' && req.method === 'POST') {
      const parts = parseMultipart(await readBody(req), req.headers['content-type']);
      const img = parts.find((x) => x.name === 'image' && x.filename);
      if (!img) return json(res, 400, { error: 'no image' });
      const subfolder = parts.find((x) => x.name === 'subfolder')?.data.toString() || '';
      let name = path.basename(img.filename), i = 1;
      while (files.has(`input/${subfolder}/${name}`)) name = `${path.parse(img.filename).name} (${i++})${path.extname(img.filename)}`;
      files.set(`input/${subfolder}/${name}`, img.data);
      return json(res, 200, { name, subfolder, type: 'input' });
    }
    if (p === '/object_info' && objectInfo) return json(res, 200, objectInfo);
    if (p.startsWith('/object_info/') && objectInfo) { const c = decodeURIComponent(p.slice(13)); return json(res, 200, objectInfo[c] ? { [c]: objectInfo[c] } : {}); }
    if (p === '/models' && models) return json(res, 200, ['custom_nodes', 'configs', ...Object.keys(models)]);
    if (p.startsWith('/models/') && models) return json(res, 200, models[decodeURIComponent(p.slice(8))] || []);
    if (p === '/internal/folder_paths') return json(res, 200, JSON.stringify(folderPaths));
    if (p === '/free' && req.method === 'POST') { await readBody(req, 1e5).catch(() => {}); return json(res, 200, {}); }
    if (p === '/mock/requests') return json(res, 200, requests);
    if (p === '/mock/state') return json(res, 200, { queue: queue.length, running: running?.prompt_id || null, files: [...files.keys()] });
    if (p === '/' || p === '/index.html') {
      // A stand-in for ComfyUI's frontend: a top bar with an "Agent" button, an
      // "unsaved changes" beforeunload prompt, and (after 300 ms) a Comfy Agent
      // error toast next to an ordinary one, like the real PrimeVue toasts.
      // Served gzip-compressed when the client accepts it (like aiohttp can).
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>ComfyUI (mock)</title>
<style>body{margin:0;font:14px sans-serif;background:#202020;color:#ddd}.comfyui-body-top{display:flex;gap:8px;padding:6px;background:#353535}.graph{height:300px}</style></head>
<body><div class="comfyui-body-top"><span class="workflow-tab">Unsaved Workflow</span><button class="p-button" aria-label="Queue">Queue</button><button class="p-button"><span class="p-button-label">Agent</span></button></div>
<h1>Mock ComfyUI</h1><p>The real ComfyUI web UI appears here.</p><div class="graph" id="graph">graph canvas</div>
<div class="p-toast p-component" id="toasts"></div>
<script>
window.__unloadPrompt = 0;
window.addEventListener('beforeunload', function (e) { window.__unloadPrompt++; e.preventDefault(); e.returnValue = ''; });
setTimeout(function () {
  var t = document.getElementById('toasts');
  t.insertAdjacentHTML('beforeend', '<div class="p-toast-message p-toast-message-error" role="alert"><div class="p-toast-summary">Comfy Agent error</div><div class="p-toast-detail">Comfy Agent hit a server error</div></div>');
  t.insertAdjacentHTML('beforeend', '<div class="p-toast-message p-toast-message-info" role="alert"><div class="p-toast-summary">Queued</div><div class="p-toast-detail">Prompt queued</div></div>');
}, 300);
</script></body></html>`;
      const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      const body = gz ? gzipSync(html) : Buffer.from(html);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, ...(gz ? { 'Content-Encoding': 'gzip' } : {}), 'X-Frame-Options': 'DENY' });
      return res.end(body);
    }
    json(res, 404, { error: 'mock: unknown ' + p });
  });

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws') return socket.destroy();
    requests.push({ method: 'UPGRADE', path: url.pathname, headers: { ...req.headers } });
    if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return;
    }
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const cid = url.searchParams.get('clientId') || crypto.randomUUID();
    if (!sockets.has(cid)) sockets.set(cid, new Set());
    sockets.get(cid).add(socket);
    // Client frames: we only care about "close" (opcode 8).
    socket.on('data', (d) => { if ((d[0] & 0x0f) === 8) { try { socket.end(Buffer.from([0x88, 0])); } catch {} } });
    const drop = () => sockets.get(cid)?.delete(socket);
    socket.on('close', drop); socket.on('error', drop);
    wsSend(socket, { type: 'status', data: { status: { exec_info: { queue_remaining: queue.length } }, sid: cid } });
  });
  const close = server.close.bind(server);
  server.close = (cb) => { for (const set of sockets.values()) for (const s of set) s.destroy(); server.closeAllConnections?.(); return close(cb); };
  return { server, files, history };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.MOCK_PORT || 8188);
  createMockComfy().server.listen(port, '127.0.0.1', () => console.log(`Mock ComfyUI on http://127.0.0.1:${port}`));
}
