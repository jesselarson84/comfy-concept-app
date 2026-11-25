// config.js - settings come from config.json, then config.local.json (yours,
// git-ignored), then environment variables (highest priority).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

export function loadConfig(overrides = {}) {
  const cfg = {
    comfyUrl: 'http://127.0.0.1:8188',
    comfyUrlFallbacks: ['http://127.0.0.1:8188', 'http://127.0.0.1:8000'],
    host: '127.0.0.1',
    port: 3100,
    workflowsDir: 'workflows',
    dataDir: 'data',
    sessionGapMinutes: 90,
    outputSubfolder: 'concept-app',
    // Local Ollama for the History tagger (server/tagger.js). Stays on localhost.
    ollamaUrl: 'http://127.0.0.1:11434',
    // GPU sharing between ComfyUI and Ollama: profiles picked from the detected
    // VRAM (see config/memory-profiles.json and server/memory.js).
    memoryProfilesFile: 'config/memory-profiles.json',
    // "Save to Drive" target: the Google Drive for Desktop folder (server/drive.js).
    driveDir: 'Q:\\My Drive\\Comfy UI',
    // Batch 11: projects are folders under this one; every output is filed there (server/projects.js, filer.js).
    projectsDir: 'Q:\\My Drive\\Creative\\PROJECTS\\ACTIVE',
    // ComfyUI's output folder on disk ("From Comfy UI" grid). Empty = ask ComfyUI
    // (its --output-directory, when it runs on this PC); see server/outputs.js.
    comfyOutputDir: '',
    ...readJson(path.join(ROOT, 'config.json')),
    ...readJson(path.join(ROOT, 'config.local.json')),
  };
  const env = process.env;
  if (env.COMFY_URL) { cfg.comfyUrl = env.COMFY_URL; cfg.comfyUrlExplicit = true; }
  if (env.PORT) cfg.port = Number(env.PORT);
  if (env.HOST) cfg.host = env.HOST;
  if (env.WORKFLOWS_DIR) cfg.workflowsDir = env.WORKFLOWS_DIR;
  if (env.DATA_DIR) cfg.dataDir = env.DATA_DIR;
  if (env.OLLAMA_URL) cfg.ollamaUrl = env.OLLAMA_URL;
  if (env.MEMORY_PROFILES_FILE) cfg.memoryProfilesFile = env.MEMORY_PROFILES_FILE;
  if (env.DRIVE_DIR) cfg.driveDir = env.DRIVE_DIR;
  if (env.PROJECTS_DIR) cfg.projectsDir = env.PROJECTS_DIR;
  if (env.COMFY_OUTPUT_DIR) cfg.comfyOutputDir = env.COMFY_OUTPUT_DIR;
  Object.assign(cfg, overrides);
  cfg.comfyUrl = String(cfg.comfyUrl).replace(/\/+$/, '');
  cfg.ollamaUrl = String(cfg.ollamaUrl).replace(/\/+$/, '');
  cfg.workflowsDir = path.resolve(ROOT, cfg.workflowsDir);
  cfg.dataDir = path.resolve(ROOT, cfg.dataDir);
  cfg.memoryProfilesFile = path.resolve(ROOT, cfg.memoryProfilesFile);
  return cfg;
}

// The owner's Comfy Desktop (v0.46.1) runs on 8188; some Desktop builds use 8000.
// Unless COMFY_URL was set explicitly, try the configured URL first and then
// the fallbacks, and keep the first that answers /system_stats.
export async function probeComfy(cfg, timeoutMs = 1500) {
  const candidates = cfg.comfyUrlExplicit ? [cfg.comfyUrl] : [cfg.comfyUrl, ...(cfg.comfyUrlFallbacks || [])];
  for (const url of [...new Set(candidates.map((u) => u.replace(/\/+$/, '')))]) {
    try {
      const r = await fetch(url + '/system_stats', { signal: AbortSignal.timeout(timeoutMs) });
      if (r.ok) return { url, ok: true, stats: await r.json() };
    } catch { /* try next */ }
  }
  return { url: cfg.comfyUrl, ok: false };
}
