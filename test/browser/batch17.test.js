// Batch 17 browser tests (phone size): the preset button reads the model name in
// full with "Text to Image" under it (beside it on a tablet); No project shows the
// circle; the prompt box sizes itself (no drag handle) and the + never covers its
// text; the prompt ⋮ (Expand, Clear with Undo); "+ Negative prompt" / its ⋮
// (Clear, Remove); the Run button says "1 of 4" on one line; Z-Image Turbo is the
// default; Reset to defaults when the app closes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startStack, ROOT } from '../unit/helpers.js';
import { launch } from './launch.js';

const SHOTS = path.join(ROOT, 'test/browser/screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
let s, browser, ctx, page;
const errors = [];
const LONG = 'A weathered scout mech crouched in a foggy pine forest at dawn, moss on the armor plates, heavy rain, sodium light, cinematic, anamorphic flare, wet reflections, steam rising, low angle shot, highly detailed, 35mm film grain, shallow depth of field, dramatic clouds, rusty bolts, chipped paint, glowing visor';

before(async () => {
  s = await startStack({ stepMs: 40, folderWorkflows: false });
  browser = await launch();
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.goto(s.base + '/');
  await page.waitForFunction(() => (window.conceptApp?.workflows?.length || 0) > 10 && window.conceptApp.current);
});
after(async () => { await browser?.close(); await s?.close(); });

const app = (fn, arg) => page.evaluate(fn, arg);
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `b17-${name}.png`) });
async function pick(id) { await page.click('#preset-btn'); await page.click(`#picker .ent[data-preset="${id}"]`); await page.waitForFunction((x) => window.conceptApp.current?.id === x, id); }
const lines = (sel) => app((q) => { const t = document.querySelector(q), cs = getComputedStyle(t); return Math.round((t.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) / parseFloat(cs.lineHeight)); }, sel);

test('a fresh client opens on Z-Image Turbo; the preset button: the name in full, "Text to Image" under it', async () => {
  assert.equal(await app(() => window.conceptApp.current.id), 'ai:z-image-turbo');
  assert.equal(await page.textContent('#preset-name'), 'Z-Image Turbo');
  assert.equal(await page.textContent('#preset-crumb'), 'Text to Image');
  await pick('ai:qwen-edit-2511');
  const geo = await app(() => {
    const n = document.querySelector('#preset-name'), c = document.querySelector('#preset-crumb');
    return { nameCut: n.scrollWidth > n.clientWidth + 1, below: c.getBoundingClientRect().top >= n.getBoundingClientRect().bottom - 1 };
  });
  assert.deepEqual(geo, { nameCut: false, below: true });
  assert.equal(await page.textContent('#preset-crumb'), 'Image Edit');
  await shot('preset-button');
});

test('tablet: the grey line sits beside the name, on one line', async () => {
  await page.setViewportSize({ width: 900, height: 1100 });
  const g = await app(() => { const n = document.querySelector('#preset-name').getBoundingClientRect(), c = document.querySelector('#preset-crumb').getBoundingClientRect(); return { sameLine: Math.abs(n.top - c.top) < 8, after: c.left > n.right }; });
  assert.deepEqual(g, { sameLine: true, after: true });
  await page.setViewportSize({ width: 390, height: 844 });
});

test('No project shows the empty circle (the clipboard is for real projects)', async () => {
  await page.waitForSelector('.project-chip');
  assert.match(await page.getAttribute('.project-chip > i.i', 'class'), /\bi-circle\b/);
});

test('the prompt box sizes itself: 3 lines empty, up to 6 on a phone, then it scrolls; no drag handle; the + never covers the text', async () => {
  await pick('ai:klein-4b-edit'); // takes a picture: the + shows
  await page.fill('#prompt', '');
  await page.locator('#prompt').dispatchEvent('input');
  assert.equal(await lines('#prompt'), 3);
  assert.equal(await app(() => getComputedStyle(document.querySelector('#prompt')).resize), 'none');
  await page.fill('#prompt', LONG);
  await page.locator('#prompt').dispatchEvent('input');
  assert.equal(await lines('#prompt'), 6);
  assert.equal(await app(() => getComputedStyle(document.querySelector('#prompt')).overflowY), 'auto', 'longer text scrolls inside');
  const g = await app(() => { const t = document.querySelector('#prompt').getBoundingClientRect(), p = document.querySelector('#btn-attach').getBoundingClientRect(); return { plusBelowText: p.top >= t.bottom - 1 }; });
  assert.deepEqual(g, { plusBelowText: true });
  await shot('prompt-sized');
});

test('prompt ⋮: Expand opens the prompt full screen (Done goes back); Clear prompt shows Undo', async () => {
  await page.click('#prompt-more');
  assert.deepEqual(await page.$$eval('.amenu .amenu-row', (b) => b.map((x) => x.dataset.act)), ['expand', 'clear-prompt'], 'Claude is off: no Write / Talk prompt');
  await page.click('.amenu [data-act="expand"]');
  await page.waitForSelector('.prompt-editor:not([hidden])');
  assert.equal(await page.inputValue('.pe-text'), LONG);
  await page.fill('.pe-text', `${LONG} edited`);
  await page.click('.prompt-editor [data-act="done"]');
  await page.waitForSelector('.prompt-editor', { state: 'hidden' });
  assert.equal(await page.inputValue('#prompt'), `${LONG} edited`);
  await page.click('#prompt-more');
  await page.click('.amenu [data-act="clear-prompt"]');
  assert.equal(await page.inputValue('#prompt'), '');
  assert.match(await page.textContent('.undo-toast'), /Prompt cleared/);
  await page.click('.undo-toast [data-act="undo-clear"]');
  assert.equal(await page.inputValue('#prompt'), `${LONG} edited`);
  await page.click('#prompt-more');
  assert.equal(await page.locator('.amenu [data-act="clear-prompt"]').count(), 1);
  await page.keyboard.press('Escape');
});

test('Negative prompt: off = "+ Negative prompt"; on = the same look as Prompt; its ⋮ clears and removes', async () => {
  await pick('ai:qwen-2512-t2i');
  if (await page.isVisible('#neg-row')) { await page.click('#neg-more'); await page.click('.amenu [data-act="remove-negative"]'); }
  assert.equal(await page.isVisible('#neg-add'), true);
  assert.equal(await page.isVisible('#neg-row'), false);
  await page.click('#neg-add');
  assert.equal(await page.isVisible('#neg-row'), true);
  assert.equal(await page.isVisible('#neg-add'), false);
  assert.equal(await app(() => document.activeElement?.id), 'negative');
  const look = await app(() => { const a = getComputedStyle(document.querySelector('.prompt-field .label > span')), b = getComputedStyle(document.querySelector('#neg-row .label > span')); return [a.fontSize === b.fontSize, a.color === b.color, a.fontWeight === b.fontWeight]; });
  assert.deepEqual(look, [true, true, true], 'same title style as Prompt');
  const gap = await app(() => document.querySelector('#negative').getBoundingClientRect().top - document.querySelector('#neg-row .label').getBoundingClientRect().bottom);
  assert.ok(gap <= 8, `box right under its title (${gap}px)`);
  await page.fill('#negative', 'blurry, cartoon');
  await page.locator('#negative').dispatchEvent('input');
  await shot('negative-on');
  await page.click('#neg-more');
  await page.click('.amenu [data-act="clear-negative"]');
  assert.equal(await page.inputValue('#negative'), '');
  await page.click('.undo-toast [data-act="undo-clear"]');
  assert.equal(await page.inputValue('#negative'), 'blurry, cartoon');
  await page.click('#neg-more');
  await page.click('.amenu [data-act="remove-negative"]');
  assert.equal(await page.isVisible('#neg-row'), false);
  assert.equal(await page.isVisible('#neg-add'), true);
  assert.equal(await app(() => window.conceptApp.panel.values().negative), '', 'off = not sent');
});

test('while a run is going the Run button says "1 of 4", on one line', async () => {
  await pick('ai:z-image-turbo');
  await page.fill('#prompt', 'a red fox in snow');
  await page.fill('#batch', '4'); await page.locator('#batch').dispatchEvent('change');
  await page.click('#btn-generate');
  await page.waitForFunction(() => /^\d of 4$/.test(document.querySelector('#run-label').textContent));
  const h = await app(() => { const l = document.querySelector('#run-label'); return { lines: Math.round(l.getBoundingClientRect().height / parseFloat(getComputedStyle(l).lineHeight)) }; });
  assert.equal(h.lines, 1);
  await page.waitForFunction(() => !window.conceptApp.lock.locked(), null, { timeout: 20000 });
  assert.equal(await page.textContent('#run-label'), 'Run');
});

test('Reset to defaults when the app closes: off keeps the form; on starts a fresh open over (a reload keeps it)', async () => {
  await pick('ai:qwen-2512-t2i');
  await page.fill('#prompt', 'keep me');
  await page.locator('#prompt').dispatchEvent('input');
  // off (default): closing and reopening keeps everything
  let p2 = await ctx.newPage();
  await p2.goto(s.base + '/'); await p2.waitForFunction(() => window.conceptApp?.current);
  assert.equal(await p2.inputValue('#prompt'), 'keep me');
  assert.equal(await p2.evaluate(() => window.conceptApp.current.id), 'ai:qwen-2512-t2i');
  await p2.close();
  // on: switch in Settings
  await page.click('#btn-settings');
  await page.waitForSelector('.settings-sheet');
  await page.check('#st-reset');
  await page.click('.settings-sheet [data-act="close"]');
  // a reload is not closing the app: kept
  await page.reload(); await page.waitForFunction(() => window.conceptApp?.current);
  assert.equal(await page.inputValue('#prompt'), 'keep me');
  // a fresh open (new tab = the app was closed): back to the defaults on Z-Image Turbo
  p2 = await ctx.newPage();
  await p2.goto(s.base + '/'); await p2.waitForFunction(() => window.conceptApp?.current);
  assert.equal(await p2.inputValue('#prompt'), '');
  assert.equal(await p2.evaluate(() => window.conceptApp.current.id), 'ai:z-image-turbo');
  assert.equal(await p2.evaluate(() => window.conceptApp.panel.state.batch), 4);
  await p2.close();
  await page.evaluate(() => localStorage.setItem('conceptResetOnClose', '0'));
});

test('no page errors in the batch 17 run', () => { assert.deepEqual(errors, []); });
