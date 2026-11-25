// workflow-picker.js - the preset picker in the top bar.
// Two tabs, like ComfyUI's right-click "AI Models" / "AI Workflows" menus:
// Models (3D / Image / Video / Audio) and Workflows (Textures / Concept / VFX,
// multi-step pipelines). It opens on the current preset's tab. "My presets" sits
// at the bottom of Models: presets saved from the node view (rename, move or
// delete inline) and workflows imported or dropped into workflows/.
// (The old "App presets" section is gone; see lib/legacy-presets.js.) Image is
// split into sub sections (Text to Image, Image Edit, Inpainting, Upscale), see
// pickerLayout. Rows show only the preset name. Unavailable rows (missing model file or node) are grayed
// out with no tag; tapping one says what is missing.
import { h, toast } from './dom.js';
import { SUBGROUPS } from '../lib/presets.js';
import { dropdown } from './dropdown.js';

// tab: the picker tab a section is on. Models = one model as it comes;
// Workflows = multi-step pipelines grouped by task (lib/presets.js KINDS).
export const TABS = [{ key: 'model', label: 'Models' }, { key: 'workflow', label: 'Workflows' }];
export const SECTIONS = [
  { key: '3D', label: '3D', icon: 'i-box', tab: 'model' },
  { key: 'Image', label: 'Image', icon: 'i-image', tab: 'model' },
  { key: 'Video', label: 'Video', icon: 'i-video', tab: 'model' },
  { key: 'Audio', label: 'Audio', icon: 'i-audio-lines', tab: 'model' },
  { key: 'Textures', label: 'Textures', icon: 'i-layers', tab: 'workflow' },
  { key: 'Concept', label: 'Concept', icon: 'i-sparkles', tab: 'workflow' },
  { key: 'VFX', label: 'VFX', icon: 'i-film', tab: 'workflow' },
  // batch 8: 3D and audio pipelines
  { key: '3D Assets', label: '3D Assets', icon: 'i-box', tab: 'workflow' },
  { key: 'Sound', label: 'Sound', icon: 'i-audio-lines', tab: 'workflow' },
  { key: 'My presets', label: 'My presets', icon: 'i-save', tab: 'model' },
];
// Anything without a known group (an imported folder workflow) is the user's own.
export const sectionOf = (w) => (w.group && SECTIONS.some((s) => s.key === w.group) ? w.group : 'My presets');
/** Picker tab of a preset: its section's tab. */
export const tabOf = (w) => SECTIONS.find((s) => s.key === sectionOf(w))?.tab || 'model';

/**
 * Picker layout: [{ sec, rows, subs: [{ name, rows }] }] in SECTIONS order. Image
 * is split into Text to Image / Image Edit / Inpainting / Upscale (lib/presets.js
 * SUBGROUPS, from each preset's menuPath); rows inside a sub section are ordered
 * by menuOrder and show the preset's short name. Empty sections are left out.
 */
export function pickerLayout(items, tab = null) {
  const out = [];
  for (const sec of SECTIONS) {
    if (tab && sec.tab !== tab) continue;
    const all = items.filter((w) => sectionOf(w) === sec.key);
    if (!all.length) continue;
    const names = SUBGROUPS[sec.key] || [];
    const subs = names.map((name) => ({ name, rows: all.filter((w) => w.subgroup === name).sort((a, b) => (a.menuOrder ?? 999) - (b.menuOrder ?? 999)) })).filter((x) => x.rows.length);
    let rows = all.filter((w) => !names.includes(w.subgroup));
    // Workflow sections: in the order the workflows are meant to be used (menuOrder).
    if (sec.tab === 'workflow') rows = rows.sort((a, b) => (a.menuOrder ?? 999) - (b.menuOrder ?? 999));
    out.push({ sec, rows, subs, count: all.length });
  }
  return out;
}

/** Name shown for a preset: its short name inside a sub section, else its label. */
export const rowName = (w) => (w.subgroup && w.short ? w.short : w.label);

const plural = (n, one, many) => (n === 1 ? `1 ${one}` : `${n} ${many}`);
/**
 * Batch 8: the short hint on the right of a picker row - what the preset needs
 * from you: "Needs 1 image", "Up to 3 images", "Needs a recording", "Uses your
 * prompt". Optional inputs only count toward "up to".
 */
export function presetHint(w) {
  if (!w?.ok) return '';
  const m = w.ai || {}, c = w.controls || {};
  const optional = new Set((m.optional || []).map((o) => o.node));
  const imgs = c.images || [];
  const need = imgs.filter((s) => !optional.has(s.node)).length;
  if (imgs.length) return need === imgs.length ? `Needs ${plural(imgs.length, 'image', 'images')}` : need ? `${need}-${imgs.length} images` : `Up to ${plural(imgs.length, 'image', 'images')}`;
  const files = (m.inputs || []).filter((s) => !s.optional && !s.defaultAvailable);
  const audio = files.filter((s) => s.kind === 'audio').length, video = files.filter((s) => s.kind === 'video').length;
  if (video) return video === 1 ? 'Needs a video' : `Needs ${video} videos`;
  if (audio) return audio === 1 ? 'Needs a recording' : `Needs ${audio} recordings`;
  if (c.prompt?.length || m.promptDefault) return 'Uses your prompt';
  return '';
}

/** Search: every word of the query in the preset's name, section or hint. */
export function matchPreset(w, q) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [w.label, rowName(w), w.group, w.subgroup, presetHint(w)].filter(Boolean).join(' ').toLowerCase();
  return words.every((x) => hay.includes(x));
}

export class WorkflowPicker {
  /** @param o.onPick(id)  @param o.onEditGraph(w, patch)  @param o.onDelete(w) */
  constructor(o) {
    Object.assign(this, o);
    this.btn = document.getElementById('preset-btn');
    this.pop = document.getElementById('picker');
    this.scrim = document.getElementById('picker-scrim');
    this.crumb = document.getElementById('preset-crumb');
    this.name = document.getElementById('preset-name');
    this.items = []; this.current = null; this.editing = null; this.tab = 'model'; this.query = '';
    // Batch 8: search box at the top (the same element across re-renders, so typing keeps focus).
    this.search = h('input.picker-search', { type: 'search', placeholder: 'Search models and workflows', 'aria-label': 'Search presets', autocomplete: 'off', enterkeyhint: 'search',
      oninput: () => { this.query = this.search.value; this.editing = null; this.render(); this.pop.scrollTop = 0; },
      onkeydown: (e) => { if (e.key === 'Enter') this.pop.querySelector('.ent[data-preset]:not(.dis)')?.click(); } });
    this.btn.addEventListener('click', () => (this.pop.hidden ? this.open() : this.close()));
    this.scrim.addEventListener('click', () => this.close());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !this.pop.hidden) this.close(); });
  }

  setItems(items) { this.items = items; if (!this.pop.hidden) this.render(); }

  setCurrent(w) {
    this.current = w?.id || null;
    const sec = w ? SECTIONS.find((s) => s.key === sectionOf(w)) : null;
    const path = sec ? [sec.label, ...(w.subgroup ? [w.subgroup] : [])] : [];
    // Batch 17: the model name comes first and always reads in full; the grey
    // line under it (beside it on a tablet) is the sub section, else the section.
    this.crumb.textContent = w?.claude ? 'Claude' : path.at(-1) || '';
    this.btn.classList.toggle('one-off', !!w?.oneOff);
    this.name.textContent = w ? rowName(w) : 'No presets';
    this.btn.title = w ? [...path, w.label].join(' › ') : '';
    this.btn.setAttribute('aria-label', w ? `Workflow preset: ${[...path, rowName(w)].join(', ')}` : 'Workflow preset');
  }

  // Opens on the tab of the current preset.
  open() { const cur = this.items.find((w) => w.id === this.current); if (cur) this.tab = tabOf(cur); this.render(); this.pop.hidden = false; this.scrim.hidden = false; this.btn.classList.add('open'); this.btn.setAttribute('aria-expanded', 'true'); this.pop.querySelector('.ent.on')?.scrollIntoView({ block: 'nearest' }); }
  close() { this.query = ''; this.search.value = ''; this.pop.hidden = true; this.scrim.hidden = true; this.btn.classList.remove('open'); this.btn.setAttribute('aria-expanded', 'false'); this.editing = null; }

  render() {
    const tabs = h('div.picker-tabs', { role: 'tablist' }, ...TABS.map((t) => h('button.picker-tab', {
      type: 'button', role: 'tab', 'aria-selected': String(this.tab === t.key), dataset: { tab: t.key },
      onclick: () => { this.tab = t.key; this.editing = null; this.render(); this.pop.scrollTop = 0; },
    }, t.label, h('span.cnt', {}, String(this.items.filter((w) => tabOf(w) === t.key).length)))));
    const searching = !!this.query.trim();
    const els = [h('div.mt', {}, h('i.i.i-workflow'), h('b', {}, 'AI Workflow')), h('label.picker-search-row', {}, h('i.i.i-search', { 'aria-hidden': 'true' }), this.search)];
    // While searching: matches from both tabs, and no tabs.
    if (!searching) els.push(tabs);
    const layout = searching ? pickerLayout(this.items.filter((w) => matchPreset(w, this.query))) : pickerLayout(this.items, this.tab);
    if (searching && !layout.length) els.push(h('div.ent.dis', {}, h('span.nm', {}, 'No matches')));
    if (!searching && !layout.length && this.items.length) els.push(h('div.ent.dis', {}, h('span.nm', {}, this.tab === 'workflow' ? 'No workflows yet' : 'No models found')));
    for (const { sec, rows, subs, count } of layout) {
      els.push(h('div.grp', { dataset: { section: sec.key } }, h(`i.i.${sec.icon}`), sec.label, h('span.cnt', {}, String(count))));
      for (const sub of subs) {
        els.push(h('div.sub', { dataset: { sub: sub.name }, role: 'presentation' }, sub.name));
        // Batch 5: models inside a sub section are indented one more step.
        for (const w of sub.rows) { const r = this.#row(w); r.classList.add('in-sub'); els.push(r); }
      }
      for (const w of rows) els.push(this.#row(w));
    }
    if (!this.items.length) els.push(h('div.ent.dis', {}, h('span.nm', {}, 'No presets found')));
    const focused = document.activeElement === this.search, caret = this.search.selectionStart;
    this.pop.replaceChildren(...els);
    if (focused) { this.search.focus(); try { this.search.setSelectionRange(caret, caret); } catch {} }
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
    }, h('span.nm', {}, rowName(w)), !off && presetHint(w) ? h('span.hint', {}, presetHint(w)) : null, /* batch 19: no ✓, the highlighted row shows the pick */
    w.graph ? h('button.edit.btn.text', { type: 'button', 'aria-label': `Rename, move or delete ${w.label}`, onclick: () => { this.editing = w.id; this.render(); } }, h('i.i.i-settings')) : null);
    row.classList.toggle('on', this.current === w.id);
    row.classList.toggle('dis', off);
    return row;
  }

  #editRow(w) {
    const input = h('input.input', { type: 'text', value: w.label, maxlength: 60, 'aria-label': 'Preset name' });
    // Presets saved from the node view: rename and move to another section / sub section.
    const opts = SECTIONS.flatMap((s) => (SUBGROUPS[s.key]?.length ? SUBGROUPS[s.key].map((sub) => [`${s.key}|${sub}`, `${s.label} › ${sub}`]) : [[`${s.key}|`, s.label]]));
    // Batch 15: the app's own dropdown (ui/dropdown.js); stays open after a pick.
    const want = `${sectionOf(w)}|${w.subgroup || ''}`;
    const place = dropdown({ options: opts, value: opts.some(([v]) => v === want) ? want : opts.find(([v]) => v.startsWith(sectionOf(w) + '|'))?.[0], label: 'Section', className: 'place' });
    const save = async () => {
      const n = input.value.trim(); if (!n) return toast('Name cannot be empty');
      const [group, sub] = place.value.split('|');
      await this.onEditGraph?.(w, { name: n, group, subgroup: sub || null });
      this.editing = null; if (!this.pop.hidden) this.render();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { this.editing = null; this.render(); } });
    // No keyboard on open (found on the phone: it covered the "Move to" row);
    // just bring both rows into view.
    setTimeout(() => this.pop.querySelector('.ent-edit-wrap')?.scrollIntoView({ block: 'nearest' }), 0);
    let confirmDel = false;
    const del = h('button.btn.text.danger-text', { type: 'button', onclick: async () => {
      if (!confirmDel) { confirmDel = true; del.textContent = 'Tap again to delete'; return; }
      await this.onDelete(w); this.editing = null; if (!this.pop.hidden) this.render();
    } }, h('i.i.i-trash-2'), 'Delete');
    const row = h('div.ent.editing', { dataset: { preset: w.id } }, input,
      h('button.btn.text', { type: 'button', onclick: save }, h('i.i.i-check'), 'Save'), del,
      h('button.btn.text', { type: 'button', 'aria-label': 'Cancel', onclick: () => { this.editing = null; this.render(); } }, h('i.i.i-x')));
    return h('div.ent-edit-wrap', { dataset: { preset: w.id } }, row, h('div.ent.editing.place-row', {}, h('span.muted', {}, 'Move to'), place));
  }
}
