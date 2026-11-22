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
import { deleteAppFile, unlinkWithRetry, IN_USE, outputDirFromArgv, comfyOutputDir, createOutputDirCache } from '../../server/outputs.js';
import { createComfyProxy } from '../../server/proxy.js';

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
