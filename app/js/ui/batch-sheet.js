// batch-sheet.js - the batch the PC runs later (server/scheduler.js).
// Batch 12 made it; batch 13 redesigned it (mockups/batch13/item2 + item4):
//   - a status card on top: Ready / Starts at … / Waiting for the PC / Running
//     job 2 of 3 (with a bar);
//   - the jobs as steps on a line (✓ done, running, numbered waiting ones);
//     long-press a waiting one and drag it up or down to reorder;
//     ⋮ on a waiting one: Edit (loads it into the form) and Remove;
//   - the footer: a toggle [▶ Now | 🕐 11:30 PM] beside one blue button whose
//     words follow it ("Start now" / "Start at 11:30 PM"); tapping the time
//     again opens a scroll-wheel clock (hour : minute, AM/PM).
// Jobs run one after another on the PC, each after the previous finished and
// only while the PC is free; a failed job is skipped. The phone can sleep.
import { h, toast } from './dom.js';
import { ActionMenu } from './action-menu.js';
import * as api from '../api.js';

const timeOf = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

/** "23:30" -> the next time it is 23:30 (today, else tomorrow), in ms. */
export function nextClockTime(hhmm, now = new Date()) {
  const [hh, mm] = String(hhmm || '').split(':').map(Number);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  const t = new Date(now); t.setHours(hh, mm, 0, 0);
  if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
  return t.getTime();
}

/** "23:30" -> "11:30 PM". */
export function clockLabel(hhmm) {
  const [hh, mm] = String(hhmm || '').split(':').map(Number);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return '';
  return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
}

/** Jobs -> rows: one row per "Save to batch" (its Batch count of jobs share a group), in order. */
export function rowsOf(jobs) {
  const rows = [];
  for (const j of jobs) {
    const last = rows.at(-1);
    if (last && j.group && last.group === j.group && last.status === j.status) last.jobs.push(j);
    else rows.push({ group: j.group, status: j.status, jobs: [j] });
  }
  return rows;
}

/** New job order after moving waiting row `from` to waiting position `to`. */
export function reorderIds(waitingRows, from, to) {
  const order = [...waitingRows];
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  return order.flatMap((r) => r.jobs.map((j) => j.id));
}

const ITEM = 34; // wheel row height (px)

/** One scroll-wheel column. values: [{ v, label }]. */
function wheel(values, selected, onPick, cls = '') {
  const col = h(`div.bs-wheel${cls}`, { role: 'listbox' }, h('div.bs-wpad'), ...values.map((x) => h('div.bs-witem', { dataset: { v: x.v } }, x.label)), h('div.bs-wpad'));
  let t = null;
  const mark = () => {
    const i = Math.max(0, Math.min(values.length - 1, Math.round(col.scrollTop / ITEM)));
    col.querySelectorAll('.bs-witem').forEach((el, k) => el.classList.toggle('on', k === i));
    return i;
  };
  col.addEventListener('scroll', () => { mark(); clearTimeout(t); t = setTimeout(() => onPick(values[mark()].v), 140); }, { passive: true });
  // a tap on a row scrolls it to the middle
  col.addEventListener('click', (e) => { const it = e.target.closest('.bs-witem'); if (!it) return; const k = [...col.querySelectorAll('.bs-witem')].indexOf(it); col.scrollTo({ top: k * ITEM, behavior: 'smooth' }); });
  requestAnimationFrame(() => { col.scrollTop = Math.max(0, values.findIndex((x) => x.v === selected)) * ITEM; mark(); });
  return col;
}

export class BatchSheet {
  /** onEdit({ ids, jobs, index, label }) - ⋮ Edit on a waiting row. */
  constructor({ button, badge, onEdit }) {
    this.button = button; this.badge = badge; this.onEdit = onEdit;
    this.menu = new ActionMenu();
    this.mode = localStorage.getItem('batchMode') === 'later' ? 'later' : 'now';
    button.addEventListener('click', () => this.open());
    this.refresh();
    // every 15 s; not while the clock is open (a repaint would rebuild the wheels under the finger)
    setInterval(() => { if (!document.hidden) this.refresh({ repaint: !this.picking }); }, 15000);
  }

  get time() { return localStorage.getItem('batchTime') || '23:30'; }
  set time(v) { localStorage.setItem('batchTime', v); }

  /** Repaint the button's count (waiting + running rows - one per Save; 0 when empty). */
  async refresh({ repaint = true } = {}) {
    try { this.data = await api.getSchedule(); } catch { return; }
    const n = rowsOf(this.data.jobs).filter((r) => r.status === 'waiting' || r.status === 'running').length;
    this.badge.textContent = String(n);
    // Batch 19: no batches = the button is greyed out and the "0" badge is gone.
    this.badge.hidden = n === 0;
    this.button.classList.toggle('has-jobs', n > 0);
    this.button.classList.toggle('no-jobs', n === 0);
    this.button.classList.toggle('is-running', this.data.state === 'running');
    if (this.el && !this.drag && repaint) this.paint();
  }

  async add(jobs) {
    try { this.data = await api.addToSchedule(jobs); } catch (e) { toast(e.message, 6000); return false; }
    await this.refresh();
    const n = this.data.jobs.filter((j) => j.status === 'waiting').length;
    toast(`Saved to batch (${n} waiting)`);
    return true;
  }

  /** Batch 13: Edit -> the row's jobs replaced in place. Throws when the job already started. */
  async replace(ids, jobs) {
    this.data = await api.replaceScheduled(ids, jobs);
    await this.refresh();
  }

  open() {
    this.close();
    this.scrim = h('div.sheet-scrim', { onclick: () => this.close() });
    this.body = h('div.bs-body');
    this.el = h('div.sheet.batch-sheet', { role: 'dialog', 'aria-label': 'Batch' },
      h('div.sheet-title.pj-title', {}, h('span', {}, 'Batch'), h('span.spacer'), h('button.btn.icon', { type: 'button', 'aria-label': 'Close', onclick: () => this.close() }, h('i.i.i-x'))), this.body);
    document.body.append(this.scrim, this.el);
    this.picking = false;
    this.paint();
    this.refresh();
  }

  close() { this.menu.close(); this.scrim?.remove(); this.el?.remove(); this.scrim = this.el = null; this.drag = null; }

  async act(fn) { try { this.data = await fn(); } catch (e) { toast(e.message, 6000); } await this.refresh(); }

  #status(d, rows) {
    const jobs = d.jobs, waiting = jobs.filter((j) => j.status === 'waiting');
    const finished = jobs.filter((j) => j.status === 'done' || j.status === 'failed').length;
    const count = h('span.muted.small', {}, `${rows.length} ${rows.length === 1 ? 'job' : 'jobs'}${jobs.length !== rows.length ? ` · ${jobs.length} runs` : ''}`);
    if (!jobs.length) return null;
    if (d.state === 'running') {
      const k = finished + 1;
      return h('div.bs-card', {}, h('div.bs-card-top', {}, h('span.bs-dot.run'), h('b', {}, `Running job ${k} of ${jobs.length}`), h('span.spacer'), finished ? h('span.muted.small', {}, `${finished} done`) : null),
        h('span.bs-bar', {}, h('i', { style: { width: `${Math.round((finished / jobs.length) * 100)}%` } })));
    }
    if (d.state === 'scheduled') return h('div.bs-card', {}, h('div.bs-card-top', {}, h('span.bs-dot.wait'), h('b', {}, `Starts at ${timeOf(d.start.at)}`), h('span.spacer'), count));
    if (d.state === 'waiting') return h('div.bs-card', {}, h('div.bs-card-top', {}, h('span.bs-dot.wait'), h('b', {}, 'Waiting for the PC'), h('span.spacer'), count),
      h('div.muted.small', {}, d.waitReason ? `${d.waitReason[0].toUpperCase()}${d.waitReason.slice(1)}. It starts by itself when the PC is free.` : 'It starts by itself when the PC is free.'));
    if (waiting.length) return h('div.bs-card', {}, h('div.bs-card-top', {}, h('span.bs-dot'), h('b', {}, 'Ready'), h('span.spacer'), count));
    return h('div.bs-card', {}, h('div.bs-card-top', {}, h('span.bs-dot'), h('b', {}, 'All done'), h('span.spacer'), count));
  }

  #step(row, waitingRows) {
    const j = row.jobs[0];
    const wi = waitingRows.indexOf(row);
    const label = `${j.label}${row.jobs.length > 1 ? ` × ${row.jobs.length}` : ''}`;
    const errors = [...new Set(row.jobs.map((x) => x.error).filter(Boolean))];
    const prompt = j.meta?.prompt ? String(j.meta.prompt).replace(/\s+/g, ' ').slice(0, 90) : '';
    const sub = row.status === 'running' ? 'Running…'
      : row.status === 'done' ? `Done · in Files`
        : row.status === 'failed' ? ['Skipped', ...errors].join(' · ') : prompt || 'Waiting';
    const node = row.status === 'done' ? h('span.bs-node.ok', {}, h('i.i.i-check'))
      : row.status === 'failed' ? h('span.bs-node.fail', {}, h('i.i.i-x'))
        : row.status === 'running' ? h('span.bs-node.run', {}, h('span.pc-spin'))
          : h('span.bs-node', {}, String(wi + 1));
    const ids = row.jobs.map((x) => x.id);
    const more = row.status === 'waiting' ? h('button.icon-btn.bs-more', { type: 'button', 'aria-label': 'More', title: 'More', dataset: { act: 'more' }, onclick: (e) => {
      e.stopPropagation();
      this.menu.open(e.currentTarget, [{ items: [
        { act: 'edit', icon: 'i-pencil', label: 'Edit', fn: () => { this.close(); this.onEdit?.({ ids, jobs: row.jobs, index: wi, label }); } },
        { act: 'remove', icon: 'i-trash-2', label: 'Remove', danger: true, fn: () => this.#remove(ids) },
      ] }]);
    } }, h('i.i.i-more-vertical')) : h('span');
    const el = h(`div.bs-step.${row.status}`, { dataset: { job: j.id, row: wi >= 0 ? String(wi) : '' } },
      node, h('span.bs-t', {}, h('span.bs-label', {}, label), h('span.bs-sub', {}, sub)), more);
    if (row.status === 'waiting') this.#draggable(el, wi, waitingRows);
    return el;
  }

  async #remove(ids) {
    for (const id of ids) { try { this.data = await api.removeScheduled(id); } catch (e) { toast(e.message, 6000); break; } }
    await this.refresh();
  }

  /** Long-press a waiting step, then drag it up or down; the others slide out of the way. */
  #draggable(el, index, waitingRows) {
    let timer = null, startY = 0, startX = 0;
    const begin = (x, y) => {
      startX = x; startY = y;
      clearTimeout(timer);
      timer = setTimeout(() => this.#lift(el, index, waitingRows, startY), 350);
    };
    const move = (x, y, e) => {
      if (this.drag?.el === el) { e.preventDefault(); this.#dragTo(y); return; }
      if (Math.abs(y - startY) > 8 || Math.abs(x - startX) > 8) clearTimeout(timer);
    };
    const end = () => { clearTimeout(timer); if (this.drag?.el === el) this.#drop(); };
    el.addEventListener('touchstart', (e) => { if (e.target.closest('.bs-more')) return; begin(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
    el.addEventListener('touchmove', (e) => move(e.touches[0].clientX, e.touches[0].clientY, e), { passive: false });
    el.addEventListener('touchend', end); el.addEventListener('touchcancel', end);
    el.addEventListener('mousedown', (e) => {
      if (e.button || e.target.closest('.bs-more')) return;
      begin(e.clientX, e.clientY);
      const mm = (ev) => move(ev.clientX, ev.clientY, ev);
      const mu = () => { document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); end(); };
      document.addEventListener('mousemove', mm); document.addEventListener('mouseup', mu);
    });
    el.addEventListener('contextmenu', (e) => { if (this.drag) e.preventDefault(); });
  }

  #lift(el, index, waitingRows, y) {
    const els = [...this.body.querySelectorAll('.bs-step.waiting')];
    const rects = els.map((x) => x.getBoundingClientRect());
    this.drag = { el, index, to: index, startY: y, els, rects, waitingRows, h: rects[index].height + 2 };
    el.classList.add('lifted');
    this.body.classList.add('dragging');
    navigator.vibrate?.(12);
  }

  #dragTo(y) {
    const d = this.drag; const dy = y - d.startY;
    d.el.style.transform = `translateY(${dy}px) scale(1.02)`;
    const mid = d.rects[d.index].top + d.rects[d.index].height / 2 + dy;
    let to = d.index;
    while (to > 0 && mid < d.rects[to - 1].top + d.rects[to - 1].height / 2) to--;
    while (to < d.rects.length - 1 && mid > d.rects[to + 1].top + d.rects[to + 1].height / 2) to++;
    d.to = to;
    d.els.forEach((x, k) => {
      if (x === d.el) return;
      const shift = d.index < to && k > d.index && k <= to ? -d.h : d.index > to && k >= to && k < d.index ? d.h : 0;
      x.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  }

  async #drop() {
    const d = this.drag; this.drag = null;
    this.body.classList.remove('dragging');
    d.el.classList.remove('lifted');
    if (d.to === d.index) { d.els.forEach((x) => { x.style.transform = ''; }); return; }
    await this.act(() => api.orderSchedule(reorderIds(d.waitingRows, d.index, d.to)));
  }

  #clock() {
    const [hh, mm] = this.time.split(':').map(Number);
    const set = (h24, m) => { this.time = `${String(h24).padStart(2, '0')}:${String(m).padStart(2, '0')}`; this.#paintFoot(); };
    const cur = () => this.time.split(':').map(Number);
    const hours = Array.from({ length: 12 }, (_, i) => ({ v: i + 1, label: String(i + 1) }));
    const mins = Array.from({ length: 60 }, (_, i) => ({ v: i, label: String(i).padStart(2, '0') }));
    const aps = [{ v: 'AM', label: 'AM' }, { v: 'PM', label: 'PM' }];
    const h12 = ((hh + 11) % 12) + 1, ap = hh < 12 ? 'AM' : 'PM';
    const to24 = (h1, a) => (h1 % 12) + (a === 'PM' ? 12 : 0);
    this.clockNote = h('div.bs-clock-note');
    return h('div.bs-clock', {},
      h('div.bs-clock-cols', {},
        wheel(hours, h12, (v) => { const [H, M] = cur(); set(to24(v, H < 12 ? 'AM' : 'PM'), M); }),
        h('div.bs-colon', {}, ':'),
        wheel(mins, mm, (v) => { const [H] = cur(); set(H, v); }),
        wheel(aps, ap, (v) => { const [H, M] = cur(); set(to24(((H + 11) % 12) + 1, v), M); }, '.ap')),
      this.clockNote);
  }

  #paintFoot() {
    if (!this.foot) return;
    const at = nextClockTime(this.time);
    if (this.clockNote) this.clockNote.textContent = at && new Date(at).toDateString() !== new Date().toDateString() ? 'Tomorrow' : 'Today';
    const label = clockLabel(this.time);
    this.foot.querySelector('[data-mode="later"] span').textContent = label;
    this.foot.querySelectorAll('.bs-tg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === this.mode));
    this.foot.querySelector('[data-act="start"]').textContent = this.mode === 'now' ? 'Start now' : `Start at ${label}`;
  }

  paint() {
    const d = this.data;
    if (!d) { this.body.replaceChildren(h('p.muted', {}, 'Loading…')); return; }
    const rows = rowsOf(d.jobs);
    const waitingRows = rows.filter((r) => r.status === 'waiting');
    const started = d.state !== 'idle';
    const list = rows.length ? h('div.bs-tl', {}, ...rows.map((r) => this.#step(r, waitingRows)))
      : h('p.muted.bs-empty', {}, 'Nothing saved yet. Set up a job on the form and tap + next to Run.');
    this.foot = null;
    let foot = null;
    if (waitingRows.length && !started) {
      const pick = (mode) => {
        if (mode === 'later' && this.mode === 'later') this.picking = !this.picking; // tap the time again: the clock
        else if (mode === 'now') this.picking = false;
        this.mode = mode; localStorage.setItem('batchMode', mode);
        this.paint();
      };
      foot = h('div.bs-foot', {},
        this.mode === 'later' && this.picking ? this.#clock() : null,
        h('div.bs-startrow', {},
          h('div.bs-tg', { role: 'group', 'aria-label': 'When' },
            h('button', { type: 'button', dataset: { mode: 'now' }, onclick: () => pick('now') }, h('i.i.i-play'), 'Now'),
            h('button', { type: 'button', dataset: { mode: 'later' }, 'aria-label': 'Start later', onclick: () => pick('later') }, h('i.i.i-clock'), h('span'))),
          h('button.btn.primary.bs-go', { type: 'button', dataset: { act: 'start' }, onclick: () => {
            if (this.mode === 'now') return this.act(() => api.startSchedule(null));
            const at = nextClockTime(this.time);
            if (!at) return toast('Pick a time');
            this.picking = false;
            this.act(() => api.startSchedule(at)).then(() => toast(`Batch starts at ${timeOf(at)}`));
          } })));
      this.foot = foot;
    } else if (started) {
      foot = h('div.bs-foot', {}, h('button.btn.bs-stop', { type: 'button', dataset: { act: 'stop' }, onclick: () => this.act(() => api.stopSchedule()) },
        h('i.i.i-square'), d.state === 'running' ? 'Stop after this job' : 'Cancel start'));
    }
    this.body.replaceChildren(...[
      this.#status(d, rows),
      list,
      d.jobs.some((j) => j.status === 'done' || j.status === 'failed') ? h('button.link.bs-clear', { type: 'button', onclick: () => this.act(() => api.clearSchedule()) }, 'Clear finished') : null,
      foot,
      rows.length ? h('p.muted.bs-hint', {}, 'Runs one job at a time, only while the PC is free. Long-press a job to move it.') : null,
    ].filter(Boolean));
    this.#paintFoot();
  }
}
