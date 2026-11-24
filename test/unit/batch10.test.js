// Batch 10: a file picked from Google Drive on Android fails to upload with
// ERR_UPLOAD_FILE_CHANGED (fetch rejects with "Failed to fetch"); the upload is
// retried with a copy of the file held in memory. Plus the wiring of the new
// viewer (⋮ menu, details, one Save) and History without tile times.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ComfyClient, inMemoryCopy } from '../../app/js/comfy-client.js';
import { ROOT } from './helpers.js';

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function withFetch(impl, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve().then(fn).finally(() => { globalThis.fetch = orig; });
}
// ComfyClient reads sessionStorage for its client id.
globalThis.sessionStorage ??= { getItem: () => null, setItem: () => {} };

test('upload: a picked file that fails (Drive on Android) is sent again as an in-memory copy', async () => {
  const picked = new File([new Uint8Array([1, 2, 3, 4])], 'from-drive.png', { type: 'image/png', lastModified: 1000 });
  const sent = [];
  await withFetch(async (url, init) => {
    const f = init.body.get('image');
    sent.push({ url, same: f.lastModified === picked.lastModified, name: f.name, type: f.type, bytes: [...new Uint8Array(await f.arrayBuffer())], overwrite: init.body.get('overwrite') });
    if (sent.length === 1) throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify({ name: 'from-drive.png', subfolder: '', type: 'input' }), { status: 200 });
  }, async () => {
    const r = await new ComfyClient().uploadImage(picked);
    assert.equal(r.ref, 'from-drive.png');
  });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].same, true, 'first try: the picked file as it is (no copy for normal files; FormData wraps it, so compare lastModified)');
  assert.equal(sent[1].same, false, 'retry: a copy');
  assert.deepEqual([sent[1].name, sent[1].type, sent[1].bytes, sent[1].overwrite], ['from-drive.png', 'image/png', [1, 2, 3, 4], 'false']);
  assert.equal(sent[1].url, '/comfy/upload/image');
});

test('upload: a normal file uploads once; a server error is not retried; a Blob that fails is not copied', async () => {
  let calls = 0;
  await withFetch(async () => { calls++; return new Response('{"name":"a.png","subfolder":"x","type":"input"}', { status: 200 }); }, async () => {
    assert.equal((await new ComfyClient().uploadImage(new File(['a'], 'a.png', { type: 'image/png' }))).ref, 'x/a.png');
  });
  assert.equal(calls, 1);
  calls = 0;
  await withFetch(async () => { calls++; return new Response('no', { status: 500 }); }, async () => {
    await assert.rejects(new ComfyClient().uploadImage(new File(['a'], 'a.png')), /Upload failed \(500\)/);
  });
  assert.equal(calls, 1);
  calls = 0;
  await withFetch(async () => { calls++; throw new TypeError('Failed to fetch'); }, async () => {
    await assert.rejects(new ComfyClient().uploadImage(new Blob(['a']), 'b.png'), /Failed to fetch/);
  });
  assert.equal(calls, 1);
});

test('inMemoryCopy keeps name, type and bytes', async () => {
  const c = await inMemoryCopy(new File([new Uint8Array([9, 8])], 'v.mp4', { type: 'video/mp4' }));
  assert.deepEqual([c.name, c.type, [...new Uint8Array(await c.arrayBuffer())]], ['v.mp4', 'video/mp4', [9, 8]]);
});

test('viewer wiring: ⋮ menu groups, no Discuss, details sheet, one Save (Drive or phone); file viewers use ⋮ too; module cached', () => {
  const viewer = read('app/js/ui/viewer.js'), main = read('app/js/main.js'), menu = read('app/js/ui/action-menu.js'), sheet = read('app/js/ui/drive-folder.js');
  assert.doesNotMatch(viewer + main, /onDiscuss|Discuss'/);
  assert.doesNotMatch(viewer, /viewer-actions|Save to device/);
  assert.match(viewer, /title: 'Keep & send'/);
  assert.match(viewer, /title: 'Make more'/);
  assert.match(viewer, /label: 'Use as reference'/);
  assert.match(viewer, /label: 'Reuse settings'/);
  assert.match(viewer, /danger: true/);
  assert.match(viewer, /openDetails\(\)/);
  assert.match(main, /onSave: \(it\) => saveToDrive\(it\.image, 'image', \{ phone: \(\) => viewer\.save\(\) \}\)/);
  assert.match(sheet, /'Save to this phone instead'/);
  assert.match(sheet, /export const PHONE = Symbol/);
  assert.match(menu, /export function driveLogo/);
  for (const f of ['model-viewer', 'video-player', 'audio-player', 'file-sheet']) {
    const src = read(`app/js/ui/${f}.js`);
    assert.match(src, /fileMoreButton\(\(\) => this\.file, this\.hooks\)/, f);
    assert.doesNotMatch(src, /'Save to Drive'\)|'Download'\)/, f);
  }
  assert.match(read('app/sw.js'), /'\/js\/ui\/action-menu\.js'/);
  assert.doesNotMatch(read('app/js/ui/history-view.js'), /thumb-time/);
  for (const i of ['star', 'star-fill', 'copy', 'smartphone']) assert.match(read('app/icons.css'), new RegExp(`\\.i-${i}\\{--svg:`), i);
});
