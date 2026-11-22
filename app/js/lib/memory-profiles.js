// memory-profiles.js - how the GPU is shared between ComfyUI and Ollama.
// Pure functions (no I/O), used by the server (server/memory.js) and tests.
//
// The profile is chosen from the GPU's TOTAL VRAM (detected, not hardcoded):
//   small (< 12 GB, the 2080 Ti): unload Ollama before EVERY ComfyUI queue;
//         before a chat turn ask ComfyUI to /free if free VRAM is too low.
//   large (>= ~16 GB, the 5080): keep the chat model loaded next to ComfyUI
//         (keep_alive 10m); before a queue unload it only if free VRAM is below
//         what that workflow needs; bigger chat models allowed, partly in RAM.
// All numbers live in config/memory-profiles.json; DEFAULT_MEMORY_CONFIG is the
// fallback when that file is missing or broken.

export const DEFAULT_MEMORY_CONFIG = {
  profile: 'auto',
  headroomMB: 768,
  desktopReserveMB: 1200,
  modelOverheadFactor: 1.2,
  ram: { reserveMB: 8192 },
  profiles: [
    { id: 'small', label: 'Under 12 GB VRAM (e.g. RTX 2080 Ti 11 GB)', minVramMB: 0, unloadOllamaBeforeQueue: 'always', ollamaKeepAlive: '5m', freeComfyBeforeChat: 'if-low', freeComfyBeforeQueue: 'on-switch', comfyFree: { unload_models: true, free_memory: true }, maxChatModelMB: 6500 },
    { id: 'large', label: '16 GB+ VRAM (e.g. RTX 5080 16 GB)', minVramMB: 15000, unloadOllamaBeforeQueue: 'if-needed', ollamaKeepAlive: '10m', freeComfyBeforeChat: 'never', freeComfyBeforeQueue: 'never', comfyFree: { unload_models: false, free_memory: true }, maxChatModelMB: 26000 },
  ],
  workflowVramNeedMB: { default: 3000, 'fast-concept': 2500, 'from-reference-image': 3000, 'action:upscale': 2500, 'action:image-to-3d': 8000 },
};

const UNLOAD_MODES = ['always', 'if-needed', 'never'];
const FREE_MODES = ['if-low', 'never'];
const num = (v, d, min = 0) => (typeof v === 'number' && Number.isFinite(v) && v >= min ? v : d);
const MiB = 1024 * 1024;

/** Merge a (possibly partial / broken) config object over the defaults. */
export function normalizeMemoryConfig(raw) {
  const warnings = [];
  const D = DEFAULT_MEMORY_CONFIG;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== undefined) warnings.push('memory config is not an object - using defaults');
    raw = {};
  }
  const pick = (k, min) => {
    if (raw[k] !== undefined && num(raw[k], null, min) === null) warnings.push(`${k}: ignored bad value ${JSON.stringify(raw[k])}`);
    return num(raw[k], D[k], min);
  };
  const cfg = {
    profile: typeof raw.profile === 'string' ? raw.profile : D.profile,
    headroomMB: pick('headroomMB'),
    desktopReserveMB: pick('desktopReserveMB'),
    modelOverheadFactor: pick('modelOverheadFactor', 1),
    ram: { reserveMB: num(raw.ram?.reserveMB, D.ram.reserveMB) },
    profiles: [],
    workflowVramNeedMB: { ...D.workflowVramNeedMB },
  };
  const list = Array.isArray(raw.profiles) && raw.profiles.length ? raw.profiles : D.profiles;
  if (raw.profiles !== undefined && list === D.profiles) warnings.push('profiles: missing or empty - using defaults');
  for (const p of list) {
    if (!p || typeof p.id !== 'string' || !p.id) { warnings.push('profiles: skipped an entry without an id'); continue; }
    const base = D.profiles.find((d) => d.id === p.id) || D.profiles[0];
    const prof = {
      id: p.id, label: typeof p.label === 'string' ? p.label : base.label,
      minVramMB: num(p.minVramMB, base.minVramMB),
      unloadOllamaBeforeQueue: UNLOAD_MODES.includes(p.unloadOllamaBeforeQueue) ? p.unloadOllamaBeforeQueue : base.unloadOllamaBeforeQueue,
      ollamaKeepAlive: typeof p.ollamaKeepAlive === 'string' || typeof p.ollamaKeepAlive === 'number' ? p.ollamaKeepAlive : base.ollamaKeepAlive,
      freeComfyBeforeChat: FREE_MODES.includes(p.freeComfyBeforeChat) ? p.freeComfyBeforeChat : base.freeComfyBeforeChat,
      freeComfyBeforeQueue: ['never', 'on-switch'].includes(p.freeComfyBeforeQueue) ? p.freeComfyBeforeQueue : (base.freeComfyBeforeQueue || 'never'),
      comfyFree: { unload_models: !!(p.comfyFree?.unload_models ?? base.comfyFree.unload_models), free_memory: p.comfyFree?.free_memory ?? base.comfyFree.free_memory ?? true },
      maxChatModelMB: num(p.maxChatModelMB, base.maxChatModelMB),
    };
    if (p.unloadOllamaBeforeQueue !== undefined && prof.unloadOllamaBeforeQueue !== p.unloadOllamaBeforeQueue) warnings.push(`${p.id}.unloadOllamaBeforeQueue: must be one of ${UNLOAD_MODES.join('/')}`);
    if (cfg.profiles.some((x) => x.id === prof.id)) { warnings.push(`profiles: duplicate id ${prof.id}`); continue; }
    cfg.profiles.push(prof);
  }
  cfg.profiles.sort((a, b) => a.minVramMB - b.minVramMB);
  if (raw.workflowVramNeedMB && typeof raw.workflowVramNeedMB === 'object') {
    for (const [k, v] of Object.entries(raw.workflowVramNeedMB)) {
      if (k.startsWith('_')) continue;
      if (num(v, null) === null) warnings.push(`workflowVramNeedMB.${k}: ignored bad value`);
      else cfg.workflowVramNeedMB[k] = v;
    }
  }
  return { config: cfg, warnings };
}

/**
 * Active profile. The server always calls this with profile 'auto' and no
 * overrides (server/memory.js): the profile follows the detected VRAM.
 * (Precedence when overrides are passed: env > setting > config "profile" > auto.)
 * "auto" (or an unknown id, with a warning) falls through to the next level.
 * Auto = the profile with the highest minVramMB <= total VRAM; unknown VRAM -> the smallest (safest).
 */
export function selectProfile(totalVramMB, config, { env, setting } = {}) {
  const warnings = [];
  for (const [source, id] of [['env', env], ['setting', setting], ['config', config.profile]]) {
    if (!id || id === 'auto') continue;
    const p = config.profiles.find((x) => x.id === id);
    if (p) return { profile: p, source, warnings };
    warnings.push(`unknown profile "${id}" from ${source} - ignored`);
  }
  let chosen = config.profiles[0];
  if (typeof totalVramMB === 'number' && totalVramMB > 0) for (const p of config.profiles) if (p.minVramMB <= totalVramMB) chosen = p;
  return { profile: chosen, source: 'auto', warnings };
}

export function workflowNeedMB(config, workflowId, presetEstMB) {
  const t = config.workflowVramNeedMB;
  return num(t[workflowId], num(presetEstMB, num(t.default, 3000)));
}

/**
 * Before a ComfyUI job: ask ComfyUI to /free its cached models first?
 * Small profile ('on-switch'): only when switching to a DIFFERENT workflow than
 * the last one queued, and the VRAM free after unloading Ollama is still below
 * what the new workflow needs (stale models from the previous preset would
 * otherwise push the new one into RAM offload). Same workflow again = keep the
 * loaded models (that is what makes the second run fast).
 */
export function decideFreeBeforeQueue({ profile, freeMB, ollamaFreedMB = 0, needMB, headroomMB = 0, lastWorkflow, workflow }) {
  if ((profile.freeComfyBeforeQueue || 'never') !== 'on-switch') return { freeComfy: false, reason: `profile ${profile.id}: ComfyUI keeps its models between jobs` };
  if (!lastWorkflow || lastWorkflow === workflow) return { freeComfy: false, reason: lastWorkflow ? 'same workflow as last time: keep loaded models' : 'first job since start' };
  if (typeof freeMB !== 'number') return { freeComfy: false, reason: 'free VRAM unknown' };
  const avail = freeMB + ollamaFreedMB - headroomMB;
  return avail < needMB
    ? { freeComfy: true, reason: `switching ${lastWorkflow} -> ${workflow}: ~${avail} MB free < need ${needMB} MB, asking ComfyUI to free VRAM` }
    : { freeComfy: false, reason: `switching workflows, ~${avail} MB free is enough for ${needMB} MB` };
}

/**
 * Before a ComfyUI queue: unload Ollama's models or keep them?
 * ollamaModels: /api/ps models ([{ name, size, size_vram }]).
 */
export function decideBeforeQueue({ profile, freeMB, ollamaModels = [], needMB, headroomMB = 0, heavy = false }) {
  const onGpu = ollamaModels.filter((m) => (m.size_vram ?? m.size ?? 0) > 0);
  if (!ollamaModels.length) return { unload: false, reason: 'no chat model loaded' };
  // Heavy jobs (Pixal3D, >= 12 GB) need the VRAM and the RAM: always keep_alive 0 first.
  if (heavy) return { unload: true, reason: 'heavy job: unloading the chat model (keep_alive 0)' };
  const mode = profile.unloadOllamaBeforeQueue;
  if (mode === 'always') return { unload: true, reason: `profile ${profile.id}: always unload before ComfyUI` };
  if (mode === 'never') return { unload: false, reason: `profile ${profile.id}: never unload` };
  if (!onGpu.length) return { unload: false, reason: 'chat model is in RAM only, not using VRAM' };
  if (typeof freeMB !== 'number') return { unload: true, reason: 'free VRAM unknown - unloading to be safe' };
  const avail = freeMB - headroomMB;
  return avail >= needMB
    ? { unload: false, reason: `free VRAM ${freeMB} MB - headroom ${headroomMB} >= need ${needMB} MB: chat model stays loaded` }
    : { unload: true, reason: `free VRAM ${freeMB} MB - headroom ${headroomMB} < need ${needMB} MB: unloading chat model` };
}

/**
 * Will a chat model fit? sizeBytes = model file size (/api/tags); loadedVramBytes
 * = what it already holds (from /api/ps), which is free for itself.
 * -> { estMB, fit: 'fits' | 'partial' | 'too-big' | 'no-fit', message }
 */
export function modelFit({ sizeBytes, loadedVramBytes = 0, freeVramMB, totalVramMB, freeRamMB, profile, config }) {
  const estMB = Math.round((sizeBytes / MiB) * config.modelOverheadFactor);
  if (estMB > profile.maxChatModelMB) return { estMB, fit: 'too-big', message: `~${gb(estMB)} needed - too big for the ${profile.id} GPU profile (max ${gb(profile.maxChatModelMB)})` };
  let vram = (typeof freeVramMB === 'number' ? freeVramMB : 0) + loadedVramBytes / MiB;
  // The small profile frees ComfyUI's VRAM before a chat turn when needed.
  if (profile.freeComfyBeforeChat === 'if-low' && typeof totalVramMB === 'number') vram = Math.max(vram, totalVramMB - config.desktopReserveMB);
  vram -= config.headroomMB;
  if (estMB <= vram) return { estMB, fit: 'fits', message: `fits in VRAM (~${gb(estMB)})` };
  const ram = typeof freeRamMB === 'number' ? freeRamMB - config.ram.reserveMB : 0;
  if (estMB <= Math.max(0, vram) + Math.max(0, ram)) return { estMB, fit: 'partial', message: `slower, runs partly in RAM (~${gb(estMB)}, ~${gb(Math.max(0, vram))} free VRAM)` };
  return { estMB, fit: 'no-fit', message: `won't fit in free VRAM + RAM (~${gb(estMB)} needed) - it would swap to disk` };
}

/** /api/ps entry -> badge when the loaded model is partly (or fully) in system RAM. */
export function offloadBadge(m) {
  if (!m || !(m.size > 0)) return null;
  const v = Math.max(0, m.size_vram ?? m.size);
  if (v >= m.size) return null;
  const pct = Math.round((v / m.size) * 100);
  return { partial: true, gpuPct: pct, text: pct === 0 ? 'slow: running in RAM only (CPU)' : `slower, runs partly in RAM (${pct}% on GPU)` };
}

/** Before a chat turn: ask ComfyUI to /free first? */
export function decideBeforeChat({ profile, freeMB, estMB, modelLoaded, headroomMB = 0 }) {
  if (modelLoaded) return { freeComfy: false, reason: 'chat model already loaded' };
  if (profile.freeComfyBeforeChat !== 'if-low') return { freeComfy: false, reason: `profile ${profile.id}: ComfyUI keeps its models (RAM/VRAM); Ollama may offload part of the model to RAM` };
  if (typeof freeMB !== 'number') return { freeComfy: false, reason: 'free VRAM unknown' };
  return freeMB - headroomMB < estMB
    ? { freeComfy: true, reason: `free VRAM ${freeMB} MB < model ~${estMB} MB + headroom: asking ComfyUI to free VRAM` }
    : { freeComfy: false, reason: `free VRAM ${freeMB} MB is enough for ~${estMB} MB` };
}

export const gb = (mb) => `${(mb / 1024).toFixed(1)} GB`;
