// Batch 22: opened from ComfyUI's Concept sidebar tab (/?in=comfy) the app has no
// node-view button, also after a reload; opened normally it still has one.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack } from '../unit/helpers.js';
import { launch } from './launch.js';

let s, browser;
before(async () => { s = await startStack({ stepMs: 20, folderWorkflows: false }); browser = await launch(); });
after(async () => { await browser?.close(); await s?.close(); });

const ready = (page) => page.waitForFunction(() => window.conceptApp?.current);

test('in ComfyUI\'s sidebar: no node-view button (also after a reload); normally: still there', async () => {
  const ctx = await browser.newContext({ viewport: { width: 460, height: 860 } });
  const page = await ctx.newPage();
  await page.goto(s.base + '/?in=comfy');
  await ready(page);
  assert.equal(await page.isVisible('#btn-canvas'), false);
  assert.equal(await page.isVisible('#btn-history'), true);
  assert.equal(new URL(page.url()).search, '', 'the URL is cleaned as usual');
  await page.reload(); await ready(page);
  assert.equal(await page.isVisible('#btn-canvas'), false, 'still hidden after a reload of the frame');
  const other = await (await browser.newContext({ viewport: { width: 460, height: 860 } })).newPage();
  await other.goto(s.base + '/'); await ready(other);
  assert.equal(await other.isVisible('#btn-canvas'), true);
});
