// Batch 18 browser tests (phone size, plus one tablet check): the GPU chip icon
// beside the preset picker; the bottom area is one raised panel with no divider
// lines; "This session" is hidden while empty and shows once there are pictures;
// the floating Ask Claude button always sits above the panel.
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

before(async () => {
  s = await startStack({ stepMs: 30, folderWorkflows: false });
  browser = await launch();
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.goto(s.base + '/');
  await page.waitForFunction(() => (window.conceptApp?.workflows?.length || 0) > 10 && window.conceptApp.current);
  // the Ask button shows only while Use Claude is on; show it for the layout checks
  await page.evaluate(() => { window.conceptApp.claude.fab.hidden = false; });
});
after(async () => { await browser?.close(); await s?.close(); });

const app = (fn, arg) => page.evaluate(fn, arg);
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `b18-${name}.png`) });
const box = (sel) => page.locator(sel).first().boundingBox();

test('the preset picker shows the GPU chip icon', async () => {
  assert.equal(await page.locator('#preset-btn .i-gpu').count(), 1);
  assert.equal(await page.locator('#preset-btn .i-workflow').count(), 0);
  const css = fs.readFileSync(path.join(ROOT, 'app/icons.css'), 'utf8');
  assert.match(css, /^\.i-gpu\{--svg:url\("data:image\/svg\+xml,/m);
  const mask = await app(() => getComputedStyle(document.querySelector('#preset-btn .i-gpu')).webkitMaskImage);
  assert.match(mask, /svg/);
});

test('empty: no "This session" row, the Run bar is the raised panel, no divider lines', async () => {
  assert.equal(await page.isVisible('#results'), false, 'This session hidden while empty');
  const bar = await app(() => { const cs = getComputedStyle(document.querySelector('.actionbar')); return { bt: cs.borderTopWidth, r: cs.borderTopLeftRadius, sh: cs.boxShadow, bg: cs.backgroundColor }; });
  assert.equal(bar.bt, '0px', 'no line above the Run bar');
  assert.equal(bar.r, '16px', 'rounded top corners');
  assert.notEqual(bar.sh, 'none', 'soft shadow');
  const bodyBg = await app(() => getComputedStyle(document.body).backgroundColor);
  assert.notEqual(bar.bg, bodyBg, 'a lighter surface than the page');
  const fab = await box('.claude-fab'), run = await box('.actionbar');
  assert.ok(fab.y + fab.height <= run.y - 4, 'Ask sits above the panel');
  await shot('empty');
});

test('with pictures: "This session" shows inside the panel; Ask never covers a thumbnail', async () => {
  await page.fill('#prompt', 'a scout mech');
  await page.fill('#batch', '6'); await page.locator('#batch').dispatchEvent('change');
  await page.click('#btn-generate');
  await page.waitForFunction(() => document.querySelectorAll('#thumbs .thumb.s-done').length === 6, null, { timeout: 20000 });
  await page.waitForFunction(() => !window.conceptApp.lock.locked());
  assert.equal(await page.isVisible('#results'), true);
  const st = await app(() => {
    const r = getComputedStyle(document.querySelector('#results')), a = getComputedStyle(document.querySelector('.actionbar'));
    return { rbt: r.borderTopWidth, rr: r.borderTopLeftRadius, rbg: r.backgroundColor, abt: a.borderTopWidth, ar: a.borderTopLeftRadius, abg: a.backgroundColor };
  });
  assert.equal(st.rbt, '0px'); assert.equal(st.abt, '0px', 'no lines');
  assert.equal(st.rr, '16px', 'the rounded corners move up to This session');
  assert.equal(st.ar, '0px');
  assert.equal(st.rbg, st.abg, 'one panel, one colour');
  // scroll the strip to the end: the last thumbnail is not under the Ask button
  await app(() => { const t = document.querySelector('#thumbs'); t.scrollLeft = t.scrollWidth; });
  await new Promise((r) => setTimeout(r, 200));
  const fab = await box('.claude-fab'), res = await box('#results');
  assert.ok(fab.y + fab.height <= res.y - 4, `Ask (${fab.y + fab.height}) above the panel (${res.y})`);
  for (const t of await page.locator('#thumbs .thumb').all()) {
    const b = await t.boundingBox();
    const overlap = !(b.x + b.width <= fab.x || fab.x + fab.width <= b.x || b.y + b.height <= fab.y || fab.y + fab.height <= b.y);
    assert.equal(overlap, false, 'Ask covers no thumbnail');
  }
  await shot('with-pictures');
  // clear finished: the row hides again and Ask drops back down
  await page.click('#btn-clear');
  await page.waitForFunction(() => document.querySelector('#results').classList.contains('empty'));
  assert.equal(await page.isVisible('#results'), false);
  await page.waitForFunction(() => { const f = document.querySelector('.claude-fab').getBoundingClientRect(), a = document.querySelector('.actionbar').getBoundingClientRect(); return f.bottom <= a.top && a.top - f.bottom < 30; });
});

test('tablet: the Run bar is raised too; Ask stays bottom right', async () => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await new Promise((r) => setTimeout(r, 200));
  const a = await app(() => { const cs = getComputedStyle(document.querySelector('.actionbar')); return { bt: cs.borderTopWidth, r: cs.borderTopLeftRadius }; });
  assert.equal(a.bt, '0px'); assert.equal(a.r, '16px');
  const fab = await box('.claude-fab');
  assert.ok(fab.x + fab.width > 900 && fab.y + fab.height > 600, 'bottom right');
  await shot('tablet');
  await page.setViewportSize({ width: 390, height: 844 });
});

test('no page errors', () => { assert.deepEqual(errors, []); });
