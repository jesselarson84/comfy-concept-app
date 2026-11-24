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
// Batch 10 layout: top bar = ✕, the count (★ when a favourite) and ⋮. The
// picture sits between the top bar and the info area (prompt on 2 lines, date
// · model, tags), with the thumbnail strip at the very bottom. ⋮ opens the
// menu: Favorite / Keep & send (Save… = Drive or this phone, Share) / Make
// more (Use as reference, Reuse settings) / Delete. Tapping the prompt or
// "Details" opens the details sheet (full prompt + Copy, date, model, size,
// seed, steps, file, all tags). Delete (pictures saved in History only)
// removes that one picture from the PC after a confirm and moves on.
// The list of images is read through getItems() every time, so images that
// finish while the viewer is open simply become swipeable.
// -----------------------------------------------------------------------------
import { h, toast } from './dom.js';
import { viewUrl } from '../comfy-client.js';
import { bridge, has, absoluteUrl } from '../native.js';
import { confirmDialog } from './history-view.js';
import { projectLabel, projectById } from './projects.js';
import { GROUP_COLORS } from '../lib/history-filter.js';

/** [muted 'Apps ›', 'Cache'] for a project id, ['Unsorted'] for none. */
function projectCrumb(id) {
  const p = projectById(id);
  if (!p) return [h('b', {}, id ? projectLabel(id) : 'Unsorted')];
  return [p.group.length ? h('span.muted', {}, `${p.group.join(' › ')} ›`) : null, h('b', {}, p.name)].filter(Boolean);
}
import { ActionMenu, driveLogo, moreButton } from './action-menu.js';

const dayFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const yearFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
/** "Sat, Nov 21 · 7:42 PM" (full: with the year). */
export function whenLabel(ms, { full = false } = {}) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${(full ? yearFmt : dayFmt).format(d)} · ${timeFmt.format(d)}`;
}

const EASE_OUT = 'cubic-bezier(.22,.8,.3,1)';
const SPRING = 'cubic-bezier(.3,1.35,.5,1)';

export class Viewer {
  /**
   * getItems(): array of { image, meta, favorite, historyId, at, tags }
   * hooks: { onFavorite(item), onReuse(item), onUseAsReference(item), onSave(item) (Drive or phone),
   *          onTag(tag), labelOf(workflowId), onDelete(item) -> Promise<boolean> }
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
    this.favMark = h('i.i.i-star-fill.viewer-fav', { hidden: true, 'aria-label': 'Favorite' });
    this.menu = new ActionMenu();
    this.moreBtn = moreButton(() => this.openMenu());
    this.top = h('div.viewer-top', {},
      h('button.icon-btn.viewer-close', { type: 'button', title: 'Close', 'aria-label': 'Close', dataset: { act: 'close' }, onclick: () => this.close() }, h('i.i.i-x')),
      this.counter, this.favMark, h('span.spacer'), this.moreBtn);
    // Under the picture: prompt (2 lines; a tap opens Details), date · model, tags.
    this.caption = h('button.viewer-caption', { type: 'button', onclick: () => this.openDetails() });
    this.when = h('span.viewer-when');
    this.meta = h('div.viewer-meta', {}, this.when, h('button.link.viewer-details-link', { type: 'button', dataset: { act: 'details' }, onclick: () => this.openDetails() }, 'Details'));
    this.tags = h('div.viewer-tags', { hidden: true });
    this.strip = h('div.viewer-strip', { role: 'listbox', 'aria-label': 'All pictures' });
    this.bottom = h('div.viewer-bottom', {}, h('div.viewer-info', {}, this.caption, this.meta, this.tags), this.strip);
    this.root = h('div.viewer', { role: 'dialog', 'aria-modal': 'true', hidden: true }, this.top, this.stage, this.bottom);
    document.body.append(this.root);
    this.#layoutSlides();
    this.#gestures();
    document.addEventListener('keydown', (e) => {
      if (this.root.hidden) return;
      if (e.key === 'ArrowRight') this.go(1);
      else if (e.key === 'ArrowLeft') this.go(-1);
      else if (e.key === 'Escape') this.close();
    });
    // Android back button / gesture closes the viewer instead of leaving the app
    // (the details sheet first, when it is open: it has its own history entry).
    window.addEventListener('popstate', () => {
      if (this.ignorePop) { this.ignorePop = false; return; }
      if (this.root.hidden) return;
      if (this.details) { this.detailsPushed = false; this.closeDetails(); return; }
      this.close(true);
    });
  }

  /** The current picture's <img> (zoom and pan apply to it). */
  get img() { return this.slides[1].firstChild; }

  items() { return this.getItems().filter((i) => i.image && !i.deleted); }
  current() { return this.items()[this.index]; }

  open(getItems, index) {
    this.getItems = getItems;
    this.index = Math.max(0, index);
    this.root.hidden = false;
    this.ignorePop = false;
    this.root.classList.remove('chrome-hidden');
    this.#resetDismiss(false);
    document.body.classList.add('viewer-open');
    // Keep the state underneath (History, its folder ...): a Back that only
    // closes the details sheet lands here, and History must not see it as "left".
    history.pushState({ ...(history.state || {}), viewer: true }, '');
    this.stripKey = '';
    this.show();
  }

  close(fromPop) {
    if (this.root.hidden) return;
    this.menu.close();
    // Our history entries to drop: the viewer's, plus the details sheet's if open.
    const steps = fromPop ? 0 : this.detailsPushed ? 2 : 1;
    this.detailsPushed = false;
    this.closeDetails();
    this.root.hidden = true;
    document.body.classList.remove('viewer-open');
    if (steps && history.state?.viewer) history.go(-steps);
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
    this.favMark.hidden = !it.favorite;
    const m = it.meta || {};
    this.caption.textContent = m.prompt || '';
    this.caption.hidden = !m.prompt;
    this.when.textContent = [whenLabel(this.#at(it)), this.#model(it)].filter(Boolean).join(' · ');
    // Batch 9: the picture's tags (History pictures); a tap searches History for it.
    const tags = (it.tags || []).slice(0, 12);
    this.tags.replaceChildren(...tags.map((t) => this.#tagBtn(t)));
    this.tags.hidden = !tags.length;
    this.#paintStrip(list);
    if (this.details) this.#fillDetails();
  }

  #at(it) { return it.at || it.meta?.createdAt || null; }
  #model(it) { const id = it.meta?.legacyWorkflow || it.meta?.workflow; return id ? (this.hooks.labelOf?.(id) || '') : ''; }
  #tagBtn(t) { return h('button.vtag', { type: 'button', dataset: { tag: t }, onclick: () => { this.close(); this.hooks.onTag?.(t); } }, t); }

  // ---- ⋮ menu ----------------------------------------------------------------
  openMenu() {
    const it = this.current(); if (!it) return;
    const run = (fn) => () => { const cur = this.current(); if (cur) fn(cur); };
    this.menu.open(this.moreBtn, [
      { items: [{ act: 'favorite', icon: it.favorite ? 'i-star-fill' : 'i-star', label: it.favorite ? 'Remove from favorites' : 'Favorite', on: !!it.favorite, fn: () => this.favorite() }] },
      { title: 'Keep & send', items: [
        { act: 'save', icon: driveLogo(), label: 'Save…', sub: 'Google Drive or this phone', fn: run((cur) => (this.hooks.onSave ? this.hooks.onSave(cur) : this.save())) },
        { act: 'share', icon: 'i-share-2', label: 'Share', fn: () => this.share() },
        // Batch 11: to another project (its Drive file moves too).
        { act: 'move', icon: 'i-folder-input', label: 'Move to project…', sub: 'Its Drive file moves too', hidden: !(it.historyId && this.hooks.onMove), fn: run(async (cur) => { if (await this.hooks.onMove(cur)) { cur.project = undefined; cur.drive = { state: 'moving', path: '' }; if (this.details) this.#fillDetails(); } }) },
      ] },
      { title: 'Make more', items: [
        // Use as reference: this picture, full resolution, into an image slot.
        { act: 'reference', icon: 'i-image-plus', label: 'Use as reference', sub: 'This picture into an image slot', hidden: !this.hooks.onUseAsReference, fn: run((cur) => this.hooks.onUseAsReference(cur)) },
        // Reuse: its prompt, seed and settings back into the form.
        { act: 'reuse', icon: 'i-rotate-ccw', label: 'Reuse settings', sub: 'Its prompt, seed and model', hidden: !this.hooks.onReuse, fn: run((cur) => { this.close(); this.hooks.onReuse(cur); }) },
      ] },
      { items: [{ act: 'delete', icon: 'i-trash-2', label: 'Delete', danger: true, hidden: !(it.historyId && this.hooks.onDelete), fn: () => this.remove() }] },
    ]);
  }

  // ---- details sheet ----------------------------------------------------------
  openDetails() {
    if (!this.current() || this.details) return;
    this.detailsBody = h('div.vd-body');
    this.detailsScrim = h('div.sheet-scrim.vd-scrim', { onclick: () => this.closeDetails() });
    this.details = h('div.sheet.viewer-details', { role: 'dialog', 'aria-label': 'Details' },
      h('button.vd-grab', { type: 'button', 'aria-label': 'Close details', onclick: () => this.closeDetails() }),
      h('div.sheet-title', {}, 'Details'), this.detailsBody);
    document.body.append(this.detailsScrim, this.details);
    history.pushState({ ...(history.state || {}), viewer: true, details: true }, '');
    this.detailsPushed = true;
    this.onDetailsKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); this.closeDetails(); } };
    document.addEventListener('keydown', this.onDetailsKey, true);
    // Swipe the sheet down to close it.
    let y0 = null;
    this.details.addEventListener('pointerdown', (e) => { y0 = this.details.scrollTop <= 0 ? e.clientY : null; });
    this.details.addEventListener('pointerup', (e) => { if (y0 !== null && e.clientY - y0 > 70) this.closeDetails(); y0 = null; });
    this.#fillDetails();
  }

  closeDetails() {
    if (!this.details) return;
    this.details.remove(); this.detailsScrim.remove();
    this.details = this.detailsScrim = null;
    document.removeEventListener('keydown', this.onDetailsKey, true);
    // Closed by a tap / Escape / swipe: drop its history entry (that Back is ours, ignore it).
    if (this.detailsPushed) { this.detailsPushed = false; this.ignorePop = true; history.back(); }
  }

  #fillDetails() {
    const it = this.current(); if (!it) return this.closeDetails();
    const m = it.meta || {};
    // Batch 12 (option A): prompt card with Copy + Reuse, small fact tiles, a
    // "Saved to" card (project + Drive path), tags with a dot per kind
    // (batch 13: no plain color tags).
    const facts = [
      ['Model', this.#model(it)],
      ['Size', m.width && m.height ? `${m.width} × ${m.height}` : ''],
      ['Made', whenLabel(this.#at(it), { full: true })],
      ['Seed', m.seed ?? ''],
      ['Steps', m.steps ?? ''],
      ['Strength', m.strength ?? ''],
      ['File', it.image?.filename || '', true],
    ].filter(([, v]) => v !== '' && v !== null && v !== undefined);
    const copy = h('button.vd-btn', { type: 'button', dataset: { act: 'copy' }, onclick: async () => {
      try { await navigator.clipboard.writeText(m.prompt || ''); toast('Prompt copied'); } catch { toast('Could not copy'); }
    } }, h('i.i.i-copy'), 'Copy prompt');
    const reuse = this.hooks.onReuse ? h('button.vd-btn', { type: 'button', dataset: { act: 'reuse' }, onclick: () => { const cur = this.current(); this.close(); this.hooks.onReuse(cur); } }, h('i.i.i-rotate-ccw'), 'Reuse settings') : null;
    const d = it.drive;
    const saved = d && it.project !== undefined ? h('div.vd-card.vd-saved', {},
      h('div.vd-crumb', {}, h('i.i.i-folder'), ...projectCrumb(it.project), h('span.spacer'),
        h(`span.vd-state.${d.state}`, {}, { ok: '✓ filed', waiting: '⏳ waiting', moving: '⏳ moving', missing: '⚠ not found', gone: 'not filed' }[d.state] || '')),
      h('div.vd-path', {}, d.path || ({ waiting: 'Filed on Drive once Drive and ComfyUI are reachable', moving: 'Moving to its new project', gone: "No longer in ComfyUI's output folder" }[d.state] || ''))) : null;
    const tags = [...new Set(it.tags || [])];
    const groupOf = (t) => { for (const [g, list] of Object.entries(it.tagsBy || {})) if (list?.includes(t)) return g; return null; };
    const mark = (t) => { const g = groupOf(t); return GROUP_COLORS[g] ? h('i.hdot2', { style: `background:${GROUP_COLORS[g]}` }) : null; };
    // (replaceChildren would print a null as the text "null": drop the empty parts)
    this.detailsBody.replaceChildren(...[
      h('div.vd-card', {},
        m.prompt ? h('div.vd-prompt', {}, m.prompt) : h('div.vd-prompt.muted', {}, 'No prompt'),
        m.negative ? h('div.vd-neg', {}, h('span.muted', {}, 'Negative: '), m.negative) : null,
        m.prompt || reuse ? h('div.vd-actions', {}, m.prompt ? copy : null, reuse) : null),
      facts.length ? h('div.vd-sec', {}, 'Info') : null,
      facts.length ? h('div.vd-facts', {}, ...facts.map(([k, v, wide]) => h(`div.vd-fact${wide ? '.wide' : ''}`, {}, h('span.vd-k', {}, k), h('span.vd-v', {}, String(v))))) : null,
      saved ? h('div.vd-sec', {}, 'Saved to') : null, saved,
      tags.length ? h('div.vd-sec', {}, 'Tags') : null,
      tags.length ? h('div.viewer-tags.vd-tags', {}, ...tags.map((t) => { const b = this.#tagBtn(t); const mk = mark(t); if (mk) b.prepend(mk); return b; })) : null,
    ].filter(Boolean));
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
    try { await this.hooks.onFavorite?.(it); toast(it.favorite ? 'Added to favorites' : 'Removed from favorites'); } catch (e) { it.favorite = !it.favorite; this.#updateChrome(); toast('Could not save favorite: ' + e.message); }
  }

  /** Delete this one picture from the PC (after a confirm), then show the next one. */
  async remove() {
    const it = this.current(); if (!it?.historyId || !this.hooks.onDelete) return;
    if (!(await confirmDialog('Delete this image from the PC? Its Drive copy goes to the Drive trash.', 'Delete'))) return;
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

  /**
   * Batch 12: a single tap hides the top bar and the info area completely, so the
   * picture area becomes the whole screen (before, they only faded out and kept
   * their space, which clipped a zoomed picture). The picture grows with the
   * area, so the pan offset is scaled by the same amount (the same spot stays in
   * the middle) and clamped to the new size.
   */
  #toggleChrome() {
    const w0 = this.img?.clientWidth || 0;
    this.root.classList.toggle('chrome-hidden');
    requestAnimationFrame(() => {
      this.#layoutSlides();
      const w1 = this.img?.clientWidth || 0;
      if (w0 && w1 && this.z?.scale > 1.01) { const k = w1 / w0; this.z.x *= k; this.z.y *= k; this.#clampPan(); }
      this.#apply(false);
    });
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
          tapTimer = setTimeout(() => this.#toggleChrome(), 260);
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
