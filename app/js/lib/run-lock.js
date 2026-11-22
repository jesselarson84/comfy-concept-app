// run-lock.js - one run at a time (batch 3).
// -----------------------------------------------------------------------------
// After Run is tapped it stays disabled until every job of that run has
// finished, failed or been cancelled. Cancel stays active the whole time.
// While locked the preset can't be switched and nothing else is queued (chat
// Generate, workflow actions, builder test runs); several pictures go through
// Batch instead. `starting` covers the moment between the tap and the jobs
// reaching the queue (the memory step and the POSTs), so a double tap can't
// queue twice. Pure logic, shared by main.js, the Android notification and the
// unit tests.
// -----------------------------------------------------------------------------
export const ACTIVE = ['submitting', 'queued', 'running'];
export const FINISHED = ['done', 'error', 'cancelled'];

export class RunLock {
  constructor() { this.starting = false; this.abort = false; this.run = []; }
  /** true while a run is being started or any of its jobs is still active. */
  locked(items = this.run) { return this.starting || items.some((i) => ACTIVE.includes(i.status)); }
  /** Begin a run; returns false (do nothing) if one is already going. */
  begin() {
    if (this.locked()) return false;
    this.starting = true; this.abort = false; this.run = [];
    return true;
  }
  /** The jobs of the run reached the queue (or failed to). */
  started(items = []) { this.starting = false; this.run = items; }
  /** Cancel tapped: also stops a run that hasn't reached the queue yet. */
  cancel() { if (this.starting) this.abort = true; }
}

/** "Running N of M" for the run: N = the job being worked on now (1-based). */
export function runProgress(items = []) {
  const total = items.length;
  const finished = items.filter((i) => FINISHED.includes(i.status)).length;
  const active = items.filter((i) => ACTIVE.includes(i.status)).length;
  const done = items.filter((i) => i.status === 'done').length;
  return { total, finished, done, active, current: Math.min(total, finished + 1), running: active > 0 };
}
