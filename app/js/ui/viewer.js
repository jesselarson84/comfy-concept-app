// viewer.js - full-screen image viewer.
// -----------------------------------------------------------------------------
// Gestures (all with Pointer Events, which unify touch, mouse and pen):
//   swipe left/right  -> next / previous image (only when not zoomed in)
//   pinch             -> zoom around the fingers' midpoint
//   drag when zoomed  -> pan
//   double-tap        -> toggle 1x / 2.5x at the tapped point
//   single tap        -> show/hide the controls (waits 250ms to rule out a double-tap)
// The list of images is read through getItems() every time, so images that
// finish while the viewer is open simply become swipeable.
// -----------------------------------------------------------------------------
import { h, toast } from './dom.js';
import { viewUrl } from '../comfy-client.js';
import { bridge, has, absoluteUrl } from '../native.js';

export class Viewer {
  /**
   * getItems(): array of { image, meta, favorite, historyId }
   * hooks: { onFavorite(item), onReuse(item), onDiscuss(item), onUseAsReference(item), onSaveToDrive(item) }
   */
  constructor(hooks) {
    this.hooks = hooks;
    this.getItems = () => [];
    this.index = 0;
    this.build();
  }

  build() {
    this.img = h('img.viewer-img', { alt: '' });
    // A native image drag would steal the pointer (pointercancel) mid-swipe.
    this.img.draggable = false;
    // (Dragging a text selection would do the same - see the stage listener.)
    this.stage = h('div.viewer-stage', {}, this.img);
    this.stage.addEventListener('dragstart', (e) => e.preventDefault());
    this.counter = h('span.viewer-counter');
    this.caption = h('div.viewer-caption');
    this.favBtn = h('button.icon-btn', { title: 'Favorite', 'aria-label': 'Favorite', onclick: () => this.favorite() }, '☆');
    const btn = (label, title, fn) => h('button.icon-btn', { title, 'aria-label': title, onclick: fn }, label);
    this.top = h('div.viewer-top', {}, btn('✕', 'Close', () => this.close()), this.counter, h('span.spacer'), this.favBtn);
    this.bottom = h('div.viewer-bottom', {},
      this.caption,
      h('div.viewer-actions', {},
        btn('↓ Save', 'Save to device', () => this.save()),
        btn('↪ Share', 'Share', () => this.share()),
        btn('↻ Reuse', 'Reuse prompt + seed', () => { const it = this.current(); if (it) { this.close(); this.hooks.onReuse?.(it); } }),
        // Discuss: attach this image (+ its prompt and seed) to the Prompt
        // assistant chat, to say what is wrong and get a revised prompt.
        btn('💬 Discuss', 'Discuss', () => { const it = this.current(); if (it) { this.close(); this.hooks.onDiscuss?.(it); } }),
        // Use as reference: this picture, full resolution, into a reference slot.
        btn('⧉ Use as reference', 'Use as reference', () => { const it = this.current(); if (it) this.hooks.onUseAsReference?.(it); }),
        btn('☁ Save to Drive', 'Save to Drive', () => { const it = this.current(); if (it) this.hooks.onSaveToDrive?.(it); })));
    this.root = h('div.viewer', { role: 'dialog', 'aria-modal': 'true', hidden: true }, this.stage, this.top, this.bottom);
    document.body.append(this.root);
    this.#gestures();
    document.addEventListener('keydown', (e) => {
      if (this.root.hidden) return;
      if (e.key === 'ArrowRight') this.go(1);
      else if (e.key === 'ArrowLeft') this.go(-1);
      else if (e.key === 'Escape') this.close();
    });
    // Android back button / gesture closes the viewer instead of leaving the app.
    window.addEventListener('popstate', () => { if (!this.root.hidden) this.close(true); });
  }

  items() { return this.getItems().filter((i) => i.image); }
  current() { return this.items()[this.index]; }

  open(getItems, index) {
    this.getItems = getItems;
    this.index = index;
    this.root.hidden = false;
    this.root.classList.remove('chrome-hidden');
    document.body.classList.add('viewer-open');
    history.pushState({ viewer: true }, '');
    this.show();
  }

  close(fromPop) {
    if (this.root.hidden) return;
    this.root.hidden = true;
    document.body.classList.remove('viewer-open');
    if (!fromPop && history.state?.viewer) history.back();
    this.onClose?.();
  }

  /** Called by main when items change while open (new image finished). */
  refresh() { if (!this.root.hidden) this.#updateChrome(); }

  show() {
    const it = this.current();
    if (!it) return;
    this.#resetZoom();
    this.img.src = viewUrl(it.image);
    // Preload neighbours so swiping feels instant.
    for (const d of [1, -1]) { const n = this.items()[this.index + d]; if (n) new Image().src = viewUrl(n.image); }
    this.#updateChrome();
  }

  #updateChrome() {
    const list = this.items(), it = list[this.index];
    const pending = this.getItems().filter((i) => !i.image && ['queued', 'running', 'submitting'].includes(i.status)).length;
    this.counter.textContent = `${this.index + 1} / ${list.length}${pending ? `  (+${pending} rendering)` : ''}`;
    if (!it) return;
    this.favBtn.textContent = it.favorite ? '★' : '☆';
    this.favBtn.classList.toggle('on', !!it.favorite);
    const m = it.meta || {};
    this.caption.textContent = `${m.prompt || ''}${m.seed !== undefined ? `  · seed ${m.seed}` : ''}`;
  }

  go(dir) {
    const n = this.items().length;
    const next = this.index + dir;
    if (next < 0 || next >= n) { this.#bounce(dir); return; }
    this.index = next;
    // Slide animation: start off-screen on the side we came from.
    this.img.style.transition = 'none';
    this.img.style.transform = `translateX(${dir * 40}%)`;
    this.img.style.opacity = '0.2';
    this.show();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      this.img.style.transition = 'transform .18s ease-out, opacity .18s';
      this.img.style.transform = 'translateX(0)'; this.img.style.opacity = '1';
    }));
  }

  #bounce(dir) {
    this.img.style.transition = 'transform .15s';
    this.img.style.transform = `translateX(${-dir * 6}%)`;
    setTimeout(() => { this.img.style.transform = 'translateX(0)'; }, 150);
  }

  async favorite() {
    const it = this.current(); if (!it) return;
    it.favorite = !it.favorite;
    this.#updateChrome();
    try { await this.hooks.onFavorite?.(it); } catch (e) { it.favorite = !it.favorite; this.#updateChrome(); toast('Could not save favorite: ' + e.message); }
  }

  async #blob() {
    const it = this.current();
    const r = await fetch(viewUrl(it.image));
    return { blob: await r.blob(), name: it.image.filename };
  }

  async save() {
    // Inside the Android app: the native side downloads it into the gallery.
    if (has('saveImage')) {
      const it = this.current(); if (!it) return;
      try { bridge().saveImage(absoluteUrl(viewUrl(it.image)), it.image.filename); } catch (e) { toast('Save failed: ' + e.message); }
      return;
    }
    try {
      const { blob, name } = await this.#blob();
      const a = h('a', { href: URL.createObjectURL(blob), download: name });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    } catch (e) { toast('Save failed: ' + e.message); }
  }

  async share() {
    // Inside the Android app: native share sheet with the real image file.
    if (has('shareImage')) {
      const it = this.current(); if (!it) return;
      try { bridge().shareImage(absoluteUrl(viewUrl(it.image)), it.image.filename); } catch (e) { toast('Share failed: ' + e.message); }
      return;
    }
    try {
      const { blob, name } = await this.#blob();
      const file = new File([blob], name, { type: blob.type || 'image/png' });
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], text: this.current().meta?.prompt || '' });
      else if (navigator.share) await navigator.share({ url: new URL(viewUrl(this.current().image), location.href).href });
      else toast('Sharing is not supported in this browser');
    } catch (e) { if (e.name !== 'AbortError') toast('Share failed: ' + e.message); }
  }

  // ---- zoom / pan state ----------------------------------------------------
  #resetZoom() { this.z = { scale: 1, x: 0, y: 0 }; this.#apply(false); }
  #apply(animate) {
    this.img.style.transition = animate ? 'transform .2s ease-out' : 'none';
    this.img.style.transform = `translate(${this.z.x}px, ${this.z.y}px) scale(${this.z.scale})`;
  }
  #clampPan() {
    // Keep the zoomed image covering the screen (no panning into the void).
    const r = this.stage.getBoundingClientRect();
    const maxX = Math.max(0, (this.img.clientWidth * this.z.scale - r.width) / 2);
    const maxY = Math.max(0, (this.img.clientHeight * this.z.scale - r.height) / 2);
    this.z.x = Math.max(-maxX, Math.min(maxX, this.z.x));
    this.z.y = Math.max(-maxY, Math.min(maxY, this.z.y));
  }
  #zoomAt(newScale, cx, cy) {
    // Zoom so that the point under (cx, cy) stays under the finger.
    const r = this.stage.getBoundingClientRect();
    const px = cx - (r.left + r.width / 2), py = cy - (r.top + r.height / 2);
    const k = newScale / this.z.scale;
    this.z.x = px - (px - this.z.x) * k;
    this.z.y = py - (py - this.z.y) * k;
    this.z.scale = newScale;
  }

  #gestures() {
    const pts = new Map();
    let start = null, pinch = null, lastTap = 0, tapTimer = null, moved = false;
    const st = this.stage;
    st.addEventListener('pointerdown', (e) => {
      st.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      moved = false;
      if (pts.size === 1) start = { x: e.clientX, y: e.clientY, t: Date.now(), zx: this.z.x, zy: this.z.y };
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), scale: this.z.scale, x: this.z.x, y: this.z.y, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      }
    });
    st.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2 && pinch) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const s = Math.max(1, Math.min(6, pinch.scale * (d / pinch.d)));
        Object.assign(this.z, { scale: pinch.scale, x: pinch.x, y: pinch.y });
        this.#zoomAt(s, pinch.mx, pinch.my);
        // Moving the midpoint pans.
        this.z.x += (a.x + b.x) / 2 - pinch.mx; this.z.y += (a.y + b.y) / 2 - pinch.my;
        this.#clampPan(); this.#apply(false); moved = true;
        return;
      }
      if (pts.size !== 1 || !start) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (Math.hypot(dx, dy) > 8) moved = true;
      if (this.z.scale > 1.01) {
        this.z.x = start.zx + dx; this.z.y = start.zy + dy; this.#clampPan(); this.#apply(false);
      } else if (moved) {
        // Not zoomed: horizontal drag previews the swipe.
        this.img.style.transition = 'none';
        this.img.style.transform = `translateX(${dx}px)`;
      }
    });
    const up = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (pinch && pts.size < 2) {
        pinch = null;
        if (this.z.scale < 1.05) this.#resetZoom();
        // Remaining finger restarts a pan from here.
        const rest = [...pts.values()][0];
        start = rest ? { x: rest.x, y: rest.y, t: Date.now(), zx: this.z.x, zy: this.z.y } : null;
        return;
      }
      if (pts.size || !start) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y, dt = Date.now() - start.t;
      start = null;
      if (!moved && dt < 300) {
        const now = Date.now();
        if (now - lastTap < 300) {
          // Double-tap: zoom in at that point, or back out.
          clearTimeout(tapTimer); lastTap = 0;
          if (this.z.scale > 1.01) this.#resetZoom(); else { this.#zoomAt(2.5, e.clientX, e.clientY); this.#clampPan(); }
          this.#apply(true);
        } else {
          lastTap = now;
          tapTimer = setTimeout(() => this.root.classList.toggle('chrome-hidden'), 260);
        }
        return;
      }
      if (this.z.scale <= 1.01 && moved) {
        const w = st.clientWidth;
        if (Math.abs(dx) > Math.max(60, w * 0.18) && Math.abs(dx) > Math.abs(dy)) this.go(dx < 0 ? 1 : -1);
        else { this.img.style.transition = 'transform .15s'; this.img.style.transform = 'translateX(0)'; }
      }
    };
    st.addEventListener('pointerup', up);
    st.addEventListener('pointercancel', up);
    // Mouse wheel zoom for desktop/tablet with trackpad.
    st.addEventListener('wheel', (e) => {
      e.preventDefault();
      const s = Math.max(1, Math.min(6, this.z.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      this.#zoomAt(s, e.clientX, e.clientY); this.#clampPan();
      if (s <= 1.01) this.#resetZoom(); else this.#apply(false);
    }, { passive: false });
  }
}
