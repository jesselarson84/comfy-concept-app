// Migration on read: state saved with the retired "App presets" (Fast concept /
// From reference image) still loads and maps to the Klein 4B presets, and the
// files on disk are never rewritten by reading them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startStack } from './helpers.js';
import { LEGACY_PRESETS, DEFAULT_PRESET, resolvePresetId, presetLabel, remapReference, migrateHistoryEntry, isLegacyPreset } from '../../app/js/lib/legacy-presets.js';
import { oldHistory, oldChats } from '../fixtures/legacy-state.js';

const j = async (r) => { assert.ok(r.ok, `HTTP ${r.status}`); return r.json(); };

test('legacy ids map: Fast concept -> Klein 4B T2I, From reference image -> Klein 4B Image Edit; others unchanged', () => {
  assert.equal(DEFAULT_PRESET, 'ai:z-image-turbo'); // batch 17: the fresh-client default
  assert.equal(resolvePresetId('fast-concept'), 'ai:klein-4b-t2i');
  assert.equal(resolvePresetId('from-reference-image'), 'ai:klein-4b-edit');
  for (const id of ['ai:flux1-dev-gguf', 'user:abc', 'action:upscale', 'builder:test', 'my-import', '', undefined, null, 'constructor', '__proto__', 'toString']) assert.equal(resolvePresetId(id), id);
  assert.equal(isLegacyPreset('toString'), false);
  assert.equal(presetLabel('fast-concept'), 'FLUX.2 Klein 4B Text to Image (was Fast concept)');
  assert.equal(presetLabel('from-reference-image', [{ id: 'ai:klein-4b-edit', label: 'Klein Edit (live)' }]), 'Klein Edit (live) (was From reference image)');
  assert.equal(presetLabel('ai:x', [{ id: 'ai:x', label: 'X' }]), 'X');
  assert.equal(presetLabel('my-import'), 'my-import');
  assert.equal(presetLabel(undefined), '');
  assert.ok(Object.isFrozen(LEGACY_PRESETS));
});

test('remapReference: old reference node -> the new preset\'s image slot; bad shapes give {}', () => {
  assert.deepEqual(remapReference({ 10: 'old-ref.png' }, [{ node: '76' }]), { 76: 'old-ref.png' });
  assert.deepEqual(remapReference({ 76: 'a.png', 10: 'b.png' }, [{ node: '76' }, { node: '77' }]), { 76: 'a.png', 77: 'b.png' });
  assert.deepEqual(remapReference({ 10: 'a.png', 11: 'b.png' }, [{ node: '76' }]), { 76: 'a.png' }, 'extra references dropped');
  assert.deepEqual(remapReference({ 10: 'a.png' }, []), {});
  for (const bad of [null, undefined, 'x.png', ['a'], 5, { 10: 42 }]) assert.deepEqual(remapReference(bad, [{ node: '76' }]), {});
});

test('migrateHistoryEntry returns a mapped copy and never touches the stored entry', () => {
  const e = oldHistory().entries[1];
  const frozen = JSON.stringify(e);
  const m = migrateHistoryEntry(e);
  assert.equal(m.workflow, 'ai:klein-4b-edit');
  assert.equal(m.legacyWorkflow, 'from-reference-image');
  assert.deepEqual(m.reference, { 10: 'old-ref.png' }, 'reference kept as recorded (the client re-targets it to the slot)');
  assert.equal(JSON.stringify(e), frozen);
  const cur = { workflow: 'ai:klein-4b-t2i', prompt: 'x' };
  assert.equal(migrateHistoryEntry(cur), cur);
  assert.equal(migrateHistoryEntry(null), null);
});

let s;
before(async () => { s = await startStack({ folderWorkflows: false, legacyFiles: true, data: { 'history.json': oldHistory(), 'chats.json': oldChats() } }); });
after(() => s?.close());

test('old data/history.json loads; entries come back mapped (legacyWorkflow kept); the file is not rewritten by reading', async () => {
  const file = path.join(s.dataDir, 'history.json');
  const before = fs.readFileSync(file);
  const { sessions } = await j(await fetch(s.base + '/api/history'));
  const by = Object.fromEntries(sessions.flatMap((x) => x.entries).map((e) => [e.id, e]));
  assert.equal(by.h_oldfast0001.workflow, 'ai:klein-4b-t2i');
  assert.equal(by.h_oldfast0001.legacyWorkflow, 'fast-concept');
  assert.equal(by.h_oldref00001.workflow, 'ai:klein-4b-edit');
  assert.equal(by.h_oldref00001.strength, 0.6);
  assert.equal(by.h_oldup000001.workflow, 'action:upscale');
  assert.equal(by.h_oldup000001.legacyWorkflow, undefined);
  const favs = (await j(await fetch(s.base + '/api/history?favorites=1'))).sessions.flatMap((x) => x.entries);
  assert.deepEqual(favs.map((e) => [e.id, e.workflow]), [['h_oldfast0001', 'ai:klein-4b-t2i']]);
  assert.deepEqual(fs.readFileSync(file), before, 'history.json untouched by GET');
  // A user action (favourite) saves the entry as it was stored, not the mapped copy.
  const r = await j(await fetch(s.base + '/api/history/h_oldref00001', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ favorite: true }) }));
  assert.equal(r.workflow, 'ai:klein-4b-edit');
  await new Promise((res) => setTimeout(res, 100));
  const stored = JSON.parse(fs.readFileSync(file, 'utf8')).entries.find((e) => e.id === 'h_oldref00001');
  assert.equal(stored.workflow, 'from-reference-image', 'stored id unchanged');
  assert.equal(stored.favorite, true);
  assert.deepEqual(stored.reference, { 10: 'old-ref.png' });
});

test('batch 15: an old data/chats.json is left on disk untouched (the Prompt assistant is gone)', async () => {
  const file = path.join(s.dataDir, 'chats.json');
  const before = fs.readFileSync(file);
  assert.equal((await fetch(s.base + '/api/chats')).status, 404);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('retired preset files left in workflows/ are not listed; the Klein presets they map to are', async () => {
  assert.ok(fs.existsSync(path.join(s.wfDir, 'fast-concept.json')));
  const { workflows } = await j(await fetch(s.base + '/api/workflows'));
  const ids = workflows.map((w) => w.id);
  assert.ok(!ids.includes('fast-concept') && !ids.includes('from-reference-image'));
  assert.ok(ids.includes('ai:klein-4b-t2i') && ids.includes('ai:klein-4b-edit'));
  assert.ok(!workflows.some((w) => !w.ai), 'no folder presets in this stack');
  assert.ok(!workflows.some((w) => w.group === 'App'));
  const edit = workflows.find((w) => w.id === 'ai:klein-4b-edit');
  assert.deepEqual(edit.controls.images.map((i) => i.node), ['76'], 'the slot old references are re-targeted to');
});

test('memory before-queue still answers for an old workflow id (old queued state)', async () => {
  const r = await fetch(s.base + '/api/memory/before-queue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflow: 'fast-concept' }) });
  assert.equal(r.status, 200);
});
