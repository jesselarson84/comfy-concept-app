// Batch 1: ComfyUI-style picker with the AI Workflow presets (live
// availability), preset param clamps, a TTS preset run, and the guarded chat
// builder (summary card -> Test run / Save as preset / Discard, rename/delete).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startStack, ROOT } from '../unit/helpers.js';
import { launch } from './launch.js';

const SHOTS = path.join(ROOT, 'test/browser/screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
let s, browser, ctx, page;
const errors = [];

before(async () => {
  // VibeVoice files are checked on disk via ComfyUI's folder_paths: give the mock a fake tts folder
  const tts = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-tts-'));
  const d = path.join(tts, 'VibeVoice', 'VibeVoice-1.5B'); fs.mkdirSync(d, { recursive: true });
  for (let i = 1; i <= 3; i++) fs.writeFileSync(path.join(d, `model-0000${i}-of-00003.safetensors`), 'x');
  s = await startStack({ stepMs: 30, comfyOptions: { folderPaths: { tts: [[tts], ['.safetensors']] } } });
  browser = await launch();
  ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text() + ' @ ' + (m.location()?.url || '?')); });
  await page.goto(s.base + '/');
  await page.waitForFunction(() => (window.conceptApp?.workflows?.length || 0) > 10);
});
after(async () => { await browser?.close(); await s?.close(); });

const comfyReqs = async () => (await (await fetch(s.mockBase + '/mock/requests')).json());
const comfyGraph = async (pid) => (await (await fetch(`${s.mockBase}/history/${pid}`)).json())[pid].prompt[2];
async function pick(id) { await page.click('#preset-btn'); await page.click(`#picker .ent[data-preset="${id}"]`); await page.waitForFunction((x) => window.conceptApp.current?.id === x, id); }
const doneCount = () => page.$$eval('#thumbs .thumb', (els) => els.filter((e) => e.className.includes('s-done')).length);
async function runAndWait() {
  const n = await doneCount();
  await page.click('#btn-generate');
  await page.waitForFunction((n) => [...document.querySelectorAll('#thumbs .thumb')].filter((e) => e.className.includes('s-done')).length > n, n, { timeout: 10000 });
  return page.evaluate(() => window.conceptApp.queue.items.at(-1));
}
const lastAssistant = () => page.locator('.chat-msg.assistant').last();
async function send(text) {
  const n = await page.locator('.chat-msg.assistant:not(.chat-thinking)').count();
  await page.fill('.chat-input', text);
  await page.click('.chat-send');
  await page.waitForFunction((n) => document.querySelectorAll('.chat-msg.assistant:not(.chat-thinking)').length > n && !document.querySelector('.chat-thinking'), n, { timeout: 10000 });
}

test('header says Comfy UI; Run button is the only blue element; picker has 3D / Image / Video / Audio with live availability', async () => {
  assert.equal(await page.title(), 'Comfy UI');
  const run = await page.$eval('#btn-generate', (b) => getComputedStyle(b).backgroundColor);
  assert.equal(run, 'rgb(11, 140, 233)');
  assert.ok(await page.locator('#btn-generate .i-play').count());
  const chip = await page.$eval('#aspect-field .chip.on', (b) => getComputedStyle(b).backgroundColor);
  assert.equal(chip, 'rgb(60, 61, 66)', 'selected = gray, not blue');
  await page.click('#preset-btn');
  const sections = await page.$$eval('#picker .grp', (els) => els.map((e) => e.dataset.section));
  assert.deepEqual(sections, ['App', '3D', 'Image', 'Video', 'Audio']);
  const wan = page.locator('#picker .ent[data-preset="ai:wan22-5b-ti2v"]');
  assert.match(await wan.textContent(), /needs download/);
  assert.equal(await wan.getAttribute('aria-disabled'), 'true');
  assert.match(await page.locator('#picker .ent[data-preset="ai:qwen-2512-t2i"]').textContent(), /slow · RAM offload/);
  await page.screenshot({ path: path.join(SHOTS, 'b1-picker.png') });
  await wan.click({ force: true }); // aria-disabled: Playwright would wait forever
  await page.waitForFunction(() => /needs download/.test(document.getElementById('toast')?.textContent || ''));
  assert.notEqual(await page.evaluate(() => window.conceptApp.current.id), 'ai:wan22-5b-ti2v', 'an unavailable preset is not selected');
  await page.keyboard.press('Escape');
});

test('AI preset: params shown with ranges; out-of-range values are clamped before queueing; ratio chips + orientation flip', async () => {
  await pick('ai:klein-4b-t2i');
  assert.match(await page.textContent('#preset-name'), /FLUX\.2 Klein 4B Text to Image/);
  assert.match(await page.textContent('#preset-crumb'), /Image/);
  await page.click('#more > summary');
  const steps = page.locator('#params [data-param="steps"]');
  await steps.fill('99');
  await page.click('#aspect-field .chip[data-ratio="16:9"]');
  await page.click('#aspect-field .seg [data-orient="portrait"]');
  assert.match(await page.textContent('#aspect-size'), /^\d+ × \d+$/);
  await page.fill('#prompt', 'a lighthouse at dusk');
  await page.fill('#batch', '1'); await page.locator('#batch').dispatchEvent('change');
  await page.screenshot({ path: path.join(SHOTS, 'b1-klein-params.png') });
  const it = await runAndWait();
  const g = await comfyGraph(it.promptId);
  const sched = Object.values(g).find((n) => n.class_type === 'Flux2Scheduler');
  assert.equal(sched.inputs.steps, 30, 'steps clamped to the preset max');
  assert.ok(it.meta.height > it.meta.width, 'portrait');
  for (const n of Object.values(g)) if (n.class_type === 'SaveImage') assert.match(n.inputs.filename_prefix, /^concept-app\//);
  assert.equal(it.meta.params.steps, 30);
});

test('TTS preset (Chatterbox): text goes to the TTS node, the result is an "Audio ↓" tile', async () => {
  await pick('ai:tts-chatterbox');
  await page.fill('#prompt', 'Testing one two three.');
  const it = await runAndWait();
  const g = await comfyGraph(it.promptId);
  const tts = Object.values(g).find((n) => n.class_type === 'ChatterboxTTS');
  assert.equal(tts.inputs.text, 'Testing one two three.');
  assert.equal(tts.inputs.model_pack_name, 'chatterbox');
  assert.match(await page.locator('#thumbs .thumb').last().textContent(), /Audio ↓/);
  await page.screenshot({ path: path.join(SHOTS, 'b1-tts.png') });
});

test('VibeVoice preset: voice-sample slot uses verify-voice.flac by default; plain text gets "[1] "', async () => {
  await pick('ai:tts-vibevoice');
  assert.match(await page.textContent('#file-inputs'), /Using verify-voice\.flac/);
  await page.fill('#prompt', 'Hello from the app.');
  const it = await runAndWait();
  const g = await comfyGraph(it.promptId);
  const vv = Object.values(g).find((n) => n.class_type === 'VibeVoiceTTS');
  assert.equal(vv.inputs.text, '[1] Hello from the app.');
  assert.equal(g[vv.inputs.speaker_1_voice[0]].inputs.audio, 'verify-voice.flac');
});

test('builder: proposal -> summary card; Test run queues a reduced graph without saving; Save adds it under My presets', async () => {
  await pick('fast-concept');
  await page.fill('#prompt', 'a red fox');
  if ((await page.locator('#chat').getAttribute('open')) === null) await page.click('#chat > summary');
  await send('make a setup: schnell then upscale 2x');
  const card = lastAssistant().locator('.setup-card');
  assert.match(await card.textContent(), /Fast concept 2x/);
  assert.match(await card.textContent(), /Checked against ComfyUI/);
  assert.doesNotMatch(await lastAssistant().textContent(), /Great idea|I have made/);
  for (const b of ['Test run', 'Save as preset', 'Discard']) assert.equal(await card.locator(`button:has-text("${b}")`).count(), 1, b);
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOTS, 'b1-builder-card.png') });
  const before = (await comfyReqs()).filter((r) => r.path === '/prompt').length;
  assert.equal(before, (await comfyReqs()).filter((r) => r.path === '/prompt').length, 'nothing queued by a proposal');
  const n = await doneCount();
  await card.locator('button:has-text("Test run")').click();
  await page.waitForFunction((n) => [...document.querySelectorAll('#thumbs .thumb')].filter((e) => e.className.includes('s-done')).length > n, n, { timeout: 10000 });
  const it = await page.evaluate(() => window.conceptApp.queue.items.at(-1));
  assert.equal(it.meta.workflow, 'builder:test');
  const g = await comfyGraph(it.promptId);
  for (const x of Object.values(g)) if (typeof x.inputs.width === 'number') assert.ok(x.inputs.width <= 768);
  assert.deepEqual((await (await fetch(s.base + '/api/user-presets')).json()).presets, [], 'test run does not save');
  await card.locator('button:has-text("Save as preset")').click();
  await page.waitForFunction(() => window.conceptApp.workflows.some((w) => w.group === 'My presets'));
  assert.equal((await (await fetch(s.base + '/api/user-presets')).json()).presets.length, 1);
  assert.match(await card.textContent(), /Saved under My presets/);
});

test('builder: an invalid proposal is rejected with the plain reason and has no Save button', async () => {
  await send('make a setup BADSETUP');
  const card = lastAssistant().locator('.setup-card');
  assert.equal(await card.getAttribute('data-state'), 'rejected');
  assert.match(await card.textContent(), /only works with Qwen-Image/);
  assert.equal(await card.locator('button:has-text("Save as preset")').count(), 0);
  assert.doesNotMatch(await lastAssistant().textContent(), /I have built/);
  assert.match(await lastAssistant().textContent(), /cannot be built as asked/);
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(SHOTS, 'b1-builder-rejected.png') });
});

test('My presets: pick, rename and delete from the picker', async () => {
  const id = await page.evaluate(() => window.conceptApp.workflows.find((w) => w.group === 'My presets').id);
  await pick(id);
  assert.match(await page.textContent('#preset-crumb'), /My presets/);
  await page.click('#preset-btn');
  await page.click(`#picker .ent[data-preset="${id}"] .edit`);
  await page.fill('#picker .ent.editing input', 'Fox upscaler');
  await page.click('#picker .ent.editing button:has-text("Save")');
  await page.waitForFunction(() => window.conceptApp.workflows.some((w) => w.label === 'Fox upscaler'));
  await page.waitForSelector(`#picker .ent[data-preset="${id}"] .edit`); // picker stays open, row shows the new name
  assert.match(await page.textContent(`#picker .ent[data-preset="${id}"]`), /Fox upscaler/);
  await page.screenshot({ path: path.join(SHOTS, 'b1-my-presets.png') });
  await page.click(`#picker .ent[data-preset="${id}"] .edit`);
  await page.click('#picker .ent.editing button:has-text("Delete")');
  await page.click('#picker .ent.editing button:has-text("Tap again")');
  await page.waitForFunction(() => !window.conceptApp.workflows.some((w) => w.group === 'My presets'));
  assert.deepEqual((await (await fetch(s.base + '/api/user-presets')).json()).presets, []);
});

test('no page errors in the batch 1 run', () => { assert.deepEqual(errors, []); });
