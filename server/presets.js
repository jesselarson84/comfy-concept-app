// presets.js (server) - the AI Workflow presets in workflows/ai/*.json.
// Validated with the shared app/js/lib/presets.js; availability is computed
// LIVE for every list() from ComfyUI's /object_info + model lists, the GPU
// (nvidia-smi) and free RAM, per memory profile. Nothing about what is
// installed is hard-coded here.
import fs from 'node:fs';
import path from 'node:path';
import { validatePreset, presetAvailability, comboOptions } from '../app/js/lib/presets.js';
import { detectControls } from '../app/js/lib/workflow-detect.js';
import { checkFsFiles } from './comfy-info.js';
import { ggufPath, isHeavy } from '../app/js/lib/memory-options.js';

export class PresetStore {
  constructor(dir) { this.dir = dir; this.cache = null; }

  load() {
    let files = [];
    try { files = fs.readdirSync(this.dir).filter((f) => f.toLowerCase().endsWith('.json')).sort(); } catch { return []; }
    const key = files.map((f) => { try { return f + fs.statSync(path.join(this.dir, f)).mtimeMs; } catch { return f; } }).join('|');
    if (this.cache?.key === key) return this.cache.items;
    const items = files.map((f) => {
      const id = path.basename(f, '.json');
      try { return validatePreset(id, JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'))); } catch (e) { return { ok: false, id, error: 'Invalid JSON: ' + e.message }; }
    });
    this.cache = { key, items };
    return items;
  }

  get(id) { return this.load().find((p) => p.ok && p.id === String(id).replace(/^ai:/, '')); }

  /** VRAM estimate + heavy flag for the loader path this profile uses. */
  memoryFor(id, { objectInfo, profileId } = {}) {
    const p = this.get(id);
    if (!p) return {};
    const v = ggufPath(p.workflow, p.manifest, { objectInfo, profileId });
    const estMB = v.manifest.vram.measuredMB || v.manifest.vram.estMB;
    return { estMB, heavy: isHeavy(v.manifest, estMB), loader: v.loader };
  }

  /** Live info + file checks for all presets (fs checks only for files /models cannot list). */
  withFs(info) {
    const fsFiles = checkFsFiles(info, this.load().filter((p) => p.ok).flatMap((p) => p.manifest.files));
    return { ...info, fsFiles };
  }

  /**
   * Items for /api/workflows, same shape as WorkflowStore items plus
   * { group, ai: manifest, availability }.
   * @param info  comfy-info get() result; hw = { gpuTotalMB, ramFreeMB }; opts = { profileId, desktopReserveMB, ramReserveMB }
   */
  list(info, hw, opts) {
    const live = this.withFs(info);
    return this.load().map((p) => {
      const id = `ai:${p.id}`;
      if (!p.ok) return { id, file: `ai/${p.id}.json`, label: p.id, ok: false, error: p.error };
      // GGUF loader path (Qwen presets): Q5_K_M through UnetLoaderGGUF on the small GPU.
      const v = ggufPath(p.workflow, p.manifest, { objectInfo: live.objectInfo, profileId: opts?.profileId });
      const pv = { ...p, workflow: v.workflow, manifest: v.manifest };
      const manifest = withInputDefaults(pv, withInstalledOptions(pv, live.objectInfo), live.objectInfo);
      manifest.heavy = isHeavy(manifest);
      const controls = presetControls(v.workflow, manifest);
      return {
        id, file: `ai/${p.id}.json`, label: manifest.label, description: manifest.description, group: manifest.group,
        ok: true, controls, workflow: v.workflow, ai: manifest, loader: v.loader,
        availability: presetAvailability({ ...pv, manifest }, live, hw, opts),
      };
    });
  }
}

/** detectControls, minus what the manifest params own (steps, denoise, batch). */
export function presetControls(workflow, manifest) {
  const c = detectControls(workflow);
  if (!c.ok) return c;
  const owned = new Set(Object.values(manifest.params).flatMap((p) => [p, ...(p.also || [])]).map((t) => `${t.node}.${t.input}`));
  c.steps = []; c.strength = []; c.batch = [];
  c.expose = c.expose.filter((e) => !owned.has(`${e.node}.${e.input}`));
  c.defaults.steps = undefined; c.defaults.strength = undefined;
  return c;
}

/** Enum params that pick a model: keep only the options ComfyUI has installed. */
export function withInstalledOptions(p, objectInfo) {
  if (!objectInfo) return p.manifest;
  const params = {};
  for (const [k, d] of Object.entries(p.manifest.params)) {
    if (d.type !== 'enum') { params[k] = d; continue; }
    const n = p.workflow[d.node];
    const spec = objectInfo[n?.class_type]?.input;
    const opts = comboOptions(spec?.required?.[d.input] || spec?.optional?.[d.input]);
    if (!opts) { params[k] = d; continue; }
    const norm = (s) => String(s).replace(/\\/g, '/');
    const keep = d.options.filter((o) => opts.map(norm).includes(norm(o)));
    params[k] = keep.length ? { ...d, options: keep, default: keep.includes(d.default) ? d.default : keep[0] } : d;
  }
  return { ...p.manifest, params };
}

/** File slots with a default file (e.g. VibeVoice's voice sample): is that file in ComfyUI's input folder right now? */
export function withInputDefaults(p, manifest, objectInfo) {
  if (!manifest.inputs?.some((s) => s.default)) return manifest;
  const inputs = manifest.inputs.map((s) => {
    if (!s.default) return s;
    const spec = objectInfo?.[p.workflow[s.node]?.class_type]?.input;
    const opts = comboOptions(spec?.required?.[s.input] || spec?.optional?.[s.input]);
    return { ...s, defaultAvailable: !!opts?.includes(s.default) };
  });
  return { ...manifest, inputs };
}
