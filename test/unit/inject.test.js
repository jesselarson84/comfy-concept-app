// Param injection: seed / prompt / size / image / strength / output prefix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectControls } from '../../app/js/lib/workflow-detect.js';
import { injectParams } from '../../app/js/lib/workflow-inject.js';
import { sizeFor } from '../../app/js/lib/aspect.js';
import { batchSeeds, MAX_SEED } from '../../app/js/lib/seed.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const load = (p) => JSON.parse(fs.readFileSync(path.resolve(root, p), 'utf8'));

test('basic-txt2img fixture (old fast-concept): prompt, seed, width/height in both nodes, prefix; original untouched', () => {
  const wf = load('test/fixtures/workflows/basic-txt2img.json');
  const before = JSON.stringify(wf);
  const c = detectControls(wf);
  const out = injectParams(wf, c, { prompt: 'a red fox', seed: 777.9, width: 832, height: 1248, steps: 6, outputPrefix: 'concept-app', batchSize: 1 });
  assert.equal(JSON.stringify(wf), before, 'preset not mutated');
  assert.equal(out['40'].inputs.text, 'a red fox');
  assert.equal(out['54'].inputs.noise_seed, 777);
  assert.equal(out['51'].inputs.width, 832); assert.equal(out['52'].inputs.width, 832);
  assert.equal(out['51'].inputs.height, 1248); assert.equal(out['52'].inputs.height, 1248);
  assert.equal(out['52'].inputs.steps, 6);
  assert.equal(out['51'].inputs.batch_size, 1);
  assert.equal(out['58'].inputs.filename_prefix, 'concept-app/concept');
  assert.deepEqual(out['40'].inputs.clip, ['2', 0], 'links preserved');
});

test('basic-reference fixture (old from-reference-image): image slot + strength', () => {
  const wf = load('test/fixtures/workflows/basic-reference.json');
  const c = detectControls(wf);
  const out = injectParams(wf, c, { prompt: 'x', seed: 1, strength: 0.4, images: { 10: 'pasted (1).png' } });
  assert.equal(out['10'].inputs.image, 'pasted (1).png');
  assert.equal(out['60'].inputs.denoise, 0.4);
  assert.equal(out['58'].inputs.filename_prefix, 'reference', 'no prefix given -> unchanged');
});

test('real klein_ref_s0: all three LoadImage slots and the prompt can be replaced', () => {
  const wf = load('../claude_tests/klein/klein_ref_s0.json');
  const c = detectControls(wf);
  const out = injectParams(wf, c, { prompt: 'new', seed: 5, images: { 10: 'a.png', 20: 'b.png', 30: 'c.png' } });
  assert.deepEqual([out['10'], out['20'], out['30']].map((n) => n.inputs.image), ['a.png', 'b.png', 'c.png']);
  assert.equal(out['40'].inputs.text, 'new');
  assert.equal(out['54'].inputs.noise_seed, 5);
});

test('negative: set when present, empty string allowed; primitive-linked values written at source', () => {
  const sd = load('test/fixtures/sd15-negative.json');
  assert.equal(injectParams(sd, detectControls(sd), { negative: '' })['7'].inputs.text, '');
  assert.equal(injectParams(sd, detectControls(sd), { negative: 'ugly' })['7'].inputs.text, 'ugly');
  const pl = load('test/fixtures/primitive-linked.json');
  const out = injectParams(pl, detectControls(pl), { prompt: 'p', seed: 9 });
  assert.equal(out['1'].inputs.value, 'p');
  assert.equal(out['4'].inputs.value, 9);
  assert.deepEqual(out['2'].inputs.text, ['1', 0]);
});

test('#expose values and "_" keys stripped', () => {
  const wf = { ...load('test/fixtures/tagged-custom.json'), _app: { note: 'x' } };
  const c = detectControls(wf);
  const out = injectParams(wf, c, { expose: { '4.glow': 0.9, '4.mode': 'slow' } });
  assert.equal(out['4'].inputs.glow, 0.9);
  assert.equal(out['4'].inputs.mode, 'slow');
  assert.equal(out._app, undefined);
});

test('aspect sizes keep ~same pixel count, multiples of 16', () => {
  assert.deepEqual(sizeFor('square', 1024, 1024), { width: 1024, height: 1024 });
  const p = sizeFor('portrait', 1024, 1024), l = sizeFor('landscape', 1024, 1024);
  assert.deepEqual(p, { width: 832, height: 1248 });
  assert.deepEqual(l, { width: 1248, height: 832 });
  for (const s of [p, l]) { assert.equal(s.width % 16, 0); assert.ok(Math.abs(s.width * s.height - 1024 * 1024) / (1024 * 1024) < 0.02); }
});

test('batch seeds: locked = base+i, random = distinct, clamped 1..20', () => {
  assert.deepEqual(batchSeeds(3, 'locked', 100), [100, 101, 102]);
  const r = batchSeeds(20, 'random');
  assert.equal(r.length, 20);
  assert.equal(new Set(r).size, 20);
  assert.ok(r.every((x) => Number.isSafeInteger(x) && x >= 0 && x < MAX_SEED));
  assert.equal(batchSeeds(99, 'random').length, 20);
  assert.equal(batchSeeds(0, 'random').length, 1);
});
