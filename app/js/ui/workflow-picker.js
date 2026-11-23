// workflow-picker.js - the preset picker in the top bar.
// Sections follow ComfyUI's right-click "AI Workflow" menu (3D / Image / Video /
// Audio), with "My presets" at the bottom: setups saved from the chat builder
// (rename / delete inline) and workflows imported or dropped into workflows/.
// (The old "App presets" section is gone; see lib/legacy-presets.js.) Image is
// split into sub sections (Text to Image, Image Edit, Inpainting, Upscale), see
// pickerLayout. Rows show only the preset name. Unavailable rows (missing model file or node) are grayed
// out with no tag; tapping one says what is missing.
import { h, toast } from './dom.js';
import { SUBGROUPS } from '../lib/presets.js';

export const SECTIONS = [
  { key: '3D', label: '3D', icon: 'i-box' },
  { key: 'Image', label: 'Image', icon: 'i-image' },
  { key: 'Video', label: 'Video', icon: 'i-video' },
  { key: 'Audio', label: 'Audio', icon: 'i-audio-lines' },
  { key: 'My presets', label: 'My presets', icon: 'i-save' },
];
// Anything without a known group (an imported folder workflow) is the user's own.
export const sectionOf = (w) => (w.group && SECTIONS.some((s) => s.key === w.group) ? w.group : 'My presets');

/**
 * Picker layout: [{ sec, rows, subs: [{ name, rows }] }] in SECTIONS order. Image
 * is split into Text to Image / Image Edit / Inpainting / Upscale (lib/presets.js
 * SUBGROUPS, from each preset's menuPath); rows inside a sub section are ordered
 * by menuOrder and show the preset's short name. Empty sections are left out.
 */
export function pickerLayout(items) {
  const out = [];
  for (const sec of SECTIONS) {
    const all = items.filter((w) => sectionOf(w) === sec.key);
    if (!all.length) continue;
    const names = SUBGROUPS[sec.key] || [];
    const subs = names.map((name) => ({ name, rows: all.filter((w) => w.subgroup === name).sort((a, b) => (a.menuOrder ?? 999) - (b.menuOrder ?? 999)) })).filter((x) => x.rows.length);
    out.push({ sec, rows: all.filter((w) => !names.includes(w.subgroup)), subs, count: all.length });
  }
  return out;
}

/** Name shown for a preset: its short name inside a sub section, else its label. */
export const rowName = (w) => (w.subgroup && w.short ? w.short : w.label);

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
    // "Image › Text to Image › Z-Image Turbo"; on a narrow phone the crumb is
    // cut with an ellipsis first, so the preset's own name stays readable.
    const path = sec ? [sec.label, ...(w.subgroup ? [w.subgroup] : [])] : [];
    // Two parts, so a phone can drop the section and keep "Text to Image ›".
    this.crumb.replaceChildren(...(sec ? [h('span.crumb-sec', {}, `${sec.label} › `)] : []), ...(w?.subgroup ? [h('span.crumb-sub', {}, `${w.subgroup} ›`)] : []));
    if (sec && !w.subgroup) this.crumb.firstChild.textContent = `${sec.label} ›`;
    this.name.textContent = w ? rowName(w) : 'No presets';
    this.btn.title = w ? [...path, w.label].join(' › ') : '';
    this.btn.setAttribute('aria-label', w ? `Workflow preset: ${[...path, rowName(w)].join(', ')}` : 'Workflow preset');
  }

  open() { this.render(); this.pop.hidden = false; this.scrim.hidden = false; this.btn.classList.add('open'); this.btn.setAttribute('aria-expanded', 'true'); this.pop.querySelector('.ent.on')?.scrollIntoView({ block: 'nearest' }); }
  close() { this.pop.hidden = true; this.scrim.hidden = true; this.btn.classList.remove('open'); this.btn.setAttribute('aria-expanded', 'false'); this.editing = null; }

  render() {
    const els = [h('div.mt', {}, h('i.i.i-workflow'), h('b', {}, 'AI Workflow'))];
    for (const { sec, rows, subs, count } of pickerLayout(this.items)) {
      els.push(h('div.grp', { dataset: { section: sec.key } }, h(`i.i.${sec.icon}`), sec.label, h('span.cnt', {}, String(count))));
      for (const sub of subs) {
        els.push(h('div.sub', { dataset: { sub: sub.name }, role: 'presentation' }, sub.name));
        // Batch 5: models inside a sub section are indented one more step.
        for (const w of sub.rows) { const r = this.#row(w); r.classList.add('in-sub'); els.push(r); }
      }
      for (const w of rows) els.push(this.#row(w));
    }
    if (!this.items.length) els.push(h('div.ent.dis', {}, h('span.nm', {}, 'No presets found')));
    this.pop.replaceChildren(...els);
  }

  #row(w) {
    const av = w.availability;
    const off = !w.ok || av?.status === 'unavailable';
    const reason = !w.ok ? w.error : off ? av?.reason || '' : '';
    if (this.editing === w.id) return this.#editRow(w);
    const row = h('div.ent', {
      role: 'option', tabindex: off ? -1 : 0, title: off ? reason : undefined, 'aria-selected': String(this.current === w.id), 'aria-disabled': String(off),
      dataset: { preset: w.id },
      onclick: (e) => { if (e.target.closest('.edit')) return; if (off) { toast(reason || 'Unavailable', 6000); return; } this.close(); this.onPick(w.id); },
      onkeydown: (e) => { if (e.key === 'Enter' && !off) { this.close(); this.onPick(w.id); } },
    }, h('span.nm', {}, rowName(w)), this.current === w.id ? h('i.i.i-check') : null,
    w.user || w.graph ? h('button.edit.btn.text', { type: 'button', 'aria-label': `${w.graph ? 'Rename, move' : 'Rename'} or delete ${w.label}`, onclick: () => { this.editing = w.id; this.render(); } }, h('i.i.i-settings')) : null);
    row.classList.toggle('on', this.current === w.id);
    row.classList.toggle('dis', off);
    return row;
  }

  #editRow(w) {
    const input = h('input.input', { type: 'text', value: w.label, maxlength: 60, 'aria-label': 'Preset name' });
    // Presets saved from the node view can also move to another section / sub section.
    let place = null;
    if (w.graph) {
      const opts = SECTIONS.flatMap((s) => (SUBGROUPS[s.key]?.length ? SUBGROUPS[s.key].map((sub) => [`${s.key}|${sub}`, `${s.label} › ${sub}`]) : [[`${s.key}|`, s.label]]));
      place = h('select.input.place', { 'aria-label': 'Section' }, ...opts.map(([v, t]) => h('option', { value: v }, t)));
      place.value = `${sectionOf(w)}|${w.subgroup || ''}`;
      if (!place.value) place.selectedIndex = opts.findIndex(([v]) => v.startsWith(sectionOf(w) + '|'));
    }
    const save = async () => {
      const n = input.value.trim(); if (!n) return toast('Name cannot be empty');
      if (w.graph) { const [group, sub] = place.value.split('|'); await this.onEditGraph?.(w, { name: n, group, subgroup: sub || null }); }
      else await this.onRename(w, n);
      this.editing = null; if (!this.pop.hidden) this.render();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { this.editing = null; this.render(); } });
    // Graph presets: no keyboard on open (found on the phone: it covered the
    // "Move to" row); just bring both rows into view. Builder setups: rename only.
    setTimeout(() => { if (w.graph) this.pop.querySelector('.ent-edit-wrap')?.scrollIntoView({ block: 'nearest' }); else input.focus(); }, 0);
    let confirmDel = false;
    const del = h('button.btn.text.danger-text', { type: 'button', onclick: async () => {
      if (!confirmDel) { confirmDel = true; del.textContent = 'Tap again to delete'; return; }
      await this.onDelete(w); this.editing = null; if (!this.pop.hidden) this.render();
    } }, h('i.i.i-trash-2'), 'Delete');
    const row = h('div.ent.editing', { dataset: { preset: w.id } }, input,
      h('button.btn.text', { type: 'button', onclick: save }, h('i.i.i-check'), 'Save'), del,
      h('button.btn.text', { type: 'button', 'aria-label': 'Cancel', onclick: () => { this.editing = null; this.render(); } }, h('i.i.i-x')));
    return place ? h('div.ent-edit-wrap', { dataset: { preset: w.id } }, row, h('div.ent.editing.place-row', {}, h('span.muted', {}, 'Move to'), place)) : row;
  }
}
