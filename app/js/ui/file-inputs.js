// file-inputs.js - upload slots for inputs that are not pictures (the video
// presets' LoadVideo node). The file goes to ComfyUI's /upload/image (which
// stores any file in input/; ComfyUI's own frontend uploads videos the same
// way) and the returned name is written into the node's input.
import { h, toast } from './dom.js';

const ACCEPT = { video: 'video/*', audio: 'audio/*' };

export class FileInputs {
  constructor(container, comfy) { this.container = container; this.comfy = comfy; this.values = {}; this.slots = []; }

  key(s) { return `${s.node}.${s.input}`; }

  render(slots = []) {
    this.slots = slots;
    this.container.replaceChildren();
    this.container.hidden = !slots.length;
    for (const s of slots) {
      const k = this.key(s), set = this.values[k];
      const fileIn = h('input', { type: 'file', accept: ACCEPT[s.kind] || '*/*', hidden: true, onchange: (e) => e.target.files[0] && this.upload(s, e.target.files[0]) });
      this.container.append(h('div.ref-slot', { dataset: { input: k } },
        h('div.ref-head', {}, h('span', {}, s.label || s.kind), set ? h('button.link', { onclick: () => { delete this.values[k]; this.render(this.slots); } }, 'clear') : null),
        h('div.ref-body', {}, h('span.ref-empty', {}, set ? set : s.defaultAvailable ? `Using ${s.default}` : '')),
        h('div.ref-buttons.one', {}, h('button.btn', { onclick: () => fileIn.click() }, `Pick ${s.kind}`)),
        fileIn));
    }
  }

  async upload(slot, file) {
    const box = this.container.querySelector(`[data-input="${this.key(slot)}"]`);
    box?.classList.add('busy');
    try { this.values[this.key(slot)] = (await this.comfy.uploadImage(file)).ref; this.render(this.slots); } catch (e) { toast(e.message); } finally { box?.classList.remove('busy'); }
  }

  set(slot, ref) { this.values[this.key(slot)] = ref; this.render(this.slots); }
  missing() { return this.slots.filter((s) => !this.values[this.key(s)] && !s.defaultAvailable); }
  /** Write the uploaded names into a graph copy. */
  apply(graph) { for (const s of this.slots) { const v = this.values[this.key(s)]; if (v && graph[s.node]) graph[s.node].inputs[s.input] = v; } return graph; }
}
