// Guarded setup builder: tested blocks only, assembled + validated against the
// live /object_info and installed models; plain rejection reasons; user presets
// only on Save; rename/delete. Plus the proposal-tense and app-name checks.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startStack, ROOT } from './helpers.js';
import { buildSetup, validateGraph, isBuilderRequest, builderSchema, testRunGraph } from '../../app/js/lib/builder.js';
import { proposalTense } from '../../app/js/lib/chat-reply.js';

const objectInfo = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/object-info.json'), 'utf8'));
const j = (r) => r.json();
const post = (s, p, body, method = 'POST') => fetch(s.base + p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const SCHNELL_UP = [{ type: 'load_model', params: { family: 'flux1-schnell' } }, { type: 'txt2img', params: { width: 1000, height: 3000, steps: 20 } }, { type: 'upscale', params: { scale: 2 } }];

test('valid chains assemble into graphs that pass validation against object_info', () => {
  const cases = {
    schnell_up: SCHNELL_UP,
    dev_lora: [{ type: 'load_model', params: { family: 'flux1-dev' } }, { type: 'lora', params: { name: 'FLUX-dev-lora-Logo-Design' } }, { type: 'txt2img' }, { type: 'save' }],
    klein_3d: [{ type: 'load_model', params: { family: 'flux2-klein' } }, { type: 'txt2img' }, { type: 'image_to_3d' }],
    qwen_cn: [{ type: 'input_image' }, { type: 'load_model', params: { family: 'qwen-image' } }, { type: 'controlnet', params: {} }, { type: 'txt2img' }],
    schnell_i2i: [{ type: 'input_image' }, { type: 'load_model', params: { family: 'flux1-schnell' } }, { type: 'img2img', params: { strength: 2 } }],
    tts: [{ type: 'audio', params: { engine: 'chatterbox' } }],
  };
  for (const [k, b] of Object.entries(cases)) {
    const r = buildSetup(b, { objectInfo });
    assert.ok(r.ok, `${k}: ${JSON.stringify(r.errors)}`);
    assert.deepEqual(validateGraph(r.graph, objectInfo), [], k);
    for (const n of Object.values(r.graph)) if (/^Save/.test(n.class_type)) assert.match(n.inputs.filename_prefix, /^concept-app\//);
  }
  const r = buildSetup(SCHNELL_UP, { objectInfo });
  assert.ok(r.notes.some((n) => /steps/i.test(n)), 'out-of-range steps are clamped with a note');
});

test('rejections come with plain reasons', () => {
  const reject = (b) => { const r = buildSetup(b, { objectInfo }); assert.equal(r.ok, false); return r.errors.join(' '); };
  assert.match(reject([{ type: 'input_image' }, { type: 'load_model', params: { family: 'flux1-schnell' } }, { type: 'controlnet', params: { name: 'Qwen-Image-InstantX-ControlNet-Union' } }, { type: 'txt2img' }]), /only works with Qwen-Image/);
  assert.match(reject([{ type: 'make_magic' }]), /make_magic/);
  assert.match(reject([{ type: 'input_image' }, { type: 'load_model', params: { family: 'flux2-klein' } }, { type: 'img2img' }]), /klein/i);
  assert.match(reject([{ type: 'load_model', params: { family: 'flux1-schnell' } }, { type: 'lora', params: { name: 'Qwen-Image-2512-Lightning-4steps-V1.0-fp32' } }, { type: 'txt2img' }]), /LoRA/);
  assert.match(reject([{ type: 'video' }]), /needs download\)?: wan2\.2_ti2v_5B_fp16/);
  assert.match(reject(Array.from({ length: 11 }, () => ({ type: 'save' }))), /blocks|at most/i);
  // a graph that references a class or model ComfyUI does not have is rejected by validateGraph
  const g = buildSetup(SCHNELL_UP, { objectInfo }).graph;
  const bad = structuredClone(g); Object.values(bad).find((n) => n.class_type === 'UnetLoaderGGUF').inputs.unet_name = 'nope.gguf';
  assert.match(validateGraph(bad, objectInfo).join(' '), /nope\.gguf/);
  const noCls = { ...objectInfo }; delete noCls.UnetLoaderGGUF;
  assert.match(validateGraph(g, noCls).join(' '), /UnetLoaderGGUF/);
});

test('test-run graph is reduced (<= 768 px before upscaling); schema only offers tested blocks', () => {
  const r = buildSetup(SCHNELL_UP, { objectInfo });
  const t = testRunGraph(r.graph);
  for (const n of Object.values(t.graph)) if (typeof n.inputs.width === 'number') assert.ok(Math.max(n.inputs.width, n.inputs.height) <= 768);
  const sch = builderSchema();
  assert.ok(sch.properties.blocks.items.properties.type.enum.includes('upscale'));
  assert.ok(!sch.properties.blocks.items.properties.type.enum.includes('make_magic'));
});

test('builder intent detection', () => {
  assert.ok(isBuilderRequest('make a setup that upscales schnell output'));
  assert.ok(isBuilderRequest('/build schnell then 3d'));
  assert.ok(!isBuilderRequest('make the duck purple'));
  assert.ok(!isBuilderRequest('upscale this'));
});

test('VibeVoice setups get a voice sample (LoadAudio -> speaker_1_voice); a missing sample is rejected in plain words', () => {
  const r = buildSetup([{ type: 'audio', params: { engine: 'vibevoice' } }], { objectInfo });
  assert.ok(r.ok, JSON.stringify(r.errors));
  const vv = Object.values(r.graph).find((n) => n.class_type === 'VibeVoiceTTS');
  assert.equal(r.graph[vv.inputs.speaker_1_voice[0]].class_type, 'LoadAudio');
  const noVoice = structuredClone(objectInfo); noVoice.LoadAudio.input.required.audio[1].options = [];
  const bad = buildSetup([{ type: 'audio', params: { engine: 'vibevoice' } }], { objectInfo: noVoice });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(' '), /VibeVoice needs a voice sample/);
});

test('server/index.js still starts itself when run directly (main block, "Comfy UI app" log line)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
  assert.match(src, /if \(process\.argv\[1\] && path\.resolve\(process\.argv\[1\]\) === fileURLToPath\(import\.meta\.url\)\)/);
  assert.match(src, /server\.listen\(cfg\.port, cfg\.host/);
  assert.match(src, /Comfy UI app:/);
});

test('proposal tense: an action reply never claims it already ran', () => {
  assert.equal(proposalTense('I have increased the resolution.'), 'I would increase the resolution. Tap Run to start it.');
  assert.match(proposalTense('Upscaling it.'), /^I would upscale it\./);
  assert.doesNotMatch(proposalTense('The image has been upscaled to 4x.'), /has been/);
  assert.doesNotMatch(proposalTense('Done. The image is now sharper.'), /^Done|is now/);
});

test('app name is "Comfy UI" in the page title, PWA manifest and Android strings; package id unchanged', () => {
  const html = fs.readFileSync(path.join(ROOT, 'app/index.html'), 'utf8');
  assert.match(html, /<title>Comfy UI<\/title>/);
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/manifest.webmanifest'), 'utf8'));
  assert.equal(m.name, 'Comfy UI'); assert.equal(m.short_name, 'Comfy UI');
  const strings = fs.readFileSync(path.join(ROOT, 'android/app/src/main/res/values/strings.xml'), 'utf8');
  assert.match(strings, /<string name="app_name">Comfy UI<\/string>/);
  assert.doesNotMatch(strings, /Comfy Concept/);
  const gradle = fs.readFileSync(path.join(ROOT, 'android/app/build.gradle'), 'utf8');
  assert.match(gradle, /applicationId\s*[= ]\s*["']app\.jesse\.comfyconcept["']/);
});

// ---- through the server ----
let s;
before(async () => { s = await startStack(); });
after(() => s.close());

test('/api/builder/propose: real proposal via Ollama `format` validates; nothing is saved; praise and past tense removed', async () => {
  const r = await j(await post(s, '/api/builder/propose', { text: 'make a setup: schnell then upscale 2x' }));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.name, 'Fast concept 2x');
  assert.ok(r.graph && r.summary.length >= 3);
  assert.doesNotMatch(r.reply, /Great idea|I have made/);
  assert.match(r.reply, /Nothing has run yet/);
  const req = s.ollama.requests?.find?.((x) => x.body?.format?.properties?.blocks);
  if (req) assert.equal(req.body.stream, false);
  assert.deepEqual((await j(await fetch(s.base + '/api/user-presets'))).presets, []);
});

test('/api/builder/propose: an invalid proposal is rejected with the reason', async () => {
  const r = await j(await post(s, '/api/builder/propose', { text: 'make a setup BADSETUP' }));
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /controlnet\).*only works with Qwen-Image/);
});

test('user presets: Save stores blocks (re-validated), listed under My presets; rename, delete; invalid -> 422', async () => {
  const bad = await post(s, '/api/user-presets', { name: 'x', blocks: [{ type: 'video' }] });
  assert.equal(bad.status, 422);
  assert.match((await j(bad)).error, /needs download/);
  const saved = await j(await post(s, '/api/user-presets', { name: 'Schnell up', blocks: SCHNELL_UP }));
  assert.match(saved.id, /^user:u_/);
  const again = await j(await post(s, '/api/user-presets', { name: 'Schnell up', blocks: SCHNELL_UP }));
  assert.equal(again.name, 'Schnell up 2');
  let { workflows } = await j(await fetch(s.base + '/api/workflows'));
  const mine = workflows.find((w) => w.id === saved.id);
  assert.equal(mine.group, 'My presets');
  assert.ok(mine.workflow && mine.controls.prompt.length);
  assert.equal((await post(s, `/api/user-presets/${encodeURIComponent(saved.id)}`, { name: 'Renamed' }, 'PATCH')).status, 200);
  assert.equal((await fetch(`${s.base}/api/user-presets/${encodeURIComponent(again.id)}`, { method: 'DELETE' })).status, 200);
  ({ workflows } = await j(await fetch(s.base + '/api/workflows')));
  assert.deepEqual(workflows.filter((w) => w.group === 'My presets' && w.user).map((w) => w.label), ['Renamed']);
  assert.ok(fs.existsSync(path.join(s.dataDir, 'user-presets.json')));
  // data/ is gitignored
  assert.match(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8'), /^\/?data\/?$/m);
});

test('builder model is configurable (default gemma3:4b); the config carries no recommendation', async () => {
  const c = await j(await fetch(s.base + '/api/builder/config'));
  assert.equal(c.model, 'gemma3:4b');
  assert.equal(c.recommended, undefined, 'no "recommended after the upgrade" model');
  assert.equal((await j(await post(s, '/api/builder/config', { model: 'qwen3:14b' }, 'PUT'))).model, 'qwen3:14b');
  assert.equal((await post(s, '/api/builder/config', { model: 'bad name; rm' }, 'PUT')).status, 400);
});

test('/api/builder/check with test=true returns a reduced graph and never saves', async () => {
  const r = await j(await post(s, '/api/builder/check', { blocks: SCHNELL_UP, name: 'T', test: true }));
  const before = (await j(await fetch(s.base + '/api/user-presets'))).presets.length;
  assert.equal(r.ok, true); assert.equal(r.test, true);
  for (const n of Object.values(r.graph)) if (typeof n.inputs.width === 'number') assert.ok(n.inputs.width <= 768);
  assert.equal((await j(await fetch(s.base + '/api/user-presets'))).presets.length, before);
});
