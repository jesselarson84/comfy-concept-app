// Batch 20: config/models.json (the model list SETUP.md and scripts/check-models.mjs use)
// must cover every model file the presets load, and the check script must find files
// on disk (also under ComfyUI's older folder names) and in ComfyUI's own listing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './helpers.js';
import { loadModels, pickModels, checkModels } from '../../scripts/check-models.mjs';

const models = loadModels();
const names = new Set(models.map((m) => m.file));
const presets = fs.readdirSync(path.join(ROOT, 'workflows/ai')).map((f) => ({ id: f.replace(/\.json$/, ''), ...JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows/ai', f), 'utf8')) }));

test('models.json lists every model file a preset loads (and the small-GPU GGUF swaps)', () => {
  const missing = [];
  for (const p of presets) {
    for (const n of Object.values(p.workflow)) {
      for (const v of Object.values(n?.inputs || {})) {
        // .onnx pose detectors are downloaded by comfyui_controlnet_aux itself
        if (typeof v === 'string' && /\.(safetensors|gguf|pth|ckpt|bin)$/i.test(v) && !names.has(v)) missing.push(`${p.id}: ${v}`);
      }
    }
    if (p.preset.gguf?.unet_name && !names.has(p.preset.gguf.unet_name)) missing.push(`${p.id}: ${p.preset.gguf.unet_name}`);
    for (const f of p.preset.files || []) if (!names.has(path.basename(f.file))) missing.push(`${p.id}: ${f.file}`);
  }
  assert.deepEqual(missing, []);
  for (const m of models) {
    assert.match(m.url, /^https:\/\/huggingface\.co\//, m.file);
    assert.ok(m.presets.length && m.presets.every((id) => presets.some((p) => p.id === id)), `${m.file}: unknown preset in ${m.presets}`);
  }
  assert.deepEqual(pickModels(models, { required: true }).map((m) => m.file).sort(), ['ae.safetensors', 'qwen_3_4b.safetensors', 'z_image_turbo_bf16.safetensors']);
  assert.ok(pickModels(models, { presets: ['ai:klein-4b-edit'] }).some((m) => m.file === 'flux2-vae.safetensors'));
});

test('check-models: present on disk (also models/unet for GGUF) or in ComfyUI\'s listing; missing otherwise', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-models-'));
  try {
    fs.mkdirSync(path.join(dir, 'unet'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'unet', 'flux1-dev-Q5_K_S.gguf'), 'x');
    fs.mkdirSync(path.join(dir, 'vae'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'vae', 'ae.safetensors'), 'x');
    const pick = models.filter((m) => ['flux1-dev-Q5_K_S.gguf', 'ae.safetensors', 'clip_l.safetensors', 't3_cfg.safetensors'].includes(m.file));
    const byFile = (rows) => Object.fromEntries(rows.map((r) => [r.file, r.present]));
    assert.deepEqual(byFile(checkModels(pick, dir)), { 'ae.safetensors': true, 'flux1-dev-Q5_K_S.gguf': true, 'clip_l.safetensors': false, 't3_cfg.safetensors': false });
    const rows = checkModels(pick, dir, { text_encoders: new Set(['clip_l.safetensors']), chatterbox: new Set(['chatterbox/t3_cfg.safetensors']) });
    assert.deepEqual(byFile(rows), { 'ae.safetensors': true, 'flux1-dev-Q5_K_S.gguf': true, 'clip_l.safetensors': true, 't3_cfg.safetensors': true });
    // a missing file's path is where a download would go
    assert.equal(checkModels(pick, dir).find((r) => r.file === 'clip_l.safetensors').path, path.join(dir, 'text_encoders', 'clip_l.safetensors'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('SETUP.md names every file in models.json and points to the check script', () => {
  const md = fs.readFileSync(path.join(ROOT, 'SETUP.md'), 'utf8');
  for (const m of models) assert.ok(md.includes(m.file), m.file);
  assert.match(md, /node scripts\/check-models\.mjs/);
  assert.match(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'), /\[SETUP\.md\]\(SETUP\.md\)/, 'README links SETUP.md');
});
