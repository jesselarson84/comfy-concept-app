// AI Workflows (Comfy UI Ideas doc): model vs workflow presets, the seven
// workflow graphs, built-in instructions, and ComfyUI's two right-click menus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validatePreset, formatPrompt, KINDS, GROUPS, WORKFLOW_GROUPS, menuParts } from '../../app/js/lib/presets.js';
import { SECTIONS, TABS, tabOf, pickerLayout } from '../../app/js/ui/workflow-picker.js';
import { buildManifest } from '../../scripts/sync-comfy-menu.mjs';
import { startStack, ROOT } from './helpers.js';

const AI = path.join(ROOT, 'workflows/ai');
const load = (id) => validatePreset(id, JSON.parse(fs.readFileSync(path.join(AI, `${id}.json`), 'utf8')));
const ids = fs.readdirSync(AI).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
const WF = ids.filter((id) => id.startsWith('wf-'));

test('kinds: every preset is a model or a workflow; workflows live in task sections, models in output sections', () => {
  assert.deepEqual(KINDS, ['model', 'workflow']);
  assert.deepEqual(WORKFLOW_GROUPS, ['Textures', 'Concept', 'VFX', '3D Assets', 'Sound']);
  assert.equal(WF.length, 17); // batch 14: Concept Looks Pose / FLUX.1 Dev
  for (const id of ids) {
    const p = load(id);
    assert.ok(p.ok, `${id}: ${p.error}`);
    if (id.startsWith('wf-')) { assert.equal(p.manifest.kind, 'workflow', id); assert.ok(WORKFLOW_GROUPS.includes(p.manifest.group), id); }
    else { assert.equal(p.manifest.kind, 'model', id); assert.ok(GROUPS.includes(p.manifest.group), id); }
  }
  const bad = (m) => validatePreset('x', { preset: { label: 'x', output: 'image', ...m }, workflow: { 1: { class_type: 'A', inputs: {} } } });
  assert.match(bad({ kind: 'workflow', group: 'Image' }).error, /Textures, Concept, VFX, 3D Assets, Sound/);
  assert.match(bad({ group: 'Textures' }).error, /3D, Image, Video, Audio/);
  assert.match(bad({ kind: 'pipeline', group: 'Image' }).error, /kind/);
});

test('the seven workflows: sections, outputs, what the user fills in', () => {
  const by = Object.fromEntries(WF.map((id) => [id, load(id).manifest]));
  assert.deepEqual(Object.fromEntries(WF.map((id) => [id, by[id].group])), {
    'wf-concept-depth': 'Concept', 'wf-concept-edges': 'Concept', 'wf-flipbook': 'VFX', 'wf-grunge-map': 'Textures',
    'wf-make-seamless': 'Textures', 'wf-remove-lighting': 'Textures', 'wf-texture-upscale': 'Textures',
    'wf-photo-texture': 'Textures', 'wf-pbr-maps': 'Textures', 'wf-pbr-chord': 'Textures', 'wf-depth-normal': 'Textures',
    // batch 8
    'wf-photo-to-3d': '3D Assets', 'wf-voice-line-swap': 'Sound', 'wf-voice-line-sfx': 'Sound', 'wf-sfx-set': 'Sound',
    // batch 14
    'wf-concept-pose': 'Concept', 'wf-concept-flux': 'Concept',
  });
  const OUT = { 'wf-photo-to-3d': '3d', 'wf-voice-line-swap': 'audio', 'wf-voice-line-sfx': 'audio', 'wf-sfx-set': 'audio' };
  for (const id of WF) {
    assert.equal(by[id].output, OUT[id] || 'image', id);
    assert.equal(menuParts(by[id].group, by[id].menuPath, by[id].label).subgroup, null, `${id}: no sub sections`);
    assert.ok(by[id].description.length > 60, id);
  }
  // ControlNet presets name both downloaded patch files; seam fixes use the lite one
  const ce = load('wf-concept-edges');
  assert.deepEqual(ce.manifest.params.patch.options.map((o) => /lite/.test(o)), [false, true]);
  assert.equal(ce.workflow[ce.manifest.params.patch.node].class_type, 'ModelPatchLoader');
  assert.equal(Object.values(ce.workflow).filter((n) => n.class_type === 'Canny').length, 1);
  assert.equal(Object.values(load('wf-concept-depth').workflow).filter((n) => n.class_type === 'Canny').length, 0, 'the depth pass is used as it is');
  // Make Seamless: AI repaint (lite ControlNet, inpaint mode) or blend, through a lazy switch
  const ms = load('wf-make-seamless');
  assert.deepEqual(ms.manifest.files, [{ folder: 'model_patches', file: 'Z-Image-Turbo-Fun-Controlnet-Union-2.1-lite-2602-8steps.safetensors' }]);
  const inp = Object.values(ms.workflow).find((n) => n.class_type === 'ZImageFunControlnet');
  assert.ok(inp.inputs.inpaint_image && inp.inputs.mask, 'seam repainted in inpaint mode');
  assert.equal(ms.workflow[inp.inputs.inpaint_image[0]].class_type, 'ImageCompositeMasked', 'the cross is blanked in the inpaint guide');
  const sw = ms.workflow[ms.manifest.params.method.node];
  assert.equal(sw.class_type, 'ComfySwitchNode');
  assert.deepEqual([ms.manifest.params.method.default, ms.manifest.params.blend.default], [true, 1]);
  assert.deepEqual(ms.manifest.params.blend.when, { param: 'method', is: true }, 'repaint settings dim with Blend');
  // Grunge Map: blend only (the repaint flattened the grain into grey bands), so no ControlNet
  const gm = load('wf-grunge-map');
  assert.deepEqual(gm.manifest.files, []);
  assert.ok(!Object.values(gm.workflow).some((n) => /ZImageFunControlnet|ModelPatchLoader/.test(n.class_type)));
  assert.equal(Object.values(gm.workflow).filter((n) => n.class_type === 'KSampler').length, 1);
  // cross masks: bands OR-ed (an add doubles the crossing square)
  for (const p of [ms, gm]) assert.ok(Object.values(p.workflow).filter((n) => n.class_type === 'MaskComposite').every((n) => n.inputs.operation === 'or'));
  // flipbook: square grid, columns follow the frame count
  const fb = load('wf-flipbook');
  assert.deepEqual(fb.manifest.params.grid.options, [16, 36, 64]);
  assert.deepEqual(fb.manifest.params.grid.also, [{ node: '72', input: 'values.a' }]);
  assert.deepEqual(fb.workflow['73'].inputs.columns, ['72', 1]);
  assert.equal(fb.workflow['58'], undefined, 'no video saved, only the sheet');
});

test('built-in instruction: an empty prompt uses promptDefault; a typed one replaces it', () => {
  const m = load('wf-remove-lighting').manifest;
  assert.match(m.promptDefault, /Remove all shadows/);
  assert.equal(formatPrompt(m, ''), m.promptDefault);
  assert.equal(formatPrompt(m, '  '), m.promptDefault);
  assert.equal(formatPrompt(m, 'remove the hot spot only'), 'remove the hot spot only');
  const g = load('wf-grunge-map').manifest;
  assert.equal(g.promptDefault, '');
  assert.match(formatPrompt(g, 'rust patches'), /^rust patches, .*seamless tileable/);
});

test('picker: Models | Workflows tabs; each section sits on one tab; layout per tab', () => {
  assert.deepEqual(TABS.map((t) => t.label), ['Models', 'Workflows']);
  assert.deepEqual(SECTIONS.filter((s) => s.tab === 'workflow').map((s) => s.key), WORKFLOW_GROUPS);
  assert.equal(tabOf({ group: 'Textures' }), 'workflow');
  assert.equal(tabOf({ group: 'Image' }), 'model');
  assert.equal(tabOf({ id: 'imported' }), 'model', 'My presets is on Models');
  const items = [{ id: 'a', group: 'Image' }, { id: 'b', group: 'VFX' }, { id: 'c', group: 'Textures' }, { id: 'd' }];
  assert.deepEqual(pickerLayout(items, 'model').map((x) => x.sec.key), ['Image', 'My presets']);
  assert.deepEqual(pickerLayout(items, 'workflow').map((x) => x.sec.key), ['Textures', 'VFX']);
  assert.equal(pickerLayout(items).length, 4, 'no tab: every section');
});

test('ComfyUI menus: AI Models (sub sections like the app) and AI Workflows; UI files kept; extra pack entries kept', () => {
  const presets = ids.map(load);
  const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'comfyui/ComfyUI-AIWorkflowMenu/web/workflows/manifest.json'), 'utf8'));
  const { manifest, apiFiles } = buildManifest({ presets, packEntries: pack.entries });
  assert.deepEqual(manifest.menus.map((m) => m.label), ['AI Models', 'AI Workflows']);
  const e = (p) => manifest.entries.find((x) => x.path === p);
  assert.deepEqual(e('Image/Text to Image/Z-Image Turbo'), { menu: 'models', path: 'Image/Text to Image/Z-Image Turbo', file: 'image/z_image_turbo.json', format: 'ui', preset: 'ai:z-image-turbo' });
  assert.equal(e('Textures/Make Seamless').format, 'api');
  assert.equal(e('Textures/Make Seamless').menu, 'workflows');
  assert.ok(apiFiles['api/wf-make-seamless.json']['1'], 'API graph written for the pack');
  assert.ok(e('Video/Wan 2.2 5B Text⁄Image to Video'), 'a "/" inside a name is not a folder');
  assert.ok(e('3D/MoGe Image to Mesh'), 'pack-only entry kept in AI Models');
  assert.equal(manifest.entries.filter((x) => x.menu === 'workflows').length, 17);
  // the committed manifest is what the sync script makes from today's presets
  assert.deepEqual(pack, manifest, 'run: node scripts/sync-comfy-menu.mjs');
  for (const [f, wf] of Object.entries(apiFiles)) assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ROOT, 'comfyui/ComfyUI-AIWorkflowMenu/web/workflows', f), 'utf8')), wf, f);
  // the menu script builds one entry per menu
  const js = fs.readFileSync(path.join(ROOT, 'comfyui/ComfyUI-AIWorkflowMenu/web/ai_workflow_menu.js'), 'utf8');
  assert.match(js, /manifest\.menus\.map/);
  assert.match(js, /app\.loadApiJson\(graph/);
});

test('API: /api/workflows says each preset\'s kind; saved presets can go into workflow sections', async () => {
  const s = await startStack({ folderWorkflows: false });
  try {
    const list = (await (await fetch(s.base + '/api/workflows')).json()).workflows;
    assert.equal(list.find((w) => w.id === 'ai:wf-grunge-map').kind, 'workflow');
    assert.equal(list.find((w) => w.id === 'ai:z-image-turbo').kind, 'model');
    assert.equal(list.find((w) => w.id === 'ai:wf-remove-lighting').ai.promptDefault.length > 20, true);
    const r = await fetch(s.base + '/api/graph-presets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'My grunge', group: 'Textures', workflow: load('wf-grunge-map').workflow }) });
    const j = await r.json();
    assert.equal(r.status, 201);
    const saved = (await (await fetch(s.base + '/api/workflows')).json()).workflows.find((w) => w.id === j.id);
    assert.equal(saved.group, 'Textures');
    assert.equal(tabOf(saved), 'workflow');
  } finally { await s.close(); }
});
