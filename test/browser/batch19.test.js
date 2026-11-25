// Batch 19 in the app: Settings cards (no focus ring on the switches), the greyed-out
// empty batch button, the plain Resolution list, the project picker as a dropdown,
// and Files: stats v2 (type colors, period toggle, collapsed Tags), filter button +
// removable chips, Favorites as a filter, always by project with collapsible projects.
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
const j = async (method, url, body) => (await fetch(s.base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();

before(async () => {
  s = await startStack({ stepMs: 40, folderWorkflows: false, projects: true });
  fs.mkdirSync(path.join(s.projectsDir, 'GTA 6 Mods', 'Mod A'), { recursive: true });
  fs.mkdirSync(path.join(s.projectsDir, 'GTA 6 Mods', 'Mod B'), { recursive: true });
  const modA = await j('POST', '/api/projects', { path: 'GTA 6 Mods/Mod A' });
  const modB = await j('POST', '/api/projects', { path: 'GTA 6 Mods/Mod B' });
  const h = s.app.history;
  const now = Date.now(), lastMonth = new Date(); lastMonth.setDate(0); lastMonth.setHours(12, 0, 0, 0); // last day of last month
  for (const f of ['a1.png', 'a2.png', 'b1.png', 'old.png']) s.mock.files.set(`output/concept-app/${f}`, pngBytes());
  const a1 = await h.add({ workflow: 'ai:z-image-turbo', prompt: 'a desert road', images: [img('a1.png')], project: modA.id, createdAt: now - 60000 });
  await h.add({ workflow: 'ai:z-image-turbo', prompt: 'a gas station', images: [img('a2.png')], project: modA.id, createdAt: now - 120000 });
  await h.add({ workflow: 'ai:klein-4b-t2i', prompt: 'a beach', images: [img('b1.png')], project: modB.id, createdAt: now - 30000 });
  await h.add({ workflow: 'ai:hunyuan3d-21', prompt: '', images: [], files: [{ ...img('m.glb'), kind: '3d' }], status: 'done', project: modB.id, createdAt: now - 10000 });
  await h.add({ workflow: 'ai:ace-step-15', prompt: 'an old song', images: [img('old.png')], createdAt: lastMonth.getTime() });
  await h.setTags(a1.id, { genre: ['western'], mood: ['calm'], setting: ['desert'] });
  await j('PATCH', `/api/history/${a1.id}`, { favorite: true });
  browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.goto(s.base + '/');
  await page.waitForFunction(() => (window.conceptApp?.workflows?.length || 0) > 10 && window.conceptApp.current);
});
after(async () => { await browser?.close(); await s?.close(); });

test('1-2. Settings: General and Claude are grouped cards with matching headings; no focus ring on the switches', async () => {
  await page.click('#btn-settings');
  await page.waitForSelector('.settings-sheet .st-group');
  assert.equal(await page.$$eval('.settings-sheet .st-group', (g) => g.length), 2);
  const heads = await page.$$eval('.st-group > .st-section', (hs) => hs.map((x) => { const c = getComputedStyle(x); return [x.textContent.trim(), c.fontSize, c.fontWeight, c.color]; }));
  assert.deepEqual(heads.map((x) => x[0]), ['General', 'Claude']);
  assert.deepEqual(heads[0].slice(1), heads[1].slice(1), 'same size, boldness and brightness');
  assert.ok(parseFloat(heads[0][1]) >= 16, 'bigger section headings');
  await page.click('label.st-switch:has(#st-reset)');
  const ring = await page.$eval('#st-reset', (x) => { x.focus(); const c = getComputedStyle(x); return [c.outlineStyle, c.boxShadow]; });
  assert.deepEqual(ring, ['none', 'none']);
  await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
  assert.equal(await page.$eval('#st-reset', (x) => getComputedStyle(x).outlineStyle), 'none', 'no ring with the keyboard either');
  await page.screenshot({ path: path.join(SHOTS, 'b19-settings.png') });
  await page.click('.settings-sheet [data-act="close"]');
});

test('3. batch button: greyed out with no "0" badge while there are no batches', async () => {
  assert.equal(await page.$eval('#btn-batch', (b) => b.classList.contains('no-jobs')), true);
  assert.equal(await page.isVisible('#batch-count'), false);
});

test('4. Resolution: a plain list, the picked size has a grey fill and no outline', async () => {
  await page.click('#aspect-res .dd-btn');
  await page.waitForSelector('.dd-pop.res-pop .dd-opt');
  const st = await page.$$eval('.res-pop .dd-opt', (o) => o.map((x) => { const c = getComputedStyle(x); return [x.getAttribute('aria-selected'), c.borderTopColor, c.backgroundColor]; }));
  for (const [, border] of st) assert.equal(border, 'rgba(0, 0, 0, 0)');
  const on = st.find((x) => x[0] === 'true'), off = st.find((x) => x[0] !== 'true');
  assert.notEqual(on[2], off[2], 'picked size has a fill');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.res-pop', { state: 'detached' });
});

test('5. project picker: a dropdown under its button (Recent, Find another); New project / Browse open inside it with a back arrow', async () => {
  await page.click('.project-chip');
  await page.waitForSelector('.pj-pop [data-act="new-project"]');
  assert.equal(await page.$('.pj-sheet'), null, 'not a bottom sheet');
  const pos = await page.evaluate(() => { const b = document.querySelector('.project-chip').getBoundingClientRect(), p = document.querySelector('.pj-pop').getBoundingClientRect(); return { below: p.top >= b.bottom, max: getComputedStyle(document.querySelector('.pj-pop')).maxHeight }; });
  assert.equal(pos.below, true); assert.notEqual(pos.max, 'none');
  const text = await page.textContent('.pj-pop');
  for (const t of ['Recent', 'Mod A', 'No project', 'Find another', 'New project…', 'Browse ACTIVE…']) assert.ok(text.includes(t), t);
  await page.screenshot({ path: path.join(SHOTS, 'b19-project-dropdown.png') });
  await page.click('.pj-pop [data-act="new-project"]');
  await page.waitForSelector('.pj-pop .pj-name');
  assert.equal(await page.isVisible('.pj-pop [data-act="back"]'), true);
  await page.screenshot({ path: path.join(SHOTS, 'b19-project-new.png') });
  await page.click('.pj-pop [data-act="back"]');
  await page.click('.pj-pop [data-act="browse"]');
  await page.waitForSelector('.pj-pop .df-crumbs');
  await page.click('.pj-pop [data-act="back"]');
  await page.click('.pj-pop [data-act="project"][data-project]');
  await page.waitForSelector('.pj-pop', { state: 'detached' });
  await page.waitForFunction(() => /Mod/.test(document.querySelector('.project-chip').textContent));
});

test('6. Files stats: type colors, key with no numbers, today/this month toggle, model bars by type, Tags collapsed', async () => {
  await page.click('#btn-history');
  await page.waitForSelector('.history .history-session');
  assert.equal(await page.$('.history .hseg'), null, 'no By project / By date toggle');
  assert.equal(await page.$('.history-top .btn'), null, 'no ★ Favorites button');
  await page.click('.hstats');
  await page.waitForSelector('.hstats.open .hperiod');
  assert.deepEqual(await page.$$eval('.hlegend span', (x) => x.map((s) => s.textContent)), ['Images', '3D', 'Video', 'Audio']);
  assert.deepEqual(await page.$$eval('.hlegend .hsw', (x) => x.map((s) => getComputedStyle(s).backgroundColor)), ['rgb(18, 194, 170)', 'rgb(143, 147, 156)', 'rgb(155, 124, 240)', 'rgb(230, 163, 58)']);
  assert.equal(await page.$eval('.hperiod.on', (b) => b.dataset.period), 'month', 'This month by default');
  // last month's entry is out of "this month": 3 images + 1 3D model this month
  assert.equal(await page.$$eval('.hstats.open .htbar i', (x) => x.length), 2);
  assert.match(await page.textContent('.hnums'), /5outputs/, 'outputs stays all-time');
  const bar3d = await page.$eval('.hbar[data-model="ai:hunyuan3d-21"] b', (b) => getComputedStyle(b).backgroundColor);
  assert.equal(bar3d, 'rgb(143, 147, 156)', 'a 3D model takes the 3D color');
  assert.equal(await page.$('.hstats .htags'), null, 'Tags collapsed');
  assert.match(await page.textContent('.hsec-btn'), /Tags · 3/);
  assert.equal(await page.isVisible('.hstats .htagger'), true);
  await page.screenshot({ path: path.join(SHOTS, 'b19-stats.png') });
  await page.click('.hsec-btn');
  await page.waitForSelector('.hstats .htags .htag');
  assert.equal(await page.$('.hdot2'), null, 'no colored dots on tags');
  assert.equal(await page.isVisible('.hstats .htagger'), true);
  await page.click('.hperiod[data-period="today"]');
  assert.equal(await page.$eval('.hperiod.on', (b) => b.dataset.period), 'today');
  await page.screenshot({ path: path.join(SHOTS, 'b19-stats-today.png') });
  await page.click('.hstats .hstats-ch');
});

test('8-10. Files filters: a filter button with a count, removable chips, Favorites in the Filters box', async () => {
  assert.equal(await page.isVisible('.hfilters'), false, 'no chip row without filters');
  assert.equal(await page.isVisible('.hfilter-n'), false);
  await page.click('.hfilter-btn');
  await page.waitForSelector('.filter-sheet [data-sec="fav"]');
  await page.click('.filter-sheet [data-fav="1"]');
  await page.click('.filter-sheet [data-type="image"]');
  await page.click('.filter-sheet [data-act="show"]');
  assert.equal(await page.textContent('.hfilter-n'), '2');
  assert.deepEqual(await page.$$eval('.hfilters .hchip .hchip-t', (c) => c.map((x) => x.textContent)), ['★ Favorites', 'Images']);
  await page.screenshot({ path: path.join(SHOTS, 'b19-filters.png') });
  await page.click('.hfilters .hchip[data-act="type"] .x');
  assert.equal(await page.textContent('.hfilter-n'), '1');
  await page.click('.hfilters .hchip[data-act="fav"] .x');
  assert.equal(await page.isVisible('.hfilters'), false);
  assert.equal(await page.isVisible('.hfilter-n'), false);
});

test('9. Files: always by project; folder groups stay open, projects start collapsed and open on a tap', async () => {
  assert.equal(await page.$('.history .hgroup button, button.hgroup'), null, 'folder groups are not toggles');
  assert.deepEqual(await page.$$eval('.history .hgroup .hg-name', (x) => x.map((e) => e.textContent)), ['GTA 6 Mods']);
  assert.deepEqual(await page.$$eval('.history-session[data-project] .day', (x) => x.map((e) => e.firstChild.textContent)), ['Mod B', 'Mod A', 'Unsorted'], 'most recent first');
  assert.equal(await page.$$eval('.history .thumb[data-id]', (t) => t.length), 0, 'collapsed at first');
  await page.click('.history-session:has-text("Mod A") h3');
  await page.waitForSelector('.history .thumb[data-id]');
  assert.equal(await page.$$eval('.history .thumb[data-id]', (t) => t.length), 2);
  await page.screenshot({ path: path.join(SHOTS, 'b19-files.png') });
  assert.deepEqual(errors, []);
});
