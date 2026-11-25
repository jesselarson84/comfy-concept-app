// Batch 10 in the app: the full-screen viewer redesign. Top bar = ✕, count, ⋮;
// the picture sits between the top bar and the info (prompt, date · model,
// tags); thumbnails at the very bottom. ⋮ = Favorite / Keep & send (Save…,
// Share) / Make more (Use as reference, Reuse settings) / Delete; no Discuss.
// Details sheet (Back closes it first). One Save: the Drive sheet with "Save to
// this phone instead". No times on History tiles. 3D / video / audio: ⋮ too.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStack, ROOT, pngBytes } from '../unit/helpers.js';
import { launch, menuAct, toggleFiles } from './launch.js';

const SHOTS = path.join(ROOT, 'test/browser/screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
let s, browser, page;
const errors = [];
const img = (f) => ({ filename: f, subfolder: 'concept-app', type: 'output' });
let ids = {};

before(async () => {
  // a real output folder: Delete removes the file from the PC (refused when it is not there)
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-out10-'));
  fs.mkdirSync(path.join(outDir, 'concept-app'), { recursive: true });
  for (const f of ['n1.png', 'n2.png', 'n3.png']) fs.writeFileSync(path.join(outDir, 'concept-app', f), pngBytes());
  s = await startStack({ stepMs: 40, folderWorkflows: false, outputDir: outDir });
  const h = s.app.history;
  const today = new Date(); today.setHours(9, 41, 0, 0);
  for (const f of ['n1.png', 'n2.png', 'n3.png']) s.mock.files.set(`output/concept-app/${f}`, pngBytes());
  s.mock.files.set('output/concept-app/m.glb', Buffer.from('glTF'));
  const a = await h.add({ workflow: 'ai:z-image-turbo', prompt: 'Modern rocketship, sleek, tall, slender and thin. White panels with dark grey underbelly. Central tube with detailed twin boosters on either side. Grey background. Realistic render.', seed: 186231708981333, width: 1024, height: 1024, steps: 8, images: [img('n1.png')], createdAt: today.getTime() });
  const b = await h.add({ workflow: 'ai:klein-4b-t2i', prompt: 'a red barn', seed: 7, width: 1024, height: 768, images: [img('n2.png')], createdAt: today.getTime() - 60e3 });
  const c = await h.add({ workflow: 'ai:klein-4b-t2i', prompt: 'a blue door', seed: 8, images: [img('n3.png')], createdAt: today.getTime() - 120e3 });
  await h.add({ workflow: 'ai:hunyuan3d-21', prompt: '', images: [], files: [{ ...img('m.glb'), kind: '3d' }], status: 'done', createdAt: today.getTime() - 180e3 });
  await h.setTags(a.id, { genre: ['space', 'rocket'], mood: ['serious'], palette: ['metallic'], colors: ['silver', 'white'], setting: ['studio'], lighting: ['studio'], medium: ['3d-render'] });
  ids = { a: a.id, b: b.id, c: c.id };
  browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, acceptDownloads: true });
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.goto(s.base + '/');
  await page.waitForFunction(() => (window.conceptApp?.workflows?.length || 0) > 10 && window.conceptApp.current);
});
after(async () => { await browser?.close(); await s?.close(); });

const openFirst = async () => {
  if (!(await page.isVisible('.history'))) await toggleFiles(page);
  await page.waitForSelector('.history .thumb[data-id]');
  await page.click(`.history .thumb[data-id="${ids.a}"]`);
  await page.waitForSelector('.viewer:not([hidden]) .viewer-img');
  await page.waitForFunction(() => document.querySelector('.viewer-img')?.naturalWidth > 0);
};

test('History tiles have no times; the full-screen view: ✕ count ⋮ on top, picture, prompt + date · model + tags, thumbnails at the bottom', async () => {
  await toggleFiles(page);
  await page.waitForSelector('.history .thumb[data-id]');
  assert.equal(await page.$('.history .thumb-time'), null);
  await openFirst();
  assert.deepEqual(await page.$$eval('.viewer-top button', (b) => b.map((x) => x.dataset.act)), ['close', 'more']);
  assert.equal(await page.$('.viewer-actions'), null, 'no big button grid');
  assert.match(await page.textContent('.viewer-counter'), /^1 \/ 3/);
  assert.match(await page.textContent('.viewer-when'), /· 9:41 AM · Z-Image Turbo$/);
  assert.match(await page.textContent('.viewer-caption'), /^Modern rocketship/);
  // two lines at most
  const cap = await page.$eval('.viewer-caption', (e) => ({ h: e.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(e).lineHeight) }));
  assert.ok(cap.h <= cap.lh * 2 + 1, JSON.stringify(cap));
  assert.ok((await page.$$eval('.viewer-info .vtag', (t) => t.map((x) => x.textContent))).includes('rocket'));
  // nothing over the picture: top bar above it, info + strip below it, strip last
  const r = await page.evaluate(() => Object.fromEntries(['.viewer-top', '.viewer-stage', '.viewer-info', '.viewer-strip'].map((s) => { const b = document.querySelector(s).getBoundingClientRect(); return [s, { top: Math.round(b.top), bottom: Math.round(b.bottom) }]; })));
  assert.ok(r['.viewer-top'].bottom <= r['.viewer-stage'].top, JSON.stringify(r));
  assert.ok(r['.viewer-stage'].bottom <= r['.viewer-info'].top, JSON.stringify(r));
  assert.ok(r['.viewer-info'].bottom <= r['.viewer-strip'].top, JSON.stringify(r));
  assert.ok(r['.viewer-strip'].bottom <= 860 && r['.viewer-strip'].bottom > 800, 'strip at the bottom');
  await page.screenshot({ path: path.join(SHOTS, 'b10-viewer.png') });
});

test('⋮ menu: Favorite / Keep & send (Save…, Share) / Make more (Use as reference, Reuse settings) / Delete - no Discuss', async () => {
  await page.click('.viewer [data-act="more"]');
  await page.waitForSelector('.amenu');
  assert.deepEqual(await page.$$eval('.amenu .amenu-row', (r) => r.map((x) => x.dataset.act)), ['favorite', 'save', 'share', 'reference', 'reuse', 'delete']);
  assert.deepEqual(await page.$$eval('.amenu .amenu-title', (r) => r.map((x) => x.textContent)), ['Keep & send', 'Make more']);
  assert.equal(await page.$$eval('.amenu .amenu-sep', (r) => r.length), 3);
  assert.equal(await page.isVisible('.amenu [data-act="save"] .drive-logo'), true, 'Drive logo on Save');
  assert.match(await page.textContent('.amenu [data-act="delete"]'), /Delete/);
  assert.ok(await page.$eval('.amenu [data-act="delete"]', (e) => e.classList.contains('danger')));
  assert.doesNotMatch(await page.textContent('.amenu'), /Discuss/);
  // the menu stays on screen under ⋮
  const m = await page.$eval('.amenu', (e) => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top }; });
  assert.ok(m.l >= 0 && m.r <= 412 && m.t > 30, JSON.stringify(m));
  await page.screenshot({ path: path.join(SHOTS, 'b10-menu.png') });
  // tap outside closes it
  await page.click('.amenu-scrim', { position: { x: 20, y: 600 } });
  await page.waitForSelector('.amenu', { state: 'detached' });
  assert.equal(await page.isVisible('.viewer'), true);
});

test('Favorite from the menu: a star by the count, saved on the PC; tapping again removes it', async () => {
  await menuAct(page, '.viewer', 'favorite');
  await page.waitForSelector('.viewer-fav:not([hidden])');
  await page.waitForFunction(async (id) => (await (await fetch('/api/history?favorites=1')).json()).sessions.flatMap((x) => x.entries).some((e) => e.id === id), ids.a);
  await page.click('.viewer [data-act="more"]');
  assert.match(await page.textContent('.amenu [data-act="favorite"]'), /Remove from favorites/);
  await page.click('.amenu [data-act="favorite"]');
  await page.waitForSelector('.viewer-fav', { state: 'hidden' });
});

test('Details: full prompt + Copy, Made / Model / Size / Seed / Steps / File, all tags; Back closes the sheet first, then the viewer (History stays)', async () => {
  await page.click('.viewer [data-act="details"]');
  await page.waitForSelector('.viewer-details');
  assert.match(await page.textContent('.vd-prompt'), /Realistic render\.$/);
  const grid = await page.$$eval('.vd-grid span', (s) => s.map((x) => x.textContent));
  const kv = Object.fromEntries(grid.reduce((a, v, i) => (i % 2 ? a[a.length - 1].push(v) : a.push([v]), a), []));
  assert.match(kv.Made, /, \d{4} · 9:41 AM$/);
  assert.equal(kv.Model, 'Z-Image Turbo');
  assert.equal(kv.Size, '1024 × 1024');
  assert.equal(kv.Seed, '186231708981333');
  assert.equal(kv.Steps, '8');
  assert.equal(kv.File, 'n1.png');
  assert.ok((await page.$$eval('.vd-tags .vtag', (t) => t.map((x) => x.textContent))).includes('3d-render'));
  assert.equal(await page.isVisible('.vd-copy'), true);
  assert.doesNotMatch(await page.textContent('.viewer-details'), /null|undefined/);
  await page.screenshot({ path: path.join(SHOTS, 'b10-details.png') });
  await page.goBack();
  await page.waitForSelector('.viewer-details', { state: 'detached' });
  assert.equal(await page.isVisible('.viewer'), true, 'Back closed only the details');
  assert.equal(await page.isVisible('.history'), true);
  // tapping the prompt opens it too; a tap on the dimmed area closes it
  await page.click('.viewer-caption');
  await page.waitForSelector('.viewer-details');
  await page.click('.vd-scrim', { position: { x: 20, y: 100 } });
  await page.waitForSelector('.viewer-details', { state: 'detached' });
  assert.equal(await page.isVisible('.viewer'), true);
  await page.goBack();
  await page.waitForSelector('.viewer', { state: 'hidden' });
  assert.equal(await page.isVisible('.history'), true, 'History is still open under the viewer');
});

test('one Save: ⋮ Save… opens the Drive sheet (Drive logo) with "Save to this phone instead" -> a download; Save here -> Drive', async () => {
  await openFirst();
  await menuAct(page, '.viewer', 'save');
  await page.waitForSelector('.drive-sheet .df-crumbs');
  assert.equal(await page.isVisible('.drive-sheet .sheet-title .drive-logo'), true);
  assert.match(await page.textContent('.drive-sheet [data-act="phone"]'), /Save to this phone instead/);
  await page.screenshot({ path: path.join(SHOTS, 'b10-save-sheet.png') });
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.click('.drive-sheet [data-act="phone"]')]);
  assert.equal(dl.suggestedFilename(), 'n1.png');
  assert.equal(await page.$('.drive-sheet'), null);
  await menuAct(page, '.viewer', 'save');
  await page.click('.drive-sheet [data-act="save-here"]');
  await page.waitForFunction(() => /Saved to Drive: Comfy UI\/Images\/n1\.png/.test(document.querySelector('#toast')?.textContent || ''));
});

test('Delete from the menu (after a confirm): the next picture shows', async () => {
  await page.click('.viewer-strip .viewer-strip-item >> nth=2');
  await page.waitForFunction(() => /^3 \/ 3/.test(document.querySelector('.viewer-counter').textContent));
  await menuAct(page, '.viewer', 'delete');
  await page.click('.confirm [data-act="confirm"]');
  await page.waitForFunction(() => /^2 \/ 2/.test(document.querySelector('.viewer-counter').textContent), null, { timeout: 8000 }).catch(async (e) => { throw new Error(`${e.message} - toast: ${await page.textContent('#toast')}`); });
  assert.equal(s.app.history.get(ids.c), null);
  await page.goBack();
  await page.waitForSelector('.viewer', { state: 'hidden' });
});

test('3D viewer: ✕ title … ⋮ on top; ⋮ = Save… and Share only; no Download / Save to Drive buttons', async () => {
  await page.click('.history .thumb.is-file');
  await page.waitForSelector('.model-viewer:not([hidden])');
  assert.equal(await page.$('.model-viewer .ov-actions'), null);
  await page.click('.model-viewer [data-act="more"]');
  assert.deepEqual(await page.$$eval('.amenu .amenu-row', (r) => r.map((x) => x.dataset.act)), ['save', 'share']);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.amenu', { state: 'detached' });
  assert.equal(await page.isVisible('.model-viewer'), true, 'Escape closed only the menu');
  await page.goBack();
  await page.waitForSelector('.model-viewer', { state: 'hidden' });
});

test('no page errors in the batch 10 run', () => {
  assert.deepEqual(errors, []);
});
