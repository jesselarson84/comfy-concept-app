// AI Workflows in the app: Models | Workflows tabs in the picker, the picker opening
// on the current preset's tab, and workflows with a built-in instruction.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startStack, ROOT } from '../unit/helpers.js';
import { launch } from './launch.js';

const SHOTS = path.join(ROOT, 'test/browser/screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
let s, browser, page;
const errors = [];

before(async () => {
  s = await startStack({ stepMs: 40, folderWorkflows: false });
  browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.goto(s.base + '/');
  await page.waitForFunction(() => (window.conceptApp?.workflows?.length || 0) > 10 && window.conceptApp.current);
});
after(async () => { await browser?.close(); await s?.close(); });

const app = (fn, a) => page.evaluate(fn, a);
const shot = (n) => page.screenshot({ path: path.join(SHOTS, `aiw-${n}.png`) });
const sections = () => page.$$eval('#picker .grp', (g) => g.map((x) => x.dataset.section));
const tab = () => page.$eval('#picker .picker-tab[aria-selected="true"]', (b) => b.dataset.tab);

test('picker: Models tab by default with the model sections; Workflows tab lists Textures / Concept / VFX / 3D Assets / Sound; search + hints (batch 8)', async () => {
  await app(() => window.conceptApp.selectPreset('ai:z-image-turbo'));
  await page.click('#preset-btn');
  await page.waitForSelector('#picker .picker-tab');
  assert.deepEqual(await page.$$eval('#picker .picker-tab', (b) => b.map((x) => x.childNodes[0].textContent)), ['Models', 'Workflows']);
  assert.equal(await tab(), 'model');
  assert.deepEqual(await sections(), ['3D', 'Image', 'Video', 'Audio']);
  await shot('models');
  await page.click('#picker .picker-tab[data-tab="workflow"]');
  assert.equal(await tab(), 'workflow');
  assert.deepEqual(await sections(), ['Textures', 'Concept', 'VFX', '3D Assets', 'Sound']);
  const rows = await page.$$eval('#picker .ent .nm', (n) => n.map((x) => x.textContent));
  assert.deepEqual(rows, ['Photo to Texture', 'Upscale Texture', 'Remove Lighting', 'Make Seamless', 'Grunge Map', 'PBR Maps', 'PBR Maps (CHORD)', 'Depth + Normal', 'Concept Looks (Edges)', 'Concept Looks (Depth)', 'Flipbook Sheet', 'Photo to 3D Model', 'Voice Line in Any Voice', 'Voice Line with Sound', 'Sound Effect Set']);
  assert.equal(await page.$eval('#picker .picker-tab[data-tab="workflow"] .cnt', (c) => c.textContent), '15');
  await shot('workflows');
  // tabs stay put while the list scrolls
  assert.equal(await page.$eval('#picker .picker-tabs', (t) => getComputedStyle(t).position), 'sticky');
  // batch 8: search covers both tabs and hides them; rows carry a short hint
  await page.fill('#picker .picker-search', 'voice');
  assert.equal(await page.locator('#picker .picker-tabs').count(), 0);
  const found = await page.$$eval('#picker .ent[data-preset] .nm', (n) => n.map((x) => x.textContent));
  assert.ok(found.includes('Chatterbox Voice Swap') && found.includes('Voice Line in Any Voice'), found.join());
  assert.equal(await page.$eval('#picker .ent:has(.nm:text-is("Voice Line in Any Voice")) .hint', (x) => x.textContent), 'Needs a recording');
  await page.fill('#picker .picker-search', '');
  assert.equal(await page.locator('#picker .picker-tabs').count(), 1);
});

test('picking a workflow: crumb shows its section; the picker reopens on the Workflows tab', async () => {
  await page.click('#picker .ent:has(.nm:text-is("Remove Lighting"))');
  await page.waitForFunction(() => window.conceptApp.current?.id === 'ai:wf-remove-lighting');
  assert.match(await page.textContent('#preset-crumb'), /Textures/);
  await page.click('#preset-btn');
  assert.equal(await tab(), 'workflow');
  assert.equal(await page.$eval('#picker .ent.on .nm', (n) => n.textContent), 'Remove Lighting');
  await page.keyboard.press('Escape');
});

test('built-in instruction: shown as the placeholder; an empty prompt is allowed (asks for the picture instead)', async () => {
  assert.match(await page.getAttribute('#prompt', 'placeholder'), /^Remove all shadows.*\(or type your own\)$/);
  await page.fill('#prompt', '');
  await page.click('#btn-generate');
  await page.waitForFunction(() => /picture/i.test(document.getElementById('toast')?.textContent || ''));
  assert.doesNotMatch(await page.textContent('#toast'), /Type a prompt/);
  // a model preset without one still needs a prompt
  await app(() => window.conceptApp.selectPreset('ai:z-image-turbo'));
  assert.equal(await page.getAttribute('#prompt', 'placeholder'), 'Describe the concept…');
  await page.click('#btn-generate');
  await page.waitForFunction(() => /Type a prompt/.test(document.getElementById('toast')?.textContent || ''));
});

test('Grunge Map: the 1K / 2K / 4K picker applies (square base); input-driven workflows have no size controls', async () => {
  await app(() => window.conceptApp.selectPreset('ai:wf-grunge-map'));
  assert.equal(await page.isVisible('#aspect-res'), true);
  await app(() => window.conceptApp.selectPreset('ai:wf-make-seamless'));
  assert.equal(await page.isVisible('#aspect-res'), false);
  assert.equal(await page.isVisible('#aspect-btn'), false);
  await app(() => window.conceptApp.selectPreset('ai:z-image-turbo'));
});

test('no page errors', () => { assert.deepEqual(errors, []); });
