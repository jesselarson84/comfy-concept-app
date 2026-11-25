// GPU & memory: the ⋮ menu has no memory section (always Auto, chosen silently
// from the detected VRAM). (Batch 15: the chat model tests went with the assistant.)
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

test('no page errors in the memory run', () => { assert.deepEqual(errors, []); });
