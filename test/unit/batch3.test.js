// Batch 3 unit tests (one block per item).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunLock, runProgress } from '../../app/js/lib/run-lock.js';

// ---- item 2: run lock ---------------------------------------------------------
test('run lock: locked from the tap until every job of the run ends; a second begin is refused', () => {
  const l = new RunLock();
  assert.equal(l.locked(), false);
  assert.equal(l.begin(), true);
  assert.equal(l.locked(), true, 'locked while starting (memory step, POSTs)');
  assert.equal(l.begin(), false, 'double tap does not start a second run');
  const run = [{ status: 'queued' }, { status: 'submitting' }];
  l.started(run);
  assert.equal(l.locked(), true);
  run[0].status = 'done'; run[1].status = 'running';
  assert.equal(l.locked(), true);
  run[1].status = 'cancelled';
  assert.equal(l.locked(), false);
  assert.equal(l.begin(), true);
});

test('run lock: Cancel before the jobs reach the queue aborts the run', () => {
  const l = new RunLock();
  l.begin(); l.cancel();
  assert.equal(l.abort, true);
  l.started([]);
  assert.equal(l.locked(), false);
});

test('runProgress: "running N of M" counts finished jobs, errors and cancels included', () => {
  assert.deepEqual(runProgress([]), { total: 0, finished: 0, done: 0, active: 0, current: 0, running: false });
  const p = runProgress([{ status: 'done' }, { status: 'error' }, { status: 'running' }, { status: 'queued' }]);
  assert.equal(p.total, 4); assert.equal(p.current, 3); assert.equal(p.running, true); assert.equal(p.done, 1);
  assert.equal(runProgress([{ status: 'done' }, { status: 'done' }]).current, 2);
});

// ---- item 4: background running -------------------------------------------------
import { persistable } from '../../app/js/job-queue.js';
test('persistable: only active jobs that reached ComfyUI are kept for catch-up after a reload', () => {
  const out = persistable([
    { key: 'a', promptId: 'p1', status: 'running', meta: { seed: 1 }, historyId: 'h1' },
    { key: 'b', promptId: null, status: 'submitting', meta: {} },
    { key: 'c', promptId: 'p3', status: 'done', meta: {} },
    { key: 'd', promptId: 'p4', status: 'queued', meta: { seed: 4 } },
  ]);
  assert.deepEqual(out.map((x) => x.promptId), ['p1', 'p4']);
  assert.equal(out[0].historyId, 'h1');
  assert.equal(out[1].historyId, null);
  assert.ok(!('image' in out[0]) && !('workflow' in out[0]), 'no results or graphs stored');
});

// ---- item 5: memory items --------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, startStack, GPU_5080 } from './helpers.js';
import { textEncoderOnCpu, tiledVaeDecode, wantTiledDecode, isOom, isHeavy, ggufPath, TILED_INPUTS } from '../../app/js/lib/memory-options.js';
import { decideBeforeQueue, DEFAULT_MEMORY_CONFIG } from '../../app/js/lib/memory-profiles.js';
import { validatePreset, checkInstalled } from '../../app/js/lib/presets.js';
import { validateGraph } from '../../app/js/lib/builder.js';

const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const objectInfo = readJson('test/fixtures/object-info.json');
const models = readJson('test/fixtures/models.json');
const preset = (id) => validatePreset(id, readJson(`workflows/ai/${id}.json`));
const [small, large] = DEFAULT_MEMORY_CONFIG.profiles;

test('CPU text encoder: CLIPLoader / DualCLIPLoader get device "cpu" (an input they really have); nothing else changes', () => {
  const g = preset('qwen-2512-t2i').workflow;
  const out = textEncoderOnCpu(g);
  assert.equal(out['4'].inputs.device, 'cpu');
  assert.equal(g['4'].inputs.device, 'default', 'original untouched');
  for (const c of ['CLIPLoader', 'DualCLIPLoader']) assert.deepEqual(objectInfo[c].input.optional.device[0], ['default', 'cpu'], c);
  assert.deepEqual(validateGraph(out, objectInfo), []);
  const k = preset('klein-4b-t2i').workflow;
  const ko = textEncoderOnCpu(k);
  for (const [id, n] of Object.entries(ko)) if (n.class_type !== 'CLIPLoader') assert.deepEqual(n, k[id]);
});

test('tiled VAE decode: above ~2 MP or after an OOM; VAEDecode -> VAEDecodeTiled with the same links and valid inputs', () => {
  assert.equal(wantTiledDecode({ width: 1024, height: 1024 }).tiled, false);
  assert.equal(wantTiledDecode({ width: 1664, height: 928 }).tiled, false, '1.54 MP');
  assert.equal(wantTiledDecode({ width: 1536, height: 1536 }).tiled, true, '2.36 MP');
  assert.equal(wantTiledDecode({ width: 1024, height: 1024, oomBefore: true }).tiled, true);
  assert.equal(wantTiledDecode({}).tiled, false, 'unknown size, no OOM');
  const g = preset('z-image-turbo').workflow;
  const t = tiledVaeDecode(g);
  const [id] = Object.entries(g).find(([, n]) => n.class_type === 'VAEDecode');
  assert.equal(t[id].class_type, 'VAEDecodeTiled');
  assert.deepEqual(t[id].inputs.samples, g[id].inputs.samples);
  assert.deepEqual(t[id].inputs.vae, g[id].inputs.vae);
  for (const [k, v] of Object.entries(TILED_INPUTS)) { const spec = objectInfo.VAEDecodeTiled.input.required[k][1]; assert.ok(v >= spec.min && v <= spec.max && v % spec.step === 0, k); }
  assert.deepEqual(validateGraph(t, objectInfo), []);
  assert.equal(isOom('torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB'), true);
  assert.equal(isOom('KSampler: expected scalar type Float'), false);
});

test('heavy jobs: Pixal3D is flagged; >= 12 GB counts; heavy = keep_alive 0 unload on every profile', () => {
  assert.equal(preset('pixal3d-trellis2').manifest.heavy, true);
  assert.equal(isHeavy(preset('pixal3d-trellis2').manifest), true);
  assert.equal(isHeavy(preset('klein-4b-t2i').manifest), false);
  assert.equal(isHeavy(null, 13800), true);
  const loaded = [{ name: 'gemma3:4b', size: 3e9, size_vram: 3e9 }];
  assert.equal(decideBeforeQueue({ profile: large, freeMB: 15000, ollamaModels: loaded, needMB: 3000 }).unload, false, 'large GPU keeps the chat model for a light job');
  const h = decideBeforeQueue({ profile: large, freeMB: 15000, ollamaModels: loaded, needMB: 3000, heavy: true });
  assert.equal(h.unload, true); assert.match(h.reason, /keep_alive 0/);
  assert.equal(decideBeforeQueue({ profile: large, freeMB: 15000, ollamaModels: [], needMB: 3000, heavy: true }).unload, false, 'nothing loaded');
  assert.equal(decideBeforeQueue({ profile: small, ollamaModels: loaded, needMB: 3000 }).unload, true);
});

test('GGUF loader path: Qwen 2512 / 2509 use their Q5_K_M GGUF on the small GPU, keep fp8 on the large one', () => {
  for (const [id, file] of [['qwen-2512-t2i', 'qwen-image-2512-Q5_K_M.gguf'], ['qwen-edit-2509', 'Qwen-Image-Edit-2509-Q5_K_M.gguf']]) {
    const p = preset(id);
    const s = ggufPath(p.workflow, p.manifest, { objectInfo, profileId: 'small' });
    assert.equal(s.loader, 'gguf', id);
    assert.deepEqual(s.workflow['1'], { class_type: 'UnetLoaderGGUF', inputs: { unet_name: file }, _meta: { title: 'Unet Loader (GGUF)' } });
    assert.deepEqual(s.workflow['2'].inputs.model, ['1', 0], 'LoRA still on the UNet');
    assert.ok(s.manifest.vram.estMB < p.manifest.vram.estMB);
    assert.deepEqual(validateGraph(s.workflow, objectInfo), []);
    assert.equal(checkInstalled(s.workflow, { objectInfo, models }).ok, true);
    assert.equal(ggufPath(p.workflow, p.manifest, { objectInfo, profileId: 'large' }).loader, 'default');
    // GGUF not installed -> default loader
    const oi = structuredClone(objectInfo); oi.UnetLoaderGGUF.input.required.unet_name[0] = [];
    assert.equal(ggufPath(p.workflow, p.manifest, { objectInfo: oi, profileId: 'small' }).loader, 'default');
    // fp8 missing but GGUF there -> GGUF on any profile
    const oi2 = structuredClone(objectInfo); oi2.UNETLoader.input.required.unet_name[0] = [];
    assert.equal(ggufPath(p.workflow, p.manifest, { objectInfo: oi2, profileId: 'large' }).loader, 'gguf');
  }
});

test('Qwen Image Edit 2511: Q5_K_M GGUF + 2511 Lightning LoRA (not the 2509 one) at 4 steps, cfg 1; template nodes; valid', () => {
  const p = preset('qwen-edit-2511');
  assert.ok(p.ok, p.error);
  const g = p.workflow, by = (c) => Object.entries(g).filter(([, n]) => n.class_type === c);
  assert.equal(by('UnetLoaderGGUF')[0][1].inputs.unet_name, 'qwen-image-edit-2511-Q5_K_M.gguf');
  assert.equal(by('LoraLoaderModelOnly')[0][1].inputs.lora_name, 'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors');
  assert.equal(by('LoraLoaderModelOnly')[0][1].inputs.strength_model, 1);
  const ks = by('KSampler')[0][1].inputs;
  assert.deepEqual([ks.steps, ks.cfg, ks.sampler_name, ks.scheduler], [4, 1, 'euler', 'simple']);
  assert.equal(by('FluxKontextMultiReferenceLatentMethod').length, 2);
  for (const [, n] of by('FluxKontextMultiReferenceLatentMethod')) assert.equal(n.inputs.reference_latents_method, 'index_timestep_zero');
  assert.equal(by('CFGNorm').length, 1);
  assert.equal(g['12'].inputs.filename_prefix, 'concept-app/qwen_edit2511');
  assert.deepEqual(validateGraph(g, objectInfo), []);
  assert.equal(checkInstalled(g, { objectInfo, models }).ok, true);
});

test('memory settings: GET/POST /api/memory/settings persist; Ollama CPU mode adds num_gpu 0 to chat; heavy before-queue unloads', async () => {
  const s = await startStack({ gpu: GPU_5080 });
  try {
    const j = (r) => r.json();
    assert.deepEqual(await j(await fetch(s.base + '/api/memory/settings')), { textEncoderCpu: false, ollamaCpu: false });
    const r = await j(await fetch(s.base + '/api/memory/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ textEncoderCpu: true, ollamaCpu: true, junk: 1 }) }));
    assert.deepEqual(r, { textEncoderCpu: true, ollamaCpu: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.dataDir, 'memory-settings.json'), 'utf8')), r);
    const bc = await j(await fetch(s.base + '/api/memory/before-chat', { method: 'POST', body: JSON.stringify({ model: 'gemma3:4b' }) }));
    assert.deepEqual(bc.chatOptions, { num_gpu: 0 });
    const bq = await j(await fetch(s.base + '/api/memory/before-queue', { method: 'POST', body: JSON.stringify({ workflow: 'ai:pixal3d-trellis2' }) }));
    assert.equal(bq.heavy, true);
    const light = await j(await fetch(s.base + '/api/memory/before-queue', { method: 'POST', body: JSON.stringify({ workflow: 'ai:klein-4b-t2i' }) }));
    assert.equal(light.heavy, false);
  } finally { await s.close(); }
});

// ---- all items: graphs only use inputs that exist in /object_info ------------------
/** Inputs a node sends that its /object_info definition doesn't have (dotted
 *  sub-inputs of a dynamic combo like "resize_type.multiplier" are allowed). */
export function inventedInputs(g, oi) {
  const bad = [];
  for (const [id, n] of Object.entries(g)) {
    if (id.startsWith('_')) continue;
    const def = oi[n.class_type];
    if (!def) { bad.push(`${id}: no class ${n.class_type}`); continue; }
    const spec = { ...(def.input?.required || {}), ...(def.input?.optional || {}) };
    for (const k of Object.keys(n.inputs)) {
      if (k in spec) continue;
      const head = k.split('.')[0];
      if (k.includes('.') && head in spec) continue;
      bad.push(`${id} ${n.class_type}.${k}`);
    }
  }
  return bad;
}
test('no invented inputs: every AI preset and action graph only sends inputs /object_info defines', () => {
  const ids = fs.readdirSync(path.join(ROOT, 'workflows/ai')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  for (const id of ids) {
    const p = preset(id);
    assert.deepEqual(inventedInputs(p.workflow, objectInfo), [], id);
    if (p.manifest.gguf) assert.deepEqual(inventedInputs(ggufPath(p.workflow, p.manifest, { objectInfo, profileId: 'small' }).workflow, objectInfo), [], id + ' gguf');
  }
  for (const f of fs.readdirSync(path.join(ROOT, 'workflows/actions'))) assert.deepEqual(inventedInputs(readJson(`workflows/actions/${f}`).workflow, objectInfo), [], f);
});

// ---- item 6: Klein 4B mask-paint inpaint ---------------------------------------------
import { detectControls } from '../../app/js/lib/workflow-detect.js';
import { isEraserPointer, isPalm, brushWidth, smoothPoint, pinchView, fitView, toImage, maskPixels } from '../../app/js/lib/mask-paint.js';
test('Klein 4B inpaint graph: crop -> noise mask + reference latent -> Klein 4 steps cfg 1 -> colour match -> stitch', () => {
  const p = preset('klein-4b-inpaint');
  assert.ok(p.ok, p.error);
  const g = p.workflow;
  const by = (cls) => Object.entries(g).filter(([, n]) => n.class_type === cls);
  const [[cropId, crop]] = by('InpaintCropImproved');
  assert.equal(crop.inputs.mask_expand_pixels, 12); assert.ok(crop.inputs.mask_expand_pixels >= 8 && crop.inputs.mask_expand_pixels <= 16);
  assert.equal(crop.inputs.mask_blend_pixels, 32);
  assert.equal(crop.inputs.context_from_mask_extend_factor, 1.35);
  assert.equal(crop.inputs.output_resize_to_target_size, true);
  assert.deepEqual([crop.inputs.output_target_width, crop.inputs.output_target_height], [1024, 1024]);
  assert.equal(crop.inputs.output_padding, '16');
  assert.equal(crop.inputs.device_mode, 'gpu (much faster)');
  assert.equal(crop.inputs.mask_fill_holes, true);
  // the mask comes from its own LoadImage (red channel), never a reference slot
  const maskNode = g[crop.inputs.mask[0]];
  assert.equal(maskNode.class_type, 'ImageToMask'); assert.equal(maskNode.inputs.channel, 'red');
  assert.equal(g[maskNode.inputs.image[0]].class_type, 'LoadImage');
  assert.deepEqual(p.manifest.mask, { node: maskNode.inputs.image[0], input: 'image', image: crop.inputs.image[0] });
  assert.deepEqual(detectControls(g).images.map((s) => s.node), [crop.inputs.image[0]]);
  // VAEEncode(cropped_image) -> SetLatentNoiseMask(cropped_mask) is the sampler latent; ReferenceLatent uses the same encode
  const [[encId, enc]] = by('VAEEncode');
  assert.deepEqual(enc.inputs.pixels, [cropId, 1]);
  const [[nmId, nm]] = by('SetLatentNoiseMask');
  assert.deepEqual(nm.inputs.samples, [encId, 0]); assert.deepEqual(nm.inputs.mask, [cropId, 2]);
  assert.ok(by('ReferenceLatent').every(([, n]) => n.inputs.latent[0] === encId));
  const [[, sca]] = by('SamplerCustomAdvanced');
  assert.deepEqual(sca.inputs.latent_image, [nmId, 0]);
  assert.equal(by('CFGGuider')[0][1].inputs.cfg, 1);
  assert.equal(by('Flux2Scheduler')[0][1].inputs.steps, 4);
  assert.match(by('UNETLoader')[0][1].inputs.unet_name, /flux-2-klein-4b/);
  // colour match: target = decoded, reference = cropped_image, exclude = cropped_mask, ~0.6
  const [[cmId, cm]] = by('INPAINT_ColorMatch');
  assert.equal(g[cm.inputs.target[0]].class_type, 'VAEDecode');
  assert.deepEqual(cm.inputs.reference, [cropId, 1]); assert.deepEqual(cm.inputs.exclude_mask, [cropId, 2]);
  assert.equal(cm.inputs.strength, 0.6);
  const [[stId, st]] = by('InpaintStitchImproved');
  assert.deepEqual(st.inputs.stitcher, [cropId, 0]); assert.deepEqual(st.inputs.inpainted_image, [cmId, 0]);
  const [[, save]] = by('SaveImage');
  assert.deepEqual(save.inputs.images, [stId, 0]); assert.match(save.inputs.filename_prefix, /^concept-app\//);
  assert.deepEqual(inventedInputs(g, objectInfo), []);
  // params target real inputs only
  for (const [k, prm] of Object.entries(p.manifest.params)) for (const t of [prm, ...(prm.also || [])]) assert.ok(t.input in g[t.node].inputs, k);
});

test('mask paint helpers: eraser end / barrel button, palm rejection, pressure, smoothing', () => {
  assert.equal(isEraserPointer({ pointerType: 'pen', button: 5, buttons: 32 }), true);
  assert.equal(isEraserPointer({ pointerType: 'pen', button: -1, buttons: 32 }), true);
  assert.equal(isEraserPointer({ pointerType: 'pen', button: 0, buttons: 3 }), true); // barrel held while drawing
  assert.equal(isEraserPointer({ pointerType: 'pen', button: 0, buttons: 1 }), false);
  assert.equal(isEraserPointer({ pointerType: 'mouse', button: 2, buttons: 2 }), false);
  const now = 10000;
  assert.equal(isPalm({ pointerType: 'touch', width: 10, height: 10 }, { penActiveAt: now - 500, now }), true);
  assert.equal(isPalm({ pointerType: 'touch', width: 10, height: 10 }, { penActiveAt: now - 5000, now }), false);
  assert.equal(isPalm({ pointerType: 'touch', width: 80, height: 60 }, { penActiveAt: 0, now }), true);
  assert.equal(isPalm({ pointerType: 'pen' }, { penActiveAt: now, now }), false);
  assert.equal(brushWidth(40, { pointerType: 'pen', pressure: 1 }, true), 40);
  assert.equal(brushWidth(40, { pointerType: 'pen', pressure: 0 }, true), 40); // no pressure reported -> full size
  assert.ok(Math.abs(brushWidth(40, { pointerType: 'pen', pressure: 0.5 }, true) - 24) < 1e-9);
  assert.equal(brushWidth(40, { pointerType: 'pen', pressure: 0.5 }, false), 40);
  assert.equal(brushWidth(40, { pointerType: 'touch', pressure: 0.5 }, true), 40);
  assert.deepEqual(smoothPoint(null, { x: 1, y: 2, w: 3 }), { x: 1, y: 2, w: 3 });
  const s = smoothPoint({ x: 0, y: 0 }, { x: 10, y: 0, w: 1 }, 0.35);
  assert.ok(Math.abs(s.x - 6.5) < 1e-9); assert.equal(smoothPoint({ x: 0, y: 0 }, { x: 10, y: 4 }, 0).x, 10);
});

test('mask paint helpers: pinch keeps the point under the fingers, fit, export to white-on-black', () => {
  const v0 = { scale: 1, x: 0, y: 0 };
  const v = pinchView(v0, { x: 100, y: 100 }, { x: 200, y: 100 }, { x: 50, y: 100 }, { x: 250, y: 100 });
  assert.equal(v.scale, 2);
  const before = toImage(v0, 150, 100), after = toImage(v, 150, 100);
  assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9);
  const pan = pinchView(v0, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 7 }, { x: 15, y: 7 });
  assert.deepEqual(pan, { scale: 1, x: 5, y: 7 });
  assert.equal(pinchView(v0, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }, { x: 1000, y: 0 }, { max: 16 }).scale, 16);
  const f = fitView(2000, 1000, 1000, 1000, 0);
  assert.equal(f.scale, 0.5); assert.equal(f.y, 250);
  const rgba = new Uint8ClampedArray([9, 9, 9, 0, 9, 9, 9, 255, 9, 9, 9, 127, 9, 9, 9, 128]);
  const m = maskPixels(rgba);
  assert.deepEqual([...m.data], [0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
  assert.equal(m.painted, 2);
  assert.equal(maskPixels(rgba, true).painted, 2);
  assert.deepEqual([...maskPixels(rgba, true).data.slice(0, 4)], [255, 255, 255, 255]);
});

test('service worker caches every module the app page imports (shell bumped for batch 3)', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'app/sw.js'), 'utf8');
  const seen = new Set();
  const visit = (abs) => {
    if (seen.has(abs)) return; seen.add(abs);
    const src = fs.readFileSync(abs, 'utf8');
    for (const m of src.matchAll(/^\s*import\s[^'"]*?from\s+'(\.[^']+)'/gm)) visit(path.resolve(path.dirname(abs), m[1]));
  };
  visit(path.join(ROOT, 'app/js/main.js'));
  assert.ok(seen.size > 30);
  for (const f of seen) {
    const rel = '/' + path.relative(path.join(ROOT, 'app'), f).split(path.sep).join('/');
    assert.ok(sw.includes(`'${rel}'`), rel);
  }
});

// ---- item 7: Settings redesign + per-preset audit -------------------------------------
import { controlFor, formatParam, paramRange, paramActive, dropEmptyOptional, clampPresetValues, applyPresetParams } from '../../app/js/lib/presets.js';
const comboOptions = (spec) => (Array.isArray(spec?.[0]) ? spec[0] : spec?.[1]?.options);
test('settings hints: control choice, readouts, modes, when/offValue, Full = 0, seconds -> tokens', () => {
  assert.equal(controlFor({ type: 'int', min: 2, max: 8 }), 'stepper');
  assert.equal(controlFor({ type: 'number', min: 1, max: 6 }), 'slider');
  assert.equal(controlFor({ type: 'enum', options: [false, true] }), 'seg');
  assert.equal(controlFor({ type: 'enum', options: [1, 2, 3, 4] }), 'select');
  assert.equal(controlFor({ type: 'text' }), 'text');
  assert.equal(controlFor({ type: 'int', min: 0, max: 5, control: 'slider' }), 'slider');
  assert.equal(formatParam({ format: 'x' }, 2), '2.0×');
  assert.equal(formatParam({ format: 'k', type: 'int' }, 300000), '300k');
  assert.equal(formatParam({ zeroAtMax: true, max: 520000, format: 'k' }, 520000), 'Full');
  assert.equal(formatParam({ format: 's' }, 16), '16 s');
  assert.equal(formatParam({ format: 'frames' }, 49, { fps: 24 }), '49 · 2.0 s');
  assert.equal(formatParam({ type: 'number', step: 0.05 }, 0.5), '0.50');
  assert.equal(formatParam({ type: 'number', step: 0.1 }, 3), '3.0');
  const q = preset('qwen-2512-t2i').manifest;
  assert.deepEqual(paramRange(q.params.steps, { lightning: true }), { min: 2, max: 8, default: 4 });
  assert.deepEqual(paramRange(q.params.steps, { lightning: false }), { min: 20, max: 50, default: 40 });
  assert.equal(paramActive(q.params.cfg, { lightning: true }), false);
  assert.equal(paramActive(q.params.cfg, { lightning: false }), true);
  // Lightning on: 4 steps, cfg forced to 1; off: 40 steps, cfg 4, LoRA bypassed by the switch
  let r = clampPresetValues(q, { params: {} });
  let g = applyPresetParams(q, preset('qwen-2512-t2i').workflow, r.params);
  assert.deepEqual([g['9'].inputs.steps, g['9'].inputs.cfg, g['20'].inputs.switch], [4, 1, true]);
  r = clampPresetValues(q, { params: { lightning: false, steps: 4, cfg: 4 } });
  assert.equal(r.params.steps, 20, 'steps follow the Lightning range');
  r = clampPresetValues(q, { params: { lightning: false } });
  g = applyPresetParams(q, preset('qwen-2512-t2i').workflow, r.params);
  assert.deepEqual([g['9'].inputs.steps, g['9'].inputs.cfg, g['20'].inputs.switch], [40, 4, false]);
  const hy = preset('hunyuan3d-21');
  g = applyPresetParams(hy.manifest, hy.workflow, clampPresetValues(hy.manifest, {}).params);
  assert.equal(g['26'].inputs.target_face_count, 0, 'Full = DecimateMesh off');
  g = applyPresetParams(hy.manifest, hy.workflow, clampPresetValues(hy.manifest, { params: { faces: 200000 } }).params);
  assert.equal(g['26'].inputs.target_face_count, 200000);
  const cb = preset('tts-chatterbox');
  g = applyPresetParams(cb.manifest, cb.workflow, clampPresetValues(cb.manifest, {}).params);
  assert.equal(g['1'].inputs.max_new_tokens, 400, '16 s = 400 tokens');
});

test('settings audit: graph switches and links (Qwen Lightning, Hunyuan cut-out + Max faces, upscalers 2x/4x, Pixal3D normal bake, voice sample, Wan start frame)', () => {
  for (const id of ['qwen-2512-t2i', 'qwen-edit-2509', 'qwen-edit-2511']) {
    const g = preset(id).workflow;
    assert.equal(g['20'].class_type, 'ComfySwitchNode', id);
    assert.deepEqual([g['20'].inputs.on_true, g['20'].inputs.on_false], [['2', 0], ['1', 0]], id);
    assert.equal(g['2'].class_type, 'LoraLoaderModelOnly'); assert.equal(g['2'].inputs.strength_model, 1);
    assert.deepEqual(g['3'].inputs.model, ['20', 0], id);
    if (id === 'qwen-edit-2511') assert.match(g['2'].inputs.lora_name, /2511-Lightning/);
  }
  const hy = preset('hunyuan3d-21').workflow;
  assert.deepEqual(hy['19:13'].inputs.image, ['25', 0]);
  assert.deepEqual([hy['25'].inputs.on_true, hy['25'].inputs.on_false], [['24', 0], ['2', 0]]);
  assert.deepEqual(hy['10'].inputs.mesh, ['26', 0]); assert.deepEqual(hy['26'].inputs.mesh, ['19:9', 0]);
  for (const [id, node, save, def] of [['upscale-4x-model', '5', '4', 1], ['realesrgan-video', '13', '11', 0.5]]) {
    const p = preset(id);
    assert.equal(p.workflow[node].class_type, 'ImageScaleBy');
    assert.deepEqual(p.workflow[save].inputs.images, [node, 0]);
    assert.equal(p.manifest.params.scale.default, def, id);
    const g = applyPresetParams(p.manifest, p.workflow, clampPresetValues(p.manifest, { params: { scale: 0.5 } }).params);
    assert.equal(g[node].inputs.scale_by, 0.5);
  }
  const px = preset('pixal3d-trellis2');
  const g = applyPresetParams(px.manifest, px.workflow, clampPresetValues(px.manifest, { params: { texture: 4096 } }).params);
  assert.equal(g['224'].inputs.resolution, 4096, 'normal bake follows Texture size');
  assert.equal(g['288'].inputs.value, 4096);
  const g1 = applyPresetParams(px.manifest, px.workflow, clampPresetValues(px.manifest, { params: { texture: 1024 } }).params);
  assert.equal(g1['224'].inputs.resolution, 1024);
  const cb = preset('tts-chatterbox');
  assert.ok(cb.manifest.inputs.some((x) => x.node === '3' && x.kind === 'audio' && x.optional));
  let w = dropEmptyOptional(cb.manifest, structuredClone(cb.workflow));
  assert.equal(w['3'], undefined); assert.equal(w['1'].inputs.audio_prompt, undefined, 'no voice sample -> default voice');
  w = dropEmptyOptional(cb.manifest, structuredClone(cb.workflow), new Set(['3']));
  assert.deepEqual(w['1'].inputs.audio_prompt, ['3', 0]);
  const wan = preset('wan22-5b-ti2v');
  w = dropEmptyOptional(wan.manifest, structuredClone(wan.workflow));
  assert.equal(w['60'], undefined); assert.equal(w['55'].inputs.start_image, undefined);
  assert.deepEqual(dropEmptyOptional(wan.manifest, structuredClone(wan.workflow), new Set(['60']))['55'].inputs.start_image, ['60', 0]);
  assert.deepEqual(detectControls(wan.workflow).images.map((s) => s.node), ['60']);
});

test('settings audit: every setting targets a real /object_info input and every list choice is a real ComfyUI option', () => {
  const ids = fs.readdirSync(path.join(ROOT, 'workflows/ai')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  let n = 0;
  for (const id of ids) {
    const p = preset(id);
    for (const [k, prm] of Object.entries(p.manifest.params)) {
      for (const t of [prm, ...(prm.also || [])]) {
        const cls = p.workflow[t.node].class_type;
        const def = objectInfo[cls];
        const spec = { ...(def.input.required || {}), ...(def.input.optional || {}) }[t.input.split('.')[0]];
        assert.ok(spec, `${id}.${k}: ${cls}.${t.input}`);
        const opts = comboOptions(spec);
        if (prm.type === 'enum' && Array.isArray(opts) && !t.input.includes('.')) for (const o of prm.options) assert.ok(opts.includes(o), `${id}.${k}: ${o} not in ${cls}.${t.input}`);
        if (spec[0] === 'BOOLEAN') assert.deepEqual(prm.options, [false, true], `${id}.${k}`);
        n++;
      }
      if (prm.control) assert.ok(['stepper', 'slider', 'select', 'seg', 'text'].includes(prm.control));
    }
  }
  assert.ok(n > 80, `${n} settings checked`);
});
