// comfy-info.js - what ComfyUI has installed RIGHT NOW, read live (never hard-coded):
//   /object_info          node classes + their inputs (combo lists = installed model files)
//   /models, /models/<f>  model files per folder (backslash paths on Windows)
//   /internal/folder_paths  only when ComfyUI runs on this PC: lets us check files
//                         that /models does not list (e.g. VibeVoice under models/tts)
// Cached for ttlMs; get({ fresh: true }) re-reads. If ComfyUI is offline,
// { objectInfo: null, error } is returned and availability shows "unknown".
import fs from 'node:fs';
import path from 'node:path';

const SKIP_FOLDERS = new Set(['custom_nodes', 'configs']);

export function createComfyInfo({ getComfyUrl, ttlMs = 60000, fetchImpl = fetch } = {}) {
  let cache = null, inflight = null;
  const getJson = async (p, ms = 8000) => {
    const r = await fetchImpl(getComfyUrl() + p, { signal: AbortSignal.timeout(ms) });
    if (!r.ok) throw new Error(`ComfyUI ${p}: HTTP ${r.status}`);
    return r.json();
  };
  async function load() {
    const objectInfo = await getJson('/object_info', 15000);
    const models = {};
    let folders = [];
    try { folders = await getJson('/models', 3000); } catch { folders = []; }
    await Promise.all((Array.isArray(folders) ? folders : []).filter((f) => !SKIP_FOLDERS.has(f)).map(async (f) => {
      try { const l = await getJson(`/models/${encodeURIComponent(f)}`, 4000); models[f] = Array.isArray(l) ? l : []; } catch { models[f] = []; }
    }));
    let folderPaths = null;
    if (isLocal(getComfyUrl())) {
      try { const fp = await getJson('/internal/folder_paths', 3000); folderPaths = typeof fp === 'string' ? JSON.parse(fp) : fp; } catch { folderPaths = null; }
    }
    return { objectInfo, models, folderPaths, at: Date.now() };
  }
  async function get({ fresh = false } = {}) {
    if (!fresh && cache && Date.now() - cache.at < ttlMs) return cache;
    if (!inflight) {
      inflight = load().then((v) => { cache = v; return v; }, (e) => {
        const v = { objectInfo: null, models: {}, folderPaths: null, error: e.message, at: Date.now() };
        cache = { ...v, at: Date.now() - ttlMs + 5000 }; // retry an offline ComfyUI after ~5 s
        return v;
      }).finally(() => { inflight = null; });
    }
    return inflight;
  }
  return { get, invalidate: () => { cache = null; } };
}

export function isLocal(url) {
  try { return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(new URL(url).hostname); } catch { return false; }
}

/**
 * Files /models cannot list: look for them on disk in ComfyUI's own folder
 * paths (only when ComfyUI is on this PC). Returns { "<fsFolder>/<file>": bool }.
 * Unknown (remote ComfyUI) -> key missing, which the availability check treats
 * as "cannot verify" (unavailable - never risk an auto-download).
 */
export function checkFsFiles(info, files) {
  const out = {};
  if (!info?.folderPaths) return out;
  for (const f of files) {
    if (!f.fsFolder) continue;
    const roots = (info.folderPaths[f.fsFolder] || []).map((r) => (Array.isArray(r) ? r[0] : r)).filter((r) => typeof r === 'string');
    const rel = String(f.file).split(/[\\/]/);
    out[`${f.fsFolder}/${f.file}`] = roots.some((r) => { try { return fs.statSync(path.join(r, ...rel)).isFile(); } catch { return false; } });
  }
  return out;
}
