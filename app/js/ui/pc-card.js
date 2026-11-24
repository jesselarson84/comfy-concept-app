// pc-card.js - batch 12: "PC is running …" at the top of the form.
// When desktop ComfyUI (or anything that is not this app's own run) is busy, a
// card shows what it runs and for how long, with "Open here": that job's
// workflow is loaded into the form (and its result followed in This session).
// It never replaces the form by itself. Polls the server every 8 s while the
// app is in front.
import { h } from './dom.js';
import * as api from '../api.js';

const mins = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return m < 1 ? 'just started' : m === 1 ? '1 min' : `${m} min`; };

export class PcCard {
  /** onOpen(promptId) loads the job into the form. */
  constructor(host, { onOpen }) {
    this.host = host; this.onOpen = onOpen;
    this.label = h('span.pc-label');
    this.sub = h('span.pc-sub');
    this.btn = h('button.btn.primary.pc-open', { type: 'button', dataset: { act: 'open-pc' }, onclick: () => this.open() }, 'Open here');
    host.replaceChildren(h('span.pc-spin', { 'aria-hidden': 'true' }), h('span.pc-text', {}, this.label, this.sub), this.btn);
    host.hidden = true;
    this.poll();
    this.timer = setInterval(() => { if (!document.hidden) this.poll(); }, 8000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.poll(); });
  }

  async poll() {
    let r;
    try { r = await api.getPcNow(); } catch { r = null; }
    const run = r?.running;
    this.job = run && !run.app ? run : null;
    this.host.hidden = !this.job;
    if (!this.job) return;
    this.label.textContent = `PC is running · ${this.job.label}`;
    this.sub.textContent = [this.job.prompt ? `“${this.job.prompt.slice(0, 70)}${this.job.prompt.length > 70 ? '…' : ''}”` : '', mins(Date.now() - (this.job.since || Date.now())), r.pending ? `${r.pending} waiting` : ''].filter(Boolean).join(' · ');
  }

  async open() {
    if (!this.job) return;
    this.btn.disabled = true;
    try { await this.onOpen(this.job.promptId); } finally { this.btn.disabled = false; }
  }
}
