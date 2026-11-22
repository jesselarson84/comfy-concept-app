// Batch 4 (server + pure logic): delete fixes (locked files, proxy cleanup,
// output folder lookup), info texts for every exposed setting, Image sub
// sections, the ComfyUI page snippet (Agent toast, canvas tab bar).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStack } from './helpers.js';
import { deleteAppFile, unlinkWithRetry, IN_USE } from '../../server/outputs.js';

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
