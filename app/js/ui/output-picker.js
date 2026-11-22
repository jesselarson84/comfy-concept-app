// output-picker.js - "From Comfy UI": a grid of generated pictures to load into
// a reference slot. This session's results first, then earlier ones from the
// PC (server /api/outputs: output/concept-app/ + history), newest first, in
// pages as you scroll. Tiles are ComfyUI's small webp previews (lazy loaded);
// the picked picture itself is loaded at full resolution by reference.js.
import { h, toast } from './dom.js';
import { viewUrl } from '../comfy-client.js';
import { getOutputs } from '../api.js';
import { Overlay, overlayTop } from './overlay.js';

const PAGE = 60;
const keyOf = (f) => `${f.type || 'output'}/${f.subfolder || ''}/${f.filename}`;

export class OutputPicker {
  constructor() {
    this.ov = new Overlay('output-picker', 'From Comfy UI');
    this.ov.onClose = () => { this.io?.disconnect(); this.token = null; };
    this.grid = h('div.op-grid');
    this.more = h('div.op-more');
    this.ov.root.append(overlayTop('From Comfy UI', () => this.close()), h('div.op-scroll', {}, this.grid, this.more));
  }

  get root() { return this.ov.root; }
  close() { this.ov.close(); }

  /** session: () => [{ filename, subfolder, type }] newest first; onPick(img). */
  open({ session = () => [], onPick }) {
    this.onPick = onPick;
    this.seen = new Set();
    this.offset = 0; this.done = false; this.loading = false;
    this.grid.replaceChildren();
    this.more.textContent = '';
    this.token = {};
    this.ov.show();
    this.#add(session());
    this.io?.disconnect();
    this.io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) this.#page(); }, { root: this.ov.root.querySelector('.op-scroll'), rootMargin: '400px' });
    this.io.observe(this.more);
    this.#page();
  }

  #add(list) {
    for (const f of list) {
      if (!f?.filename) continue;
      const k = keyOf(f);
      if (this.seen.has(k)) continue;
      this.seen.add(k);
      const img = { filename: f.filename, subfolder: f.subfolder || '', type: f.type || 'output' };
      this.grid.append(h('button.thumb.s-done.op-tile', { type: 'button', title: img.filename, dataset: { file: k }, onclick: () => { this.close(); this.onPick?.(img); } },
        h('img', { src: viewUrl(img, { thumb: true }), loading: 'lazy', decoding: 'async', alt: '' })));
    }
    this.more.textContent = this.grid.children.length || this.loading ? '' : 'Nothing generated yet.';
  }

  async #page() {
    if (this.loading || this.done || !this.token) return;
    this.loading = true;
    const token = this.token;
    try {
      const r = await getOutputs({ kind: 'image', offset: this.offset, limit: PAGE });
      if (token !== this.token) return;
      this.offset += r.items.length;
      this.done = !r.items.length || this.offset >= r.total;
      this.loading = false;
      this.#add(r.items);
    } catch (e) {
      if (token !== this.token) return;
      this.done = true; this.loading = false;
      toast(e.message, 6000);
      this.#add([]);
    }
  }
}
