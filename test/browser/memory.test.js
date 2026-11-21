// GPU & memory in the UI: detected hardware + profile in the ⋮ menu, manual
// override, the 5080 profile keeping the chat model loaded across a batch,
// model-fit labels in the picker and the "partly in RAM" badge.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startStack, ROOT, GPU_5080 } from '../unit/helpers.js';
import { launch } from './launch.js';

const SHOTS = path.join(ROOT, 'test/browser/screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
let browser, ctx;
const errors = [];
before(async () => {
  browser = await launch();
  ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
});
after(async () => { await browser?.close(); });
async function open(s) {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text() + ' @ ' + (m.location()?.url || '?')); });
  await p.goto(s.base + '/');
  await p.waitForFunction(() => (window.conceptApp?.workflows?.length || 0) >= 2);
  return p;
}


// Preset picker (top bar): open it and tap a row.
async function pick(id, pg = page) { await pg.click('#preset-btn'); await pg.click(`#picker .ent[data-preset="${id}"]`); await pg.waitForFunction((x) => window.conceptApp.current?.id === x, id); }
const currentPreset = (pg = page) => pg.evaluate(() => window.conceptApp.current?.id);
const hasPreset = (id) => (window.conceptApp?.workflows || []).some((w) => w.id === id);

test('2080 Ti: menu shows GPU, VRAM, RAM and the auto profile; override persists and switches back', async () => {
  const s = await startStack();
  const p = await open(s);
  try {
    await p.click('details.menu > summary');
    await p.waitForFunction(() => /2080 Ti/.test(document.querySelector('.memory-line')?.textContent || ''));
    assert.equal(await p.textContent('.memory-line'), 'NVIDIA GeForce RTX 2080 Ti · 11.0 GB VRAM (3.9 GB free) · RAM 95.9 GB (58.6 GB free)');
    assert.match(await p.textContent('.memory-profile-line'), /Under 12 GB VRAM .*\(auto-detected\)/);
    await p.screenshot({ path: path.join(SHOTS, 'memory-menu.png') });
    await p.selectOption('.memory-select', 'large');
    await p.waitForFunction(() => /chosen here/.test(document.querySelector('.memory-profile-line').textContent));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.dataDir, 'memory-profile.json'), 'utf8')), { profile: 'large' });
    await p.selectOption('.memory-select', 'auto');
    await p.waitForFunction(() => /auto-detected/.test(document.querySelector('.memory-profile-line').textContent));
  } finally { await p.close(); await s.close(); }
});

test('5080: chat model stays loaded through a batch; 12B listed; partial-offload badge shown', async () => {
  const s = await startStack({ gpu: { ...GPU_5080, freeMB: 9000 }, ollamaOptions: { extraModels: [{ name: 'gemma3:12b', vision: true, size: 8149190253, family: 'gemma3' }, { name: 'huge:70b', vision: false, size: 42 * 1024 ** 3, family: 'llama' }], vramFraction: { 'gemma3:12b': 0.7 } } });
  const p = await open(s);
  try {
    await p.click('#chat > summary');
    await p.waitForFunction(() => document.querySelector('.chat-model')?.options.length === 4);
    const opts = await p.$$eval('.chat-model option', (o) => o.map((x) => [x.value, x.textContent, x.disabled]));
    assert.deepEqual(opts.find((o) => o[0] === 'gemma3:12b'), ['gemma3:12b', 'gemma3:12b - slower, partly in RAM', false]);
    assert.deepEqual(opts.find((o) => o[0] === 'huge:70b'), ['huge:70b', "huge:70b - won't fit", true]);
    await p.selectOption('.chat-model', 'gemma3:4b');
    await p.fill('.chat-input', 'a purple duck'); await p.click('.chat-send');
    await p.waitForSelector('.chat-proposal');
    const chatReq = (await (await fetch(s.ollamaBase + '/mock/requests')).json()).filter((r) => r.path === '/api/chat').at(-1);
    assert.equal(chatReq.body.keep_alive, '10m');
    // A light workflow (the old Fast concept graph, imported): the default Klein 4B T2I
    // preset needs ~9 GB, which really would unload the chat model at 9 GB free.
    await p.evaluate(() => window.conceptApp.selectPreset('basic-txt2img'));
    await p.fill('#prompt', 'a purple duck');
    await p.fill('#batch', '2'); await p.locator('#batch').dispatchEvent('change');
    await p.click('#btn-generate');
    await p.waitForFunction(() => [...document.querySelectorAll('#thumbs .thumb')].filter((e) => e.className.includes('s-done')).length === 2, null, { timeout: 10000 });
    assert.deepEqual([...s.ollama.loaded], ['gemma3:4b'], 'not unloaded on the 16 GB profile');
    assert.ok(!(await (await fetch(s.ollamaBase + '/mock/requests')).json()).some((r) => r.path === '/api/generate'));
    // switch to the 12B model: after a turn the status shows the RAM badge
    await p.selectOption('.chat-model', 'gemma3:12b');
    await p.fill('.chat-input', 'make it moodier'); await p.click('.chat-send');
    await p.waitForFunction(() => /partly in RAM \(70% on GPU\)/.test(document.querySelector('.chat-status').textContent), null, { timeout: 8000 });
    await p.screenshot({ path: path.join(SHOTS, 'memory-5080-badge.png') });
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && document.querySelector('#panel').scrollWidth <= innerWidth + 1), 'no sideways scrolling from the long status');
  } finally { await p.close(); await s.close(); }
});

test('no page errors in the memory run', () => { assert.deepEqual(errors, []); });
