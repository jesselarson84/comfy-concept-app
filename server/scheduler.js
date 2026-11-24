// scheduler.js - batch 12: a batch of jobs that runs later, one after another.
// -----------------------------------------------------------------------------
// The app's "Save to batch" adds jobs exactly as Run would queue them (the app
// builds the graph), and the batch is started now or at a clock time. The PC
// runs it, so the phone can sleep or be off:
//   - one job at a time: the next starts only after the previous one finished;
//   - it waits until the PC is free: nothing in ComfyUI's queue (desktop or app
//     jobs) and the GPU not busy (a game) - checked before every job;
//   - a job that fails is skipped and the rest carry on;
//   - "random seed" jobs get a new seed when they run; locked seeds stay;
//   - each job lands in History (its project from when it was saved) and is
//     filed on Drive like any other run.
// data/schedule.json: { start: null | { at }, jobs: [{ id, label, graph, meta,
//   seeds: [{node, input}], randomSeed, status, promptId, historyId, error }] }
//   status: waiting | running | done | failed
// -----------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { splitOutputs } from '../app/js/lib/outputs.js';

const MAX_SEED = 2 ** 50;
const err = (status, message) => Object.assign(new Error(message), { status });

export function createScheduler({ dataDir, history, getComfyUrl, gpuUtil = async () => null, busyPercent = 30, beforeQueue = async () => {}, fetchImpl = fetch, now = Date.now, log = () => {}, onFinished = () => {}, clientId = 'concept-scheduler' } = {}) {
  const file = path.join(dataDir, 'schedule.json');
  let data = { start: null, jobs: [] };
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); if (d && Array.isArray(d.jobs)) data = { start: d.start || null, jobs: d.jobs }; } catch {}
  let timer = null, busy = false, waitReason = '';
  const save = () => { try { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(data)); fs.renameSync(tmp, file); } catch (e) { log(`scheduler: could not save: ${e.message}`); } };
  const comfy = async (p, opts = {}) => { const r = await fetchImpl(`${getComfyUrl()}${p}`, { signal: AbortSignal.timeout(10000), ...opts }); const j = await r.json().catch(() => ({})); if (!r.ok) throw err(r.status, j?.error?.message || j?.error || `ComfyUI ${p} answered ${r.status}`); return j; };
  const running = () => data.jobs.find((j) => j.status === 'running');
  const waiting = () => data.jobs.filter((j) => j.status === 'waiting');

  function view() {
    const state = !data.start ? 'idle' : running() ? 'running' : !waiting().length ? 'idle' : data.start.at > now() ? 'scheduled' : 'waiting';
    return {
      start: data.start, state, waitReason: state === 'waiting' ? waitReason : '',
      jobs: data.jobs.map(({ graph, seeds, ...j }) => j),
    };
  }

  /** jobs: [{ graph, meta, seeds, randomSeed, label }] built by the app exactly like Run. */
  function add(jobs) {
    if (!Array.isArray(jobs) || !jobs.length) throw err(400, 'Nothing to add');
    for (const j of jobs) {
      if (!j?.graph || typeof j.graph !== 'object' || Array.isArray(j.graph)) throw err(400, 'Bad job');
      data.jobs.push({
        id: 'b_' + crypto.randomUUID().slice(0, 8), label: String(j.label || j.meta?.workflow || 'Job').slice(0, 120), graph: j.graph,
        meta: j.meta && typeof j.meta === 'object' ? j.meta : {}, seeds: Array.isArray(j.seeds) ? j.seeds.filter((s) => s && typeof s.node === 'string' && typeof s.input === 'string') : [],
        randomSeed: !!j.randomSeed, status: 'waiting', addedAt: now(),
        group: typeof j.group === 'string' && j.group ? j.group.slice(0, 40) : undefined, // the jobs of one "Save to batch" (Batch 4 = 4 jobs)
      });
    }
    save();
    return view();
  }

  function remove(id) {
    const j = data.jobs.find((x) => x.id === id);
    if (!j) throw err(404, 'Not found');
    if (j.status === 'running') throw err(409, 'That job is running; it finishes first');
    data.jobs = data.jobs.filter((x) => x.id !== id);
    if (!waiting().length && !running()) data.start = null;
    save(); return view();
  }

  /** New order for the waiting jobs (ids in order); finished / running ones stay where they are. */
  function order(ids) {
    const want = new Map((Array.isArray(ids) ? ids : []).map((id, i) => [id, i]));
    const w = waiting().sort((a, b) => (want.get(a.id) ?? 1e9) - (want.get(b.id) ?? 1e9));
    data.jobs = [...data.jobs.filter((j) => j.status !== 'waiting'), ...w];
    save(); return view();
  }

  /** at: ms (a clock time) or null = now. */
  function start(at) {
    if (!waiting().length) throw err(400, 'The batch is empty');
    const t = at == null ? now() : Number(at);
    if (!Number.isFinite(t)) throw err(400, 'Bad time');
    data.start = { at: t };
    save(); kick();
    return view();
  }

  /** Stop: nothing new starts (a running job finishes). */
  function stop() { data.start = null; save(); return view(); }

  function clearFinished() { data.jobs = data.jobs.filter((j) => j.status === 'waiting' || j.status === 'running'); save(); return view(); }

  async function pcFree() {
    try {
      const q = await comfy('/queue');
      if ((q.queue_running || []).length || (q.queue_pending || []).length) { waitReason = 'ComfyUI is busy'; return false; }
    } catch { waitReason = 'ComfyUI is not reachable'; return false; }
    const util = await gpuUtil().catch(() => null);
    if (util !== null && util > busyPercent) { waitReason = `the GPU is busy (${util} %)`; return false; }
    waitReason = '';
    return true;
  }

  async function checkRunning(j) {
    let h = null;
    try { h = (await comfy(`/history/${encodeURIComponent(j.promptId)}`))[j.promptId]; } catch { return; }
    if (!h) {
      // not finished: still queued / running? If ComfyUI lost it (restart), it failed.
      try { const q = await comfy('/queue'); if ([...(q.queue_running || []), ...(q.queue_pending || [])].some((x) => x[1] === j.promptId)) return; } catch { return; }
      return finish(j, 'failed', 'ComfyUI lost the job (restarted?)');
    }
    if (h.status?.status_str === 'error') {
      const m = (h.status.messages || []).find((x) => x?.[0] === 'execution_error')?.[1];
      return finish(j, 'failed', m ? `${m.node_type || 'node'}: ${m.exception_message || 'error'}` : 'Failed in ComfyUI');
    }
    if (!h.status?.completed) return;
    const { images, files } = splitOutputs(h.outputs);
    if (!images.length && !files.length) return finish(j, 'failed', 'Finished but saved nothing');
    if (j.historyId) await history.update(j.historyId, { images, files, status: 'done' });
    return finish(j, 'done');
  }

  async function finish(j, status, error) {
    j.status = status; if (error) j.error = error; j.endedAt = now();
    if (status === 'failed' && j.historyId) await history.update(j.historyId, { status: 'error' }).catch(() => {});
    if (status === 'failed') log(`scheduler: skipped "${j.label}": ${error}`);
    if (!waiting().length && !running()) data.start = null; // the batch is done
    save();
    onFinished(j);
  }

  async function launch(j) {
    const graph = JSON.parse(JSON.stringify(j.graph));
    if (j.randomSeed && j.seeds.length) {
      const seed = Math.floor(Math.random() * MAX_SEED);
      for (const t of j.seeds) if (graph[t.node]?.inputs) graph[t.node].inputs[t.input] = seed;
      j.meta = { ...j.meta, seed };
    }
    try { await beforeQueue(j.meta?.workflow || 'default'); } catch { /* memory step is best-effort */ }
    j.status = 'running'; j.startedAt = now(); save();
    let r;
    try { r = await comfy('/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: graph, client_id: clientId }) }); } catch (e) {
      return finish(j, 'failed', `ComfyUI refused it: ${e.message}`);
    }
    if (!r.prompt_id) return finish(j, 'failed', 'ComfyUI did not take the job');
    j.promptId = r.prompt_id;
    const e = await history.add({ ...j.meta, promptId: j.promptId, status: 'queued', origin: 'schedule' });
    j.historyId = e.id;
    save();
  }

  async function tick() {
    if (busy) return view();
    busy = true;
    try {
      const r = running();
      if (r) { if (r.promptId) await checkRunning(r); else await finish(r, 'failed', 'Did not start'); }
      if (!data.start || data.start.at > now() || running()) return view();
      const next = waiting()[0];
      if (!next) { data.start = null; save(); return view(); }
      if (!(await pcFree())) return view();
      await launch(next);
    } catch (e) { log(`scheduler: ${e.message}`); } finally { busy = false; }
    return view();
  }

  function kick() { if (timer) setTimeout(() => tick().catch(() => {}), 50); }

  return {
    view, add, remove, order, start, stop, clearFinished, tick, kick,
    /** Prompt ids the scheduler queued (they are not "desktop" jobs). */
    has: (promptId) => data.jobs.some((j) => j.promptId === promptId),
    start_() { if (!timer) { timer = setInterval(() => tick().catch(() => {}), 10000); kick(); } },
    stopTimer() { clearInterval(timer); timer = null; },
  };
}
