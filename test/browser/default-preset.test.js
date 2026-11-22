// Fresh-client default in the real app (headless Chromium, new context = no
// localStorage, cookies or service worker), with the real preset ids.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startStack, ROOT } from '../unit/helpers.js';
import { launch } from './launch.js';

const models = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/models.json'), 'utf8'));
// ComfyUI without the Klein 4B base UNet (what FLUX.2 Klein 4B Text to Image loads).
const noKleinBase = () => {
  const oi = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/object-info.json'), 'utf8'));
  const spec = oi.UNETLoader.input.required.unet_name;
  spec[0] = spec[0].filter((f) => !/klein-base/.test(f));
  return { objectInfo: oi, models: { ...models, diffusion_models: models.diffusion_models.filter((f) => !/klein-base/.test(f)) } };
};
let browser, ctx;
const stacks = [];
const errors = [];
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); for (const s of stacks) await s.close(); });

async function freshPage(s, { keepStorage = false } = {}) {
  // One context (single-process headless Chromium); storage is wiped per page unless keepStorage.
  ctx ||= await browser.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  if (!keepStorage) await page.addInitScript(() => { if (!sessionStorage.getItem('wiped')) { localStorage.clear(); sessionStorage.setItem('wiped', '1'); } });
  await page.goto(s.base + '/');
  await page.waitForFunction(() => window.conceptApp?.current);
  return page;
}
const cur = (p) => p.evaluate(() => window.conceptApp.current.id);

test('fresh client with My presets present opens on FLUX.2 Klein 4B Text to Image and remembers nothing; a pick persists across reloads', async () => {
  const s = await startStack({ stepMs: 20 }); stacks.push(s); // basic-txt2img / basic-reference under My presets
  const p = await freshPage(s);
  try {
    assert.ok(await p.evaluate(() => window.conceptApp.workflows.some((w) => w.group === 'My presets')));
    assert.equal(await p.evaluate(() => localStorage.length), 0, 'clean state');
    assert.equal(await p.evaluate(() => !!navigator.serviceWorker?.controller), false);
    assert.equal(await cur(p), 'ai:klein-4b-t2i');
    assert.equal((await p.textContent('#preset-crumb')).trim(), 'Image › Text to Image ›');
    assert.equal(await p.evaluate(() => localStorage.getItem('preset')), null);
    // Returning user: pick a My presets entry, reload -> still there.
    await p.click('#preset-btn'); await p.click('#picker .ent[data-preset="basic-txt2img"]');
    await p.waitForFunction(() => window.conceptApp.current?.id === 'basic-txt2img');
    assert.equal(await p.evaluate(() => localStorage.getItem('preset')), 'basic-txt2img');
    await p.reload(); await p.waitForFunction(() => window.conceptApp?.current);
    assert.equal(await cur(p), 'basic-txt2img', 'last-used selection persists');
  } finally { await p.close(); }
});

test('Klein 4B T2I unavailable: a fresh client lands on the first available AI Workflow entry, not My presets', async () => {
  const s = await startStack({ stepMs: 20, comfyOptions: noKleinBase() });
  stacks.push(s);
  const { default: def } = await (await fetch(s.base + '/api/workflows')).json();
  const p = await freshPage(s);
  try {
    const id = await cur(p);
    assert.equal(id, def);
    assert.match(id, /^ai:/);
    assert.notEqual(id, 'ai:klein-4b-t2i');
    assert.equal(await p.evaluate((x) => { const w = window.conceptApp.workflows.find((y) => y.id === x); return w.availability?.status !== 'unavailable' && !w.user && !w.folder; }, id), true);
    assert.equal(await p.evaluate(() => localStorage.getItem('preset')), null, 'the fallback is not remembered, so Klein wins again once it is back');
  } finally { await p.close(); }
});

test('no page errors', () => { assert.deepEqual(errors, []); });
