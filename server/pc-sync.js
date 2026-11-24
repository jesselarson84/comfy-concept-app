// pc-sync.js - batch 12: what you run in desktop ComfyUI shows up in the app.
// -----------------------------------------------------------------------------
// The app used to know only the jobs it queued itself. This watches ComfyUI's
// own /history and /queue (every client: the desktop ComfyUI page, the app, the
// scheduler) and:
//   - records every finished job the app does not know yet as a History entry
//     ("desktop:<model>", project Unsorted), including earlier runs ComfyUI still
//     remembers (ComfyUI keeps its history in memory, so: since it last started);
//   - keeps each recorded job's workflow (data/pc-graphs/<promptId>.json: the API
//     graph the app can run + ComfyUI's own UI workflow), so the phone can open
//     and keep editing the exact workflow later;
//   - tells the app what the PC is running right now (the "PC is running" card).
// A job is recorded ~20 s after it finished, so a job the app queued itself has
// long had its own entry by then. Jobs whose files were deleted (all outputs
// gone from disk) and jobs that saved nothing (previews only) are skipped and
// remembered in data/pc-sync.json, so they are never looked at again.
// -----------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { splitOutputs } from '../app/js/lib/outputs.js';

const GRACE_MS = 20000;
const TEXT_KEYS = ['text', 'prompt', 'text_g', 'positive_prompt'];

/** prompt / negative / model / seed / size / steps read from an API-format graph. */
export function describeGraph(graph) {
  const nodes = graph && typeof graph === 'object' ? graph : {};
  const textOf = (link) => {
    const n = Array.isArray(link) ? nodes[link[0]] : null;
    if (!n || /ZeroOut/i.test(n.class_type || '')) return ''; // a zeroed-out conditioning is "no negative"
    for (const k of TEXT_KEYS) if (typeof n.inputs?.[k] === 'string') return n.inputs[k];
    // a conditioning node in between (e.g. ConditioningZeroOut, FluxGuidance): follow it
    for (const v of Object.values(n.inputs || {})) if (Array.isArray(v)) { const t = textOf(v); if (t) return t; }
    return '';
  };
  const d = { prompt: '', negative: '', model: '', seed: undefined, width: undefined, height: undefined, steps: undefined };
  for (const n of Object.values(nodes)) {
    const inp = n?.inputs || {};
    if (!d.model) for (const k of ['ckpt_name', 'unet_name', 'model_name', 'checkpoint']) if (typeof inp[k] === 'string') { d.model = inp[k]; break; }
    if (d.seed === undefined) for (const k of ['seed', 'noise_seed']) if (typeof inp[k] === 'number') { d.seed = inp[k]; break; }
    if (d.steps === undefined && typeof inp.steps === 'number') d.steps = inp.steps;
    if (d.width === undefined && typeof inp.width === 'number' && typeof inp.height === 'number') { d.width = inp.width; d.height = inp.height; }
    if (!d.prompt && Array.isArray(inp.positive)) d.prompt = textOf(inp.positive);
    if (!d.negative && Array.isArray(inp.negative)) d.negative = textOf(inp.negative);
  }
  if (d.negative && d.negative === d.prompt) d.negative = '';
  if (!d.prompt) { // no sampler with positive/negative: the longest text in the graph
    for (const n of Object.values(nodes)) for (const k of TEXT_KEYS) { const t = n?.inputs?.[k]; if (typeof t === 'string' && t.length > d.prompt.length) d.prompt = t; }
  }
  return d;
}

/** "z_image_turbo_bf16.safetensors" -> "z_image_turbo_bf16" (the History "model"). */
export const modelKey = (m) => String(m || 'workflow').split(/[\\/]/).pop().replace(/\.(safetensors|ckpt|gguf|pt|pth|bin)$/i, '') || 'workflow';

const msgTime = (h, name) => (h?.status?.messages || []).find((m) => m?.[0] === name)?.[1]?.timestamp;

export function createPcSync({ history, dataDir, getComfyUrl, outputDirOf = async () => null, fetchImpl = fetch, log = () => {}, now = Date.now, isScheduled = () => false, onRecorded = () => {} } = {}) {
  const file = path.join(dataDir, 'pc-sync.json');
  const graphDir = path.join(dataDir, 'pc-graphs');
  let state = { imported: false, skip: [] };
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); if (d && Array.isArray(d.skip)) state = { imported: !!d.imported, skip: d.skip }; } catch {}
  const skip = new Set(state.skip);
  const save = () => { try { fs.writeFileSync(file, JSON.stringify({ imported: state.imported, skip: [...skip].slice(-20000) })); } catch {} };
  const seenRunning = new Map(); // promptId -> first time seen running (for "running for 3 min")
  let busy = false;

  const known = () => new Set(history.data.entries.map((e) => e.promptId).filter(Boolean));
  const get = async (p) => { const r = await fetchImpl(`${getComfyUrl()}${p}`, { signal: AbortSignal.timeout(8000) }); if (!r.ok) throw new Error(`ComfyUI ${p} answered ${r.status}`); return r.json(); };

  function saveGraph(id, graph, workflow) {
    try { fs.mkdirSync(graphDir, { recursive: true }); fs.writeFileSync(path.join(graphDir, `${id.replace(/[^\w-]/g, '_')}.json`), JSON.stringify({ graph, workflow: workflow || null })); } catch (e) { log(`pc-sync: could not keep the workflow of ${id}: ${e.message}`); }
  }
  function loadGraph(id) { try { return JSON.parse(fs.readFileSync(path.join(graphDir, `${String(id).replace(/[^\w-]/g, '_')}.json`), 'utf8')); } catch { return null; } }

  /** One pass over ComfyUI's /history: record what the app does not know yet. */
  async function tick() {
    if (busy) return { added: 0 };
    busy = true;
    let added = 0;
    try {
      // The first pass reads everything ComfyUI remembers (earlier desktop runs), later ones the latest 200.
      const all = await get(state.imported ? '/history?max_items=200' : '/history');
      const have = known();
      const outDir = await outputDirOf().catch(() => null);
      const items = Object.entries(all || {}).map(([id, h]) => ({ id, h, at: msgTime(h, 'execution_start') || msgTime(h, 'execution_success') || 0 })).sort((a, b) => a.at - b.at);
      for (const { id, h, at } of items) {
        if (have.has(id) || skip.has(id) || isScheduled(id)) continue;
        const status = h?.status || {};
        if (status.status_str === 'error') { skip.add(id); continue; }
        if (!status.completed) continue; // still going (or unknown): look again later
        const doneAt = msgTime(h, 'execution_success') || at;
        if (doneAt && now() - doneAt < GRACE_MS) continue; // give the app time to record its own job
        const { images, files } = splitOutputs(h.outputs);
        const keep = (list) => list.filter((f) => (f.type || 'output') === 'output');
        const imgs = keep(images), fls = keep(files);
        if (!imgs.length && !fls.length) { skip.add(id); continue; } // previews only: nothing was saved
        if (outDir) {
          const exists = (f) => fs.existsSync(path.join(outDir, ...String(f.subfolder || '').split('/').filter(Boolean), f.filename));
          if (![...imgs, ...fls].some(exists)) { skip.add(id); continue; } // deleted since (e.g. in the app)
        }
        const graph = Array.isArray(h.prompt) ? h.prompt[2] : null;
        const extra = Array.isArray(h.prompt) ? h.prompt[3] : null;
        const d = describeGraph(graph);
        await history.addExternal({
          promptId: id, workflow: `desktop:${modelKey(d.model)}`, prompt: d.prompt, negative: d.negative || undefined, seed: d.seed,
          width: d.width, height: d.height, steps: d.steps, images: imgs, files: fls, status: 'done', createdAt: at || now(), origin: 'desktop',
        });
        if (graph) saveGraph(id, graph, extra?.extra_pnginfo?.workflow);
        added++;
      }
      if (!state.imported) { state.imported = true; log(`pc-sync: imported ${added} earlier ComfyUI run(s)`); }
      save();
      if (added) onRecorded(added);
    } catch (e) {
      log(`pc-sync: ${e.message}`);
    } finally { busy = false; }
    return { added };
  }

  /**
   * Live progress of a running job from the app's ComfyUI add-on (GET /concept/progress,
   * comfyui/ComfyUI-AIWorkflowMenu): ComfyUI itself only tells the window that queued it.
   * { value, max, fraction, node, nodesDone, nodesTotal } or null (add-on not installed /
   * ComfyUI not restarted since: the card then shows the time only).
   */
  async function progressOf(id, graph) {
    let p;
    try { const r = await fetchImpl(`${getComfyUrl()}/concept/progress`, { signal: AbortSignal.timeout(3000) }); if (!r.ok) return null; p = await r.json(); } catch { return null; }
    if (!p || p.prompt_id !== id) return null;
    const nodesTotal = Math.max(1, Object.keys(graph || {}).length - (p.cached || 0));
    const nodesDone = Math.min(nodesTotal, p.nodes_done || 0);
    const step = p.max > 0 ? Math.min(1, (p.value || 0) / p.max) : null;
    return { value: p.value || 0, max: p.max || 0, node: p.node || null, nodesDone, nodesTotal, fraction: step ?? nodesDone / nodesTotal };
  }

  /** What the PC is running now, unless the app queued it itself (it shows that one already). */
  async function now_() {
    let q;
    try { q = await get('/queue'); } catch (e) { return { reachable: false, running: null, pending: 0 }; }
    const run = (q.queue_running || [])[0];
    const pending = (q.queue_pending || []).length;
    if (!run) { seenRunning.clear(); return { reachable: true, running: null, pending }; }
    const [, id, graph, extra] = run;
    if (!seenRunning.has(id)) seenRunning.set(id, now());
    const have = known();
    const scheduled = isScheduled(id);
    const mine = have.has(id) && !scheduled; // a batch job is shown on the card too
    const d = describeGraph(graph);
    return {
      reachable: true, pending,
      running: { promptId: id, app: mine, scheduled, label: modelKey(d.model), prompt: d.prompt.slice(0, 200), since: seenRunning.get(id), client: extra?.client_id || null, progress: await progressOf(id, graph) },
    };
  }

  /** The workflow of a job (running, still in ComfyUI's memory, or kept on disk) for "Open here" / Reuse. */
  async function job(id) {
    let graph = null, workflow = null;
    try {
      const q = await get('/queue');
      const hit = [...(q.queue_running || []), ...(q.queue_pending || [])].find((x) => x[1] === id);
      if (hit) { graph = hit[2]; workflow = hit[3]?.extra_pnginfo?.workflow || null; }
    } catch { /* ComfyUI offline: the kept copy below */ }
    if (!graph) {
      try { const h = (await get(`/history/${encodeURIComponent(id)}`))[id]; if (h && Array.isArray(h.prompt)) { graph = h.prompt[2]; workflow = h.prompt[3]?.extra_pnginfo?.workflow || null; } } catch {}
    }
    if (!graph) { const kept = loadGraph(id); if (kept) ({ graph, workflow } = kept); }
    if (!graph) return null;
    const d = describeGraph(graph);
    return { promptId: id, graph, workflow, label: modelKey(d.model), meta: d };
  }

  return { tick, now: now_, job, loadGraph, forget(ids) { for (const id of ids) if (id) skip.add(id); save(); } };
}
