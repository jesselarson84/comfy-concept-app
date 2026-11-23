// Batch 5 unit tests: 1K / 2K / 4K sizes, the 4K upscale chain, which presets
// get the picker, and the raised size caps of the text-to-image presets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { renderSize, finalSize, withUpscale, pickUpscaleModel, resolutionApplies, normRes } from '../../app/js/lib/resolution.js';
import { validatePreset } from '../../app/js/lib/presets.js';

const read = (rel) => fs.readFileSync(new URL('../../' + rel, import.meta.url), 'utf8');

test('the long side follows the resolution; the ratio only sets the short side', () => {
  assert.deepEqual(renderSize('1:1', '1k'), { width: 1024, height: 1024 });
  assert.deepEqual(renderSize('16:9-landscape', '1k'), { width: 1024, height: 576 });
  assert.deepEqual(renderSize('16:9-portrait', '2k'), { width: 1152, height: 2048 });
  assert.deepEqual(renderSize('4:3-landscape', '2k'), { width: 2048, height: 1536 });
  assert.deepEqual(renderSize('3:2-portrait', '1k'), { width: 688, height: 1024 }, 'rounded to a multiple of 16');
  // 4K renders at 2K, the final picture is twice that
  assert.deepEqual(renderSize('16:9-landscape', '4k'), { width: 2048, height: 1152 });
  assert.deepEqual(finalSize('16:9-landscape', '4k'), { width: 4096, height: 2304 });
  assert.deepEqual(finalSize('1:1', '2k'), { width: 2048, height: 2048 });
  assert.equal(normRes('8k'), '1k');
});

test('4K chain: 4x model -> resize by 0.5 in front of every SaveImage; other nodes untouched', () => {
  const g = {
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 0] } },
    '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'x' } },
    '75:62': { class_type: 'KSampler', inputs: { steps: 20 } },
  };
  const out = withUpscale(g, '4x-UltraSharp.safetensors', 2);
  assert.notEqual(out, g); assert.deepEqual(g['9'].inputs.images, ['8', 0], 'input graph not changed');
  const by = (cls) => Object.entries(out).filter(([, n]) => n.class_type === cls);
  const [[lid, loader]] = by('UpscaleModelLoader'), [[uid, up]] = by('ImageUpscaleWithModel'), [[sid, sc]] = by('ImageScaleBy');
  assert.equal(loader.inputs.model_name, '4x-UltraSharp.safetensors');
  assert.deepEqual(up.inputs, { upscale_model: [lid, 0], image: ['8', 0] });
  assert.deepEqual(sc.inputs, { image: [uid, 0], upscale_method: 'lanczos', scale_by: 0.5 });
  assert.deepEqual(out['9'].inputs.images, [sid, 0]);
  for (const id of [lid, uid, sid]) assert.equal(g[id], undefined, 'fresh node ids');
  assert.deepEqual(out['75:62'], g['75:62']);
});

test('upscale model: the preferred one that is installed, else any installed, else none', () => {
  assert.equal(pickUpscaleModel(['4x_foolhardy_Remacri.pth', '4x-UltraSharp.safetensors']), '4x-UltraSharp.safetensors');
  assert.equal(pickUpscaleModel(['RealESRGAN_x4plus.safetensors']), 'RealESRGAN_x4plus.safetensors');
  assert.equal(pickUpscaleModel(['some-other-4x.pth']), 'some-other-4x.pth');
  assert.equal(pickUpscaleModel([]), null);
});

test('the picker applies to text-to-image presets only; their size cap is 2048 so 2K renders natively', () => {
  const ctl = { width: [{ node: '1' }], height: [{ node: '1' }] };
  assert.equal(resolutionApplies({ ok: true, controls: ctl, ai: { output: 'image', size: { base: [1024, 1024], min: 512, max: 2048 } } }), true);
  assert.equal(resolutionApplies({ ok: true, controls: ctl, ai: { output: 'video', size: { base: [1280, 704], min: 480, max: 1280 } } }), false, 'Wan video');
  assert.equal(resolutionApplies({ ok: true, controls: { width: [], height: [] }, ai: { output: 'image' } }), false, 'edit preset (size from the picture)');
  assert.equal(resolutionApplies({ ok: true, controls: ctl }), false, 'folder graph without a manifest');
  for (const id of ['klein-4b-t2i', 'z-image-turbo', 'flux1-dev-gguf', 'flux1-schnell-gguf', 'qwen-2512-t2i']) {
    const p = validatePreset(id, JSON.parse(read(`workflows/ai/${id}.json`)));
    assert.equal(p.ok, true, p.error);
    assert.equal(p.manifest.size.max, 2048, id);
  }
});

test('index.html: no ⋮ menu or import input; folder History toggle; gear Settings; icon-only seed lock', () => {
  const html = read('app/index.html');
  for (const re of [/details class="menu"/, /id="btn-import"/, /id="import-file"/, /id="builder-model"/, /id="mem-te-cpu"/, /id="mem-ollama-cpu"/, /i-history/, /i-sliders-horizontal/, /<span>Lock<\/span>/]) assert.doesNotMatch(html, re);
  assert.match(html, /id="btn-history"[^>]*aria-pressed="false"[^>]*><i class="i i-folder">/);
  assert.match(html, /<i class="i i-settings" aria-hidden="true"><\/i><span>Settings<\/span>/);
  assert.match(html, /id="aspect-res"[\s\S]*value="1k"[\s\S]*value="2k"[\s\S]*value="4k"/);
});
