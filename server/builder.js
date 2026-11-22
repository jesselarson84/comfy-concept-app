// builder.js (server) - the chat's guarded setup builder.
//   propose({ text, history, model })  ask Ollama (format = block schema) -> validated result
//   check({ blocks, name, test })      re-check + assemble + validate (Save / Test run)
//   config / setModel                  builder model (data/builder.json overrides config.json)
// The model only ever proposes blocks; the graph is assembled and validated here
// (app/js/lib/builder.js) against ComfyUI's live /object_info + model lists.
import fs from 'node:fs';
import path from 'node:path';
import { buildSetup, builderSchema, builderSystemPrompt, FAMILIES, testRunGraph } from '../app/js/lib/builder.js';
import { vramFit } from '../app/js/lib/presets.js';
import { stripPraise, proposalTense, firstJsonObject } from '../app/js/lib/chat-reply.js';

export const DEFAULT_BUILDER_MODEL = 'gemma3:4b';

export function createBuilder({ cfg, comfyInfo, presets, memory, hardware, fetchImpl = fetch }) {
  const file = path.join(cfg.dataDir, 'builder.json');
  const model = () => { try { const m = JSON.parse(fs.readFileSync(file, 'utf8')).model; if (m) return String(m); } catch {} return cfg.builderModel || DEFAULT_BUILDER_MODEL; };
  function setModel(m) {
    const v = String(m || '').trim();
    if (!/^[\w.:\-/]{1,80}$/.test(v)) throw Object.assign(new Error('Bad model name'), { status: 400 });
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify({ model: v }, null, 2)); fs.renameSync(file + '.tmp', file);
    return config();
  }
  const config = () => ({ model: model(), default: cfg.builderModel || DEFAULT_BUILDER_MODEL });

  async function context() {
    const info = presets.withFs(await comfyInfo.get());
    const hw = await hardware.detect();
    const mem = memory ? await memory.status().catch(() => null) : null;
    return { info, hw, profileId: mem?.profile?.id, desktopReserveMB: mem?.desktopReserveMB };
  }

  /** Re-check blocks against live ComfyUI. Adds VRAM fit + TTS file checks. */
  async function check({ blocks, name, test = false }) {
    const { info, hw, profileId } = await context();
    if (!info.objectInfo) return { ok: false, stage: 'comfy', errors: ['ComfyUI is not reachable, so the setup cannot be checked.'], notes: [], blocks: [] };
    const r = buildSetup(blocks, { objectInfo: info.objectInfo, prefix: `${cfg.outputSubfolder || 'concept-app'}/builder_${slug(name)}` });
    r.name = String(name || '').slice(0, 60) || 'My setup';
    if (!r.ok) return r;
    // TTS engines: the model files must be on disk (VibeVoice/Chatterbox would otherwise auto-download).
    const audio = r.blocks.find((b) => b.type === 'audio');
    if (audio) {
      const p = presets.get(`tts-${audio.params.engine}`);
      const a = p && presets.list(info, { gpuTotalMB: hw.gpu?.totalMB, ramFreeMB: hw.ram?.freeMB }, { profileId }).find((x) => x.id === `ai:${p.id}`)?.availability;
      if (!p || a?.status === 'unavailable') return { ...r, ok: false, stage: 'models', errors: [`${audio.params.engine}: ${a?.reason || 'preset missing'}`] };
    }
    const fit = vramFit({ estMB: r.estMB, gpuTotalMB: hw.gpu?.totalMB, ramFreeMB: hw.ram?.freeMB, profileId });
    r.vram = fit;
    if (fit.status === 'unavailable') return { ...r, ok: false, stage: 'memory', errors: [`Not enough memory: ${fit.reason}.`] };
    if (test) { const t = testRunGraph(r.graph); r.graph = t.graph; r.notes = [...r.notes, ...t.notes]; r.test = true; }
    return r;
  }

  /** Ask the builder model for blocks, then validate. Never queues anything. */
  async function propose({ text, history = [], model: m }) {
    const useModel = String(m || model());
    const { info, hw, profileId } = await context();
    if (!info.objectInfo) return { ok: false, stage: 'comfy', errors: ['ComfyUI is not reachable, so I cannot check what is installed.'], reply: '' };
    if (memory) { const bc = await memory.beforeChat(useModel).catch(() => null); if (bc && bc.ok === false) return { ok: false, stage: 'model', errors: [`Builder model ${useModel}: ${bc.reason || bc.note || 'does not fit in memory right now'}`], reply: '' }; }
    const familyStatus = {};
    for (const [id, f] of Object.entries(FAMILIES)) { const v = vramFit({ estMB: f.estMB, gpuTotalMB: hw.gpu?.totalMB, ramFreeMB: hw.ram?.freeMB, profileId }); if (v.label) familyStatus[id] = v.label; }
    const messages = [
      { role: 'system', content: builderSystemPrompt({ objectInfo: info.objectInfo, familyStatus }) },
      ...history.slice(-6).filter((x) => x && ['user', 'assistant'].includes(x.role) && typeof x.content === 'string').map((x) => ({ role: x.role, content: x.content.slice(0, 2000) })),
      { role: 'user', content: String(text || '').slice(0, 2000) },
    ];
    let raw;
    try {
      const r = await fetchImpl(cfg.ollamaUrl + '/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: useModel, stream: false, format: builderSchema(), messages, options: { temperature: 0.2 } }),
        signal: AbortSignal.timeout(180000),
      });
      if (!r.ok) throw new Error(`Ollama HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      raw = (await r.json()).message?.content || '';
    } catch (e) { return { ok: false, stage: 'model', errors: [`The builder model did not answer: ${e.message}`], reply: '' }; }
    let obj = null;
    try { obj = JSON.parse(raw); } catch { const s = firstJsonObject(raw); try { obj = s ? JSON.parse(s) : null; } catch { obj = null; } }
    if (!obj || !Array.isArray(obj.blocks)) return { ok: false, stage: 'model', errors: ['The builder model did not return a block list.'], reply: '', raw: raw.slice(0, 500) };
    const result = await check({ blocks: obj.blocks, name: obj.name });
    const reply = proposalTense(stripPraise(String(obj.reply || '')), { cta: 'Nothing has run yet.' });
    return { ...result, reply, proposed: obj.blocks, model: useModel };
  }

  return { propose, check, config, setModel };
}

export const slug = (s) => (String(s || 'setup').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'setup');
