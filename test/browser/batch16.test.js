// Batch 16 browser tests, updated for batch 17: Claude on the phone (never the
// real API - the server's SDK talks to test/mock-claude.js). Off by default and
// hidden; Settings asks for the key first and never shows it; prompt help from the
// prompt's ⋮ (Write prompt… / Talk prompt) in a sheet with the model switch;
// Claude fills the form and stops (orange marks until the run finishes, no
// summary, no Undo, no chat memory); voice that sends by itself; the floating
// Ask Claude button (answers only); Ask Claude from the viewer and from Files
// (back on the form with no stale Back step and the top bar in place); a built
// workflow as a one-off preset; variations into the batch (not started); the
// monthly limit message. Plus the node view fit fix.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startStack, ROOT } from '../unit/helpers.js';
import { launch, toggleFiles } from './launch.js';

const SHOTS = path.join(ROOT, 'test/browser/screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
const KEY = 'sk-ant-test-0123456789abcdefghijklmnop';
let s, browser, ctx, page;
const errors = [];

before(async () => {
  s = await startStack({ stepMs: 30, folderWorkflows: false, claude: true });
  browser = await launch();
  ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  // A stand-in for the phone's speech recognizer (Web Speech): hears two partials, then the user stops talking.
  await ctx.addInitScript(() => {
    class FakeRec {
      start() {
        window.__recStarted = (window.__recStarted || 0) + 1;
        const said = window.__say || 'make it rain at night';
        const res = (t, final) => { const r = [{ transcript: t }]; r.isFinal = final; return { results: [r] }; };
        setTimeout(() => this.onresult?.(res(said.split(' ').slice(0, 2).join(' '), false)), 80);
        setTimeout(() => this.onresult?.(res(said, true)), 400);
        this.t = setTimeout(() => this.onend?.(), window.__silenceMs || 900);
      }
      stop() { clearTimeout(this.t); setTimeout(() => this.onend?.(), 10); }
      abort() { clearTimeout(this.t); setTimeout(() => this.onend?.(), 10); }
    }
    window.SpeechRecognition = FakeRec; window.webkitSpeechRecognition = FakeRec; // Chrome has an unprefixed one too
  });
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.goto(s.base + '/');
  await page.waitForFunction(() => (window.conceptApp?.workflows?.length || 0) > 10 && window.conceptApp.current);
});
after(async () => { await browser?.close(); await s?.close(); });

const app = (fn, arg) => page.evaluate(fn, arg);
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `b16-${name}.png`) });
const comfyPrompts = async () => (await (await fetch(s.mockBase + '/mock/requests')).json()).filter((r) => r.path === '/prompt').length;
/** A finished picture in This session (the strip is empty again after a reload). */
async function ensureResult() {
  if (await page.locator('#thumbs .thumb.s-done').count()) return;
  await pick('ai:klein-4b-t2i');
  if (!(await page.inputValue('#prompt')).trim()) await page.fill('#prompt', 'a scout mech');
  await page.fill('#batch', '1'); await page.locator('#batch').dispatchEvent('change');
  await page.click('#btn-generate');
  await page.waitForSelector('#thumbs .thumb.s-done', { timeout: 15000 });
  await page.waitForFunction(() => !window.conceptApp.lock.locked());
}
const claudeReqs = async () => (await fetch(s.claudeBase + '/mock/requests')).json();
const resetClaude = () => fetch(s.claudeBase + '/mock/reset', { method: 'POST' });
async function pick(id) { await page.click('#preset-btn'); await page.click(`#picker .ent[data-preset="${id}"]`); await page.waitForFunction((x) => window.conceptApp.current?.id === x, id); }
async function reload() { await page.reload(); await page.waitForFunction(() => (window.conceptApp?.workflows?.length || 0) > 10 && window.conceptApp.current && window.conceptApp.claude?.status); }
/** The prompt's ⋮ -> a row (write-prompt, talk-prompt, expand, clear-prompt). */
async function promptMenu(act) { await page.click('#prompt-more'); await page.click(`.amenu [data-act="${act}"]`); }
/** Write prompt… : type, send; resolves when the sheet closed (form changed) or shows an answer / error. */
async function writePrompt(text) {
  await promptMenu('write-prompt');
  await page.waitForSelector('.claude-sheet[data-mode="prompt"]');
  await page.fill('.claude-sheet .cl-input', text);
  await page.click('.claude-sheet [data-act="send"]');
  await page.waitForFunction(() => !document.querySelector('.claude-sheet') || document.querySelector('.claude-sheet .cl-text, .claude-sheet .cl-error'), null, { timeout: 15000 });
}
const closeSheet = () => app(() => window.conceptApp.claude.sheet.close());
/** The top bar is on screen and the page frame never moved (only the form scrolls). */
const frameInPlace = () => app(() => ({ scrolled: document.scrollingElement.scrollTop, topBar: Math.round(document.querySelector('.topbar').getBoundingClientRect().top) }));

test('off by default: no floating button, no Claude in the prompt ⋮, the viewer or Files; nothing sent', async () => {
  assert.equal(await page.isVisible('#btn-settings'), true, 'gear in the top bar');
  assert.equal(await page.isVisible('.claude-fab'), false);
  await page.click('#prompt-more');
  assert.equal(await page.locator('.amenu [data-act="write-prompt"]').count(), 0);
  assert.equal(await page.locator('.amenu [data-act="expand"]').count(), 1);
  await page.keyboard.press('Escape');
  // a result to open in the viewer (and for Files later)
  await pick('ai:klein-4b-t2i');
  await page.fill('#prompt', 'a weathered scout mech crouched in a foggy pine forest');
  await page.fill('#batch', '2'); await page.locator('#batch').dispatchEvent('change');
  await page.click('#btn-generate');
  await page.waitForFunction(() => [...document.querySelectorAll('#thumbs .thumb')].filter((e) => e.className.includes('s-done')).length === 2, null, { timeout: 15000 });
  await page.click('#thumbs .thumb.s-done');
  await page.click('.viewer [data-act="more"]');
  assert.equal(await page.locator('.amenu [data-act="ask-claude"]').count(), 0);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.viewer', { state: 'hidden' });
  assert.equal((await claudeReqs()).length, 0);
});

test('Settings: turning Claude on with no key asks for the key first; the key never comes back', async () => {
  await page.click('#btn-settings');
  await page.waitForSelector('.settings-sheet');
  assert.match(await page.textContent('.settings-sheet'), /About \$0\.00 of \$20\.00 used this month/);
  assert.match(await page.textContent('.settings-sheet'), /platform\.claude\.com/);
  assert.match(await page.textContent('.settings-sheet'), /Reset to defaults when the app closes/);
  assert.doesNotMatch(await page.textContent('.settings-sheet'), /null|undefined/);
  assert.equal(await page.isChecked('#st-claude-on'), false);
  await page.check('#st-claude-on');
  await page.waitForSelector('#st-key');
  assert.match(await page.textContent('.settings-sheet'), /Add your API key below/);
  assert.equal(await app(() => document.activeElement?.id), 'st-key');
  assert.equal(await app(() => window.conceptApp.claude.fab.hidden), true, 'still off until the key is saved');
  await page.fill('#st-key', KEY);
  await page.click('[data-act="save-key"]');
  await page.waitForSelector('[data-key="saved"]');
  assert.match(await page.textContent('[data-key="saved"]'), /Saved on your PC/);
  assert.equal(await page.isChecked('#st-claude-on'), true);
  await page.waitForFunction(() => !window.conceptApp.claude.fab.hidden);
  await shot('settings');
  const html = await page.content();
  assert.doesNotMatch(html, /sk-ant-test/, 'the key is not in the page');
  assert.doesNotMatch(JSON.stringify(await app(() => window.conceptApp.claude.status)), /sk-ant/);
  await page.click('.settings-sheet [data-act="close"]');
});

test('Write prompt… (prompt ⋮): a sheet with the model switch, starting on the Settings default every time the app opens', async () => {
  await pick('ai:qwen-2512-t2i');
  assert.equal(await page.locator('#claude-box, #claude-host').count(), 0, 'no Claude box on the form');
  await promptMenu('write-prompt');
  await page.waitForSelector('.claude-sheet[data-mode="prompt"]');
  assert.equal(await page.getAttribute('.claude-sheet .cl-seg [data-model="haiku"]', 'aria-checked'), 'true');
  assert.equal(await page.locator('.claude-sheet .cl-pill [data-act="talk"]').count(), 1, 'the small mic inside the bar');
  assert.equal(await page.isDisabled('.claude-sheet [data-act="send"]'), true, 'send is off until there is text');
  await shot('write-prompt');
  await page.click('.claude-sheet .cl-seg [data-model="sonnet"]');
  await resetClaude();
  await page.fill('.claude-sheet .cl-input', 'QUESTION what does guidance do?');
  await page.click('.claude-sheet [data-act="send"]');
  await page.waitForSelector('.claude-sheet .cl-text');
  assert.equal((await claudeReqs())[0].body.model, 'claude-sonnet-5-5');
  assert.match(await page.textContent('.claude-sheet .cl-text'), /follow the prompt more closely/);
  assert.match(await page.textContent('.claude-sheet .cl-cost'), /Sonnet · /);
  await closeSheet();
  await reload();
  await promptMenu('write-prompt');
  assert.equal(await page.getAttribute('.claude-sheet .cl-seg [data-model="haiku"]', 'aria-checked'), 'true', 'back to the default after the app reopens');
  await closeSheet();
  await fetch(s.base + '/api/claude', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ defaultModel: 'opus' }) });
  await reload();
  await promptMenu('write-prompt');
  assert.equal(await page.getAttribute('.claude-sheet .cl-seg [data-model="opus"]', 'aria-checked'), 'true');
  await closeSheet();
  await fetch(s.base + '/api/claude', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ defaultModel: 'haiku' }) });
  await reload();
});

test('Claude fills in the form and stops: the sheet closes, orange marks only (no summary, no Undo), one-shot; the marks clear when the run finishes', async () => {
  await pick('ai:qwen-2512-t2i');
  await page.fill('#prompt', 'A weathered scout mech crouched in a foggy pine forest at dawn');
  await page.locator('#prompt').dispatchEvent('input');
  const queued = await comfyPrompts();
  await resetClaude();
  await writePrompt('Same mech but at night in heavy rain, tall for a phone wallpaper, more cinematic');
  assert.equal(await page.locator('.claude-sheet').count(), 0, 'the sheet closed: Claude changed the form');
  const st = await app(() => window.conceptApp.panel.state);
  assert.match(st.prompt, /night, heavy rain/);
  assert.equal(st.aspect, '16:9-portrait');
  assert.equal(st.res, '2k');
  assert.equal(st.negOn, true);
  assert.equal(await page.inputValue('#prompt'), st.prompt);
  assert.equal(await page.isVisible('#neg-row'), true, 'the negative prompt section is on');
  assert.equal(await page.textContent('#aspect-label'), '9:16');
  for (const sel of ['.prompt-field', '#neg-row', '#aspect-field']) assert.equal(await page.locator(`${sel}.claude-changed`).count(), 1, sel);
  assert.equal(await page.locator('.cl-reply, .cl-changes, [data-act="undo"], [data-act="start-over"]').count(), 0, 'no summary, no Undo, no chat');
  assert.equal(await comfyPrompts(), queued, 'nothing was queued: the user presses Run');
  await shot('applied');
  // one-shot: the next request carries no history
  await resetClaude();
  await writePrompt('QUESTION and the guidance?');
  assert.equal((await claudeReqs())[0].body.messages.length, 1);
  await closeSheet();
  // the orange marks stay until the run finishes
  await page.fill('#batch', '1'); await page.locator('#batch').dispatchEvent('change');
  await page.click('#btn-generate');
  await page.waitForFunction(() => window.conceptApp.lock.locked());
  assert.ok(await page.locator('.claude-changed').count() > 0, 'still marked while running');
  await page.waitForFunction(() => !window.conceptApp.lock.locked(), null, { timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll('.claude-changed').length === 0);
});

test('Talk prompt: listens at once, shows the words, and sends by itself when you stop talking; Cancel throws it away', async () => {
  await resetClaude();
  await app(() => { window.__say = 'QUESTION what is a negative prompt'; window.__silenceMs = 900; });
  await promptMenu('talk-prompt');
  await page.waitForSelector('.claude-sheet .cl-listen:not([hidden])');
  assert.match(await page.textContent('.claude-sheet .cl-listen'), /Listening…/);
  await page.waitForFunction(() => /what is a negative prompt/.test(document.querySelector('.claude-sheet .cl-words')?.textContent || ''), null, { timeout: 4000 });
  await shot('listening');
  await page.waitForFunction(() => /negative prompt/.test(document.querySelector('.claude-sheet .cl-you')?.textContent || '') && document.querySelector('.claude-sheet .cl-text'), null, { timeout: 10000 });
  const reqs = await claudeReqs();
  assert.equal(reqs.length, 1);
  assert.match(JSON.stringify(reqs[0].body.messages.at(-1)), /QUESTION what is a negative prompt/);
  await closeSheet();
  // Cancel throws it away
  await resetClaude();
  await app(() => { window.__silenceMs = 3000; });
  await promptMenu('talk-prompt');
  await page.click('.claude-sheet [data-act="cancel-listen"]');
  await page.waitForSelector('.claude-sheet .cl-listen', { state: 'hidden' });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await claudeReqs()).length, 0, 'nothing sent after Cancel');
  await closeSheet();
});

test('the floating Ask Claude button: on every screen; answers only (look-only tools), the form never changes', async () => {
  const fab = await page.locator('.claude-fab').boundingBox();
  const run = await page.locator('.actionbar').boundingBox();
  assert.ok(fab.y + fab.height <= run.y, 'above the Run bar on the form');
  assert.ok(fab.x + fab.width > 380, 'bottom right');
  const before_ = await app(() => JSON.stringify(window.conceptApp.panel.state));
  await resetClaude();
  await page.click('.claude-fab');
  await page.waitForSelector('.claude-sheet[data-mode="question"]');
  assert.match(await page.textContent('.claude-sheet'), /Ask Claude/);
  await page.fill('.claude-sheet .cl-input', 'make it rain');
  await page.click('.claude-sheet [data-act="send"]');
  await page.waitForSelector('.claude-sheet .cl-text, .claude-sheet .cl-error');
  assert.match(await page.textContent('.claude-sheet .cl-cost'), /answers only, never changes the form/);
  assert.equal(await app(() => JSON.stringify(window.conceptApp.panel.state)), before_, 'nothing changed');
  const req = (await claudeReqs())[0].body;
  assert.deepEqual(req.tools.map((t) => t.name), ['get_form', 'list_presets', 'get_preset', 'search_history', 'view_picture']);
  await shot('question');
  await closeSheet();
  // also on Files (in the corner)
  await toggleFiles(page);
  await page.waitForSelector('.history .thumb[data-id]');
  assert.equal(await page.isVisible('.claude-fab'), true);
  await app(() => window.conceptApp.historyView.close());
});

test('viewer: ⋮ Ask Claude about this -> Fix this result (Opus, picture attached) -> back on the form, no stale Back step', async () => {
  await ensureResult();
  await page.click('#thumbs .thumb.s-done');
  await page.click('.viewer [data-act="more"]');
  assert.equal(await page.locator('.amenu [data-act="ask-claude"]').count(), 1);
  await page.click('.amenu [data-act="ask-claude"]');
  await page.waitForSelector('.claude-sheet[data-mode="fix"]');
  assert.match(await page.textContent('.claude-sheet'), /Fix this result/);
  assert.match(await page.textContent('.claude-sheet'), /Opus · always/);
  assert.match(await page.textContent('.claude-sheet .cl-attach'), /This picture is attached.*seed \d+/s);
  await shot('viewer-sheet');
  await resetClaude();
  await page.fill('.claude-sheet .cl-input', 'The hands look melted and the armor is way too clean');
  await page.click('.claude-sheet [data-act="send"]');
  await page.waitForSelector('.claude-sheet', { state: 'detached', timeout: 10000 });
  await page.waitForSelector('.viewer', { state: 'hidden' });
  const req = (await claudeReqs())[0].body;
  assert.equal(req.model, 'claude-opus-5-5');
  const img = req.messages.at(-1).content.find((c) => c.type === 'image');
  assert.ok(img && img.source.media_type === 'image/jpeg' && img.source.data.length > 50, 'the picture went along (JPEG)');
  assert.match(await app(() => window.conceptApp.panel.state.prompt), /five-fingered hands/);
  assert.equal(await page.locator('.prompt-field.claude-changed').count(), 1);
  assert.equal(await app(() => history.state?.viewer || null), null, 'the viewer left no Back entry');
  assert.deepEqual(await frameInPlace(), { scrolled: 0, topBar: 0 });
});

test('Files: Claude button (no ⋮ in the bar) sends the pictures in tap order; a question is answered in the sheet; a merge builds a one-off workflow and lands on the form', async () => {
  await toggleFiles(page);
  await page.waitForSelector('.history .thumb[data-id]');
  const ids = await page.$$eval('.history .thumb[data-id]', (b) => b.map((x) => x.dataset.id));
  assert.ok(ids.length >= 2);
  await app((x) => { const hv = window.conceptApp.historyView; hv.startSelect(x[1]); hv.toggle(x[0]); }, ids);
  assert.equal(await page.isVisible('.sel-bar [data-act="ask-claude"]'), true);
  assert.equal(await page.locator('.sel-bar [data-act="more"]').count(), 0, 'batch 17: no ⋮ in the selection bar');
  await page.click('.sel-bar [data-act="ask-claude"]');
  await page.waitForSelector('.claude-sheet[data-mode="files"]');
  assert.match(await page.textContent('.claude-sheet'), /Ask Claude about 2 pictures/);
  assert.deepEqual(await page.$$eval('.claude-sheet .cl-pick b', (b) => b.map((x) => x.textContent)), ['1', '2']);
  await shot('files-sheet');
  // a question: answered right in the sheet, nothing changed
  await resetClaude();
  await page.fill('.claude-sheet .cl-input', 'QUESTION which one is sharper?');
  await page.click('.claude-sheet [data-act="send"]');
  await page.waitForSelector('.claude-sheet .cl-out .cl-text');
  assert.match(await page.textContent('.claude-sheet .cl-out'), /2 picture\(s\)/);
  const q = (await claudeReqs())[0].body;
  assert.equal(q.model, 'claude-opus-5-5');
  // tap order: picture 1 is the one tapped first
  assert.match(JSON.stringify(q.messages.at(-1).content), new RegExp(`Picture 1[^]*Picture 2`));
  // merge: Claude builds a workflow, checked against ComfyUI, loaded as a one-off preset
  await page.fill('.claude-sheet .cl-input', 'The robot from 3, lighting from 1, colours from 2');
  await page.click('.claude-sheet [data-act="send"]');
  await page.waitForSelector('.claude-sheet', { state: 'detached', timeout: 10000 });
  await page.waitForFunction(() => window.conceptApp.current?.claude);
  assert.equal(await app(() => window.conceptApp.current.label), 'Merge 4 looks');
  assert.equal(await page.textContent('#preset-crumb'), 'Claude');
  assert.equal(await page.locator('#preset-btn.one-off').count(), 1);
  assert.equal(await page.isVisible('#history-host'), false, 'back on the form');
  assert.equal(await app(() => history.state?.history || null), null, 'Files left no Back entry');
  assert.deepEqual(await frameInPlace(), { scrolled: 0, topBar: 0 });
  assert.equal(await page.isVisible('#preset-btn'), true, 'the top bar is there');
  const refsFilled = await app(() => Object.values(window.conceptApp.refs.values).filter(Boolean).length);
  assert.ok(refsFilled >= 1, 'the pictures went into its slots');
  await shot('files-result');
  await pick('ai:klein-4b-t2i');
});

test('variations: N jobs land in the batch NOT started, each editable / removable', async () => {
  await pick('ai:klein-4b-t2i');
  const before_ = (await (await fetch(s.base + '/api/schedule')).json());
  await resetClaude();
  await writePrompt('Give me 6 takes on this: 3 lighting moods, each from a low and a high angle');
  await page.waitForSelector('.cl-variations', { timeout: 15000 });
  assert.equal((await claudeReqs())[0].body.model, 'claude-opus-5-5', 'variations use Opus');
  assert.match(await page.textContent('.cl-variations'), /Added 6 jobs to the batch — not started/);
  assert.equal(await page.locator('.cl-variations .cl-job').count(), 6);
  const sched = await (await fetch(s.base + '/api/schedule')).json();
  const added = sched.jobs.slice(before_.jobs.length);
  assert.equal(added.length, 6);
  assert.ok(added.every((j) => j.status === 'waiting'));
  assert.equal(sched.state, 'idle', 'not started');
  assert.equal(new Set(added.map((j) => j.meta.prompt)).size, 6, 'each job differs');
  assert.equal(await page.textContent('#batch-count'), String(before_.jobs.filter((j) => j.status === 'waiting').length + 6));
  await shot('variations');
  // Remove all takes them out again
  await page.click('.cl-variations [data-act="remove-all"]');
  await page.waitForFunction(async (n) => (await (await fetch('/api/schedule')).json()).jobs.length === n, before_.jobs.length);
});

test('monthly limit reached: a plain message in the sheet, nothing sent', async () => {
  const st = await (await fetch(s.base + '/api/claude')).json();
  await fetch(s.base + '/api/claude', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limitUsd: Math.floor(st.spentUsd * 100) / 100 }) });
  await resetClaude();
  await writePrompt('make it rain');
  assert.match(await page.textContent('.claude-sheet .cl-error'), /Monthly limit reached: about \$[\d.]+ of \$[\d.]+ used\. Claude is back on/);
  assert.equal((await claudeReqs()).length, 0);
  await closeSheet();
  await page.click('#btn-settings');
  await page.waitForSelector('.settings-sheet');
  assert.match(await page.textContent('.settings-sheet'), /The limit is reached/);
  await shot('limit');
  await page.click('.settings-sheet [data-act="close"]');
  await fetch(s.base + '/api/claude', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limitUsd: 20 }) });
});

test('switching Claude off hides everything again', async () => {
  await page.click('#btn-settings');
  await page.uncheck('#st-claude-on');
  await page.waitForFunction(() => window.conceptApp.claude.fab.hidden);
  await page.click('.settings-sheet [data-act="close"]');
  await page.click('#prompt-more');
  assert.equal(await page.locator('.amenu [data-act="write-prompt"], .amenu [data-act="talk-prompt"]').count(), 0);
  await page.keyboard.press('Escape');
  await ensureResult();
  await page.click('#thumbs .thumb.s-done');
  await page.click('.viewer [data-act="more"]');
  assert.equal(await page.locator('.amenu [data-act="ask-claude"]').count(), 0);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.waitForSelector('.viewer', { state: 'hidden' });
  await toggleFiles(page);
  await page.waitForSelector('.history .thumb[data-id]');
  const id = await page.$eval('.history .thumb[data-id]', (b) => b.dataset.id);
  await app((x) => window.conceptApp.historyView.startSelect(x), id);
  assert.equal(await page.isVisible('.sel-bar [data-act="ask-claude"]'), false);
  await app(() => window.conceptApp.historyView.close()); // close() leaves the selection too, in one Back step
});

test('the node view fits the whole graph into view when it is loaded or shown', async () => {
  await pick('ai:z-image-turbo');
  await page.click('#btn-canvas');
  await page.waitForSelector('#node-view iframe');
  const frame = await (await page.$('#node-view iframe')).contentFrame();
  await frame.waitForLoadState('domcontentloaded');
  // A stand-in for ComfyUI's app with LiteGraph's DragAndScale (screen = (pos + offset) * scale).
  // Like on the phone, a loaded graph lands far outside the view at 90 % zoom.
  await frame.evaluate(() => {
    const el = document.getElementById('graph'); el.style.height = '600px';
    const nodes = [];
    window.app = {
      graph: { _nodes: nodes, arrange() {}, setDirtyCanvas() {} },
      canvas: { canvas: el, ds: { scale: 0.9, offset: [0, 0] }, setDirty() {} },
      async loadApiJson(wf) { nodes.length = 0; Object.keys(wf).forEach((k, i) => nodes.push({ id: k, pos: [3000 + (i % 4) * 320, 2400 + Math.floor(i / 4) * 220], size: [280, 160] })); },
    };
    window.inView = () => { const { ds } = window.app.canvas, w = el.clientWidth, h = el.clientHeight; return window.app.graph._nodes.filter((n) => { const x = (n.pos[0] + ds.offset[0]) * ds.scale, y = (n.pos[1] + ds.offset[1]) * ds.scale; return x >= 0 && y >= 0 && x + n.size[0] * ds.scale <= w + 1 && y + n.size[1] * ds.scale <= h + 1; }).length; };
  });
  await frame.waitForFunction(() => window.app.graph._nodes.length > 0, null, { timeout: 25000 });
  await frame.waitForFunction(() => window.inView() === window.app.graph._nodes.length, null, { timeout: 5000 });
  const n = await frame.evaluate(() => ({ all: window.app.graph._nodes.length, inView: window.inView() }));
  assert.ok(n.all >= 5, `nodes loaded: ${n.all}`);
  assert.equal(n.inView, n.all, 'every node within the visible canvas');
  // shown again after being scrolled away: fitted again
  await page.click('#btn-canvas');
  await frame.evaluate(() => { window.app.canvas.ds.offset = [-9000, -9000]; });
  await page.click('#btn-canvas');
  await frame.waitForFunction(() => window.inView() === window.app.graph._nodes.length, null, { timeout: 5000 });
  await page.click('#btn-canvas');
});

test('no page errors in the batch 16 run', () => { assert.deepEqual(errors, []); });
