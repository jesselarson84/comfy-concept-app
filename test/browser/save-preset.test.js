// Save as preset from the node view: button only in node view, the sheet,
// saving into a section / sub section, Update vs Save as new, rename + move +
// delete from the picker. The mock ComfyUI page has no real canvas, so the
// canvas graph is supplied through nodeView.currentGraph.
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
const klein = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows/ai/klein-4b-t2i.json'), 'utf8')).workflow;

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
const shot = (n) => page.screenshot({ path: path.join(SHOTS, `sp-${n}.png`) });
const canvasGraph = (g) => app((g) => { window.conceptApp.nodeView.currentGraph = async () => JSON.parse(JSON.stringify(g)); }, g);
const saved = () => app(() => window.conceptApp.workflows.filter((w) => w.graph).map((w) => ({ id: w.id, label: w.label, group: w.group, subgroup: w.subgroup || null })));

test('Save preset button shows only in the node view', async () => {
  assert.equal(await page.isVisible('#btn-save-graph'), false);
  await app(() => window.conceptApp.selectPreset('ai:klein-4b-t2i'));
  await page.click('#btn-canvas');
  await page.waitForFunction(() => document.body.classList.contains('node-view-on'));
  assert.equal(await page.isVisible('#btn-save-graph'), true);
  assert.equal(await page.isVisible('#preset-btn'), false);
});

test('saving from a built-in preset makes a new preset in the chosen sub section; the form switches to it', async () => {
  const wf = structuredClone(klein); wf['75:68'].inputs.value = 768;
  await canvasGraph(wf);
  await page.click('#btn-save-graph');
  await page.waitForSelector('.save-preset');
  assert.match(await page.textContent('.save-preset'), /stays as it is/);
  assert.equal(await page.inputValue('.save-preset input'), 'FLUX.2 Klein 4B Text to Image copy');
  assert.equal(await page.inputValue('.save-preset select[aria-label=Section]'), 'Image');
  assert.equal(await page.inputValue('.save-preset select[aria-label="Sub section"]'), 'Text to Image');
  const chips = await page.$$eval('.save-preset .sp-chip', (c) => c.map((x) => x.textContent));
  assert.ok(chips.includes('Prompt') && chips.includes('Aspect') && chips.includes('Seed'), JSON.stringify(chips));
  assert.deepEqual(await page.$$eval('.save-preset .sp-actions button', (b) => b.map((x) => x.dataset.act)), ['cancel', 'save']);
  // switching to Video hides the sub section
  await page.selectOption('.save-preset select[aria-label=Section]', 'Video');
  assert.equal(await page.isVisible('.save-preset select[aria-label="Sub section"]'), false);
  await page.selectOption('.save-preset select[aria-label=Section]', 'Image');
  await page.selectOption('.save-preset select[aria-label="Sub section"]', 'Text to Image');
  await page.fill('.save-preset input', 'Tall poster');
  await shot('sheet');
  await page.click('.save-preset [data-act="save"]');
  await page.waitForSelector('.save-preset', { state: 'detached' });
  await page.waitForFunction(() => window.conceptApp.current?.graph?.name === 'Tall poster');
  const list = await saved();
  assert.equal(list.length, 1); assert.deepEqual([list[0].group, list[0].subgroup], ['Image', 'Text to Image']);
  assert.equal(await app(() => window.conceptApp.nodeView.loadedId), list[0].id, 'canvas not reloaded: it already shows this graph');
  // built-in untouched
  assert.equal(await app(() => window.conceptApp.workflows.find((w) => w.id === 'ai:klein-4b-t2i').workflow['75:68'].inputs.value), 1024);
});

test('picker shows it indented under Image › Text to Image', async () => {
  await page.click('#btn-canvas');
  await page.waitForFunction(() => !document.body.classList.contains('node-view-on'));
  await page.click('#preset-btn');
  const row = await app(() => { const r = [...document.querySelectorAll('#picker .ent')].find((e) => e.textContent.includes('Tall poster')); let p = r.previousElementSibling; while (p && !p.classList.contains('sub')) p = p.previousElementSibling; return { inSub: r.classList.contains('in-sub'), sub: p?.dataset.sub, gear: !!r.querySelector('.edit') }; });
  assert.deepEqual(row, { inSub: true, sub: 'Text to Image', gear: true });
  await shot('picker');
  await page.keyboard.press('Escape');
});

test('from one of your presets: Update overwrites it, Save as new adds another', async () => {
  await page.click('#btn-canvas');
  await page.waitForFunction(() => document.body.classList.contains('node-view-on'));
  const id = (await saved())[0].id;
  const wf = structuredClone(klein); wf['75:68'].inputs.value = 640;
  await canvasGraph(wf);
  await page.click('#btn-save-graph');
  await page.waitForSelector('.save-preset');
  assert.deepEqual(await page.$$eval('.save-preset .sp-actions button', (b) => b.map((x) => x.dataset.act)), ['cancel', 'save-new', 'update']);
  assert.equal(await page.inputValue('.save-preset input'), 'Tall poster');
  await page.click('.save-preset [data-act="update"]');
  await page.waitForSelector('.save-preset', { state: 'detached' });
  await page.waitForFunction((id) => window.conceptApp.workflows.find((w) => w.id === id)?.workflow['75:68'].inputs.value === 640, id);
  assert.equal((await saved()).length, 1, 'updated in place');
  await page.click('#btn-save-graph');
  await page.waitForSelector('.save-preset');
  await page.fill('.save-preset input', 'Wide poster');
  await page.click('.save-preset [data-act="save-new"]');
  await page.waitForSelector('.save-preset', { state: 'detached' });
  await page.waitForFunction(() => window.conceptApp.workflows.filter((w) => w.graph).length === 2);
  await page.click('#btn-canvas');
});

test('picker gear: rename + move to another section, and delete', async () => {
  await page.click('#preset-btn');
  const entSel = (name) => `#picker .ent:has(.nm:text-is("${name}"))`;
  await page.click(`${entSel('Wide poster')} .edit`);
  await page.waitForSelector('#picker .place-row select');
  await page.fill('#picker .ent.editing input', 'Wide poster (video)');
  await page.selectOption('#picker .place-row select', 'Video|');
  await page.click('#picker .ent.editing button:has-text("Save")');
  await page.waitForFunction(() => window.conceptApp.workflows.some((w) => w.graph?.name === 'Wide poster (video)' && w.group === 'Video'));
  // delete (two taps)
  if (await page.isHidden('#picker')) await page.click('#preset-btn');
  await page.click(`${entSel('Wide poster (video)')} .edit`);
  const del = page.locator('#picker .ent.editing button:has-text("Delete")');
  await del.click(); await del.click();
  await page.waitForFunction(() => !window.conceptApp.workflows.some((w) => w.graph?.name === 'Wide poster (video)'));
  assert.equal((await saved()).length, 1);
  await app(() => window.conceptApp.picker.close());
});

test('a graph that saves nothing is refused with a reason; the sheet stays open', async () => {
  await page.click('#btn-canvas');
  await page.waitForFunction(() => document.body.classList.contains('node-view-on'));
  await canvasGraph({ 1: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } } });
  await page.click('#btn-save-graph');
  await page.waitForSelector('.save-preset');
  await page.fill('.save-preset input', 'Broken');
  await page.click('.save-preset .sp-actions .primary');
  await page.waitForFunction(() => /saves nothing/.test(document.getElementById('toast')?.textContent || ''));
  assert.equal(await page.isVisible('.save-preset'), true);
  await page.click('.save-preset [data-act="cancel"]');
  await page.click('#btn-canvas');
});

test('no page errors', () => { assert.deepEqual(errors, []); });
