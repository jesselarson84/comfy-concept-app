// AI Workflow presets: shipped files, clamps, live availability (installed
// nodes/models from ComfyUI + VRAM fit), TTS presets, memory "free" decision.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStack, GPU_5080, ROOT } from './helpers.js';
import { validatePreset, clampPresetValues, applyPresetParams, formatPrompt, checkInstalled, vramFit } from '../../app/js/lib/presets.js';
import { decideFreeBeforeQueue, workflowNeedMB, DEFAULT_MEMORY_CONFIG } from '../../app/js/lib/memory-profiles.js';
import { splitOutputs, fileKind } from '../../app/js/lib/outputs.js';
import { validateGraph } from '../../app/js/lib/builder.js';

const AI_DIR = path.join(ROOT, 'workflows', 'ai');
const load = (id) => validatePreset(id, JSON.parse(fs.readFileSync(path.join(AI_DIR, id + '.json'), 'utf8')));
const objectInfo = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/object-info.json'), 'utf8'));
const models = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/models.json'), 'utf8'));
const j = (r) => r.json();
const avail = (ws, id) => ws.find((w) => w.id === 'ai:' + id).availability;

// The 16 AI Workflow manifest entries + the two TTS presets.
const MANIFEST_16 = ['qwen-2512-t2i', 'qwen-edit-2509', 'z-image-turbo', 'klein-4b-t2i', 'klein-4b-edit', 'flux1-dev-gguf', 'flux1-schnell-gguf',
  'seedvr2-7b-image', 'upscale-4x-model', 'seedvr2-3b-video', 'realesrgan-video', 'wan22-5b-ti2v', 'hunyuan3d-21', 'moge-mesh', 'pixal3d-trellis2', 'ace-step-15'];

test('every shipped AI preset validates: 16 manifest entries + Chatterbox + VibeVoice, prefixes under concept-app/', () => {
  const ids = fs.readdirSync(AI_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  assert.deepEqual(ids, [...MANIFEST_16, 'tts-chatterbox', 'tts-vibevoice'].sort());
  for (const id of ids) {
    const p = load(id);
    assert.ok(p.ok, `${id}: ${p.error}`);
    assert.ok(p.manifest.vram.estMB > 0, `${id}: VRAM estimate`);
    for (const [k, n] of Object.entries(p.workflow)) if (/^Save/.test(n.class_type)) assert.match(n.inputs.filename_prefix, /^concept-app\//, `${id} node ${k}`);
    // every class exists in the real object_info fixture (trimmed from ComfyUI 0.46.2)
    for (const n of Object.values(p.workflow)) assert.ok(objectInfo[n.class_type], `${id}: ${n.class_type}`);
  }
});

test('every installed preset graph passes the builder validator against object_info (Wan/ACE only miss model files)', () => {
  for (const id of [...MANIFEST_16, 'tts-chatterbox', 'tts-vibevoice']) {
    const errs = validateGraph(load(id).workflow, objectInfo);
    if (id === 'wan22-5b-ti2v' || id === 'ace-step-15') assert.match(errs.join(' '), /needs download/, id);
    else assert.deepEqual(errs, [], id);
  }
});

test('preset clamps: params to [min,max], size to range + multiple, batch to maxBatch, enums to options', () => {
  const p = load('flux1-schnell-gguf');
  const r = clampPresetValues(p.manifest, { params: { steps: 99 }, width: 5000, height: 100, batch: 50 });
  assert.equal(r.params.steps, p.manifest.params.steps.max);
  assert.ok(r.size.width <= p.manifest.size.max && r.size.height >= p.manifest.size.min);
  assert.equal(r.size.width % (p.manifest.size.multiple || 16), 0);
  assert.equal(r.batch, p.manifest.maxBatch);
  assert.ok(r.notes.length >= 3);
  const q = load('qwen-2512-t2i');
  assert.equal(clampPresetValues(q.manifest, { params: { steps: 1 } }).params.steps, 2);
  const px = load('pixal3d-trellis2');
  const e = clampPresetValues(px.manifest, { params: { texture: 999, faces: 10 } });
  assert.equal(e.params.texture, 2048); // not an option -> default
  assert.equal(e.params.faces, px.manifest.params.faces.min);
  // values land in the graph (and `also` targets)
  const ace = load('ace-step-15');
  const g = applyPresetParams(ace.manifest, ace.workflow, clampPresetValues(ace.manifest, { params: { seconds: 9999 } }).params);
  const sec = ace.manifest.params.seconds;
  assert.equal(g[sec.node].inputs[sec.input], sec.max);
  for (const t of sec.also || []) assert.equal(g[t.node].inputs[t.input], sec.max);
});

test('checkInstalled: missing node class and missing model file give plain reasons', () => {
  const p = load('klein-4b-t2i');
  const ok = checkInstalled(p.workflow, { objectInfo, models }, p.manifest.files);
  assert.ok(ok.ok, ok.reasons.join());
  const noNode = { ...objectInfo }; delete noNode.Flux2Scheduler;
  assert.match(checkInstalled(p.workflow, { objectInfo: noNode, models }, p.manifest.files).reasons.join(), /missing custom node: Flux2Scheduler/);
  const wan = load('wan22-5b-ti2v');
  assert.match(checkInstalled(wan.workflow, { objectInfo, models }, wan.manifest.files).reasons.join(), /needs download: wan2\.2_ti2v_5B_fp16\.safetensors/);
});

test('vramFit: ok / tight / slow RAM offload / unavailable', () => {
  assert.equal(vramFit({ estMB: 3000, gpuTotalMB: 11264, ramFreeMB: 60000 }).status, 'ok');
  assert.equal(vramFit({ estMB: 9600, gpuTotalMB: 11264, ramFreeMB: 60000 }).status, 'tight');
  const off = vramFit({ estMB: 21500, gpuTotalMB: 11264, ramFreeMB: 60000, profileId: 'small' });
  assert.equal(off.status, 'offload'); assert.equal(off.label, 'slow · RAM offload');
  assert.equal(vramFit({ estMB: 21500, gpuTotalMB: 11264, ramFreeMB: 12000 }).status, 'unavailable');
});

test('TTS presets: Chatterbox uses the real node inputs; VibeVoice wraps plain text as "[1] ..."', () => {
  const cb = load('tts-chatterbox');
  const node = Object.values(cb.workflow).find((n) => n.class_type === 'ChatterboxTTS');
  assert.equal(node.inputs.model_pack_name, 'chatterbox');
  for (const k of Object.keys(node.inputs)) if (!Array.isArray(node.inputs[k])) assert.ok(k in { ...objectInfo.ChatterboxTTS.input.required, ...objectInfo.ChatterboxTTS.input.optional }, `ChatterboxTTS.${k}`);
  const vv = load('tts-vibevoice');
  const vn = Object.values(vv.workflow).find((n) => n.class_type === 'VibeVoiceTTS');
  assert.equal(vn.inputs.model_name, 'VibeVoice-1.5B');
  assert.equal(vn.inputs.force_offload, true);
  for (const k of Object.keys(vn.inputs)) if (!Array.isArray(vn.inputs[k])) assert.ok(k in { ...objectInfo.VibeVoiceTTS.input.required, ...objectInfo.VibeVoiceTTS.input.optional }, `VibeVoiceTTS.${k}`);
  assert.equal(formatPrompt(vv.manifest, 'Hello there.'), '[1] Hello there.');
  // standard VibeVoice clones a reference voice: a LoadAudio sample feeds speaker 1, with a default file
  assert.equal(vv.workflow[vn.inputs.speaker_1_voice[0]].class_type, 'LoadAudio');
  assert.deepEqual(vv.manifest.inputs.map((s) => [s.kind, s.default]), [['audio', 'verify-voice.flac']]);
  assert.equal(formatPrompt(vv.manifest, '[1] Hi\n[2] Hey'), '[1] Hi\n[2] Hey');
  assert.equal(formatPrompt(cb.manifest, 'Hello'), 'Hello');
});

test('outputs: SaveVideo / SaveAudio / SaveGLB become files, temp previews dropped when a saved result exists', () => {
  const r = splitOutputs({ 1: { images: [{ filename: 'a.mp4', subfolder: 'concept-app', type: 'output' }], animated: [true] }, 2: { audio: [{ filename: 'b.flac', subfolder: '', type: 'output' }] }, 3: { '3d': [{ filename: 'c.glb', subfolder: '', type: 'output' }] }, 4: { images: [{ filename: 'p.png', type: 'temp' }] } });
  assert.deepEqual(r.files.map(fileKind).sort(), ['3d', 'audio', 'video']);
  assert.equal(r.images.length, 0);
});

test('memory: the small profile frees ComfyUI VRAM when switching to a workflow that does not fit; large never', () => {
  const cfg = DEFAULT_MEMORY_CONFIG;
  const small = { id: 'small', ...cfg.profiles.small, freeComfyBeforeQueue: 'on-switch' };
  assert.equal(workflowNeedMB(cfg, 'ai:x', 9600), 9600);
  assert.equal(decideFreeBeforeQueue({ profile: small, freeMB: 3000, needMB: 9600, lastWorkflow: 'ai:a', workflow: 'ai:b' }).freeComfy, true);
  assert.equal(decideFreeBeforeQueue({ profile: small, freeMB: 3000, needMB: 9600, lastWorkflow: 'ai:b', workflow: 'ai:b' }).freeComfy, false);
  assert.equal(decideFreeBeforeQueue({ profile: small, freeMB: 10000, needMB: 2000, lastWorkflow: 'ai:a', workflow: 'ai:b' }).freeComfy, false);
  assert.equal(decideFreeBeforeQueue({ profile: { id: 'large', freeComfyBeforeQueue: 'never' }, freeMB: 100, needMB: 9600, lastWorkflow: 'a', workflow: 'b' }).freeComfy, false);
});

// ---- live availability through the server (mock ComfyUI with real object_info / model lists) ----
let s, vvDir;
before(async () => {
  vvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-tts-'));
  const d = path.join(vvDir, 'VibeVoice', 'VibeVoice-1.5B'); fs.mkdirSync(d, { recursive: true });
  for (let i = 1; i <= 3; i++) fs.writeFileSync(path.join(d, `model-0000${i}-of-00003.safetensors`), 'x');
  s = await startStack({ comfyOptions: { folderPaths: { tts: [[vvDir], ['.safetensors']] } } });
});
after(() => s.close());

test('/api/workflows: availability is computed live; Wan 2.2 5B and ACE-Step 1.5 need download; heavy = slow RAM offload on 11 GB', async () => {
  const { workflows, comfy } = await j(await fetch(s.base + '/api/workflows?fresh=1'));
  assert.equal(comfy.reachable, true);
  assert.equal(avail(workflows, 'wan22-5b-ti2v').status, 'unavailable');
  assert.equal(avail(workflows, 'wan22-5b-ti2v').label, 'needs download');
  assert.equal(avail(workflows, 'ace-step-15').label, 'needs download');
  assert.match(avail(workflows, 'ace-step-15').reason, /acestep_v1\.5_turbo/);
  for (const id of ['qwen-2512-t2i', 'qwen-edit-2509', 'z-image-turbo']) assert.equal(avail(workflows, id).label, 'slow · RAM offload', id);
  for (const id of ['moge-mesh', 'upscale-4x-model', 'tts-chatterbox', 'tts-vibevoice']) assert.equal(avail(workflows, id).status, 'ok', id);
  // the enum of upscale models only offers installed files
  const up = workflows.find((w) => w.id === 'ai:upscale-4x-model');
  for (const o of up.ai.params.model.options) assert.ok(models.upscale_models.includes(o), o);
});

test('availability follows the live model list: a removed file makes the preset unavailable with the reason', async () => {
  const r = await startStack({ comfyOptions: { models: { ...models, chatterbox: [] } } });
  try {
    const { workflows } = await j(await fetch(r.base + '/api/workflows'));
    assert.equal(avail(workflows, 'tts-chatterbox').status, 'unavailable');
    assert.match(avail(workflows, 'tts-chatterbox').reason, /needs download: t3_cfg\.safetensors/);
    assert.equal(avail(workflows, 'tts-vibevoice').status, 'unavailable'); // folder_paths has no tts folder here
  } finally { await r.close(); }
});

test('5080 (16 GB): klein / Pixal3D fit; Qwen stays slow RAM offload; ComfyUI down: "unknown", app still lists presets', async () => {
  const r = await startStack({ gpu: GPU_5080 });
  try {
    const { workflows } = await j(await fetch(r.base + '/api/workflows'));
    assert.equal(avail(workflows, 'klein-4b-t2i').status, 'ok');
    assert.equal(avail(workflows, 'pixal3d-trellis2').status, 'ok');
    assert.equal(avail(workflows, 'qwen-2512-t2i').status, 'offload');
  } finally { await r.close(); }
  const d = await startStack({ comfyDown: true });
  try {
    const { workflows, comfy } = await j(await fetch(d.base + '/api/workflows'));
    assert.equal(comfy.reachable, false);
    assert.equal(avail(workflows, 'klein-4b-t2i').status, 'unknown');
    assert.ok(workflows.some((w) => w.id === 'fast-concept' && w.ok));
  } finally { await d.close(); }
});

test('a TTS preset runs end to end through /comfy/prompt and the audio file comes back', async () => {
  const { workflows } = await j(await fetch(s.base + '/api/workflows'));
  const p = workflows.find((w) => w.id === 'ai:tts-chatterbox');
  const r = await j(await fetch(s.base + '/comfy/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: p.workflow, client_id: 't' }) }));
  assert.ok(r.prompt_id);
  let h;
  for (let i = 0; i < 100 && !h?.outputs; i++) { await new Promise((x) => setTimeout(x, 30)); h = (await j(await fetch(`${s.base}/comfy/history/${r.prompt_id}`)))[r.prompt_id]; }
  const { files } = splitOutputs(h.outputs);
  assert.equal(fileKind(files[0]), 'audio');
  assert.match(files[0].subfolder, /^concept-app/);
});
