// Batch 2: main screen / picker / menu cleanup, the 3D viewer (wireframe
// toggle, counts, reset), the audio player (waveform, duration, scrub),
// "From Comfy UI" in the reference slot, "Use as reference" on image results
// (current preset, or a short list of 3D / Image Edit presets), and Save to
// Drive from the image viewer, 3D viewer and audio player.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStack, ROOT, pngBytes } from '../unit/helpers.js';
import { makeGlb, makeWav, makeVideo } from '../fixtures/media.js';
import { launch } from './launch.js';

const SHOTS = path.join(ROOT, 'test/browser/screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
let s, browser, ctx, page, outDir;
const errors = [];

// Earlier results on "the PC": output/concept-app on disk (listed) + the same bytes in the mock ComfyUI (served).
const EARLIER = ['earlier_00001_.png', 'earlier_00002_.png', 'earlier_00003_.png'];
before(async () => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-out-'));
  fs.mkdirSync(path.join(outDir, 'concept-app'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'private'), { recursive: true });
  EARLIER.forEach((f, i) => { const p = path.join(outDir, 'concept-app', f); fs.writeFileSync(p, pngBytes()); fs.utimesSync(p, 1000 + i, 1000 + i); });
  fs.writeFileSync(path.join(outDir, 'private', 'not-mine.png'), pngBytes());
  s = await startStack({ stepMs: 30, folderWorkflows: false, outputDir: outDir });
  for (const f of EARLIER) s.mock.files.set(`output/concept-app/${f}`, pngBytes());
  s.mock.files.set('output/private/not-mine.png', pngBytes());
  s.mock.files.set('output/concept-app/cube_00001_.glb', makeGlb());
  s.mock.files.set('output/concept-app/tone_00001.flac', makeWav(2));
  s.mock.files.set('output/concept-app/clip_00001_.webm', makeVideo());
  s.mock.files.set('output/concept-app/anim_00001_.gif', Buffer.from('GIF89a'));
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
async function pick(id) { await page.click('#preset-btn'); await page.click(`#picker .ent[data-preset="${id}"]`); await page.waitForFunction((x) => window.conceptApp.current?.id === x, id); }
const doneCount = () => page.$$eval('#thumbs .thumb', (els) => els.filter((e) => e.className.includes('s-done')).length);
async function runAndWait() {
  const n = await doneCount();
  await page.click('#btn-generate');
  await page.waitForFunction((n) => [...document.querySelectorAll('#thumbs .thumb')].filter((e) => e.className.includes('s-done')).length > n, n, { timeout: 10000 });
  // batch 3 run lock: the whole run has to end before the preset can change again
  await page.waitForFunction(() => !document.querySelector('#btn-generate').disabled, null, { timeout: 15000 });
  return app(() => window.conceptApp.queue.items.at(-1));
}
const refValue = (node) => app((n) => window.conceptApp.refs.values[n] || null, node);
// What ended up in a reference slot: the file uploaded to ComfyUI's input folder (name + bytes).
async function uploaded(node) {
  const ref = await refValue(node); // "name" or "subfolder/name" in ComfyUI's input folder
  const i = ref.lastIndexOf('/'), name = ref.slice(i + 1), sub = i < 0 ? '' : ref.slice(0, i);
  const r = await fetch(`${s.mockBase}/view?type=input&subfolder=${encodeURIComponent(sub)}&filename=${encodeURIComponent(name)}`);
  return { name, bytes: Buffer.from(await r.arrayBuffer()) };
}
const fullRes = pngBytes();
// Wait for the toast to say something (string = contains, RegExp = matches).
const waitToast = (want) => page.waitForFunction(([src, flags, str]) => { const t = document.getElementById('toast')?.textContent || ''; return str != null ? t.includes(str) : new RegExp(src, flags).test(t); }, want instanceof RegExp ? [want.source, want.flags, null] : [null, null, want], { timeout: 8000 });
// Screenshot without a leftover toast over the controls.
const shot = async (name) => { await page.evaluate(() => document.getElementById('toast')?.classList.remove('show')); await page.waitForTimeout(250); await page.screenshot({ path: path.join(SHOTS, `batch2-${name}.png`) }); };
const closeOverlay = async (sel) => { await page.click(`${sel} .ov-top button[aria-label="Close"]`); await page.waitForSelector(`${sel}`, { state: 'hidden' }); await page.waitForTimeout(450); };

test('main screen: no preset description box; open row is Aspect, Batch, Seed; Steps is under Settings (batch 3); dark theme + Run unchanged', async () => {
  await pick('ai:klein-4b-t2i');
  assert.equal(await page.locator('#more, details.more, #preset-desc, .preset-desc').count(), 0);
  assert.equal(await page.isVisible('#preset-msg'), false, 'no description / recommendation box');
  // batch 3 (the owner, Nov 22 10:17): Steps went back under one "Settings" twirl-down
  const row = await page.$$eval('.quick > .ctl:not([hidden]) > .label > span:first-child', (els) => els.map((x) => x.textContent));
  assert.deepEqual(row, ['Aspect', 'Batch', 'Seed']);
  if (!(await page.$eval('#settings', (d) => d.open))) await page.click('#settings > summary');
  assert.equal(await page.isVisible('#steps'), true);
  await page.click('#settings > summary');
  assert.equal(await page.$eval('#btn-generate', (b) => getComputedStyle(b).backgroundColor), 'rgb(11, 140, 233)');
  assert.doesNotMatch(await page.textContent('#panel'), /More settings|after the upgrade|Recommended|tight on|RAM offload|Results appear here/);
  await shot('main');
});

test('picker: rows are names only; a grayed-out (missing) row says what is missing when tapped', async () => {
  await page.click('#preset-btn');
  assert.equal(await page.locator('#picker .tg').count(), 0);
  assert.doesNotMatch(await page.textContent('#picker'), /same list|tight on|RAM offload|needs download/);
  const wan = page.locator('#picker .ent[data-preset="ai:wan22-5b-ti2v"]');
  assert.equal(await wan.getAttribute('aria-disabled'), 'true');
  await shot('picker');
  await wan.click({ force: true }); // aria-disabled: Playwright would wait for it to be enabled
  await waitToast(/needs download: wan2\.2_ti2v_5B_fp16\.safetensors/);
  assert.equal(await app(() => window.conceptApp.current.id), 'ai:klein-4b-t2i', 'a disabled row is not selected');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#picker', { state: 'hidden' });
});

test('top bar: no ⋮ menu any more (batch 5), so no GPU & memory readout / Refresh / profile setting', async () => {
  assert.equal(await page.$('details.menu, .menu-pop'), null);
  assert.doesNotMatch(await page.textContent('.topbar'), /GPU|memory|Refresh|Profile|Recommended/i);
});

test('Use as reference (current preset has no image input): short list of 3D + Image Edit presets -> switches and loads the full-res picture', async () => {
  await pick('ai:klein-4b-t2i');
  await page.fill('#prompt', 'a ceramic owl');
  await runAndWait();
  await page.locator('#thumbs .thumb.s-done').last().click();
  await page.waitForSelector('.viewer:not([hidden])');
  const shown = await app(() => window.conceptApp.viewer.current().image);
  // every action label fits its button on a phone-width screen (no "Use as refer…")
  assert.deepEqual(await page.$$eval('.viewer-actions .icon-btn', (b) => b.filter((x) => x.scrollWidth > x.clientWidth + 1 || x.scrollHeight > x.clientHeight + 1).map((x) => x.textContent)), []);
  await page.click('.viewer button[title="Use as reference"]');
  await page.waitForSelector('.preset-chooser:not([hidden]) .ent');
  const ids = await page.$$eval('.preset-chooser .ent', (els) => els.map((e) => e.dataset.preset));
  assert.deepEqual(ids, ['ai:hunyuan3d-21', 'ai:pixal3d-trellis2', 'ai:klein-4b-edit', 'ai:qwen-edit-2509', 'ai:qwen-edit-2511']);
  assert.ok(!ids.some((id) => /upscale|seedvr/.test(id)), 'upscalers are not offered');
  assert.equal(await page.isVisible('.viewer'), false);
  await shot('use-as-reference-list');
  await page.click('.preset-chooser .ent[data-preset="ai:hunyuan3d-21"]');
  await page.waitForFunction(() => window.conceptApp.current?.id === 'ai:hunyuan3d-21');
  await page.waitForFunction(() => !!window.conceptApp.refs.values['2'], null, { timeout: 5000 });
  const up = await uploaded('2');
  assert.match(up.name, new RegExp('^' + shown.filename.replace(/\.png$/, '')));
  assert.deepEqual(up.bytes, Buffer.from(await (await fetch(`${s.mockBase}/view?type=output&subfolder=${shown.subfolder}&filename=${shown.filename}`)).arrayBuffer()), 'the original file, not a preview');
  assert.equal(await page.isVisible('.ref-slot[data-node="2"] .ref-preview'), true);
  assert.equal(await page.isVisible('.preset-chooser'), false);
  await shot('use-as-reference-loaded');
});

test('Use as reference (current preset takes a picture): loads straight into its slot, no list', async () => {
  await pick('ai:klein-4b-edit');
  const before = await refValue('76');
  await app(() => window.conceptApp.useAsReference({ filename: 'earlier_00002_.png', subfolder: 'concept-app', type: 'output' }));
  await page.waitForFunction((b) => { const v = window.conceptApp.refs.values['76']; return v && JSON.stringify(v) !== b; }, JSON.stringify(before));
  assert.equal(await page.isVisible('.preset-chooser'), false);
  const up = await uploaded('76');
  assert.match(up.name, /^earlier_00002_/);
  assert.deepEqual(up.bytes, fullRes);
  assert.equal(await app(() => window.conceptApp.current.id), 'ai:klein-4b-edit');
});

test('From Comfy UI: grid of this session + earlier app outputs (lazy thumbnails, nothing from other folders); a tap loads it full-res', async () => {
  await pick('ai:klein-4b-edit');
  // let the batch from the earlier test finish, so the session part of the grid is complete
  await page.waitForFunction(() => window.conceptApp.queue.items.every((x) => x.image || /error|fail|cancel/i.test(x.status || '')), null, { timeout: 15000 });
  await page.click('.ref-slot[data-node="76"] button[data-from="comfy"]');
  await page.waitForSelector('.output-picker:not([hidden]) .op-tile[data-file="output/concept-app/earlier_00001_.png"]');
  const tiles = await page.$$eval('.output-picker .op-tile', (els) => els.map((e) => e.dataset.file));
  const session = await app(() => window.conceptApp.queue.items.filter((x) => x.image).flatMap((x) => [x.image, ...(x.extraImages || [])]).map((f) => `output/${f.subfolder}/${f.filename}`));
  assert.ok(session.length > 0);
  assert.deepEqual(new Set(tiles.slice(0, session.length)), new Set(session), 'this session first');
  assert.deepEqual(tiles.slice(-3), ['output/concept-app/earlier_00003_.png', 'output/concept-app/earlier_00002_.png', 'output/concept-app/earlier_00001_.png']);
  assert.ok(!tiles.some((t) => /not-mine|\.glb|\.flac/.test(t)), JSON.stringify(tiles));
  assert.ok(await page.$$eval('.output-picker .op-tile img', (im) => im.every((i) => i.loading === 'lazy' && /preview=webp/.test(i.src))));
  await shot('from-comfy-grid');
  await page.click('.output-picker .op-tile[data-file="output/concept-app/earlier_00001_.png"]');
  await page.waitForSelector('.output-picker', { state: 'hidden' });
  await page.waitForFunction(() => /earlier_00001_/.test(String(window.conceptApp.refs.values['76'] || '')), null, { timeout: 5000 });
  const up = await uploaded('76');
  assert.match(up.name, /^earlier_00001_/);
  assert.deepEqual(up.bytes, fullRes, 'full resolution original');
  assert.equal(await page.isVisible('.ref-slot[data-node="76"] .ref-preview'), true);
});

test('Save to Drive from the image viewer: copied into Comfy UI/Images, second save gets " (2)"', async () => {
  const it = await app(() => window.conceptApp.queue.items.findLast((x) => x.image));
  await page.locator('#thumbs .thumb.s-done').first().click();
  await page.waitForSelector('.viewer:not([hidden])');
  const shown = await app(() => window.conceptApp.viewer.current().image.filename);
  await page.click('.viewer button[title="Save to Drive"]');
  await waitToast(`Saved to Drive: Comfy UI/Images/${shown}`);
  await page.click('.viewer button[title="Save to Drive"]');
  const second = shown.replace(/(\.[^.]+)$/, ' (2)$1');
  await waitToast(`Saved to Drive: Comfy UI/Images/${second}`);
  assert.deepEqual(fs.readdirSync(path.join(s.driveDir, 'Images')).sort(), [shown, second].sort());
  assert.ok(it);
  await page.goBack(); await page.waitForSelector('.viewer', { state: 'hidden' });
});

test('3D viewer: Hunyuan run -> tap the 3D tile -> clay model, counts, Shaded / Wireframe / Shaded+wireframe, reset, Save to Drive', async () => {
  await pick('ai:hunyuan3d-21');
  const ref = await refValue('2');
  assert.ok(ref, 'reference from the earlier test');
  await runAndWait();
  // batch2-fix1: what ComfyUI got. The reference goes to LoadImage 2 and through
  // BiRefNet onto white before CLIP vision; Detail 256 -> octree, Steps 30 -> KSampler.
  const g = Object.values(s.mock.history).map((h) => h.prompt[2]).findLast((w) => Object.values(w).some((n) => n.class_type === 'VAEDecodeHunyuan3D'));
  assert.equal(g['2'].inputs.image, ref);
  const enc = Object.values(g).find((n) => n.class_type === 'CLIPVisionEncode');
  // batch 3: through the "Remove background" switch (On by default); Max faces Full -> DecimateMesh 0
  const sw = g[enc.inputs.image[0]];
  assert.equal(sw.class_type, 'ComfySwitchNode'); assert.equal(sw.inputs.switch, true);
  assert.equal(g[sw.inputs.on_true[0]].class_type, 'ImageCompositeMasked');
  assert.equal(Object.values(g).find((n) => n.class_type === 'DecimateMesh').inputs.target_face_count, 0);
  assert.deepEqual(g['21'].inputs.image, ['2', 0]);
  assert.deepEqual([g['19:8'].inputs.octree_resolution, g['19:8'].inputs.num_chunks, g['19:7'].inputs.steps], [256, 8000, 30]);
  const tile = page.locator('#thumbs .thumb.is-file').last();
  assert.equal((await tile.textContent()).trim(), '3D');
  await tile.click();
  await page.waitForFunction(() => window.conceptApp.modelViewer.state !== 'loading', null, { timeout: 15000 });
  assert.equal(await app(() => window.conceptApp.modelViewer.state), 'ready', await page.textContent('.model-viewer .mv-status'));
  assert.equal(await page.textContent('.model-viewer .mv-stats'), '8 vertices · 12 triangles');
  assert.ok((await page.locator('.model-viewer .ov-top').boundingBox()).y < 10, 'title bar on top');
  assert.deepEqual(await page.$$eval('.model-viewer .mv-modes button', (b) => b.map((x) => x.textContent)), ['Shaded', 'Wireframe', 'Shaded+wireframe']);
  const mats = () => app(() => { const v = window.conceptApp.modelViewer; const m = v.meshes[0]; return { solid: m.mesh.material.colorWrite && m.mesh.material.visible, wire: m.wire.visible, mode: v.mode, pressed: [...document.querySelectorAll('.model-viewer .mv-modes button')].map((b) => b.getAttribute('aria-checked')), clay: v.clay.color.getHexString(), isClay: m.mesh.material === v.clay }; });
  let m = await mats();
  assert.deepEqual([m.mode, m.pressed, m.solid, m.wire, m.isClay, m.clay], ['shaded', ['true', 'false', 'false'], true, false, true, 'b9b9b9'], 'untextured -> gray clay');
  await page.waitForTimeout(300);
  await shot('3d-shaded');
  await page.click('.model-viewer .mv-modes button[data-mode="wireframe"]');
  m = await mats();
  assert.deepEqual([m.mode, m.pressed, m.solid, m.wire], ['wireframe', ['false', 'true', 'false'], false, true]);
  await page.waitForTimeout(300);
  await shot('3d-wireframe');
  await page.click('.model-viewer .mv-modes button[data-mode="both"]');
  m = await mats();
  assert.deepEqual([m.mode, m.solid, m.wire], ['both', true, true]);
  // orbit by dragging, then reset puts the camera back
  const cam = () => app(() => window.conceptApp.modelViewer.camera.position.toArray().map((x) => +x.toFixed(3)));
  const home = await cam();
  const box = await page.locator('.model-viewer canvas').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 40, { steps: 8 }); await page.mouse.up();
  await page.waitForTimeout(400);
  assert.notDeepEqual(await cam(), home, 'drag orbits');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 - 80, box.y + box.height / 2, { steps: 4 }); await page.mouse.up();
  await page.click('.model-viewer [data-act="reset"]'); // straight after a drag: no leftover drift
  await page.waitForTimeout(400);
  assert.deepEqual(await cam(), home);
  assert.equal(await page.isVisible('.model-viewer [data-act="download"]'), true);
  await page.click('.model-viewer [data-act="drive"]');
  await waitToast(/Saved to Drive: Comfy UI\/3D\/.+\.glb/);
  assert.equal(fs.readdirSync(path.join(s.driveDir, '3D')).length, 1);
  await page.goBack();
  await page.waitForSelector('.model-viewer', { state: 'hidden' });
  assert.equal(await app(() => window.conceptApp.modelViewer.state), 'closed');
});

test('audio player: duration, waveform, play/pause, scrub; Save to Drive -> Comfy UI/Audio', async () => {
  await app(() => window.conceptApp.openFile({ filename: 'tone_00001.flac', subfolder: 'concept-app', type: 'output' }, { prompt: 'a short tone' }));
  await page.waitForSelector('.audio-player:not([hidden])');
  await page.waitForFunction(() => window.conceptApp.audioPlayer.waveState !== 'loading', null, { timeout: 10000 });
  assert.equal(await app(() => window.conceptApp.audioPlayer.waveState), 'ready');
  await page.waitForFunction(() => window.conceptApp.audioPlayer.duration > 0);
  assert.equal(Math.round(await app(() => window.conceptApp.audioPlayer.duration)), 2);
  assert.match(await page.textContent('.audio-player .ap-time'), /^0:00 \/ 0:02$/);
  assert.notEqual(await page.$eval('.audio-player .ap-play', (b) => getComputedStyle(b).backgroundColor), 'rgb(11, 140, 233)', 'Run stays the only blue button');
  const peaks = await app(() => [...window.conceptApp.audioPlayer.peaks]);
  assert.ok(peaks.length > 50 && Math.max(...peaks) > 0.8 && peaks[0] < 0.2, 'waveform from the decoded audio');
  await page.click('.audio-player .ap-play');
  await page.waitForFunction(() => !window.conceptApp.audioPlayer.audio.paused || window.conceptApp.audioPlayer.audio.ended, null, { timeout: 5000 }).catch(() => {});
  await page.click('.audio-player .ap-play');
  assert.equal(await app(() => window.conceptApp.audioPlayer.audio.paused), true);
  await page.$eval('.audio-player .ap-scrub', (r) => { r.value = '1'; r.dispatchEvent(new Event('input')); });
  assert.ok(Math.abs((await app(() => window.conceptApp.audioPlayer.audio.currentTime)) - 1) < 0.05);
  assert.match(await page.textContent('.audio-player .ap-time'), /^0:01 \/ 0:02$/);
  await shot('audio');
  await page.click('.audio-player [data-act="drive"]');
  await waitToast('Saved to Drive: Comfy UI/Audio/tone_00001.flac');
  assert.equal(await page.isVisible('.audio-player [data-act="download"]'), true);
  await closeOverlay('.audio-player');
});

test('video player: plays in-app with play/pause, scrub, duration, loop toggle; Download + Save to Drive -> Comfy UI/Video', async () => {
  await app(() => window.conceptApp.openFile({ filename: 'clip_00001_.webm', subfolder: 'concept-app', type: 'output' }, {}));
  await page.waitForSelector('.video-player:not([hidden])');
  await page.waitForFunction(() => window.conceptApp.videoPlayer.state !== 'loading', null, { timeout: 10000 });
  const vp = () => app(() => { const p = window.conceptApp.videoPlayer, v = p.video; return { state: p.state, d: +p.duration.toFixed(1), t: +v.currentTime.toFixed(2), paused: v.paused, loop: v.loop, pressed: document.querySelector('.video-player .vp-loop').getAttribute('aria-pressed'), time: document.querySelector('.video-player .ap-time').textContent, w: v.videoWidth, controls: v.controls }; });
  let v = await vp();
  assert.deepEqual([v.state, v.d, v.w, v.controls, v.time], ['ready', 2, 96, false, '0:00 / 0:02']);
  assert.equal(v.loop, true, 'loops by default (short clips)');
  assert.equal(v.pressed, 'true');
  await page.click('.video-player .ap-play');
  await page.waitForFunction(() => window.conceptApp.videoPlayer.video.currentTime > 0.2, null, { timeout: 5000 });
  assert.equal(await page.getAttribute('.video-player .ap-play', 'aria-label'), 'Pause');
  await page.click('.video-player .ap-play');
  assert.equal((await vp()).paused, true);
  await page.$eval('.video-player .ap-scrub', (r) => { r.value = '1.5'; r.dispatchEvent(new Event('input')); });
  await page.waitForFunction(() => Math.abs(window.conceptApp.videoPlayer.video.currentTime - 1.5) < 0.1);
  assert.match((await vp()).time, /^0:01 \/ 0:02$/);
  await page.click('.video-player .vp-loop');
  v = await vp();
  assert.deepEqual([v.loop, v.pressed], [false, 'false']);
  assert.equal(await app(() => localStorage.getItem('conceptVideo.loop')), '0', 'the loop choice is remembered');
  await page.click('.video-player .vp-loop');
  assert.equal((await vp()).loop, true);
  assert.notEqual(await page.$eval('.video-player .ap-play', (b) => getComputedStyle(b).backgroundColor), 'rgb(11, 140, 233)');
  assert.ok((await page.locator('.video-player .ov-top').boundingBox()).y < 10);
  await shot('video');
  assert.equal(await page.isVisible('.video-player [data-act="download"]'), true);
  await page.click('.video-player [data-act="drive"]');
  await waitToast('Saved to Drive: Comfy UI/Video/clip_00001_.webm');
  assert.deepEqual(fs.readFileSync(path.join(s.driveDir, 'Video', 'clip_00001_.webm')), makeVideo());
  await page.goBack();
  await page.waitForSelector('.video-player', { state: 'hidden' });
  assert.equal(await app(() => [window.conceptApp.videoPlayer.state, window.conceptApp.videoPlayer.video.paused]).then((x) => x.join()), 'closed,true');
  // an animated GIF is not a <video>: it gets the file sheet (Download / Save to Drive)
  await app(() => window.conceptApp.openFile({ filename: 'anim_00001_.gif', subfolder: 'concept-app', type: 'output' }, {}));
  await page.waitForSelector('.file-sheet:not([hidden])');
  assert.equal(await page.isVisible('.video-player'), false);
  await closeOverlay('.file-sheet');
});

test('Save to Drive with no Drive (Q: missing) says so plainly', async () => {
  const myDrive = path.dirname(s.driveDir); // like Q:\My Drive missing when Drive for desktop is not running
  fs.renameSync(myDrive, myDrive + '-gone');
  try {
    const r = await app(() => window.conceptApp.saveToDrive({ filename: 'earlier_00003_.png', subfolder: 'concept-app', type: 'output' }, 'image'));
    assert.equal(r, null);
    await waitToast(/Google Drive is not available: .*was not found\./);
    assert.equal(fs.existsSync(myDrive), false, 'nothing created');
  } finally { fs.renameSync(myDrive + '-gone', myDrive); }
});

test('no page errors in the batch 2 run', () => {
  assert.deepEqual(errors.filter((e) => !/Failed to load resource: .* 503/.test(e)), []);
});
