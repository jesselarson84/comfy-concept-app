// Drives the real app (in headless Chromium) against the mock ComfyUI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startStack, pngBytes, ROOT } from '../unit/helpers.js';
import { launch, pickAspect, menuAct, saveToPhone } from './launch.js';

const SHOTS = path.join(ROOT, 'test/browser/screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
let s, browser, ctx, page;
const errors = [];

before(async () => {
  s = await startStack({ stepMs: 150 });
  browser = await launch();
  ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text() + ' @ ' + (m.location()?.url || '?')); });
  await page.goto(s.base + '/');
  await page.waitForFunction(() => (window.conceptApp?.workflows?.length || 0) >= 2);
});
after(async () => { await browser?.close(); await s?.close(); });

const mockPrompts = async () => (await (await fetch(s.mockBase + '/mock/requests')).json()).filter((r) => r.path === '/prompt');
const visible = (sel) => page.locator(sel).isVisible();
const statuses = () => page.$$eval('#thumbs .thumb', (els) => els.map((e) => e.className.replace('thumb s-', '')));


// Preset picker (top bar): open it and tap a row.
async function pick(id, pg = page) { await pg.click('#preset-btn'); await pg.click(`#picker .ent[data-preset="${id}"]`); await pg.waitForFunction((x) => window.conceptApp.current?.id === x, id); }
const currentPreset = (pg = page) => pg.evaluate(() => window.conceptApp.current?.id);
const hasPreset = (id) => (window.conceptApp?.workflows || []).some((w) => w.id === id);

test('fresh client opens on Z-Image Turbo (batch 17; not My presets); basic txt2img shows aspect, hides reference/strength/negative', async () => {
  assert.deepEqual(await page.evaluate(() => window.conceptApp.workflows.filter((w) => !w.ai).map((w) => w.label)), ['Basic reference', 'Basic txt2img']);
  // Start screen as a fresh client sees it (new context: no localStorage, no SW).
  assert.equal(await currentPreset(), 'ai:z-image-turbo');
  assert.match(await page.textContent('#preset-crumb'), /Image/);
  assert.equal(await page.evaluate(() => localStorage.getItem('preset')), null, 'the automatic default is not remembered');
  await page.screenshot({ path: path.join(SHOTS, 'phone-start.png') });
  await pick('basic-txt2img');
  assert.equal(await visible('#aspect-field'), true);
  assert.equal(await visible('#seed-field'), true);
  assert.equal(await visible('#refs'), false);
  assert.equal(await visible('#strength-field'), false);
  assert.equal(await visible('#neg-row'), false, 'klein has no negative prompt');
  assert.equal(await visible('#banner'), false);
  await page.screenshot({ path: path.join(SHOTS, 'phone-basic-txt2img.png') });
});

test('batch of 3 portrait: images appear one by one, seeds differ, size injected', async () => {
  const before = (await mockPrompts()).length;
  await page.fill('#prompt', 'a brass airship over a canyon');
  await page.fill('#batch', '3'); await page.locator('#batch').dispatchEvent('change');
  await pickAspect(page, '3:2-portrait');
  await page.click('#btn-generate');
  // While the batch runs there must be a moment with >=1 done and >=1 pending.
  await page.waitForFunction(() => {
    const c = [...document.querySelectorAll('#thumbs .thumb')].map((e) => e.className);
    return c.some((x) => x.includes('s-done')) && c.some((x) => /s-(queued|running)/.test(x));
  }, null, { timeout: 8000 });
  assert.equal(await visible('#btn-cancel'), true);
  await page.screenshot({ path: path.join(SHOTS, 'phone-batch-running.png') });
  await page.waitForFunction(() => [...document.querySelectorAll('#thumbs .thumb')].filter((e) => e.className.includes('s-done')).length === 3, null, { timeout: 10000 });
  const sent = (await mockPrompts()).slice(before);
  assert.equal(sent.length, 3);
  const reqs = await page.evaluate(() => window.conceptApp.queue.items.map((i) => i.meta));
  assert.equal(new Set(reqs.map((m) => m.seed)).size, 3);
  assert.deepEqual([reqs[0].width, reqs[0].height], [832, 1248]);
  const thumbsLoaded = await page.$$eval('#thumbs .thumb img', (imgs) => imgs.every((i) => i.complete && i.naturalWidth > 0));
  assert.equal(thumbsLoaded, true);
  assert.equal(await visible('#btn-cancel'), false);
  // history recorded with images
  const { sessions } = await (await fetch(s.base + '/api/history')).json();
  const entries = sessions.flatMap((x) => x.entries);
  assert.equal(entries.filter((e) => e.prompt === 'a brass airship over a canyon' && e.images.length === 1 && e.status === 'done').length, 3);
});

test('viewer: open, swipe, double-tap zoom, pinch, tap toggles controls, favorite, reuse', async () => {
  await page.click('#thumbs .thumb >> nth=0');
  await page.waitForSelector('.viewer:not([hidden])');
  await page.waitForFunction(() => document.querySelector('.viewer-img').naturalWidth > 0);
  assert.match(await page.textContent('.viewer-counter'), /^1 \/ 3/);
  const box = await page.locator('.viewer-stage').boundingBox();
  const cy = box.y + box.height / 2;
  // Swipe left with a pointer drag.
  await page.mouse.move(box.x + box.width * 0.8, cy); await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(box.x + box.width * (0.8 - i * 0.1), cy);
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('.viewer-counter').textContent.startsWith('2 / 3'), null, { timeout: 3000 });
  // Swipe right goes back.
  await page.mouse.move(box.x + box.width * 0.2, cy); await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(box.x + box.width * (0.2 + i * 0.1), cy);
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('.viewer-counter').textContent.startsWith('1 / 3'), null, { timeout: 3000 });
  // Double-tap -> zoom 2.5
  await page.mouse.click(box.x + box.width / 2, cy); await page.mouse.click(box.x + box.width / 2, cy, { delay: 30 });
  await page.waitForTimeout(300);
  const zoomed = await page.$eval('.viewer-img', (i) => i.style.transform);
  assert.match(zoomed, /scale\(2\.5\)/);
  // Double-tap again -> back to 1
  await page.mouse.click(box.x + box.width / 2, cy); await page.mouse.click(box.x + box.width / 2, cy, { delay: 30 });
  await page.waitForTimeout(300);
  assert.match(await page.$eval('.viewer-img', (i) => i.style.transform), /scale\(1\)/);
  // Pinch with two real touch points (CDP touch events -> pointer events).
  const cdp = await ctx.newCDPSession(page);
  const cx = box.x + box.width / 2;
  const touch = (type, d) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: cx - d, y: cy, id: 1 }, { x: cx + d, y: cy, id: 2 }] });
  await touch('touchStart', 40);
  for (const d of [60, 80, 100, 120]) await touch('touchMove', d);
  await touch('touchEnd', 0);
  const pinchScale = await page.$eval('.viewer-img', (i) => Number(/scale\(([\d.]+)\)/.exec(i.style.transform)?.[1]));
  assert.ok(pinchScale > 2.5 && pinchScale <= 3.1, `pinch scale ${pinchScale}`);
  // Single tap toggles the controls (after the double-tap window).
  await page.waitForTimeout(400);
  await page.mouse.click(box.x + 30, box.y + box.height - 300);
  await page.waitForTimeout(450);
  assert.equal(await page.$eval('.viewer', (v) => v.classList.contains('chrome-hidden')), true);
  await page.mouse.click(box.x + 30, box.y + box.height - 300);
  await page.waitForTimeout(450);
  assert.equal(await page.$eval('.viewer', (v) => v.classList.contains('chrome-hidden')), false);
  await page.screenshot({ path: path.join(SHOTS, 'phone-viewer.png') });
  // Favorite -> stored on server
  await menuAct(page, '.viewer', 'favorite');
  await page.waitForSelector('.viewer-top .viewer-fav:not([hidden])');
  await page.waitForTimeout(200);
  const { sessions } = await (await fetch(s.base + '/api/history?favorites=1')).json();
  assert.equal(sessions.flatMap((x) => x.entries).length, 1);
  // Reuse -> prompt + locked seed
  const seed = await page.evaluate(() => window.conceptApp.viewer.current().meta.seed);
  await menuAct(page, '.viewer', 'reuse');
  await page.waitForSelector('.viewer', { state: 'hidden' });
  assert.equal(await page.inputValue('#prompt'), 'a brass airship over a canyon');
  assert.equal(await page.isChecked('#seed-lock'), true);
  assert.equal(Number(await page.inputValue('#seed')), seed);
});

test('Save… -> Save to this phone instead triggers a download (share not testable headless)', async () => {
  await page.click('#thumbs .thumb >> nth=1');
  await page.waitForSelector('.viewer:not([hidden])');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), saveToPhone(page, '.viewer')]);
  assert.match(dl.suggestedFilename(), /^concept_\d+_\.png$/);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.viewer', { state: 'hidden' });
});

test('cancel queue: pending removed from ComfyUI queue and running interrupted', async () => {
  await page.uncheck('#seed-lock', { force: true });
  await page.fill('#batch', '5'); await page.locator('#batch').dispatchEvent('change');
  await page.click('#btn-generate');
  await page.waitForFunction(() => document.querySelector('#thumbs .thumb.s-running'), null, { timeout: 8000 });
  await page.click('#btn-cancel');
  await page.waitForFunction(() => window.conceptApp.queue.active.length === 0, null, { timeout: 8000 });
  const st = await (await fetch(s.mockBase + '/mock/state')).json();
  assert.equal(st.queue, 0);
  await page.waitForTimeout(300);
  assert.equal((await (await fetch(s.mockBase + '/mock/state')).json()).running, null);
  const sts = await statuses();
  assert.ok(sts.filter((x) => x === 'cancelled').length >= 4, sts.join(','));
  await page.click('#btn-clear');
  await page.waitForFunction(() => document.querySelectorAll('#thumbs .thumb').length === 0);
});

test('reference preset: pick file uploads to ComfyUI, strength + image injected', async () => {
  await pick('basic-reference');
  assert.equal(await visible('#refs'), true);
  assert.equal(await visible('#strength-field'), true);
  assert.equal(await visible('#aspect-field'), false, 'size follows the reference');
  await page.click('#btn-generate');
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('reference'));
  const fileInput = page.locator('.ref-slot input[type=file]:not([capture])');
  await fileInput.setInputFiles({ name: 'sketch.png', mimeType: 'image/png', buffer: pngBytes() });
  await page.waitForFunction(() => { const i = document.querySelector('.ref-preview'); return i && !i.hidden && i.naturalWidth > 0; });
  await page.fill('#strength', '0.4');
  await page.fill('#batch', '1'); await page.locator('#batch').dispatchEvent('change');
  const before = (await mockPrompts()).length;
  await page.click('#btn-generate');
  await page.waitForFunction(() => document.querySelector('#thumbs .thumb.s-done'), null, { timeout: 8000 });
  assert.equal((await mockPrompts()).length, before + 1);
  const pid = await page.evaluate(() => window.conceptApp.queue.items.at(-1).promptId);
  const h = await (await fetch(`${s.mockBase}/history/${pid}`)).json();
  const wf = h[pid].prompt[2];
  assert.equal(wf['10'].inputs.image, 'sketch.png');
  assert.equal(wf['60'].inputs.denoise, 0.4);
  assert.equal(wf['58'].inputs.filename_prefix, 'concept-app/reference');
});

test('paste an image into the reference slot', async () => {
  await page.evaluate(async () => {
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVQI12P4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  });
  await page.waitForFunction(() => window.conceptApp.refs.values['10'] === 'pasted.png');
});

test('Android share target flow: POST /share -> redirect -> FLUX.2 Klein 4B Image Edit preselected', async () => {
  await pick('basic-txt2img');
  const fd = new FormData();
  fd.append('image', new Blob([pngBytes()], { type: 'image/png' }), 'Screenshot_share.png');
  const r = await fetch(s.base + '/share', { method: 'POST', body: fd, redirect: 'manual' });
  await page.goto(s.base + r.headers.get('location'));
  // From reference image is retired: a share lands in the Klein 4B Image Edit slot (node 76).
  await page.waitForFunction(() => window.conceptApp?.current?.id === 'ai:klein-4b-edit');
  await page.waitForFunction(() => window.conceptApp.refs.values['76'] === 'Screenshot_share.png');
  await page.waitForFunction(() => document.querySelector('.ref-preview')?.naturalWidth > 0);
  assert.equal(new URL(page.url()).search, '', 'URL cleaned');
  // Also: a real form POST navigation from the page (what Chrome does) lands in the app.
  await page.evaluate(() => {
    const f = document.createElement('form'); f.method = 'POST'; f.action = '/share'; f.enctype = 'multipart/form-data';
    const t = document.createElement('input'); t.name = 'text'; t.value = 'shared words'; f.append(t); document.body.append(f); f.submit();
  });
  await page.waitForFunction(() => document.querySelector('#prompt')?.value === 'shared words', null, { timeout: 5000 });
});

// Batch 5: the Import workflow button (⋮ menu) is gone; a graph dropped into
// workflows/ still appears on its own (SSE).
test('workflow dropped into the folder -> appears in dropdown, negative prompt works', async () => {
  assert.equal(await page.$('#import-file, #btn-import, details.menu'), null, 'no ⋮ menu, no Import');
  fs.copyFileSync(path.join(ROOT, 'test/fixtures/sd15-negative.json'), path.join(s.wfDir, 'sd15-negative.json'));
  await page.waitForFunction(() => (window.conceptApp?.workflows || []).some((w) => w.id === 'sd15-negative'), null, { timeout: 5000 });
  await pick('sd15-negative');
  // batch 17: off = "+ Negative prompt"; tapping it shows the box
  assert.equal(await visible('#neg-add'), true, 'SD graph has a negative prompt');
  await page.click('#neg-add');
  assert.equal(await visible('#negative'), true);
});

test('workflow dropped into folder shows up without reload (SSE); unknown graph shows message', async () => {
  fs.copyFileSync(path.join(ROOT, 'test/fixtures/nothing-detectable.json'), path.join(s.wfDir, 'zz-blank.json'));
  await page.waitForFunction(() => (window.conceptApp?.workflows || []).some((w) => w.id === 'zz-blank'), null, { timeout: 5000 });
  await pick('zz-blank');
  assert.match(await page.textContent('#preset-msg'), /No controls detected/);
});

test('history view lists the session with images', async () => {
  await page.click('#btn-history');
  await page.waitForSelector('.history-session .thumb img');
  const n = await page.$$eval('.history-session .thumb', (t) => t.length);
  assert.ok(n >= 4, `history thumbs ${n}`);
  assert.ok(await page.$$eval('.history-session .thumb-label', (l) => l.some((x) => x.textContent === '★')));
  await page.screenshot({ path: path.join(SHOTS, 'phone-history.png') });
  await page.click('#btn-history');
});

test('history: Back closes a viewer opened from History, then History, without leaving the page', async () => {
  const url = page.url();
  await page.click('#btn-history');
  await page.waitForSelector('.history-session .thumb img');
  await page.click('.history-session .thumb');
  await page.waitForSelector('.viewer:not([hidden])');
  await page.goBack();
  await page.waitForSelector('.viewer', { state: 'hidden' });
  assert.equal(await page.$eval('.history', (e) => e.hidden), false, 'History stays open after the viewer closes');
  await page.goBack();
  await page.waitForFunction(() => document.querySelector('.history').hidden);
  assert.equal(page.url(), url);
  // Closing with the ✕ button also unwinds its history entry.
  await page.click('#btn-history');
  await page.waitForSelector('.history:not([hidden])');
  await page.click('#btn-history');
  await page.waitForFunction(() => document.querySelector('.history').hidden && !history.state?.history);
});

test('service worker registers and caches only the shell', async () => {
  await page.waitForFunction(() => navigator.serviceWorker.controller || navigator.serviceWorker.ready.then(() => true), null, { timeout: 8000 });
  // Cache name follows VERSION in app/sw.js (bumped whenever app files change).
  const version = /const VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'app/sw.js'), 'utf8'))[1];
  const keys = await page.evaluate(async (v) => { await navigator.serviceWorker.ready; const c = await caches.open(v); return (await c.keys()).map((r) => new URL(r.url).pathname); }, version);
  assert.ok(keys.includes('/js/main.js'));
  assert.ok(keys.includes('/js/native.js'));
  assert.ok(!keys.some((k) => k.startsWith('/comfy') || k.startsWith('/api')));
});

test('tablet layout: panel and grid side by side; landscape phone still usable', async () => {
  // Same page, resized (the VM's single-process Chromium dislikes a 2nd context).
  await page.setViewportSize({ width: 1180, height: 820 });
  await page.waitForTimeout(200);
  const a = await page.locator('#panel').boundingBox(), b = await page.locator('#results').boundingBox();
  assert.ok(b.x >= a.x + a.width - 1, 'results to the right of panel');
  assert.ok(Math.abs(a.y - b.y) < 2);
  const cols = await page.$eval('#thumbs', (t) => getComputedStyle(t).display);
  assert.equal(cols, 'grid');
  await page.screenshot({ path: path.join(SHOTS, 'tablet.png') });
  await page.setViewportSize({ width: 860, height: 400 });
  await page.waitForTimeout(200);
  const gen = await page.locator('#btn-generate').boundingBox();
  assert.ok(gen.y + gen.height <= 400, 'generate button on screen in landscape');
  await page.screenshot({ path: path.join(SHOTS, 'phone-landscape.png') });
  await page.setViewportSize({ width: 412, height: 860 });
});

// ---- Android wrapper bridge (window.AndroidBridge) ---------------------------
// A stub stands in for the native object; it only records the calls.
const installBridgeStub = () => page.evaluate(() => {
  window.__bridgeCalls = [];
  window.AndroidBridge = {
    isNativeApp: () => true,
    saveImage: (url, name) => window.__bridgeCalls.push(['saveImage', url, name]),
    shareImage: (url, name) => window.__bridgeCalls.push(['shareImage', url, name]),
    keepAwake: (on) => window.__bridgeCalls.push(['keepAwake', on]),
  };
});
const bridgeCalls = () => page.evaluate(() => window.__bridgeCalls);

test('Android bridge: keepAwake(true) while a batch runs, keepAwake(false) when idle', async () => {
  await installBridgeStub();
  await pick('basic-txt2img');
  await page.uncheck('#seed-lock', { force: true });
  await page.fill('#prompt', 'bridge batch');
  await page.fill('#batch', '2'); await page.locator('#batch').dispatchEvent('change');
  await page.click('#btn-generate');
  await page.waitForFunction(() => window.__bridgeCalls.some((c) => c[0] === 'keepAwake' && c[1] === true), null, { timeout: 8000 });
  await page.waitForFunction(() => window.conceptApp.queue.active.length === 0, null, { timeout: 10000 });
  await page.waitForFunction(() => window.__bridgeCalls.at(-1)?.[1] === false, null, { timeout: 3000 });
  // Called only on changes (not once per progress event).
  assert.deepEqual((await bridgeCalls()).filter((c) => c[0] === 'keepAwake'), [['keepAwake', true], ['keepAwake', false]]);
});

test('Android bridge: Save and Share call the native side with the absolute image URL', async () => {
  let downloads = 0;
  const onDl = () => downloads++;
  page.on('download', onDl);
  const done = await page.evaluate(() => window.conceptApp.queue.items.filter((i) => i.image).length);
  await page.click(`#thumbs .thumb.s-done >> nth=${done - 1}`);
  await page.waitForSelector('.viewer:not([hidden])');
  const img = await page.evaluate(() => window.conceptApp.viewer.current().image);
  await page.evaluate(() => { window.__bridgeCalls = []; });
  await saveToPhone(page, '.viewer');
  await menuAct(page, '.viewer', 'share');
  await page.waitForTimeout(300);
  const calls = await bridgeCalls();
  assert.equal(calls.length, 2, JSON.stringify(calls));
  const [save, share] = calls;
  assert.equal(save[0], 'saveImage'); assert.equal(share[0], 'shareImage');
  for (const c of [save, share]) {
    const u = new URL(c[1]);
    assert.equal(u.origin, s.base, 'absolute URL on the app origin');
    assert.equal(u.pathname, '/comfy/view');
    assert.equal(u.searchParams.get('filename'), img.filename);
    assert.equal(u.searchParams.get('preview'), null, 'full image, not the thumbnail');
    assert.equal(c[2], img.filename);
  }
  assert.equal(downloads, 0, 'no browser download when the bridge handles Save');
  page.off('download', onDl);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.viewer', { state: 'hidden' });
});

test('without the bridge: Save is a browser download again and keepAwake is never called', async () => {
  await page.evaluate(() => { delete window.AndroidBridge; window.__bridgeCalls = []; });
  await page.click('#thumbs .thumb.s-done >> nth=0');
  await page.waitForSelector('.viewer:not([hidden])');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), saveToPhone(page, '.viewer')]);
  assert.match(dl.suggestedFilename(), /\.png$/);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.viewer', { state: 'hidden' });
  await page.fill('#batch', '1'); await page.locator('#batch').dispatchEvent('change');
  await page.click('#btn-generate');
  await page.waitForFunction(() => window.conceptApp.queue.active.length === 0 && window.conceptApp.queue.items.at(-1).status === 'done', null, { timeout: 8000 });
  assert.deepEqual(await bridgeCalls(), []);
});

test('ComfyUI canvas (top bar toggle, batch 4) shows the proxied ComfyUI UI without leaving the app', async () => {
  await page.click('#btn-canvas');
  const frame = page.frameLocator('#node-view iframe');
  assert.match(await frame.locator('h1').textContent(), /Mock ComfyUI/);
  assert.equal(new URL(page.url()).pathname, '/');
  await page.click('#btn-canvas');
  assert.equal(await page.isVisible('#node-view'), false);
});

test('no page errors during the run', () => {
  // The only expected one: the deliberate UI-format import answered 400.
  assert.deepEqual(errors.filter((e) => !/status of 400 \(Bad Request\)/.test(e)), []);
  assert.ok(errors.length <= 1);
});
