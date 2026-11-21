// Prompt assistant (chat tied to the prompt box) + workflow actions, driven in
// headless Chromium against mock ComfyUI + mock Ollama.
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

async function openPage(base) {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text() + ' @ ' + (m.location()?.url || '?')); });
  await p.goto(base + '/');
  await p.waitForFunction(() => document.querySelectorAll('#preset option').length >= 2);
  return p;
}
before(async () => {
  s = await startStack({ stepMs: 40 });
  browser = await launch();
  ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  page = await openPage(s.base);
});
after(async () => { await browser?.close(); await s?.close(); });

const oreqs = async () => (await (await fetch(s.ollamaBase + '/mock/requests')).json());
const chats = async () => (await oreqs()).filter((r) => r.path === '/api/chat');
const comfyReqs = async () => (await (await fetch(s.mockBase + '/mock/requests')).json());
const comfyGraph = async (pid) => (await (await fetch(`${s.mockBase}/history/${pid}`)).json())[pid].prompt[2];
const lastAssistant = () => page.locator('.chat-msg.assistant').last();
async function send(text) {
  const n = await page.locator('.chat-msg.assistant:not(.chat-thinking)').count();
  await page.fill('.chat-input', text);
  await page.click('.chat-send');
  await page.waitForFunction((n) => document.querySelectorAll('.chat-msg.assistant:not(.chat-thinking)').length > n && !document.querySelector('.chat-thinking'), n, { timeout: 10000 });
}
const doneCount = () => page.$$eval('#thumbs .thumb', (els) => els.filter((e) => e.className.includes('s-done')).length);

test('assistant sits under the prompt box, lists Ollama models, shows the vision badge', async () => {
  assert.equal(await page.locator('#prompt-tools + #chat-mount #chat').count(), 1);
  await page.click('#chat > summary');
  await page.waitForFunction(() => document.querySelector('.chat-model')?.options.length === 2);
  assert.deepEqual(await page.$$eval('.chat-model option', (o) => o.map((x) => x.value)), ['gemma3:4b', 'llama3.2:3b']);
  assert.match(await page.textContent('.chat-status'), /gemma3:4b \(sees images\)/);
  assert.equal(await page.isEnabled('.chat-send'), true);
});

test('create a prompt: request carries the current prompt box + JSON schema; diff shown; Apply fills the box; Undo restores', async () => {
  await page.fill('#prompt', 'a duck');
  await send('a purple duck');
  const req = (await chats()).at(-1).body;
  assert.equal(req.model, 'gemma3:4b');
  assert.equal(req.format.type, 'object'); assert.ok(req.format.properties.prompt && req.format.properties.action);
  assert.match(req.messages[0].content, /CURRENT PROMPT BOX[^\n]*\n"""a duck"""/);
  assert.ok(req.messages[0].content.includes('"upscale"'), 'actions are in the context');
  assert.equal(req.stream, true);
  const diff = await lastAssistant().locator('.chat-diff').innerHTML();
  assert.match(diff, /<del[^>]*>[^<]*duck/);
  assert.doesNotMatch(await lastAssistant().locator('.chat-diff').textContent(), /duckpurple/); assert.match(diff, /<ins[^>]*>[^<]*concept art of/);
  await page.screenshot({ path: path.join(SHOTS, 'chat-proposal.png') });
  await lastAssistant().locator('button:has-text("Apply")').first().click();
  assert.equal(await page.inputValue('#prompt'), 'concept art of a purple duck, dramatic lighting, wide shot');
  assert.match(await lastAssistant().textContent(), /Applied ✓/);
  assert.match(await page.textContent('details.versions summary'), /Versions \(1\)/);
  await page.click('#prompt-undo');
  assert.equal(await page.inputValue('#prompt'), 'a duck');
  await page.fill('#prompt', 'concept art of a purple duck, dramatic lighting, wide shot');
});

test('revision turns: no-change, malformed (json block), truncated/plain text keep the box untouched', async () => {
  const before = await page.inputValue('#prompt');
  await send('NOCHANGE make sure it is purple');
  assert.equal(await lastAssistant().locator('.chat-proposal').count(), 0);
  assert.match(await lastAssistant().textContent(), /already says that/);
  await send('MALFORMED add rain');
  assert.equal(await lastAssistant().locator('.chat-proposal').count(), 1, 'json inside prose still proposes');
  await send('TRUNCATED');
  assert.equal(await lastAssistant().locator('.chat-proposal').count(), 0);
  assert.match(await lastAssistant().textContent(), /answer was cut off/);
  assert.doesNotMatch(await lastAssistant().textContent(), /"prompt"/);
  await send('UNASKED a duck please');
  assert.equal(await lastAssistant().locator('.chat-action').count(), 0, 'unrequested action is not offered');
  assert.doesNotMatch(await lastAssistant().textContent(), /null|undefined/);
  assert.equal(await lastAssistant().locator('.chat-proposal').count(), 1);
  await send('PRAISE make it dusk');
  assert.equal(await lastAssistant().locator('.chat-text').first().textContent(), 'I changed the light to dusk.');
  await send('CLAIM fix the neck');
  assert.equal(await lastAssistant().locator('.chat-proposal').count(), 0);
  assert.match(await lastAssistant().locator('.chat-unchanged').textContent(), /sent the prompt back unchanged/);
  assert.equal(await page.locator('.chat-msg.assistant .chat-unchanged').count(), 1, 'only on the claiming turn');
  await send('GARBAGE');
  assert.match(await lastAssistant().textContent(), /lovely as it is/);
  assert.equal(await page.inputValue('#prompt'), before);
  // The model gets the whole conversation, assistant turns replayed as JSON.
  const req = (await chats()).at(-1).body;
  assert.ok(req.messages.filter((m) => m.role === 'assistant').length >= 4);
});

test('Generate unloads Ollama first (keep_alive 0 before ComfyUI /prompt)', async () => {
  assert.ok(s.ollama.loaded.size >= 1, 'model is loaded after chatting');
  const t0 = Date.now();
  await page.fill('#batch', '1'); await page.locator('#batch').dispatchEvent('change');
  await page.click('#btn-generate');
  await page.waitForFunction(() => [...document.querySelectorAll('#thumbs .thumb')].some((e) => e.className.includes('s-done')), null, { timeout: 10000 });
  const unload = (await oreqs()).find((r) => r.t >= t0 && r.path === '/api/generate' && r.body.keep_alive === 0);
  const prompt = (await comfyReqs()).find((r) => r.t >= t0 && r.path === '/prompt');
  assert.ok(unload && prompt, 'both happened');
  assert.ok(unload.t <= prompt.t, `unload ${unload.t} before prompt ${prompt.t}`);
  assert.equal(s.ollama.loaded.size, 0);
});

test('viewer Discuss: image attached as base64 JPEG with its prompt + seed; Apply + same seed re-runs that seed', async () => {
  const item = await page.evaluate(() => window.conceptApp.queue.items.at(-1).meta);
  await page.click('#thumbs .thumb >> nth=-1');
  await page.waitForSelector('.viewer:not([hidden])');
  await page.click('.viewer button:has-text("Discuss")');
  await page.waitForSelector('.viewer', { state: 'hidden' });
  const chip = await page.textContent('.chat-attach');
  assert.match(chip, new RegExp(`img1 · seed ${item.seed}`));
  await page.screenshot({ path: path.join(SHOTS, 'chat-discuss.png') });
  await send('it looks like a swan, make it a duck');
  const req = (await chats()).at(-1).body;
  const last = req.messages.at(-1);
  assert.equal(last.images.length, 1);
  assert.equal(Buffer.from(last.images[0], 'base64').subarray(0, 3).toString('hex'), 'ffd8ff', 'JPEG bytes');
  assert.match(last.content, /\[attached: img1\]/);
  assert.match(req.messages[0].content, new RegExp(`img1: generated with prompt "${item.prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}", seed ${item.seed}`));
  assert.equal(req.messages.slice(0, -1).filter((m) => m.images).length, 0, 'only the newest message carries pixels');
  assert.match(await lastAssistant().textContent(), /reads as a swan/);
  const same = lastAssistant().locator(`button:has-text("Apply + same seed ${item.seed}")`);
  assert.equal(await same.count(), 1);
  const n = await doneCount();
  await same.click();
  await page.waitForFunction((n) => [...document.querySelectorAll('#thumbs .thumb')].filter((e) => e.className.includes('s-done')).length > n, n, { timeout: 10000 });
  const meta = await page.evaluate(() => window.conceptApp.queue.items.at(-1).meta);
  assert.equal(meta.seed, item.seed);
  assert.match(meta.prompt, /short neck and a flat orange bill/);
  assert.match(await page.inputValue('#prompt'), /short neck/);
});

test('action: "upscale" -> confirm chip with clamp note; Run wires the image into LoadImage; result linked to parent', async () => {
  const parent = await page.evaluate(() => window.conceptApp.queue.items.at(-1));
  await page.click('#thumbs .thumb >> nth=-1');
  await page.waitForSelector('.viewer:not([hidden])');
  await page.click('.viewer button:has-text("Discuss")');
  const promptsBefore = (await comfyReqs()).filter((r) => r.path === '/prompt').length;
  await send('upscale this please');
  const card = lastAssistant().locator('.chat-action');
  assert.match(await card.textContent(), /Upscale \(scale 4, model 4x-UltraSharp\.safetensors\) on img2\. Run\?/);
  assert.match(await card.textContent(), /outside 1\.5-4/);
  assert.equal((await comfyReqs()).filter((r) => r.path === '/prompt').length, promptsBefore, 'nothing queued before Run');
  await page.screenshot({ path: path.join(SHOTS, 'chat-action.png') });
  const n = await doneCount();
  await card.locator('button:has-text("Run")').click();
  await page.waitForFunction((n) => [...document.querySelectorAll('#thumbs .thumb')].filter((e) => e.className.includes('s-done')).length > n, n, { timeout: 10000 });
  const it = await page.evaluate(() => window.conceptApp.queue.items.at(-1));
  const g = await comfyGraph(it.promptId);
  const img = parent.image;
  assert.equal(g['10'].class_type, 'LoadImage');
  assert.equal(g['10'].inputs.image, `${img.subfolder ? img.subfolder + '/' : ''}${img.filename} [output]`);
  assert.equal(g['13'].inputs.scale_by, 1);
  assert.match(g['14'].inputs.filename_prefix, /concept-app\/upscale$/);
  assert.equal(it.meta.action, 'upscale'); assert.equal(it.meta.parent.image.filename, img.filename);
  assert.match(await card.textContent(), /Upscale/); assert.equal(await card.locator('button:has-text("Run")').count(), 0);
  const { sessions } = await (await fetch(s.base + '/api/history')).json();
  const e = sessions.flatMap((x) => x.entries).find((x) => x.action === 'upscale');
  assert.ok(e && e.parent?.image?.filename === img.filename && e.images.length === 1);
});

test('action: "make it 3d" -> GLB result is a "3D ↓" download tile; unknown action is refused', async () => {
  const n = await page.locator('#thumbs .thumb').count();
  await send('make it 3d');
  await lastAssistant().locator('.chat-action button:has-text("Run")').click();
  await page.waitForFunction((n) => document.querySelectorAll('#thumbs .thumb.is-file.s-done').length >= 1 && document.querySelectorAll('#thumbs .thumb').length > n, n, { timeout: 10000 });
  assert.match(await page.textContent('#thumbs .thumb.is-file'), /3D ↓/);
  const it = await page.evaluate(() => window.conceptApp.queue.items.at(-1));
  assert.match(it.files[0].filename, /^mesh_\d+_\.glb$/);
  const r = await fetch(`${s.base}/comfy/view?filename=${it.files[0].filename}&subfolder=${it.files[0].subfolder}&type=output`);
  assert.equal((await r.text()).slice(0, 4), 'glTF');
  await send('BOGUSACTION');
  assert.match(await lastAssistant().textContent(), /Unknown action "teleport"/);
  assert.equal(await lastAssistant().locator('.chat-action button:has-text("Run")').count(), 0);
});

test('non-vision model: discussing an image sends only its prompt + seed', async () => {
  await page.selectOption('.chat-model', 'llama3.2:3b');
  await page.waitForFunction(() => !/sees images/.test(document.querySelector('.chat-status').textContent));
  await page.click('#thumbs .thumb >> nth=0');
  await page.waitForSelector('.viewer:not([hidden])');
  await page.click('.viewer button:has-text("Discuss")');
  assert.match(await page.textContent('.chat-attach'), /cannot see images/);
  await send('what about this one');
  const req = (await chats()).at(-1).body;
  assert.equal(req.model, 'llama3.2:3b');
  assert.equal(req.messages.filter((m) => m.images).length, 0);
  await page.selectOption('.chat-model', 'gemma3:4b');
});

test('chats persist (data/chats.json) and come back after a reload; Versions survive too', async () => {
  const count = await page.locator('.chat-msg').count();
  const disk = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'chats.json'), 'utf8'));
  assert.ok(disk.chats[0].messages.length >= 10);
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('#preset option').length >= 2);
  await page.waitForFunction((c) => document.querySelectorAll('.chat-msg').length >= c - 1, count, { timeout: 8000 });
  assert.equal(await page.locator('#chat').getAttribute('open'), '');
  assert.match(await page.textContent('details.versions summary'), /Versions \(\d+\)/);
  assert.ok(await page.locator('.chat-thread option').count() >= 1);
});

test('Ollama offline: clear message + Retry, Send disabled, rest of the app still works', async () => {
  const d = await startStack({ ollamaDown: true });
  const p = await openPage(d.base);
  try {
    await p.evaluate(() => localStorage.setItem('conceptChat.open', '1'));
    await p.reload(); await p.waitForFunction(() => document.querySelectorAll('#preset option').length >= 2);
    await p.waitForSelector('.chat-offline:not([hidden])', { timeout: 8000 });
    assert.match(await p.textContent('.chat-offline'), /Start Ollama on the PC/);
    assert.equal(await p.isDisabled('.chat-send'), true);
    assert.equal(await p.isVisible('#banner'), false);
    await p.screenshot({ path: path.join(SHOTS, 'chat-offline.png') });
  } finally { await p.close(); await d.close(); }
  // the 502s from the offline probe are expected there; drop them
  for (let i = errors.length - 1; i >= 0; i--) if (/502|Bad Gateway/.test(errors[i])) errors.splice(i, 1);
});

test('no page errors during the chat run', () => {
  assert.deepEqual(errors, []);
});
