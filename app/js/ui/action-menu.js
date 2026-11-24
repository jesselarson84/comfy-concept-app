// action-menu.js - the ⋮ menu of the full-screen viewers (batch 10).
// -----------------------------------------------------------------------------
// A small dropdown under the ⋮ button: groups of rows (icon, label, optional
// grey line under it), split by thin lines, with an optional group title
// ("Keep & send", "Make more"). A danger row (Delete) is red. Tapping outside,
// Escape or Back closes it; tapping a row closes it, then runs the row.
//   menu.open(anchorButton, [{ title, items: [{ act, icon, label, sub, danger, fn }] }])
// icon: an icon class ('i-share-2') or an element (driveLogo()).
// -----------------------------------------------------------------------------
import { h } from './dom.js';

const SVG = 'http://www.w3.org/2000/svg';

/** The Google Drive mark (three-colour triangle) as an inline <svg>. */
export function driveLogo(size = 20) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 87.3 78');
  svg.setAttribute('width', size); svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('drive-logo');
  for (const [d, fill] of [
    ['m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z', '#0066da'],
    ['m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z', '#00ac47'],
    ['m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z', '#ea4335'],
    ['m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z', '#00832d'],
    ['m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z', '#2684fc'],
    ['m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z', '#ffba00'],
  ]) {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d); p.setAttribute('fill', fill);
    svg.append(p);
  }
  return svg;
}

/** The ⋮ button that opens a menu. */
export function moreButton(onclick) {
  return h('button.icon-btn.more-btn', { type: 'button', title: 'More', 'aria-label': 'More', 'aria-haspopup': 'menu', dataset: { act: 'more' }, onclick }, h('i.i.i-more-vertical'));
}

/** ⋮ for the 3D / video / audio / file viewers: Save… (Drive or this phone) and Share.
 *  getFile() -> the open result; hooks: { onSave(file), onShare(file) }. */
export function fileMoreButton(getFile, hooks = {}) {
  const menu = new ActionMenu();
  const btn = moreButton(() => {
    const f = getFile(); if (!f) return;
    menu.open(btn, [{ title: 'Keep & send', items: [
      { act: 'save', icon: driveLogo(), label: 'Save…', sub: 'Google Drive or this phone', hidden: !hooks.onSave, fn: () => hooks.onSave(f) },
      { act: 'share', icon: 'i-share-2', label: 'Share', hidden: !hooks.onShare, fn: () => hooks.onShare(f) },
    ] }]);
  });
  btn.menu = menu;
  return btn;
}

export class ActionMenu {
  constructor() {
    this.onKey = (e) => { if (e.key === 'Escape' && this.el) { e.stopPropagation(); this.close(); } };
    this.onPop = () => this.close();
  }

  get isOpen() { return !!this.el; }

  open(anchor, groups) {
    this.close();
    const rows = [];
    groups.filter((g) => g.items.some((i) => !i.hidden)).forEach((g, gi) => {
      if (gi) rows.push(h('div.amenu-sep', { role: 'separator' }));
      if (g.title) rows.push(h('div.amenu-title', {}, g.title));
      for (const it of g.items) {
        if (it.hidden) continue;
        const icon = typeof it.icon === 'string' ? h(`i.i.${it.icon}`) : it.icon || h('span');
        rows.push(h(`button.amenu-row${it.danger ? '.danger' : ''}${it.on ? '.on' : ''}`, { type: 'button', role: 'menuitem', dataset: { act: it.act }, onclick: () => { this.close(); it.fn?.(); } },
          h('span.amenu-ic', {}, icon), h('span.amenu-txt', {}, it.label, it.sub ? h('small', {}, it.sub) : null)));
      }
    });
    this.scrim = h('div.amenu-scrim', { onclick: () => this.close() });
    this.el = h('div.amenu', { role: 'menu' }, ...rows);
    // Under the button, right edges lined up (kept on screen).
    const r = anchor.getBoundingClientRect();
    this.el.style.top = `${Math.round(r.bottom + 4)}px`;
    this.el.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
    document.body.append(this.scrim, this.el);
    anchor.setAttribute('aria-expanded', 'true');
    this.anchor = anchor;
    document.addEventListener('keydown', this.onKey, true);
    window.addEventListener('popstate', this.onPop);
    this.el.querySelector('.amenu-row')?.focus({ preventScroll: true });
  }

  close() {
    if (!this.el) return;
    this.scrim.remove(); this.el.remove(); this.scrim = this.el = null;
    this.anchor?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('popstate', this.onPop);
  }
}
