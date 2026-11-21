// index.js - the app server.
// -----------------------------------------------------------------------------
//   /            -> the PWA (static files from app/)
//   /comfy/*     -> reverse proxy to ComfyUI (HTTP + websocket), see proxy.js
//   /api/config     GET   app settings + whether ComfyUI answers
//   /api/workflows  GET   presets with detected controls; POST import (multipart or JSON)
//   /api/history    GET   sessions -> entries; POST add entry
//   /api/history/:id PATCH favourite / images / status
//   /api/events     GET   Server-Sent Events ("workflows" when the folder changes)
//   /share          POST  Android share target
//   /ollama/*       -> allow-listed proxy to a local Ollama (Chat tab), see ollama.js
//   /api/chats      GET list, POST create; /api/chats/:id GET, PUT/PATCH, DELETE
//   /api/ollama/unload POST  unload Ollama models (keep_alive 0) now
//   /api/memory     GET   detected GPU/RAM, active memory profile, chat model fit (?fresh=1)
//   /api/memory/profile PUT {profile:'auto'|id}  the app's override (data/memory-profile.json)
//   /api/memory/before-queue POST {workflow}  unload Ollama if this profile/free VRAM says so
//   /api/memory/before-chat  POST {model}     fit check; maybe ComfyUI /free first (small GPU)
//   /api/memory/free-for-chat POST           OOM fallback: ComfyUI /free per profile
//   /api/actions    GET   workflow actions (workflows/actions/*.json) for the Chat
//   /api/workflows?fresh=1 also lists the AI Workflow presets (workflows/ai/*.json,
//                   availability computed live from ComfyUI /object_info + model
//                   lists + GPU/RAM) and the user's saved builder setups
//   /api/builder/propose POST {text, history, model}  chat builder: Ollama proposes blocks, server validates
//   /api/builder/check   POST {blocks, name, test}    re-validate (Test run gets the graph)
//   /api/builder/config  GET / PUT {model}            builder model (data/builder.json)
//   /api/user-presets    GET, POST {name, blocks}; /api/user-presets/:id PATCH {name}, DELETE
//   /scripts/* /extensions/* /assets/* -> ComfyUI too (custom-node extensions
//                   that import from the ComfyUI root instead of /comfy/)
// Binds 127.0.0.1 only. Remote access = `tailscale serve` in front of it.
// -----------------------------------------------------------------------------
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, probeComfy, ROOT } from './config.js';
import { createComfyProxy } from './proxy.js';
import { serveStatic } from './static.js';
import { WorkflowStore } from './workflows.js';
import { HistoryStore } from './history.js';
import { ChatStore } from './chats.js';
import { createOllama } from './ollama.js';
import { ActionStore } from './actions.js';
import { createHardware } from './hardware.js';
import { createMemory } from './memory.js';
import { handleShare } from './share.js';
import { readBody, parseMultipart } from './multipart.js';
import { createComfyInfo } from './comfy-info.js';
import { PresetStore } from './presets.js';
import { UserPresetStore } from './user-presets.js';
import { createBuilder } from './builder.js';
import { detectControls } from '../app/js/lib/workflow-detect.js';
import { vramFit } from '../app/js/lib/presets.js';
import { splitOutputs } from '../app/js/lib/outputs.js';

const GROUP_OF = { image: 'Image', '3d': '3D', video: 'Video', audio: 'Audio' };

const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };

export function createApp(cfg, { runSmi, os, env } = {}) {
  const appDir = path.join(ROOT, 'app');
  const workflows = new WorkflowStore(cfg.workflowsDir);
  const history = new HistoryStore(cfg.dataDir, { sessionGapMinutes: cfg.sessionGapMinutes });
  const proxy = createComfyProxy(() => cfg.comfyUrl);
  // Some ComfyUI custom-node extensions import "/scripts/app.js" or call
  // "/api/<their-route>" from the ComfyUI root instead of relative to the page,
  // which under /comfy/ would hit this app. Forward those unchanged.
  const rootProxy = createComfyProxy(() => cfg.comfyUrl, '');
  const chats = new ChatStore(cfg.dataDir);
  const ollama = createOllama(() => cfg.ollamaUrl);
  const actions = new ActionStore(path.join(cfg.workflowsDir, 'actions'));
  const hardware = createHardware({ getComfyUrl: () => cfg.comfyUrl, ...(runSmi ? { runSmi } : {}), ...(os ? { os } : {}) });
  const memory = createMemory({ cfg, hardware, ollama, getComfyUrl: () => cfg.comfyUrl, ...(env ? { env } : {}) });
  const comfyInfo = createComfyInfo({ getComfyUrl: () => cfg.comfyUrl });
  const presets = new PresetStore(path.join(cfg.workflowsDir, 'ai'));
  const userPresets = new UserPresetStore(cfg.dataDir);
  const builder = createBuilder({ cfg, comfyInfo, presets, memory, hardware });
  const sseClients = new Set();

  // Everything the preset picker shows: folder presets, AI Workflow presets
  // (live availability) and saved builder setups (re-validated live).
  async function allWorkflows({ fresh = false } = {}) {
    const info = await comfyInfo.get({ fresh });
    const hw = await hardware.detect();
    let profileId; try { profileId = (await memory.status()).profile.id; } catch {}
    const hwOpts = { gpuTotalMB: hw.gpu?.totalMB, ramFreeMB: hw.ram?.freeMB };
    const ai = presets.list(info, hwOpts, { profileId });
    const mine = await Promise.all(userPresets.list().map(async (u) => {
      const base = { id: `user:${u.id}`, file: null, label: u.name, group: 'My presets', user: { id: u.id, name: u.name, blocks: u.blocks, output: u.output } };
      if (!info.objectInfo) return { ...base, ok: true, workflow: null, availability: { status: 'unknown', label: 'ComfyUI offline', reason: 'ComfyUI is not reachable' } };
      const r = await builder.check({ blocks: u.blocks, name: u.name });
      if (!r.ok) return { ...base, ok: true, workflow: null, availability: { status: 'unavailable', label: 'unavailable', reason: r.errors.join(' ') } };
      return { ...base, ok: true, workflow: r.graph, controls: detectControls(r.graph), description: r.summary.join(' · '), output: r.output, ai: { output: r.output, params: {}, size: null, maxBatch: r.output === 'image' ? 8 : 2, vram: { estMB: r.estMB }, promptFormat: r.blocks.some((b) => b.type === 'audio' && b.params.engine === 'vibevoice') ? { unless: '\\[\\d+\\]|Speaker \\d+:', template: '[1] {text}' } : null }, availability: { ...vramFit({ estMB: r.estMB, ...hwOpts, profileId }), estMB: r.estMB } };
    }));
    return { workflows: [...workflows.list(), ...ai, ...mine], comfy: { reachable: !!info.objectInfo, error: info.error || null } };
  }
  async function estMBFor(id) {
    if (id.startsWith('ai:')) { const p = presets.get(id); return p ? (p.manifest.vram.measuredMB || p.manifest.vram.estMB) : undefined; }
    if (id.startsWith('user:')) { const u = userPresets.get(id); if (!u) return undefined; const r = await builder.check({ blocks: u.blocks, name: u.name }); return r.estMB; }
    if (id.startsWith('builder:')) return undefined;
    return undefined;
  }
  workflows.on('change', () => { for (const r of sseClients) r.write('event: workflows\ndata: {}\n\n'); });

  // If a browser lost track of a job (phone slept, tab closed), the history
  // entry has a promptId but no images. Ask ComfyUI's GET /history/<id>,
  // which keeps finished jobs' outputs, and fill them in.
  async function resolvePending() {
    const pend = history.pending().filter((e) => Date.now() - e.createdAt < 7 * 864e5).slice(-20);
    await Promise.all(pend.map(async (e) => {
      try {
        const r = await fetch(`${cfg.comfyUrl}/history/${encodeURIComponent(e.promptId)}`, { signal: AbortSignal.timeout(1500) });
        if (!r.ok) return;
        const h = (await r.json())[e.promptId];
        if (!h) return;
        const { images, files } = splitOutputs(h.outputs);
        if (images.length || files.length) await history.update(e.id, { images, files, status: 'done' });
        else if (h.status?.status_str === 'error') await history.update(e.id, { status: 'error' });
      } catch { /* ComfyUI offline: leave as is */ }
    }));
  }

  async function api(req, res, url) {
    const p = url.pathname;
    if (p === '/api/config' && req.method === 'GET') {
      const probe = await probeComfy({ ...cfg, comfyUrlExplicit: true }, 1500);
      return json(res, 200, { comfyUrl: cfg.comfyUrl, comfyReachable: probe.ok, comfyStats: probe.stats || null, outputSubfolder: cfg.outputSubfolder, sessionGapMinutes: cfg.sessionGapMinutes });
    }
    if (p === '/api/workflows' && req.method === 'GET') return json(res, 200, await allWorkflows({ fresh: url.searchParams.get('fresh') === '1' }));
    // ---- Chat builder + saved setups ----
    if (p.startsWith('/api/builder/') || p.startsWith('/api/user-presets')) {
      let body = {};
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        try { const t = (await readBody(req, 256 * 1024)).toString('utf8'); body = t ? JSON.parse(t) : {}; } catch { return json(res, 400, { error: 'Bad JSON' }); }
      }
      if (p === '/api/builder/config' && req.method === 'GET') return json(res, 200, builder.config());
      if (p === '/api/builder/config' && req.method === 'PUT') { try { return json(res, 200, builder.setModel(body.model)); } catch (e) { return json(res, e.status || 500, { error: e.message }); } }
      if (p === '/api/builder/propose' && req.method === 'POST') return json(res, 200, await builder.propose({ text: body.text, history: Array.isArray(body.history) ? body.history : [], model: body.model }));
      if (p === '/api/builder/check' && req.method === 'POST') return json(res, 200, await builder.check({ blocks: body.blocks, name: body.name, test: !!body.test }));
      if (p === '/api/user-presets' && req.method === 'GET') return json(res, 200, { presets: userPresets.list() });
      if (p === '/api/user-presets' && req.method === 'POST') {
        const r = await builder.check({ blocks: body.blocks, name: body.name });
        if (!r.ok) return json(res, 422, { error: r.errors.join(' '), errors: r.errors });
        const u = await userPresets.add({ name: body.name, blocks: r.blocks, output: r.output });
        for (const c of sseClients) c.write('event: workflows\ndata: {}\n\n');
        return json(res, 201, { ...u, id: `user:${u.id}` });
      }
      let dp = p; try { dp = decodeURIComponent(p); } catch {}
      const um = /^\/api\/user-presets\/(?:user:)?([\w-]+)$/.exec(dp);
      if (um && req.method === 'PATCH') { try { const u = await userPresets.rename(um[1], body.name); if (!u) return json(res, 404, { error: 'Not found' }); for (const c of sseClients) c.write('event: workflows\ndata: {}\n\n'); return json(res, 200, { ...u, id: `user:${u.id}` }); } catch (e) { return json(res, e.status || 500, { error: e.message }); } }
      if (um && req.method === 'DELETE') { const ok = await userPresets.remove(um[1]); if (ok) for (const c of sseClients) c.write('event: workflows\ndata: {}\n\n'); return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Not found' }); }
      return json(res, 404, { error: 'Unknown API route' });
    }
    if (p === '/api/workflows' && req.method === 'POST') {
      const body = await readBody(req, 10 * 1024 * 1024);
      const ct = req.headers['content-type'] || '';
      let name = url.searchParams.get('name') || 'imported.json', text;
      if (ct.startsWith('multipart/')) {
        const f = parseMultipart(body, ct).find((x) => x.filename);
        if (!f) return json(res, 400, { error: 'No file in upload' });
        name = f.filename; text = f.data.toString('utf8');
      } else text = body.toString('utf8');
      try { return json(res, 201, workflows.import(name, text)); } catch (e) { return json(res, e.status || 500, { error: e.message }); }
    }
    if (p === '/api/history' && req.method === 'GET') {
      await resolvePending();
      return json(res, 200, { sessions: history.list({ favoritesOnly: url.searchParams.get('favorites') === '1' }) });
    }
    if (p === '/api/history' && req.method === 'POST') {
      let body;
      try { body = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8')); } catch { return json(res, 400, { error: 'Bad JSON' }); }
      return json(res, 201, await history.add(body));
    }
    const m = /^\/api\/history\/([\w-]+)$/.exec(p);
    if (m && (req.method === 'PATCH' || req.method === 'POST')) {
      let body;
      try { body = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8')); } catch { return json(res, 400, { error: 'Bad JSON' }); }
      const e = await history.update(m[1], body);
      return e ? json(res, 200, e) : json(res, 404, { error: 'Not found' });
    }
    // ---- Chat tab ----
    if (p === '/api/chats' && req.method === 'GET') return json(res, 200, { chats: chats.list() });
    if (p === '/api/chats' && req.method === 'POST') {
      let body;
      try { body = JSON.parse((await readBody(req, 4 * 1024 * 1024)).toString('utf8') || '{}'); } catch { return json(res, 400, { error: 'Bad JSON' }); }
      return json(res, 201, await chats.create(body));
    }
    const cm = /^\/api\/chats\/([\w-]+)$/.exec(p);
    if (cm) {
      if (req.method === 'GET') { const c = chats.get(cm[1]); return c ? json(res, 200, c) : json(res, 404, { error: 'Not found' }); }
      if (req.method === 'DELETE') return (await chats.remove(cm[1])) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Not found' });
      if (req.method === 'PUT' || req.method === 'PATCH') {
        let body;
        try { body = JSON.parse((await readBody(req, 4 * 1024 * 1024)).toString('utf8')); } catch { return json(res, 400, { error: 'Bad JSON' }); }
        const c = await chats.update(cm[1], body);
        return c ? json(res, 200, c) : json(res, 404, { error: 'Not found' });
      }
    }
    if (p === '/api/actions' && req.method === 'GET') return json(res, 200, { actions: actions.list() });
    if (p === '/api/ollama/unload' && req.method === 'POST') return json(res, 200, await ollama.unloadAll());
    if (p === '/api/memory' && req.method === 'GET') return json(res, 200, await memory.status({ fresh: url.searchParams.has('fresh') }));
    if (p.startsWith('/api/memory/') && req.method === 'PUT' || req.method === 'POST' && p.startsWith('/api/memory/')) {
      let body = {};
      try { const t = (await readBody(req, 64 * 1024)).toString('utf8'); body = t ? JSON.parse(t) : {}; } catch { return json(res, 400, { error: 'Bad JSON' }); }
      if (p === '/api/memory/profile' && req.method === 'PUT') { memory.setSetting(String(body.profile || 'auto')); return json(res, 200, await memory.status()); }
      if (p === '/api/memory/before-queue') { const id = String(body.workflow || 'default'); return json(res, 200, await memory.beforeQueue(id, { estMB: await estMBFor(id) })); }
      if (p === '/api/memory/before-chat') return json(res, 200, await memory.beforeChat(String(body.model || '')));
      if (p === '/api/memory/free-for-chat') return json(res, 200, await memory.freeForChat());
    }
    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 5000\n\n');
      sseClients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
      return;
    }
    if (fromComfyPage(req)) return rootProxy.web(req, res); // a ComfyUI extension's own /api route
    return json(res, 404, { error: 'Unknown API route' });
  }

  // True when the request comes from the proxied ComfyUI frontend (/comfy/...).
  function fromComfyPage(req) {
    try { return new URL(req.headers.referer).pathname.startsWith('/comfy/'); } catch { return false; }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/comfy' ) { res.writeHead(301, { Location: '/comfy/' }); return res.end(); }
      if (url.pathname.startsWith('/comfy/')) return proxy.web(req, res);
      if (url.pathname.startsWith('/ollama/')) return ollama.web(req, res);
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (url.pathname === '/share' && req.method === 'POST') return await handleShare(req, res, cfg);
      // Browsers ask for /favicon.ico regardless of <link rel=icon>; answer with the app icon.
      if (url.pathname === '/favicon.ico') req.url = '/icons/icon-192.png';
      if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(appDir, req, res)) return;
      // ComfyUI root paths used by custom-node extensions (the app has no such folders).
      if (/^\/(scripts|extensions|assets)\//.test(url.pathname)) return rootProxy.web(req, res);
      // Unknown paths in the app (e.g. "/?ref=..") fall back to index.html.
      if (req.method === 'GET' && !path.extname(url.pathname)) { req.url = '/'; if (serveStatic(appDir, req, res)) return; }
      json(res, 404, { error: 'Not found' });
    } catch (e) {
      if (!res.headersSent) json(res, e.status || 500, { error: e.message });
      else res.end();
    }
  });
  // Upgraded (websocket) sockets are no longer tracked by the http server, so
  // keep them ourselves to be able to shut down cleanly.
  const upgraded = new Set();
  server.on('upgrade', (req, socket, head) => {
    upgraded.add(socket); socket.on('close', () => upgraded.delete(socket));
    if (req.url.startsWith('/comfy/')) proxy.upgrade(req, socket, head);
    else socket.destroy();
  });
  const close = server.close.bind(server);
  server.close = (cb) => {
    workflows.close();
    for (const r of sseClients) r.end();
    for (const sock of upgraded) sock.destroy();
    server.closeAllConnections?.();
    return close(cb);
  };
  return { server, workflows, history, chats, memory, hardware, cfg, presets, userPresets, builder, comfyInfo };
}

// Run directly: `node server/index.js` / `npm start` / start.bat
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig();
  const probe = await probeComfy(cfg);
  if (probe.ok) cfg.comfyUrl = probe.url;
  const { server, memory } = createApp(cfg);
  server.listen(cfg.port, cfg.host, () => {
    console.log(`Comfy UI app:       http://${cfg.host}:${cfg.port}/`);
    console.log(`ComfyUI target:     ${cfg.comfyUrl}  (${probe.ok ? 'reachable' : 'NOT reachable yet - start Comfy Desktop'})`);
    console.log(`Workflows folder:   ${cfg.workflowsDir}`);
    memory.status({ fresh: true }).then((s) => console.log(`GPU / RAM:          ${s.hardware.gpu ? `${s.hardware.gpu.name} ${s.hardware.gpu.totalMB} MiB (${s.hardware.gpu.source})` : 'no GPU detected'} / ${s.hardware.ram.totalMB} MiB RAM -> memory profile "${s.profile.id}" (${s.profile.source})`)).catch(() => {});
    console.log(`Remote access:      tailscale serve --bg ${cfg.port}`);
  });
}
