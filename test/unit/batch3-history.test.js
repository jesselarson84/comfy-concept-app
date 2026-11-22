// Batch 3 items 8 and 9 (server side): safe delete, history remove, folders.
// Every file touched here lives in a fresh temp dir made by the test itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deleteAppFile } from '../../server/outputs.js';
import { FolderStore } from '../../server/folders.js';
import { startStack } from './helpers.js';

function tempOutput() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-del-'));
  const out = path.join(root, 'output');
  fs.mkdirSync(path.join(out, 'concept-app', 'klein'), { recursive: true });
  const write = (rel, s = 'x') => { const f = path.join(out, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); return f; };
  return { root, out, write };
}
const del = (ref, out, sub = 'concept-app') => deleteAppFile(ref, { outputDir: out, outputSubfolder: sub });

test('delete: a file in output/concept-app (and its own subfolders) is deleted', async () => {
  const t = tempOutput();
  const a = t.write('concept-app/a.png'), b = t.write('concept-app/klein/b.png');
  assert.deepEqual(await del({ filename: 'a.png', subfolder: 'concept-app', type: 'output' }, t.out), { ok: true, deleted: true });
  assert.deepEqual(await del({ filename: 'b.png', subfolder: 'concept-app/klein', type: 'output' }, t.out), { ok: true, deleted: true });
  assert.equal(fs.existsSync(a) || fs.existsSync(b), false);
  assert.deepEqual(await del({ filename: 'gone.png', subfolder: 'concept-app', type: 'output' }, t.out), { ok: true, missing: true });
});

test('delete: path traversal, absolute paths and odd names are refused, nothing is touched', async () => {
  const t = tempOutput();
  const outside = t.write('other/keep.png'), top = t.write('keep-top.png');
  fs.writeFileSync(path.join(t.root, 'secret.txt'), 's');
  const bad = [
    { filename: '../keep-top.png', subfolder: 'concept-app' },
    { filename: 'keep.png', subfolder: 'concept-app/../other' },
    { filename: 'keep.png', subfolder: '../output/other' },
    { filename: 'secret.txt', subfolder: 'concept-app/../..' },
    { filename: top, subfolder: 'concept-app' },
    { filename: 'keep.png', subfolder: path.join(t.out, 'other') },
    { filename: 'keep.png', subfolder: '/etc' },
    { filename: 'keep-top.png', subfolder: '' },
    { filename: 'keep.png', subfolder: 'other' },
    { filename: 'keep.png', subfolder: 'concept-app-evil' },
    { filename: 'a\\..\\..\\keep-top.png', subfolder: 'concept-app' },
    { filename: '..', subfolder: 'concept-app' },
    { filename: '', subfolder: 'concept-app' },
    { filename: 'a.png\u0000', subfolder: 'concept-app' },
    { filename: 'keep.png', subfolder: 'concept-app/./../other' },
  ];
  for (const ref of bad) {
    const r = await del({ ...ref, type: 'output' }, t.out);
    assert.equal(r.ok, false, JSON.stringify(ref));
  }
  assert.equal((await del({ filename: 'a.png', subfolder: 'concept-app', type: 'input' }, t.out)).ok, false, 'input files are never deleted');
  assert.equal((await del({ filename: 'a.png', subfolder: 'concept-app', type: 'temp' }, t.out)).ok, false);
  assert.equal((await del(null, t.out)).ok, false);
  assert.equal((await deleteAppFile({ filename: 'a.png', subfolder: 'concept-app' }, { outputDir: '' })).ok, false, 'unknown output dir');
  assert.ok(fs.existsSync(outside) && fs.existsSync(top) && fs.existsSync(path.join(t.root, 'secret.txt')));
});

test('delete: symlinks out of the folder are refused (file link, folder link, linked app folder)', async () => {
  const t = tempOutput();
  const victim = path.join(t.root, 'victim.png'); fs.writeFileSync(victim, 'v');
  const victimDir = path.join(t.root, 'vdir'); fs.mkdirSync(victimDir); fs.writeFileSync(path.join(victimDir, 'v.png'), 'v');
  fs.symlinkSync(victim, path.join(t.out, 'concept-app', 'link.png'));
  fs.symlinkSync(victimDir, path.join(t.out, 'concept-app', 'linkdir'));
  assert.equal((await del({ filename: 'link.png', subfolder: 'concept-app', type: 'output' }, t.out)).ok, false);
  assert.equal((await del({ filename: 'v.png', subfolder: 'concept-app/linkdir', type: 'output' }, t.out)).ok, false);
  assert.ok(fs.existsSync(path.join(t.out, 'concept-app', 'link.png')), 'the link itself is left alone too');
  // The whole app folder is a link elsewhere: refuse everything.
  const t2 = tempOutput();
  fs.rmSync(path.join(t2.out, 'concept-app'), { recursive: true });
  fs.symlinkSync(victimDir, path.join(t2.out, 'concept-app'));
  assert.equal((await del({ filename: 'v.png', subfolder: 'concept-app', type: 'output' }, t2.out)).ok, false);
  assert.ok(fs.existsSync(victim) && fs.existsSync(path.join(victimDir, 'v.png')));
  // A directory with a file name is not deleted.
  fs.mkdirSync(path.join(t.out, 'concept-app', 'dir.png'));
  assert.equal((await del({ filename: 'dir.png', subfolder: 'concept-app', type: 'output' }, t.out)).ok, false);
});

test('folders: labels only; create / rename / add / remove / forget; persisted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-fold-'));
  const s = new FolderStore(dir);
  const f = await s.create('  Robots  ');
  assert.equal(f.name, 'Robots');
  assert.equal((await s.create('robots')).id, f.id, 'same name (any case) reuses the folder');
  await assert.rejects(() => s.create('   '), /name/);
  await s.edit(f.id, { add: ['h_1', 'h_2', 'h_1'] });
  assert.deepEqual(s.get(f.id).items, ['h_1', 'h_2']);
  await s.edit(f.id, { remove: ['h_1'] });
  await s.rename(f.id, 'Mechs');
  await s.forget(['h_2']);
  await s.writing;
  const again = new FolderStore(dir);
  assert.deepEqual(again.list().map((x) => [x.name, x.items]), [['Mechs', []]]);
  assert.equal(await again.remove(f.id), true);
  assert.equal(await again.remove(f.id), false);
});

test('API: /api/history/delete deletes only app files (temp output dir), drops entries and folder labels', async () => {
  const t = tempOutput();
  t.write('concept-app/one.png'); t.write('concept-app/klein/two.png'); t.write('concept-app/three.glb');
  const keep = t.write('elsewhere/keep.png');
  const st = await startStack({ outputDir: t.out });
  try {
    const post = (p, b, m = 'POST') => fetch(st.base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const img = (filename, subfolder) => ({ filename, subfolder, type: 'output' });
    const a = (await post('/api/history', { workflow: 'z-image-turbo', prompt: 'a', images: [img('one.png', 'concept-app'), img('two.png', 'concept-app/klein')] })).body;
    const b = (await post('/api/history', { workflow: 'hunyuan3d', prompt: '', files: [img('three.glb', 'concept-app')] })).body;
    const c = (await post('/api/history', { workflow: 'z-image-turbo', prompt: 'c', images: [img('keep.png', 'elsewhere')] })).body;
    const d = (await post('/api/history', { workflow: 'z-image-turbo', prompt: 'd', images: [img('../../keep.png', 'concept-app')] })).body;
    const f = (await post('/api/folders', { name: 'Keepers' })).body;
    assert.equal((await post(`/api/folders/${f.id}/items`, { add: [a.id, b.id, c.id, 'h_nope'] })).body.items.length, 3, 'unknown ids are not added');
    let folders = (await (await fetch(st.base + '/api/folders')).json());
    assert.equal(folders.folders[0].count, 3);
    assert.equal((await (await fetch(st.base + `/api/history?folder=${f.id}`)).json()).sessions.flatMap((s) => s.entries).length, 3);

    assert.equal((await post('/api/history/delete', { ids: [] })).status, 400);
    const r = await post('/api/history/delete', { ids: [a.id, b.id, c.id, d.id, 'h_missing'] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.deleted.sort(), [a.id, b.id].sort());
    assert.deepEqual(r.body.refused.map((x) => x.id).sort(), [c.id, d.id, 'h_missing'].sort());
    assert.equal(fs.existsSync(path.join(t.out, 'concept-app', 'one.png')), false);
    assert.equal(fs.existsSync(path.join(t.out, 'concept-app', 'klein', 'two.png')), false);
    assert.equal(fs.existsSync(path.join(t.out, 'concept-app', 'three.glb')), false);
    assert.ok(fs.existsSync(keep), 'a file outside the app folder is never deleted');
    const left = (await (await fetch(st.base + '/api/history')).json()).sessions.flatMap((s) => s.entries).map((e) => e.id);
    assert.ok(!left.includes(a.id) && !left.includes(b.id) && left.includes(c.id) && left.includes(d.id));
    folders = (await (await fetch(st.base + '/api/folders')).json());
    assert.equal(folders.folders[0].count, 1, 'deleted entries leave the folder');
    assert.equal((await post(`/api/folders/${f.id}`, { name: 'Best' }, 'PATCH')).body.name, 'Best');
    assert.equal((await post(`/api/folders/${f.id}`, undefined, 'DELETE')).status, 200);
    assert.equal((await post('/api/folders/f_nope', undefined, 'DELETE')).status, 404);
  } finally { await st.close(); }
});

test('API: delete with no known ComfyUI output folder deletes nothing (409)', async () => {
  const st = await startStack({ outputDir: null });
  try {
    const h = await (await fetch(st.base + '/api/history', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workflow: 'z-image-turbo', images: [{ filename: 'x.png', subfolder: 'concept-app', type: 'output' }] }) })).json();
    const r = await fetch(st.base + '/api/history/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [h.id] }) });
    assert.ok([409, 200].includes(r.status));
    if (r.status === 200) assert.deepEqual((await r.json()).deleted, []);
  } finally { await st.close(); }
});
