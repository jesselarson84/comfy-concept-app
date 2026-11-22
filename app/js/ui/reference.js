// reference.js - reference image slots (one per LoadImage node).
// A picture can come from: file picker, camera, paste (Ctrl+V / long-press
// paste), "From Comfy UI" (a grid of the app's own results, ui/output-picker.js),
// "Use as reference" in the viewer, or the Android share sheet (see
// server/share.js). Either way the full-resolution file is uploaded to
// ComfyUI's /upload/image and the returned name is what the LoadImage node gets.
import { h, toast } from './dom.js';
import { inputViewUrl, viewUrl } from '../comfy-client.js';

export class ReferenceSlots {
  constructor(container, comfy, onChange) {
    this.container = container; this.comfy = comfy; this.onChange = onChange;
    this.values = {};        // nodeId -> LoadImage value ("name.png")
    this.slots = [];
    this.active = null;      // slot that receives a paste
    this.onPickFromComfy = null; // (node) => opens the "From Comfy UI" grid (set by main.js)
    document.addEventListener('paste', (e) => {
      if (!this.slots.length) return;
      const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
      if (!file) return;
      e.preventDefault();
      this.upload(this.active || this.slots[0].node, file);
    });
  }

  render(slots) {
    this.slots = slots;
    this.container.replaceChildren();
    this.container.hidden = !slots.length;
    for (const slot of slots) {
      const preview = h('img.ref-preview', { alt: 'reference' });
      const empty = h('i.i.i-image.ref-empty', { 'aria-hidden': 'true' });
      const set = this.values[slot.node];
      if (set) { preview.src = inputViewUrl(set); empty.hidden = true; } else preview.hidden = true;
      const fileIn = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: (e) => e.target.files[0] && this.upload(slot.node, e.target.files[0]) });
      const camIn = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true, onchange: (e) => e.target.files[0] && this.upload(slot.node, e.target.files[0]) });
      const label = slots.length > 1 ? (slot.title || `Image ${slot.node}`).replace(/#\w+/g, '').trim() : 'Reference image';
      const box = h('div.ref-slot', { dataset: { node: slot.node }, onpointerdown: () => { this.active = slot.node; } },
        h('div.ref-head', {}, h('span', {}, label), set ? h('button.link', { onclick: () => { delete this.values[slot.node]; this.render(this.slots); this.onChange?.(); } }, 'clear') : null),
        h('div.ref-body', {}, preview, empty),
        h('div.ref-buttons', {},
          h('button.btn', { onclick: () => fileIn.click() }, 'Pick'),
          h('button.btn', { onclick: () => camIn.click() }, 'Camera'),
          h('button.btn', { onclick: () => this.pasteFromClipboard(slot.node) }, 'Paste'),
          h('button.btn', { dataset: { from: 'comfy' }, onclick: () => this.onPickFromComfy?.(slot.node) }, 'From Comfy UI')),
        fileIn, camIn);
      this.container.append(box);
    }
  }

  async pasteFromClipboard(node) {
    try {
      // Async Clipboard API (needs HTTPS; asks permission on Android).
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (type) { const blob = await item.getType(type); return this.upload(node, new File([blob], 'pasted.' + type.split('/')[1], { type })); }
      }
      toast('No image on the clipboard');
    } catch { toast('Clipboard not available'); }
  }

  async upload(node, file) {
    const box = this.container.querySelector(`[data-node="${node}"]`);
    box?.classList.add('busy');
    try {
      const r = await this.comfy.uploadImage(file);
      this.values[node] = r.ref;
      this.render(this.slots);
      this.onChange?.();
    } catch (e) { toast(e.message); } finally { box?.classList.remove('busy'); }
  }

  set(node, ref) { this.values[node] = ref; this.render(this.slots); }

  /** One of ComfyUI's results ({ filename, subfolder, type }) -> this slot, at full
   *  resolution: the original file is fetched (no preview/thumbnail) and uploaded
   *  to ComfyUI's input folder like a picked file. */
  async useImage(node, img) {
    const box = this.container.querySelector(`[data-node="${node}"]`);
    box?.classList.add('busy');
    try {
      const r = await fetch(viewUrl(img));
      if (!r.ok) throw new Error(`Could not load ${img.filename} (${r.status})`);
      const blob = await r.blob();
      await this.upload(node, new File([blob], img.filename, { type: blob.type || 'image/png' }));
      return this.values[node];
    } catch (e) { toast(e.message, 6000); return null; } finally { box?.classList.remove('busy'); }
  }

  /** Slot for an incoming picture: the one last touched, else the first empty, else the first. */
  targetNode() {
    if (this.active && this.slots.some((s) => s.node === this.active)) return this.active;
    return (this.slots.find((s) => !this.values[s.node]) || this.slots[0])?.node;
  }
  missing() { return this.slots.filter((s) => !this.values[s.node]); }
}
