// workflow-picker.js - the preset picker in the top bar.
// Sections follow ComfyUI's right-click "AI Workflow" menu (3D / Image / Video /
// Audio), with the app's own presets on top and the setups saved from the chat
// builder ("My presets", rename / delete inline) at the bottom. Each row shows
// its live availability: "needs download" / "missing node" rows are disabled
// with the reason; "slow · RAM offload" and "tight on 11 GB" are hints.
import { h, toast } from './dom.js';

export const SECTIONS = [
  { key: 'App', label: 'App presets', icon: 'i-sparkles' },
  { key: '3D', label: '3D', icon: 'i-box' },
  { key: 'Image', label: 'Image', icon: 'i-image' },
  { key: 'Video', label: 'Video', icon: 'i-video' },
  { key: 'Audio', label: 'Audio', icon: 'i-audio-lines' },
  { key: 'My presets', label: 'My presets', icon: 'i-save' },
];
export const sectionOf = (w) => (w.group && SECTIONS.some((s) => s.key === w.group) ? w.group : 'App');

export class WorkflowPicker {
  /** @param o.onPick(id)  @param o.onRename(w, name)  @param o.onDelete(w) */
  constructor(o) {
    Object.assign(this, o);
    this.btn = document.getElementById('preset-btn');
    this.pop = document.getElementById('picker');
    this.scrim = document.getElementById('picker-scrim');
    this.crumb = document.getElementById('preset-crumb');
    this.name = document.getElementById('preset-name');
    this.items = []; this.current = null; this.editing = null;
    this.btn.addEventListener('click', () => (this.pop.hidden ? this.open() : this.close()));
    this.scrim.addEventListener('click', () => this.close());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !this.pop.hidden) this.close(); });
  }

  setItems(items) { this.items = items; if (!this.pop.hidden) this.render(); }

  setCurrent(w) {
    this.current = w?.id || null;
    const sec = w ? SECTIONS.find((s) => s.key === sectionOf(w)) : null;
    this.crumb.textContent = sec && sec.key !== 'App' ? `${sec.label} ›` : '';
    this.name.textContent = w ? w.label : 'No presets';
    this.btn.title = w ? `${sec?.label || ''} › ${w.label}` : '';
  }

  open() { this.render(); this.pop.hidden = false; this.scrim.hidden = false; this.btn.classList.add('open'); this.btn.setAttribute('aria-expanded', 'true'); this.pop.querySelector('.ent.on')?.scrollIntoView({ block: 'nearest' }); }
  close() { this.pop.hidden = true; this.scrim.hidden = true; this.btn.classList.remove('open'); this.btn.setAttribute('aria-expanded', 'false'); this.editing = null; }

  render() {
    const els = [h('div.mt', {}, h('i.i.i-workflow'), h('b', {}, 'AI Workflow'), h('span', {}, 'same list as ComfyUI right-click'))];
    for (const sec of SECTIONS) {
      const rows = this.items.filter((w) => sectionOf(w) === sec.key);
      if (!rows.length) continue;
      els.push(h('div.grp', { dataset: { section: sec.key } }, h(`i.i.${sec.icon}`), sec.label, h('span.cnt', {}, String(rows.length))));
      for (const w of rows) els.push(this.#row(w));
    }
    if (!this.items.length) els.push(h('div.ent.dis', {}, h('span.nm', {}, 'No presets found')));
    this.pop.replaceChildren(...els);
  }

  #row(w) {
    const av = w.availability;
    const off = !w.ok || av?.status === 'unavailable';
    const tag = !w.ok ? h('span.tg.na', {}, 'invalid')
      : av?.status === 'unavailable' ? h('span.tg.na', {}, av.label || 'unavailable')
        : av?.label ? h('span.tg', {}, av.label) : null;
    const reason = !w.ok ? w.error : av?.reason || w.description || '';
    if (this.editing === w.id) return this.#editRow(w);
    const row = h('div.ent', {
      role: 'option', tabindex: off ? -1 : 0, title: reason, 'aria-selected': String(this.current === w.id), 'aria-disabled': String(off),
      dataset: { preset: w.id },
      onclick: (e) => { if (e.target.closest('.edit')) return; if (off) { toast(reason || 'Unavailable', 6000); return; } this.close(); this.onPick(w.id); },
      onkeydown: (e) => { if (e.key === 'Enter' && !off) { this.close(); this.onPick(w.id); } },
    }, h('span.nm', {}, w.label), tag, this.current === w.id ? h('i.i.i-check') : null,
    w.user ? h('button.edit.btn.text', { type: 'button', 'aria-label': `Rename or delete ${w.label}`, onclick: () => { this.editing = w.id; this.render(); } }, h('i.i.i-settings')) : null);
    row.classList.toggle('on', this.current === w.id);
    row.classList.toggle('dis', off);
    return row;
  }

  #editRow(w) {
    const input = h('input.input', { type: 'text', value: w.label, maxlength: 60, 'aria-label': 'Preset name' });
    const save = async () => { const n = input.value.trim(); if (!n) return toast('Name cannot be empty'); await this.onRename(w, n); this.editing = null; if (!this.pop.hidden) this.render(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { this.editing = null; this.render(); } });
    setTimeout(() => input.focus(), 0);
    let confirmDel = false;
    const del = h('button.btn.text.danger-text', { type: 'button', onclick: async () => {
      if (!confirmDel) { confirmDel = true; del.textContent = 'Tap again to delete'; return; }
      await this.onDelete(w); this.editing = null; if (!this.pop.hidden) this.render();
    } }, h('i.i.i-trash-2'), 'Delete');
    return h('div.ent.editing', { dataset: { preset: w.id } }, input,
      h('button.btn.text', { type: 'button', onclick: save }, h('i.i.i-check'), 'Save'), del,
      h('button.btn.text', { type: 'button', 'aria-label': 'Cancel', onclick: () => { this.editing = null; this.render(); } }, h('i.i.i-x')));
  }
}
