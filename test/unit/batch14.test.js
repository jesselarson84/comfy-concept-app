// Batch 14: the helper models in the app - FLUX.1 Fill (inpaint + outpaint), Concept
// Looks with FLUX.1 Dev / Qwen-Image ControlNets ("Guide by" sets several switches),
// Concept Looks (Pose) with DWPose, Depth Anything 3 in Concept Looks (Depth), and
// SAM 2 "Select" in the mask editor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.js';
import { validatePreset, applyPresetParams } from '../../app/js/lib/presets.js';
import { samGraph, createSam } from '../../server/sam.js';

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const load = (id) => { const r = validatePreset(id, JSON.parse(read(`workflows/ai/${id}.json`))); assert.ok(r.ok, `${id}: ${r.error}`); return r; };
const of = (wf, cls) => Object.entries(wf).filter(([, n]) => n.class_type === cls);

test('preset "set": one choice switches several inputs; bad entries are refused', () => {
  const wf = { 1: { class_type: 'PrimitiveString', inputs: { value: 'a' } }, 2: { class_type: 'ComfySwitchNode', inputs: { switch: false } }, 3: { class_type: 'ComfySwitchNode', inputs: { switch: false, on_true: ['2', 0] } } };
  const p = (set) => validatePreset('x', { preset: { label: 'x', group: 'Image', output: 'image', params: { g: { node: '1', input: 'value', type: 'enum', options: ['a', 'b'], default: 'a', set } } }, workflow: wf });
  const ok = p({ b: [{ node: '2', input: 'switch', value: true }, { node: '3', input: 'switch', value: true }] });
  assert.ok(ok.ok);
  const out = applyPresetParams(ok.manifest, wf, { g: 'b' });
  assert.deepEqual([out[1].inputs.value, out[2].inputs.switch, out[3].inputs.switch], ['b', true, true]);
  assert.equal(applyPresetParams(ok.manifest, wf, {})[2].inputs.switch, false, 'option without a set list changes nothing else');
  assert.match(p({ c: [] }).error, /unknown option c/);
  assert.match(p({ b: [{ node: '9', input: 'switch', value: true }] }).error, /not a value/);
  assert.match(p({ b: [{ node: '3', input: 'on_true', value: 1 }] }).error, /not a value/, 'a link is not a value');
});

test('FLUX.1 Fill: inpaint (crop & stitch, mask) and outpaint (pad) presets', () => {
  const ip = load('flux1-fill-inpaint');
  assert.equal(ip.manifest.subgroup, 'Inpainting');
  assert.deepEqual(ip.manifest.mask, { node: '2', input: 'image', image: '1' });
  assert.equal(of(ip.workflow, 'UnetLoaderGGUF')[0][1].inputs.unet_name, 'flux1-fill-dev-Q5_K_S.gguf');
  for (const c of ['InpaintCropImproved', 'InpaintModelConditioning', 'DifferentialDiffusion', 'InpaintStitchImproved']) assert.equal(of(ip.workflow, c).length, 1, c);
  assert.equal(of(ip.workflow, 'FluxGuidance')[0][1].inputs.guidance, 30);
  const op = load('flux1-fill-outpaint');
  assert.equal(op.manifest.subgroup, 'Outpainting');
  const pad = op.workflow[op.manifest.params.left.node];
  assert.equal(pad.class_type, 'ImagePadForOutpaint');
  assert.deepEqual(['left', 'right', 'top', 'bottom'].map((k) => op.manifest.params[k].default), [256, 256, 0, 0]);
  assert.deepEqual(op.workflow[of(op.workflow, 'InpaintModelConditioning')[0][0]].inputs.mask, [String(op.manifest.params.left.node), 1]);
  for (const p of [ip, op]) assert.doesNotMatch(JSON.stringify(p.manifest), /colour/i, 'US spelling');
});

test('Concept Looks with FLUX.1 Dev / Qwen-Image: Guide by Edges / Depth / Depth pass / Pose', () => {
  for (const [id, cn] of [['wf-concept-flux', 'FLUX.1-dev-ControlNet-Union-Pro-2.0.safetensors'], ['wf-concept-qwen', 'Qwen-Image-InstantX-ControlNet-Union.safetensors']]) {
    const p = load(id);
    assert.equal(p.manifest.group, 'Concept');
    assert.equal(of(p.workflow, 'ControlNetLoader')[0][1].inputs.control_net_name, cn);
    const apply = of(p.workflow, 'ControlNetApplyAdvanced')[0][1];
    const guideOf = (mode) => {
      const wf = applyPresetParams(p.manifest, p.workflow, { guide: mode });
      // follow the switches from the ControlNet image back to the guide
      let n = apply.inputs.image[0];
      while (wf[n].class_type === 'ComfySwitchNode') n = wf[n].inputs[wf[n].inputs.switch ? 'on_true' : 'on_false'][0];
      return wf[n].class_type;
    };
    assert.deepEqual(['edges', 'depth', 'pass', 'pose'].map(guideOf), ['Canny', 'DA3Render', 'ImageScaleToTotalPixels', 'DWPreprocessor'], id);
    assert.equal(guideOf(p.manifest.params.guide.default), 'Canny');
    // the graph as stored (ComfyUI menu) runs the default guide too
    let n = apply.inputs.image[0];
    while (p.workflow[n].class_type === 'ComfySwitchNode') n = p.workflow[n].inputs[p.workflow[n].inputs.switch ? 'on_true' : 'on_false'][0];
    assert.equal(p.workflow[n].class_type, 'Canny');
    assert.deepEqual(p.manifest.params.detail.when, { param: 'guide', is: 'edges' });
  }
});

test('Concept Looks (Pose) uses DWPose; Concept Looks (Depth) estimates with Depth Anything 3', () => {
  const pose = load('wf-concept-pose');
  const sw = pose.workflow[pose.manifest.params.source.node];
  assert.equal(pose.workflow[sw.inputs.on_true[0]].class_type, 'DWPreprocessor');
  assert.equal(pose.manifest.params.source.default, true, 'a photo is the default');
  assert.equal(of(pose.workflow, 'ZImageFunControlnet').length, 1);
  const depth = load('wf-concept-depth');
  assert.equal(of(depth.workflow, 'MoGeInference').length, 0);
  assert.equal(of(depth.workflow, 'LoadDA3Model')[0][1].inputs.model_name, 'depth_anything_3_base.safetensors');
  assert.equal(depth.manifest.params.source.labels.true, 'Estimate');
});

test('SAM 2 Select: graph, server route, mask editor tool', async () => {
  const g = samGraph('pic.png', [{ x: 10.4, y: 20.6 }]);
  assert.equal(g[2].inputs.model, 'sam2.1_hiera_large.safetensors');
  assert.equal(g[3].inputs.coordinates_positive, '[{"x":10,"y":21}]');
  assert.equal(g[5].class_type, 'PreviewImage', 'nothing is saved, so the PC sync skips it');
  // a fake ComfyUI: takes the prompt, finishes it, serves the mask
  const seen = [];
  const fetchImpl = async (url, opts = {}) => {
    seen.push(url);
    const body = String(url).endsWith('/prompt') ? { prompt_id: 'p1' }
      : String(url).includes('/history/') ? { p1: { status: { completed: true }, outputs: { 5: { images: [{ filename: 'm.png', subfolder: '', type: 'temp' }] } } } } : null;
    return { ok: true, json: async () => body, arrayBuffer: async () => new TextEncoder().encode('PNG').buffer };
  };
  const sam = createSam({ getComfyUrl: () => 'http://c', fetchImpl, pollMs: 1 });
  assert.equal((await sam.select({ image: 'pic.png', points: [{ x: 1, y: 2 }] })).toString(), 'PNG');
  assert.ok(seen.some((u) => u.includes('/view?filename=m.png') && u.includes('type=temp')));
  await assert.rejects(sam.select({ image: '../x', points: [{ x: 1, y: 2 }] }), /Bad picture/);
  await assert.rejects(sam.select({ image: 'pic.png', points: [] }), /Tap/);
  assert.match(read('server/index.js'), /p === '\/api\/sam\/select' && req\.method === 'POST'/);
  const me = read('app/js/ui/mask-editor.js');
  assert.match(me, /tool\('select', 'Select'\)/);
  assert.match(me, /await samSelect\(this\.source, \[\{ x: p\.x, y: p\.y \}\]\)/);
  assert.match(me, /this\.pushUndo\(\);\n\s+this\.ctx\.globalCompositeOperation = 'source-over';\n\s+this\.ctx\.drawImage\(tmp, 0, 0\);/, 'a selection can be undone');
});

