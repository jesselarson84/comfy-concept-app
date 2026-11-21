// Browser migration test: an app opened with state saved before batch 1
// (localStorage preset "from-reference-image", old panel shape, an old chat
// thread, old history entries) loads without errors, lands on the Klein 4B
// presets, and Reuse / Discuss on the old results work.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startStack, ROOT } from '../unit/helpers.js';
import { launch } from './launch.js';
import { oldHistory, oldChats, oldLocalStorage } from '../fixtures/legacy-state.js';

const SHOTS = path.join(ROOT, 'test/browser/screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
let s, browser;
const errors = [];

before(async () => {
  s = await startStack({ stepMs: 30, folderWorkflows: false, data: { 'history.json': oldHistory(), 'chats.json': oldChats() } });
  browser = await launch();
});
after(async () => { await browser?.close(); await s?.close(); });

let ctx;
// One context (headless Chromium here runs single-process: closing a context
// would close the browser); each test opens a page that starts from the given
// localStorage (cleared first, seeded once per page load).
async function openWith(storage) {
  ctx ||= await browser.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await page.addInitScript((st) => { if (!sessionStorage.getItem('seeded')) { localStorage.clear(); for (const [k, v] of Object.entries(st)) localStorage.setItem(k, v); sessionStorage.setItem('seeded', '1'); } }, storage);
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text() + ' @ ' + (m.location()?.url || '?')); });
  await page.goto(s.base + '/');
  await page.waitForFunction(() => window.conceptApp?.current);
  return { ctx: page, page };
}

test('saved preset "from-reference-image" opens FLUX.2 Klein 4B Image Edit; old panel state (aspect "portrait") loads into the dropdown', async () => {
  const { ctx, page } = await openWith(oldLocalStorage('from-reference-image'));
  try {
    assert.equal(await page.evaluate(() => window.conceptApp.current.id), 'ai:klein-4b-edit');
    assert.equal(await page.evaluate(() => localStorage.getItem('preset')), 'ai:klein-4b-edit');
    assert.equal(await page.inputValue('#prompt'), 'same castle, winter');
    assert.equal(await page.evaluate(() => window.conceptApp.panel.state.aspect), '3:2-portrait');
    await page.evaluate(() => window.conceptApp.selectPreset('ai:klein-4b-t2i'));
    assert.equal(await page.inputValue('#aspect-ratio'), '3:2');
    assert.equal(await page.getAttribute('#aspect-field .seg [data-orient="portrait"]', 'aria-checked'), 'true');
    assert.match(await page.textContent('#aspect-size'), /^\d+ × \d+$/);
  } finally { await ctx.close(); }
});

test('saved preset "fast-concept" opens FLUX.2 Klein 4B Text to Image; no saved preset also defaults to it', async () => {
  for (const st of [oldLocalStorage('fast-concept'), {}]) {
    const { ctx, page } = await openWith(st);
    try {
      assert.equal(await page.evaluate(() => window.conceptApp.current.id), 'ai:klein-4b-t2i');
      assert.match(await page.textContent('#preset-name'), /FLUX\.2 Klein 4B Text to Image/);
    } finally { await ctx.close(); }
  }
});

test('old history: Reuse on a From reference image result -> Klein 4B Image Edit with the old reference in its slot; Fast concept result -> Klein 4B T2I', async () => {
  const { ctx, page } = await openWith(oldLocalStorage('fast-concept'));
  try {
    await page.click('.menu summary');
    await page.click('#btn-history');
    await page.waitForSelector('.history-session .thumb img');
    assert.equal(await page.$$eval('.history-session .thumb', (t) => t.length), 3);
    // newest first: upscale, reference, fast
    await page.click('.history-session .thumb >> nth=1');
    await page.waitForSelector('.viewer:not([hidden])');
    await page.click('.viewer-actions button[title="Reuse prompt + seed"]');
    await page.waitForFunction(() => window.conceptApp.current?.id === 'ai:klein-4b-edit');
    await page.waitForFunction(() => window.conceptApp.refs.values['76'] === 'old-ref.png');
    assert.equal(await page.inputValue('#prompt'), 'same castle, winter');
    assert.equal(await page.inputValue('#seed'), '77');
        await page.screenshot({ path: path.join(SHOTS, 'legacy-reuse-edit.png') });
    if (await page.locator('.viewer:not([hidden])').count()) await page.keyboard.press('Escape');
    if (await page.locator('.history:not([hidden])').count()) await page.click('.history-top button[aria-label=Close]').catch(() => {});
    await page.evaluate(() => window.conceptApp.viewer.open(() => [{ image: { filename: 'concept_00001_.png', subfolder: 'concept-app', type: 'output' }, meta: { workflow: 'ai:klein-4b-t2i', legacyWorkflow: 'fast-concept', prompt: 'a brass airship over a canyon', seed: 4242 } }], 0));
    await page.waitForSelector('.viewer:not([hidden])');
    await page.click('.viewer-actions button[title="Reuse prompt + seed"]');
    await page.waitForFunction(() => window.conceptApp.current?.id === 'ai:klein-4b-t2i');
    // A result recorded with the raw old id (no server mapping) also works.
    await page.evaluate(() => window.conceptApp.viewer.open(() => [{ image: { filename: 'reference_00001_.png', subfolder: 'concept-app', type: 'output' }, meta: { workflow: 'from-reference-image', reference: { 10: 'raw.png' }, prompt: 'x', seed: 1 } }], 0));
    await page.click('.viewer-actions button[title="Reuse prompt + seed"]');
    await page.waitForFunction(() => window.conceptApp.current?.id === 'ai:klein-4b-edit' && window.conceptApp.refs.values['76'] === 'raw.png');
  } finally { await ctx.close(); }
});

test('old chat thread loads; feedback on its Fast concept image tells the model the new preset; Apply + same seed runs on Klein', async () => {
  const { ctx, page } = await openWith(oldLocalStorage('fast-concept'));
  try {
    if ((await page.locator('#chat').getAttribute('open')) === null) await page.click('#chat > summary');
    await page.waitForFunction(() => document.querySelectorAll('.chat-msg').length >= 2);
    assert.match(await page.textContent('.chat-log'), /Made the hull rigid/);
    const n = await page.locator('.chat-msg.assistant:not(.chat-thinking)').count();
    await page.fill('.chat-input', 'img1 still looks like a balloon');
    await page.click('.chat-send');
    await page.waitForFunction((n) => document.querySelectorAll('.chat-msg.assistant:not(.chat-thinking)').length > n && !document.querySelector('.chat-thinking'), n, { timeout: 10000 });
    const req = (await (await fetch(s.ollamaBase + '/mock/requests')).json()).filter((r) => r.path === '/api/chat').at(-1).body;
    assert.match(req.messages[0].content, /img1: generated with prompt "a brass airship over a canyon", seed 4242, preset FLUX\.2 Klein 4B Text to Image \(was Fast concept\)/);
    assert.match(req.messages[0].content, /Active preset: FLUX\.2 Klein 4B Text to Image/);
    // Apply + Run on the proposal queues on the current (Klein) preset.
    const btn = page.locator('.chat-msg.assistant').last().locator('button', { hasText: /Apply \+ (Run|same seed)/ }).first();
    assert.ok(await btn.count(), 'proposal has an Apply + Run button');
    await btn.click();
    await page.waitForFunction(() => window.conceptApp.queue.items.some((i) => i.meta?.workflow === 'ai:klein-4b-t2i'), null, { timeout: 10000 });
    // The stored chat keeps the image's original preset id (no rewrite of old data).
    const c = await (await fetch(s.base + '/api/chats/c_oldchat01')).json();
    assert.equal(c.messages[0].images[0].preset, 'fast-concept');
  } finally { await ctx.close(); }
});

test('no page errors with the old state', () => {
  // The old result images are not in the mock's output folder (404 from /view); nothing else may fail.
  assert.deepEqual(errors.filter((e) => !/404 \(Not Found\) @ http:\/\/127\.0\.0\.1:\d+\/comfy\/view\?/.test(e)), []);
});
