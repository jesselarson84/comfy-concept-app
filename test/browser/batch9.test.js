// Batch 9 in the app: History search, filter chips + sheet, the stats strip,
// times on items, tags under a picture in the viewer (a tap searches History).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startStack, ROOT, pngBytes } from '../unit/helpers.js';
import { launch } from './launch.js';

const SHOTS = path.join(ROOT, 'test/browser/screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
let s, browser, page;
const errors = [];
const img = (f) => ({ filename: f, subfolder: 'concept-app', type: 'output' });

before(async () => {
  s = await startStack({ stepMs: 40, folderWorkflows: false });
  const h = s.app.history;
  const day = (d, hr) => new Date(2026, 10, d, hr, 5).getTime();
  const today = new Date(); today.setHours(9, 41, 0, 0);
  for (const f of ['n1.png', 'n2.png', 'barn.png']) s.mock.files.set(`output/concept-app/${f}`, pngBytes());
  const a = await h.add({ workflow: 'ai:klein-4b-t2i', prompt: 'a night market in the rain', images: [img('n1.png')], createdAt: today.getTime() });
  const b = await h.add({ workflow: 'ai:z-image-turbo', prompt: 'a red barn', images: [img('barn.png')], createdAt: day(21, 22) });
  await h.add({ workflow: 'ai:hunyuan3d-21', prompt: '', images: [], files: [{ ...img('m.glb'), kind: '3d' }], status: 'done', createdAt: day(21, 20) });
  await h.setTags(a.id, { genre: ['sci-fi'], mood: ['moody'], palette: ['neon'], colors: ['blue', 'pink'], setting: ['city-street'], lighting: ['neon-lit'], medium: ['3d-render'] });
  await h.setTags(b.id, { genre: ['rural'], mood: ['calm'], palette: ['warm-earth-tones'], colors: ['red'], setting: ['farm'], lighting: ['golden-hour'], medium: ['photograph'] });
  browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.goto(s.base + '/');
  await page.waitForFunction(() => (window.conceptApp?.workflows?.length || 0) > 10 && window.conceptApp.current);
});
after(async () => { await browser?.close(); await s?.close(); });

const tiles = () => page.$$eval('.history .thumb[data-id]', (t) => t.length);

test('History: search box, filter chips, stats strip, times on items', async () => {
  await page.click('#btn-history');
  await page.waitForSelector('.history .thumb[data-id]');
  assert.equal(await page.isVisible('.history .hsearch'), true);
  assert.deepEqual(await page.$$eval('.hfilters .hchip', (c) => c.map((x) => x.dataset.act)), ['type', 'model', 'date', 'tags']);
  assert.equal(await tiles(), 3);
  assert.equal(await page.textContent('.history .thumb:not(.is-file) .thumb-time'), '9:41 AM');
  // stats strip: totals; tap opens it (top models, tags, tagging line + switch)
  assert.match(await page.textContent('.hstats'), /3outputs.*this month/);
  await page.click('.hstats');
  await page.waitForSelector('.hstats.open .hbar');
  assert.ok((await page.$$eval('.hstats .htag', (t) => t.map((x) => x.dataset.tag))).includes('neon'));
  assert.equal(await page.isVisible('.hstats .hswitch'), true);
  await page.screenshot({ path: path.join(SHOTS, 'b9-history-stats.png') });
  await page.click('.hstats .hstats-ch');
  assert.equal(await page.isVisible('.hstats.open'), false);
});

test('search: tags and colours match ("neon blue"), the result count shows, Clear brings everything back', async () => {
  await page.fill('.history .hsearch', 'neon blue');
  await page.waitForFunction(() => document.querySelectorAll('.history .thumb[data-id]').length === 1);
  assert.match(await page.textContent('.hresults'), /^1 result/);
  await page.fill('.history .hsearch', 'barn');
  await page.waitForFunction(() => document.querySelectorAll('.history .thumb[data-id]').length === 1);
  await page.click('.hresults .link');
  assert.equal(await tiles(), 3);
  assert.equal(await page.inputValue('.history .hsearch'), '');
});

test('filter sheet: opens at the tapped chip; Type 3D + Show; the chip shows it and ✕ removes it', async () => {
  await page.click('.hfilters .hchip[data-act="type"]');
  await page.waitForSelector('.filter-sheet');
  await page.click('.filter-sheet [data-type="3d"]');
  assert.match(await page.textContent('.filter-sheet [data-act="show"]'), /Show 1/);
  await page.screenshot({ path: path.join(SHOTS, 'b9-filter-sheet.png') });
  await page.click('.filter-sheet [data-act="show"]');
  await page.waitForFunction(() => document.querySelectorAll('.history .thumb[data-id]').length === 1);
  assert.match(await page.textContent('.hchip.on'), /3D/);
  await page.click('.hchip.on .x');
  await page.waitForFunction(() => document.querySelectorAll('.history .thumb[data-id]').length === 3);
  // Date: Today
  await page.click('.hfilters .hchip[data-act="date"]');
  await page.click('.filter-sheet [data-date="today"]');
  await page.click('.filter-sheet [data-act="show"]');
  await page.waitForFunction(() => document.querySelectorAll('.history .thumb[data-id]').length === 1);
  await page.click('.hresults .link');
});

test('viewer: the picture\'s tags under the prompt; tapping one searches History for it', async () => {
  await page.click('.history .thumb[data-id]:not(.is-file)');
  await page.waitForSelector('.viewer:not([hidden]) .viewer-tags .vtag');
  const tags = await page.$$eval('.viewer-tags .vtag', (b) => b.map((x) => x.textContent));
  assert.ok(tags.includes('neon-lit') && tags.includes('blue'), tags.join());
  await page.screenshot({ path: path.join(SHOTS, 'b9-viewer-tags.png') });
  await page.click('.viewer-tags .vtag[data-tag="neon-lit"]');
  await page.waitForSelector('.viewer', { state: 'hidden' });
  await page.waitForFunction(() => document.querySelectorAll('.history .thumb[data-id]').length === 1);
  assert.match(await page.textContent('.hchip.on'), /neon-lit/);
});

test('no page errors in the batch 9 run', () => {
  assert.deepEqual(errors, []);
});
