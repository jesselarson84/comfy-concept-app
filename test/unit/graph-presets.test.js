// Save as preset (node view): store, section rules, API, and how the presets show up in /api/workflows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GraphPresetStore, placement, cleanGraph, outputKind } from '../../server/graph-presets.js';
import { startStack } from './helpers.js';

const klein = () => JSON.parse(fs.readFileSync(new URL('../../workflows/ai/klein-4b-t2i.json', import.meta.url), 'utf8')).workflow;
const j = async (r) => ({ status: r.status, body: await r.json() });
const send = (base, method, url, body) => fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(j);

test('placement: known sections only; sub sections only where the section has them', () => {
  assert.deepEqual(placement('Image', 'Text to Image'), { group: 'Image', subgroup: 'Text to Image' });
  assert.deepEqual(placement('Image', 'Nope'), { group: 'Image', subgroup: null });
  assert.deepEqual(placement('Video', 'Text to Image'), { group: 'Video', subgroup: null });
  assert.deepEqual(placement('Random', 'x'), { group: 'My presets', subgroup: null });
});

test('cleanGraph: API format with a Save node; UI format and save-less graphs are refused with a reason', () => {
  const g = cleanGraph({ ...klein(), _meta: { x: 1 } });
  assert.equal(g._meta, undefined);
  assert.throws(() => cleanGraph({ nodes: [], links: [] }), /UI-format|Export \(API\)|not API/i);
  assert.throws(() => cleanGraph({ 1: { class_type: 'EmptyLatentImage', inputs: { width: 512 } } }), /saves nothing/);
  assert.throws(() => cleanGraph(null), /No graph/);
  assert.equal(outputKind(klein()), 'image');
  assert.equal(outputKind({ 1: { class_type: 'SaveAudio', inputs: {} } }), 'audio');
  assert.equal(outputKind({ 1: { class_type: 'SaveGLB', inputs: {} } }), '3d');
});

test('store: add / update (graph, name, move) / remove; names stay unique; survives a reload', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gp-'));
  const s = new GraphPresetStore(dir);
  const a = await s.add({ name: 'Tall poster', group: 'Image', subgroup: 'Text to Image', workflow: klein(), from: 'ai:klein-4b-t2i' });
  const b = await s.add({ name: 'tall poster', group: 'Image', subgroup: 'Text to Image', workflow: klein() });
  assert.equal(b.name, 'tall poster 2');
  const wf = klein(); wf['75:68'].inputs.value = 768;
  await s.update(a.id, { workflow: wf, name: 'Tall poster v2', group: 'Image', subgroup: 'Image Edit' });
  const again = new GraphPresetStore(dir).get(a.id);
  assert.equal(again.name, 'Tall poster v2'); assert.equal(again.subgroup, 'Image Edit'); assert.equal(again.workflow['75:68'].inputs.value, 768); assert.equal(again.from, 'ai:klein-4b-t2i');
  await s.update(a.id, { group: 'My presets' });
  assert.deepEqual([s.get(a.id).group, s.get(a.id).subgroup], ['My presets', null]);
  await assert.rejects(() => s.update(a.id, { name: '  ' }), /empty/);
  assert.equal(await s.remove(b.id), true); assert.equal(await s.remove(b.id), false);
  assert.equal(new GraphPresetStore(dir).list().length, 1);
});

test('API: saved presets appear in /api/workflows in their section with detected controls; built-ins untouched', async () => {
  const s = await startStack({ folderWorkflows: false });
  try {
    const before = (await j(await fetch(s.base + '/api/workflows'))).body.workflows.find((w) => w.id === 'ai:klein-4b-t2i').workflow;
    const r = await send(s.base, 'POST', '/api/graph-presets', { name: 'Klein poster', group: 'Image', subgroup: 'Text to Image', workflow: klein(), from: 'ai:klein-4b-t2i' });
    assert.equal(r.status, 201); assert.match(r.body.id, /^graph:g_/); assert.equal(r.body.workflow, undefined);
    let list = (await j(await fetch(s.base + '/api/workflows'))).body.workflows;
    const w = list.find((x) => x.id === r.body.id);
    assert.equal(w.ok, true); assert.equal(w.group, 'Image'); assert.equal(w.subgroup, 'Text to Image'); assert.equal(w.short, 'Klein poster'); assert.equal(w.output, 'image');
    assert.ok(w.controls.prompt.length && w.controls.width.length && w.controls.seed.length, 'prompt, size and seed detected');
    assert.deepEqual(list.find((x) => x.id === 'ai:klein-4b-t2i').workflow, before, 'built-in preset unchanged');
    // update the graph + move
    const wf = klein(); wf['75:69'].inputs.value = 1536;
    const u = await send(s.base, 'PATCH', `/api/graph-presets/${encodeURIComponent(r.body.id)}`, { workflow: wf, group: 'My presets' });
    assert.equal(u.status, 200);
    list = (await j(await fetch(s.base + '/api/workflows'))).body.workflows;
    const moved = list.find((x) => x.id === r.body.id);
    assert.equal(moved.group, 'My presets'); assert.equal(moved.subgroup, undefined); assert.equal(moved.workflow['75:69'].inputs.value, 1536);
    // refused with a reason
    const bad = await send(s.base, 'POST', '/api/graph-presets', { name: 'x', group: 'Image', workflow: { nodes: [], links: [] } });
    assert.equal(bad.status, 400); assert.match(bad.body.error, /API|UI-format/i);
    assert.equal((await send(s.base, 'PATCH', '/api/graph-presets/graph:g_nope', { name: 'y' })).status, 404);
    // delete
    assert.equal((await send(s.base, 'DELETE', `/api/graph-presets/${encodeURIComponent(r.body.id)}`)).status, 200);
    list = (await j(await fetch(s.base + '/api/workflows'))).body.workflows;
    assert.ok(!list.some((x) => x.id === r.body.id));
    assert.ok(fs.existsSync(path.join(s.dataDir, 'graph-presets.json')), 'stored in data/ (git-ignored)');
  } finally { await s.close(); }
});
