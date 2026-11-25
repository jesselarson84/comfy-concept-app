// save-preset.js - "Save as preset" from the node view.
// -----------------------------------------------------------------------------
// The Save preset button (top bar, node view only) takes the graph on ComfyUI's
// canvas (app.graphToPrompt, API format) and opens a bottom sheet:
//   Name · Section (3D / Image / Video / Audio / My presets) · Sub section
//   (only for sections that have them: Image) · the controls the app found in
//   the graph (what the form will show) · Save
// When the canvas shows one of YOUR saved presets the sheet offers Update
// (overwrite it) or Save as new. Built-in presets are never overwritten: saving
// from one always makes a new preset.
// -----------------------------------------------------------------------------
import { h, toast } from './dom.js';
import { detectControls } from '../lib/workflow-detect.js';
import { SUBGROUPS } from '../lib/presets.js';
import { SECTIONS } from './workflow-picker.js';
import { dropdown } from './dropdown.js';

/** Human list of what the form will show for a graph. */
export function controlSummary(c) {
  if (!c?.ok) return [];
  const out = [];
  if (c.prompt.length) out.push('Prompt');
  if (c.negative.length) out.push('Negative');
  if (c.images.length) out.push(c.images.length > 1 ? `${c.images.length} pictures` : 'Picture');
  if (c.width.length && c.height.length) out.push('Aspect');
  if (c.seed.length) out.push('Seed');
  if (c.steps.length) out.push('Steps');
  if (c.strength.length) out.push('Strength');
  return out;
}

export class SavePresetSheet {
  /**
   * @param o.getGraph()  async -> API graph from the canvas (or throws)
   * @param o.target()    -> { id, label, group, subgroup, graph?, ai? } the preset the canvas was opened from
   * @param o.save({ mode: 'new' | 'update', id?, name, group, subgroup, workflow })  async -> saved preset
   */
  constructor({ getGraph, target, save }) {
    Object.assign(this, { getGraph, target, save });
  }

  async open() {
    let workflow;
    try { workflow = await this.getGraph(); } catch (e) { toast('Could not read the canvas: ' + e.message, 6000); return; }
    const c = detectControls(workflow);
    const t = this.target() || {};
    const mine = !!t.graph; // one of the user's saved presets -> Update is possible
    const name = h('input.sheet-input', { type: 'text', maxlength: 60, value: mine ? t.label : t.label ? `${t.label} copy` : 'My preset', 'aria-label': 'Preset name' });
    // Batch 15: the app's own dropdowns (ui/dropdown.js); they stay open after a pick.
    const section = dropdown({ options: SECTIONS.map((s) => [s.key, s.label]), value: SECTIONS.some((s) => s.key === t.group) ? t.group : 'My presets', label: 'Section' });
    const sub = dropdown({ label: 'Sub section' });
    const subRow = h('div.sp-row', {}, h('span.sp-label', {}, 'Sub section'), sub);
    const paintSub = () => {
      const subs = SUBGROUPS[section.value] || [];
      sub.setOptions(subs);
      subRow.hidden = !subs.length;
      if (subs.length) sub.value = subs.includes(t.subgroup) ? t.subgroup : subs[0];
    };
    section.addEventListener('change', paintSub);
    paintSub();
    const found = controlSummary(c);
    const controls = h('div.sp-controls', {},
      h('span.sp-label', {}, 'The form will show'),
      h('div.sp-chips', {}, ...(found.length ? found.map((x) => h('span.sp-chip', {}, x)) : [h('span.muted', {}, 'No controls found: it runs exactly as built')])),
      c.ok ? null : h('p.sp-warn', {}, c.error));
    const go = async (mode) => {
      const n = name.value.trim();
      if (!n) { toast('Give it a name'); name.focus(); return; }
      busy(true);
      try {
        const g = await this.save({ mode, id: mode === 'update' ? t.graph.id : undefined, name: n, group: section.value, subgroup: subRow.hidden ? null : sub.value, workflow });
        this.close();
        const where = [section.value, subRow.hidden ? null : sub.value].filter(Boolean).join(' › ');
        toast(`${mode === 'update' ? 'Updated' : 'Saved'} "${g?.name || n}" in ${where}`, 5000);
      } catch (e) { toast(e.message, 8000); busy(false); }
    };
    const btn = (label, act, cls, fn) => h(`button.btn${cls}`, { type: 'button', dataset: { act }, onclick: fn }, label);
    const actions = mine
      ? [btn('Save as new', 'save-new', '', () => go('new')), btn('Update', 'update', '.primary', () => go('update'))]
      : [btn('Save', 'save', '.primary', () => go('new'))];
    const busy = (on) => { for (const b of actions) b.disabled = on; };
    this.close();
    this.scrim = h('div.sheet-scrim', { onclick: () => this.close() });
    this.el = h('div.sheet.save-preset', { role: 'dialog', 'aria-label': 'Save as preset' },
      h('div.sheet-title', {}, mine ? `Save "${t.label}"` : 'Save as preset'),
      mine ? null : t.ai ? h('p.sp-note.muted', {}, `${t.label} itself stays as it is; this saves a new preset.`) : null,
      h('label.sp-row', {}, h('span.sp-label', {}, 'Name'), name),
      h('div.sp-row', {}, h('span.sp-label', {}, 'Section'), section),
      subRow, controls,
      h('div.sp-actions', {}, btn('Cancel', 'cancel', '', () => this.close()), ...actions));
    this.el.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') this.close(); if (e.key === 'Enter' && e.target === name) actions.at(-1).click(); });
    document.body.append(this.scrim, this.el);
  }

  get isOpen() { return !!this.el?.isConnected; }
  close() { this.scrim?.remove(); this.el?.remove(); this.scrim = this.el = null; }
}
