// preset-chooser.js - "Use as reference" when the current preset has no image
// input: a short list of the presets that take a picture (3D and Image Edit),
// then the picked one is selected and the picture goes into its slot.
import { h } from './dom.js';
import { Overlay, overlayTop } from './overlay.js';
import { SECTIONS, sectionOf } from './workflow-picker.js';

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
    for (const sec of SECTIONS) {
      const rows = presets.filter((w) => sectionOf(w) === sec.key);
      if (!rows.length) continue;
      els.push(h('div.grp', {}, h(`i.i.${sec.icon}`), sec.label));
      for (const w of rows) els.push(h('button.ent', { type: 'button', dataset: { preset: w.id }, onclick: () => { this.close(); onPick(w); } }, h('span.nm', {}, w.label)));
    }
    this.list.replaceChildren(...els);
    this.ov.show();
  }
}
