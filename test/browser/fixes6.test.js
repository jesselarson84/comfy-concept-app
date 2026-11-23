// Fixes after batch 5 (found on the phone):
//  1. The node view always shows the selected preset: closing its ComfyUI tab
//     and coming back loads it again (it used to leave a blank canvas).
//  2. History: a back arrow (and Back) leaves a folder / Favorites for all of History.
// The mock ComfyUI page has no frontend, so a small fake `app` (loadApiJson +
// the workflow tab store) is put into the node view iframe.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack } from '../unit/helpers.js';
import { launch } from './launch.js';

let s, browser, page;
const errors = [];

before(async () => {
  s = await startStack({ stepMs: 40, folderWorkflows: false });
  browser = await launch();
  const ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.goto(s.base + '/');
  await page.waitForFunction(() => (window.conceptApp?.workflows?.length || 0) > 10 && window.conceptApp.current);
});
after(async () => { await browser?.close(); await s?.close(); });

const app = (fn, a) => page.evaluate(fn, a);
const nodeOn = () => page.waitForFunction(() => document.body.classList.contains('node-view-on'));
const nodeOff = () => page.waitForFunction(() => !document.body.classList.contains('node-view-on'));

/** Fake ComfyUI frontend in the iframe; records every loadApiJson. */
const fakeComfy = async () => { await page.waitForFunction(() => { const f = window.conceptApp.nodeView.frame; try { return f.contentWindow.location.pathname.startsWith('/comfy') && f.contentDocument.readyState === 'complete'; } catch { return false; } }); await app(() => {
  const w = window.conceptApp.nodeView.frame.contentWindow;
  const unsaved = { path: 'workflows/Unsaved Workflow.json' };
  const store = { tabsRestored: true, openWorkflows: [unsaved], activeWorkflow: unsaved,
    async closeWorkflow(x) { this.openWorkflows = this.openWorkflows.filter((o) => o !== x); if (this.activeWorkflow === x) this.activeWorkflow = this.openWorkflows[0] || null; } };
  w.loads = [];
  w.app = { graph: {}, extensionManager: { workflow: store },
    async loadApiJson(wf, name) { w.loads.push(name); const t = { path: 'workflows/' + name }; store.openWorkflows.push(t); store.activeWorkflow = t; } };
}); };
const loads = () => app(() => window.conceptApp.nodeView.frame.contentWindow.loads.slice());

test('node view: loads the selected preset; keeps it on re-entry; loads it again after its tab was closed', async () => {
  await app(() => window.conceptApp.selectPreset('ai:z-image-turbo'));
  await page.click('#btn-canvas'); await nodeOn();
  await fakeComfy();
  await page.waitForFunction(() => window.conceptApp.nodeView.loadedId === 'ai:z-image-turbo');
  const name = (await loads())[0];
  assert.match(name, /\.json$/);
  // out and back in: nothing reloaded (canvas edits survive)
  await page.click('#btn-canvas'); await nodeOff();
  await page.click('#btn-canvas'); await nodeOn();
  await page.waitForTimeout(600);
  assert.equal((await loads()).length, 1, 'same preset, tab still open: not reloaded');
  // close the preset's tab inside ComfyUI (as the tab's X does), leave, come back
  await app(async () => { const st = window.conceptApp.nodeView.frame.contentWindow.app.extensionManager.workflow; await st.closeWorkflow(st.activeWorkflow); });
  await page.click('#btn-canvas'); await nodeOff();
  await page.click('#btn-canvas'); await nodeOn();
  await page.waitForFunction((n) => window.conceptApp.nodeView.frame.contentWindow.loads.length === n, 2);
  assert.equal(await app(() => window.conceptApp.nodeView.frame.contentWindow.app.extensionManager.workflow.activeWorkflow.path), 'workflows/' + name);
  // closed tab, then a different preset picked outside: that one is loaded
  await app(async () => { const st = window.conceptApp.nodeView.frame.contentWindow.app.extensionManager.workflow; await st.closeWorkflow(st.activeWorkflow); });
  await page.click('#btn-canvas'); await nodeOff();
  await app(() => window.conceptApp.selectPreset('ai:klein-4b-t2i'));
  await page.click('#btn-canvas'); await nodeOn();
  await page.waitForFunction(() => window.conceptApp.nodeView.loadedId === 'ai:klein-4b-t2i');
  const last = (await loads()).at(-1);
  assert.match(last, /Klein/);
  assert.equal(await app(() => window.conceptApp.nodeView.frame.contentWindow.app.extensionManager.workflow.activeWorkflow.path), 'workflows/' + last);
  await page.click('#btn-canvas'); await nodeOff();
});

test('History: back arrow leaves Favorites / a folder for all of History; Back does too, then closes History', async () => {
  await app(() => fetch('/api/folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Back test' }) }));
  await page.click('#btn-history');
  await page.waitForFunction(() => document.querySelector('.history h2')?.textContent === 'History');
  assert.equal(await page.isVisible('[data-act="all-history"]'), false, 'no arrow on all of History');
  // Favorites -> arrow -> History
  await page.click('.history-top button:has-text("Favorites")');
  await page.waitForFunction(() => document.querySelector('.history h2')?.textContent === 'Favorites');
  assert.equal(await page.isVisible('[data-act="all-history"]'), true);
  await page.click('[data-act="all-history"]');
  await page.waitForFunction(() => document.querySelector('.history h2')?.textContent === 'History');
  assert.equal(await page.$eval('.history-top button:has-text("Favorites")', (b) => b.classList.contains('on')), false);
  assert.equal(await app(() => !!history.state?.history && !history.state.historySub), true, 'arrow popped the folder entry');
  // a folder from the Folders screen -> Back -> History (still open) -> Back -> closed
  await page.click('.history [data-act="folders"]');
  await page.click('.folder-card:has-text("Back test")');
  await page.waitForFunction(() => document.querySelector('.history h2')?.textContent === 'Back test');
  assert.equal(await page.isVisible('[data-act="all-history"]'), true);
  await app(() => history.back());
  await page.waitForFunction(() => document.querySelector('.history h2')?.textContent === 'History');
  assert.equal(await app(() => window.conceptApp.historyView.on), true);
  await app(() => history.back());
  await page.waitForFunction(() => !window.conceptApp.historyView.on);
});

test('History: closing from inside a folder leaves no extra Back entries; reopening starts on all of History', async () => {
  const len0 = await app(() => history.length);
  await page.click('#btn-history');
  await page.click('.history-top button:has-text("Favorites")');
  await page.waitForFunction(() => document.querySelector('.history h2')?.textContent === 'Favorites');
  await page.click('#btn-history');
  await page.waitForFunction(() => !window.conceptApp.historyView.on);
  await page.waitForTimeout(300);
  assert.equal(await app(() => !!history.state?.history), false, 'back on the app entry');
  await page.click('#btn-history');
  await page.waitForFunction(() => document.querySelector('.history h2')?.textContent === 'History');
  assert.equal(await page.isVisible('[data-act="all-history"]'), false);
  // from a folder straight to the node view: the node view takes over History's entry
  await page.click('.history-top button:has-text("Favorites")');
  await page.waitForFunction(() => document.querySelector('.history h2')?.textContent === 'Favorites');
  await page.click('#btn-canvas'); await nodeOn();
  assert.equal(await app(() => window.conceptApp.historyView.on), false);
  await app(() => history.back()); await nodeOff();
  await page.waitForTimeout(300);
  assert.equal(await app(() => !!(history.state?.history || history.state?.nodeView)), false, 'one Back leaves the node view to the app');
});

test('no page errors', () => { assert.deepEqual(errors, []); });
