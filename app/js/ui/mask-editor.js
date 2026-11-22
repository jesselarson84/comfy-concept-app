// mask-editor.js - paint the area an inpaint preset repaints (white = repaint).
// MaskSlot is the small block under the picture slot (preview, Paint, clear);
// MaskEditor is the full-screen painter:
//   - Pointer Events with coalesced points and a desynchronized 2D canvas for
//     low-latency strokes; light smoothing; round caps.
//   - Pen pressure (switchable), the pen's eraser end or barrel button erases,
//     palm rejection (touches are ignored while a pen is in use / big contacts).
//   - Two fingers pinch-zoom and pan and never paint (a stroke a first finger
//     started is undone when the second finger lands); mouse wheel zooms.
//   - Hover cursor ring (mouse and hovering pen) at the real brush size.
//   - Re-fits on rotation / resize; side toolbar on tablets in landscape.
//   - Undo, Clear, Invert. The mask is exported at the picture's own size.
import { h, toast } from './dom.js';
import { Overlay, overlayTop } from './overlay.js';
import { inputViewUrl } from '../comfy-client.js';
import { isEraserPointer, isPalm, brushWidth, smoothPoint, pinchView, fitView, toImage, maskPixels } from '../lib/mask-paint.js';

const PAINT = '#fd9903';
const UNDO_MAX = 8;

export class MaskEditor {
  constructor() {
    this.ov = new Overlay('mask-editor', 'Mask');
    this.ov.onClose = () => this.endStroke(true);
    this.size = Number(localStorage.getItem('maskBrush') || 48); // screen px
    this.pressure = localStorage.getItem('maskPressure') !== '0';
    this.tool = 'brush';
    this.view = { scale: 1, x: 0, y: 0 };
    this.userView = false;
    this.undo = [];
    this.touches = new Map();
    this.penActiveAt = 0;
    this.stroke = null;
    this.gesture = null;
    this.build();
  }

  build() {
    const r = this.ov.root;
    this.img = h('img.me-img', { alt: '', draggable: false });
    this.canvas = h('canvas.me-paint');
    this.layer = h('div.me-layer', {}, this.img, this.canvas);
    this.cursor = h('div.me-cursor', { hidden: true });
    this.stage = h('div.me-stage', {}, this.layer, this.cursor);
    const tool = (id, label) => h('button.seg-btn', { type: 'button', dataset: { tool: id }, 'aria-pressed': String(this.tool === id), onclick: () => this.setTool(id) }, label);
    this.toolSeg = h('div.me-seg', { role: 'group', 'aria-label': 'Tool' }, tool('brush', 'Brush'), tool('eraser', 'Eraser'));
    this.sizeIn = h('input.me-size', { type: 'range', min: 4, max: 200, step: 1, value: this.size, 'aria-label': 'Brush size', oninput: (e) => { this.size = Number(e.target.value); localStorage.setItem('maskBrush', this.size); this.paintSize(); } });
    this.pressBtn = h('button.btn.me-pressure', { type: 'button', 'aria-pressed': String(this.pressure), onclick: () => { this.pressure = !this.pressure; localStorage.setItem('maskPressure', this.pressure ? '1' : '0'); this.pressBtn.setAttribute('aria-pressed', String(this.pressure)); } }, 'Pressure');
    const tools = h('div.me-tools', {},
      this.toolSeg,
      h('label.me-size-row', {}, h('span', {}, 'Size'), this.sizeIn),
      this.pressBtn,
      h('button.btn', { type: 'button', dataset: { act: 'invert' }, onclick: () => this.invert() }, 'Invert'),
      h('button.btn', { type: 'button', dataset: { act: 'clear' }, onclick: () => this.clear() }, 'Clear'));
    this.undoBtn = h('button.btn', { type: 'button', dataset: { act: 'undo' }, disabled: true, onclick: () => this.popUndo() }, 'Undo');
    this.doneBtn = h('button.btn', { type: 'button', dataset: { act: 'done' }, onclick: () => this.done() }, 'Done');
    r.append(overlayTop('Mask', () => this.ov.close(), this.undoBtn, this.doneBtn), h('div.me-body', {}, this.stage, tools));

    const s = this.stage;
    s.addEventListener('pointerdown', (e) => this.down(e));
    s.addEventListener('pointermove', (e) => this.move(e));
    s.addEventListener('pointerup', (e) => this.up(e));
    s.addEventListener('pointercancel', (e) => this.up(e, true));
    s.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') this.cursor.hidden = true; });
    s.addEventListener('contextmenu', (e) => e.preventDefault());
    s.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = s.getBoundingClientRect();
      const p = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const k = Math.exp(-e.deltaY * 0.0015);
      const scale = Math.min(16, Math.max(0.05, this.view.scale * k));
      const f = scale / this.view.scale;
      this.setView({ scale, x: p.x - (p.x - this.view.x) * f, y: p.y - (p.y - this.view.y) * f }, true);
    }, { passive: false });
    new ResizeObserver(() => { if (!this.ov.root.hidden) this.refit(); }).observe(s);
  }

  /** Opens for a picture (LoadImage ref). Same picture -> the painting is kept. */
  async open(sourceRef, onDone) {
    this.onDone = onDone;
    this.ov.show();
    if (this.source !== sourceRef) {
      this.source = sourceRef;
      this.undo = []; this.undoBtn.disabled = true;
      await new Promise((res, rej) => { this.img.onload = res; this.img.onerror = () => rej(new Error('Could not load the picture')); this.img.src = inputViewUrl(sourceRef); })
        .catch((e) => { toast(e.message); this.ov.close(); throw e; });
      this.w = this.img.naturalWidth; this.h = this.img.naturalHeight;
      this.canvas.width = this.w; this.canvas.height = this.h;
      this.layer.style.width = `${this.w}px`; this.layer.style.height = `${this.h}px`;
      this.ctx = this.canvas.getContext('2d', { desynchronized: true });
      this.userView = false;
    }
    this.refit(true);
  }

  refit(force) {
    const r = this.stage.getBoundingClientRect();
    if (!this.w || !r.width) return;
    if (force || !this.userView) this.setView(fitView(this.w, this.h, r.width, r.height), false);
    else {
      // Rotation: keep the zoom, keep the picture centre in view.
      const c = toImage(this.view, (this.lastBox?.width || r.width) / 2, (this.lastBox?.height || r.height) / 2);
      this.setView({ scale: this.view.scale, x: r.width / 2 - c.x * this.view.scale, y: r.height / 2 - c.y * this.view.scale }, true);
    }
    this.lastBox = { width: r.width, height: r.height };
  }

  setView(v, user) {
    this.view = v;
    if (user) this.userView = true;
    this.layer.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.scale})`;
    this.paintSize();
  }

  setTool(t) {
    this.tool = t;
    for (const b of this.toolSeg.children) b.setAttribute('aria-pressed', String(b.dataset.tool === t));
  }

  paintSize() { this.cursor.style.width = this.cursor.style.height = `${this.size}px`; }

  local(e) { const r = this.stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

  showCursor(e) {
    if (e.pointerType === 'touch') { this.cursor.hidden = true; return; }
    const p = this.local(e);
    this.cursor.hidden = false;
    this.cursor.style.transform = `translate(${p.x - this.size / 2}px, ${p.y - this.size / 2}px)`;
    this.cursor.classList.toggle('erase', this.tool === 'eraser' || isEraserPointer(e));
  }

  down(e) {
    if (!this.ctx) return;
    if (e.pointerType === 'pen') this.penActiveAt = Date.now();
    if (e.pointerType === 'touch') {
      if (isPalm(e, { penActiveAt: this.penActiveAt })) return;
      this.touches.set(e.pointerId, this.local(e));
      if (this.touches.size >= 2) { this.startGesture(); return; }
      if (this.gesture || this.touchLock) return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    try { this.stage.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    this.pushUndo();
    const erase = this.tool === 'eraser' || isEraserPointer(e);
    const p = { ...toImage(this.view, ...Object.values(this.local(e))), w: brushWidth(this.size, e, this.pressure) / this.view.scale };
    this.stroke = { id: e.pointerId, type: e.pointerType, erase, last: p };
    this.dab(p, erase);
    this.showCursor(e);
  }

  move(e) {
    if (e.pointerType === 'pen') this.penActiveAt = Date.now();
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, this.local(e));
      if (this.gesture) { this.updateGesture(); return; }
    }
    this.showCursor(e);
    const s = this.stroke;
    if (!s || s.id !== e.pointerId) return;
    const events = e.getCoalescedEvents?.() || [];
    for (const ev of events.length ? events : [e]) {
      const raw = { ...toImage(this.view, ...Object.values(this.local(ev))), w: brushWidth(this.size, ev, this.pressure) / this.view.scale };
      const p = smoothPoint(s.last, raw);
      this.segment(s.last, p, s.erase);
      s.last = p;
    }
  }

  up(e, cancelled) {
    if (e.pointerType === 'touch') {
      this.touches.delete(e.pointerId);
      if (this.gesture && this.touches.size < 2) { this.gesture = null; this.touchLock = this.touches.size > 0; }
      if (!this.touches.size) this.touchLock = false;
    }
    if (this.stroke?.id === e.pointerId) this.endStroke(cancelled);
  }

  endStroke(cancel) {
    if (!this.stroke) return;
    if (cancel) this.popUndo();
    this.stroke = null;
  }

  startGesture() {
    // A finger that started painting just before the second one landed: undo it.
    if (this.stroke?.type === 'touch') this.endStroke(true);
    const [a, b] = [...this.touches.values()];
    this.gesture = { view0: { ...this.view }, a0: a, b0: b };
    this.cursor.hidden = true;
  }

  updateGesture() {
    const [a, b] = [...this.touches.values()];
    if (!a || !b) return;
    const g = this.gesture;
    this.setView(pinchView(g.view0, g.a0, g.b0, a, b, { min: 0.05, max: 16 }), true);
  }

  dab(p, erase) { this.segment(p, p, erase); }

  segment(a, b, erase) {
    const c = this.ctx;
    c.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
    c.strokeStyle = PAINT; c.lineCap = 'round'; c.lineJoin = 'round';
    c.lineWidth = Math.max(1, (a.w + b.w) / 2);
    c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x + (a === b ? 0.01 : 0), b.y); c.stroke();
    c.globalCompositeOperation = 'source-over';
  }

  pushUndo() {
    this.undo.push(this.ctx.getImageData(0, 0, this.w, this.h));
    if (this.undo.length > UNDO_MAX) this.undo.shift();
    this.undoBtn.disabled = false;
  }

  popUndo() {
    const d = this.undo.pop();
    if (d) this.ctx.putImageData(d, 0, 0);
    this.undoBtn.disabled = !this.undo.length;
  }

  clear() { if (!this.ctx) return; this.pushUndo(); this.ctx.clearRect(0, 0, this.w, this.h); }

  invert() {
    if (!this.ctx) return;
    this.pushUndo();
    const c = this.ctx;
    c.globalCompositeOperation = 'xor'; c.fillStyle = PAINT; c.fillRect(0, 0, this.w, this.h);
    c.globalCompositeOperation = 'source-over';
  }

  /** Black/white PNG at the picture's size + a small preview (picture + tint). */
  async exportMask() {
    const { data, painted } = maskPixels(this.ctx.getImageData(0, 0, this.w, this.h).data);
    const out = h('canvas'); out.width = this.w; out.height = this.h;
    out.getContext('2d').putImageData(new ImageData(data, this.w, this.h), 0, 0);
    const blob = await new Promise((res) => out.toBlob(res, 'image/png'));
    const pw = 160, ph = Math.max(1, Math.round(160 * this.h / this.w));
    const pv = h('canvas'); pv.width = pw; pv.height = ph;
    const pc = pv.getContext('2d');
    pc.drawImage(this.img, 0, 0, pw, ph); pc.globalAlpha = 0.6; pc.drawImage(this.canvas, 0, 0, pw, ph);
    return { file: new File([blob], 'mask.png', { type: 'image/png' }), painted, preview: pv.toDataURL('image/png') };
  }

  async done() {
    if (!this.ctx) return;
    const r = await this.exportMask();
    if (!r.painted) { toast('Nothing painted'); return; }
    this.doneBtn.disabled = true;
    try { await this.onDone?.(r); this.ov.close(); } catch (e) { toast(e.message, 6000); } finally { this.doneBtn.disabled = false; }
  }
}

/** The block under the picture: mask preview, Paint, clear. */
export class MaskSlot {
  constructor(container, comfy) {
    this.container = container; this.comfy = comfy;
    this.editor = null;
    this.spec = null; this.source = undefined; this.value = null; this.preview = null;
  }

  /** spec = preset manifest.mask (or null), source = the picture's LoadImage ref. */
  render(spec, source) {
    if (source !== this.source && this.source !== undefined) { this.value = null; this.preview = null; } // the mask belongs to one picture
    this.spec = spec; this.source = source || null;
    this.container.replaceChildren();
    this.container.hidden = !spec;
    if (!spec) return;
    const src = this.preview || (this.value ? inputViewUrl(this.value) : '');
    const pv = h('img.ref-preview', { alt: 'mask', hidden: !src });
    if (src) pv.src = src;
    const empty = h('i.i.i-image.ref-empty', { 'aria-hidden': 'true', hidden: !!src });
    this.container.append(h('div.ref-slot.mask-slot', { dataset: { mask: spec.node } },
      h('div.ref-head', {}, h('span', {}, 'Mask'), this.value ? h('button.link', { type: 'button', onclick: () => { this.value = null; this.preview = null; this.render(this.spec, this.source); } }, 'clear') : null),
      h('div.ref-body', {}, pv, empty),
      h('div.ref-buttons.one', {}, h('button.btn', { type: 'button', dataset: { act: 'paint' }, disabled: !this.source, onclick: () => this.paint() }, 'Paint'))));
  }

  async paint() {
    if (!this.source) return;
    this.editor = this.editor || new MaskEditor();
    const source = this.source;
    await this.editor.open(source, async (r) => {
      const up = await this.comfy.uploadImage(r.file, 'mask.png');
      if (this.source !== source) return;
      this.value = up.ref; this.preview = r.preview;
      this.render(this.spec, this.source);
    }).catch(() => {});
  }

  missing() { return !!this.spec && !this.value; }
  apply(workflow) { if (this.spec && this.value && workflow[this.spec.node]) workflow[this.spec.node].inputs.image = this.value; }
}
