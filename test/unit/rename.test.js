// Batch 1 follow-up names: "Comfy UI" save folder, "ComfyUI canvas" menu item,
// no "App presets" section, ratio dropdown in the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.js';

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('Android saves go to Pictures/Comfy UI and Download/Comfy UI; the Saved-to message uses that path', () => {
  const ms = read('android/app/src/main/java/app/jesse/comfyconcept/MediaSaver.java');
  assert.match(ms, /static final String FOLDER = "Comfy UI";/);
  assert.doesNotMatch(ms.replace(/\/\*[\s\S]*?\*\//g, ''), /"Comfy Concept"/);
  assert.match(read('android/app/src/main/res/values/strings.xml'), /<string name="saved_to">Saved to %1\$s<\/string>/);
  // Nothing moves, renames or deletes the old Comfy Concept folder (deletes are cache tidy-up / failed new saves only).
  assert.doesNotMatch(ms, /renameTo/);
  assert.equal((ms.match(/\.delete\(/g) || []).length, 3, 'only the app cache tidy-up and the two failed-save cleanups (unchanged)');
});

test('ComfyUI canvas is the node view toggle in the top bar (batch 4; was the menu item "ComfyUI canvas", before that "Advanced (ComfyUI)")', () => {
  const html = read('app/index.html');
  assert.match(html, /id="btn-canvas"[^>]*aria-pressed="false"[^>]*aria-label="Node view \(ComfyUI canvas\)"/);
  assert.doesNotMatch(html, /id="btn-advanced"/);
  assert.doesNotMatch(html, /Advanced \(ComfyUI\)/);
});

test('picker has no App presets section; aspect is a dropdown next to the orientation toggle; SW cache bumped', async () => {
  const { SECTIONS, sectionOf } = await import('../../app/js/ui/workflow-picker.js').catch(() => ({}));
  if (SECTIONS) {
    assert.deepEqual(SECTIONS.map((x) => x.key), ['3D', 'Image', 'Video', 'Audio', 'Textures', 'Concept', 'VFX', 'My presets']);
    assert.equal(sectionOf({ id: 'my-import' }), 'My presets');
  } else assert.doesNotMatch(read('app/js/ui/workflow-picker.js'), /App presets/);
  const html = read('app/index.html');
  assert.match(html, /<select id="aspect-ratio"[\s\S]*?value="1:1"[\s\S]*?value="4:3"[\s\S]*?value="3:2"[\s\S]*?value="16:9"[\s\S]*?<\/select>/);
  assert.doesNotMatch(html, /data-ratio=/);
  assert.match(html, /data-orient="portrait"[\s\S]*data-orient="landscape"/);
  assert.match(html, /id="aspect-size"/);
  assert.match(read('app/sw.js'), /const VERSION = 'shell-v22';/); // batch 7: Import sheet + recorder
  assert.match(read('app/sw.js'), /'\/js\/lib\/resolution\.js'/);
  assert.match(read('app/sw.js'), /'\/js\/lib\/preset-choice\.js'/);
  assert.match(read('app/sw.js'), /'\/js\/lib\/legacy-presets\.js'/);
  assert.ok(!fs.existsSync(path.join(ROOT, 'workflows/fast-concept.json')) && !fs.existsSync(path.join(ROOT, 'workflows/from-reference-image.json')));
});
