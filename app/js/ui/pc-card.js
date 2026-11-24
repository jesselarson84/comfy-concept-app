// pc-card.js - batch 12: "PC is running …" at the top of the form.
// When desktop ComfyUI (or anything that is not this app's own run) is busy, a
// card shows what it runs, its live percentage (from the app's ComfyUI add-on; else
// how long it has been running), with "Open here": that job's
// workflow is loaded into the form (and its result followed in This session).
// It never replaces the form by itself. Polls the server every 8 s while the
// app is in front.
import { h } from './dom.js';
import * as api from '../api.js';

const mins = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return m < 1 ? 'just started' : m === 1 ? '1 min' : `${m} min`; };

export class PcCard {
  /** onOpen(promptId) loads the job into the form; onProgress(promptId, fraction) for a followed job. */
  constructor(host, { onOpen, onProgress = () => {} }) {
    this.host = host; this.onOpen = onOpen; this.onProgress = onProgress;
    this.label = h('span.pc-label');
    this.sub = h('span.pc-sub');
    this.bar = h('i');
    this.track = h('span.pc-bar', { hidden: true }, this.bar);
    this.btn = h('button.btn.primary.pc-open', { type: 'button', dataset: { act: 'open-pc' }, onclick: () => this.open() }, 'Open here');
    host.replaceChildren(h('span.pc-spin', { 'aria-hidden': 'true' }), h('span.pc-text', {}, this.label, this.sub, this.track), this.btn);
    host.hidden = true;
    this.poll();
    // Batch 12: every 3 s while the PC is busy (live percentage), else every 8 s.
    this.timer = setInterval(() => { if (!document.hidden && (this.job || Date.now() - (this.last || 0) > 8000)) this.poll(); }, 3000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.poll(); });
  }

  async poll() {
    this.last = Date.now();
    let r;
    try { r = await api.getPcNow(); } catch { r = null; }
    const run = r?.running;
    this.job = run && !run.app ? run : null;
    this.host.hidden = !this.job;
    if (!this.job) return;
    const p = this.job.progress; // from the app's ComfyUI add-on (null: not installed / ComfyUI not restarted)
    const pct = p ? Math.round(p.fraction * 100) : null;
    this.label.textContent = `${this.job.scheduled ? 'Batch job running' : 'PC is running'} · ${this.job.label}${pct !== null ? ` · ${pct}%` : ''}`;
    const where = p ? (p.max > 0 ? `step ${p.value} of ${p.max}` : `node ${Math.min(p.nodesDone + 1, p.nodesTotal)} of ${p.nodesTotal}`) : '';
    this.sub.textContent = [where, this.job.prompt ? `“${this.job.prompt.slice(0, 60)}${this.job.prompt.length > 60 ? '…' : ''}”` : '', mins(Date.now() - (this.job.since || Date.now())), r.pending ? `${r.pending} waiting` : ''].filter(Boolean).join(' · ');
    this.track.hidden = pct === null;
    if (pct !== null) { this.bar.style.width = `${pct}%`; this.onProgress(this.job.promptId, p.fraction); }
  }

  async open() {
    if (!this.job) return;
    this.btn.disabled = true;
    try { await this.onOpen(this.job.promptId); } finally { this.btn.disabled = false; }
  }
}
