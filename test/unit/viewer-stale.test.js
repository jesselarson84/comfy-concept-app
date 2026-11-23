// Reused output file names must never show an older picture (bug 2026-11-22:
// ComfyUI restarts its counter after the highest file left, so a deleted
// z_image_turbo_00044_.png name came back for a new image and the phone's
// viewer showed the old one from the WebView cache).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { viewUrl } from '../../app/js/comfy-client.js';
import { splitOutputs, stampOutputs } from '../../app/js/lib/outputs.js';
import { thumbKey } from '../../app/js/lib/thumb-cache.js';
import { HistoryStore, withViewVersion } from '../../server/history.js';
import { historyOutputs, scanAppFolder, mergeOutputs } from '../../server/outputs.js';
import { createComfyProxy, isViewPath } from '../../server/proxy.js';

const ref = { filename: 'z_image_turbo_00044_.png', subfolder: 'concept-app', type: 'output' };

test('same file name, different job -> different /view URL (full size and thumb)', () => {
  const a = viewUrl({ ...ref, v: 'prompt-old' }), b = viewUrl({ ...ref, v: 'prompt-new' });
  assert.notEqual(a, b);
  assert.notEqual(viewUrl({ ...ref, v: 'prompt-old' }, { thumb: true }), viewUrl({ ...ref, v: 'prompt-new' }, { thumb: true }));
  assert.match(b, /[?&]v=prompt-new(&|$)/);
  assert.equal(viewUrl(ref), '/comfy/view?filename=z_image_turbo_00044_.png&subfolder=concept-app&type=output', 'no v: URL unchanged');
  assert.notEqual(thumbKey({ ...ref, v: '1' }), thumbKey({ ...ref, v: '2' }), '3D still cache keyed by version too');
});

test('live results are stamped with their prompt id', () => {
  const out = stampOutputs(splitOutputs({ 9: { images: [ref] }, 10: { '3d': [{ filename: 'm.glb', subfolder: 'concept-app', type: 'output' }] } }), 'p-123');
  assert.equal(out.images[0].v, 'p-123');
  assert.equal(out.files[0].v, 'p-123');
  assert.equal(stampOutputs({ images: [ref], files: [] }, null).images[0].v, undefined);
});

test('History: list() adds v from the prompt id; history.json is not changed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-stale-'));
  const h = new HistoryStore(dir);
  const old = await h.add({ promptId: 'p-old', prompt: 'white rocket', images: [ref] });
  await h.remove([old.id]); // the old picture is deleted, its name becomes free
  await h.add({ promptId: 'p-new', prompt: 'launch tower', images: [{ ...ref, v: 'ignored-on-save' }] });
  const e = h.list()[0].entries[0];
  assert.equal(e.images[0].v, 'p-new');
  assert.equal(viewUrl(e.images[0]).includes('v=p-new'), true);
  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'history.json'), 'utf8'));
  assert.equal(disk.entries[0].images[0].v, undefined, 'stored data keeps its old shape');
  assert.equal(withViewVersion({ id: 'h_1', images: [ref], files: [] }).images[0].v, 'h_1', 'no prompt id: entry id');
});

test('"From Comfy UI" list: v from history prompt id, disk files by mtime', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-stale-out-'));
  fs.mkdirSync(path.join(dir, 'concept-app'));
  const f = path.join(dir, 'concept-app', ref.filename);
  fs.writeFileSync(f, 'png');
  const mt = new Date('2026-11-22T23:49:08Z'); fs.utimesSync(f, mt, mt);
  const disk = scanAppFolder(dir, 'concept-app');
  assert.equal(disk[0].v, String(mt.getTime()));
  const hist = historyOutputs({ list: () => [{ entries: [{ id: 'h_a', promptId: 'p-new', createdAt: 1, images: [ref], files: [] }] }] });
  assert.equal(hist[0].v, 'p-new');
  const merged = mergeOutputs([hist, disk], {});
  assert.equal(merged.items.length, 1);
  assert.ok(['p-new', String(mt.getTime())].includes(merged.items[0].v), 'merged entry keeps a v');
});

test('proxy: ComfyUI /view answers get Cache-Control: no-cache, other paths untouched', async () => {
  assert.ok(isViewPath('/view?filename=a.png') && isViewPath('/api/view?filename=a.png') && !isViewPath('/viewer') && !isViewPath('/history'));
  const comfy = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'image/png', ETag: '"x"', 'Last-Modified': 'Sun, 01 Nov 2026 00:00:00 GMT' }); res.end('png'); });
  const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
  const cport = await listen(comfy);
  const proxy = createComfyProxy(() => `http://127.0.0.1:${cport}`);
  const app = http.createServer((req, res) => proxy.web(req, res));
  const aport = await listen(app);
  try {
    const v = await fetch(`http://127.0.0.1:${aport}/comfy/view?filename=a.png&type=output`);
    assert.equal(v.headers.get('cache-control'), 'no-cache');
    assert.equal(v.headers.get('etag'), '"x"', 'validators kept: an unchanged file is a cheap 304');
    const o = await fetch(`http://127.0.0.1:${aport}/comfy/object_info`);
    assert.equal(o.headers.get('cache-control'), null);
  } finally {
    comfy.closeAllConnections(); app.closeAllConnections();
    await new Promise((r) => comfy.close(r)); await new Promise((r) => app.close(r));
  }
});
