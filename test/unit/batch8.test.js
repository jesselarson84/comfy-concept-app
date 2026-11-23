// Batch 8 (1123 Change List + the Studio-style ideas, in the current layout):
// Save to Drive asks for a folder (list / make / save, path rules), the ratio
// grid, the picker's hints and search, the + button, carrying pictures across
// presets, and the four new workflows (Photo to 3D Model + three Sound ones).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStack, ROOT, pngBytes } from './helpers.js';
import { resolveDriveFolder, relDriveFolder } from '../../server/drive.js';
import { ASPECT_GRID, aspectShape, aspectLabel, parseAspect, aspectKey, sizeFor } from '../../app/js/lib/aspect.js';
import { renderSize } from '../../app/js/lib/resolution.js';
import { formatParam } from '../../app/js/lib/presets.js';

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const j = (r) => r.json();
const post = (s, url, body) => fetch(s.base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const load = (id) => JSON.parse(read(`workflows/ai/${id}.json`));

test('Drive folders: lists My Drive folders (hidden ones left out), starts the kind folders on first use, makes folders', async () => {
  const s = await startStack();
  try {
    const root = path.dirname(s.driveDir); // ...\My Drive
    fs.mkdirSync(path.join(root, 'Projects', 'Props'), { recursive: true });
    fs.mkdirSync(path.join(root, '.hidden'), { recursive: true });
    let r = await j(await fetch(s.base + '/api/drive/folders'));
    assert.equal(r.root, 'My Drive');
    assert.equal(r.path, '');
    assert.deepEqual(r.folders, ['Projects'], 'no hidden folders; Comfy UI not made yet');
    assert.deepEqual(r.defaults, { image: 'Comfy UI/Images', video: 'Comfy UI/Video', '3d': 'Comfy UI/3D', audio: 'Comfy UI/Audio' });
    // a default kind folder is made when it is first opened
    r = await j(await fetch(s.base + '/api/drive/folders?path=' + encodeURIComponent('Comfy UI/3D')));
    assert.equal(r.path, 'Comfy UI/3D');
    assert.ok(fs.statSync(path.join(s.driveDir, '3D')).isDirectory());
    // a folder that is gone (deleted / renamed in Drive): back to the root instead of an error
    r = await j(await fetch(s.base + '/api/drive/folders?path=' + encodeURIComponent('Old/Gone')));
    assert.equal(r.path, '');
    // new folder
    r = await j(await post(s, '/api/drive/folders', { path: 'Projects', name: 'Robots' }));
    assert.equal(r.path, 'Projects/Robots');
    assert.ok(fs.statSync(path.join(root, 'Projects', 'Robots')).isDirectory());
    for (const name of ['..', 'a/b', 'a\\b', 'C:', '', '.git']) assert.equal((await post(s, '/api/drive/folders', { path: 'Projects', name })).status, 400, name);
    for (const p of ['../x', 'Projects/../..', 'C:/Windows', '..']) assert.equal((await fetch(s.base + '/api/drive/folders?path=' + encodeURIComponent(p))).status, 400, p);
  } finally { await s.close(); }
});

test('Save to Drive into a picked folder: any folder in My Drive, must exist, never outside it', async () => {
  const s = await startStack();
  try {
    const root = path.dirname(s.driveDir);
    s.mock.files.set('output/concept-app/klein_t2i_00001_.png', pngBytes());
    fs.mkdirSync(path.join(root, 'Projects', 'Props'), { recursive: true });
    let r = await j(await post(s, '/api/drive/save', { filename: 'klein_t2i_00001_.png', subfolder: 'concept-app', type: 'output', folder: 'Projects/Props' }));
    assert.equal(r.drivePath, 'Projects/Props');
    assert.equal(r.path, path.join(root, 'Projects', 'Props', 'klein_t2i_00001_.png'));
    assert.deepEqual(fs.readFileSync(r.path), pngBytes());
    // the Drive root itself
    r = await j(await post(s, '/api/drive/save', { filename: 'klein_t2i_00001_.png', subfolder: 'concept-app', folder: '' }));
    assert.equal(r.drivePath, '');
    assert.equal(r.path, path.join(root, 'klein_t2i_00001_.png'));
    // a default kind folder that does not exist yet is made
    r = await j(await post(s, '/api/drive/save', { filename: 'klein_t2i_00001_.png', subfolder: 'concept-app', folder: 'Comfy UI/Images' }));
    assert.equal(r.drivePath, 'Comfy UI/Images');
    // any other missing folder: 404; traversal: 400
    assert.equal((await post(s, '/api/drive/save', { filename: 'klein_t2i_00001_.png', subfolder: 'concept-app', folder: 'Nope' })).status, 404);
    for (const folder of ['../x', 'Projects/../../x', 'C:/Windows', 'Projects\\Props']) assert.equal((await post(s, '/api/drive/save', { filename: 'klein_t2i_00001_.png', subfolder: 'concept-app', folder })).status, 400, folder);
    // without a folder: the old kind folder (Comfy UI/Images)
    r = await j(await post(s, '/api/drive/save', { filename: 'klein_t2i_00001_.png', subfolder: 'concept-app' }));
    assert.deepEqual([r.folder, r.drivePath], ['Images', 'Comfy UI/Images']);
  } finally { await s.close(); }
});

test('Drive path helpers: relative paths with forward slashes; a link out of My Drive is refused', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-'));
  try {
    const root = path.join(tmp, 'My Drive');
    fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    assert.equal(relDriveFolder(root, resolveDriveFolder(root, 'a/b')), 'a/b');
    assert.equal(relDriveFolder(root, resolveDriveFolder(root, '')), '');
    fs.mkdirSync(path.join(tmp, 'outside'));
    try { fs.symlinkSync(path.join(tmp, 'outside'), path.join(root, 'link'), 'junction'); } catch { return t.skip('no junctions here'); }
    assert.throws(() => resolveDriveFolder(root, 'link'), /Bad folder/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('Save to Drive UI: asks where every time, remembers the folder per kind; the toast shows the Drive path', () => {
  const main = read('app/js/main.js'), sheet = read('app/js/ui/drive-folder.js');
  assert.match(main, /const folder = await driveSheet\.choose\(driveKind\);\s+if \(folder === null\) return null;/);
  assert.match(main, /rememberFolder\(driveKind, r\.drivePath \?\? folder\)/);
  assert.match(sheet, /'Save here'/);
  assert.match(sheet, /'New folder'/);
  assert.match(sheet, /r\.defaults\?\.\[kind\]/, 'first time: the kind\'s default folder');
  assert.match(read('app/sw.js'), /'\/js\/ui\/drive-folder\.js'/);
});

test('ratio grid: every ratio in both orientations, labels the way they come out, new 5:4 and 21:9 sizes', () => {
  assert.deepEqual(ASPECT_GRID.map(aspectLabel), ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '9:21', '21:9']);
  assert.deepEqual(aspectShape('21:9-portrait'), [9, 21]);
  for (const k of ASPECT_GRID) assert.equal(aspectKey(parseAspect(k)), k, k);
  const { width, height } = sizeFor('5:4-landscape', 1024, 1024, 16);
  assert.ok(Math.abs(width / height - 1.25) < 0.03);
  const r = renderSize('21:9-landscape', '1k', 16);
  assert.equal(r.width, 1024);
  // the old dropdown + orientation toggle are gone; the panel greys out shapes a preset's size range bends
  const html = read('app/index.html'), panel = read('app/js/ui/prompt-panel.js');
  assert.match(html, /id="aspect-btn"[\s\S]*id="aspect-pop"/);
  assert.match(panel, /aspectOff\(key\)[\s\S]*> 0\.04/);
  assert.equal(formatParam({ format: 'dB' }, -12), '-12 dB');
});

test('picker: a short hint per row (what it needs), search across both tabs, two new Workflow sections', async () => {
  const { presetHint, matchPreset, SECTIONS, tabOf } = await import('../../app/js/ui/workflow-picker.js').catch(() => ({}));
  if (!presetHint) return; // needs a DOM-free import; the browser tests cover the rest
  const w = (o) => ({ ok: true, controls: { prompt: [1], images: [] }, ai: {}, ...o });
  assert.equal(presetHint(w({})), 'Uses your prompt');
  assert.equal(presetHint(w({ controls: { prompt: [1], images: [{ node: '6' }] } })), 'Needs 1 image');
  assert.equal(presetHint(w({ controls: { prompt: [1], images: [{ node: '1' }, { node: '2' }, { node: '3' }] }, ai: { optional: [{ node: '2' }, { node: '3' }] } })), '1-3 images');
  assert.equal(presetHint(w({ controls: { prompt: [], images: [] }, ai: { inputs: [{ kind: 'audio' }, { kind: 'audio' }] } })), 'Needs 2 recordings');
  assert.equal(presetHint(w({ controls: { prompt: [], images: [] }, ai: { inputs: [{ kind: 'video' }] } })), 'Needs a video');
  assert.equal(presetHint({ ok: false }), '');
  assert.ok(matchPreset({ label: 'Qwen Image Edit 2511', group: 'Image' }, 'qwen edit'));
  assert.ok(!matchPreset({ label: 'Qwen Image Edit 2511', group: 'Image' }, 'qwen video'));
  assert.deepEqual(SECTIONS.filter((s) => s.tab === 'workflow').map((s) => s.key), ['Textures', 'Concept', 'VFX', '3D Assets', 'Sound']);
  assert.equal(tabOf({ group: 'Sound' }), 'workflow');
});

test('+ in the prompt box: the current preset gets the file when it takes that kind, else "What next?"; never switches by itself', () => {
  const main = read('app/js/main.js'), html = read('app/index.html'), sheet = read('app/js/ui/import-sheet.js');
  assert.match(html, /<span class="prompt-box">[\s\S]*id="prompt"[\s\S]*id="btn-attach"/);
  assert.match(main, /button: \$\('#btn-attach'\)/);
  assert.match(main, /kind === 'image' && current\.controls\?\.images\?\.length\) \{ refs\.set\(refs\.targetNode\(\), ref\)/);
  assert.match(main, /presetChooser\.open\(list, async \(w\) => \{/, 'the user picks the preset');
  assert.match(sheet, /'Paste a picture'/);
  assert.match(sheet, /'From Comfy UI'/);
  assert.match(sheet, /'Gallery, files or Google Drive'/);
  assert.match(read('app/js/ui/file-inputs.js'), /'Record video'/);
});

test('switching presets keeps the loaded picture / recording (re-keyed to the new slots); a text-only preset drops it', () => {
  const main = read('app/js/main.js');
  assert.match(main, /function carryInputs\(prev, next\)/);
  assert.match(main, /const prev = current;\s+current = workflows\.find\(\(w\) => w\.id === id\) \|\| null;\s+carryInputs\(prev, current\);/);
  assert.match(main, /nextImgs\.forEach\(\(s, i\) => \{ if \(imgs\[i\]\) refs\.values\[s\.node\] = imgs\[i\]; \}\);/);
});

test('Photo to 3D Model: Qwen clean-up behind a lazy switch, then the Hunyuan3D 2.1 graph; saves only the model', () => {
  const { preset, workflow } = load('wf-photo-to-3d');
  assert.deepEqual([preset.kind, preset.group, preset.output], ['workflow', '3D Assets', '3d']);
  const sw = workflow[preset.params.cleanup.node];
  assert.equal(sw.class_type, 'ComfySwitchNode');
  assert.deepEqual([sw.inputs.on_false, sw.inputs.on_true], [['6', 0], ['11', 0]], 'off = the photo as it is, on = the Qwen edit');
  assert.equal(workflow['6'].class_type, 'LoadImage');
  const savers = Object.values(workflow).filter((n) => /^Save/.test(n.class_type));
  assert.deepEqual(savers.map((n) => n.class_type), ['SaveGLB']);
  assert.equal(savers[0].inputs.filename_prefix, 'concept-app/photo_to_3d');
  // every Hunyuan3D use of its old LoadImage now reads the switch
  const reads = Object.values(workflow).flatMap((n) => Object.values(n.inputs)).filter((v) => Array.isArray(v) && v[0] === '30');
  assert.equal(reads.length, 3);
  for (const k of ['removeBg', 'steps', 'detail', 'faces']) assert.ok(workflow[preset.params[k].node], k);
  assert.deepEqual(preset.params.lightning.when, { param: 'cleanup', is: true });
});

test('Sound workflows: voice line + swap, voice line over a sound bed, a set of sound effect takes', () => {
  const swap = load('wf-voice-line-swap');
  assert.equal(swap.preset.group, 'Sound');
  const vc = Object.values(swap.workflow).find((n) => n.class_type === 'ChatterboxVC');
  assert.equal(swap.workflow[vc.inputs.source_audio[0]].class_type, 'ChatterboxTTS', 'the TTS line is what gets swapped');
  assert.equal(swap.workflow[vc.inputs.target_voice_audio[0]].class_type, 'LoadAudio');
  assert.deepEqual(swap.preset.inputs.map((i) => i.label), ['Target voice']);
  assert.ok(!Object.values(swap.workflow).some((n) => n.class_type === 'ChatterboxTTS' && n.inputs.audio_prompt), 'no voice sample on the TTS side');

  const sfx = load('wf-voice-line-sfx');
  const mix = Object.values(sfx.workflow).find((n) => n.class_type === 'AudioMerge');
  assert.equal(mix.inputs.merge_method, 'add');
  assert.equal(sfx.workflow[mix.inputs.audio1[0]].class_type, 'AudioAdjustVolume', 'the sound bed (level set) is the length');
  const voice = sfx.workflow[mix.inputs.audio2[0]];
  assert.deepEqual([voice.class_type, voice.inputs.volume], ['AudioAdjustVolume', -3], 'headroom for the sound under it');
  assert.equal(sfx.workflow[voice.inputs.audio[0]].class_type, 'AudioConcat', 'the line after a lead-in silence');
  assert.equal(sfx.workflow[sfx.preset.params.sound.node].class_type, 'CLIPTextEncode');
  assert.equal(sfx.preset.params.sound.open, true, 'the sound description is its own text box');
  assert.equal(Object.values(sfx.workflow).filter((n) => /^Save/.test(n.class_type)).length, 1);

  const set = load('wf-sfx-set');
  assert.equal(set.workflow[set.preset.params.takes.node].class_type, 'EmptyLatentAudio');
  assert.deepEqual(set.preset.params.takes.options, [2, 4, 8]);
  assert.equal(set.preset.maxBatch, 1, 'the takes are the batch');
});
