// memory.js - applies the memory profile (app/js/lib/memory-profiles.js) using
// live numbers: detected VRAM/RAM (hardware.js), Ollama's /api/ps and /api/tags.
//
//   status()            hardware + active profile + chat models with a fit note
//   setSetting(id)      the app's override ('auto' | profile id) -> data/memory-profile.json
//   beforeQueue(wf)     unload Ollama or keep it, per profile and free VRAM
//   beforeChat(model)   refuse models that would swap; maybe ComfyUI /free first
//   freeForChat()       the out-of-memory fallback: ComfyUI /free (API call, ComfyUI keeps running)
import fs from 'node:fs';
import path from 'node:path';
import { normalizeMemoryConfig, selectProfile, workflowNeedMB, decideBeforeQueue, decideBeforeChat, modelFit, offloadBadge } from '../app/js/lib/memory-profiles.js';

export function loadMemoryConfig(file) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    const r = normalizeMemoryConfig(undefined);
    r.warnings.push(e.code === 'ENOENT' ? `${path.basename(file)} not found - using built-in defaults` : `${path.basename(file)} is not valid JSON (${e.message}) - using built-in defaults`);
    return r;
  }
  return normalizeMemoryConfig(raw);
}

export function createMemory({ cfg, hardware, ollama, getComfyUrl, env = process.env }) {
  const file = cfg.memoryProfilesFile;
  const settingFile = path.join(cfg.dataDir, 'memory-profile.json');
  let cached = { mtime: -1, value: null };
  const config = () => {
    let m = 0; try { m = fs.statSync(file).mtimeMs; } catch {}
    if (m !== cached.mtime || !cached.value) cached = { mtime: m, value: loadMemoryConfig(file) };
    return cached.value;
  };
  const setting = () => { try { return JSON.parse(fs.readFileSync(settingFile, 'utf8')).profile; } catch { return undefined; } };
  const getJson = async (p, opts = {}) => {
    const r = await fetch(cfg.ollamaUrl + p, { ...opts, signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(`Ollama ${p} ${r.status}`);
    return r.json();
  };
  const ps = async () => { try { return (await getJson('/api/ps')).models || []; } catch { return null; } };

  async function active({ fresh = false } = {}) {
    const { config: c, warnings } = config();
    const hw = await hardware.detect({ fresh });
    const sel = selectProfile(hw.gpu?.totalMB, c, { env: env.MEMORY_PROFILE, setting: setting() });
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
      setting: setting() || 'auto', env: env.MEMORY_PROFILE || null, configProfile: c.profile,
      profiles: c.profiles.map((p) => ({ id: p.id, label: p.label, minVramMB: p.minVramMB })),
      headroomMB: c.headroomMB, workflowVramNeedMB: c.workflowVramNeedMB,
      ollama: { reachable: loaded !== null, loaded: (loaded || []).map((m) => ({ name: m.name, size: m.size, size_vram: m.size_vram, badge: offloadBadge(m) })) },
      models, warnings,
    };
  }

  function setSetting(id) {
    const { config: c } = config();
    if (id !== 'auto' && !c.profiles.some((p) => p.id === id)) throw Object.assign(new Error(`Unknown profile "${id}"`), { status: 400 });
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    const tmp = settingFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ profile: id }, null, 2));
    fs.renameSync(tmp, settingFile);
  }

  async function beforeQueue(workflowId = 'default') {
    const { c, hw, sel } = await active({ fresh: true });
    const loaded = await ps();
    const needMB = workflowNeedMB(c, workflowId);
    const d = decideBeforeQueue({ profile: sel.profile, freeMB: hw.gpu?.freeMB, ollamaModels: loaded || [], needMB, headroomMB: c.headroomMB });
    const out = { profile: sel.profile.id, workflow: workflowId, freeMB: hw.gpu?.freeMB ?? null, needMB, loaded: (loaded || []).map((m) => m.name), ...d };
    if (d.unload) out.result = await ollama.unloadAll();
    return out;
  }

  async function beforeChat(model) {
    const { c, hw, sel } = await active({ fresh: true });
    const loaded = (await ps()) || [];
    const l = loaded.find((x) => x.name === model || x.model === model);
    let size = 0;
    try { size = ((await getJson('/api/tags')).models || []).find((t) => t.name === model)?.size || 0; } catch {}
    const fit = modelFit({ sizeBytes: size, loadedVramBytes: l?.size_vram || 0, freeVramMB: hw.gpu?.freeMB, totalVramMB: hw.gpu?.totalMB, freeRamMB: hw.ram.freeMB, profile: sel.profile, config: c });
    const out = { profile: sel.profile.id, model, keepAlive: sel.profile.ollamaKeepAlive, freeMB: hw.gpu?.freeMB ?? null, ...fit, ok: !l ? !['no-fit', 'too-big'].includes(fit.fit) : true };
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
  return { status, setSetting, beforeQueue, beforeChat, freeForChat, config };
}
