// Batch 3 follow-up: no warning labels on presets; only installed voice models;
// Favorites folder tile; Qwen 2509 three references; ACE-Step Auto key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installedPacks } from '../../server/presets.js';
import { startStack } from './helpers.js';

const j = (r) => r.json();

test('presets: no "slow · RAM offload" / "tight on" labels in /api/workflows or in the builder chat context', async () => {
  const s = await startStack();
  try {
    const { workflows } = await j(await fetch(s.base + '/api/workflows?fresh=1'));
    for (const w of workflows) if (w.availability && w.availability.status !== 'unavailable' && w.availability.status !== 'unknown') assert.equal(w.availability.label || '', '', w.id);
    assert.doesNotMatch(JSON.stringify(workflows), /RAM offload|tight on \d/);
    const src = fs.readFileSync(new URL('../../app/js/lib/presets.js', import.meta.url), 'utf8') + fs.readFileSync(new URL('../../server/builder.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /slow · RAM offload|tight on \$/);
  } finally { await s.close(); }
});

test('installed voice models: Chatterbox packs from /models/chatterbox, VibeVoice from models/tts/VibeVoice/<name>', () => {
  const cb = { options: ['chatterbox', 'chatterbox-turbo', 'chatterbox-multilingual-hi'], installed: { folder: 'chatterbox', prefix: '{v}/' } };
  assert.deepEqual(installedPacks(cb, { models: { chatterbox: ['_shared\\s3gen.safetensors', 'chatterbox\\t3_cfg.safetensors', 'chatterbox\\conds.pt'] } }), ['chatterbox']);
  assert.deepEqual(installedPacks(cb, { models: { chatterbox: ['chatterbox/t3_cfg.safetensors', 'chatterbox-turbo/t3_turbo_v1.safetensors', 'chatterbox-multilingual-hi/readme.txt'] } }), ['chatterbox', 'chatterbox-turbo']);
  assert.equal(installedPacks(cb, { models: {} }), null, 'no listing: keep the list');
  assert.equal(installedPacks(cb, { models: { chatterbox: [] } }), null, 'nothing installed: the preset is unavailable anyway');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-tts-'));
  fs.mkdirSync(path.join(root, 'VibeVoice', 'VibeVoice-1.5B'), { recursive: true });
  fs.writeFileSync(path.join(root, 'VibeVoice', 'VibeVoice-1.5B', 'model-00001-of-00003.safetensors'), 'x');
  fs.mkdirSync(path.join(root, 'VibeVoice', 'VibeVoice-7B'), { recursive: true }); // empty folder = not installed
  const vv = { options: ['VibeVoice-1.5B', 'VibeVoice-7B'], installed: { fsFolder: 'tts', dir: 'VibeVoice/{v}' } };
  assert.deepEqual(installedPacks(vv, { folderPaths: { tts: [[root], ['.safetensors']] } }), ['VibeVoice-1.5B']);
  assert.equal(installedPacks(vv, { folderPaths: null }), null, 'remote ComfyUI: cannot check, keep the list');
});

test('installed voice models end to end: the Chatterbox and VibeVoice selects list only what is on the PC', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-tts-'));
  fs.mkdirSync(path.join(root, 'VibeVoice', 'VibeVoice-1.5B'), { recursive: true });
  for (const n of ['model-00001-of-00003', 'model-00002-of-00003', 'model-00003-of-00003']) fs.writeFileSync(path.join(root, 'VibeVoice', 'VibeVoice-1.5B', n + '.safetensors'), 'x');
  const s = await startStack({ comfyOptions: { folderPaths: { tts: [[root], ['.safetensors']] } } });
  try {
    const { workflows } = await j(await fetch(s.base + '/api/workflows?fresh=1'));
    const p = (id) => workflows.find((w) => w.id === id).ai.params;
    assert.deepEqual(p('ai:tts-chatterbox').voice.options, ['chatterbox']);
    assert.deepEqual(p('ai:tts-vibevoice').model.options, ['VibeVoice-1.5B']);
    assert.equal(p('ai:tts-vibevoice').model.default, 'VibeVoice-1.5B');
  } finally { await s.close(); }
});

// ---- Qwen Edit 2509: three references ----------------------------------------------
import { validatePreset, applyPresetParams, dropEmptyOptional, resolveAutoKey } from '../../app/js/lib/presets.js';
const ROOT = new URL('../../', import.meta.url).pathname;
const objectInfo = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/object-info.json'), 'utf8'));
const preset = (id) => validatePreset(id, JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows/ai', id + '.json'), 'utf8')));

test('Qwen 2509: image1/image2/image3 of TextEncodeQwenImageEditPlus (real /object_info inputs); slots 2-3 optional and dropped when empty', () => {
  const p = preset('qwen-edit-2509');
  assert.equal(p.ok, true, p.error);
  const spec = objectInfo.TextEncodeQwenImageEditPlus.input;
  for (const i of ['image1', 'image2', 'image3']) assert.ok(spec.optional[i], i);
  for (const n of ['7', '8']) {
    assert.deepEqual(p.workflow[n].inputs.image1, ['14', 0]); // 6 -> FluxKontextImageScale 14
    assert.deepEqual(p.workflow[n].inputs.image2, ['21', 0]);
    assert.deepEqual(p.workflow[n].inputs.image3, ['22', 0]);
  }
  assert.deepEqual(p.manifest.optional.map((o) => o.node), ['21', '22']);
  // only slot 1 filled: 21 and 22 gone, no dangling links
  const only1 = dropEmptyOptional(p.manifest, structuredClone(p.workflow), new Set(['6']));
  assert.ok(!only1['21'] && !only1['22']);
  for (const n of ['7', '8']) { assert.deepEqual(Object.keys(only1[n].inputs).filter((k) => k.startsWith('image')), ['image1']); }
  for (const [id, n] of Object.entries(only1)) for (const v of Object.values(n.inputs)) if (Array.isArray(v)) assert.ok(only1[v[0]], `${id} links to missing ${v[0]}`);
  // slots 1 + 2 filled: 22 dropped, 21 kept
  const two = dropEmptyOptional(p.manifest, structuredClone(p.workflow), new Set(['6', '21']));
  assert.ok(two['21'] && !two['22']);
  assert.deepEqual(two['7'].inputs.image2, ['21', 0]); assert.equal(two['7'].inputs.image3, undefined);
});

// ---- ACE-Step Auto key ------------------------------------------------------------
test('ACE-Step: "Auto" key (default) resolves to the key named in the tags, else one from the seed; keyscale is always a real option', () => {
  const p = preset('ace-step-15');
  assert.equal(p.ok, true, p.error);
  const k = p.manifest.params.key;
  assert.equal(k.default, 'auto'); assert.equal(k.options[0], 'auto'); assert.equal(k.labels.auto, 'Auto');
  const real = objectInfo['TextEncodeAceStepAudio1.5'].input.required.keyscale[1].options;
  const run = (tags, seed, key = 'auto') => { const wf = structuredClone(p.workflow); wf[k.node].inputs.tags = tags; wf[k.node].inputs.seed = seed; return applyPresetParams(p.manifest, wf, { key }); };
  let g = run('dark synthwave in F# minor, 100 bpm', 5);
  assert.equal(g[k.node].inputs.keyscale, 'F# minor');
  assert.equal(g[k.node].inputs.tags, 'dark synthwave in F# minor, 100 bpm', 'tags untouched');
  g = run('lofi hip hop, Am, rainy', 5);
  assert.equal(g[k.node].inputs.keyscale, 'A minor');
  const a = run('cheerful pop', 12345)[k.node].inputs.keyscale, b = run('cheerful pop', 12345)[k.node].inputs.keyscale;
  assert.equal(a, b, 'same seed, same key'); assert.ok(real.includes(a));
  assert.equal(run('cheerful pop', 1, 'D minor')[k.node].inputs.keyscale, 'D minor', 'a picked key still wins');
  assert.equal(resolveAutoKey(['auto', 'C# major', 'Bb minor'], 'in Db major and A# minor'), 'C# major', 'enharmonic spelling');
  assert.doesNotMatch(JSON.stringify(run('x', 3)), /"auto"/, 'the graph never gets "auto"');
});

test('ACE-Step: "Auto" survives the installed-options filter in /api/workflows', async () => {
  const s = await startStack();
  try {
    const { workflows } = await j(await fetch(s.base + '/api/workflows?fresh=1'));
    const k = workflows.find((w) => w.id === 'ai:ace-step-15').ai.params.key;
    assert.equal(k.options[0], 'auto'); assert.equal(k.default, 'auto');
  } finally { await s.close(); }
});

// ---- Favorites as a folder tile -----------------------------------------------------
test('Folders API: Favorites is a tile backed by the star flag (count follows starring/unstarring), not a label store', async () => {
  const s = await startStack();
  try {
    const post = (p, b, m = 'POST') => fetch(s.base + p, { method: m, headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(j);
    const e = await post('/api/history', { workflow: 'ai:z-image-turbo', images: [{ filename: 'f.png', subfolder: 'concept-app', type: 'output' }] });
    assert.equal((await j(await fetch(s.base + '/api/folders'))).favorites.count, 0);
    await post(`/api/history/${e.id}`, { favorite: true }, 'PATCH');
    const f = await j(await fetch(s.base + '/api/folders'));
    assert.equal(f.favorites.count, 1); assert.equal(f.favorites.cover.filename, 'f.png');
    assert.ok(!f.folders.some((x) => /favorite/i.test(x.name)), 'not stored as a label folder');
    assert.equal(fs.existsSync(path.join(s.dataDir, 'folders.json')), false, 'nothing written to the label store');
    await post(`/api/history/${e.id}`, { favorite: false }, 'PATCH');
    assert.equal((await j(await fetch(s.base + '/api/folders'))).favorites.count, 0);
  } finally { await s.close(); }
});

test('Qwen 2509 edits in place like 2511: input VAE-encoded, vae into both text encoders, sampler starts from the input latent at denoise 1', () => {
  const p = preset('qwen-edit-2509');
  assert.equal(p.ok, true, p.error);
  const w = p.workflow;
  assert.ok(!Object.values(w).some((n) => /^Empty.*Latent/.test(n.class_type)), 'no empty latent');
  assert.equal(w['14'].class_type, 'FluxKontextImageScale'); assert.deepEqual(w['14'].inputs.image, ['6', 0]);
  assert.equal(w['9'].class_type, 'VAEEncode'); assert.deepEqual(w['9'].inputs, { pixels: ['14', 0], vae: ['5', 0] });
  for (const n of ['7', '8']) { assert.deepEqual(w[n].inputs.vae, ['5', 0]); assert.deepEqual(w[n].inputs.image1, ['14', 0]); }
  assert.deepEqual(w['10'].inputs.latent_image, ['9', 0]); assert.equal(w['10'].inputs.denoise, 1);
  assert.equal(p.manifest.size, null, 'output size follows the input picture');
  // every input used exists in /object_info
  for (const [id, n] of Object.entries(w)) {
    const def = objectInfo[n.class_type]; assert.ok(def, n.class_type);
    const spec = { ...(def.input.required || {}), ...(def.input.optional || {}) };
    for (const k of Object.keys(n.inputs)) assert.ok(k in spec, `${id} ${n.class_type}.${k}`);
  }
  // slot 1 only: still valid, no dangling links
  const only1 = dropEmptyOptional(p.manifest, structuredClone(w), new Set(['6']));
  for (const [id, n] of Object.entries(only1)) for (const v of Object.values(n.inputs)) if (Array.isArray(v)) assert.ok(only1[v[0]], `${id} -> ${v[0]}`);
  assert.deepEqual(Object.keys(only1['7'].inputs).filter((k) => k.startsWith('image')), ['image1']);
});
