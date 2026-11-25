// Which preset a client opens on (lib/preset-choice.js), with the REAL preset ids:
// fresh client -> Z-Image Turbo when available (batch 17; FLUX.2 Klein 4B before), else the first
// available AI Workflow entry, never My presets; a returning user's pick persists.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startStack, ROOT } from './helpers.js';
import { defaultPreset, choosePreset, isUsable, isAiWorkflow } from '../../app/js/lib/preset-choice.js';

const models = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/models.json'), 'utf8'));
// ComfyUI without Z-Image Turbo's UNet.
const noZImage = () => {
  const oi = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/object-info.json'), 'utf8'));
  const spec = oi.UNETLoader.input.required.unet_name;
  spec[0] = spec[0].filter((f) => !/z_image_turbo/.test(f));
  return { objectInfo: oi, models: { ...models, diffusion_models: models.diffusion_models.filter((f) => !/z_image_turbo/.test(f)) } };
};
const j = async (r) => { assert.ok(r.ok, `HTTP ${r.status}`); return r.json(); };
const stacks = [];
const stack = async (o) => { const s = await startStack(o); stacks.push(s); return s; };
after(async () => { for (const s of stacks) await s.close(); });

test('real server list (AI presets + My presets): default is ai:z-image-turbo, endpoint says so, chooser agrees', async () => {
  const s = await stack({}); // folder workflows present = My presets entries exist
  const r = await j(await fetch(s.base + '/api/workflows'));
  assert.ok(r.workflows.some((w) => w.group === 'My presets'), 'My presets entries exist in this list');
  assert.equal(r.default, 'ai:z-image-turbo');
  assert.equal(defaultPreset(r.workflows), 'ai:z-image-turbo');
  assert.deepEqual(choosePreset(r.workflows, {}), { id: 'ai:z-image-turbo', source: 'default' });
  assert.deepEqual(choosePreset(r.workflows, { saved: null }), { id: 'ai:z-image-turbo', source: 'default' });
  // My presets listed first must not matter either (order-independent).
  const myFirst = [...r.workflows.filter((w) => !isAiWorkflow(w)), ...r.workflows.filter(isAiWorkflow)];
  assert.equal(defaultPreset(myFirst), 'ai:z-image-turbo');
});

test('Z-Image Turbo missing its model: fresh default = first AVAILABLE AI Workflow entry, never My presets', async () => {
  const s = await stack({ comfyOptions: noZImage() });
  const { workflows, default: def } = await j(await fetch(s.base + '/api/workflows'));
  const z = workflows.find((w) => w.id === 'ai:z-image-turbo');
  assert.equal(z.availability.status, 'unavailable', 'precondition: Z-Image Turbo unavailable');
  assert.ok(isUsable(workflows.find((w) => w.id === 'basic-txt2img')), 'a usable My presets entry exists');
  const expected = workflows.find((w) => isAiWorkflow(w) && isUsable(w)).id;
  assert.equal(def, expected);
  assert.match(def, /^ai:/);
  assert.notEqual(def, 'ai:z-image-turbo');
  assert.ok(!workflows.find((w) => w.id === def).user && !workflows.find((w) => w.id === def).folder);
  // Even with My presets placed first in the list.
  assert.equal(defaultPreset([...workflows.filter((w) => !isAiWorkflow(w)), ...workflows.filter(isAiWorkflow)]), expected);
});

test('no AI entry available: still an AI Workflow entry (Z-Image Turbo, with its reason), never My presets; no AI at all -> null', () => {
  const na = { status: 'unavailable', reason: 'needs download' };
  const list = [
    { id: 'user:abc', ok: true, workflow: {}, group: 'My presets', user: { id: 'abc' } },
    { id: 'basic-txt2img', ok: true, workflow: {}, group: 'My presets', folder: true },
    { id: 'ai:flux1-dev-gguf', ok: true, workflow: {}, availability: na },
    { id: 'ai:z-image-turbo', ok: true, workflow: {}, availability: na },
  ];
  assert.equal(defaultPreset(list), 'ai:z-image-turbo');
  assert.equal(defaultPreset(list.filter((w) => w.id !== 'ai:z-image-turbo')), 'ai:flux1-dev-gguf');
  assert.equal(defaultPreset(list.slice(0, 2)), null);
  assert.equal(defaultPreset([]), null);
  assert.equal(defaultPreset(undefined), null);
  // ComfyUI offline ("unknown") still counts as available.
  assert.equal(defaultPreset([{ id: 'ai:z-image-turbo', ok: true, workflow: {}, availability: { status: 'unknown' } }]), 'ai:z-image-turbo');
});

test('returning user: the last pick persists (even My presets or an unavailable preset); a deleted pick falls back to the default; old ids map', async () => {
  const s = await stack({});
  const { workflows } = await j(await fetch(s.base + '/api/workflows'));
  assert.deepEqual(choosePreset(workflows, { saved: 'basic-txt2img' }), { id: 'basic-txt2img', source: 'saved' });
  assert.deepEqual(choosePreset(workflows, { saved: 'ai:wan22-5b-ti2v' }), { id: 'ai:wan22-5b-ti2v', source: 'saved' });
  assert.deepEqual(choosePreset(workflows, { saved: 'user:deleted' }), { id: 'ai:z-image-turbo', source: 'default' });
  assert.deepEqual(choosePreset(workflows, { saved: 'fast-concept' }), { id: 'ai:klein-4b-t2i', source: 'saved' });
  assert.deepEqual(choosePreset(workflows, { saved: 'from-reference-image' }), { id: 'ai:klein-4b-edit', source: 'saved' });
  assert.deepEqual(choosePreset(workflows, { keep: 'ai:flux1-dev-gguf', saved: 'basic-txt2img' }), { id: 'ai:flux1-dev-gguf', source: 'keep' });
  assert.deepEqual(choosePreset(workflows, { keep: 'gone', saved: 'basic-txt2img' }), { id: 'basic-txt2img', source: 'saved' });
});
