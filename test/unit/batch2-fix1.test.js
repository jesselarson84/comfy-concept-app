// batch2-fix1: Hunyuan3D "makes only a box". On an opaque backdrop Hunyuan3D 2.1
// models the whole frame, so the SDF is inside everywhere and the mesh is the
// grid's outer box (Nov 22: 384,056 vertices, all on the +/-0.98 cube faces).
// Every Hunyuan path must cut the object out (BiRefNet) and put it on white
// before CLIP vision, with Detail -> octree_resolution and Steps -> KSampler.steps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.js';
import { validatePreset, clampPresetValues, applyPresetParams, checkInstalled } from '../../app/js/lib/presets.js';
import { validateGraph } from '../../app/js/lib/graph-validate.js';

const objectInfo = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/object-info.json'), 'utf8'));
const models = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/models.json'), 'utf8'));
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const preset = () => validatePreset('hunyuan3d-21', read('workflows/ai/hunyuan3d-21.json'));

/** Follow the CLIP vision image back to its source and check the cut-out chain. */
export function assertCutout(g, loadId, label) {
  const [encId, enc] = Object.entries(g).find(([, n]) => n.class_type === 'CLIPVisionEncode') || [];
  assert.ok(enc, `${label}: CLIPVisionEncode`);
  let comp = g[enc.inputs.image[0]];
  // Batch 3 (item 7): the preset routes it through a "Remove background" switch, On by default.
  if (comp?.class_type === 'ComfySwitchNode') {
    assert.equal(comp.inputs.switch, true, `${label}: Remove background is On by default`);
    assert.deepEqual(comp.inputs.on_false, [loadId, 0], `${label}: Off sends the upload as is`);
    comp = g[comp.inputs.on_true[0]];
  }
  assert.equal(comp?.class_type, 'ImageCompositeMasked', `${label}: CLIP vision sees the composited picture, not the raw upload (${encId})`);
  assert.deepEqual(comp.inputs.destination, [loadId, 0], `${label}: composite keeps the uploaded picture`);
  assert.equal(comp.inputs.resize_source, true, `${label}: white fill is stretched to the picture size`);
  const white = g[comp.inputs.source[0]];
  assert.equal(white.class_type, 'EmptyImage');
  assert.equal(white.inputs.color, 0xffffff, `${label}: background becomes white`);
  const inv = g[comp.inputs.mask[0]];
  assert.equal(inv.class_type, 'InvertMask', `${label}: white goes where the object is NOT`);
  const rb = g[inv.inputs.mask[0]];
  assert.equal(rb.class_type, 'RemoveBackground');
  assert.deepEqual(rb.inputs.image, [loadId, 0], `${label}: mask is cut from the same uploaded picture`);
  assert.equal(g[rb.inputs.bg_removal_model[0]].inputs.bg_removal_name, 'birefnet.safetensors');
  assert.equal(g[loadId].class_type, 'LoadImage');
}

test('Hunyuan3D preset: reference is cut out on white before CLIP vision; graph validates against object_info', () => {
  const p = preset();
  assert.ok(p.ok, p.error);
  assertCutout(p.workflow, '2', 'preset');
  assert.deepEqual(validateGraph(p.workflow, objectInfo), []);
  assert.equal(checkInstalled(p.workflow, { objectInfo, models }).ok, true);
});

test('Hunyuan3D preset params: Detail -> VAEDecodeHunyuan3D.octree_resolution (192/256/320/384), Steps -> KSampler.steps; num_chunks untouched', () => {
  const p = preset();
  const { params } = clampPresetValues(p.manifest, { params: { steps: 30, detail: 256 } });
  const g = applyPresetParams(p.manifest, p.workflow, params);
  const dec = Object.values(g).find((n) => n.class_type === 'VAEDecodeHunyuan3D');
  const ks = Object.values(g).find((n) => n.class_type === 'KSampler');
  assert.equal(dec.inputs.octree_resolution, 256);
  assert.equal(dec.inputs.num_chunks, 8000);
  assert.equal(ks.inputs.steps, 30);
  assert.equal(ks.inputs.cfg, 5);
  const hi = applyPresetParams(p.manifest, p.workflow, clampPresetValues(p.manifest, { params: { steps: 99, detail: 384 } }).params);
  assert.equal(clampPresetValues(p.manifest, { params: { detail: 9999 } }).params.detail, 256, 'not an option -> default');
  assert.equal(Object.values(hi).find((n) => n.class_type === 'VAEDecodeHunyuan3D').inputs.octree_resolution, 384);
  assert.equal(Object.values(hi).find((n) => n.class_type === 'KSampler').inputs.steps, 50);
  assertCutout(g, '2', 'preset after params');
});

test('Hunyuan3D preset reports "needs download" when the BiRefNet model is missing (no silent box)', () => {
  const p = preset();
  const oi = structuredClone(objectInfo);
  oi.LoadBackgroundRemovalModel.input.required.bg_removal_name[1].options = [];
  const r = checkInstalled(p.workflow, { objectInfo: oi, models });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(' '), /needs download: birefnet\.safetensors/);
});

test('Pixal3D / TRELLIS.2 preset already cuts the object out: BiRefNet mask (switch on) -> ImageCropToMask on black -> both conditionings', () => {
  const p = validatePreset('pixal3d-trellis2', read('workflows/ai/pixal3d-trellis2.json'));
  assert.ok(p.ok, p.error);
  const g = p.workflow;
  const src = (ref) => g[ref[0]];
  // a PreviewImage / MaskPreview in between only passes the value through
  const through = (ref) => { let n = src(ref); while (n && /^(PreviewImage|MaskPreview)$/.test(n.class_type)) n = src(n.inputs.images || n.inputs.mask); return n; };
  for (const cls of ['Pixal3DConditioning', 'Trellis2Conditioning', 'MoGeInference']) {
    const n = Object.values(g).find((x) => x.class_type === cls);
    const crop = through(n.inputs.image);
    assert.equal(crop.class_type, 'ImageCropToMask', `${cls} gets the cropped cut-out`);
    assert.equal(crop.inputs.background, '#000000');
    assert.equal(src(crop.inputs.images).class_type, 'LoadImage');
    const sw = through(crop.inputs.masks);
    assert.equal(sw.class_type, 'ComfySwitchNode');
    assert.equal(sw.inputs.switch, true, 'the BiRefNet branch is selected, not the picture\'s own alpha');
    const rb = src(sw.inputs.on_true);
    assert.equal(rb.class_type, 'RemoveBackground');
    assert.deepEqual(rb.inputs.image, crop.inputs.images, 'mask is cut from the same uploaded picture');
    assert.equal(src(rb.inputs.bg_removal_model).inputs.bg_removal_name, 'birefnet.safetensors');
  }
  // Batch 3 (item 7, settings audit): "Remove background" is a setting now, On by default.
  const rb = Object.values(p.manifest.params).filter((x) => x.node === '248');
  assert.equal(rb.length, 1); assert.equal(rb[0].input, 'switch'); assert.equal(rb[0].default, true);
  const oi = structuredClone(objectInfo);
  oi.LoadBackgroundRemovalModel.input.required.bg_removal_name[1].options = [];
  assert.match(checkInstalled(g, { objectInfo: oi, models }).reasons.join(' '), /needs download: birefnet\.safetensors/);
});
