// memory.js - applies the memory profile (app/js/lib/memory-profiles.js) using
// live numbers: detected VRAM/RAM (hardware.js), Ollama's /api/ps and /api/tags.
//
//   status()            hardware + active profile + chat models with a fit note
//
// The profile is ALWAYS chosen automatically from the detected total VRAM.
// There is no override any more: an old data/memory-profile.json, a "profile"
// in config/memory-profiles.json and MEMORY_PROFILE are all ignored.
//   beforeQueue(wf)     unload Ollama or keep it, per profile and free VRAM
//   beforeChat(model)   refuse models that would swap; maybe ComfyUI /free first
//   freeForChat()       the out-of-memory fallback: ComfyUI /free (API call, ComfyUI keeps running)
import fs from 'node:fs';
import path from 'node:path';
import { normalizeMemoryConfig, selectProfile, workflowNeedMB, decideBeforeQueue, decideFreeBeforeQueue, decideBeforeChat, modelFit, offloadBadge } from '../app/js/lib/memory-profiles.js';

export function loadMemoryConfig(file) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    const r = normalizeMemoryConfig(undefined);
    r.warnings.push(e.code === 'ENOENT' ? `${path.basename(file)} not found - using built-in defaults` : `${path.basename(file)} is not valid JSON (${e.message}) - using built-in defaults`);
    return r;
  }
  return normalizeMemoryConfig(raw);
}

export function createMemory({ cfg, hardware, ollama, getComfyUrl }) {
  const file = cfg.memoryProfilesFile;
  let cached = { mtime: -1, value: null };
  const config = () => {
    let m = 0; try { m = fs.statSync(file).mtimeMs; } catch {}
    if (m !== cached.mtime || !cached.value) cached = { mtime: m, value: loadMemoryConfig(file) };
    return cached.value;
  };
  const getJson = async (p, opts = {}) => {
    const r = await fetch(cfg.ollamaUrl + p, { ...opts, signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(`Ollama ${p} ${r.status}`);
    return r.json();
  };
  const ps = async () => { try { return (await getJson('/api/ps')).models || []; } catch { return null; } };

  async function active({ fresh = false } = {}) {
    const { config: c, warnings } = config();
    const hw = await hardware.detect({ fresh });
    const sel = selectProfile(hw.gpu?.totalMB, { ...c, profile: 'auto' });
    return { c, hw, sel, warnings: [...warnings, ...sel.warnings] };
  }

  async function status({ fresh = false } = {}) {
    const { c, hw, sel, warnings } = await active({ fresh });
    const loaded = await ps();
    let models = [];
    try {
      const tags = (await getJson('/api/tags')).models || [];
      models = tags.map((t) => {
        const l = loaded?.find((x) => x.name === t.name || x.model === t.name);
        return { name: t.name, size: t.size, ...modelFit({ sizeBytes: t.size || 0, loadedVramBytes: l?.size_vram || 0, freeVramMB: hw.gpu?.freeMB, totalVramMB: hw.gpu?.totalMB, freeRamMB: hw.ram.freeMB, profile: sel.profile, config: c }) };
      });
    } catch {}
    return {
      hardware: hw,
      profile: { ...sel.profile, source: sel.source },
      profiles: c.profiles.map((p) => ({ id: p.id, label: p.label, minVramMB: p.minVramMB })),
      headroomMB: c.headroomMB, workflowVramNeedMB: c.workflowVramNeedMB,
      ollama: { reachable: loaded !== null, loaded: (loaded || []).map((m) => ({ name: m.name, size: m.size, size_vram: m.size_vram, badge: offloadBadge(m) })) },
      models, warnings,
    };
  }

  let lastWorkflow = null;
  // ---- batch 3 memory settings (data/memory-settings.json): two switches in the menu ----
  const settingsFile = path.join(cfg.dataDir, 'memory-settings.json');
  const SETTINGS_DEFAULT = { textEncoderCpu: false, ollamaCpu: false };
  function getSettings() {
    try { const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); return { textEncoderCpu: s.textEncoderCpu === true, ollamaCpu: s.ollamaCpu === true }; } catch { return { ...SETTINGS_DEFAULT }; }
  }
  function setSettings(patch = {}) {
    const next = getSettings();
    for (const k of Object.keys(SETTINGS_DEFAULT)) if (typeof patch[k] === 'boolean') next[k] = patch[k];
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.writeFileSync(settingsFile + '.tmp', JSON.stringify(next, null, 1));
    fs.renameSync(settingsFile + '.tmp', settingsFile);
    return next;
  }
  /** Ollama options for a chat request: CPU mode = no layers on the GPU (num_gpu 0). */
  const chatOptions = () => (getSettings().ollamaCpu ? { num_gpu: 0 } : {});

  async function profileId() { try { return (await active()).sel.profile.id; } catch { return undefined; } }

  async function beforeQueue(workflowId = 'default', { estMB, heavy = false } = {}) {
    const { c, hw, sel } = await active({ fresh: true });
    const loaded = await ps();
    const needMB = workflowNeedMB(c, workflowId, estMB);
    const d = decideBeforeQueue({ profile: sel.profile, freeMB: hw.gpu?.freeMB, ollamaModels: loaded || [], needMB, headroomMB: c.headroomMB, heavy });
    const out = { profile: sel.profile.id, workflow: workflowId, freeMB: hw.gpu?.freeMB ?? null, needMB, heavy, loaded: (loaded || []).map((m) => m.name), ...d };
    if (d.unload) out.result = await ollama.unloadAll();
    const freedMB = d.unload ? Math.round((loaded || []).reduce((a, m) => a + (m.size_vram || 0), 0) / 1048576) : 0;
    const f = decideFreeBeforeQueue({ profile: sel.profile, freeMB: hw.gpu?.freeMB, ollamaFreedMB: freedMB, needMB, headroomMB: c.headroomMB, lastWorkflow, workflow: workflowId });
    out.comfyFree = f;
    if (f.freeComfy) out.comfyFree.result = await comfyFree(sel.profile.comfyFree);
    lastWorkflow = workflowId;
    return out;
  }

  async function beforeChat(model) {
    const { c, hw, sel } = await active({ fresh: true });
    const loaded = (await ps()) || [];
    const l = loaded.find((x) => x.name === model || x.model === model);
    let size = 0;
    try { size = ((await getJson('/api/tags')).models || []).find((t) => t.name === model)?.size || 0; } catch {}
    const fit = modelFit({ sizeBytes: size, loadedVramBytes: l?.size_vram || 0, freeVramMB: hw.gpu?.freeMB, totalVramMB: hw.gpu?.totalMB, freeRamMB: hw.ram.freeMB, profile: sel.profile, config: c });
    const cpu = getSettings().ollamaCpu;
    // CPU mode: the model lives in RAM only, so VRAM fit does not matter.
    const out = { profile: sel.profile.id, model, keepAlive: sel.profile.ollamaKeepAlive, freeMB: hw.gpu?.freeMB ?? null, ...fit, ok: cpu || (!l ? !['no-fit', 'too-big'].includes(fit.fit) : true), chatOptions: chatOptions() };
    if (cpu) return { ...out, reason: 'Ollama CPU mode: chat runs in RAM' };
    if (!out.ok) return out;
    const d = decideBeforeChat({ profile: sel.profile, freeMB: hw.gpu?.freeMB, estMB: fit.estMB, modelLoaded: !!l, headroomMB: c.headroomMB });
    out.reason = d.reason;
    if (d.freeComfy) out.freed = await comfyFree(sel.profile.comfyFree);
    return out;
  }

  async function comfyFree(body) {
    try {
      const r = await fetch(getComfyUrl() + '/free', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
      return { ok: r.ok, body };
    } catch (e) { return { ok: false, body, error: e.message }; }
  }
  async function freeForChat() {
    const { sel } = await active();
    return comfyFree(sel.profile.comfyFree);
  }
  return { status, beforeQueue, beforeChat, freeForChat, config, getSettings, setSettings, chatOptions, profileId };
}
