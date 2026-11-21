// Workflow control detection, against the real klein workflows + synthetic ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectControls, checkApiFormat, tagsOf } from '../../app/js/lib/workflow-detect.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const load = (p) => JSON.parse(fs.readFileSync(path.resolve(root, p), 'utf8'));
const fx = (n) => load(`test/fixtures/${n}.json`);
const kleinDir = path.resolve(root, '../claude_tests/klein');
const T = (node, input) => ({ node, input });

test('real klein_ref_s0/s1/s2: prompt, seed, steps, 3 image slots, no negative, size follows reference', () => {
  for (const s of [0, 1, 2]) {
    const wf = load(path.join(kleinDir, `klein_ref_s${s}.json`));
    const c = detectControls(wf);
    assert.equal(c.ok, true);
    assert.deepEqual(c.prompt, [T('40', 'text')]);
    assert.deepEqual(c.negative, [], 'negative is ConditioningZeroOut -> no negative prompt');
    assert.deepEqual(c.seed, [T('54', 'noise_seed')]);
    assert.equal(c.defaults.seed, [101, 202, 303][s]);
    assert.deepEqual(c.steps, [T('52', 'steps')]);
    assert.deepEqual(c.images.map((i) => i.node), ['10', '20', '30']);
    assert.deepEqual(c.width, [], 'width comes from GetImageSize link -> not a control');
    assert.deepEqual(c.batch, [T('51', 'batch_size')]);
    assert.deepEqual(c.outputs, ['58']);
    assert.equal(c.kind, 'img2img');
  }
});

test('real klein_faces_s0: two image slots, node 43 defined last still traced', () => {
  const c = detectControls(load(path.join(kleinDir, 'klein_faces_s0.json')));
  assert.deepEqual(c.prompt, [T('40', 'text')]);
  assert.deepEqual(c.images.map((i) => i.node), ['10', '20']);
  assert.deepEqual(c.negative, []);
});

test('basic-txt2img fixture (old fast-concept preset): txt2img, width/height in latent AND scheduler', () => {
  const c = detectControls(load('test/fixtures/workflows/basic-txt2img.json'));
  assert.equal(c.kind, 'txt2img');
  assert.deepEqual(c.prompt, [T('40', 'text')]);
  assert.deepEqual(c.width, [T('51', 'width'), T('52', 'width')]);
  assert.deepEqual(c.height, [T('51', 'height'), T('52', 'height')]);
  assert.deepEqual(c.seed, [T('54', 'noise_seed')]);
  assert.deepEqual(c.images, []);
  assert.deepEqual(c.strength, []);
  assert.equal(c.defaults.width, 1024);
  assert.deepEqual(c.warnings, []);
});

test('basic-reference fixture (old from-reference-image preset): image slot + strength via #strength', () => {
  const c = detectControls(load('test/fixtures/workflows/basic-reference.json'));
  assert.equal(c.kind, 'img2img');
  assert.deepEqual(c.images.map((i) => [i.node, i.title]), [['10', 'Reference']]);
  assert.deepEqual(c.strength, [T('60', 'denoise')]);
  assert.equal(c.defaults.strength, 0.75);
  assert.deepEqual(c.width, []);
});

test('SD1.5 KSampler graph: positive vs negative found by tracing, denoise not a strength in txt2img', () => {
  const c = detectControls(fx('sd15-negative'));
  assert.deepEqual(c.prompt, [T('6', 'text')]);
  assert.deepEqual(c.negative, [T('7', 'text')]);
  assert.equal(c.defaults.negative, 'blurry');
  assert.deepEqual(c.seed, [T('3', 'seed')]);
  assert.deepEqual(c.steps, [T('3', 'steps')]);
  assert.deepEqual(c.width, [T('5', 'width')]);
  assert.deepEqual(c.strength, []);
});

test('links to primitive nodes are followed to the value; shared pos/neg encoder counts as positive', () => {
  const c = detectControls(fx('primitive-linked'));
  assert.deepEqual(c.prompt, [T('1', 'value')]);
  assert.deepEqual(c.negative, []);
  assert.deepEqual(c.seed, [T('4', 'value')]);
  assert.equal(c.defaults.seed, 1234);
});

test('Flux.1 CLIPTextEncodeFlux + BasicGuider: both text fields are prompt targets', () => {
  const c = detectControls(fx('flux1-dualprompt'));
  assert.deepEqual(c.prompt, [T('2', 't5xxl'), T('2', 'clip_l')]);
  assert.deepEqual(c.seed, [T('7', 'noise_seed')]);
  assert.deepEqual(c.steps, [T('6', 'steps')]);
});

test('#tags override and extend detection (custom node types)', () => {
  const wf = fx('tagged-custom');
  assert.deepEqual(tagsOf(wf['2']), ['prompt']);
  const c = detectControls(wf);
  assert.deepEqual(c.prompt, [T('2', 'words')]);
  assert.deepEqual(c.seed, [T('3', 'value')]);
  assert.deepEqual(c.width, [T('5', 'value')]);
  assert.deepEqual(c.expose.map((e) => e.input).sort(), ['glow', 'mode', 'size_h', 'size_w']);
  assert.equal(c.expose.find((e) => e.input === 'glow').type, 'number');
});

test('nothing detectable: still ok, kind unknown, clear message', () => {
  const c = detectControls(fx('nothing-detectable'));
  assert.equal(c.ok, true);
  assert.equal(c.kind, 'unknown');
  assert.match(c.message, /No controls detected/);
});

test('UI-format and junk are rejected with a reason', () => {
  assert.match(detectControls(fx('ui-format')).error, /UI-format.*Export \(API\)/);
  assert.equal(checkApiFormat([]).ok, false);
  assert.equal(checkApiFormat({ 1: { inputs: {} } }).ok, false);
  assert.equal(checkApiFormat({}).ok, false);
});

test('no output node -> warning', () => {
  const wf = fx('sd15-negative'); delete wf['9'];
  assert.ok(detectControls(wf).warnings.some((w) => /SaveImage/.test(w)));
});
