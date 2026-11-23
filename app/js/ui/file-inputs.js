// file-inputs.js - upload slots for inputs that are not pictures (the video
// presets' LoadVideo node). The file goes to ComfyUI's /upload/image (which
// stores any file in input/; ComfyUI's own frontend uploads videos the same
// way) and the returned name is written into the node's input.
import { h, toast } from './dom.js';
import { infoButton } from './info-tip.js';
import { startRecording } from '../lib/recorder.js';

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
      // Batch 8: video slots can record straight from the camera too (the system camera app).
      const camIn = s.kind === 'video' ? h('input', { type: 'file', accept: 'video/*', capture: 'environment', hidden: true, onchange: (e) => e.target.files[0] && this.upload(s, e.target.files[0]) }) : null;
      this.container.append(h('div.ref-slot', { dataset: { input: k } },
        h('div.ref-head', {}, h('span.ref-title', {}, h('span', {}, s.label || s.kind), infoButton(s.label || s.kind, s.info)), set ? h('button.link', { onclick: () => { delete this.values[k]; this.render(this.slots); } }, 'clear') : null),
        h('div.ref-body', {}, h('span.ref-empty', {}, set ? set : s.defaultAvailable ? `Using ${s.default}` : '')),
        // audio slots (batch 7, voice swap): record straight from the microphone too
        h(`div.ref-buttons${s.kind === 'audio' || camIn ? '' : '.one'}`, {}, h('button.btn', { onclick: () => fileIn.click() }, `Pick ${s.kind}`),
          s.kind === 'audio' ? h('button.btn.rec-btn', { type: 'button', dataset: { act: 'record' }, onclick: (e) => this.toggleRecord(s, e.currentTarget) }, this.recording?.slot === k ? 'Stop ●' : 'Record') : null,
          camIn ? h('button.btn', { type: 'button', dataset: { act: 'record-video' }, onclick: () => camIn.click() }, 'Record video') : null),
        fileIn, camIn));
    }
  }

  async upload(slot, file) {
    const box = this.container.querySelector(`[data-input="${this.key(slot)}"]`);
    box?.classList.add('busy');
    try { this.values[this.key(slot)] = (await this.comfy.uploadImage(file)).ref; this.render(this.slots); } catch (e) { toast(e.message); } finally { box?.classList.remove('busy'); }
  }

  /** Record into an audio slot: first tap starts, second tap stops and uploads. */
  async toggleRecord(slot, btn) {
    if (this.recording) {
      const r = this.recording; this.recording = null;
      try { await this.upload(slot, await r.rec.stop()); } catch (e) { toast(e.message, 6000); this.render(this.slots); }
      return;
    }
    try { this.recording = { slot: this.key(slot), rec: await startRecording() }; btn.textContent = 'Stop ●'; btn.classList.add('on'); toast('Recording… tap Stop when done'); } catch (e) { toast(e.message, 7000); }
  }

  set(slot, ref) { this.values[this.key(slot)] = ref; this.render(this.slots); }
  missing() { return this.slots.filter((s) => !this.values[this.key(s)] && !s.defaultAvailable && !s.optional); }
  /** Nodes of the slots that have a file (optional slots left empty are dropped from the graph). */
  filled() { return this.slots.filter((s) => this.values[this.key(s)]).map((s) => s.node); }
  /** Write the uploaded names into a graph copy. */
  apply(graph) { for (const s of this.slots) { const v = this.values[this.key(s)]; if (v && graph[s.node]) graph[s.node].inputs[s.input] = v; } return graph; }
}
