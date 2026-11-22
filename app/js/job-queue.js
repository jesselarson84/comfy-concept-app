// job-queue.js - a batch of N concept jobs and their live state.
// -----------------------------------------------------------------------------
// "Batch 6" = SIX separate ComfyUI jobs (each with its own seed), not one job
// with batch_size 6. Why: ComfyUI sends `executed` per job, so image 1 can be
// viewed while 2-6 still render; and cancelling drops just the unfinished ones.
//
// Each item: { key, promptId, status, progress, image, meta, historyId, error }
//   status: 'submitting' -> 'queued' -> 'running' -> 'done' | 'error' | 'cancelled'
// The queue fires a 'change' event whenever any item changes; the UI just
// re-renders from `queue.items`.
// -----------------------------------------------------------------------------
import { addHistory, patchHistory } from './api.js';
import { splitOutputs } from './lib/outputs.js';

// The active run is kept in localStorage (batch 3), so if Android drops the page
// while the app is in the background, the results are caught up from /history
// when it comes back.
const RUN_STORE = 'conceptRun.v1';
const ACTIVE = ['submitting', 'queued', 'running'];
/** What is saved per active job: enough to find its result again. */
export function persistable(items) {
  return items.filter((i) => ACTIVE.includes(i.status) && i.promptId)
    .map((i) => ({ key: i.key, promptId: i.promptId, historyId: i.historyId || null, meta: i.meta, run: i.run || null }));
}

export class JobQueue extends EventTarget {
  constructor(comfy) {
    super();
    this.comfy = comfy;
    this.items = [];
    this.byPrompt = new Map();
    this.lastRun = [];
    this.#listen();
  }

  #changed(item) { this.#persist(); this.dispatchEvent(new CustomEvent('change', { detail: item })); }

  #persist() {
    try {
      const keep = persistable(this.items);
      if (keep.length) localStorage.setItem(RUN_STORE, JSON.stringify(keep)); else localStorage.removeItem(RUN_STORE);
    } catch { /* storage full or blocked: catch-up just won't survive a reload */ }
  }

  /** After a reload: bring back the jobs that were still active, then ask /history. */
  restore() {
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem(RUN_STORE)) || []; } catch {}
    const have = new Set(this.items.map((i) => i.promptId));
    const back = saved.filter((x) => x?.promptId && !have.has(x.promptId)).map((x) => ({
      key: x.key || 'r' + Math.random().toString(36).slice(2, 10), promptId: x.promptId, status: 'queued', progress: 0,
      image: null, extraImages: [], files: [], meta: x.meta || {}, historyId: x.historyId, favorite: false, error: null, restored: true,
    }));
    for (const it of back) { this.items.push(it); this.byPrompt.set(it.promptId, it); }
    if (back.length) { this.lastRun = back; this.#changed(); }
    return back;
  }

  #listen() {
    const c = this.comfy;
    const job = (d) => this.byPrompt.get(d?.prompt_id);
    c.addEventListener('execution_start', (e) => { const it = job(e.detail); if (it && it.status === 'queued') { it.status = 'running'; this.#changed(it); } });
    c.addEventListener('progress', (e) => {
      const it = job(e.detail); if (!it) return;
      it.status = 'running';
      it.progress = e.detail.max ? e.detail.value / e.detail.max : 0;
      this.#changed(it);
    });
    c.addEventListener('executed', (e) => {
      const it = job(e.detail); if (!it) return;
      // A graph may have several Save nodes; the first image is "the" image,
      // the rest are kept in extraImages. Non-image outputs (SaveGLB "3d",
      // SaveAudio "audio", SaveVideo animated images) go to files.
      const { images: imgs, files } = splitOutputs({ x: e.detail.output || {} });
      for (const img of imgs) {
        if (img.type === 'temp' && it.image && it.image.type !== 'temp') continue;
        if (!it.image) it.image = img;
        else if (it.image.type === 'temp' && img.type !== 'temp') { it.extraImages.unshift(it.image); it.image = img; } else it.extraImages.push(img);
      }
      for (const f of files) it.files.push(f);
      // A graph that saved a 3D/audio/video file: pass-through previews are not the result.
      if (it.files.length && it.image?.type === 'temp') { it.image = null; it.extraImages = it.extraImages.filter((x) => x.type !== 'temp'); }
      this.#changed(it);
    });
    // `executing` with node === null is the classic "this prompt is finished"
    // signal; execution_success is the newer explicit one. Handle both.
    c.addEventListener('executing', (e) => { if (e.detail && e.detail.node === null) this.#finish(job(e.detail)); });
    c.addEventListener('execution_success', (e) => this.#finish(job(e.detail)));
    c.addEventListener('execution_error', (e) => {
      const it = job(e.detail); if (!it) return;
      it.status = 'error';
      it.error = `${e.detail.node_type || 'node'}: ${e.detail.exception_message || 'error'}`;
      this.#record(it);
      this.#changed(it);
    });
    c.addEventListener('execution_interrupted', (e) => {
      const it = job(e.detail); if (!it || it.status === 'done') return;
      it.status = 'cancelled'; this.#record(it); this.#changed(it);
    });
    // After a reconnect, messages may have been missed: ask /history.
    c.addEventListener('connection', (e) => { if (e.detail.reconnected) this.resync(); });
  }

  async #finish(it) {
    if (!it || it.status === 'done' || it.status === 'error' || it.status === 'cancelled') return;
    if (!it.image) {
      // Cached results or missed `executed`: outputs are in /history.
      const h = await this.comfy.history(it.promptId).catch(() => null);
      const { images: imgs, files } = splitOutputs(h?.outputs);
      if (imgs.length) { it.image = imgs[0]; it.extraImages = imgs.slice(1); }
      if (!it.files.length) it.files = files;
    }
    const ok = it.image || it.files.length;
    it.status = ok ? 'done' : 'error';
    if (!ok) it.error = 'Finished but returned nothing (does the graph have a Save node?)';
    it.progress = 1;
    this.#record(it);
    this.#changed(it);
  }

  async #record(it) {
    // Server history: entry was created at queue time; now attach the result.
    if (!it.historyId) return;
    try {
      await (it.historyReady || Promise.resolve());
      await patchHistory(it.historyId, { images: it.image ? [it.image, ...it.extraImages] : [], files: it.files, status: it.status });
    } catch { /* history is best-effort; the server also resolves via /history later */ }
  }

  /** Catch up on missed websocket messages: finished jobs are read from /history.
   *  A restored job that is neither in /history nor in ComfyUI's queue any more
   *  was lost (ComfyUI restarted): it is marked cancelled so Run unlocks. */
  async resync() {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      let queue = null;
      for (const it of this.items) {
        if (!['queued', 'running'].includes(it.status) || !it.promptId) continue;
        const h = await this.comfy.history(it.promptId).catch(() => null);
        if (h?.status?.completed || Object.keys(h?.outputs || {}).length) await this.#finish(it);
        else if (h?.status?.status_str === 'error') {
          const interrupted = (h.status.messages || []).some((m) => m?.[0] === 'execution_interrupted');
          it.status = interrupted ? 'cancelled' : 'error'; if (!interrupted) it.error = 'Failed (see ComfyUI)';
          this.#record(it); this.#changed(it);
        } else if (!h && it.restored) {
          queue ||= await this.comfy.queueState?.().catch(() => null);
          if (queue && !queue.has(it.promptId)) {
            // not queued: look once more (it may have finished in between)
            const h2 = await this.comfy.history(it.promptId).catch(() => null);
            if (h2?.status?.completed || Object.keys(h2?.outputs || {}).length) await this.#finish(it);
            else { it.status = 'cancelled'; this.#record(it); this.#changed(it); }
          }
        }
      }
    })();
    try { await this.syncing; } finally { this.syncing = null; }
  }

  /**
   * jobs: [{ workflow, meta }] - meta is what goes to history (prompt, seed..).
   * POSTs them one after another so ComfyUI's queue keeps our order.
   */
  async submit(jobs) {
    const created = jobs.map(({ workflow, meta }) => ({
      key: 'j' + Math.random().toString(36).slice(2, 10), promptId: null, status: 'submitting', progress: 0,
      image: null, extraImages: [], files: [], meta, historyId: null, favorite: false, error: null, workflow,
    }));
    this.items.push(...created);
    this.lastRun = created; // set before the first await: main.js locks Run on these
    this.#changed();
    for (const it of created) {
      if (it.status === 'cancelled') continue;
      try {
        const r = await this.comfy.queuePrompt(it.workflow);
        it.promptId = r.prompt_id;
        it.status = it.status === 'submitting' ? 'queued' : it.status;
        this.byPrompt.set(it.promptId, it);
        it.historyReady = addHistory({ ...it.meta, promptId: it.promptId, status: 'queued' })
          .then((e) => { it.historyId = e.id; if (['done', 'error', 'cancelled'].includes(it.status)) this.#record(it); })
          .catch(() => {});
      } catch (err) {
        it.status = 'error'; it.error = err.message;
        // Same graph will fail the same way - don't spam the rest of the batch.
        for (const rest of created) if (rest.status === 'submitting') { rest.status = 'error'; rest.error = err.message; }
        this.#changed(it);
        throw err;
      }
      delete it.workflow; // no need to keep big graphs around
      this.#changed(it);
    }
    return created;
  }

  get active() { return this.items.filter((i) => ['submitting', 'queued', 'running'].includes(i.status)); }

  /** Cancel everything unfinished: delete pending from ComfyUI's queue, interrupt the running one. */
  async cancelAll() {
    const active = this.active;
    for (const it of active) if (it.status === 'submitting') it.status = 'cancelled';
    const queued = active.filter((i) => i.status === 'queued').map((i) => i.promptId);
    const running = active.filter((i) => i.status === 'running');
    await this.comfy.deleteQueued(queued);
    for (const r of running) await this.comfy.interrupt(r.promptId);
    for (const it of active) if (it.status === 'queued') { it.status = 'cancelled'; this.#record(it); }
    this.#changed();
  }

  /** Remove finished/failed items from the strip (images stay in history). */
  clearFinished() {
    this.items = this.items.filter((i) => ['submitting', 'queued', 'running'].includes(i.status));
    this.#changed();
  }
}
