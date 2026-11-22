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
    params: [...document.querySelectorAll('#params input, #params select, #params button')].map(st),
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
