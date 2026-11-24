// overlay.js - a full-screen layer (3D viewer, audio player, "From Comfy UI"
// grid, preset list) that the Android back button / gesture closes, like the
// image viewer and History do. Each open overlay owns one history entry
// ({ overlay: key }); Back pops it and the overlay closes itself.
import { h } from './dom.js';

export class Overlay {
  constructor(key, label) {
    this.key = key;
    this.root = h(`div.overlay.${key}`, { role: 'dialog', 'aria-modal': 'true', 'aria-label': label, hidden: true });
    document.body.append(this.root);
    window.addEventListener('popstate', () => { if (!this.root.hidden && history.state?.overlay !== this.key) this.close(true); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !this.root.hidden) this.close(); });
  }

  get isOpen() { return !this.root.hidden; }

  show() {
    if (this.root.hidden) history.pushState({ overlay: this.key }, '');
    this.root.hidden = false;
    document.body.classList.add('viewer-open');
  }

  close(fromPop) {
    if (this.root.hidden) return;
    this.root.hidden = true;
    if (!document.querySelector('.overlay:not([hidden]), .viewer:not([hidden])')) document.body.classList.remove('viewer-open');
    if (!fromPop && history.state?.overlay === this.key) history.back();
    this.onClose?.();
  }
}

/** Resolves after the history entry popped by a close() has been handled
 *  (so the next overlay's pushState is not undone by that pending Back). */
export function afterBack(ms = 400) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); window.removeEventListener('popstate', done); resolve(); };
    const t = setTimeout(done, ms);
    window.addEventListener('popstate', done, { once: true });
  });
}

/** Top bar shared by the overlays: close button, title, optional extras. */
export function overlayTop(title, onClose, ...extras) {
  const t = h('span.ov-title', {}, title);
  const bar = h('div.ov-top', {}, h('button.icon-btn', { type: 'button', 'aria-label': 'Close', title: 'Close', dataset: { act: 'close' }, onclick: onClose }, h('i.i.i-x')), t, h('span.spacer'), ...extras);
  bar.setTitle = (s) => { t.textContent = s; };
  return bar;
}
