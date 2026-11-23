// Batch 7 in the app: the Import button (photo / video / recording -> "What next?"),
// Record on audio slots, the new presets in the picker.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startStack, ROOT } from '../unit/helpers.js';
import { launch } from './launch.js';

const SHOTS = path.join(ROOT, 'test/browser/screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
let s, browser, page;
const errors = [];

// 1x1 PNG and a short silent WAV
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
function wav(seconds = 0.5, rate = 8000) {
  const n = Math.round(seconds * rate), b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  return b;
}

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
const shot = (n) => page.screenshot({ path: path.join(SHOTS, `b7-${n}.png`) });
const setFile = async (which, name, mimeType, buffer) => {
  const input = await page.evaluateHandle((w) => window.conceptApp.importSheet.inputs[w], which);
  await input.asElement().setInputFiles({ name, mimeType, buffer });
};

test('+ in the prompt box (batch 8): the sheet offers photo, video, recording, files, paste and From Comfy UI', async () => {
  await app(() => window.conceptApp.selectPreset('ai:z-image-turbo'));
  assert.equal(await page.isVisible('#btn-attach'), true);
  assert.equal(await page.locator('#btn-import-media').count(), 0, 'the top bar button is gone');
  assert.equal(await page.locator('.prompt-box #btn-attach').count(), 1);
  await page.click('#btn-attach');
  await page.waitForSelector('.import-sheet');
  assert.deepEqual(await page.$$eval('.import-sheet .sheet-row', (r) => r.map((x) => x.dataset.act)), ['photo', 'video', 'record', 'device', 'audio-file', 'paste', 'comfy']);
  // capture inputs: camera for photo / video, gallery for both kinds
  assert.deepEqual(await app(() => { const i = window.conceptApp.importSheet.inputs; return [i.photo.accept, i.photo.getAttribute('capture'), i.video.accept, i.video.getAttribute('capture'), i.device.accept]; }), ['image/*', 'environment', 'video/*', 'environment', 'image/*,video/*']);
  await shot('sheet');
  await page.click('.sheet-scrim');
  await page.waitForSelector('.import-sheet', { state: 'detached' });
});

test('a photo: uploaded, "What next?" lists only presets that take a picture; picking one fills its slot', async () => {
  await setFile('device', 'wall.png', 'image/png', PNG);
  await page.waitForFunction(() => document.querySelector('.preset-chooser:not([hidden]) .ov-title')?.textContent === 'What next?');
  assert.equal(await page.isVisible('.preset-chooser .pc-preview img'), true);
  const rows = await page.$$eval('.preset-chooser .ent .nm', (r) => r.map((x) => x.textContent));
  assert.ok(rows.includes('Photo to Texture') && rows.includes('PBR Maps') && rows.includes('Remove Lighting'), rows.join(', '));
  assert.ok(!rows.includes('Z-Image Turbo') && !rows.includes('Stable Audio 3 SFX'), 'nothing that takes no picture');
  await shot('what-next');
  await page.click('.preset-chooser .ent:has(.nm:text-is("Photo to Texture"))');
  await page.waitForFunction(() => window.conceptApp.current?.id === 'ai:wf-photo-texture');
  await page.waitForSelector('#refs .ref-preview:not([hidden])');
  assert.match(await page.textContent('#toast'), /Photo ready in Photo to Texture/);
  // its notes box: the built-in default as placeholder
  assert.match(await page.getAttribute('#prompt', 'placeholder'), /keep all of the surface/);
});

test('a recording: "What next?" lists the presets with an audio slot; Voice Swap gets it as "Your recording"', async () => {
  await setFile('audioFile', 'line.wav', 'audio/wav', wav());
  await page.waitForFunction(() => document.querySelector('.preset-chooser:not([hidden]) .ov-title')?.textContent === 'What next?');
  assert.equal(await page.isVisible('.preset-chooser .pc-preview audio'), true);
  const rows = await page.$$eval('.preset-chooser .ent .nm', (r) => r.map((x) => x.textContent));
  assert.ok(rows.includes('Chatterbox Voice Swap'), rows.join(', '));
  assert.ok(!rows.includes('Photo to Texture'));
  await page.click('.preset-chooser .ent:has(.nm:text-is("Chatterbox Voice Swap"))');
  await page.waitForFunction(() => window.conceptApp.current?.id === 'ai:chatterbox-voice-swap');
  await page.waitForFunction(() => /\.wav/.test(document.querySelector('#file-inputs .ref-slot .ref-empty')?.textContent || ''));
  // both audio slots have Pick + Record
  assert.equal(await page.locator('#file-inputs .rec-btn').count(), 2);
  await shot('voice-swap');
  // batch 8: the current preset takes recordings -> the next one goes straight into its empty slot, no chooser
  await setFile('audioFile', 'voice.wav', 'audio/wav', wav());
  await page.waitForFunction(() => document.querySelectorAll('#file-inputs .ref-slot .ref-empty').length === 2 && [...document.querySelectorAll('#file-inputs .ref-slot .ref-empty')].every((e) => /.wav/.test(e.textContent)));
  assert.equal(await page.isVisible('.preset-chooser'), false);
  assert.equal(await app(() => window.conceptApp.current.id), 'ai:chatterbox-voice-swap', 'never switches by itself');
});

test('batch 8: a photo while the preset takes pictures goes straight into its slot; switching presets keeps it', async () => {
  await app(() => window.conceptApp.selectPreset('ai:hunyuan3d-21'));
  await setFile('device', 'chair.png', 'image/png', PNG);
  await page.waitForSelector('#refs .ref-preview:not([hidden])');
  assert.equal(await page.isVisible('.preset-chooser'), false);
  const ref = await app(() => Object.values(window.conceptApp.refs.values)[0]);
  assert.ok(ref);
  await app(() => window.conceptApp.selectPreset('ai:wf-photo-to-3d'));
  assert.deepEqual(await app(() => Object.values(window.conceptApp.refs.values)), [ref], 'carried into the new preset');
  await page.waitForSelector('#refs .ref-preview:not([hidden])');
  await app(() => window.conceptApp.selectPreset('ai:z-image-turbo'));
  assert.deepEqual(await app(() => window.conceptApp.refs.values), {}, 'a text-only preset drops it');
});

test('+ hides in the node view; new presets sit in the right sections', async () => {
  await page.click('#btn-canvas');
  await page.waitForFunction(() => document.body.classList.contains('node-view-on'));
  assert.equal(await page.isVisible('#btn-attach'), false);
  await page.click('#btn-canvas');
  await page.waitForFunction(() => !document.body.classList.contains('node-view-on'));
  const where = await app(() => Object.fromEntries(['ai:wf-photo-texture', 'ai:wf-pbr-maps', 'ai:wf-pbr-chord', 'ai:wf-depth-normal', 'ai:sa3-small-sfx', 'ai:chatterbox-voice-swap'].map((id) => { const w = window.conceptApp.workflows.find((x) => x.id === id); return [id, `${w.kind}:${w.group}`]; })));
  assert.deepEqual(where, { 'ai:wf-photo-texture': 'workflow:Textures', 'ai:wf-pbr-maps': 'workflow:Textures', 'ai:wf-pbr-chord': 'workflow:Textures', 'ai:wf-depth-normal': 'workflow:Textures', 'ai:sa3-small-sfx': 'model:Audio', 'ai:chatterbox-voice-swap': 'model:Audio' });
});

test('no page errors', () => { assert.deepEqual(errors, []); });
