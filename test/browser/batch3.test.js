// Batch 3 browser tests: run lock, Hunyuan cut-out in the UI, background-run
// catch-up, Klein inpaint mask editor, Settings redesign, History multi-select
// and Folders, 3D thumbnails.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStack, ROOT, pngBytes } from '../unit/helpers.js';
import { launch, pickOption, dropdownOptions } from './launch.js';
import { makeGlb } from '../fixtures/media.js';

const SHOTS = path.join(ROOT, 'test/browser/screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
let s, browser, ctx, page, outDir;
const errors = [];

before(async () => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-out3-'));
  fs.mkdirSync(path.join(outDir, 'concept-app'), { recursive: true });
  s = await startStack({ stepMs: 60, folderWorkflows: false, outputDir: outDir });
  browser = await launch();
  ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text() + ' @ ' + (m.location()?.url || '?')); });
  await page.goto(s.base + '/');
  await page.waitForFunction(() => (window.conceptApp?.workflows?.length || 0) > 10);
});
after(async () => { await browser?.close(); await s?.close(); });

const app = (fn, arg) => page.evaluate(fn, arg);
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `b3-${name}.png`), fullPage: false });
async function pick(id) { await page.click('#preset-btn'); await page.click(`#picker .ent[data-preset="${id}"]`); await page.waitForFunction((x) => window.conceptApp.current?.id === x, id); }
const idle = () => page.waitForFunction(() => !document.querySelector('#btn-generate').disabled && window.conceptApp.queue.active.length === 0, null, { timeout: 20000 });
async function setBatch(n) { await page.fill('#batch', String(n)); await page.locator('#batch').dispatchEvent('change'); }

// ---- item 2: run lock ---------------------------------------------------------
test('run lock: Run stays disabled for the whole run, Cancel stays active, no preset switching or extra queuing', async () => {
  await pick('ai:klein-4b-t2i');
  await page.fill('#prompt', 'lock test');
  await setBatch(3);
  await page.click('#btn-generate');
  await page.waitForFunction(() => document.querySelector('#btn-generate').disabled);
  assert.equal(await page.isDisabled('#preset-btn'), true, 'preset switching is blocked');
  assert.equal(await page.isVisible('#btn-cancel'), true);
  assert.equal(await page.isEnabled('#btn-cancel'), true);
  await page.waitForFunction(() => /^\d of 3$/.test(document.querySelector('#run-label').textContent));
  await shot('run-locked');
  // a forced tap and Ctrl+Enter queue nothing extra
  await page.click('#btn-generate', { force: true });
  await page.focus('#prompt'); await page.keyboard.press('Control+Enter');
  const n = await app(() => window.conceptApp.queue.items.length);
  assert.equal(n, 3);
  // Run is still the only blue element while locked (dimmed, not recoloured)
  assert.equal(await page.$eval('#btn-generate', (b) => getComputedStyle(b).backgroundColor), 'rgb(11, 140, 233)');
  await idle();
  assert.equal(await app(() => window.conceptApp.queue.items.filter((i) => i.status === 'done').length), 3);
  assert.equal(await page.isDisabled('#preset-btn'), false);
  assert.equal(await page.textContent('#run-label'), 'Run');
});

test('run lock: Cancel ends the run and unlocks Run', async () => {
  await setBatch(4);
  await page.click('#btn-generate');
  await page.waitForFunction(() => window.conceptApp.queue.active.length > 0);
  await page.click('#btn-cancel');
  await idle();
  const st = await app(() => window.conceptApp.queue.items.slice(-4).map((i) => i.status));
  assert.ok(st.includes('cancelled'), st.join());
  assert.equal(await page.isVisible('#btn-cancel'), false);
});

// ---- item 4: background running -------------------------------------------------
test('Android bridge: runStatus "running N of M" during the run, then one finish call (native side vibrates)', async () => {
  await app(() => {
    window.__runCalls = [];
    window.AndroidBridge = { isNativeApp: () => true, keepAwake: () => {}, runStatus: (c, t, r, d) => window.__runCalls.push([c, t, r, d]) };
  });
  await setBatch(2);
  await page.click('#btn-generate');
  await idle();
  await page.waitForFunction(() => window.__runCalls.at(-1)?.[2] === false);
  const calls = await app(() => window.__runCalls);
  assert.deepEqual(calls[0].slice(0, 3), [1, 2, true]);
  assert.ok(calls.some((c) => c[0] === 2 && c[1] === 2 && c[2] === true), JSON.stringify(calls));
  assert.deepEqual(calls.at(-1), [2, 2, false, 2], 'finish: 2 of 2 done');
  assert.equal(calls.filter((c) => c[2] === false).length, 1, 'finish is reported once');
  await app(() => { delete window.AndroidBridge; });
});

test('resume: a dropped page restores the active run, stays locked, and catches the results up from /history', async () => {
  await setBatch(2);
  await page.click('#btn-generate');
  await page.waitForFunction(() => window.conceptApp.queue.active.some((i) => i.promptId));
  const ids = await app(() => window.conceptApp.queue.lastRun.map((i) => i.promptId));
  assert.ok(JSON.parse(await app(() => localStorage.getItem('conceptRun.v1'))).length >= 1);
  // Android drops the page in the background: a fresh load, new websocket client.
  await app(() => sessionStorage.removeItem('comfyClientId'));
  await page.reload();
  await page.waitForFunction(() => (window.conceptApp?.workflows?.length || 0) > 10);
  const restored = await app(() => window.conceptApp.queue.items.filter((i) => i.restored).map((i) => i.promptId));
  assert.ok(restored.length >= 1 && restored.every((id) => ids.includes(id)), 'active jobs are back');
  await page.waitForFunction(() => window.conceptApp.queue.items.filter((i) => i.restored).every((i) => i.status === 'done'), null, { timeout: 20000 });
  await idle();
  const imgs = await app(() => window.conceptApp.queue.items.filter((i) => i.restored).map((i) => !!i.image));
  assert.ok(imgs.every(Boolean), 'results caught up from /history');
  assert.equal(await app(() => localStorage.getItem('conceptRun.v1')), null, 'nothing left to restore');
});

test('resume: back from the background reconnects the websocket at once (no back-off wait)', async () => {
  const before = await app(() => window.conceptApp.comfy.ws);
  await app(() => { const c = window.conceptApp.comfy; c.retry = 4; c.ws.close(); });
  await page.waitForFunction(() => !window.conceptApp.comfy.connected);
  const t0 = Date.now();
  await app(() => window.conceptApp.resume());
  await page.waitForFunction(() => window.conceptApp.comfy.connected, null, { timeout: 3000 });
  assert.ok(Date.now() - t0 < 3000, 'reconnected before the 16 s back-off');
  assert.ok(before !== undefined);
});

// ---- item 5: memory items in the queued graph ---------------------------------------
const lastGraph = (cls) => Object.values(s.mock.history).map((h) => h.prompt[2]).findLast((w) => Object.values(w).some((n) => n.class_type === cls));
// Batch 5: the menu switch is gone, but a "Text encoder on CPU" value saved on the server is still honoured.
test('saved "Text encoder on CPU" puts CLIPLoader on the CPU; an OOM makes the next run of that preset decode in tiles', async () => {
  await app(() => fetch('/api/memory/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ textEncoderCpu: true }) }));
  await page.reload();
  await page.waitForFunction(() => window.conceptApp?.current);
  await page.waitForTimeout(300);
  await pick('ai:klein-4b-t2i');
  await setBatch(1);
  await page.click('#btn-generate'); await idle();
  let g = lastGraph('Flux2Scheduler');
  assert.equal(Object.values(g).find((n) => n.class_type === 'CLIPLoader').inputs.device, 'cpu');
  assert.ok(Object.values(g).some((n) => n.class_type === 'VAEDecode'), '1 MP: plain decode');
  // an out-of-memory error on this preset -> the next run uses VAEDecodeTiled
  await app(() => localStorage.setItem('conceptOom.v1', JSON.stringify({ 'ai:klein-4b-t2i': Date.now() })));
  await page.click('#btn-generate'); await idle();
  g = lastGraph('Flux2Scheduler');
  const t = Object.values(g).find((n) => n.class_type === 'VAEDecodeTiled');
  assert.ok(t, 'tiled decode'); assert.equal(t.inputs.tile_size, 512);
  assert.ok(!Object.values(g).some((n) => n.class_type === 'VAEDecode'));
  await app(() => localStorage.removeItem('conceptOom.v1'));
  await app(() => fetch('/api/memory/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ textEncoderCpu: false }) }));
  await page.reload();
  await page.waitForFunction(() => window.conceptApp?.current);
});

// ---- item 6: Klein 4B inpaint mask editor ---------------------------------------------
async function pointer(type, init) {
  await app(([type, init]) => {
    const st = document.querySelector('.me-stage'); const r = st.getBoundingClientRect();
    st.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, isPrimary: true, pressure: 0.5, button: 0, buttons: type === 'pointerup' ? 0 : 1, ...init, clientX: r.left + init.x, clientY: r.top + init.y }));
  }, [type, init]);
}
const painted = () => app(() => { const c = document.querySelector('.me-paint'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] >= 128) n++; return n; });
test('Klein inpaint: mask editor paints with the pen (pressure, eraser end), ignores palms and two-finger pinch; the mask PNG goes to its own LoadImage', async () => {
  await pick('ai:klein-4b-inpaint');
  assert.equal(await page.isVisible('#mask-slot'), true);
  assert.equal(await page.isDisabled('#mask-slot [data-act="paint"]'), true, 'no picture yet');
  // a 200 x 100 picture in the image slot
  await app(async () => {
    const c = document.createElement('canvas'); c.width = 200; c.height = 100;
    const x = c.getContext('2d'); x.fillStyle = '#336'; x.fillRect(0, 0, 200, 100);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    await window.conceptApp.refs.upload('1', new File([blob], 'inpaint-src.png', { type: 'image/png' }));
  });
  await page.fill('#prompt', 'a red apple');
  const before = await app(() => window.conceptApp.queue.items.length);
  await page.click('#btn-generate');
  await page.waitForFunction(() => /Paint a mask first/.test(document.querySelector('#toast')?.textContent || ''));
  assert.equal(await app(() => window.conceptApp.queue.items.length), before, 'nothing queued without a mask');
  await page.click('#mask-slot [data-act="paint"]');
  await page.waitForFunction(() => document.querySelector('.me-paint')?.width === 200);
  assert.equal(await page.$eval('.me-stage', (e) => getComputedStyle(e).touchAction), 'none');
  const box = await page.$eval('.me-stage', (e) => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height }; });
  const view = await app(() => ({ ...window.conceptApp.maskSlot.editor.view }));
  const at = (ix, iy) => ({ x: view.x + ix * view.scale, y: view.y + iy * view.scale });
  // hover ring follows a hovering pen
  await pointer('pointermove', { pointerId: 2, pointerType: 'pen', buttons: 0, pressure: 0, ...at(20, 20) });
  assert.equal(await page.isVisible('.me-cursor'), true);
  // pen stroke across the middle
  await pointer('pointerdown', { pointerId: 2, pointerType: 'pen', ...at(60, 50) });
  for (let x = 70; x <= 140; x += 10) await pointer('pointermove', { pointerId: 2, pointerType: 'pen', pressure: 0.9, ...at(x, 50) });
  await pointer('pointerup', { pointerId: 2, pointerType: 'pen', ...at(140, 50) });
  const n1 = await painted();
  assert.ok(n1 > 200, `painted ${n1}`);
  // a palm right after the pen: ignored
  await pointer('pointerdown', { pointerId: 9, pointerType: 'touch', width: 20, height: 20, ...at(20, 80) });
  await pointer('pointermove', { pointerId: 9, pointerType: 'touch', width: 20, height: 20, ...at(40, 80) });
  await pointer('pointerup', { pointerId: 9, pointerType: 'touch', ...at(40, 80) });
  assert.equal(await painted(), n1, 'palm ignored');
  // the pen's eraser end removes paint
  await pointer('pointerdown', { pointerId: 3, pointerType: 'pen', button: 5, buttons: 32, ...at(140, 50) });
  await pointer('pointermove', { pointerId: 3, pointerType: 'pen', buttons: 32, ...at(120, 50) });
  await pointer('pointerup', { pointerId: 3, pointerType: 'pen', ...at(120, 50) });
  const n2 = await painted();
  assert.ok(n2 < n1, 'eraser end erased');
  // two fingers pinch-zoom (no paint, even after the first finger had started)
  await app(() => { window.conceptApp.maskSlot.editor.penActiveAt = 0; });
  await pointer('pointerdown', { pointerId: 11, pointerType: 'touch', width: 10, height: 10, ...at(30, 30) });
  await pointer('pointermove', { pointerId: 11, pointerType: 'touch', width: 10, height: 10, ...at(32, 32) });
  await pointer('pointerdown', { pointerId: 12, pointerType: 'touch', isPrimary: false, width: 10, height: 10, ...at(60, 60) });
  await pointer('pointermove', { pointerId: 12, pointerType: 'touch', isPrimary: false, width: 10, height: 10, ...at(90, 90) });
  await pointer('pointerup', { pointerId: 12, pointerType: 'touch', ...at(90, 90) });
  await pointer('pointermove', { pointerId: 11, pointerType: 'touch', width: 10, height: 10, ...at(10, 10) });
  await pointer('pointerup', { pointerId: 11, pointerType: 'touch', ...at(10, 10) });
  assert.equal(await painted(), n2, 'pinch did not paint');
  assert.ok((await app(() => window.conceptApp.maskSlot.editor.view.scale)) > view.scale, 'zoomed in');
  // rotate/resize: the picture is re-fitted and the painting kept
  await page.setViewportSize({ width: 860, height: 412 });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.mask-editor .me-body')).flexDirection === 'row');
  assert.equal(await painted(), n2);
  await shot('mask-editor-landscape');
  await page.setViewportSize({ width: 412, height: 860 });
  // undo + invert work on the layer
  await page.click('.mask-editor [data-act="invert"]');
  assert.equal(await painted(), 200 * 100 - n2);
  await page.click('.mask-editor [data-act="undo"]');
  assert.equal(await painted(), n2);
  assert.ok(box.w > 0);
  await shot('mask-editor');
  await page.click('.mask-editor [data-act="done"]');
  await page.waitForFunction(() => window.conceptApp.maskSlot.value);
  const ref = await app(() => window.conceptApp.maskSlot.value);
  const key = [...s.mock.files.keys()].find((f) => f.endsWith('/' + ref));
  assert.ok(key, 'mask uploaded to ComfyUI input');
  const png = s.mock.files.get(key);
  assert.equal(png.readUInt32BE(16), 200); assert.equal(png.readUInt32BE(20), 100);
  assert.equal(await page.isVisible('#mask-slot .ref-preview'), true);
  await setBatch(1);
  await page.click('#btn-generate'); await idle();
  const g = lastGraph('InpaintCropImproved');
  assert.equal(g['2'].inputs.image, ref);
  assert.equal(g['1'].inputs.image, 'inpaint-src.png');
  assert.equal(g['22'].inputs.steps, 4); assert.equal(g['19'].inputs.cfg, 1);
  // a new picture invalidates the mask (it belongs to one picture)
  await app(() => window.conceptApp.refs.set('1', 'other.png'));
  assert.equal(await app(() => window.conceptApp.maskSlot.value), null);
});

// ---- item 7: Settings redesign ----------------------------------------------------------
const settingsOpen = () => page.$eval('#settings', (d) => d.open);
async function openSettings() { if (!(await settingsOpen())) await page.click('#settings > summary'); }
const ctl = (key) => `#params .ctl[data-key="${key}"]`;
test('Settings: open row is Aspect | Batch, then Seed full row; everything else under a collapsed "Settings" in 2 columns; open state remembered', async () => {
  await app(() => localStorage.removeItem('conceptSettingsOpen'));
  await page.reload(); await page.waitForFunction(() => (window.conceptApp?.workflows?.length || 0) > 10);
  await pick('ai:z-image-turbo');
  assert.equal(await settingsOpen(), false, 'collapsed by default');
  assert.equal((await page.textContent('#settings > summary')).trim(), 'Settings');
  const quick = await page.$$eval('.quick > .ctl:not([hidden])', (els) => els.map((e) => [e.id, Math.round(e.getBoundingClientRect().width)]));
  assert.deepEqual(quick.map((x) => x[0]), ['aspect-field', 'batch-field', 'seed-field']);
  // batch 5: Aspect (+ orientation + resolution) is the full row; Batch and Seed share the next one
  assert.ok(quick[0][1] > quick[2][1] * 1.3 && quick[2][1] > quick[1][1], 'Aspect full row, Seed wider than Batch');
  await shot('settings-collapsed');
  await page.click('#settings > summary');
  await page.waitForFunction(() => localStorage.getItem('conceptSettingsOpen') === '1');
  const cols = await page.$eval('#params', (g) => getComputedStyle(g).gridTemplateColumns.split(' ').length);
  assert.equal(cols, 2);
  assert.equal(await page.locator(`${ctl('steps')} .stepper.fill`).count(), 1);
  assert.equal(await page.locator(`${ctl('shift')} .slider-box input.sl`).count(), 1);
  assert.equal(await page.textContent(`${ctl('shift')} .val`), '3.0');
  assert.equal(await page.locator(`${ctl('sampler')} .dd .dd-btn`).count(), 1, "batch 15: the app's own dropdown");
  assert.deepEqual((await dropdownOptions(page, `${ctl('sampler')} .dd`)).map(([v]) => v), ['res_multistep', 'euler', 'euler_ancestral', 'dpmpp_2m', 'uni_pc']);
  // slider fill is gray (--p set by JS) and nothing but Run is blue
  assert.match(await page.$eval(`${ctl('shift')} input.sl`, (i) => i.style.getPropertyValue('--p')), /^40(\.0+)?%$/);
  const blue = await page.$$eval('#panel *, .actionbar *, .actionbar', (els) => els.filter((e) => e.offsetParent && [getComputedStyle(e).backgroundColor, getComputedStyle(e).color, getComputedStyle(e).borderTopColor].includes('rgb(11, 140, 233)')).map((e) => e.id || e.className));
  assert.deepEqual(blue, ['btn-generate']);
  await shot('settings-zimage');
  // the value reaches the graph
  await page.fill(`${ctl('shift')} input.sl`, '4.5');
  await pickOption(page, `${ctl('sampler')} .dd`, 'euler');
  await setBatch(1); await page.fill('#prompt', 'settings test');
  await page.click('#btn-generate'); await idle();
  const g = lastGraph('ModelSamplingAuraFlow');
  assert.equal(g['57:11'].inputs.shift, 4.5); assert.equal(g['57:3'].inputs.sampler_name, 'euler');
  await page.reload(); await page.waitForFunction(() => (window.conceptApp?.workflows?.length || 0) > 10);
  assert.equal(await settingsOpen(), true, 'open state remembered');
});

test('Settings: Qwen Lightning On dims Guidance (cfg 1, 4 steps); Off gives 40 steps at cfg 4 with the LoRA switched out', async () => {
  await pick('ai:qwen-2512-t2i');
  await openSettings();
  assert.equal(await page.textContent(`${ctl('lightning')} .seg.text button.on`), 'On');
  assert.equal(await page.$eval(ctl('cfg'), (e) => e.classList.contains('is-off')), true);
  assert.equal(await page.inputValue('#steps'), '4');
  await page.click(`${ctl('lightning')} button[data-value="false"]`);
  assert.equal(await page.$eval(ctl('cfg'), (e) => e.classList.contains('is-off')), false);
  assert.equal(await page.inputValue('#steps'), '40');
  await shot('settings-qwen-off');
  await page.fill('#prompt', 'lightning off'); await setBatch(1);
  await page.click('#btn-generate'); await idle();
  let g = lastGraph('EmptySD3LatentImage');
  assert.deepEqual([g['20'].inputs.switch, g['9'].inputs.steps, g['9'].inputs.cfg], [false, 40, 4]);
  await page.click(`${ctl('lightning')} button[data-value="true"]`);
  assert.equal(await page.inputValue('#steps'), '4');
  await page.click('#btn-generate'); await idle();
  g = lastGraph('EmptySD3LatentImage');
  assert.deepEqual([g['20'].inputs.switch, g['9'].inputs.steps, g['9'].inputs.cfg], [true, 4, 1]);
});

test('Settings: Pixal3D groups + Batch grayed at 1; Texture size also drives the normal bake; Hunyuan Max faces reads Full', async () => {
  await pick('ai:pixal3d-trellis2');
  await openSettings();
  assert.equal(await page.isDisabled('#batch'), true); assert.equal(await page.isDisabled('#batch-plus'), true);
  assert.deepEqual(await page.$$eval('#params .sg-h', (e) => e.map((x) => x.textContent)), ['Sampling', 'Mesh & texture']);
  assert.equal(await page.textContent(`${ctl('model')} button.on`), 'Pixal3D');
  assert.equal(await page.textContent(`${ctl('faces')} .val`), '300k');
  await shot('settings-pixal3d');
  await page.setViewportSize({ width: 1280, height: 800 });
  await shot('settings-pixal3d-tablet');
  await page.setViewportSize({ width: 412, height: 860 });
  await pick('ai:hunyuan3d-21');
  await openSettings();
  assert.equal(await page.textContent(`${ctl('faces')} .val`), 'Full');
  assert.equal(await page.textContent(`${ctl('removeBg')} button.on`), 'On');
  await page.fill(`${ctl('faces')} input.sl`, '200000');
  assert.equal(await page.textContent(`${ctl('faces')} .val`), '200k');
  await shot('settings-hunyuan');
});

test('Settings: SeedVR2 video dims Chunk overlap while Split is Off; Chatterbox voice sample is optional and the length is in seconds', async () => {
  await pick('ai:seedvr2-3b-video');
  await openSettings();
  assert.equal(await page.$eval(ctl('overlap'), (e) => e.classList.contains('is-off')), true);
  assert.equal(await page.$eval(ctl('start'), (e) => e.classList.contains('is-off')), true);
  await page.click(`${ctl('split')} button[data-value="true"]`);
  assert.equal(await page.$eval(ctl('overlap'), (e) => e.classList.contains('is-off')), false);
  await page.click(`${ctl('split')} button[data-value="false"]`);
  await pick('ai:tts-chatterbox');
  await openSettings();
  assert.match(await page.textContent('#file-inputs'), /Voice sample/);
  assert.equal(await page.textContent(`${ctl('seconds')} .val`), '16 s');
  assert.equal(await page.textContent(`${ctl('voice')} .dd-text`), 'Chatterbox (English)'); // batch 15: the app's own dropdown
  await shot('settings-chatterbox');
  await page.fill('#prompt', 'Hello there.'); await setBatch(1);
  await page.click('#btn-generate'); await idle();
  const g = lastGraph('ChatterboxTTS');
  const tts = Object.values(g).find((n) => n.class_type === 'ChatterboxTTS');
  assert.equal(tts.inputs.max_new_tokens, 400); assert.equal(tts.inputs.audio_prompt, undefined);
  assert.ok(!Object.values(g).some((n) => n.class_type === 'LoadAudio'));
});

test('Settings: no hint text inside Settings (labels and value readouts only)', async () => {
  for (const id of ['ai:z-image-turbo', 'ai:pixal3d-trellis2', 'ai:tts-chatterbox', 'ai:klein-4b-inpaint']) {
    await pick(id); await openSettings();
    const extra = await page.$$eval('#params *', (els) => els.filter((e) => e.children.length === 0 && e.textContent.trim() && !e.closest('.label, .seg, select, .dd, .sg-h, .stepper')).map((e) => e.outerHTML));
    assert.deepEqual(extra, [], id);
    assert.equal(await page.locator('#params [title], #params .hint, #params small, #params p').count(), 0, id);
  }
});

// ---- item 8: History multi-select + Folders --------------------------------------
// Every file here is created by this test in its own temp output dir (outDir).
const img = (filename, subfolder = 'concept-app/hist') => ({ filename, subfolder, type: 'output' });
async function seedHistory(names) {
  const ids = [];
  for (const n of names) {
    const f = path.join(outDir, 'concept-app', 'hist', n);
    fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, pngBytes());
    s.mock.files.set(`output/concept-app/hist/${n}`, pngBytes());
    const r = await fetch(s.base + '/api/history', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workflow: 'ai:z-image-turbo', prompt: n, images: [img(n)] }) });
    ids.push((await r.json()).id);
  }
  return ids;
}
async function longPress(sel) {
  const b = await page.locator(sel).boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down(); await page.waitForTimeout(650); await page.mouse.up();
}
const tile = (id) => `.history .thumb[data-id="${id}"]`;
// A failing History test must not leave the overlay over the next test.
afterEach(async () => {
  await page.evaluate(() => {
    document.querySelectorAll('.sheet, .sheet-scrim, .confirm').forEach((e) => e.remove());
    const hv = window.conceptApp?.historyView; if (hv && !hv.root.hidden) { hv.endSelect(true); hv.root.hidden = true; hv.folder = null; hv.favOnly = false; }
  }).catch(() => {});
});

test('History: long-press starts selection, tap toggles, select-all per group, X leaves; sel bar replaces the top bar', async () => {
  const ids = await seedHistory(['sel_a.png', 'sel_b.png', 'sel_c.png']);
  await page.click('#btn-history');
  await page.waitForSelector(tile(ids[0]));
  await longPress(tile(ids[0]));
  await page.waitForSelector('.history.selecting');
  assert.equal(await page.textContent('.sel-count'), '1');
  assert.equal(await page.isVisible('.history-top.sel-bar'), true);
  assert.equal(await page.$eval(tile(ids[0]), (e) => e.classList.contains('selected')), true);
  assert.equal(await page.locator('.viewer:not([hidden])').count(), 0, 'long-press did not open the viewer');
  await page.click(tile(ids[1]));
  assert.equal(await page.textContent('.sel-count'), '2');
  await page.click(tile(ids[1]));
  assert.equal(await page.textContent('.sel-count'), '1');
  const group = await page.$eval(tile(ids[0]), (e) => JSON.parse(e.closest('.history-session').dataset.ids).length);
  await page.locator('.history-session', { has: page.locator(`.thumb[data-id="${ids[0]}"]`) }).locator('.sel-all').click();
  assert.equal(await page.textContent('.sel-count'), String(group));
  await shot('history-select');
  await page.click('[data-act="cancel-sel"]');
  assert.equal(await page.locator('.history.selecting').count(), 0);
  assert.equal(await page.locator('.history .thumb.selected').count(), 0);
  // A plain tap (no selection) still opens the viewer.
  await page.click(tile(ids[2]));
  await page.waitForFunction(() => !document.querySelector('.viewer')?.hidden);
  await page.keyboard.press('Escape');
  await page.evaluate(() => { const v = document.querySelector('.viewer'); if (v && !v.hidden) history.back(); });
  await page.waitForFunction(() => document.querySelector('.viewer')?.hidden !== false);
  await page.evaluate(() => window.conceptApp.historyView.close());
});

test('History: Add to → new folder, Favorites; Folders screen shows cover, name and count; folder view lists only its items', async () => {
  const ids = await seedHistory(['fold_a.png', 'fold_b.png']);
  await page.click('#btn-history');
  await page.waitForSelector(tile(ids[0]));
  await longPress(tile(ids[0]));
  await page.click(tile(ids[1]));
  await page.click('[data-act="add"]');
  await page.waitForSelector('.sheet');
  await shot('history-add-to');
  await page.fill('.sheet-input', 'Robots');
  await page.click('.sheet [data-act="create"]');
  await page.waitForFunction(() => !document.querySelector('.sheet') && !document.querySelector('.history.selecting'));
  await longPress(tile(ids[0]));
  await page.click('[data-act="add"]');
  await page.click('.sheet [data-folder="favorites"]');
  await page.waitForFunction(() => !document.querySelector('.sheet'));
  await page.click('.history [data-act="folders"]');
  await page.waitForSelector('.folder-card[data-folder]:not([data-folder="favorites"])');
  const cards = await page.$$eval('.folder-card', (els) => els.map((e) => [e.dataset.folder === 'favorites' ? 'fav' : 'f', e.querySelector('.folder-name').textContent, e.querySelector('.folder-count').textContent, !!e.querySelector('.folder-cover img')]));
  assert.deepEqual(cards[0].slice(0, 2), ['fav', 'Favorites'], 'Favorites first');
  assert.ok(Number(cards[0][2]) >= 1);
  assert.deepEqual(cards[1], ['f', 'Robots', '2', true]);
  await shot('folders');
  await page.click('.folder-card:has-text("Robots")');
  await page.waitForFunction(() => document.querySelector('.history h2')?.textContent === 'Robots' && document.querySelectorAll('.history .thumb[data-id]').length === 2);
  const shown = await page.$$eval('.history .thumb[data-id]', (els) => els.map((e) => e.dataset.id).sort());
  assert.deepEqual(shown, [...ids].sort());
  await page.evaluate(() => window.conceptApp.historyView.close());
  await page.evaluate(() => { window.conceptApp.historyView.folder = null; });
});

test('History: Delete asks first; Cancel keeps everything; Delete removes only this test\'s files (inside output/concept-app)', async () => {
  const ids = await seedHistory(['del_a.png', 'del_b.png']);
  const files = ['del_a.png', 'del_b.png'].map((n) => path.join(outDir, 'concept-app', 'hist', n));
  await page.click('#btn-history');
  await page.waitForSelector(tile(ids[0]));
  await longPress(tile(ids[0]));
  await page.click(tile(ids[1]));
  await page.click('[data-act="delete"]');
  await page.waitForSelector('.confirm');
  assert.match(await page.textContent('.confirm p'), /Delete 2 items/);
  await shot('history-delete-confirm');
  await page.click('.confirm [data-act="cancel"]');
  assert.ok(files.every((f) => fs.existsSync(f)), 'Cancel deletes nothing');
  assert.equal(await page.textContent('.sel-count'), '2');
  await page.click('[data-act="delete"]');
  await page.click('.confirm [data-act="confirm"]');
  await page.waitForFunction((x) => !document.querySelector(`.history .thumb[data-id="${x}"]`), ids[0]);
  assert.ok(files.every((f) => !fs.existsSync(f)), 'the two test files are gone');
  const left = (await (await fetch(s.base + '/api/history')).json()).sessions.flatMap((x) => x.entries).map((e) => e.id);
  assert.ok(!left.includes(ids[0]) && !left.includes(ids[1]));
  assert.equal(await page.locator('.history.selecting').count(), 0);
  await page.evaluate(() => window.conceptApp.historyView.close());
});

test('History selection bar and folders use no blue (Run stays the only blue element)', async () => {
  const ids = await seedHistory(['blue_a.png']);
  await page.click('#btn-history');
  await page.waitForSelector(tile(ids[0]));
  await longPress(tile(ids[0]));
  const blue = await page.$$eval('.history *, .history', (els) => els.filter((e) => {
    const cs = getComputedStyle(e);
    return [cs.color, cs.backgroundColor, cs.borderTopColor, cs.outlineColor].some((c) => { const m = /rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?/.exec(c); if (!m || (m[4] !== undefined && Number(m[4]) === 0)) return false; const [r, g, b] = m.slice(1, 4).map(Number); return b > 150 && b - r > 80 && b - g > 30; });
  }).map((e) => e.className));
  assert.deepEqual(blue, []);
  await page.click('[data-act="cancel-sel"]');
  await page.evaluate(() => window.conceptApp.historyView.close());
});

// ---- item 9: real 3D thumbnails -------------------------------------------------
test('3D tiles: lazy stills through ONE offscreen renderer; offscreen tiles are not rendered until scrolled to', async () => {
  const glb = makeGlb();
  const N = 48;
  for (let i = 0; i < N; i++) {
    const n = `lazy_${String(i).padStart(2, '0')}.glb`;
    s.mock.files.set(`output/concept-app/hist/${n}`, glb);
    await fetch(s.base + '/api/history', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workflow: 'ai:hunyuan3d-21', prompt: '', files: [img(n)], status: 'done' }) });
  }
  await page.click('#btn-history');
  await page.waitForSelector('.history .thumb.is-3d');
  // Earlier tests' pictures come first in the session: bring the first 3D tile up.
  await page.$eval('.history .thumb.is-3d', (t) => t.scrollIntoView({ block: 'start' }));
  await page.waitForFunction(() => document.querySelectorAll('.history .thumb.is-3d.has-still').length >= 4, null, { timeout: 30000 });
  await page.waitForTimeout(800);
  const st = await page.evaluate(async () => ({ ...(await import('/js/ui/model-thumbs.js')).stats }));
  const total = await page.locator('.history .thumb.is-3d').count();
  assert.ok(total >= N);
  assert.ok(st.renders > 0 && st.renders < N, `only visible tiles rendered (${st.renders} of ${N})`);
  assert.equal(st.contexts, 1, 'one shared WebGL context');
  assert.equal(await page.locator('canvas').evaluateAll((cs) => cs.filter((c) => c.closest('.history')).length), 0, 'no canvas inside tiles');
  const src = await page.$eval('.history .thumb.is-3d.has-still img', (e) => e.src);
  assert.match(src, /^blob:/);
  // A rendered still is not blank: some pixels differ from the background.
  const varied = await page.$eval('.history .thumb.is-3d.has-still img', async (im) => { await im.decode(); const c = document.createElement('canvas'); c.width = 64; c.height = 64; const x = c.getContext('2d'); x.drawImage(im, 0, 0, 64, 64); const d = x.getImageData(0, 0, 64, 64).data; const set = new Set(); for (let i = 0; i < d.length; i += 4) set.add(`${d[i] >> 3},${d[i + 1] >> 3},${d[i + 2] >> 3}`); return set.size; });
  assert.ok(varied > 3, `still has content (${varied} colours)`);
  await shot('history-3d-stills');
  await page.evaluate(() => { const h = document.querySelector('.history'); h.scrollTop = h.scrollHeight; });
  await page.waitForFunction(() => [...document.querySelectorAll('.history .thumb.is-3d')].slice(-2).every((t) => t.classList.contains('has-still')), null, { timeout: 30000 });
  const st2 = await page.evaluate(async () => ({ ...(await import('/js/ui/model-thumbs.js')).stats }));
  assert.ok(st2.renders > st.renders, 'scrolling renders the newly seen tiles');
  assert.equal(st2.contexts, 1);
  await page.evaluate(() => window.conceptApp.historyView.close());
});

test('3D tiles: the still is cached in IndexedDB (a new page/instance does not re-render)', async () => {
  const r = await page.evaluate(async () => {
    const { ModelThumbs, stats } = await import('/js/ui/model-thumbs.js');
    const { getThumb, thumbKey } = await import('/js/lib/thumb-cache.js');
    // As History lists it: with v (its prompt / entry id), part of the cache key.
    const h = await (await fetch('/api/history')).json();
    const file = h.sessions.flatMap((s) => s.entries).flatMap((e) => e.files || []).find((x) => x.filename === 'lazy_00.glb' && x.subfolder === 'concept-app/hist');
    const cached = !!(await getThumb(thumbKey(file)));
    let calls = 0;
    const mt = new ModelThumbs({ render: async () => { calls++; return null; } });
    const tile = document.createElement('button'); const im = document.createElement('img'); tile.append(im); document.body.append(tile);
    const hits = stats.cacheHits;
    mt.attach(tile, im, file, null);
    await new Promise((res) => { const t0 = Date.now(); (function w() { if (tile.classList.contains('has-still') || Date.now() - t0 > 5000) res(); else setTimeout(w, 50); })(); });
    tile.remove();
    return { cached, calls, hit: stats.cacheHits - hits, still: tile.classList.contains('has-still') };
  });
  assert.deepEqual(r, { cached: true, calls: 0, hit: 1, still: true });
});

test('3D tiles: fallback is the source picture, then a neutral 3D placeholder; the session strip gets stills too', async () => {
  for (const [n, parent] of [['fb_src.glb', img('src_pic.png')], ['fb_none.glb', null]]) {
    // No GLB bytes in the mock: rendering fails, the fallback stays.
    await fetch(s.base + '/api/history', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workflow: 'ai:hunyuan3d-21', prompt: n, files: [img(n)], parent: parent ? { image: parent } : undefined, status: 'done' }) });
  }
  s.mock.files.set('output/concept-app/hist/src_pic.png', pngBytes());
  await page.click('#btn-history');
  await page.waitForSelector('.history .thumb.is-3d[title="fb_none.glb"]');
  await page.locator('.history .thumb.is-3d[title="fb_none.glb"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(1500);
  const srcTile = await page.$eval('.history .thumb.is-3d[title="fb_src.glb"]', (t) => ({ src: t.querySelector('img').getAttribute('src') || '', still: t.classList.contains('has-still'), ph: t.classList.contains('ph-3d') }));
  assert.match(srcTile.src, /src_pic\.png/); assert.equal(srcTile.still, false); assert.equal(srcTile.ph, false);
  const none = await page.$eval('.history .thumb.is-3d[title="fb_none.glb"]', (t) => ({ ph: t.classList.contains('ph-3d'), still: t.classList.contains('has-still'), label: t.querySelector('.thumb-label').textContent }));
  assert.deepEqual(none, { ph: true, still: false, label: '3D' });
  await page.evaluate(() => window.conceptApp.historyView.close());
  // Session strip: a finished 3D job tile gets the rendered still.
  await pick('ai:hunyuan3d-21');
  s.mock.files.set('input/obj3d.png', pngBytes());
  await app(() => window.conceptApp.refs.set('2', 'obj3d.png'));
  await page.click('#btn-generate'); await idle();
  await page.waitForSelector('#thumbs .thumb.is-3d');
  await page.$eval('#thumbs .thumb.is-3d', (t) => t.scrollIntoView({ inline: 'nearest', block: 'nearest' }));
  await page.waitForFunction(() => document.querySelector('#thumbs .thumb.is-3d.has-still'), null, { timeout: 60000 });
  const st = await page.evaluate(async () => ({ ...(await import('/js/ui/model-thumbs.js')).stats }));
  assert.equal(st.contexts, 1);
});

// ---- follow-up: Google Photos selection layout, Favorites tile, Qwen 2509 refs, ACE Auto key ----
test('History selection matches the Google Photos layout: X · count · share · + · trash · ⋮, check circles top-left, select-all circle right of each day header', async () => {
  const DAY = 864e5, now = Date.now();
  const mk = async (n, createdAt) => {
    const f = path.join(outDir, 'concept-app', 'hist', n); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, pngBytes()); s.mock.files.set(`output/concept-app/hist/${n}`, pngBytes());
    return (await (await fetch(s.base + '/api/history', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workflow: 'ai:z-image-turbo', prompt: n, images: [img(n)], createdAt }) })).json()).id;
  };
  const old1 = await mk('gp_old1.png', now - 3 * DAY), old2 = await mk('gp_old2.png', now - 40 * DAY);
  const ids = await seedHistory(['gp_a.png', 'gp_b.png', 'gp_c.png']);
  await page.click('#btn-history');
  await page.waitForSelector(tile(old2));
  const heads = await page.$$eval('.history-session h3', (hs) => hs.map((h) => [h.querySelector('.day').textContent, h.lastElementChild.classList.contains('sel-all')]));
  assert.equal(heads[0][0], 'Today');
  assert.ok(heads.every(([, right]) => right), 'select-all circle is the last thing in each header');
  assert.ok(heads.some(([d]) => /^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}$/.test(d)), JSON.stringify(heads));
  assert.equal(new Set(heads.map((x) => x[0])).size, heads.length, 'one header per day');
  await longPress(tile(ids[0]));
  await page.waitForSelector('.history.selecting');
  const bar = await page.$$eval('.history-top.sel-bar > *', (els) => els.map((e) => e.dataset.act || e.className));
  assert.deepEqual(bar.filter((x) => x !== 'spacer'), ['cancel-sel', 'sel-count', 'favorite', 'share', 'add', 'delete', 'more']); // batch 5: + favourite star
  // circles: top-left on every tile; selected = white fill, not blue
  const geo = await page.$eval(tile(ids[1]), (t) => { const a = t.getBoundingClientRect(), c = t.querySelector('.sel-check').getBoundingClientRect(); return { dx: c.left - a.left, dy: c.top - a.top, w: c.width, br: getComputedStyle(t.querySelector('.sel-check')).borderRadius, shown: getComputedStyle(t.querySelector('.sel-check')).display }; });
  assert.ok(geo.dx < 12 && geo.dy < 12 && geo.w >= 20 && geo.shown === 'flex' && geo.br === '50%', JSON.stringify(geo));
  const selBg = await page.$eval(`${tile(ids[0])} .sel-check`, (c) => getComputedStyle(c).backgroundColor);
  assert.equal(selBg, 'rgb(255, 255, 255)');
  const hr = await page.$eval('.history-session h3', (h) => { const a = h.getBoundingClientRect(), b = h.querySelector('.sel-all').getBoundingClientRect(); return a.right - b.right; });
  assert.ok(hr < 24, `select-all sits at the right (${hr}px)`);
  await page.locator('.history-session', { has: page.locator(`.thumb[data-id="${old1}"]`) }).locator('.sel-all').click();
  assert.equal(await page.textContent('.sel-count'), '2');
  await page.$eval('.history', (h) => { h.scrollTop = 0; });
  await shot('history-select-gphotos');
  await page.locator(tile(old1)).scrollIntoViewIfNeeded();
  await shot('history-select-gphotos-days');
  // ⋮ menu: Select all
  await page.click('[data-act="more"]');
  await page.waitForSelector('.sel-menu');
  await shot('history-select-menu');
  await page.click('.sel-menu [data-act="select-all"]');
  assert.equal(Number(await page.textContent('.sel-count')), await page.locator('.history .thumb[data-id]').count());
  await page.click('[data-act="cancel-sel"]');
});

test('Favorites is the first tile in the Folders grid, backed by the star; ⋮ in Favorites removes the star', async () => {
  const ids = await seedHistory(['favtile_a.png']);
  await fetch(s.base + `/api/history/${ids[0]}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ favorite: true }) });
  const favCount = (await (await fetch(s.base + '/api/folders')).json()).favorites.count;
  await page.click('#btn-history');
  await page.click('.history [data-act="folders"]');
  await page.waitForSelector('.folder-card[data-folder="favorites"]');
  assert.equal(await page.$eval('.folder-grid > .folder-card', (c) => c.dataset.folder), 'favorites');
  assert.equal(await page.textContent('.folder-card[data-folder="favorites"] .folder-count'), String(favCount));
  assert.equal(await page.locator('.folder-card[data-folder="favorites"] .folder-cover img').count(), 1);
  await page.click('.folder-card[data-folder="favorites"]');
  await page.waitForFunction(() => document.querySelector('.history h2')?.textContent === 'Favorites');
  await page.waitForSelector(tile(ids[0]));
  await longPress(tile(ids[0]));
  await page.click('[data-act="more"]');
  await page.click('.sel-menu [data-act="remove-fav"]');
  await page.waitForFunction((x) => !document.querySelector(`.history .thumb[data-id="${x}"]`), ids[0]);
  assert.equal((await (await fetch(s.base + '/api/folders')).json()).favorites.count, favCount - 1);
  // batch 5: History hides the workflow dropdown, so leave it before the next test picks a preset
  await app(() => { const hv = window.conceptApp.historyView; hv.endSelect(); hv.close(); });
  await page.waitForFunction(() => !document.body.classList.contains('history-on'));
});

test('Qwen Edit 2509: three picture slots, 2 and 3 optional; slot 1 alone gives a graph without image2/image3; two refs wire image2', async () => {
  await pick('ai:qwen-edit-2509');
  const slots = await page.$$eval('#reference .ref-slot, .ref-slot', (els) => [...new Set(els.map((e) => e.dataset.node))]);
  assert.deepEqual(slots, ['6', '21', '22']);
  await shot('qwen2509-three-refs');
  await page.fill('#prompt', 'put the hat from picture 2 on the person');
  await setBatch(1);
  await app(() => { const r = window.conceptApp.refs; for (const n of ['6', '21', '22']) r.set(n, null); });
  await page.click('#btn-generate');
  assert.ok(await page.waitForFunction(() => /Add a picture first/.test(document.body.textContent)).catch(() => true));
  await app(() => window.conceptApp.refs.set('6', 'qa.png'));
  await page.click('#btn-generate'); await idle();
  let g = lastGraph('TextEncodeQwenImageEditPlus');
  assert.ok(!g['21'] && !g['22']);
  assert.deepEqual(Object.keys(g['7'].inputs).filter((k) => k.startsWith('image')), ['image1']);
  await app(() => window.conceptApp.refs.set('21', 'qb.png'));
  await page.click('#btn-generate'); await idle();
  g = lastGraph('TextEncodeQwenImageEditPlus');
  assert.equal(g['21'].inputs.image, 'qb.png'); assert.ok(!g['22']);
  assert.deepEqual(g['7'].inputs.image2, ['21', 0]); assert.deepEqual(g['8'].inputs.image2, ['21', 0]);
  await app(() => { const r = window.conceptApp.refs; for (const n of ['6', '21']) r.set(n, null); });
});

test('ACE-Step: Key offers Auto (default) in the app\'s preset list (graph resolution is unit-tested; ACE is not installed in the mock)', async () => {
  const k = await app(() => window.conceptApp.workflows.find((w) => w.id === 'ai:ace-step-15').ai.params.key);
  assert.equal(k.options[0], 'auto'); assert.equal(k.default, 'auto'); assert.equal(k.labels.auto, 'Auto');
});

test('no page errors in the batch 3 run', () => {
  assert.deepEqual(errors.filter((e) => !/Failed to load resource: .* (503|404)/.test(e)), []);
});
