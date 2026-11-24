// Batch 5 browser tests: no ⋮ menu, folder History toggle, orientation only
// swaps the ratio, 1K / 2K / 4K resolution (4K = 2K + 2x upscale), Aspect /
// Batch+Seed rows, picker sub-categories, gear Settings, History as a top bar
// toggle with batch favourite, gallery viewer (strip, flick, rubber band,
// swipe down to close, delete). Screenshots: test/browser/screenshots/b5-*.png.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStack, ROOT } from '../unit/helpers.js';
import { launch, pickAspect, menuAct } from './launch.js';

const SHOTS = path.join(ROOT, 'test/browser/screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
let s, browser, ctx, page, outDir;
const errors = [];

before(async () => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-out5-'));
  fs.mkdirSync(path.join(outDir, 'concept-app'), { recursive: true });
  s = await startStack({ stepMs: 40, folderWorkflows: false, outputDir: outDir });
  browser = await launch();
  ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.goto(s.base + '/');
  await page.waitForFunction(() => (window.conceptApp?.workflows?.length || 0) > 10 && window.conceptApp.current);
});
after(async () => { await browser?.close(); await s?.close(); });

const app = (fn, arg) => page.evaluate(fn, arg);
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `b5-${name}.png`) });
async function pick(id) { await page.click('#preset-btn'); await page.click(`#picker .ent[data-preset="${id}"]`); await page.waitForFunction((x) => window.conceptApp.current?.id === x, id); }
const idle = () => page.waitForFunction(() => !document.querySelector('#btn-generate').disabled && window.conceptApp.queue.active.length === 0, null, { timeout: 20000 });
/** Click Run and wait until the run's jobs are queued and finished (4K first asks ComfyUI for its upscale models). */
async function run() { const n = await app(() => window.conceptApp.queue.items.length); await page.click('#btn-generate'); await page.waitForFunction((n) => window.conceptApp.queue.items.length > n, n, { timeout: 10000 }); await idle(); }
async function setBatch(n) { await page.fill('#batch', String(n)); await page.locator('#batch').dispatchEvent('change'); }
const lastGraph = () => { const all = Object.values(s.mock.history).sort((a, b) => a.prompt[0] - b.prompt[0]); return all[all.length - 1].prompt[2]; };
const nodes = (g, cls) => Object.entries(g).filter(([, n]) => n.class_type === cls);
const size = () => page.textContent('#aspect-size');

test('top bar: no ⋮ menu, History is a folder toggle; Settings has a gear; seed Lock is icon only', async () => {
  assert.equal(await page.$('details.menu, .menu-pop, #btn-import, #builder-model, #mem-te-cpu'), null);
  assert.equal(await page.$eval('#btn-history i', (i) => i.className), 'i i-folder');
  assert.equal(await page.getAttribute('#btn-history', 'aria-pressed'), 'false');
  assert.equal(await page.$eval('#settings > summary i', (i) => i.className), 'i i-settings');
  assert.equal((await page.textContent('#seed-field .toggle')).trim(), '', 'no "Lock" word');
  assert.equal(await page.$eval('#seed-field .toggle .i', (i) => i.className), 'i i-lock');
});

test('batch 8 ratio grid: both orientations side by side, shown the way they come out, shapes the preset cannot make are greyed', async () => {
  await pick('ai:klein-4b-t2i');
  await pickAspect(page, '1:1');
  assert.equal(await app(() => window.conceptApp.panel.state.aspect), '1:1');
  await page.click('#aspect-btn');
  assert.deepEqual(await page.$$eval('#aspect-pop .ar-opt', (b) => b.map((x) => x.textContent)), ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '9:21', '21:9']);
  assert.equal(await page.$eval('#aspect-pop .ar-opt[aria-checked="true"]', (b) => b.textContent), '1:1');
  await page.click('#aspect-pop .ar-opt[data-aspect="16:9-portrait"]');
  assert.equal(await page.isVisible('#aspect-pop'), false, 'closes on pick');
  assert.equal(await app(() => window.conceptApp.panel.state.aspect), '16:9-portrait');
  assert.equal(await page.textContent('#aspect-label'), '9:16', 'shown the way it comes out');
  await pickAspect(page, '16:9-landscape');
  assert.equal(await page.textContent('#aspect-label'), '16:9');
  await pickAspect(page, '4:3-portrait');
  assert.equal(await app(() => window.conceptApp.panel.state.aspect), '4:3-portrait');
  // the preview shape follows the hovered ratio; Escape closes
  await page.click('#aspect-btn');
  await page.hover('#aspect-pop .ar-opt[data-aspect="16:9-landscape"]');
  await page.waitForFunction(() => { const e = document.querySelector('#aspect-pop .ar-preview'); return e.offsetWidth > e.offsetHeight * 1.6; }, null, { timeout: 2000 });
  await page.keyboard.press('Escape');
  assert.equal(await page.isVisible('#aspect-pop'), false);
});

test('resolution 1K / 2K / 4K locks the ratio to the long side; Aspect, orientation and resolution share a row', async () => {
  await pick('ai:klein-4b-t2i');
  assert.equal(await page.isVisible('#res-select'), true);
  await pickAspect(page, '16:9-landscape');
  await page.selectOption('#aspect-res', '1k');
  assert.equal(await size(), '1024 × 576');
  await page.selectOption('#aspect-res', '2k');
  assert.equal(await size(), '2048 × 1152');
  await pickAspect(page, '16:9-portrait');
  assert.equal(await size(), '1152 × 2048');
  await page.selectOption('#aspect-res', '4k');
  assert.equal(await size(), '2304 × 4096');
  // row 1: ratio button and resolution side by side; row 2: Batch and Seed side by side
  const geo = await app(() => {
    const r = (sel) => document.querySelector(sel).getBoundingClientRect();
    return { ratio: r('#aspect-btn'), res: r('#res-select'), batch: r('#batch-field'), seed: r('#seed-field'), vw: innerWidth };
  });
  const mid = (b) => b.top + b.height / 2;
  assert.ok(Math.abs(mid(geo.ratio) - mid(geo.res)) < 4, JSON.stringify(geo));
  assert.ok(geo.ratio.right <= geo.res.left);
  assert.ok(Math.abs(geo.batch.top - geo.seed.top) < 4 && geo.batch.right <= geo.seed.left, 'Batch and Seed on one row');
  assert.ok(geo.seed.right <= geo.vw, 'no overflow');
  await shot('form-4k');
  // not shown where it does not apply (picture-in edit preset has no size block)
  await pick('ai:klein-4b-edit');
  assert.equal(await page.isVisible('#res-select'), false);
  await pick('ai:klein-4b-t2i');
  assert.equal(await page.isVisible('#res-select'), true);
});

test('4K renders at 2K and upscales 2x in the same graph; 2K renders natively', async () => {
  await pick('ai:klein-4b-t2i');
  await page.fill('#prompt', 'a tall white rocket');
  await setBatch(1);
  await pickAspect(page, '1:1');
  await page.selectOption('#aspect-res', '4k');
  await run();
  let g = lastGraph();
  // Klein feeds width / height through two PrimitiveInt nodes (75:68 / 75:69)
  assert.deepEqual([g['75:68'].inputs.value, g['75:69'].inputs.value], [2048, 2048], 'rendered at 2K');
  const [[loaderId, loader]] = nodes(g, 'UpscaleModelLoader');
  assert.equal(loader.inputs.model_name, '4x-UltraSharp.safetensors');
  const [[upId, up]] = nodes(g, 'ImageUpscaleWithModel');
  assert.deepEqual(up.inputs.upscale_model, [loaderId, 0]);
  const [[scaleId, scale]] = nodes(g, 'ImageScaleBy');
  assert.equal(scale.inputs.scale_by, 0.5);
  assert.deepEqual(scale.inputs.image, [upId, 0]);
  for (const [, save] of nodes(g, 'SaveImage')) assert.deepEqual(save.inputs.images, [scaleId, 0], 'saved picture is the upscaled one');
  const meta = await app(() => window.conceptApp.queue.items.at(-1).meta);
  assert.deepEqual([meta.width, meta.height, meta.res], [4096, 4096, '4k']);
  // 2K: no upscale nodes
  await page.selectOption('#aspect-res', '2k');
  await run();
  g = lastGraph();
  assert.equal(nodes(g, 'UpscaleModelLoader').length, 0);
  await page.selectOption('#aspect-res', '1k');
});

test('picker: sub-category names bolder + lighter grey, their models indented; no lines', async () => {
  await page.click('#preset-btn');
  const st = await app(() => {
    const sub = document.querySelector('#picker .sub'), ent = document.querySelector('#picker .ent.in-sub'), top = [...document.querySelectorAll('#picker .ent')].find((e) => !e.classList.contains('in-sub'));
    const cs = (e) => getComputedStyle(e);
    return { subW: Number(cs(sub).fontWeight), subC: cs(sub).color, subPad: parseFloat(cs(sub).paddingLeft), entPad: parseFloat(cs(ent).paddingLeft), topPad: top ? parseFloat(cs(top).paddingLeft) : null, subBorder: cs(sub).borderTopStyle + cs(sub).borderBottomStyle, entC: cs(ent).color };
  });
  assert.ok(st.subW >= 700, JSON.stringify(st));
  assert.equal(st.subC, 'rgb(200, 200, 200)');
  assert.ok(st.entPad > st.subPad, 'models indented under the sub-category');
  assert.equal(st.subBorder, 'nonenone', 'no lines on sub-categories');
  await shot('picker');
  await page.keyboard.press('Escape');
});

test('History is a top bar toggle: top bar stays, dropdown and Run hide; batch favourite in the selection bar', async () => {
  // make a few pictures first
  await pick('ai:z-image-turbo');
  await page.fill('#prompt', 'robots in a field');
  await setBatch(4);
  await run();
  const barBefore = await page.$eval('.topbar', (t) => t.getBoundingClientRect().top);
  await page.click('#btn-history');
  await page.waitForSelector('.history .thumb[data-id]');
  assert.equal(await page.getAttribute('#btn-history', 'aria-pressed'), 'true');
  assert.equal(await page.$eval('.topbar', (t) => t.getBoundingClientRect().top), barBefore, 'top bar did not move');
  for (const sel of ['#preset-btn', '.actionbar', '#panel']) assert.equal(await page.isVisible(sel), false, sel);
  for (const sel of ['.topbar', '#btn-canvas', '#btn-history']) assert.equal(await page.isVisible(sel), true, sel);
  const hb = await app(() => ({ top: document.querySelector('.topbar').getBoundingClientRect().bottom, h: document.querySelector('.history').getBoundingClientRect().top }));
  assert.ok(hb.h >= hb.top - 1, 'History sits under the top bar');
  await shot('history');
  // select two -> star favourites both, star again unfavourites both
  const ids = await page.$$eval('.history .thumb[data-id]', (els) => els.slice(0, 2).map((e) => e.dataset.id));
  await app((ids) => { const hv = window.conceptApp.historyView; hv.startSelect(ids[0]); hv.selected.add(ids[1]); hv.paintSelection(); }, ids);
  assert.equal(await page.isVisible('.sel-bar'), true);
  assert.equal(await page.isVisible('.topbar'), true, 'selection bar sits under the top bar');
  assert.equal(await page.textContent('.sel-bar .sel-fav'), '☆');
  await page.click('.sel-bar .sel-fav');
  await page.waitForFunction(() => document.querySelector('.sel-bar .sel-fav').textContent === '★');
  let fav = (await (await fetch(s.base + '/api/history?favorites=1')).json()).sessions.flatMap((x) => x.entries).map((e) => e.id);
  assert.ok(ids.every((id) => fav.includes(id)), 'both favourited');
  assert.equal(await app(() => window.conceptApp.historyView.selecting), true, 'still selecting');
  await shot('history-fav');
  await page.click('.sel-bar .sel-fav');
  await page.waitForFunction(() => document.querySelector('.sel-bar .sel-fav').textContent === '☆');
  fav = (await (await fetch(s.base + '/api/history?favorites=1')).json()).sessions.flatMap((x) => x.entries).map((e) => e.id);
  assert.ok(ids.every((id) => !fav.includes(id)), 'both unfavourited');
  await app(() => window.conceptApp.historyView.endSelect());
  await page.click('#btn-history');
  assert.equal(await page.isVisible('.actionbar'), true, 'back to the form');
});

test('viewer: strip, drag moves the next picture in, flick, rubber band, strip tap, swipe down closes', async () => {
  await page.click('#btn-history');
  await page.waitForSelector('.history .thumb[data-id]');
  await page.click('.history .thumb[data-id] >> nth=0');
  await page.waitForSelector('.viewer:not([hidden])');
  await page.waitForFunction(() => document.querySelector('.viewer-img').naturalWidth > 0);
  const n = await page.locator('.viewer-strip-item').count();
  assert.ok(n >= 4, `strip has ${n}; items ${JSON.stringify(await app(() => window.conceptApp.viewer.items().map((i) => i.historyId)))}`);
  assert.match(await page.textContent('.viewer-counter'), /^1 \//);
  const box = await page.locator('.viewer-stage').boundingBox();
  const cy = box.y + box.height / 2;
  // mid-drag: the whole track follows and the next slide is on screen
  await page.mouse.move(box.x + box.width * 0.8, cy); await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, cy); await page.mouse.move(box.x + box.width * 0.5, cy);
  const mid = await app(() => { const s = [...document.querySelectorAll('.viewer-slide')].find((x) => x.getBoundingClientRect().left > 0 && x.getBoundingClientRect().left < innerWidth && !x.hidden); return { track: document.querySelector('.viewer-track').style.transform, next: !!s }; });
  assert.match(mid.track, /translate3d\(-\d+/); assert.equal(mid.next, true, 'next picture visible while dragging');
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('.viewer-counter').textContent.startsWith('2 /'), null, { timeout: 3000 });
  // short fast flick (under a third of the width) still goes to the next one
  await page.mouse.move(box.x + box.width * 0.7, cy); await page.mouse.down();
  for (const f of [0.62, 0.55, 0.48]) await page.mouse.move(box.x + box.width * f, cy);
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('.viewer-counter').textContent.startsWith('3 /'), null, { timeout: 3000 });
  // a slow short drag springs back
  await page.mouse.move(box.x + box.width * 0.6, cy); await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, cy); await page.waitForTimeout(200); await page.mouse.up();
  await page.waitForTimeout(450);
  assert.match(await page.textContent('.viewer-counter'), /^3 \//);
  // strip tap jumps to the first; strip follows
  await page.click('.viewer-strip-item >> nth=0');
  await page.waitForFunction(() => document.querySelector('.viewer-counter').textContent.startsWith('1 /'));
  assert.equal(await page.$eval('.viewer-strip-item.on', (b) => [...b.parentNode.children].indexOf(b)), 0);
  // rubber band at the first picture: drag right does not move on
  await page.mouse.move(box.x + box.width * 0.2, cy); await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(box.x + box.width * (0.2 + i * 0.1), cy);
  const stretched = await app(() => Number(/translate3d\((-?[\d.]+)px/.exec(document.querySelector('.viewer-track').style.transform)[1]));
  assert.ok(stretched > 0 && stretched < box.width * 0.4, `rubber band ${stretched}`);
  await page.mouse.up();
  await page.waitForTimeout(450);
  assert.match(await page.textContent('.viewer-counter'), /^1 \//);
  await shot('viewer');
  // swipe down closes
  await page.mouse.move(box.x + box.width / 2, box.y + 200); await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(box.x + box.width / 2, box.y + 200 + i * 45);
  await page.mouse.up();
  await page.waitForSelector('.viewer', { state: 'hidden' });
  assert.equal(await page.isVisible('.history'), true, 'back in History');
});

test('viewer delete: ⋮ Delete + confirm removes only that picture from the PC and shows the next one', async () => {
  const before = (await (await fetch(s.base + '/api/history')).json()).sessions.flatMap((x) => x.entries).length;
  await page.click('.history .thumb[data-id] >> nth=0');
  await page.waitForSelector('.viewer:not([hidden])');
  const total = Number((await page.textContent('.viewer-counter')).split('/')[1]);
  const id = await app(() => window.conceptApp.viewer.current().historyId);
  const nextId = await app(() => window.conceptApp.viewer.items()[1].historyId);
  await menuAct(page, '.viewer', 'delete'); // batch 10: Delete is in the ⋮ menu
  await page.waitForSelector('.confirm');
  assert.match(await page.textContent('.confirm p'), /Delete this image from the PC\?/);
  await page.click('.confirm [data-act="confirm"]');
  await page.waitForFunction((t) => document.querySelector('.viewer-counter').textContent.startsWith(`1 / ${t - 1}`), total);
  assert.equal(await app(() => window.conceptApp.viewer.current().historyId), nextId, 'moved on to the next picture');
  const after = (await (await fetch(s.base + '/api/history')).json()).sessions.flatMap((x) => x.entries);
  assert.equal(after.length, before - 1);
  assert.ok(!after.some((e) => e.id === id));
  // closing reloads History without it
  await page.click('.viewer-top button[aria-label=Close]');
  await page.waitForFunction((x) => !document.querySelector(`.history .thumb[data-id="${x}"]`), id);
  await page.click('#btn-history');
});

test('no page errors in batch 5 tests', () => {
  assert.deepEqual(errors, []);
});
