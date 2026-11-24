// Batch 2: Save to Drive (path rules, no overwrite, missing drive), the
// "From Comfy UI" output list, the vendored three.js + mesh stats, the audio
// helpers, the builder card's step count, and the hint sweep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStack, ROOT, pngBytes } from './helpers.js';
import { safeFileName, safeSubfolder, checkAppOutput, scanAppFolder, mergeOutputs } from '../../server/outputs.js';
import { openUnique, driveKind, DRIVE_FOLDERS } from '../../server/drive.js';
import { makeGlb, makeWav } from '../fixtures/media.js';
import { checkChain, summarize } from '../../app/js/lib/builder.js';

const j = (r) => r.json();
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const save = (s, body) => fetch(s.base + '/api/drive/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const put = (s, key, buf) => s.mock.files.set(key, buf);

test('path rules: plain names and app folders only (traversal, absolute, drive letters, NUL, other types refused)', () => {
  for (const ok of ['a.png', 'klein_t2i_00001_.png', 'name (2).png']) assert.equal(safeFileName(ok), true, ok);
  for (const bad of ['', '.', '..', '../x.png', '..\\x.png', 'a/b.png', 'C:x.png', 'C:\\x.png', '/etc/passwd', 'x\u0000.png', ' x.png', 'a|b.png']) assert.equal(safeFileName(bad), false, JSON.stringify(bad));
  assert.equal(safeSubfolder(''), true); assert.equal(safeSubfolder('concept-app/sub'), true);
  for (const bad of ['../concept-app', 'concept-app/..', 'concept-app/../input', '/concept-app', 'concept-app/', 'C:\\out', 'a\\b']) assert.equal(safeSubfolder(bad), false, bad);
  const o = { outputSubfolder: 'concept-app' };
  assert.equal(checkAppOutput({ filename: 'a.png', subfolder: 'concept-app' }, o), null);
  assert.equal(checkAppOutput({ filename: 'a.png', subfolder: 'concept-app/x' }, o), null);
  assert.match(checkAppOutput({ filename: 'a.png', subfolder: 'concept-apps' }, o), /Not one of this app/);
  assert.match(checkAppOutput({ filename: 'a.png', subfolder: 'tminus' }, o), /Not one of this app/);
  assert.match(checkAppOutput({ filename: 'a.png', subfolder: 'concept-app', type: 'input' }, o), /Only saved results/);
  assert.match(checkAppOutput({ filename: 'a.png', subfolder: 'concept-app', type: 'temp' }, o), /Only saved results/);
  assert.match(checkAppOutput({ filename: '../a.png', subfolder: 'concept-app' }, o), /Bad file name/);
  assert.match(checkAppOutput({ filename: 'a.png', subfolder: 'concept-app/../..' }, o), /Bad folder/);
  assert.equal(checkAppOutput({ filename: 'a.png', subfolder: 'other' }, { ...o, historyFiles: new Set(['other/a.png']) }), null, 'an output recorded in history is the app\'s');
  assert.deepEqual(DRIVE_FOLDERS, { image: 'Images', video: 'Video', '3d': '3D', audio: 'Audio' });
  assert.deepEqual(['x.png', 'x.glb', 'x.flac', 'x.mp4', 'x.webp'].map((f) => driveKind({ filename: f })), ['image', '3d', 'audio', 'video', 'image']);
});

test('openUnique never overwrites: name, name (2), name (3); stays in its folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-uniq-'));
  fs.writeFileSync(path.join(dir, 'a.png'), 'ORIGINAL');
  const names = [];
  for (let i = 0; i < 2; i++) { const o = openUnique(dir, 'a.png'); fs.writeSync(o.fd, 'new'); fs.closeSync(o.fd); names.push(o.name); }
  assert.deepEqual(names, ['a (2).png', 'a (3).png']);
  assert.equal(fs.readFileSync(path.join(dir, 'a.png'), 'utf8'), 'ORIGINAL');
  assert.throws(() => openUnique(dir, '../escape.png'), /Bad file name/);
  assert.equal(fs.existsSync(path.join(dir, '..', 'escape.png')), false);
});

test('Save to Drive: copies into Comfy UI/<Images|3D|Audio|Video>, creates folders, suffixes on collision, refuses traversal', async () => {
  const s = await startStack();
  try {
    put(s, 'output/concept-app/klein_t2i_00001_.png', pngBytes());
    put(s, 'output/concept-app/hunyuan3d_00001_.glb', makeGlb());
    put(s, 'output/concept-app/tts_chatterbox_00001.flac', makeWav(0.2));
    put(s, 'output/concept-app/wan_00001_.mp4', Buffer.from('mockmp4'));
    put(s, 'output/tminus/secret.png', pngBytes());
    put(s, 'input/ref.png', pngBytes());
    assert.equal(fs.existsSync(s.driveDir), false);
    let r = await j(await save(s, { filename: 'klein_t2i_00001_.png', subfolder: 'concept-app', type: 'output' }));
    assert.deepEqual([r.folder, r.name], ['Images', 'klein_t2i_00001_.png']);
    assert.equal(r.path, path.join(s.driveDir, 'Images', 'klein_t2i_00001_.png'));
    assert.deepEqual(fs.readFileSync(r.path), pngBytes());
    // collision: never overwrite, add a suffix
    fs.writeFileSync(path.join(s.driveDir, 'Images', 'klein_t2i_00001_.png'), 'EDITED IN DRIVE');
    r = await j(await save(s, { filename: 'klein_t2i_00001_.png', subfolder: 'concept-app', type: 'output' }));
    assert.equal(r.name, 'klein_t2i_00001_ (2).png');
    r = await j(await save(s, { filename: 'klein_t2i_00001_.png', subfolder: 'concept-app', type: 'output' }));
    assert.equal(r.name, 'klein_t2i_00001_ (3).png');
    assert.equal(fs.readFileSync(path.join(s.driveDir, 'Images', 'klein_t2i_00001_.png'), 'utf8'), 'EDITED IN DRIVE');
    // kinds -> folders
    assert.equal((await j(await save(s, { filename: 'hunyuan3d_00001_.glb', subfolder: 'concept-app', kind: '3d' }))).folder, '3D');
    assert.equal((await j(await save(s, { filename: 'tts_chatterbox_00001.flac', subfolder: 'concept-app', kind: 'audio' }))).folder, 'Audio');
    assert.equal((await j(await save(s, { filename: 'wan_00001_.mp4', subfolder: 'concept-app', kind: 'video' }))).folder, 'Video');
    assert.deepEqual(fs.readdirSync(s.driveDir).sort(), ['3D', 'Audio', 'Images', 'Video']);
    assert.deepEqual(fs.readFileSync(path.join(s.driveDir, '3D', 'hunyuan3d_00001_.glb')), makeGlb());
    // refused: not the app's, wrong type, traversal in name or folder, bad kind can't escape
    for (const [body, re] of [
      [{ filename: 'secret.png', subfolder: 'tminus' }, /Not one of this app/],
      [{ filename: 'ref.png', subfolder: '', type: 'input' }, /Only saved results/],
      [{ filename: '../../../evil.png', subfolder: 'concept-app' }, /Bad file name/],
      [{ filename: '..\\..\\evil.png', subfolder: 'concept-app' }, /Bad file name/],
      [{ filename: 'secret.png', subfolder: 'concept-app/../tminus' }, /Bad folder/],
      [{ filename: 'C:\\Windows\\win.ini', subfolder: 'concept-app' }, /Bad file name/],
    ]) {
      const res = await save(s, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match((await j(res)).error, re);
    }
    const kindTrick = await j(await save(s, { filename: 'klein_t2i_00001_.png', subfolder: 'concept-app', kind: '../..' }));
    assert.equal(kindTrick.folder, 'Images', 'unknown kind falls back to the file type');
    // missing file in ComfyUI
    const miss = await save(s, { filename: 'nope.png', subfolder: 'concept-app' });
    assert.equal(miss.status, 404);
    // nothing was written outside the Drive folder
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    assert.ok(walk(s.driveRoot).every((f) => f.startsWith(s.driveDir + path.sep)));
  } finally { await s.close(); }
});

test('Save to Drive with the Drive folder missing (Q: not mounted): clear error, nothing created', async () => {
  const s = await startStack({ drive: false });
  try {
    put(s, 'output/concept-app/a.png', pngBytes());
    const res = await save(s, { filename: 'a.png', subfolder: 'concept-app' });
    assert.equal(res.status, 503);
    assert.match((await j(res)).error, /^Google Drive is not available: .*My Drive was not found\.$/);
    assert.deepEqual(fs.readdirSync(s.driveRoot), []);
  } finally { await s.close(); }
});

test('/api/outputs: app folder + history, newest first, images only on request, other folders never listed, paged', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-out-'));
  const mk = (rel, t) => { const f = path.join(out, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); fs.utimesSync(f, t, t); };
  mk('concept-app/old.png', 1000); mk('concept-app/sub/mid.webp', 2000); mk('concept-app/new.png', 3000);
  mk('concept-app/mesh_00001_.glb', 2500); mk('concept-app/notes.txt', 4000); mk('tminus/private.png', 5000); mk('root.png', 5000);
  const s = await startStack({ outputDir: out, data: { 'history.json': { version: 1, sessions: [{ id: 's1', startedAt: 1, lastAt: 1 }], entries: [{ id: 'e1', sessionId: 's1', createdAt: 2600000, updatedAt: 2600000, prompt: 'p', images: [{ filename: 'hist.png', subfolder: 'elsewhere', type: 'output' }], files: [], status: 'done' }] } } });
  try {
    const all = await j(await fetch(s.base + '/api/outputs'));
    assert.equal(all.scanned, true);
    const names = all.items.map((f) => `${f.subfolder}/${f.filename}`);
    assert.deepEqual(names, ['concept-app/new.png', 'elsewhere/hist.png', 'concept-app/mesh_00001_.glb', 'concept-app/sub/mid.webp', 'concept-app/old.png']);
    assert.ok(!names.some((n) => /private|root|notes/.test(n)));
    const imgs = await j(await fetch(s.base + '/api/outputs?kind=image&limit=2'));
    assert.deepEqual([imgs.total, imgs.items.map((f) => f.filename)], [4, ['new.png', 'hist.png']]);
    const p2 = await j(await fetch(s.base + '/api/outputs?kind=image&offset=2&limit=2'));
    assert.deepEqual(p2.items.map((f) => f.filename), ['mid.webp', 'old.png']);
    assert.ok(imgs.items.every((f) => f.type === 'output'));
  } finally { await s.close(); }
  assert.deepEqual(scanAppFolder(out, '../tminus'), [], 'a bad subfolder lists nothing');
  assert.equal(mergeOutputs([[{ filename: 'a.png', subfolder: 'c', mtime: 1, kind: 'image' }], [{ filename: 'a.png', subfolder: 'c', mtime: 2, kind: 'image' }]]).total, 1);
});

test('three.js is vendored (r187, MIT, relative imports, no CDN); GLB parses and mesh stats count vertices + triangles', async () => {
  const v = 'app/vendor/three';
  for (const f of ['three.module.js', 'three.core.js', 'addons/loaders/GLTFLoader.js', 'addons/controls/OrbitControls.js', 'addons/utils/BufferGeometryUtils.js', 'addons/utils/SkeletonUtils.js', 'LICENSE', 'README.md']) assert.ok(fs.existsSync(path.join(ROOT, v, f)), f);
  assert.match(read(`${v}/LICENSE`), /The MIT License/);
  assert.match(read(`${v}/README.md`), /three@0\.187\.0/);
  assert.match(read(`${v}/three.core.js`), /const REVISION = '187'/);
  for (const f of ['addons/loaders/GLTFLoader.js', 'addons/controls/OrbitControls.js', 'addons/utils/BufferGeometryUtils.js', 'addons/utils/SkeletonUtils.js']) assert.doesNotMatch(read(`${v}/${f}`), /from 'three'/, f);
  // nothing in the app loads code from the internet
  const appText = [read('app/index.html'), ...fs.readdirSync(path.join(ROOT, 'app/js'), { recursive: true }).filter((f) => f.endsWith('.js')).map((f) => read(`app/js/${f}`))].join('\n');
  assert.doesNotMatch(appText, /unpkg|jsdelivr|cdnjs|esm\.sh|skypack|https:\/\/[^'"\s]*\.js/);
  const THREE = await import('../../app/vendor/three/three.module.js');
  const { GLTFLoader } = await import('../../app/vendor/three/addons/loaders/GLTFLoader.js');
  const { meshStats, MODES } = await import('../../app/js/ui/model-viewer.js');
  const glb = makeGlb();
  const gltf = await new GLTFLoader().parseAsync(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.length), '');
  assert.deepEqual(meshStats(gltf.scene), { vertices: 8, triangles: 12 });
  const g = new THREE.Group(); g.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)), new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(9), 3))));
  assert.deepEqual(meshStats(g), { vertices: 27, triangles: 13 });
  assert.deepEqual(MODES.map((m) => m.label), ['Shaded', 'Wireframe', 'Shaded+wireframe']);
});

test('video player: own module, offline-cached, routed for real video files only; loop/scrub/duration controls', () => {
  const main = read('app/js/main.js'), vp = read('app/js/ui/video-player.js');
  assert.match(main, /if \(k === 'video' && \/\\\.\(mp4\|webm\|mov\|mkv\)\$\/i\.test\(f\.filename \|\| ''\)\) return videoPlayer\.open\(f, meta\);/);
  assert.match(read('app/sw.js'), /'\/js\/ui\/video-player\.js'/);
  for (const re of [/h\('video\.vp-video'/, /'aria-label': 'Loop'/, /type: 'range'/, /fmtTime/, /fileMoreButton\(\(\) => this\.file, this\.hooks\)/, /playsinline/]) assert.match(vp, re);
  assert.match(read('app/icons.css'), /^\.i-repeat\{--svg:url\("data:image\/svg\+xml,/m);
});

test('audio helpers: time format and waveform peaks', async () => {
  const { fmtTime, peaks } = await import('../../app/js/ui/audio-player.js');
  assert.deepEqual([fmtTime(0), fmtTime(5.9), fmtTime(65), fmtTime(3725), fmtTime(NaN)], ['0:00', '0:05', '1:05', '1:02:05', '0:00']);
  const p = peaks([new Float32Array([0, 0.5, -1, 0.25]), new Float32Array([0.75, 0, 0, 0])], 2);
  assert.deepEqual([...p], [0.75, 1]);
  assert.equal(makeWav(1, 8000).length, 44 + 16000);
});

test('builder card: the model line has no step count, the sampler line shows the clamped steps (matches the clamp note)', () => {
  const ctx = {};
  const c = checkChain([{ type: 'load_model', params: { family: 'flux2-klein' } }, { type: 'txt2img', params: { steps: 20, width: 1024, height: 1024 } }, { type: 'save' }], ctx);
  assert.ok(c.ok, c.errors?.join(' '));
  assert.deepEqual(c.notes, ['Steps 20 is outside 2-8, using 8.']);
  const lines = summarize(c.blocks);
  assert.equal(lines[0], 'Model: FLUX.2 Klein 4B');
  assert.equal(lines[1], 'Text to image, 1024×1024, 8 steps');
  assert.ok(lines.every((l) => (l.match(/(\d+) steps/g) || []).every((m) => m === '8 steps')));
  for (const fam of ['flux1-schnell', 'flux1-dev', 'z-image-turbo', 'qwen-image']) {
    const r = checkChain([{ type: 'load_model', params: { family: fam } }, { type: 'txt2img', params: { steps: 99 } }, { type: 'save' }], ctx);
    const L = summarize(r.blocks);
    assert.doesNotMatch(L[0], /steps|heavy/, fam);
    assert.equal(L[1].match(/(\d+) steps/)[1], r.notes[0].match(/using (\d+)/)[1], fam);
  }
});

test('hint sweep: no recommendations / upgrade notes / tags / More settings / memory setting left in the app', () => {
  const html = read('app/index.html');
  for (const re of [/More settings/, /builder-model-note/, /memory-mount/, /Results appear here/, /Low = stay close/]) assert.doesNotMatch(html, re);
  const ui = ['app/js/main.js', 'app/js/ui/workflow-picker.js', 'app/js/ui/prompt-panel.js', 'app/js/ui/reference.js', 'app/js/ui/file-inputs.js', 'app/js/ui/chat-panel.js'].map(read).join('\n');
  for (const re of [/Recommended after/, /same list as ComfyUI right-click/, /span\.tg/, /\(pick a file to use your own\)/, /short clips: this runs/, /No image yet - pick/, /long-press the prompt box/, /30-40 s/, /Undo is under the prompt box/, /then tap Retry/, /Pull one \(e\.g\./, /Test run makes one result/, /rename or delete it in the picker/, /slower, partly in RAM/, /e\.g\. "looks like a swan/, /is Comfy Desktop running\?/, /MemoryPanel/]) assert.doesNotMatch(ui, re);
  assert.equal(fs.existsSync(path.join(ROOT, 'app/js/ui/memory-panel.js')), false);
  assert.doesNotMatch(read('server/builder.js'), /RECOMMENDED|after the RTX 5080|Slow on this GPU/);
  assert.doesNotMatch(read('server/index.js'), /\/api\/memory\/profile' && req\.method === 'PUT'/);
  // The Tailscale hint on the Android connection error stays (the owner, 10:39 PM); the address example is gone.
  const strings = read('android/app/src/main/res/values/strings.xml');
  assert.match(strings, /<string name="err_hint">Check that Tailscale is connected on this device, and that the PC is on with the Comfy UI app server running\.<\/string>/);
  assert.match(strings, /<string name="address_invalid">Enter an https:\/\/ address with no path<\/string>/);
  assert.match(read('android/app/src/main/java/app/jesse/comfyconcept/MainActivity.java'), /String hint = getString\(R\.string\.err_hint\);\n\s+errorDetail\.setText\(detail == null \|\| detail\.isEmpty\(\) \? hint : detail \+ "\\n\\n" \+ hint\);/);
  // kept: field labels and the Run button
  assert.match(html, /<details id="settings" class="settings" hidden>\s*<summary><i class="i i-sliders-horizontal" aria-hidden="true"><\/i><span>Settings<\/span>/);
  assert.match(html, /id="btn-generate" class="btn primary run"[^>]*><i class="i i-play"><\/i><span id="run-label">Run<\/span>/);
});
