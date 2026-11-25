// Batch 4 (server + pure logic): delete fixes (locked files, proxy cleanup,
// output folder lookup), info texts for every exposed setting, Image sub
// sections, the ComfyUI page snippet (Agent toast, canvas tab bar).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStack } from './helpers.js';
import http from 'node:http';
import zlib from 'node:zlib';
import { deleteAppFile, unlinkWithRetry, IN_USE, outputDirFromArgv, comfyOutputDir, createOutputDirCache } from '../../server/outputs.js';
import { createComfyProxy, injectIntoHtml, isPagePath, allowSameOriginFrame } from '../../server/proxy.js';
import { ConnectionBanner, GRACE_MS } from '../../app/js/lib/conn-banner.js';
import { exposedControls, infoFor, GLOSSARY } from '../../app/js/lib/setting-info.js';
import { validatePreset, menuParts, SUBGROUPS } from '../../app/js/lib/presets.js';
import { validateAction } from '../../app/js/lib/actions.js';

function tempOutput() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-del4-'));
  const out = path.join(root, 'output');
  fs.mkdirSync(path.join(out, 'concept-app'), { recursive: true });
  const write = (rel, s = 'x') => { const f = path.join(out, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); return f; };
  return { root, out, write };
}
const busy = (code = 'EBUSY') => Object.assign(new Error(`${code}: resource busy or locked, unlink 'x'`), { code });
const noWait = async () => {};

// ---- 1. locked files ------------------------------------------------------------
test('unlinkWithRetry: EBUSY / EPERM are retried with growing pauses, then a friendly message', async () => {
  const waits = [];
  let calls = 0;
  const r = await unlinkWithRetry('f', { unlink: async () => { calls++; throw busy(); }, wait: async (ms) => { waits.push(ms); } });
  assert.deepEqual(r, { ok: false, reason: IN_USE, code: 'EBUSY' });
  assert.equal(calls, 5);
  assert.deepEqual(waits, [100, 200, 300, 400], '1 s of pauses in total');
  assert.match(IN_USE, /in use.*try again/i);
  // a lock that clears on the third try deletes the file
  calls = 0;
  assert.deepEqual(await unlinkWithRetry('f', { unlink: async () => { if (++calls < 3) throw busy('EPERM'); }, wait: noWait }), { ok: true, deleted: true });
  // other errors are not retried; ENOENT counts as already gone
  calls = 0;
  assert.equal((await unlinkWithRetry('f', { unlink: async () => { calls++; throw Object.assign(new Error('EIO'), { code: 'EIO' }); }, wait: noWait })).ok, false);
  assert.equal(calls, 1);
  assert.deepEqual(await unlinkWithRetry('f', { unlink: async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); }, wait: noWait }), { ok: true, missing: true });
});

test('deleteAppFile: a locked file is reported, not thrown, and stays on disk', async () => {
  const t = tempOutput();
  const f = t.write('concept-app/hunyuan3d_00004_.glb');
  const r = await deleteAppFile({ filename: 'hunyuan3d_00004_.glb', subfolder: 'concept-app', type: 'output' }, { outputDir: t.out, unlink: async () => { throw busy(); }, wait: noWait });
  assert.equal(r.ok, false);
  assert.equal(r.reason, IN_USE);
  assert.ok(fs.existsSync(f));
});

test('API delete: a locked file does not stop the batch; History keeps exactly what is still on disk', async () => {
  const t = tempOutput();
  t.write('concept-app/a.png'); t.write('concept-app/locked.glb'); t.write('concept-app/c1.png'); t.write('concept-app/c2.png');
  const locked = path.join(t.out, 'concept-app', 'locked.glb');
  const unlink = async (p) => { if (path.basename(p) === 'locked.glb' || path.basename(p) === 'c2.png') throw busy(); return fs.promises.unlink(p); };
  const st = await startStack({ outputDir: t.out, appOptions: { unlink, wait: noWait } });
  try {
    const post = (p, b) => fetch(st.base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const img = (filename) => ({ filename, subfolder: 'concept-app', type: 'output' });
    const a = (await post('/api/history', { workflow: 'z', prompt: 'a', images: [img('a.png')] })).body;
    const b = (await post('/api/history', { workflow: 'h', prompt: 'b', files: [img('locked.glb')] })).body;
    const c = (await post('/api/history', { workflow: 'z', prompt: 'c', images: [img('c1.png'), img('c2.png')] })).body;
    const d = (await post('/api/history', { workflow: 'z', prompt: 'd', images: [img('d.png')] })).body; // already gone
    const f = (await post('/api/folders', { name: 'F' })).body;
    await post(`/api/folders/${f.id}/items`, { add: [a.id, b.id, c.id, d.id] });
    const r = await post('/api/history/delete', { ids: [b.id, a.id, c.id, d.id] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.deleted.sort(), [a.id, d.id].sort(), 'the locked file (listed first) did not stop the others');
    assert.deepEqual(r.body.refused.map((x) => [x.id, x.reason]).sort(), [[b.id, IN_USE], [c.id, IN_USE]].sort());
    assert.ok(fs.existsSync(locked));
    assert.equal(fs.existsSync(path.join(t.out, 'concept-app', 'c1.png')), false);
    const entries = (await (await fetch(st.base + '/api/history')).json()).sessions.flatMap((s) => s.entries);
    assert.deepEqual(entries.map((e) => e.id).sort(), [b.id, c.id].sort());
    assert.deepEqual(entries.find((e) => e.id === c.id).images.map((i) => i.filename), ['c2.png'], 'the deleted c1.png left the entry');
    const folders = await (await fetch(st.base + '/api/folders')).json();
    assert.equal(folders.folders[0].count, 2);
  } finally { await st.close(); }
});

// ---- 2. proxy lets go of ComfyUI when the phone disconnects ----------------------
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

test('proxy: a client that disconnects mid-download destroys the upstream request and response', async () => {
  let upstreamClosed, sawRequest;
  const closed = new Promise((r) => { upstreamClosed = r; });
  const got = new Promise((r) => { sawRequest = r; });
  // "ComfyUI" streaming a big file slowly, forever.
  const comfy = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'model/gltf-binary' });
    const t = setInterval(() => res.write(Buffer.alloc(16 * 1024)), 5);
    res.on('close', () => { clearInterval(t); upstreamClosed(); });
    sawRequest();
  });
  const cport = await listen(comfy);
  const proxy = createComfyProxy(() => `http://127.0.0.1:${cport}`);
  const app = http.createServer((req, res) => proxy.web(req, res));
  const aport = await listen(app);
  try {
    const ctrl = new AbortController();
    const r = await fetch(`http://127.0.0.1:${aport}/comfy/view?filename=big.glb`, { signal: ctrl.signal });
    await got;
    const reader = r.body.getReader();
    await reader.read();
    ctrl.abort();
    const t0 = Date.now();
    await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error('upstream still open 3 s after the client left')), 3000))]);
    assert.ok(Date.now() - t0 < 3000);
  } finally {
    comfy.closeAllConnections(); app.closeAllConnections();
    await new Promise((r) => comfy.close(r)); await new Promise((r) => app.close(r));
  }
});

test('proxy: an idle upstream is dropped after idleMs with a 502; a normal response is untouched', async () => {
  const comfy = http.createServer((req, res) => { if (req.url === '/hang') return; res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); });
  const cport = await listen(comfy);
  const proxy = createComfyProxy(() => `http://127.0.0.1:${cport}`, '/comfy', { idleMs: 150 });
  const app = http.createServer((req, res) => proxy.web(req, res));
  const aport = await listen(app);
  try {
    const ok = await fetch(`http://127.0.0.1:${aport}/comfy/x`);
    assert.equal(ok.status, 200); assert.equal(await ok.text(), 'ok');
    const r = await fetch(`http://127.0.0.1:${aport}/comfy/hang`);
    assert.equal(r.status, 502);
    assert.match((await r.json()).detail, /no answer/);
  } finally {
    comfy.closeAllConnections(); app.closeAllConnections();
    await new Promise((r) => comfy.close(r)); await new Promise((r) => app.close(r));
  }
});

// ---- 3. output folder lookup ------------------------------------------------------
test('output folder from ComfyUI argv: spaced and = forms, quotes, --base-directory fallback', () => {
  assert.equal(outputDirFromArgv(['main.py', '--output-directory', '/x/out']), path.resolve('/x/out'));
  assert.equal(outputDirFromArgv(['main.py', '--output-directory=/x/out2', '--port', '8000']), path.resolve('/x/out2'));
  assert.equal(outputDirFromArgv(['main.py', '--output-directory="/x/q"']), path.resolve('/x/q'));
  assert.equal(outputDirFromArgv(['main.py', '--base-directory', '/x/shared', '--port', '8000']), path.resolve('/x/shared', 'output'));
  assert.equal(outputDirFromArgv(['main.py', '--base-directory=/x/shared']), path.resolve('/x/shared', 'output'));
  assert.equal(outputDirFromArgv(['main.py', '--base-directory', '/b', '--output-directory', '/o']), path.resolve('/o'), 'an explicit output folder wins');
  assert.equal(outputDirFromArgv(['main.py', '--output-directory', '--port']), null, 'a flag is not a folder');
  assert.equal(outputDirFromArgv(['main.py']), null);
  assert.equal(outputDirFromArgv(undefined), null);
});

const stats = (argv) => async () => ({ ok: true, json: async () => ({ system: { argv } }) });
const local = { comfyUrl: 'http://127.0.0.1:8188', comfyOutputDir: '' };

test('output folder: config wins; remote ComfyUI gives null; a slow /system_stats waits up to 8 s, not 2 s', async () => {
  assert.equal(await comfyOutputDir({ ...local, comfyOutputDir: '/cfg/out' }, { fetchImpl: async () => { throw new Error('not called'); } }), path.resolve('/cfg/out'));
  assert.equal(await comfyOutputDir({ comfyUrl: 'http://192.168.1.5:8188', comfyOutputDir: '' }, { fetchImpl: stats(['--output-directory', '/o']) }), null);
  let seen;
  const slow = async (url, { signal }) => { seen = signal; await new Promise((r) => setTimeout(r, 2300)); if (signal.aborted) throw signal.reason; return stats(['--output-directory', '/slow'])(); };
  assert.equal(await comfyOutputDir(local, { fetchImpl: slow }), path.resolve('/slow'), 'an answer after 2.3 s is still used');
  assert.ok(seen instanceof AbortSignal);
  // the timeout itself (shortened for the test) falls back to "unknown"
  const logs = [];
  const hang = (url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(signal.reason)));
  assert.equal(await comfyOutputDir(local, { fetchImpl: hang, timeoutMs: 50, log: (m) => logs.push(m) }), null);
  assert.match(logs[0], /took longer than/);
});

test('output folder: the last good value is cached in memory and in data/, and used when ComfyUI does not answer', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-odc-'));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-odo-'));
  const cache = createOutputDirCache(dataDir);
  assert.equal(await comfyOutputDir(local, { fetchImpl: stats(['--base-directory', path.dirname(outDir)]), cache }), path.join(path.dirname(outDir), 'output'));
  assert.equal(await comfyOutputDir(local, { fetchImpl: stats(['--output-directory', outDir]), cache }), outDir);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'comfy-output-dir.json'), 'utf8')).dir, outDir);
  const down = async () => { throw new Error('ECONNREFUSED'); };
  assert.equal(await comfyOutputDir(local, { fetchImpl: down, cache }), outDir, 'memory');
  const again = createOutputDirCache(dataDir); // server restart
  assert.equal(await comfyOutputDir(local, { fetchImpl: down, cache: again }), outDir, 'data/comfy-output-dir.json');
  assert.equal(await comfyOutputDir(local, { fetchImpl: stats(['main.py']), cache: again }), outDir, 'argv without the flags');
  fs.rmSync(outDir, { recursive: true });
  assert.equal(await comfyOutputDir(local, { fetchImpl: down, cache: again }), null, 'a cached folder that no longer exists is not used');
});

test('API delete: output folder found through --base-directory (Comfy Desktop) and kept after ComfyUI goes quiet', async () => {
  const t = tempOutput();
  t.write('concept-app/one.png'); t.write('concept-app/two.png');
  let up = true;
  const fetchImpl = async (url, o) => (String(url).endsWith('/system_stats') ? (up ? stats(['main.py', `--base-directory=${t.root}`])() : Promise.reject(new Error('down'))) : fetch(url, o));
  const st = await startStack({ outputDir: null, appOptions: { fetchImpl } });
  try {
    const post = (p, b) => fetch(st.base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const one = (await post('/api/history', { workflow: 'z', images: [{ filename: 'one.png', subfolder: 'concept-app', type: 'output' }] })).body;
    const two = (await post('/api/history', { workflow: 'z', images: [{ filename: 'two.png', subfolder: 'concept-app', type: 'output' }] })).body;
    assert.deepEqual((await post('/api/history/delete', { ids: [one.id] })).body.deleted, [one.id]);
    up = false;
    assert.deepEqual((await post('/api/history/delete', { ids: [two.id] })).body.deleted, [two.id], 'cached folder used while /system_stats fails');
    assert.equal(fs.existsSync(path.join(t.out, 'concept-app', 'two.png')), false);
  } finally { await st.close(); }
});

// ---- A. press effect only on enabled buttons -----------------------------------------
test('styles: every :active (press) rule excludes disabled controls', () => {
  const css = fs.readFileSync(new URL('../../app/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = [...css.matchAll(/([^{}]+)\{/g)].flatMap((m) => m[1].split(',')).map((x) => x.trim()).filter((x) => x.includes(':active'));
  assert.ok(selectors.length >= 1);
  for (const sel of selectors) assert.match(sel, /:not\(:disabled\)/, `"${sel}" would also flash a disabled control`);
});

// ---- C. reconnect banner grace period -------------------------------------------------
function fakeTimers() {
  let now = 0, id = 0; const timers = new Map();
  return {
    setTimer: (f, ms) => { timers.set(++id, { f, at: now + ms }); return id; },
    clearTimer: (t) => timers.delete(t),
    advance(ms) { now += ms; for (const [k, t] of [...timers]) if (t.at <= now) { timers.delete(k); t.f(); } },
    get pending() { return timers.size; },
  };
}
test('banner: hidden during the 4 s grace period, shown after, hidden the moment the socket opens', () => {
  const t = fakeTimers(); const log = [];
  const b = new ConnectionBanner({ show: () => log.push('show'), hide: () => log.push('hide'), ...t });
  assert.equal(GRACE_MS, 4000);
  b.disconnected(); t.advance(3900);
  assert.deepEqual(log, [], 'a reconnect within 4 s shows nothing');
  b.connected(); t.advance(5000);
  assert.deepEqual(log, [], 'reconnected in time: never shown');
  b.disconnected(); b.disconnected(); // back-off retries keep failing
  t.advance(1000); b.disconnected(); t.advance(3000);
  assert.deepEqual(log, ['show'], 'shown once after 4 s down (not reset by each failed retry)');
  b.disconnected(); t.advance(10000);
  assert.deepEqual(log, ['show']);
  b.connected();
  assert.deepEqual(log, ['show', 'hide']);
});
test('banner: resume() hides it and starts a fresh grace period', () => {
  const t = fakeTimers(); const log = [];
  const b = new ConnectionBanner({ show: () => log.push('show'), hide: () => log.push('hide'), ...t });
  b.disconnected(); t.advance(4000);
  assert.deepEqual(log, ['show']);
  b.resume(); // back in the foreground, reconnecting
  assert.deepEqual(log, ['show', 'hide']);
  t.advance(3000); b.connected();
  assert.deepEqual(log, ['show', 'hide'], 'reconnect within the fresh grace period: no banner');
  b.disconnected(); t.advance(3000); b.resume(); t.advance(3000);
  assert.deepEqual(log, ['show', 'hide'], 'resume during a grace period restarts it');
  t.advance(1000);
  assert.deepEqual(log, ['show', 'hide', 'show']);
  b.connected(); b.resume();
  assert.equal(t.pending, 0, 'connected + resume arms nothing');
});

// ---- D. an info text for every control every bundled workflow exposes -------------

test('info: every control of every bundled AI preset (23 models + 17 workflows) has a plain-language text', async () => {
  const st = await startStack({ folderWorkflows: false });
  try {
    const list = (await (await fetch(st.base + '/api/workflows')).json()).workflows.filter((w) => w.id.startsWith('ai:'));
    const files = fs.readdirSync(path.join(st.wfDir, 'ai')).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 40);
    assert.equal(list.length, 40, 'all 40 presets are listed');
    const missing = [];
    for (const w of list) {
      assert.ok(w.ok, `${w.id}: ${w.error}`);
      const ctl = exposedControls(w);
      assert.ok(ctl.length >= 2, w.id);
      for (const c of ctl) {
        if (!c.info) missing.push(`${w.id} › ${c.label} (${c.key})`);
        else assert.ok(c.info.length >= 25 && /[.)]$/.test(c.info), `${w.id} › ${c.label}: write a full sentence`);
      }
      // every manifest param is covered by its own text or the glossary
      for (const key of Object.keys(w.ai.params)) assert.ok(ctl.some((c) => c.key === key && c.info), `${w.id} param ${key}`);
    }
    assert.deepEqual(missing, [], 'controls without an (i) text');
  } finally { await st.close(); }
});

test('info: every parameter of the 2 workflow actions has a text', () => {
  const dir = new URL('../../workflows/actions/', import.meta.url);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 2);
  for (const f of files) {
    const a = validateAction(f, JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8')));
    assert.ok(a.ok, a.error);
    for (const [k, p] of Object.entries(a.manifest.params)) assert.ok(infoFor(k, { param: p }), `${f} ${k}`);
  }
});

test('info: preset texts match what the presets really do (spot checks against the graphs)', () => {
  const load = (f) => validatePreset(f, JSON.parse(fs.readFileSync(new URL(`../../workflows/ai/${f}.json`, import.meta.url), 'utf8')));
  const z = load('z-image-turbo');
  assert.equal(z.manifest.params.steps.default, 8);
  assert.match(infoFor('steps', { param: z.manifest.params.steps, manifest: z.manifest }), /about 8 steps/);
  const q = load('qwen-2512-t2i');
  assert.equal(q.manifest.params.cfg.when.is, false, 'guidance only applies with Lightning off');
  assert.equal(q.manifest.params.cfg.offValue, 1);
  assert.match(infoFor('cfg', { param: q.manifest.params.cfg }), /Lightning off/);
  assert.match(infoFor('negative', { manifest: q.manifest }), /Lightning off/);
  const fd = load('flux1-dev-gguf');
  assert.equal(fd.workflow[fd.manifest.params.guidance.node].class_type, 'FluxGuidance');
  assert.match(infoFor('guidance', { param: fd.manifest.params.guidance }), /instead of classic CFG/);
  const k = load('klein-4b-edit');
  assert.equal(k.workflow[k.manifest.params.megapixels.node].class_type, 'ImageScaleToTotalPixels');
  const h3 = load('hunyuan3d-21');
  assert.equal(h3.manifest.params.faces.zeroAtMax, true);
  assert.match(infoFor('faces', { param: h3.manifest.params.faces }), /Full/);
  const w = load('wan22-5b-ti2v');
  assert.equal(w.workflow[w.manifest.params.fps.node].class_type, 'CreateVideo', 'fps only changes playback, not the frames made');
  // glossary from the owner's notes
  assert.match(GLOSSARY.aspect, /portrait/); assert.match(GLOSSARY.batch, /own seed/); assert.match(GLOSSARY.seed, /same result/);
  assert.match(GLOSSARY.scheduler, /default/); assert.match(GLOSSARY.shift, /layout/);
  // #expose controls of imported workflows: by input name, else a generic text
  assert.equal(infoFor('expose', { input: 'denoise', label: 'Denoise' }), GLOSSARY.denoise);
  assert.match(infoFor('expose', { input: 'tile_overlap', label: 'Tile overlap' }), /#expose.*Tile overlap/);
  // a workflow can override any text
  assert.equal(infoFor('batch', { manifest: { info: { batch: 'Mine.' } } }), 'Mine.');
  assert.equal(validatePreset('x', { preset: { group: 'Image', label: 'x', output: 'image', info: { prompt: 3 } }, workflow: { 1: { class_type: 'A', inputs: {} } } }).ok, false, 'info must be text');
});

// ---- E. Image sub sections --------------------------------------------------------
test('Image presets are split into Text to Image / Image Edit / Inpainting / Upscale (from menuPath)', async () => {
  assert.deepEqual(SUBGROUPS.Image, ['Text to Image', 'Image Edit', 'Inpainting', 'Outpainting', 'Upscale']);
  assert.deepEqual(menuParts('Image', 'Image/Text to Image/Z-Image Turbo', 'Z-Image Turbo Text to Image'), { subgroup: 'Text to Image', short: 'Z-Image Turbo' });
  assert.deepEqual(menuParts('Video', 'Video/Wan 2.2 5B Text/Image to Video', 'Wan'), { subgroup: null, short: 'Wan' }, 'a "/" in a name is not a sub section');
  assert.deepEqual(menuParts('Image', 'Image/Something Else/X', 'X full'), { subgroup: null, short: 'X full' });
  const st = await startStack({ folderWorkflows: true });
  try {
    const list = (await (await fetch(st.base + '/api/workflows')).json()).workflows;
    const by = (sub) => list.filter((w) => w.subgroup === sub).sort((a, b) => a.menuOrder - b.menuOrder).map((w) => w.id);
    assert.deepEqual(by('Text to Image'), ['ai:z-image-turbo', 'ai:klein-4b-t2i', 'ai:qwen-2512-t2i', 'ai:flux1-dev-gguf', 'ai:flux1-schnell-gguf']);
    assert.deepEqual(by('Image Edit'), ['ai:klein-4b-edit', 'ai:qwen-edit-2509', 'ai:qwen-edit-2511']);
    assert.deepEqual(by('Inpainting'), ['ai:klein-4b-inpaint', 'ai:flux1-fill-inpaint']);
    assert.deepEqual(by('Outpainting'), ['ai:flux1-fill-outpaint']); // batch 14
    assert.deepEqual(by('Upscale'), ['ai:seedvr2-7b-image', 'ai:upscale-4x-model']);
    assert.ok(list.filter((w) => w.group === 'Image').every((w) => w.subgroup), 'every Image preset has a sub section');
    assert.ok(list.filter((w) => w.group !== 'Image').every((w) => !w.subgroup));
    const z = list.find((w) => w.id === 'ai:z-image-turbo');
    assert.equal(z.short, 'Z-Image Turbo'); assert.equal(z.label, 'Z-Image Turbo Text to Image', 'the full name is unchanged (history, chat, legacy mapping)');
    const { pickerLayout } = await import('../../app/js/ui/workflow-picker.js');
    const lay = pickerLayout(list);
    assert.deepEqual(lay.map((x) => x.sec.key), ['3D', 'Image', 'Video', 'Audio', 'Textures', 'Concept', 'VFX', '3D Assets', 'Sound', 'My presets']);
    const img = lay.find((x) => x.sec.key === 'Image');
    assert.deepEqual(img.subs.map((x) => x.name), ['Text to Image', 'Image Edit', 'Inpainting', 'Outpainting', 'Upscale'], 'Upscale last');
    assert.equal(img.rows.length, 0); assert.equal(img.count, 13);
  } finally { await st.close(); }
});

// ---- F. ComfyUI page snippet (Agent button / toasts) ------------------------------

test('page snippet: inserted before </head>, once; only the page path; framing headers relaxed', () => {
  assert.equal(injectIntoHtml('<html><head><title>x</title></head><body></body></html>', '<i data-concept-tweaks></i>'), '<html><head><title>x</title><i data-concept-tweaks></i></head><body></body></html>');
  assert.equal(injectIntoHtml('<body class="a">x</body>', '<i data-concept-tweaks></i>'), '<body class="a"><i data-concept-tweaks></i>x</body>');
  assert.equal(injectIntoHtml('{"not":"html"}', 'S'), null);
  assert.equal(injectIntoHtml('<head data-concept-tweaks></head>', 'S'), '<head data-concept-tweaks></head>', 'never twice');
  for (const p of ['/', '/index.html', '/?x=1']) assert.ok(isPagePath(p), p);
  for (const p of ['/view?filename=a.png', '/assets/index.js', '/api/prompt', '/index.htm']) assert.ok(!isPagePath(p), p);
  assert.deepEqual(allowSameOriginFrame({ 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" }), { 'x-frame-options': 'SAMEORIGIN', 'content-security-policy': "default-src 'self'; frame-ancestors 'self'" });
});

async function upstreamPage(handler, fn) {
  const comfy = http.createServer(handler);
  const cport = await listen(comfy);
  const proxy = createComfyProxy(() => `http://127.0.0.1:${cport}`, '/comfy', { injectHtml: '<script data-concept-tweaks src="/js/comfy-tweaks.js"></script>', frameable: true });
  const app = http.createServer((req, res) => proxy.web(req, res));
  const aport = await listen(app);
  try { await fn(`http://127.0.0.1:${aport}`); } finally { comfy.closeAllConnections(); app.closeAllConnections(); await new Promise((r) => comfy.close(r)); await new Promise((r) => app.close(r)); }
}
const PAGE = '<!doctype html><html><head><title>ComfyUI</title></head><body>app</body></html>';

test('page snippet: gzip, br and deflate pages are decoded, injected, sent with the right Content-Length; asks for identity', async () => {
  for (const [enc, fn] of [['gzip', zlib.gzipSync], ['br', zlib.brotliCompressSync], ['deflate', zlib.deflateSync], [null, (b) => b]]) {
    let askedFor;
    await upstreamPage((req, res) => {
      askedFor = req.headers['accept-encoding'];
      const body = fn(Buffer.from(PAGE));
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': body.length, ETag: '"abc"', ...(enc ? { 'Content-Encoding': enc } : {}) });
      res.end(body);
    }, async (base) => {
      const r = await fetch(base + '/comfy/', { headers: { 'Accept-Encoding': 'gzip, br' } });
      const raw = Buffer.from(await r.arrayBuffer());
      assert.equal(r.status, 200);
      assert.equal(askedFor, 'identity');
      assert.equal(r.headers.get('content-encoding'), null, enc);
      assert.equal(Number(r.headers.get('content-length')), raw.length, enc);
      assert.equal(r.headers.get('etag'), null);
      assert.match(raw.toString(), /<title>ComfyUI<\/title><script data-concept-tweaks src="\/js\/comfy-tweaks.js"><\/script><\/head>/, enc);
    });
  }
});

test('page snippet: fails open (broken gzip, not HTML, no head/body), and leaves every other response untouched', async () => {
  const bodies = {
    '/': [{ 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' }, Buffer.from('this is not gzip')],
    '/index.html': [{ 'Content-Type': 'text/html' }, Buffer.from('plain words, no tags')],
    '/view': [{ 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' }, zlib.gzipSync(PAGE)],
    '/api/x': [{ 'Content-Type': 'application/json' }, Buffer.from('{"a":1}')],
  };
  await upstreamPage((req, res) => { const [h, b] = bodies[new URL(req.url, 'http://x').pathname]; res.writeHead(200, { ...h, 'Content-Length': b.length }); res.end(b); }, async (base) => {
    const raw = async (p) => { const r = await fetch(base + '/comfy' + p, { headers: { 'Accept-Encoding': 'identity' } }); return { r, b: Buffer.from(await r.arrayBuffer()) }; };
    // node's fetch decodes gzip itself, so look at the raw bytes with http.get
    const get = (p) => new Promise((ok) => http.get(base + '/comfy' + p, (r) => { const c = []; r.on('data', (x) => c.push(x)); r.on('end', () => ok({ headers: r.headers, body: Buffer.concat(c) })); }));
    const broken = await get('/');
    assert.equal(broken.headers['content-encoding'], 'gzip'); assert.equal(broken.body.toString(), 'this is not gzip', 'unmodified');
    const words = await raw('/index.html');
    assert.equal(words.b.toString(), 'plain words, no tags');
    const view = await get('/view');
    assert.equal(view.headers['content-encoding'], 'gzip', 'not the page: streamed through as is');
    assert.deepEqual(view.body, bodies['/view'][1]);
    const api = await raw('/api/x');
    assert.equal(api.b.toString(), '{"a":1}');
  });
});

test('page snippet: wired into the app server for /comfy/ (mock ComfyUI page, gzip, X-Frame-Options)', async () => {
  const st = await startStack({});
  try {
    const r = await fetch(st.base + '/comfy/');
    const html = await r.text();
    assert.match(html, /<link rel="stylesheet" href="\/comfy-tweaks.css" data-concept-tweaks><script src="\/js\/comfy-tweaks.js" data-concept-tweaks><\/script><\/head>/);
    assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
    const js = await fetch(st.base + '/js/comfy-tweaks.js');
    assert.equal(js.status, 200); assert.match(js.headers.get('content-type'), /javascript/);
    assert.equal((await fetch(st.base + '/comfy-tweaks.css')).status, 200);
    const sys = await fetch(st.base + '/comfy/system_stats');
    assert.ok(!(await sys.text()).includes('data-concept-tweaks'));
  } finally { await st.close(); }
});

// ---- Cancel while a job's POST is still on its way (lock must really lift) ----------
test('queue: Cancel during submission takes the job back out of ComfyUI; late progress never revives a cancelled job', async () => {
  const mem = new Map();
  globalThis.localStorage ??= { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  const { JobQueue } = await import('../../app/js/job-queue.js');
  const calls = [];
  let release;
  const comfy = Object.assign(new EventTarget(), {
    queuePrompt: () => new Promise((r) => { release = () => r({ prompt_id: 'p1' }); }),
    deleteQueued: async (ids) => { if (ids.length) calls.push(['delete', ...ids]); },
    interrupt: async (id) => { calls.push(['interrupt', id]); },
    history: async () => null,
  });
  const q = new JobQueue(comfy);
  const run = q.submit([{ workflow: { 1: { class_type: 'SaveImage', inputs: {} } }, meta: {} }]).catch(() => {});
  assert.equal(q.items[0].status, 'submitting');
  await q.cancelAll();
  assert.equal(q.items[0].status, 'cancelled');
  release();
  await run;
  assert.deepEqual(calls, [['delete', 'p1'], ['interrupt', 'p1']]);
  comfy.dispatchEvent(new CustomEvent('progress', { detail: { prompt_id: 'p1', value: 1, max: 4 } }));
  comfy.dispatchEvent(new CustomEvent('execution_start', { detail: { prompt_id: 'p1' } }));
  assert.equal(q.items[0].status, 'cancelled');
  assert.equal(q.active.length, 0);
});
