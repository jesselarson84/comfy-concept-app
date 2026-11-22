// preset-chooser.js - "Use as reference" when the current preset has no image
// input: a short list of the presets that take a picture (3D and Image Edit),
// then the picked one is selected and the picture goes into its slot.
import { h } from './dom.js';
import { Overlay, overlayTop } from './overlay.js';
import { pickerLayout, rowName } from './workflow-picker.js';

export class PresetChooser {
  constructor() {
    this.ov = new Overlay('preset-chooser', 'Use as reference');
    this.list = h('div.pc-list');
    this.ov.root.append(overlayTop('Use as reference', () => this.close()), this.list);
  }

  get root() { return this.ov.root; }
  close() { this.ov.close(); }

  /** presets: workflow items; onPick(w). */
  open(presets, onPick) {
    const els = [];
    const row = (w) => h('button.ent', { type: 'button', dataset: { preset: w.id }, onclick: () => { this.close(); onPick(w); } }, h('span.nm', {}, rowName(w)));
    for (const { sec, rows, subs } of pickerLayout(presets)) {
      els.push(h('div.grp', {}, h(`i.i.${sec.icon}`), sec.label));
      for (const sub of subs) { els.push(h('div.sub', { dataset: { sub: sub.name } }, sub.name)); els.push(...sub.rows.map(row)); }
      els.push(...rows.map(row));
    }
    this.list.replaceChildren(...els);
    this.ov.show();
  }
}
