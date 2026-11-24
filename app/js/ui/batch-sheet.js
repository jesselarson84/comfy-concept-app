// batch-sheet.js - batch 12: the batch the PC runs later (server/scheduler.js).
// "Save to batch" (next to Run) adds the form's job(s); this sheet lists them in
// order (move up / down, remove), and starts the batch now or at a clock time.
// Jobs run one after another on the PC, each after the previous finished and only
// while the PC is free; a failed job is skipped. The phone can sleep meanwhile.
import { h, toast } from './dom.js';
import * as api from '../api.js';

const timeOf = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const STATUS = { waiting: '', running: 'Running…', done: '✓ Done', failed: 'Skipped' };

/** "23:30" -> the next time it is 23:30 (today, else tomorrow), in ms. */
export function nextClockTime(hhmm, now = new Date()) {
  const [hh, mm] = String(hhmm || '').split(':').map(Number);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  const t = new Date(now); t.setHours(hh, mm, 0, 0);
  if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
  return t.getTime();
}

export class BatchSheet {
  constructor({ button, badge }) {
    this.button = button; this.badge = badge;
    button.addEventListener('click', () => this.open());
    this.refresh();
    setInterval(() => { if (!document.hidden) this.refresh(); }, 15000);
  }

  /** Repaint the button's count (waiting + running jobs). */
  async refresh() {
    try { this.data = await api.getSchedule(); } catch { return; }
    const n = this.data.jobs.filter((j) => j.status === 'waiting' || j.status === 'running').length;
    this.badge.textContent = n ? String(n) : '';
    this.button.classList.toggle('has-jobs', n > 0);
    this.button.classList.toggle('is-running', this.data.state === 'running');
    if (this.el) this.paint();
  }

  async add(jobs) {
    try { this.data = await api.addToSchedule(jobs); } catch (e) { toast(e.message, 6000); return false; }
    await this.refresh();
    const n = this.data.jobs.filter((j) => j.status === 'waiting').length;
    toast(`Saved to batch (${n} waiting)`);
    return true;
  }

  open() {
    this.close();
    this.scrim = h('div.sheet-scrim', { onclick: () => this.close() });
    this.body = h('div.bs-body');
    this.el = h('div.sheet.batch-sheet', { role: 'dialog', 'aria-label': 'Batch' },
      h('div.sheet-title.pj-title', {}, h('span', {}, 'Batch'), h('span.spacer'), h('button.btn.icon', { type: 'button', 'aria-label': 'Close', onclick: () => this.close() }, h('i.i.i-x'))), this.body);
    document.body.append(this.scrim, this.el);
    this.paint();
    this.refresh();
  }

  close() { this.scrim?.remove(); this.el?.remove(); this.scrim = this.el = null; }

  async act(fn) { try { this.data = await fn(); } catch (e) { toast(e.message, 6000); } await this.refresh(); }

  paint() {
    const d = this.data;
    if (!d) { this.body.replaceChildren(h('p.muted', {}, 'Loading…')); return; }
    const waiting = d.jobs.filter((j) => j.status === 'waiting');
    // One row per "Save to batch" (its Batch count of jobs share a group), in order.
    const rowsData = [];
    for (const j of d.jobs) {
      const last = rowsData.at(-1);
      if (last && j.group && last.group === j.group && last.status === j.status) last.jobs.push(j);
      else rowsData.push({ group: j.group, status: j.status, jobs: [j] });
    }
    const waitingRows = rowsData.filter((r) => r.status === 'waiting');
    const rows = rowsData.map((row) => {
      const j = row.jobs[0];
      const wi = waitingRows.indexOf(row);
      const move = (dir) => {
        const order = [...waitingRows]; const k = wi + dir; [order[wi], order[k]] = [order[k], order[wi]];
        this.act(() => api.orderSchedule(order.flatMap((r) => r.jobs.map((x) => x.id))));
      };
      const remove = async () => { for (const x of row.jobs) { try { this.data = await api.removeScheduled(x.id); } catch (e) { toast(e.message, 6000); break; } } await this.refresh(); };
      const errors = [...new Set(row.jobs.map((x) => x.error).filter(Boolean))];
      return h(`div.bs-row.${row.status}`, { dataset: { job: j.id } },
        h('span.bs-n', {}, wi >= 0 ? String(wi + 1) : ''),
        h('span.bs-t', {}, h('span.bs-label', {}, `${j.label}${row.jobs.length > 1 ? ` × ${row.jobs.length}` : ''}`), h('span.bs-sub', {}, [j.meta?.prompt ? `“${String(j.meta.prompt).slice(0, 60)}”` : '', STATUS[row.status], ...errors].filter(Boolean).join(' · '))),
        row.status === 'waiting' ? h('span.bs-acts', {},
          h('button.btn.icon', { type: 'button', 'aria-label': 'Move up', disabled: wi === 0, onclick: () => move(-1) }, h('i.i.i-chevron-up')),
          h('button.btn.icon', { type: 'button', 'aria-label': 'Move down', disabled: wi === waitingRows.length - 1, onclick: () => move(1) }, h('i.i.i-chevron-down')),
          h('button.btn.icon', { type: 'button', 'aria-label': 'Remove', onclick: remove }, h('i.i.i-trash-2'))) : h('span'));
    });
    const time = h('input.sheet-input.bs-time', { type: 'time', value: localStorage.getItem('batchTime') || '23:30', 'aria-label': 'Start time' });
    const state = d.state === 'running' ? `Running · ${waiting.length} still waiting`
      : d.state === 'scheduled' ? `Starts at ${timeOf(d.start.at)}`
        : d.state === 'waiting' ? `Waiting for the PC to be free${d.waitReason ? ` (${d.waitReason})` : ''}` : '';
    const started = d.state !== 'idle';
    this.body.replaceChildren(...[
      rows.length ? h('div.bs-list', {}, ...rows) : h('p.muted.bs-empty', {}, 'Nothing saved yet. Set up a job on the form and tap "Save to batch".'),
      state ? h('div.bs-state', {}, h('span.pc-spin'), state) : null,
      waiting.length && !started ? h('div.bs-start', {},
        h('button.btn.primary', { type: 'button', dataset: { act: 'start-now' }, onclick: () => this.act(() => api.startSchedule(null)) }, h('i.i.i-play'), 'Start now'),
        h('span.muted', {}, 'or at'), time,
        h('button.btn', { type: 'button', dataset: { act: 'start-at' }, onclick: () => { const at = nextClockTime(time.value); if (!at) return toast('Pick a time'); localStorage.setItem('batchTime', time.value); this.act(() => api.startSchedule(at)).then(() => toast(`Batch starts at ${timeOf(at)}`)); } }, 'Start then')) : null,
      started ? h('div.bs-start', {}, h('button.btn', { type: 'button', dataset: { act: 'stop' }, onclick: () => this.act(() => api.stopSchedule()) }, 'Stop', d.state === 'running' ? ' (after this job)' : '')) : null,
      d.jobs.some((j) => j.status === 'done' || j.status === 'failed') ? h('button.link.bs-clear', { type: 'button', onclick: () => this.act(() => api.clearSchedule()) }, 'Clear finished') : null,
      h('p.muted.pj-note', {}, 'The PC runs the jobs one after another, each after the previous one finished, and waits while it is busy (a game, or other ComfyUI jobs). A job that fails is skipped. Random seeds are picked when a job runs.'),
    ].filter(Boolean));
  }
}
