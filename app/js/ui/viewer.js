// viewer.js - full-screen image viewer.
// -----------------------------------------------------------------------------
// Batch 5: a gallery-style strip. Three slides (previous / current / next) sit
// side by side in a track; a horizontal drag moves the whole track 1:1 under
// the finger, so the next picture slides in as you drag (no swap, no fade).
//   swipe left/right  -> next / previous. A quick flick is enough; a slow drag
//                        must pass ~1/3 of the screen, else it springs back.
//                        The settle animation continues the finger's speed.
//   at either end     -> rubber band (the track stretches and springs back)
//   swipe down        -> close; the picture shrinks and the black fades as you drag
//   pinch             -> zoom around the fingers' midpoint (swiping is off while zoomed)
//   drag when zoomed  -> pan
//   double-tap        -> toggle 1x / 2.5x at the tapped point
//   single tap        -> show/hide the controls (waits 250ms to rule out a double-tap)
// A thumbnail strip at the bottom jumps to any picture and follows the swipes.
// The trash button (pictures saved in History only) deletes that one picture
// from the PC after a confirm and moves on to the next one.
// The list of images is read through getItems() every time, so images that
// finish while the viewer is open simply become swipeable.
// -----------------------------------------------------------------------------
import { h, toast } from './dom.js';
import { viewUrl } from '../comfy-client.js';
import { bridge, has, absoluteUrl } from '../native.js';
import { confirmDialog } from './history-view.js';

const EASE_OUT = 'cubic-bezier(.22,.8,.3,1)';
const SPRING = 'cubic-bezier(.3,1.35,.5,1)';

export class Viewer {
  /**
   * getItems(): array of { image, meta, favorite, historyId }
   * hooks: { onFavorite(item), onReuse(item), onDiscuss(item), onUseAsReference(item), onSaveToDrive(item), onDelete(item) -> Promise<boolean> }
   */
  constructor(hooks) {
    this.hooks = hooks;
    this.getItems = () => [];
    this.index = 0;
    this.z = { scale: 1, x: 0, y: 0 };
    this.build();
  }

  build() {
    // prev / current / next. Only the current one has the .viewer-img class.
    this.slides = [-1, 0, 1].map(() => {
      const img = h('img', { alt: '', draggable: false });
      img.draggable = false; // a native image drag would steal the pointer mid-swipe
      return h('div.viewer-slide', {}, img);
    });
    this.track = h('div.viewer-track', {}, ...this.slides);
    this.stage = h('div.viewer-stage', {}, this.track);
    this.stage.addEventListener('dragstart', (e) => e.preventDefault());
    this.counter = h('span.viewer-counter');
    this.caption = h('div.viewer-caption');
    this.favBtn = h('button.icon-btn', { title: 'Favorite', 'aria-label': 'Favorite', onclick: () => this.favorite() }, '☆');
    this.delBtn = h('button.icon-btn.viewer-del', { title: 'Delete', 'aria-label': 'Delete', onclick: () => this.remove() }, h('i.i.i-trash-2'));
    const btn = (label, title, fn) => h('button.icon-btn', { title, 'aria-label': title, onclick: fn }, label);
    this.top = h('div.viewer-top', {}, btn('✕', 'Close', () => this.close()), this.counter, h('span.spacer'), this.delBtn, this.favBtn);
    this.strip = h('div.viewer-strip', { role: 'listbox', 'aria-label': 'All pictures' });
    this.bottom = h('div.viewer-bottom', {},
      this.strip,
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
    this.#layoutSlides();
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

  /** The current picture's <img> (zoom and pan apply to it). */
  get img() { return this.slides[1].firstChild; }

  items() { return this.getItems().filter((i) => i.image && !i.deleted); }
  current() { return this.items()[this.index]; }

  open(getItems, index) {
    this.getItems = getItems;
    this.index = Math.max(0, index);
    this.root.hidden = false;
    this.root.classList.remove('chrome-hidden');
    this.#resetDismiss(false);
    document.body.classList.add('viewer-open');
    history.pushState({ viewer: true }, '');
    this.stripKey = '';
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
  refresh() { if (!this.root.hidden) { this.#fillSlides(); this.#updateChrome(); } }

  show() {
    const n = this.items().length;
    if (!n) return;
    this.index = Math.min(this.index, n - 1);
    this.#setTrack(0, false);
    this.#fillSlides();
    this.#resetZoom();
    this.#updateChrome();
  }

  // ---- slides -------------------------------------------------------------
  #layoutSlides() {
    this.slides.forEach((s, i) => {
      s.style.transform = `translateX(${(i - 1) * 100}%)`;
      s.firstChild.classList.toggle('viewer-img', i === 1);
    });
  }

  #fillSlides() {
    const list = this.items();
    this.slides.forEach((s, i) => {
      const it = list[this.index + i - 1];
      const img = s.firstChild;
      s.hidden = !it;
      if (!it) return;
      const src = viewUrl(it.image);
      if (img.getAttribute('src') !== src) img.src = src;
    });
  }

  #setTrack(px, animate, { ms = 260, ease = EASE_OUT } = {}) {
    this.track.style.transition = animate ? `transform ${ms}ms ${ease}` : 'none';
    this.track.style.transform = `translate3d(${px}px,0,0)`;
  }

  /** Move to the neighbour (dir = +1 next, -1 previous), animating from the current drag offset. */
  go(dir, { from = 0, velocity = 0 } = {}) {
    const n = this.items().length, next = this.index + dir;
    if (next < 0 || next >= n) { this.#bounce(dir, from); return; }
    const w = this.stage.clientWidth || window.innerWidth;
    const remaining = Math.max(0, w - Math.abs(from));
    // Keep the finger's speed: fast flick lands fast, slow drag eases in.
    const ms = Math.round(Math.max(150, Math.min(340, remaining / Math.max(Math.abs(velocity), 1.1))));
    this.#settling?.();
    this.#setTrack(-dir * w, true, { ms });
    const done = () => {
      clearTimeout(t); this.track.removeEventListener('transitionend', done); this.#settling = null;
      this.index = next;
      // Rotate: the slide that scrolled off becomes the new far neighbour.
      if (dir > 0) this.slides.push(this.slides.shift()); else this.slides.unshift(this.slides.pop());
      this.#layoutSlides();
      this.#setTrack(0, false);
      this.#fillSlides();
      this.#resetZoom();
      this.#updateChrome();
    };
    const t = setTimeout(done, ms + 80);
    this.track.addEventListener('transitionend', done);
    this.#settling = done;
  }
  #settling = null;

  #bounce(dir, from = 0) {
    if (!from) { this.#setTrack(-dir * 36, true, { ms: 120 }); setTimeout(() => this.#setTrack(0, true, { ms: 320, ease: SPRING }), 120); return; }
    this.#setTrack(0, true, { ms: 340, ease: SPRING });
  }

  /** Jump straight to a picture (thumbnail strip, after a delete). */
  jump(i, { dir = 0 } = {}) {
    this.#settling?.();
    this.index = i;
    this.#fillSlides();
    this.#resetZoom();
    this.#updateChrome();
    const w = this.stage.clientWidth || window.innerWidth;
    if (dir) { this.#setTrack(dir * w * 0.35, false); requestAnimationFrame(() => requestAnimationFrame(() => this.#setTrack(0, true, { ms: 240 }))); }
  }

  // ---- chrome ---------------------------------------------------------------
  #updateChrome() {
    const list = this.items(), it = list[this.index];
    const pending = this.getItems().filter((i) => !i.image && ['queued', 'running', 'submitting'].includes(i.status)).length;
    this.counter.textContent = `${this.index + 1} / ${list.length}${pending ? `  (+${pending} rendering)` : ''}`;
    if (!it) return;
    this.favBtn.textContent = it.favorite ? '★' : '☆';
    this.favBtn.classList.toggle('on', !!it.favorite);
    this.delBtn.hidden = !(it.historyId && this.hooks.onDelete);
    const m = it.meta || {};
    this.caption.textContent = `${m.prompt || ''}${m.seed !== undefined ? `  · seed ${m.seed}` : ''}`;
    this.#paintStrip(list);
  }

  #paintStrip(list) {
    const key = list.map((i) => i.key ?? viewUrl(i.image)).join('|');
    if (key !== this.stripKey) {
      this.stripKey = key;
      this.strip.replaceChildren(...list.map((it, i) => h('button.viewer-strip-item', {
        type: 'button', role: 'option', 'aria-label': `Picture ${i + 1}`,
        onclick: () => { if (i !== this.index) this.jump(i, { dir: Math.sign(i - this.index) }); },
      }, h('img', { src: viewUrl(it.image, { thumb: true }), alt: '', loading: 'lazy', draggable: false }))));
    }
    this.strip.hidden = list.length < 2;
    [...this.strip.children].forEach((b, i) => { b.classList.toggle('on', i === this.index); b.setAttribute('aria-selected', String(i === this.index)); });
    const cur = this.strip.children[this.index];
    if (cur && !this.strip.hidden) {
      const left = cur.offsetLeft - (this.strip.clientWidth - cur.offsetWidth) / 2;
      this.strip.scrollTo({ left, behavior: this.stripPainted ? 'smooth' : 'auto' });
      this.stripPainted = true;
    }
  }

  async favorite() {
    const it = this.current(); if (!it) return;
    it.favorite = !it.favorite;
    this.#updateChrome();
    try { await this.hooks.onFavorite?.(it); } catch (e) { it.favorite = !it.favorite; this.#updateChrome(); toast('Could not save favorite: ' + e.message); }
  }

  /** Delete this one picture from the PC (after a confirm), then show the next one. */
  async remove() {
    const it = this.current(); if (!it?.historyId || !this.hooks.onDelete) return;
    if (!(await confirmDialog('Delete this image from the PC?', 'Delete'))) return;
    let ok = false;
    try { ok = await this.hooks.onDelete(it); } catch (e) { toast(e.message, 8000); }
    if (!ok) return;
    it.deleted = true;
    const n = this.items().length;
    if (!n) { this.close(); return; }
    const wasLast = this.index >= n;
    this.stripKey = '';
    this.jump(Math.min(this.index, n - 1), { dir: wasLast ? -1 : 1 });
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

  // ---- swipe-down to close ---------------------------------------------------
  #dismissAt(dy, animate) {
    const hgt = this.stage.clientHeight || window.innerHeight;
    const p = Math.max(0, Math.min(1, dy / hgt));
    const s = this.slides[1];
    s.style.transition = this.root.style.transition = animate ? `transform 220ms ${EASE_OUT}, opacity 220ms` : 'none';
    s.style.transform = `translateX(0) translateY(${Math.max(0, dy)}px) scale(${1 - p * 0.4})`;
    this.root.style.backgroundColor = `rgba(0,0,0,${1 - Math.min(1, p * 1.6)})`;
    this.top.style.opacity = this.bottom.style.opacity = dy > 0 ? String(Math.max(0, 1 - p * 4)) : '';
    for (const o of [this.slides[0], this.slides[2]]) o.style.opacity = dy > 0 ? '0' : '';
  }
  #resetDismiss(animate) {
    this.#dismissAt(0, animate);
    const s = this.slides[1];
    setTimeout(() => { s.style.transition = ''; this.#layoutSlides(); this.root.style.backgroundColor = ''; this.top.style.opacity = this.bottom.style.opacity = ''; }, animate ? 230 : 0);
  }

  // ---- zoom / pan state ----------------------------------------------------
  #resetZoom() { this.z = { scale: 1, x: 0, y: 0 }; this.#apply(false); for (const s of this.slides) if (s.firstChild !== this.img) s.firstChild.style.transform = ''; }
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
    let start = null, pinch = null, lastTap = 0, tapTimer = null, moved = false, axis = null, samples = [];
    const st = this.stage;
    const hasNeighbour = (dir) => { const n = this.items().length, i = this.index + dir; return i >= 0 && i < n; };
    /** px per ms over the last ~100 ms of the drag. */
    const velocity = () => {
      const now = Date.now(), recent = samples.filter((s) => now - s.t < 100);
      if (recent.length < 2) return { vx: 0, vy: 0 };
      const a = recent[0], b = recent[recent.length - 1], dt = Math.max(1, b.t - a.t);
      return { vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt };
    };
    st.addEventListener('pointerdown', (e) => {
      st.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      moved = false;
      if (pts.size === 1) {
        this.#settling?.(); // a new touch during the settle finishes it at once
        start = { x: e.clientX, y: e.clientY, t: Date.now(), zx: this.z.x, zy: this.z.y };
        axis = null; samples = [{ x: e.clientX, y: e.clientY, t: Date.now() }];
      }
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), scale: this.z.scale, x: this.z.x, y: this.z.y, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
        // A pinch cancels a swipe in progress.
        if (axis) { axis = null; this.#setTrack(0, true); this.#resetDismiss(true); }
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
      samples.push({ x: e.clientX, y: e.clientY, t: Date.now() });
      if (samples.length > 12) samples.shift();
      if (Math.hypot(dx, dy) > 8) moved = true;
      if (this.z.scale > 1.01) {
        this.z.x = start.zx + dx; this.z.y = start.zy + dy; this.#clampPan(); this.#apply(false);
        return;
      }
      if (!moved) return;
      // Lock to one direction on the first real movement.
      if (!axis) axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : dy > 0 ? 'y' : 'none';
      if (axis === 'x') {
        // Past either end the track stretches (rubber band) instead of moving 1:1.
        const off = hasNeighbour(dx < 0 ? 1 : -1) ? dx : dx * 0.35;
        this.#setTrack(off, false);
      } else if (axis === 'y') this.#dismissAt(dy, false);
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
        axis = null; samples = rest ? [{ ...rest, t: Date.now() }] : [];
        return;
      }
      if (pts.size || !start) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y, dt = Date.now() - start.t;
      const { vx, vy } = velocity();
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
      if (this.z.scale > 1.01 || !moved) return;
      if (axis === 'x') {
        const w = st.clientWidth;
        const dir = dx < 0 ? 1 : -1;
        // A flick (fast, same direction) or a drag past a third of the screen.
        const flick = Math.abs(vx) > 0.45 && Math.sign(vx) === Math.sign(dx);
        if ((flick || Math.abs(dx) > w / 3) && hasNeighbour(dir)) this.go(dir, { from: dx, velocity: vx });
        else this.#bounce(dir, dx || 1);
      } else if (axis === 'y') {
        if (dy > 120 || (vy > 0.6 && dy > 20)) {
          // Fly out the rest of the way, then close.
          this.#dismissAt((st.clientHeight || window.innerHeight) * 0.6, true);
          setTimeout(() => { this.close(); this.#resetDismiss(false); }, 180);
        } else this.#resetDismiss(true);
      }
      axis = null;
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
