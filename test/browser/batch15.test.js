// Batch 15 browser tests: the aspect grid and every dropdown (1K / 2K / 4K,
// Settings, Section) stay open after a pick and close on a tap outside, and
// that closing tap does nothing else; the preset picker still closes on a pick;
// Negative prompt sits right under the prompt box; the Prompt assistant is gone.
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
  s = await startStack({ stepMs: 40, folderWorkflows: false });
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
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `b15-${name}.png`) });
async function pick(id) { await page.click('#preset-btn'); await page.click(`#picker .ent[data-preset="${id}"]`); await page.waitForFunction((x) => window.conceptApp.current?.id === x, id); }
const ctl = (key) => `#params .ctl:has([data-param="${key}"])`;
/** Tap the middle of an element (a real touch on the page, wherever the scrim is). */
async function tapOn(sel) { const b = await page.locator(sel).boundingBox(); await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); }

test('aspect grid: stays open after picks; a tap outside closes it and presses nothing under it', async () => {
  await pick('ai:klein-4b-t2i');
  await page.fill('#prompt', 'keep me');
  await app(() => document.activeElement?.blur());
  await page.click('#aspect-btn');
  await page.click('#aspect-pop .ar-opt[data-aspect="16:9-portrait"]');
  await page.click('#aspect-pop .ar-opt[data-aspect="3:2-landscape"]');
  assert.equal(await page.isVisible('#aspect-pop'), true, 'still open after two picks');
  assert.equal(await app(() => window.conceptApp.panel.state.aspect), '3:2-landscape');
  assert.equal(await page.textContent('#aspect-pop .ar-opt[aria-checked="true"]'), '3:2');
  await shot('aspect-open');
  await tapOn('#prompt'); // above the grid: the tap lands on the scrim
  assert.equal(await page.isVisible('#aspect-pop'), false);
  assert.notEqual(await app(() => document.activeElement?.id), 'prompt', 'the closing tap did not focus the prompt box');
  await page.click('#aspect-btn'); // and it opens again right away
  assert.equal(await page.isVisible('#aspect-pop'), true);
  await page.keyboard.press('Escape');
});

test('1K / 2K / 4K: the app\'s own dropdown, open after a pick, closed by a tap outside', async () => {
  assert.equal(await page.locator('#res-select select').count(), 0, 'no phone menu');
  await page.click('#aspect-res .dd-btn');
  await page.click('.dd-pop .dd-opt[data-value="2k"]');
  assert.equal(await page.isVisible('.dd-pop'), true);
  assert.equal(await page.textContent('#aspect-res .dd-text'), '2K');
  assert.equal(await app(() => window.conceptApp.panel.state.res), '2k');
  await page.click('.dd-pop .dd-opt[data-value="4k"]');
  assert.equal(await page.textContent('.dd-pop .dd-opt[aria-selected="true"]'), '4K');
  await shot('res-open');
  await tapOn('#prompt');
  assert.equal(await page.locator('.dd-pop').count(), 0);
  assert.notEqual(await app(() => document.activeElement?.id), 'prompt', 'the closing tap did not focus the prompt box');
  await page.click('#aspect-res .dd-btn');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.dd-pop').count(), 0, 'Escape closes it');
});

test('Settings dropdown (Sampler): stays open after a pick, the value reaches the form', async () => {
  await pick('ai:z-image-turbo');
  await app(() => { document.querySelector('#settings').open = true; });
  await page.click(`${ctl('sampler')} .dd-btn`);
  await page.click('.dd-pop .dd-opt[data-value="euler"]');
  await page.click('.dd-pop .dd-opt[data-value="dpmpp_2m"]');
  assert.equal(await page.isVisible('.dd-pop'), true);
  assert.equal(await page.textContent(`${ctl('sampler')} .dd-text`), 'dpmpp_2m');
  assert.equal(await app(() => window.conceptApp.panel.paramValues().sampler), 'dpmpp_2m');
  await shot('sampler-open');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.dd-pop').count(), 0);
});

test('the preset picker at the top still closes on a pick', async () => {
  await pick('ai:klein-4b-t2i');
  assert.equal(await page.isVisible('#picker'), false);
});

test('Negative prompt sits right under the prompt box; no Prompt assistant, no Undo / Versions', async () => {
  await pick('ai:qwen-2512-t2i'); // has a negative prompt
  const gap = await app(() => document.querySelector('#neg-row').getBoundingClientRect().top - document.querySelector('.prompt-field').getBoundingClientRect().bottom);
  assert.ok(gap <= 6, `gap ${gap}px`);
  assert.equal(await page.locator('#chat-mount, .chat, #prompt-tools, #prompt-undo, .versions').count(), 0);
  assert.equal(await app(() => 'chat' in window.conceptApp || 'versions' in window.conceptApp), false);
  for (const route of ['/api/chats', '/api/actions', '/api/builder/config', '/api/user-presets']) assert.equal((await fetch(s.base + route)).status, 404, route);
  await shot('form');
});

test('no page errors in the batch 15 run', () => { assert.deepEqual(errors, []); });
