// Memory profiles: GPU/RAM detection, profile choice (11 / 16 / 24 GB),
// override precedence, config loading, unload decisions (incl. low free VRAM on
// a 16 GB card), chat model fit and the partial-offload badge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStack, ROOT, GPU_5080, GPU_2080TI } from './helpers.js';
import { DEFAULT_MEMORY_CONFIG, normalizeMemoryConfig, selectProfile, workflowNeedMB, decideBeforeQueue, decideBeforeChat, modelFit, offloadBadge } from '../../app/js/lib/memory-profiles.js';
import { loadMemoryConfig } from '../../server/memory.js';
import { parseNvidiaSmi, fromSystemStats } from '../../server/hardware.js';

const FILE = path.join(ROOT, 'config/memory-profiles.json');
const { config: C } = loadMemoryConfig(FILE);
const P = (id) => C.profiles.find((p) => p.id === id);
const GB = 1024 ** 3;
const tmpFile = (obj) => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mem-')), 'memory-profiles.json'); fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj)); return f; };
const j = (r) => r.json();
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(j);

test('shipped config/memory-profiles.json loads without warnings and matches the built-in defaults', () => {
  const r = loadMemoryConfig(FILE);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.config, normalizeMemoryConfig(DEFAULT_MEMORY_CONFIG).config);
});

test('profile by detected VRAM: 11 GB (2080 Ti) -> small, 16 GB (5080) -> large, 24 GB -> large, unknown -> small', () => {
  assert.equal(selectProfile(11264, C).profile.id, 'small');
  assert.equal(selectProfile(16303, C).profile.id, 'large');
  assert.equal(selectProfile(24564, C).profile.id, 'large');
  assert.equal(selectProfile(undefined, C).profile.id, 'small');
  assert.equal(selectProfile(11264, C).source, 'auto');
});

test('override precedence: env > app setting > config file > auto; unknown ids are skipped with a warning', () => {
  const cfg = { ...C, profile: 'large' };
  assert.deepEqual([selectProfile(11264, cfg).profile.id, selectProfile(11264, cfg).source], ['large', 'config']);
  assert.deepEqual([selectProfile(11264, cfg, { setting: 'small' }).profile.id, selectProfile(11264, cfg, { setting: 'small' }).source], ['small', 'setting']);
  const e = selectProfile(16303, cfg, { env: 'small', setting: 'large' });
  assert.deepEqual([e.profile.id, e.source], ['small', 'env']);
  const a = selectProfile(16303, cfg, { setting: 'auto' });
  assert.equal(a.source, 'config');
  const bad = selectProfile(16303, C, { env: 'huge', setting: 'nope' });
  assert.deepEqual([bad.profile.id, bad.source], ['large', 'auto']);
  assert.equal(bad.warnings.length, 2);
});

test('config loading: missing file, broken JSON, partial file, bad values', () => {
  const miss = loadMemoryConfig('/nonexistent/memory-profiles.json');
  assert.match(miss.warnings[0], /not found - using built-in defaults/);
  assert.equal(miss.config.profiles.length, 2);
  const broken = loadMemoryConfig(tmpFile('{ "profile": '));
  assert.match(broken.warnings[0], /not valid JSON/);
  const part = loadMemoryConfig(tmpFile({ headroomMB: 1024, workflowVramNeedMB: { 'fast-concept': 4000, 'action:upscale': 'lots' } }));
  assert.equal(part.config.headroomMB, 1024);
  assert.equal(workflowNeedMB(part.config, 'fast-concept'), 4000);
  assert.equal(workflowNeedMB(part.config, 'action:upscale'), 2500);
  assert.equal(workflowNeedMB(part.config, 'something-new'), 3000);
  assert.ok(part.warnings.some((w) => /action:upscale/.test(w)));
  const custom = loadMemoryConfig(tmpFile({ profiles: [{ id: 'xl', minVramMB: 22000, unloadOllamaBeforeQueue: 'never' }, { id: 'small' }, { id: 'large', minVramMB: 15000, unloadOllamaBeforeQueue: 'sometimes' }, { label: 'no id' }] }));
  assert.deepEqual(custom.config.profiles.map((p) => p.id), ['small', 'large', 'xl']);
  assert.equal(selectProfile(24564, custom.config).profile.id, 'xl');
  assert.equal(custom.config.profiles.find((p) => p.id === 'large').unloadOllamaBeforeQueue, 'if-needed');
  assert.equal(custom.warnings.length, 2);
  assert.equal(loadMemoryConfig(tmpFile('[1,2]')).warnings[0], 'memory config is not an object - using defaults');
});

test('before a queue: small always unloads; large keeps the chat model when free VRAM allows, unloads when low', () => {
  const gemma = [{ name: 'gemma3:4b', size: 3.8 * GB, size_vram: 2.9 * GB }];
  const need = workflowNeedMB(C, 'fast-concept');
  assert.equal(decideBeforeQueue({ profile: P('small'), freeMB: 9000, ollamaModels: gemma, needMB: need, headroomMB: C.headroomMB }).unload, true);
  assert.equal(decideBeforeQueue({ profile: P('small'), freeMB: 9000, ollamaModels: [], needMB: need }).unload, false);
  const keep = decideBeforeQueue({ profile: P('large'), freeMB: 9000, ollamaModels: gemma, needMB: need, headroomMB: C.headroomMB });
  assert.equal(keep.unload, false); assert.match(keep.reason, /stays loaded/);
  const low = decideBeforeQueue({ profile: P('large'), freeMB: 2500, ollamaModels: gemma, needMB: need, headroomMB: C.headroomMB });
  assert.equal(low.unload, true); assert.match(low.reason, /2500 MB - headroom 768 < need 2500/);
  // 3D needs more: same free VRAM, different decision
  assert.equal(decideBeforeQueue({ profile: P('large'), freeMB: 6000, ollamaModels: gemma, needMB: workflowNeedMB(C, 'fast-concept'), headroomMB: C.headroomMB }).unload, false);
  assert.equal(decideBeforeQueue({ profile: P('large'), freeMB: 6000, ollamaModels: gemma, needMB: workflowNeedMB(C, 'action:image-to-3d'), headroomMB: C.headroomMB }).unload, true);
  assert.equal(decideBeforeQueue({ profile: P('large'), freeMB: undefined, ollamaModels: gemma, needMB: need }).unload, true);
  assert.equal(decideBeforeQueue({ profile: P('large'), freeMB: 100, ollamaModels: [{ name: 'x', size: GB, size_vram: 0 }], needMB: need }).unload, false, 'RAM-only model needs no unload');
});

test('chat model fit: 12B fits a 5080, is too big for the small profile; spill to RAM is "partial"; swap is refused', () => {
  const g12 = 8.1 * GB, g4 = 3.3 * GB;
  const big = { totalVramMB: 16303, freeRamMB: 60000, config: C, profile: P('large') };
  assert.equal(modelFit({ ...big, sizeBytes: g12, freeVramMB: 12000 }).fit, 'fits');
  const part = modelFit({ ...big, sizeBytes: g12, freeVramMB: 5000 });
  assert.equal(part.fit, 'partial'); assert.match(part.message, /slower, runs partly in RAM/);
  const swap = modelFit({ ...big, sizeBytes: g12, freeVramMB: 1000, freeRamMB: 9000 });
  assert.equal(swap.fit, 'no-fit'); assert.match(swap.message, /swap to disk/);
  assert.equal(modelFit({ ...big, sizeBytes: 30 * GB, freeVramMB: 15000 }).fit, 'too-big');
  const small = { totalVramMB: 11264, freeRamMB: 60000, config: C, profile: P('small') };
  assert.equal(modelFit({ ...small, sizeBytes: g12, freeVramMB: 11000 }).fit, 'too-big');
  // small profile frees ComfyUI first, so gemma3:4b "fits" even when ComfyUI holds VRAM now
  assert.equal(modelFit({ ...small, sizeBytes: g4, freeVramMB: 600 }).fit, 'fits');
  // an already-loaded model counts its own VRAM as available
  assert.equal(modelFit({ ...big, sizeBytes: g4, freeVramMB: 800, loadedVramBytes: g4 * 1.2 }).fit, 'fits');
  assert.equal(modelFit({ ...big, sizeBytes: g4, freeVramMB: 800 }).fit, 'partial');
});

test('before a chat turn: small frees ComfyUI only when free VRAM is low; large never forces it', () => {
  assert.equal(decideBeforeChat({ profile: P('small'), freeMB: 1500, estMB: 4000, modelLoaded: false, headroomMB: 768 }).freeComfy, true);
  assert.equal(decideBeforeChat({ profile: P('small'), freeMB: 8000, estMB: 4000, modelLoaded: false, headroomMB: 768 }).freeComfy, false);
  assert.equal(decideBeforeChat({ profile: P('small'), freeMB: 100, estMB: 4000, modelLoaded: true }).freeComfy, false);
  assert.equal(decideBeforeChat({ profile: P('large'), freeMB: 100, estMB: 4000, modelLoaded: false }).freeComfy, false);
});

test('partial-offload badge from /api/ps (size_vram < size)', () => {
  assert.equal(offloadBadge({ name: 'a', size: 100, size_vram: 100 }), null);
  assert.equal(offloadBadge({ name: 'a', size: 0, size_vram: 0 }), null);
  assert.deepEqual(offloadBadge({ name: 'a', size: 100, size_vram: 60 }), { partial: true, gpuPct: 60, text: 'slower, runs partly in RAM (60% on GPU)' });
  assert.match(offloadBadge({ name: 'a', size: 100, size_vram: 0 }).text, /RAM only/);
});

test('hardware parsing: nvidia-smi CSV (incl. two GPUs) and ComfyUI /system_stats fallback', () => {
  assert.deepEqual(parseNvidiaSmi('NVIDIA GeForce RTX 5080, 16303, 14987\r\nNVIDIA GeForce RTX 2080 Ti, 11264, 10800\r\n'), [{ name: 'NVIDIA GeForce RTX 5080', totalMB: 16303, freeMB: 14987 }, { name: 'NVIDIA GeForce RTX 2080 Ti', totalMB: 11264, freeMB: 10800 }]);
  assert.deepEqual(parseNvidiaSmi('garbage\n'), []);
  assert.deepEqual(fromSystemStats({ devices: [{ name: 'cuda:0 NVIDIA GeForce RTX 2080 Ti : cudaMallocAsync', type: 'cuda', vram_total: 11810832384, vram_free: 1328251128 }] }), { name: 'NVIDIA GeForce RTX 2080 Ti', totalMB: 11264, freeMB: 1267 });
});

// ---- server, end to end with fake nvidia-smi / RAM --------------------------
test('GET /api/memory on a 2080 Ti: detected GPU + RAM, small profile, model fit list', async () => {
  const s = await startStack();
  try {
    const m = await j(await fetch(s.base + '/api/memory?fresh=1'));
    assert.deepEqual(m.hardware.gpu, { name: 'NVIDIA GeForce RTX 2080 Ti', totalMB: 11264, freeMB: 4000, usedMB: 7264, source: 'nvidia-smi' });
    assert.deepEqual(m.hardware.ram, { totalMB: 98204, freeMB: 60000 });
    assert.equal(m.profile.id, 'small'); assert.equal(m.profile.source, 'auto');
    assert.deepEqual(m.models.map((x) => [x.name, x.fit]), [['gemma3:4b', 'fits'], ['llama3.2:3b', 'fits']]);
    // queue: small always unloads a loaded model
    await fetch(s.base + '/ollama/api/chat', { method: 'POST', body: JSON.stringify({ model: 'gemma3:4b', messages: [{ role: 'user', content: 'hi' }], stream: false }) });
    const q = await post(s.base + '/api/memory/before-queue', { workflow: 'fast-concept' });
    assert.equal(q.unload, true); assert.deepEqual(q.result.stillLoaded, []);
    // chat with low free VRAM: ComfyUI /free with unload_models
    s.hw.gpu = { ...s.hw.gpu, freeMB: 900 };
    const c = await post(s.base + '/api/memory/before-chat', { model: 'gemma3:4b' });
    assert.equal(c.ok, true); assert.equal(c.keepAlive, '5m'); assert.equal(c.freed.ok, true); assert.deepEqual(c.freed.body, { unload_models: true, free_memory: true });
    assert.ok((await j(await fetch(s.mockBase + '/mock/requests'))).some((r) => r.path === '/free'));
  } finally { await s.close(); }
});

test('5080 (16 GB): chat model stays loaded next to ComfyUI; low free VRAM triggers the unload; 12B allowed with fit note', async () => {
  const s = await startStack({ gpu: { ...GPU_5080, freeMB: 12000 }, ollamaOptions: { extraModels: [{ name: 'gemma3:12b', vision: true, size: 8149190253, family: 'gemma3' }] } });
  try {
    const m = await j(await fetch(s.base + '/api/memory?fresh=1'));
    assert.equal(m.profile.id, 'large');
    assert.equal(m.models.find((x) => x.name === 'gemma3:12b').fit, 'fits');
    await fetch(s.base + '/ollama/api/chat', { method: 'POST', body: JSON.stringify({ model: 'gemma3:4b', messages: [{ role: 'user', content: 'hi' }], stream: false }) });
    const keep = await post(s.base + '/api/memory/before-queue', { workflow: 'fast-concept' });
    assert.equal(keep.unload, false); assert.equal(keep.result, undefined);
    assert.deepEqual([...s.ollama.loaded], ['gemma3:4b']);
    s.hw.gpu = { ...s.hw.gpu, freeMB: 2000 };
    const low = await post(s.base + '/api/memory/before-queue', { workflow: 'fast-concept' });
    assert.equal(low.unload, true); assert.equal(low.needMB, 2500); assert.deepEqual(low.result.stillLoaded, []);
    // big model with little free VRAM: partial (RAM spill), keep_alive 10m, no ComfyUI /free
    s.hw.gpu = { ...s.hw.gpu, freeMB: 4000 };
    const c = await post(s.base + '/api/memory/before-chat', { model: 'gemma3:12b' });
    assert.deepEqual([c.ok, c.fit, c.keepAlive, c.freed], [true, 'partial', '10m', undefined]);
    // not enough VRAM + RAM -> refused (would swap)
    s.hw.ram = { totalMB: 98204, freeMB: 9000 };
    s.hw.gpu = { ...s.hw.gpu, freeMB: 1000 };
    const no = await post(s.base + '/api/memory/before-chat', { model: 'gemma3:12b' });
    assert.equal(no.ok, false); assert.equal(no.fit, 'no-fit');
  } finally { await s.close(); }
});

test('memory profile is always Auto from VRAM: old saved choice, MEMORY_PROFILE and the override route are ignored; partial badge in status', async () => {
  // An old data/memory-profile.json from the removed menu setting must not matter.
  const s = await startStack({ gpu: { ...GPU_5080 }, env: { MEMORY_PROFILE: 'small' }, data: { 'memory-profile.json': { profile: 'small' } }, ollamaOptions: { vramFraction: { 'gemma3:4b': 0.6 } } });
  try {
    const m = await j(await fetch(s.base + '/api/memory'));
    assert.deepEqual([m.profile.id, m.profile.source], ['large', 'auto']);
    assert.equal(m.setting, undefined); assert.equal(m.env, undefined);
    const r = await fetch(s.base + '/api/memory/profile', { method: 'PUT', body: JSON.stringify({ profile: 'small' }) });
    assert.equal(r.status, 404, 'no override route');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.dataDir, 'memory-profile.json'), 'utf8')), { profile: 'small' }, 'old file left alone, just ignored');
    assert.equal((await j(await fetch(s.base + '/api/memory'))).profile.id, 'large');
    const q = await post(s.base + '/api/memory/before-queue', { workflow: 'default' });
    assert.equal(q.profile, 'large');
    await fetch(s.base + '/ollama/api/chat', { method: 'POST', body: JSON.stringify({ model: 'gemma3:4b', messages: [{ role: 'user', content: 'hi' }], stream: false }) });
    const st = await j(await fetch(s.base + '/api/memory'));
    assert.deepEqual(st.ollama.loaded[0].badge, { partial: true, gpuPct: 60, text: 'slower, runs partly in RAM (60% on GPU)' });
  } finally { await s.close(); }
  // Broken old file: still fine.
  const e = await startStack({ gpu: { ...GPU_2080TI }, data: { 'memory-profile.json': '{not json' } });
  try { assert.deepEqual((await j(await fetch(e.base + '/api/memory'))).profile.id, 'small'); } finally { await e.close(); }
});

test('no nvidia-smi: falls back to ComfyUI /system_stats; config edits are picked up without restart', async () => {
  const f = tmpFile(DEFAULT_MEMORY_CONFIG);
  const s = await startStack({ gpu: null, memoryFile: f });
  try {
    const m = await j(await fetch(s.base + '/api/memory?fresh=1'));
    assert.equal(m.hardware.gpu.source, 'comfyui');
    assert.equal(m.hardware.gpu.name, 'mock-gpu');
    assert.equal(m.profile.id, 'small');
    // A "profile" set in the file is ignored (always Auto); edited thresholds are picked up.
    fs.writeFileSync(f, JSON.stringify({ ...DEFAULT_MEMORY_CONFIG, profile: 'large' }));
    let t = Date.now() / 1000 + 5; fs.utimesSync(f, t, t);
    const m2 = await j(await fetch(s.base + '/api/memory'));
    assert.deepEqual([m2.profile.id, m2.profile.source], ['small', 'auto']);
    fs.writeFileSync(f, JSON.stringify({ ...DEFAULT_MEMORY_CONFIG, profiles: [{ ...DEFAULT_MEMORY_CONFIG.profiles[0], id: 'tiny' }, DEFAULT_MEMORY_CONFIG.profiles[1]] }));
    t = Date.now() / 1000 + 10; fs.utimesSync(f, t, t);
    const m3 = await j(await fetch(s.base + '/api/memory'));
    assert.deepEqual([m3.profile.id, m3.profile.source], ['tiny', 'auto']);
  } finally { await s.close(); }
});
