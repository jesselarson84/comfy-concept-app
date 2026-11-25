// Batch 16 browser tests: Claude on the phone (never the real API - the server's
// SDK talks to test/mock-claude.js). Off by default and hidden; Settings asks for
// the key first and never shows it; the model switch; filling the form + one Undo;
// voice that sends by itself; Ask Claude from the viewer and from Files; a built
// workflow as a one-off preset; variations into the batch (not started); the
// monthly limit message. Plus the node view fit fix (item 11).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startStack, ROOT } from '../unit/helpers.js';
import { launch, menuAct } from './launch.js';

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
async function reload() { await page.reload(); await page.waitForFunction(() => (window.conceptApp?.workflows?.length || 0) > 10 && window.conceptApp.current && window.conceptApp.claude); }
async function sayToClaude(text) {
  await page.fill('#claude-box .cl-input', text);
  await page.click('#claude-box [data-act="talk"]');
  await page.waitForSelector('#claude-box .cl-reply, #claude-box .cl-error', { timeout: 10000 });
}

test('off by default: no Claude box, no Ask Claude in the viewer or Files, nothing sent', async () => {
  assert.equal(await page.isVisible('#btn-settings'), true, 'gear in the top bar');
  assert.equal(await page.isVisible('#claude-host'), false);
  assert.equal(await page.locator('#claude-box').count(), 0);
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
  assert.doesNotMatch(await page.textContent('.settings-sheet'), /null|undefined/);
  assert.equal(await page.isChecked('#st-claude-on'), false);
  await page.check('#st-claude-on');
  await page.waitForSelector('#st-key');
  assert.match(await page.textContent('.settings-sheet'), /Add your API key below/);
  assert.equal(await app(() => document.activeElement?.id), 'st-key');
  assert.equal(await page.isVisible('#claude-host'), false, 'still off until the key is saved');
  await page.fill('#st-key', KEY);
  await page.click('[data-act="save-key"]');
  await page.waitForSelector('[data-key="saved"]');
  assert.match(await page.textContent('[data-key="saved"]'), /Saved on your PC/);
  assert.equal(await page.isChecked('#st-claude-on'), true);
  await page.waitForSelector('#claude-box');
  await shot('settings');
  const html = await page.content();
  assert.doesNotMatch(html, /sk-ant-test/, 'the key is not in the page');
  assert.doesNotMatch(JSON.stringify(await app(() => window.conceptApp.claude.status)), /sk-ant/);
  await page.click('.settings-sheet [data-act="close"]');
});

test('the Claude box sits under Negative prompt; model switch starts on the Settings default every time', async () => {
  await pick('ai:qwen-2512-t2i');
  const order = await app(() => { const n = document.querySelector('#neg-row').getBoundingClientRect(), c = document.querySelector('#claude-box').getBoundingClientRect(), a = document.querySelector('#aspect-field').getBoundingClientRect(); return { below: c.top >= n.bottom, aboveAspect: c.bottom <= a.top }; });
  assert.deepEqual(order, { below: true, aboveAspect: true });
  assert.equal(await page.getAttribute('#claude-box .cl-seg [data-model="haiku"]', 'aria-checked'), 'true');
  await page.click('#claude-box .cl-seg [data-model="sonnet"]');
  await resetClaude();
  await sayToClaude('QUESTION what does guidance do?');
  assert.equal((await claudeReqs())[0].body.model, 'claude-sonnet-5-5');
  assert.match(await page.textContent('#claude-box .cl-reply'), /follow the prompt more closely/);
  assert.match(await page.textContent('#claude-box .cl-cost'), /Sonnet · /);
  assert.equal(await page.locator('#claude-box [data-act="undo"]').count(), 0, 'a question changes nothing, no Undo');
  await reload();
  assert.equal(await page.getAttribute('#claude-box .cl-seg [data-model="haiku"]', 'aria-checked'), 'true', 'back to the default after the app reopens');
  await fetch(s.base + '/api/claude', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ defaultModel: 'opus' }) });
  await reload();
  assert.equal(await page.getAttribute('#claude-box .cl-seg [data-model="opus"]', 'aria-checked'), 'true');
  await fetch(s.base + '/api/claude', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ defaultModel: 'haiku' }) });
  await reload();
});

test('Claude fills in the form and stops: orange marks, "Changed N things", cost; one Undo reverts it all', async () => {
  await pick('ai:qwen-2512-t2i');
  await page.fill('#prompt', 'A weathered scout mech crouched in a foggy pine forest at dawn');
  await page.locator('#prompt').dispatchEvent('input');
  const before_ = await app(() => ({ prompt: window.conceptApp.panel.state.prompt, aspect: window.conceptApp.panel.state.aspect, res: window.conceptApp.panel.state.res, neg: window.conceptApp.panel.state.negOn }));
  const queued = await comfyPrompts();
  await resetClaude();
  await sayToClaude('Same mech but at night in heavy rain, tall for a phone wallpaper, more cinematic');
  const st = await app(() => window.conceptApp.panel.state);
  assert.match(st.prompt, /night, heavy rain/);
  assert.equal(st.aspect, '16:9-portrait');
  assert.equal(st.res, '2k');
  assert.equal(st.negOn, true);
  assert.equal(await page.inputValue('#prompt'), st.prompt);
  assert.equal(await page.textContent('#aspect-label'), '9:16');
  assert.match(await page.textContent('#claude-box .cl-reply-head'), /Changed 4 things/);
  assert.match(await page.textContent('#claude-box .cl-changes'), /prompt rewritten · negative: “bright daylight, cartoon” · aspect 9:16 · 2K/);
  assert.match(await page.textContent('#claude-box .cl-cost'), /Haiku · (about|under) \$/);
  for (const sel of ['.prompt-field', '#neg-row', '#aspect-field']) assert.equal(await page.locator(`${sel}.claude-changed`).count(), 1, sel);
  assert.equal(await comfyPrompts(), queued, 'nothing was queued: the user presses Run');
  assert.match(await page.textContent('#claude-box .cl-mem'), /Remembers this chat until you close the app/);
  await shot('applied');
  // one Undo reverts everything this reply changed
  await page.click('#claude-box [data-act="undo"]');
  await page.waitForFunction(() => document.querySelectorAll('.claude-changed').length === 0);
  const after_ = await app(() => ({ prompt: window.conceptApp.panel.state.prompt, aspect: window.conceptApp.panel.state.aspect, res: window.conceptApp.panel.state.res, neg: window.conceptApp.panel.state.negOn }));
  assert.deepEqual(after_, before_);
  assert.equal(await page.inputValue('#prompt'), before_.prompt);
  // memory goes along with the next request
  await resetClaude();
  await sayToClaude('QUESTION and the guidance?');
  const m = (await claudeReqs())[0].body.messages;
  assert.equal(m[0].content, 'Same mech but at night in heavy rain, tall for a phone wallpaper, more cinematic');
  assert.match(m[1].content, /Changed: prompt rewritten/);
  // Start over clears the chat
  await page.click('#claude-box [data-act="start-over"]');
  assert.equal(await page.locator('#claude-box .cl-reply').count(), 0);
  assert.equal(await app(() => window.conceptApp.claude.box.memory.length), 0);
});

test('voice: the mic listens, shows the words, and sends by itself when you stop talking', async () => {
  await resetClaude();
  await app(() => { window.__say = 'QUESTION what is a negative prompt'; window.__silenceMs = 900; });
  await page.click('#claude-box [data-act="talk"]'); // empty box: the button is the mic
  await page.waitForSelector('#claude-box .cl-listen:not([hidden])');
  assert.match(await page.textContent('#claude-box .cl-listen'), /Listening…/);
  await page.waitForFunction(() => /what is a negative prompt/.test(document.querySelector('#claude-box .cl-words')?.textContent || ''), null, { timeout: 4000 });
  await shot('listening');
  await page.waitForFunction(() => /negative prompt/.test(document.querySelector('#claude-box .cl-you')?.textContent || '') && document.querySelector('#claude-box .cl-reply'), null, { timeout: 10000 });
  const reqs = await claudeReqs();
  assert.equal(reqs.length, 1);
  assert.match(JSON.stringify(reqs[0].body.messages.at(-1)), /QUESTION what is a negative prompt/);
  // Cancel throws it away
  await resetClaude();
  await app(() => { window.__silenceMs = 3000; });
  await page.click('#claude-box [data-act="talk"]');
  await page.click('#claude-box [data-act="cancel-listen"]');
  await page.waitForSelector('#claude-box .cl-listen', { state: 'hidden' });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await claudeReqs()).length, 0, 'nothing sent after Cancel');
});

test('viewer: ⋮ Ask Claude about this -> Fix this result (Opus, picture attached) -> back on the form', async () => {
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
  await page.click('.claude-sheet [data-act="talk"]');
  await page.waitForSelector('.claude-sheet', { state: 'detached', timeout: 10000 });
  await page.waitForSelector('.viewer', { state: 'hidden' });
  const req = (await claudeReqs())[0].body;
  assert.equal(req.model, 'claude-opus-5-5');
  const img = req.messages.at(-1).content.find((c) => c.type === 'image');
  assert.ok(img && img.source.media_type === 'image/jpeg' && img.source.data.length > 50, 'the picture went along (JPEG)');
  assert.match(await app(() => window.conceptApp.panel.state.prompt), /five-fingered hands/);
  assert.match(await page.textContent('#claude-box .cl-reply'), /same seed/);
});

test('Files: the selection bar\'s Claude button sends the pictures in tap order; a question is answered in the sheet; a merge builds a one-off workflow', async () => {
  await page.click('#btn-history');
  await page.waitForSelector('.history .thumb[data-id]');
  const ids = await page.$$eval('.history .thumb[data-id]', (b) => b.map((x) => x.dataset.id));
  assert.ok(ids.length >= 2);
  await app((x) => { const hv = window.conceptApp.historyView; hv.startSelect(x[1]); hv.toggle(x[0]); }, ids);
  assert.equal(await page.isVisible('.sel-bar [data-act="ask-claude"]'), true);
  await page.click('.sel-bar [data-act="ask-claude"]');
  await page.waitForSelector('.claude-sheet[data-mode="files"]');
  assert.match(await page.textContent('.claude-sheet'), /Ask Claude about 2 pictures/);
  assert.deepEqual(await page.$$eval('.claude-sheet .cl-pick b', (b) => b.map((x) => x.textContent)), ['1', '2']);
  await shot('files-sheet');
  // a question: answered right in the sheet, nothing changed
  await resetClaude();
  await page.fill('.claude-sheet .cl-input', 'QUESTION which one is sharper?');
  await page.click('.claude-sheet [data-act="talk"]');
  await page.waitForSelector('.claude-sheet .cl-answer .cl-text');
  assert.match(await page.textContent('.claude-sheet .cl-answer'), /2 picture\(s\)/);
  const q = (await claudeReqs())[0].body;
  assert.equal(q.model, 'claude-opus-5-5');
  // tap order: picture 1 is the one tapped first
  assert.match(JSON.stringify(q.messages.at(-1).content), new RegExp(`Picture 1[^]*Picture 2`));
  // merge: Claude builds a workflow, checked against ComfyUI, loaded as a one-off preset
  await page.fill('.claude-sheet .cl-input', 'The robot from 3, lighting from 1, colours from 2');
  await page.click('.claude-sheet [data-act="talk"]');
  await page.waitForSelector('.claude-sheet', { state: 'detached', timeout: 10000 });
  await page.waitForFunction(() => window.conceptApp.current?.claude);
  assert.equal(await app(() => window.conceptApp.current.label), 'Merge 4 looks');
  assert.equal(await page.textContent('#preset-crumb'), 'Claude ›');
  assert.equal(await page.locator('#preset-btn.one-off').count(), 1);
  assert.equal(await page.isVisible('#history-host'), false, 'back on the form');
  assert.match(await page.textContent('#claude-box .cl-built'), /Checked against your ComfyUI: every node and model is installed/);
  assert.equal(await page.locator('#claude-box [data-act="save-claude-preset"]').count(), 1);
  assert.equal(await page.locator('#claude-box [data-act="open-node-view"]').count(), 1);
  const refsFilled = await app(() => Object.values(window.conceptApp.refs.values).filter(Boolean).length);
  assert.ok(refsFilled >= 1, 'the pictures went into its slots');
  await shot('files-result');
  // Undo removes the one-off preset again
  await page.click('#claude-box [data-act="undo"]');
  await page.waitForFunction(() => !window.conceptApp.current?.claude);
  assert.equal(await app(() => window.conceptApp.workflows.some((w) => w.claude)), false);
});

test('variations: N jobs land in the batch NOT started, each editable / removable', async () => {
  await pick('ai:klein-4b-t2i');
  const before_ = (await (await fetch(s.base + '/api/schedule')).json());
  await resetClaude();
  await page.fill('#claude-box .cl-input', 'Give me 6 takes on this: 3 lighting moods, each from a low and a high angle');
  await page.click('#claude-box [data-act="talk"]');
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
  // Edit opens one in the form (batch 13 edit bar)
  await page.click('.cl-variations .cl-job:nth-child(3) [data-act="edit-job"]');
  await page.waitForSelector('#edit-bar:not([hidden])');
  assert.match(await app(() => window.conceptApp.panel.state.prompt), /moonlit blue fog/i);
  await page.click('#btn-edit-cancel');
  // Undo on the reply removes the 6 jobs again
  await page.click('#claude-box [data-act="undo"]');
  await page.waitForFunction(async (n) => (await (await fetch('/api/schedule')).json()).jobs.length === n, before_.jobs.length);
});

test('monthly limit reached: a plain message, nothing sent', async () => {
  const st = await (await fetch(s.base + '/api/claude')).json();
  await fetch(s.base + '/api/claude', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limitUsd: Math.floor(st.spentUsd * 100) / 100 }) });
  await resetClaude();
  await sayToClaude('make it rain');
  assert.match(await page.textContent('#claude-box .cl-error'), /Monthly limit reached: about \$[\d.]+ of \$[\d.]+ used\. Claude is back on/);
  assert.equal((await claudeReqs()).length, 0);
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
  await page.waitForFunction(() => document.querySelector('#claude-host').hidden);
  await page.click('.settings-sheet [data-act="close"]');
  await ensureResult();
  await page.click('#thumbs .thumb.s-done');
  await page.click('.viewer [data-act="more"]');
  assert.equal(await page.locator('.amenu [data-act="ask-claude"]').count(), 0);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.waitForSelector('.viewer', { state: 'hidden' });
  await page.click('#btn-history');
  await page.waitForSelector('.history .thumb[data-id]');
  const id = await page.$eval('.history .thumb[data-id]', (b) => b.dataset.id);
  await app((x) => window.conceptApp.historyView.startSelect(x), id);
  assert.equal(await page.isVisible('.sel-bar [data-act="ask-claude"]'), false);
  await app(() => { window.conceptApp.historyView.endSelect(); window.conceptApp.historyView.close(); });
});

test('item 11: the node view fits the whole graph into view when it is loaded or shown', async () => {
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
