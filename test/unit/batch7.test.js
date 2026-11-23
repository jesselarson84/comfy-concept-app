// Batch 7: Import (photo / video / recording -> "What next?"), Photo to Texture,
// PBR maps (image math + CHORD), Depth + Normal, Concept Looks from a render,
// Stable Audio 3 SFX, voice swap, the recorder, the Android capture changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validatePreset, formatPrompt, paramActive } from '../../app/js/lib/presets.js';
import { kindOf, presetsFor } from '../../app/js/ui/import-sheet.js';
import { recordingType, extFor } from '../../app/js/lib/recorder.js';
import { buildMessages, styleFor } from '../../app/js/lib/chat-context.js';
import { ROOT, startStack } from './helpers.js';

const load = (id) => validatePreset(id, JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows/ai', `${id}.json`), 'utf8')));
const nodes = (p, cls) => Object.entries(p.workflow).filter(([, n]) => n.class_type === cls);
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('import: file kinds from type or name; presets offered by what they take', () => {
  assert.equal(kindOf({ type: 'image/jpeg', name: 'IMG_1.jpg' }), 'image');
  assert.equal(kindOf({ type: '', name: 'capture_1.mp4' }), 'video');
  assert.equal(kindOf({ type: 'audio/webm', name: 'recording.webm' }), 'audio');
  assert.equal(kindOf({ type: 'application/pdf', name: 'x.pdf' }), null);
  const wfs = [
    { id: 'a', ok: true, controls: { images: [{ node: '1' }] } },
    { id: 'v', ok: true, controls: { images: [] }, ai: { inputs: [{ kind: 'video', node: '2' }] } },
    { id: 's', ok: true, controls: { images: [] }, ai: { inputs: [{ kind: 'audio', node: '3' }] } },
    { id: 'off', ok: false, controls: { images: [{ node: '1' }] } },
  ];
  assert.deepEqual(presetsFor('image', wfs).map((w) => w.id), ['a']);
  assert.deepEqual(presetsFor('video', wfs).map((w) => w.id), ['v']);
  assert.deepEqual(presetsFor('audio', wfs).map((w) => w.id), ['s']);
});

test('recorder: best container the browser has; file extension follows it', () => {
  assert.equal(recordingType((t) => t === 'audio/webm'), 'audio/webm');
  assert.equal(recordingType((t) => t === 'audio/mp4'), 'audio/mp4');
  assert.equal(recordingType(() => false), '');
  assert.equal(extFor('audio/webm;codecs=opus'), 'webm');
  assert.equal(extFor('audio/mp4'), 'm4a');
  // recorded dry: no browser processing on the voice
  assert.match(read('app/js/lib/recorder.js'), /echoCancellation: false, noiseSuppression: false, autoGainControl: false/);
});

test('Photo to Texture: your notes go into the edit with lighting removal; tiling + size; the assistant writes notes', () => {
  const p = load('wf-photo-texture');
  assert.ok(p.ok, p.error);
  const m = p.manifest;
  assert.equal(m.group, 'Textures'); assert.equal(m.menuOrder, 0, 'first in Textures');
  const f = formatPrompt(m, 'flatten the dented panel underneath, keep the chipped paint and every chip');
  assert.match(f, /^flatten the dented panel underneath, keep the chipped paint and every chip\. Remove all shadows/);
  assert.match(f, /photorealistic/); assert.doesNotMatch(f, /texture map/, '"texture map" gave an illustrated look');
  assert.match(formatPrompt(m, ''), /^keep all of the surface's own detail/);
  // edit -> snap -> (tile switch: seam fix) -> 4x model -> size
  assert.equal(nodes(p, 'TextEncodeQwenImageEditPlus').length, 2);
  const tile = p.workflow[m.params.tile.node];
  assert.equal(tile.class_type, 'ComfySwitchNode');
  assert.equal(paramActive(m.params.method, { tile: false }, m.params), false, 'seam method dims with Tiling off');
  assert.deepEqual(m.params.size.options, [1024, 2048, 4096]);
  assert.equal(nodes(p, 'SaveImage').length, 1);
  // prompt assistant: edit notes, not a picture description
  assert.match(m.assistant, /edit notes/);
  assert.equal(styleFor({ ai: m }), m.assistant);
  const sys = buildMessages({ current: { prompt: '', preset: m.label, workflow: { ai: m } }, userText: 'remove the dents' })[0].content;
  assert.match(sys, /keep and what to remove/);
  assert.match(styleFor({ workflow: { 1: { class_type: 'X', inputs: {} } } }), /natural-language/, 'other presets unchanged');
});

test('PBR Maps (image math): six maps, wrap-around slopes, DirectX by default, ORM packed, no model', () => {
  const p = load('wf-pbr-maps');
  assert.ok(p.ok, p.error);
  const saves = nodes(p, 'SaveImage').map(([, n]) => n.inputs.filename_prefix.split('/').pop());
  assert.deepEqual(saves, ['pbr_basecolor', 'pbr_normal', 'pbr_height', 'pbr_roughness', 'pbr_ao', 'pbr_orm']);
  assert.equal(p.manifest.vram.estMB < 1000, true);
  assert.ok(!Object.values(p.workflow).some((n) => /Loader|Sampler/.test(n.class_type)), 'no model, no sampler');
  assert.equal(p.manifest.params.green.default, true, 'Unreal (DirectX) green by default');
  assert.equal(p.manifest.params.invert.default, false, 'light = raised by default');
  // every blur stays inside ComfyUI's limits (sigma > 10 made ComfyUI silently drop 5 of the 6 maps)
  for (const [, n] of nodes(p, 'ImageBlur')) { assert.ok(n.inputs.sigma <= 10 && n.inputs.blur_radius <= 31, JSON.stringify(n.inputs)); }
  for (const [, n] of nodes(p, 'AdjustContrast')) assert.ok(n.inputs.factor <= 2);
  // slopes read neighbours with wrap-around shifts (a tiling texture stays tiling)
  assert.ok(nodes(p, 'ImageStitch').length >= 12);
});

test('PBR Maps (CHORD): Ubisoft nodes, research-only noted, normal flipped for Unreal, ORM from its maps', () => {
  const p = load('wf-pbr-chord');
  assert.ok(p.ok, p.error);
  assert.deepEqual(['ChordLoadModel', 'ChordMaterialEstimation', 'ChordNormalToHeight'].map((c) => nodes(p, c).length), [1, 1, 1]);
  assert.equal(nodes(p, 'ChordLoadModel')[0][1].inputs.ckpt_name, 'chord_v1.safetensors');
  assert.match(p.manifest.description, /research-only/);
  assert.equal(nodes(p, 'SaveImage').length, 7);
});

test('Depth + Normal and Concept Looks (Depth): MoGe, depth estimated from a render or the pass as it is', () => {
  const d = load('wf-depth-normal');
  assert.ok(d.ok, d.error);
  assert.deepEqual(d.manifest.params.convention.options, ['normal_directx', 'normal_opengl']);
  const c = load('wf-concept-depth');
  assert.equal(c.manifest.label, 'Concept Looks (Depth)');
  const sw = c.workflow[c.manifest.params.source.node];
  assert.equal(sw.class_type, 'ComfySwitchNode');
  assert.equal(c.manifest.params.source.default, false, 'a real depth pass is the default');
  assert.equal(c.workflow[sw.inputs.on_true[0]].class_type, 'MoGeRender');
  for (const p of [d, c]) for (const [, n] of nodes(p, 'MoGeInference')) assert.equal(n.inputs.refine_steps, 0, 'required input');
});

test('audio: Stable Audio 3 SFX and Chatterbox Voice Swap are Models › Audio; voice swap takes two recordings', () => {
  const sfx = load('sa3-small-sfx');
  assert.ok(sfx.ok, sfx.error);
  assert.deepEqual([sfx.manifest.kind, sfx.manifest.group, sfx.manifest.output], ['model', 'Audio', 'audio']);
  assert.equal(nodes(sfx, 'CLIPLoader')[0][1].inputs.type, 'stable_audio');
  assert.deepEqual(sfx.manifest.files.map((f) => f.file), ['stable_audio_3_small_sfx.safetensors', 't5gemma_b_b_ul2.safetensors']);
  assert.ok(sfx.manifest.params.seconds.max <= 120);
  const vs = load('chatterbox-voice-swap');
  assert.ok(vs.ok, vs.error);
  assert.deepEqual(vs.manifest.inputs.map((i) => [i.kind, i.label]), [['audio', 'Your recording'], ['audio', 'Target voice']]);
  const vc = nodes(vs, 'ChatterboxVC')[0][1];
  assert.ok(vc.inputs.source_audio && vc.inputs.target_voice_audio);
  assert.match(vs.manifest.description, /permission/);
});

test('app: Import button, "What next?" chooser title, Record on audio slots; service worker lists the new modules', () => {
  const html = read('app/index.html');
  assert.match(html, /id="btn-import-media"[^>]*aria-label="Import a photo, video or recording"/);
  assert.match(read('app/js/ui/import-sheet.js'), /'Take a photo'[\s\S]*'Record a video'[\s\S]*'Record audio'[\s\S]*'Photo or video from this device'/);
  assert.match(read('app/js/main.js'), /title: 'What next\?'/);
  assert.match(read('app/js/ui/file-inputs.js'), /toggleRecord/);
  const sw = read('app/sw.js');
  assert.match(sw, /'\/js\/ui\/import-sheet\.js'/); assert.match(sw, /'\/js\/lib\/recorder\.js'/);
});

test('Android: video capture through the camera app, microphone for the server page only, versionCode 3', () => {
  const java = read('android/app/src/main/java/app/jesse/comfyconcept/MainActivity.java');
  assert.match(java, /captureIntent\(MediaStore\.ACTION_VIDEO_CAPTURE, "\.mp4"\)/);
  assert.match(java, /EXTRA_MIME_TYPES, new String\[\] \{"image\/\*", "video\/\*"\}/);
  assert.match(java, /onPermissionRequest[\s\S]*RESOURCE_AUDIO_CAPTURE[\s\S]*isServerUrl\(request\.getOrigin\(\)\.toString\(\), server\)/);
  assert.match(java, /REQ_MICROPHONE/);
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /android\.permission\.RECORD_AUDIO/);
  assert.match(manifest, /android\.media\.action\.VIDEO_CAPTURE/);
  assert.doesNotMatch(manifest, /android\.permission\.CAMERA"/, 'still no CAMERA permission (the camera app takes the picture)');
  assert.match(read('android/app/build.gradle'), /versionCode = 3/);
  // no byte-order marks (Gradle refuses build files that start with one)
  for (const f of ['android/app/build.gradle', 'app/sw.js', 'app/styles.css']) assert.notEqual(fs.readFileSync(path.join(ROOT, f))[0], 0xEF, f);
});

test('API: CHORD shows as missing node when ComfyUI-Chord is not installed; the rest are listed', async () => {
  const s = await startStack({ folderWorkflows: false });
  try {
    const list = (await (await fetch(s.base + '/api/workflows')).json()).workflows;
    for (const id of ['ai:wf-photo-texture', 'ai:wf-pbr-maps', 'ai:wf-depth-normal', 'ai:sa3-small-sfx', 'ai:chatterbox-voice-swap']) assert.ok(list.find((w) => w.id === id)?.ok, id);
    // the test fixture has CHORD's nodes (so its graph can be checked); a live ComfyUI without them marks it unavailable
    assert.equal(list.find((w) => w.id === 'ai:wf-pbr-chord').kind, 'workflow');
  } finally { await s.close(); }
});
