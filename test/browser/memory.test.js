// GPU & memory: the ⋮ menu has no memory section (always Auto, chosen silently
// from the detected VRAM), the 5080 profile keeping the chat model loaded
// across a batch, and model-fit in the chat model list.
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

test('menu has no GPU & memory section or profile setting (always Auto); an old saved choice is ignored', async () => {
  const s = await startStack({ data: { 'memory-profile.json': { profile: 'large' } } });
  const p = await open(s);
  try {
    await p.waitForTimeout(300);
    assert.equal(await p.locator('.memory, .memory-select, #memory, #memory-mount').count(), 0);
    // batch 5: the ⋮ menu (Import, builder model, CPU switches) is gone entirely
    assert.equal(await p.locator('details.menu, .menu-pop, #mem-te-cpu, #mem-ollama-cpu, #builder-model, #btn-import').count(), 0);
    assert.doesNotMatch(await p.textContent('.topbar'), /GPU & memory|Profile|Under 12 GB|16 GB\+|Refresh/);
    const m = await (await fetch(s.base + '/api/memory')).json();
    assert.deepEqual([m.profile.id, m.profile.source], ['small', 'auto'], '2080 Ti -> small, the stale "large" is ignored');
  } finally { await p.close(); await s.close(); }
});

test('5080: chat model stays loaded through a batch; 12B listed; partial-offload badge shown', async () => {
  const s = await startStack({ gpu: { ...GPU_5080, freeMB: 9000 }, ollamaOptions: { extraModels: [{ name: 'gemma3:12b', vision: true, size: 8149190253, family: 'gemma3' }, { name: 'huge:70b', vision: false, size: 42 * 1024 ** 3, family: 'llama' }], vramFraction: { 'gemma3:12b': 0.7 } } });
  const p = await open(s);
  try {
    await p.click('#chat > summary');
    await p.waitForFunction(() => document.querySelector('.chat-model')?.options.length === 4);
    await p.waitForFunction(() => [...document.querySelector('.chat-model').options].some((o) => o.disabled)); // fit is filled in after the list
    const opts = await p.$$eval('.chat-model option', (o) => o.map((x) => [x.value, x.textContent, x.disabled]));
    assert.deepEqual(opts.find((o) => o[0] === 'gemma3:12b'), ['gemma3:12b', 'gemma3:12b', false]);
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
