// Batch 11: projects (folders under Creative/PROJECTS/ACTIVE on Drive), every
// output filed into <project>/__comfy outputs/<kind>/ (or ACTIVE/__Comfy UI when
// no project is set), moving files when an item changes project, Drive trash on
// delete, and History grouped by project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStack, ROOT, pngBytes } from './helpers.js';
import { HistoryStore } from '../../server/history.js';
import { ProjectStore, MARKER, OUTPUTS_DIR, UNSORTED_DIR } from '../../server/projects.js';
import { createFiler } from '../../server/filer.js';
import { byProject, driveInfo } from '../../app/js/ui/history-view.js';

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const img = (f) => ({ filename: f, subfolder: 'concept-app', type: 'output' });
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** ACTIVE with Apps/ (grouping folder), GTA 6 Mods/, __BlankProject/ and a plain folder. */
function active() {
  const root = path.join(tmp('cc-active-'), 'ACTIVE');
  for (const d of ['Apps/Cache', 'Apps/Slate', 'GTA 6 Mods', '__BlankProject', 'Nameless_Things/Houdini']) fs.mkdirSync(path.join(root, d), { recursive: true });
  return root;
}

function rig({ comfyDown = false } = {}) {
  const dataDir = tmp('cc-p-');
  const root = active();
  const history = new HistoryStore(dataDir);
  const projects = new ProjectStore(dataDir, { projectsDir: root });
  const calls = [];
  const env = { down: comfyDown, missing: new Set() };
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (env.down) throw new Error('ECONNREFUSED');
    const name = new URL(url).searchParams.get('filename');
    if (env.missing.has(name)) return new Response('nope', { status: 404 });
    return new Response(pngBytes());
  };
  const filer = createFiler({ history, projects, getComfyUrl: () => 'http://comfy', fetchImpl });
  return { dataDir, root, history, projects, filer, calls, env };
}

test('projects: Use marks a folder (hidden marker), grouping folders hold projects, no projects inside projects, "__" folders hidden', async () => {
  const r = rig();
  let b = r.projects.browse('');
  assert.deepEqual(b.folders.map((f) => f.name), ['Apps', 'GTA 6 Mods', 'Nameless_Things'], '__BlankProject is hidden');
  const cache = await r.projects.mark('Apps/Cache');
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.root, 'Apps/Cache', MARKER), 'utf8')).id, cache.id);
  assert.ok(fs.statSync(path.join(r.root, 'Apps/Cache', OUTPUTS_DIR)).isDirectory(), 'Use makes __comfy outputs');
  assert.deepEqual(r.projects.browse('Apps').here, { name: 'Apps', projects: 1 }, 'Apps holds a project: no Use-this-folder');
  assert.deepEqual(r.projects.browse('GTA 6 Mods').here, { name: 'GTA 6 Mods', projects: 0 });
  b = r.projects.browse('');
  assert.equal(b.folders.find((f) => f.name === 'Apps').projects, 1, 'Apps is a grouping folder with 1 project');
  assert.equal(r.projects.browse('Apps').folders.find((f) => f.name === 'Cache').project, cache.id);
  await assert.rejects(r.projects.mark('Apps'), /cannot hold other projects/, 'a folder holding a project cannot become one');
  await assert.rejects(r.projects.mark('Apps/Cache/x'), /./);
  assert.throws(() => r.projects.browse('Apps/Cache'), /cannot hold other projects/, 'projects never open');
  await assert.rejects(r.projects.mark('__BlankProject'), /cannot be a project/);
  assert.throws(() => r.projects.abs('../../etc'), /Bad folder/);
  const again = await r.projects.mark('Apps/Cache');
  assert.equal(again.id, cache.id, 'marking twice keeps the same project');
});

test('projects: New project makes <name>/__comfy outputs in ACTIVE or a grouping folder; taken names are refused', async () => {
  const r = rig();
  const p = await r.projects.create('Apps', 'Habit Tracker');
  assert.ok(fs.statSync(path.join(r.root, 'Apps', 'Habit Tracker', OUTPUTS_DIR)).isDirectory());
  assert.ok(fs.existsSync(path.join(r.root, 'Apps', 'Habit Tracker', MARKER)));
  assert.deepEqual(r.projects.list().find((x) => x.id === p.id).group, ['Apps']);
  const top = await r.projects.create('', 'Rocket');
  assert.deepEqual(r.projects.list().find((x) => x.id === top.id).group, []);
  await assert.rejects(r.projects.create('Apps', 'cache'), /already exists/, 'same name (any case) is refused');
  await assert.rejects(r.projects.create('', '__Secret'), /cannot start/);
  await assert.rejects(r.projects.create('', 'a/b'), /cannot/);
  await assert.rejects(r.projects.create('Apps/Habit Tracker', 'Inner'), /cannot hold other projects/);
});

test('projects: a renamed / moved project folder is found again by its marker; one moved out of ACTIVE shows as missing', async () => {
  const r = rig();
  const p = await r.projects.mark('Apps/Cache');
  fs.renameSync(path.join(r.root, 'Apps/Cache'), path.join(r.root, 'GTA 6 Mods/Cache Two'));
  const found = r.projects.list().find((x) => x.id === p.id);
  assert.equal(found.path ?? found.rel, 'GTA 6 Mods/Cache Two');
  assert.equal(found.name, 'Cache Two');
  assert.equal(found.missing, false);
  fs.rmSync(path.join(r.root, 'GTA 6 Mods/Cache Two'), { recursive: true });
  r.projects.lastScan = 0;
  assert.equal(r.projects.list().find((x) => x.id === p.id).missing, true);
  assert.equal(r.projects.outputsDir(p.id), null, 'nothing is filed into a lost project');
});

test('filer: every output is copied to Drive - Unsorted without a project, <project>/__comfy outputs/<kind> with one; never overwrites', async () => {
  const r = rig();
  const cache = await r.projects.mark('Apps/Cache');
  const a = await r.history.add({ prompt: 'a', images: [img('a.png')] });
  const b = await r.history.add({ prompt: 'b', images: [img('b.png')], project: cache.id });
  const glb = await r.history.add({ prompt: 'c', images: [], files: [{ ...img('m.glb'), kind: '3d' }], project: cache.id });
  fs.mkdirSync(path.join(r.root, 'Apps/Cache', OUTPUTS_DIR, 'Images'), { recursive: true });
  fs.writeFileSync(path.join(r.root, 'Apps/Cache', OUTPUTS_DIR, 'Images', 'b.png'), 'someone else'); // already there
  const s = await r.filer.tick();
  assert.equal(s.waiting, 0); assert.equal(s.filed, 3);
  assert.ok(fs.existsSync(path.join(r.root, UNSORTED_DIR, 'Images', 'a.png')));
  assert.ok(fs.existsSync(path.join(r.root, 'Apps/Cache', OUTPUTS_DIR, 'Images', 'b (2).png')), 'existing file kept, copy renamed');
  assert.equal(fs.readFileSync(path.join(r.root, 'Apps/Cache', OUTPUTS_DIR, 'Images', 'b.png'), 'utf8'), 'someone else');
  assert.ok(fs.existsSync(path.join(r.root, 'Apps/Cache', OUTPUTS_DIR, '3D', 'm.glb')));
  assert.deepEqual(r.history.get(a.id).filed['concept-app/a.png'], { p: null, f: 'Images/a.png', s: 'ok' });
  assert.equal(r.history.get(b.id).filed['concept-app/b.png'].f, 'Images/b (2).png');
  assert.ok(r.history.get(glb.id).filed);
  const n = r.calls.length;
  await r.filer.tick();
  assert.equal(r.calls.length, n, 'filed once, never again');
});

test('filer: setting a project afterwards MOVES the files (and what was made from them); same-name clash gets (2)', async () => {
  const r = rig();
  const cache = await r.projects.mark('Apps/Cache');
  const a = await r.history.add({ prompt: 'a', images: [img('a.png')] });
  const up = await r.history.add({ prompt: 'upscale', images: [img('a_up.png')], parent: { historyId: a.id, image: img('a.png') } });
  const ref = await r.history.add({ prompt: '3d', images: [], files: [img('a.glb')], source: a.id });
  await r.filer.tick();
  assert.ok(fs.existsSync(path.join(r.root, UNSORTED_DIR, 'Images', 'a.png')));
  assert.deepEqual(r.history.descendants([a.id]).sort(), [a.id, up.id, ref.id].sort());
  await r.history.setProject(r.history.descendants([a.id]), cache.id);
  const s = await r.filer.tick();
  assert.equal(s.waiting, 0);
  assert.ok(!fs.existsSync(path.join(r.root, UNSORTED_DIR, 'Images', 'a.png')), 'moved, not copied');
  assert.ok(fs.existsSync(path.join(r.root, 'Apps/Cache', OUTPUTS_DIR, 'Images', 'a.png')));
  assert.ok(fs.existsSync(path.join(r.root, 'Apps/Cache', OUTPUTS_DIR, 'Images', 'a_up.png')));
  assert.ok(fs.existsSync(path.join(r.root, 'Apps/Cache', OUTPUTS_DIR, '3D', 'a.glb')));
  assert.deepEqual(r.history.get(a.id).filed['concept-app/a.png'], { p: cache.id, f: 'Images/a.png', s: 'ok' });
  // back to Unsorted where a file of that name now exists
  fs.writeFileSync(path.join(r.root, UNSORTED_DIR, 'Images', 'a.png'), 'other');
  await r.history.setProject([a.id], null);
  await r.filer.tick();
  assert.equal(r.history.get(a.id).filed['concept-app/a.png'].f, 'Images/a (2).png');
  assert.equal(fs.readFileSync(path.join(r.root, UNSORTED_DIR, 'Images', 'a.png'), 'utf8'), 'other');
});

test('filer: Drive offline or ComfyUI offline -> waits and catches up; a file deleted in Drive is marked missing and never re-filed', async () => {
  const r = rig({ comfyDown: true });
  const a = await r.history.add({ prompt: 'a', images: [img('a.png')] });
  let s = await r.filer.tick();
  assert.equal(s.waiting, 1); assert.match(s.error, /ComfyUI did not send/);
  r.env.down = false;
  // Drive gone (Q: unmounted)
  const moved = r.root + '-off';
  fs.renameSync(r.root, moved);
  s = await r.filer.tick();
  assert.equal(s.available, false); assert.equal(s.waiting, 1);
  fs.renameSync(moved, r.root);
  s = await r.filer.tick();
  assert.equal(s.filed, 1);
  fs.unlinkSync(path.join(r.root, UNSORTED_DIR, 'Images', 'a.png'));
  await r.filer.verify();
  assert.equal(r.history.get(a.id).filed['concept-app/a.png'].s, 'missing');
  const n = r.calls.length;
  await r.filer.tick();
  assert.equal(r.calls.length, n, 'a file the user deleted in Drive is not copied again');
  // gone from ComfyUI: given up, not retried forever
  r.env.missing.add('b.png');
  const b = await r.history.add({ prompt: 'b', images: [img('b.png')] });
  await r.filer.tick();
  assert.equal(r.history.get(b.id).filed['concept-app/b.png'].s, 'gone');
});

test('filer: only the app\'s own outputs are filed; trash() deletes the filed copy (Drive for Desktop -> Drive trash)', async () => {
  const r = rig();
  const other = await r.history.add({ prompt: 'x', images: [{ filename: 'x.png', subfolder: 'elsewhere', type: 'temp' }] });
  const a = await r.history.add({ prompt: 'a', images: [img('a.png')] });
  await r.filer.tick();
  assert.equal(r.history.get(other.id).filed, undefined, 'temp files are not filed');
  const p = path.join(r.root, UNSORTED_DIR, 'Images', 'a.png');
  assert.ok(fs.existsSync(p));
  assert.equal(await r.filer.trash(r.history.get(a.id), [img('a.png')]), 1);
  assert.ok(!fs.existsSync(p));
});

test('server: project routes, the pick on this device for new outputs (batch 12: No project by default), inheritance from the source picture, move, delete -> Drive trash', async () => {
  let fetchImpl;
  const s = await startStack({ projects: true, appOptions: { filer: { fetchImpl: (...a) => fetchImpl(...a) } } });
  fetchImpl = async () => new Response(pngBytes());
  const j = async (method, url, body) => { const r = await fetch(s.base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
  try {
    fs.mkdirSync(path.join(s.projectsDir, 'Apps', 'Cache'), { recursive: true });
    let r = await j('GET', '/api/projects');
    assert.equal(r.body.available, true); assert.equal(r.body.root, 'ACTIVE'); assert.equal(r.body.current, undefined, 'no shared current project');
    r = await j('GET', '/api/projects/browse?path=Apps');
    assert.deepEqual(r.body.folders.map((f) => f.name), ['Cache']);
    const cache = (await j('POST', '/api/projects', { path: 'Apps/Cache' })).body;
    // batch 12: the app sends the project picked on that device; unknown ids are ignored
    assert.equal((await j('POST', '/api/history', { prompt: 'x', images: [], project: 'p_hacked' })).body.project, null);
    assert.equal((await j('POST', '/api/history', { prompt: 'x', images: [] })).body.project, null, 'No project by default');
    const a = (await j('POST', '/api/history', { prompt: 'a', promptId: 'p1', images: [], project: cache.id })).body;
    assert.equal(a.project, cache.id);
    await j('PATCH', `/api/history/${a.id}`, { images: [img('a.png')], status: 'done' });
    // made from it (upscale / Use as reference) -> same project even after switching
    const rocket = (await j('POST', '/api/projects/new', { name: 'Rocket', parent: '' })).body;
    const up = (await j('POST', '/api/history', { prompt: 'up', parent: { historyId: a.id, image: img('a.png') }, images: [img('a_up.png')], project: rocket.id })).body;
    assert.equal(up.project, cache.id);
    const viaRef = (await j('POST', '/api/history', { prompt: '3d', source: a.id, images: [img('a3d.png')], project: rocket.id })).body;
    assert.equal(viaRef.project, cache.id);
    const fresh = (await j('POST', '/api/history', { prompt: 'f', images: [img('f.png')], project: rocket.id })).body;
    assert.equal(fresh.project, rocket.id);
    const none = (await j('POST', '/api/history', { prompt: 'n', images: [img('n.png')] })).body;
    assert.equal(none.project, null);
    await s.app.filer.tick();
    assert.ok(fs.existsSync(path.join(s.projectsDir, 'Apps/Cache', OUTPUTS_DIR, 'Images', 'a.png')));
    assert.ok(fs.existsSync(path.join(s.projectsDir, 'Rocket', OUTPUTS_DIR, 'Images', 'f.png')));
    assert.ok(fs.existsSync(path.join(s.projectsDir, UNSORTED_DIR, 'Images', 'n.png')));
    // counts per project
    r = (await j('GET', '/api/projects')).body;
    assert.equal(r.projects.find((p) => p.id === cache.id).count, 3);
    assert.equal(r.unsorted.count, 1);
    assert.equal(r.filing.waiting, 0);
    // move a (and what was made from it) to Rocket
    r = (await j('POST', '/api/projects/move', { ids: [a.id], project: rocket.id })).body;
    assert.equal(r.ids.length, 3); assert.equal(r.moved, 3);
    await s.app.filer.tick();
    assert.ok(fs.existsSync(path.join(s.projectsDir, 'Rocket', OUTPUTS_DIR, 'Images', 'a_up.png')));
    assert.ok(!fs.existsSync(path.join(s.projectsDir, 'Apps/Cache', OUTPUTS_DIR, 'Images', 'a.png')));
    assert.equal((await j('POST', '/api/projects/move', { ids: [a.id], project: 'p_nope' })).status, 404);
    assert.equal((await j('POST', '/api/projects/new', { name: 'Rocket' })).status, 409);
    // History list carries project + filed
    const hist = (await j('GET', '/api/history')).body.sessions.flatMap((x) => x.entries);
    assert.equal(hist.find((e) => e.id === a.id).project, rocket.id);
    assert.equal(hist.find((e) => e.id === a.id).filed['concept-app/a.png'].s, 'ok');
  } finally { await s.close(); }
});

test('server: deleting an item sends its filed Drive copy to the trash', async () => {
  const outputDir = tmp('cc-out-');
  fs.mkdirSync(path.join(outputDir, 'concept-app'));
  fs.writeFileSync(path.join(outputDir, 'concept-app', 'd.png'), pngBytes());
  let fetchImpl = async () => new Response(pngBytes());
  const s = await startStack({ projects: true, outputDir, appOptions: { filer: { fetchImpl: (...a) => fetchImpl(...a) } } });
  try {
    const e = await s.app.history.add({ prompt: 'd', images: [img('d.png')] });
    await s.app.filer.tick();
    const filed = path.join(s.projectsDir, UNSORTED_DIR, 'Images', 'd.png');
    assert.ok(fs.existsSync(filed));
    const r = await (await fetch(s.base + '/api/history/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [e.id] }) })).json();
    assert.deepEqual(r.deleted, [e.id]);
    assert.ok(!fs.existsSync(filed), 'Drive copy deleted (Drive for Desktop puts it in the Drive trash)');
  } finally { await s.close(); }
});

test('History by project: grouping folders gather their projects, top-level projects stand alone, newest first, Unsorted last', () => {
  const day = 864e5, now = new Date('2026-11-24T12:00:00');
  const data = { root: 'ACTIVE', projects: [
    { id: 'p1', name: 'Cache', group: ['Apps'] }, { id: 'p2', name: 'Slate', group: ['Apps'] },
    { id: 'p3', name: 'Rocket', group: [] }, { id: 'p4', name: 'Mod A', group: ['GTA 6 Mods'] },
  ] };
  const e = (id, project, ago) => ({ id, project, createdAt: now.getTime() - ago * day, images: [img(id + '.png')] });
  const blocks = byProject([e('a', 'p1', 0), e('b', 'p2', 3), e('c', 'p3', 1), e('d', null, 0.1), e('f', 'gone', 0.2), e('g', 'p1', 2)], data, now);
  assert.deepEqual(blocks.map((b) => b.head), ['Apps', null, null]);
  assert.deepEqual(blocks[0].projects.map((p) => [p.label, p.entries.length]), [['Cache', 2], ['Slate', 1]]);
  assert.equal(blocks[1].projects[0].label, 'Rocket');
  assert.equal(blocks[2].projects[0].label, 'Unsorted');
  assert.deepEqual(blocks[2].projects[0].entries.map((x) => x.id), ['d', 'f'], 'unknown project -> Unsorted');
  assert.match(blocks[0].projects[0].sub, /Today/);
});

test('viewer Details: where the Drive copy is (filed, waiting, moving, missing)', () => {
  const data = { root: 'ACTIVE', projects: [{ id: 'p1', name: 'Cache', group: ['Apps'] }] };
  const e = { images: [img('a.png')], project: 'p1' };
  assert.deepEqual(driveInfo(e, data), { state: 'waiting', path: '' });
  assert.deepEqual(driveInfo({ ...e, filed: { 'concept-app/a.png': { p: 'p1', f: 'Images/a.png', s: 'ok' } } }, data), { state: 'ok', path: 'ACTIVE/Apps/Cache/__comfy outputs/Images/a.png' });
  assert.equal(driveInfo({ ...e, filed: { 'concept-app/a.png': { p: null, f: 'Images/a.png', s: 'ok' } } }, data).state, 'moving');
  assert.equal(driveInfo({ ...e, project: null, filed: { 'concept-app/a.png': { p: null, f: 'Images/a.png', s: 'ok' } } }, data).path, 'ACTIVE/__Comfy UI/Images/a.png');
  assert.equal(driveInfo({ ...e, filed: { 'concept-app/a.png': { p: 'p1', f: 'Images/a.png', s: 'missing' } } }, data).state, 'missing');
});

test('UI wiring: chip at the top of the form, Move in the selection bar and the viewer menu, By project / By date, shell cached', () => {
  const html = read('app/index.html');
  assert.ok(html.indexOf('id="project-row"') < html.indexOf('id="prompt"'), 'chip above the prompt');
  const main = read('app/js/main.js');
  assert.match(main, /new ProjectChip\(\$\('#project-row'\)\)/);
  assert.match(main, /source: Object\.values\(refs\.values\)/, 'Use as reference sends its source picture');
  const hv = read('app/js/ui/history-view.js');
  assert.match(hv, /act: 'move'/); assert.match(hv, /'By project'/); assert.match(hv, /'By date'/);
  assert.match(read('app/js/ui/viewer.js'), /Move to project…/);
  const sw = read('app/sw.js');
  assert.match(sw, /'\/js\/ui\/projects\.js'/);
  assert.match(sw, /shell-v33/);
  assert.match(read('app/js/ui/projects.js'), /act: 'use-here'/, 'inside a folder: use that folder itself');
});

test('Save to Drive starts in the current project (or ACTIVE/__Comfy UI) and never makes My Drive/Comfy UI again', async () => {
  const s = await startStack({ projects: true });
  const j = async (method, url, body) => { const r = await fetch(s.base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
  try {
    let r = (await j('GET', '/api/drive/folders?path=')).body;
    assert.equal(r.defaults.image, 'Creative/PROJECTS/ACTIVE/__Comfy UI/Images');
    assert.equal(r.defaults['3d'], 'Creative/PROJECTS/ACTIVE/__Comfy UI/3D');
    fs.mkdirSync(path.join(s.projectsDir, 'Apps', 'Cache'), { recursive: true });
    const cache = (await j('POST', '/api/projects', { path: 'Apps/Cache' })).body;
    r = (await j('GET', `/api/drive/folders?path=Creative/PROJECTS/ACTIVE/Apps/Cache/__comfy outputs/Images&project=${cache.id}`)).body;
    assert.equal(r.defaults.image, 'Creative/PROJECTS/ACTIVE/Apps/Cache/__comfy outputs/Images');
    assert.equal(r.path, 'Creative/PROJECTS/ACTIVE/Apps/Cache/__comfy outputs/Images', 'the default kind folder is made on first use');
    // the old remembered folder is gone: the server falls back to My Drive, the sheet then opens the default
    assert.equal((await j('GET', '/api/drive/folders?path=Comfy UI/Images')).body.path, '');
    assert.ok(!fs.existsSync(path.join(s.driveRoot, 'My Drive', 'Comfy UI')), 'no top-level Comfy UI folder');
    assert.match(read('app/js/ui/drive-folder.js'), /if \(path && !r\.path && kind && r\.defaults\?\.\[kind\]\)/);
  } finally { await s.close(); }
});
