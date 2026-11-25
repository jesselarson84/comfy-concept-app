// Batch 19 additions in the app: folder cards in Files, no ✓ in the workflow picker,
// Write / Talk / Expand on the Negative prompt too (Claude writes only that text),
// the floating Claude button as a chat that sets up the form, and keeping a Claude
// workflow as a preset after trying it (a bar after its first run + ⋮ Make more).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startStack, ROOT, pngBytes } from '../unit/helpers.js';
import { launch, toggleFiles } from './launch.js';

const SHOTS = path.join(ROOT, 'test/browser/screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
let s, browser, page;
const errors = [];
const j = async (method, url, body) => (await fetch(s.base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
const app = (fn, arg) => page.evaluate(fn, arg);
const resetClaude = () => fetch(s.claudeBase + '/mock/reset', { method: 'POST' });
const claudeReqs = async () => (await fetch(s.claudeBase + '/mock/requests')).json();

before(async () => {
  s = await startStack({ stepMs: 30, folderWorkflows: false, projects: true, claude: true });
  fs.mkdirSync(path.join(s.projectsDir, 'Apps', 'Cache'), { recursive: true });
  const cache = await j('POST', '/api/projects', { path: 'Apps/Cache' });
  s.mock.files.set('output/concept-app/c1.png', pngBytes());
  await s.app.history.add({ workflow: 'ai:z-image-turbo', prompt: 'a cache icon', images: [{ filename: 'c1.png', subfolder: 'concept-app', type: 'output' }], project: cache.id });
  await j('POST', '/api/claude/key', { key: 'sk-ant-test-0123456789abcdefghijklmnop' });
  await j('POST', '/api/claude', { enabled: true, limitUsd: 20, defaultModel: 'haiku' });
  browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.goto(s.base + '/');
  await page.waitForFunction(() => (window.conceptApp?.workflows?.length || 0) > 10 && window.conceptApp.current && window.conceptApp.claude.status?.enabled);
});
after(async () => { await browser?.close(); await s?.close(); });

test('Files: a folder is one card holding its projects; project names are smaller than the folder name', async () => {
  await toggleFiles(page);
  await page.waitForSelector('.hgroup-card .history-session');
  const sizes = await app(() => ({ folder: parseFloat(getComputedStyle(document.querySelector('.hgroup-card .hgroup')).fontSize), project: parseFloat(getComputedStyle(document.querySelector('.hgroup-card .history-session h3')).fontSize) }));
  assert.ok(sizes.folder > sizes.project, JSON.stringify(sizes));
  await page.screenshot({ path: path.join(SHOTS, 'b19b-folder-cards.png') });
  await toggleFiles(page);
});

test('workflow picker: the picked row is highlighted, with no ✓', async () => {
  await page.click('#preset-btn');
  await page.waitForSelector('#picker .ent.on');
  assert.equal(await page.locator('#picker .ent.on .i-check').count(), 0);
  await page.keyboard.press('Escape');
  await app(() => window.conceptApp.picker.close?.());
});

test('Negative prompt ⋮: Write prompt / Talk prompt / Expand like Prompt, plus Remove; Claude writes only the negative prompt', async () => {
  await page.click('#preset-btn'); await page.click('#picker .ent[data-preset="ai:flux1-dev-gguf"]').catch(() => {});
  await app(() => window.conceptApp.picker.close?.());
  await app(() => { const w = window.conceptApp.workflows.find((x) => x.ok && x.controls?.negative?.length); window.conceptApp.selectPreset(w.id, { remember: false }); window.conceptApp.panel.setNegOn(true); });
  await page.click('#neg-more');
  const acts = await page.$$eval('.amenu [data-act]', (b) => b.map((x) => x.dataset.act));
  for (const a of ['write-prompt', 'expand', 'remove-negative']) assert.ok(acts.includes(a), a);
  await page.click('.amenu [data-act="write-prompt"]');
  await page.waitForSelector('.claude-sheet[data-mode="negative"]');
  const before_ = await app(() => window.conceptApp.panel.state);
  await resetClaude();
  await page.fill('.claude-sheet .cl-input', 'keep it clean');
  await page.click('.claude-sheet [data-act="send"]');
  await page.waitForFunction(() => !document.querySelector('.claude-sheet'));
  const st = await app(() => window.conceptApp.panel.state);
  assert.equal(st.negative, 'blurry, low detail, watermark');
  assert.equal(st.prompt, before_.prompt); assert.equal(st.aspect, before_.aspect);
  assert.equal((await claudeReqs())[0].body.tools.at(-1).name, 'write_prompt');
  // Expand opens the negative prompt full screen
  await page.click('#neg-more'); await page.click('.amenu [data-act="expand"]');
  await page.waitForSelector('.prompt-editor:not([hidden]) .pe-text, #prompt-editor .pe-text');
  assert.equal(await page.inputValue('.pe-text'), 'blurry, low detail, watermark');
  await page.click('.pe-done');
});

test('the floating Claude chat sets up the form when asked (and closes Files behind it)', async () => {
  await app(() => sessionStorage.removeItem('claudeChat.v1'));
  await toggleFiles(page);
  await resetClaude();
  await page.click('.claude-fab');
  await page.waitForSelector('.claude-sheet[data-mode="chat"]');
  await page.fill('.claude-sheet .cl-input', 'SETUP a lighthouse with Klein');
  await page.click('.claude-sheet [data-act="send"]');
  await page.waitForSelector('.claude-sheet .cl-changed');
  assert.equal(await app(() => window.conceptApp.current.id), 'ai:klein-4b-t2i');
  assert.equal(await app(() => window.conceptApp.panel.state.prompt), 'a lighthouse at dawn');
  assert.equal(await app(() => window.conceptApp.historyView.on), false, 'Files closed so the form shows behind the chat');
  assert.equal(await page.isVisible('.claude-sheet'), true, 'the chat stays open');
  await page.screenshot({ path: path.join(SHOTS, 'b19b-chat.png') });
  await app(() => window.conceptApp.claude.chat.close());
});

test('a Claude workflow: Save bar after its first run, ⋮ Save workflow as preset in Make more; saving hides both', async () => {
  await app(() => { const w = window.conceptApp.workflows.find((x) => x.id === 'ai:z-image-turbo'); return window.conceptApp.claude.applyClaude({ actions: [{ type: 'graph', name: 'Rocket turntable', graph: w.workflow }] }); });
  assert.match(await app(() => window.conceptApp.current.id), /^claude:/);
  assert.equal(await page.isVisible('.cl-savebar'), false, 'not before a run');
  await page.fill('#prompt', 'a retro rocket'); await page.fill('#batch', '1'); await page.locator('#batch').dispatchEvent('change');
  await page.click('#btn-generate');
  await page.waitForSelector('.cl-savebar:not([hidden])', { timeout: 15000 });
  await page.waitForFunction(() => !window.conceptApp.lock.locked());
  await page.screenshot({ path: path.join(SHOTS, 'b19b-savebar.png') });
  // the result's ⋮: last in Make more
  await page.click('#thumbs .thumb.s-done');
  await page.click('.viewer [data-act="more"]');
  await page.waitForSelector('.amenu [data-act="save-workflow"]');
  const order = await page.$$eval('.amenu [data-act]', (b) => b.map((x) => x.dataset.act));
  assert.ok(order.indexOf('save-workflow') > order.indexOf('reuse') && order.indexOf('save-workflow') < order.indexOf('delete'), order.join());
  await page.screenshot({ path: path.join(SHOTS, 'b19b-result-menu.png') });
  await page.keyboard.press('Escape');
  await app(() => window.conceptApp.viewer.close());
  // the history entry keeps the workflow (Files can save it later)
  const hist = (await j('GET', '/api/history')).sessions.flatMap((x) => x.entries);
  assert.ok(hist.some((e) => e.claudeGraph?.name === 'Rocket turntable'));
  // Save as preset from the bar
  await page.click('.cl-savebar [data-act="save-claude"]');
  await page.waitForSelector('.save-preset');
  assert.equal(await page.inputValue('.save-preset input.sheet-input'), 'Rocket turntable copy');
  await page.fill('.save-preset input.sheet-input', 'Rocket turntable');
  await page.click('.save-preset [data-act="save"]');
  await page.waitForFunction(() => window.conceptApp.current?.id?.startsWith('graph:'));
  await page.waitForSelector('.cl-savebar', { state: 'hidden' });
  await page.click('#thumbs .thumb.s-done');
  await page.click('.viewer [data-act="more"]');
  await page.waitForSelector('.amenu [data-act="reuse"]');
  assert.equal(await page.locator('.amenu [data-act="save-workflow"]').count(), 0, 'saved: no more Save workflow');
  await page.keyboard.press('Escape');
  await app(() => window.conceptApp.viewer.close());
  assert.deepEqual(errors, []);
});
