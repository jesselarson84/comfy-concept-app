// memory-profiles.js - how the GPU is shared between ComfyUI and Ollama (the
// History tagger's model). Pure functions (no I/O), used by the server
// (server/memory.js) and tests.
//
// The profile is chosen from the GPU's TOTAL VRAM (detected, not hardcoded):
//   small (< 12 GB, the 2080 Ti): unload Ollama before EVERY ComfyUI queue.
//   large (>= ~16 GB, the 5080): before a queue unload Ollama only if free VRAM
//         is below what that workflow needs.
// All numbers live in config/memory-profiles.json; DEFAULT_MEMORY_CONFIG is the
// fallback when that file is missing or broken.

export const DEFAULT_MEMORY_CONFIG = {
  profile: 'auto',
  headroomMB: 768,
  profiles: [
    { id: 'small', label: 'Under 12 GB VRAM (e.g. RTX 2080 Ti 11 GB)', minVramMB: 0, unloadOllamaBeforeQueue: 'always', freeComfyBeforeQueue: 'on-switch', comfyFree: { unload_models: true, free_memory: true } },
    { id: 'large', label: '16 GB+ VRAM (e.g. RTX 5080 16 GB)', minVramMB: 15000, unloadOllamaBeforeQueue: 'if-needed', freeComfyBeforeQueue: 'never', comfyFree: { unload_models: false, free_memory: true } },
  ],
  workflowVramNeedMB: { default: 3000, 'fast-concept': 2500, 'from-reference-image': 3000 },
};

const UNLOAD_MODES = ['always', 'if-needed', 'never'];
const num = (v, d, min = 0) => (typeof v === 'number' && Number.isFinite(v) && v >= min ? v : d);

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
      freeComfyBeforeQueue: ['never', 'on-switch'].includes(p.freeComfyBeforeQueue) ? p.freeComfyBeforeQueue : (base.freeComfyBeforeQueue || 'never'),
      comfyFree: { unload_models: !!(p.comfyFree?.unload_models ?? base.comfyFree.unload_models), free_memory: p.comfyFree?.free_memory ?? base.comfyFree.free_memory ?? true },
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
  if (!ollamaModels.length) return { unload: false, reason: 'no Ollama model loaded' };
  // Heavy jobs (Pixal3D, >= 12 GB) need the VRAM and the RAM: always keep_alive 0 first.
  if (heavy) return { unload: true, reason: 'heavy job: unloading the Ollama model (keep_alive 0)' };
  const mode = profile.unloadOllamaBeforeQueue;
  if (mode === 'always') return { unload: true, reason: `profile ${profile.id}: always unload before ComfyUI` };
  if (mode === 'never') return { unload: false, reason: `profile ${profile.id}: never unload` };
  if (!onGpu.length) return { unload: false, reason: 'Ollama model is in RAM only, not using VRAM' };
  if (typeof freeMB !== 'number') return { unload: true, reason: 'free VRAM unknown - unloading to be safe' };
  const avail = freeMB - headroomMB;
  return avail >= needMB
    ? { unload: false, reason: `free VRAM ${freeMB} MB - headroom ${headroomMB} >= need ${needMB} MB: Ollama model stays loaded` }
    : { unload: true, reason: `free VRAM ${freeMB} MB - headroom ${headroomMB} < need ${needMB} MB: unloading Ollama model` };
}

/** /api/ps entry -> badge when the loaded model is partly (or fully) in system RAM. */
export function offloadBadge(m) {
  if (!m || !(m.size > 0)) return null;
  const v = Math.max(0, m.size_vram ?? m.size);
  if (v >= m.size) return null;
  const pct = Math.round((v / m.size) * 100);
  return { partial: true, gpuPct: pct, text: pct === 0 ? 'slow: running in RAM only (CPU)' : `slower, runs partly in RAM (${pct}% on GPU)` };
}

