// Batch 4 browser tests: run lock covers the whole form, reconnect banner
// grace period, info popovers, Image sub sections, canvas (node view) toggle,
// History delete error handling. Screenshots go to test/browser/screenshots/b4-*.png.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStack, ROOT } from '../unit/helpers.js';
import { launch } from './launch.js';

const SHOTS = path.join(ROOT, 'test/browser/screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
let s, browser, ctx, page, outDir;
const errors = [];

before(async () => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-out4-'));
  fs.mkdirSync(path.join(outDir, 'concept-app'), { recursive: true });
  s = await startStack({ stepMs: 80, folderWorkflows: false, outputDir: outDir });
  browser = await launch();
  ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text() + ' @ ' + (m.location()?.url || '?')); });
  await page.goto(s.base + '/');
  await page.waitForFunction(() => (window.conceptApp?.workflows?.length || 0) > 10);
});
after(async () => { await browser?.close(); await s?.close(); });

const app = (fn, arg) => page.evaluate(fn, arg);
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `b4-${name}.png`), fullPage: false });
async function pick(id) { await page.click('#preset-btn'); await page.click(`#picker .ent[data-preset="${id}"]`); await page.waitForFunction((x) => window.conceptApp.current?.id === x, id); }
const idle = () => page.waitForFunction(() => !document.querySelector('#btn-generate').disabled && window.conceptApp.queue.active.length === 0, null, { timeout: 20000 });
async function setBatch(n) { await page.fill('#batch', String(n)); await page.locator('#batch').dispatchEvent('change'); }

// Every form control and whether it can be used right now.
const formState = () => app(() => {
  const st = (el) => (el ? (el.tagName === 'TEXTAREA' ? !el.readOnly && el.getAttribute('aria-disabled') !== 'true' : !el.disabled) : null);
  const q = (sel) => st(document.querySelector(sel));
  return {
    prompt: q('#prompt'), ratio: q('#aspect-ratio'), orient: q('[data-orient="portrait"]'), batch: q('#batch'), batchPlus: q('#batch-plus'),
    seedLock: q('#seed-lock'), seedDice: q('#seed-dice'), seedVal: q('#seed'),
    params: [...document.querySelectorAll('#params input, #params select, #params button:not(.info-btn)')].map(st),
    chatInput: q('.chat-input'), menuSwitch: q('#mem-te-cpu'), importBtn: q('#btn-import'),
    cancel: q('#btn-cancel'), history: q('#btn-history'), canvas: q('#btn-canvas'),
  };
});

// ---- B. no interaction while a run is going ----------------------------------
test('B: the whole form is locked during a run and comes back exactly as it was', async () => {
  await pick('ai:z-image-turbo');
  await page.fill('#prompt', 'a red mech in the rain');
  await app(() => { const d = document.querySelector('#settings'); d.open = true; });
  await setBatch(3);
  const before = await formState();
  assert.equal(before.prompt, true); assert.equal(before.seedVal, false, 'random seed: the value box is off before the run');
  assert.ok(before.params.length >= 4 && before.params.every(Boolean));
  await page.click('#btn-generate');
  await page.waitForFunction(() => document.querySelector('#prompt').readOnly);
  const during = await formState();
  for (const k of ['prompt', 'ratio', 'orient', 'batch', 'batchPlus', 'seedLock', 'seedDice', 'seedVal', 'chatInput', 'menuSwitch', 'importBtn']) assert.equal(during[k], false, `${k} is locked`);
  assert.ok(during.params.every((x) => x === false), 'Settings are locked');
  assert.equal(during.cancel, true, 'Cancel stays usable');
  assert.equal(during.history, true, 'History stays usable');
  assert.equal(await page.getAttribute('#prompt', 'aria-disabled'), 'true');
  // typing does nothing; a tap on a locked stepper does nothing
  await page.click('#prompt', { force: true }); await page.keyboard.type('XYZ');
  assert.equal(await page.inputValue('#prompt'), 'a red mech in the rain');
  await page.click('#batch-plus', { force: true });
  assert.equal(await page.inputValue('#batch'), '3');
  await shot('form-locked');
  // a finished thumbnail can still be opened while the rest render
  await page.waitForFunction(() => window.conceptApp.queue.items.some((i) => i.image));
  await page.click('#thumbs .thumb.s-done');
  await page.waitForFunction(() => !document.querySelector('.viewer').hidden);
  await page.keyboard.press('Escape').catch(() => {});
  await app(() => window.conceptApp.viewer.close());
  await idle();
  assert.deepEqual(await formState(), before, 'every control is back to its pre-run state');
});

test('B: the lock lifts after an error and after Cancel', async () => {
  await page.route('**/comfy/prompt', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"message":"boom"}}' }));
  await setBatch(1);
  await page.click('#btn-generate');
  await idle();
  assert.equal((await formState()).prompt, true, 'unlocked after a failed queue');
  await page.unroute('**/comfy/prompt');
  await setBatch(4);
  await page.click('#btn-generate');
  await page.waitForFunction(() => document.querySelector('#prompt').readOnly);
  await page.click('#btn-cancel');
  await idle();
  const st = await formState();
  assert.equal(st.prompt, true); assert.equal(st.batchPlus, true);
});

test('B: viewer Reuse waits for the run to end', async () => {
  await setBatch(2);
  await page.click('#btn-generate');
  await page.waitForFunction(() => window.conceptApp.queue.items.slice(-2).some((i) => i.image));
  const promptBefore = await page.inputValue('#prompt');
  await app(() => { const v = window.conceptApp.viewer; v.open(() => window.conceptApp.queue.items, 0); });
  await app(() => window.conceptApp.panel.state.prompt);
  const changed = await app(() => { const it = window.conceptApp.queue.items.find((i) => i.image); const before = window.conceptApp.panel.state.seed; window.conceptApp.viewer.hooks.onReuse({ ...it, meta: { ...it.meta, prompt: 'REUSED', seed: 42 } }); return window.conceptApp.panel.state.prompt === 'REUSED' || window.conceptApp.panel.state.seed !== before; });
  assert.equal(changed, false);
  assert.equal(await page.inputValue('#prompt'), promptBefore);
  await app(() => window.conceptApp.viewer.close());
  await idle();
});

// ---- C. no "Not connected" banner after switching apps ---------------------------
// Simulates Android: the page is hidden, its socket dies, then it is shown again.
const setHidden = (hidden) => app((h) => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => h }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') }); document.dispatchEvent(new Event('visibilitychange')); }, hidden);
const bannerShown = () => app(() => !document.querySelector('#banner').hidden && /Not connected/.test(document.querySelector('#banner').textContent));

test('C: back from another app: the dead socket is replaced at once and the banner never shows', async () => {
  await page.waitForFunction(() => window.conceptApp.comfy.connected);
  await setHidden(true);
  await app(() => { window.__sockets = 0; const c = window.conceptApp.comfy; const old = c.ws; c.retry = 4; old.close(); }); // killed in the background
  await page.waitForFunction(() => !window.conceptApp.comfy.connected);
  await page.waitForTimeout(300);
  await setHidden(false);
  await page.waitForFunction(() => window.conceptApp.comfy.connected, null, { timeout: 3000 });
  for (let i = 0; i < 6; i++) { assert.equal(await bannerShown(), false); await page.waitForTimeout(800); }
});

test('C: a socket that still says "open" after a long time away is replaced on resume', async () => {
  await page.waitForTimeout(1100); // resume() runs at most once a second
  const first = await app(() => { window.__old = window.conceptApp.comfy.ws; return window.__old.readyState; });
  assert.equal(first, 1);
  await setHidden(true);
  // pretend the page was hidden 30 s ago
  await app(() => { const real = Date.now; window.__realNow = real; Date.now = () => real() + 30000; });
  await setHidden(false);
  await page.waitForFunction(() => window.conceptApp.comfy.ws !== window.__old && window.conceptApp.comfy.connected, null, { timeout: 3000 });
  assert.equal(await bannerShown(), false);
  await app(() => { Date.now = window.__realNow; });
});

test('C: when ComfyUI really is gone the banner appears after the grace period, and resume restarts it', async () => {
  await page.waitForTimeout(1100);
  await app(() => {
    const Real = window.WebSocket;
    window.__RealWS = Real;
    window.WebSocket = class extends Real { constructor(u, p) { super(window.__wsDown ? 'ws://127.0.0.1:9/' : u, p); } };
    window.__wsDown = true;
    window.conceptApp.comfy.ws.close();
  });
  await page.waitForFunction(() => !window.conceptApp.comfy.connected);
  await page.waitForTimeout(2500);
  assert.equal(await bannerShown(), false, 'not within the first seconds');
  await page.waitForFunction(() => !document.querySelector('#banner').hidden, null, { timeout: 4000 });
  assert.equal(await bannerShown(), true);
  await shot('banner-after-grace');
  await page.waitForTimeout(1100);
  await app(() => window.conceptApp.resume());
  assert.equal(await bannerShown(), false, 'resume hides it (fresh grace period)');
  await app(() => { window.__wsDown = false; window.conceptApp.resume(); });
  await page.waitForTimeout(1100);
  await app(() => window.conceptApp.resume());
  await page.waitForFunction(() => window.conceptApp.comfy.connected, null, { timeout: 4000 });
  assert.equal(await bannerShown(), false);
  await app(() => { window.WebSocket = window.__RealWS; });
});

// ---- D. (i) info popovers ------------------------------------------------------
test('D: every visible setting has an (i) button; tap opens a plain-language popover, outside tap / Escape close it', async () => {
  await pick('ai:z-image-turbo');
  await app(() => { document.querySelector('#settings').open = true; });
  const names = await page.$$eval('#panel .info-btn', (bs) => bs.filter((b) => b.offsetParent).map((b) => b.getAttribute('aria-label')));
  for (const n of ['About Prompt', 'About Aspect', 'About Batch', 'About Seed', 'About Steps', 'About Shift', 'About Sampler', 'About Scheduler']) assert.ok(names.includes(n), `${n} in ${names.join(', ')}`);
  // every labelled control in the Settings grid and the quick row has one
  const bare = await page.$$eval('#params .ctl, .quick .ctl', (cs) => cs.filter((c) => c.offsetParent && !c.querySelector('.info-btn')).map((c) => c.textContent.trim()));
  assert.deepEqual(bare, []);
  await page.click('#params .info-btn[aria-label="About Steps"]');
  await page.waitForSelector('#info-pop:not([hidden])');
  assert.match(await page.textContent('#info-pop'), /about 8 steps/);
  assert.equal(await page.getAttribute('#params .info-btn[aria-label="About Steps"]', 'aria-expanded'), 'true');
  assert.equal(await page.getAttribute('#info-pop', 'role'), 'dialog');
  await shot('info-popover');
  // the popover stays on screen
  const box = await page.$eval('#info-pop', (p) => { const r = p.getBoundingClientRect(); return { l: r.left, r: r.right, w: innerWidth }; });
  assert.ok(box.l >= 0 && box.r <= box.w, JSON.stringify(box));
  await page.click('#panel', { position: { x: 4, y: 4 } }); // outside
  await page.waitForSelector('#info-pop', { state: 'hidden' });
  await page.click('.quick .info-btn[aria-label="About Seed"]');
  assert.match(await page.textContent('#info-pop'), /same prompt, settings and seed/);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#info-pop', { state: 'hidden' });
  // tapping the same (i) again closes it too
  await page.click('.quick .info-btn[aria-label="About Batch"]');
  await page.click('.quick .info-btn[aria-label="About Batch"]');
  await page.waitForSelector('#info-pop', { state: 'hidden' });
});

test('D: texts follow the preset, dimmed settings still explain themselves, and (i) works during a run', async () => {
  await pick('ai:qwen-2512-t2i');
  await app(() => { document.querySelector('#settings').open = true; });
  // Guidance is dimmed with Lightning on, but its (i) still opens
  const g = '#params .ctl[data-key="cfg"] .info-btn';
  assert.equal(await page.$eval('#params .ctl[data-key="cfg"]', (c) => c.classList.contains('is-off')), true);
  await page.click(g);
  assert.match(await page.textContent('#info-pop'), /Lightning off/);
  await page.keyboard.press('Escape');
  await pick('ai:klein-4b-edit');
  await page.click('#refs .info-btn');
  assert.match(await page.textContent('#info-pop'), /picture to edit/i);
  await page.keyboard.press('Escape');
  await page.click('label.prompt-field .info-btn');
  assert.match(await page.textContent('#info-pop'), /edit instruction/);
  await page.keyboard.press('Escape');
  // during a run
  await pick('ai:z-image-turbo');
  await page.fill('#prompt', 'info during a run');
  await setBatch(2);
  await page.click('#btn-generate');
  await page.waitForFunction(() => document.querySelector('#prompt').readOnly);
  assert.equal(await page.isEnabled('.quick .info-btn[aria-label="About Seed"]'), true);
  await page.click('.quick .info-btn[aria-label="About Seed"]');
  await page.waitForSelector('#info-pop:not([hidden])');
  await page.keyboard.press('Escape');
  await idle();
});
