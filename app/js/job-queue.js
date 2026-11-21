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

export class JobQueue extends EventTarget {
  constructor(comfy) {
    super();
    this.comfy = comfy;
    this.items = [];
    this.byPrompt = new Map();
    this.#listen();
  }

  #changed(item) { this.dispatchEvent(new CustomEvent('change', { detail: item })); }

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
      const imgs = e.detail.output?.images || [];
      // A graph may have several Save nodes; the first image is "the" image,
      // the rest are kept in extraImages.
      for (const img of imgs) {
        if (!it.image) it.image = img; else it.extraImages.push(img);
      }
      // Non-image outputs (SaveGLB reports {"3d": [...]}) - e.g. the 3D action.
      for (const f of e.detail.output?.['3d'] || []) it.files.push(f);
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
      const imgs = Object.values(h?.outputs || {}).flatMap((o) => o.images || []);
      if (imgs.length) { it.image = imgs[0]; it.extraImages = imgs.slice(1); }
      if (!it.files.length) it.files = Object.values(h?.outputs || {}).flatMap((o) => o['3d'] || []);
    }
    const ok = it.image || it.files.length;
    it.status = ok ? 'done' : 'error';
    if (!ok) it.error = 'Finished but returned no image (does the graph have a SaveImage node?)';
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

  async resync() {
    for (const it of this.items) {
      if (!['queued', 'running'].includes(it.status) || !it.promptId) continue;
      const h = await this.comfy.history(it.promptId).catch(() => null);
      if (h?.status?.completed || Object.keys(h?.outputs || {}).length) this.#finish(it);
      else if (h?.status?.status_str === 'error') { it.status = 'error'; it.error = 'Failed (see ComfyUI)'; this.#changed(it); }
    }
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
