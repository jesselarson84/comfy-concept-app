// info-tip.js - the small (i) button next to a setting's label, and the one
// shared popover it opens (batch 4). The texts come from lib/setting-info.js.
// -----------------------------------------------------------------------------
// Tap (i) = open the popover under it; tap it again, tap anywhere else or press
// Escape = close. Works with touch, mouse and keyboard (it is a real <button>
// with an accessible name "About <setting>" and aria-expanded). The popover is
// role="dialog" (non-modal) and named after the setting. The buttons carry
// data-keep-live so they stay usable while a run locks the form.
// -----------------------------------------------------------------------------
import { h } from './dom.js';

let pop = null, owner = null;

function ensurePop() {
  if (pop) return pop;
  const title = h('div.info-pop-title', { id: 'info-pop-title' });
  const body = h('div.info-pop-body');
  pop = h('div.info-pop', { id: 'info-pop', role: 'dialog', 'aria-labelledby': 'info-pop-title', hidden: true }, title, body);
  pop.parts = { title, body };
  document.body.append(pop);
  // Outside tap closes (pointerdown, so it also works before a scroll starts).
  document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !pop.contains(e.target) && !e.target.closest?.('.info-btn')) closeInfo(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) { const b = owner; closeInfo(); b?.focus(); } });
  window.addEventListener('resize', () => closeInfo());
  document.addEventListener('scroll', () => { if (owner) place(owner); }, true);
  return pop;
}

function place(btn) {
  const r = btn.getBoundingClientRect();
  const vw = document.documentElement.clientWidth, vh = window.innerHeight;
  const w = Math.min(320, vw - 16);
  pop.style.width = `${w}px`;
  pop.style.left = `${Math.max(8, Math.min(vw - w - 8, r.left + r.width / 2 - w / 2))}px`;
  const below = r.bottom + 6, hgt = pop.offsetHeight || 120;
  pop.style.top = `${below + hgt > vh - 8 && r.top - hgt - 6 > 8 ? r.top - hgt - 6 : below}px`;
}

export function closeInfo() {
  if (!pop || pop.hidden) return;
  pop.hidden = true;
  owner?.setAttribute('aria-expanded', 'false');
  owner?.classList.remove('on');
  owner = null;
}

export function openInfo(btn, label, text) {
  ensurePop();
  if (owner === btn) { closeInfo(); return; }
  closeInfo();
  pop.parts.title.textContent = label;
  pop.parts.body.textContent = text;
  pop.hidden = false;
  owner = btn;
  btn.setAttribute('aria-expanded', 'true');
  btn.classList.add('on');
  place(btn);
}

/** The (i) button for a setting; null when there is no text (nothing to show). */
export function infoButton(label, text) {
  if (!text) return null;
  const name = String(label || 'this setting').replace(/\s+/g, ' ').trim();
  const b = h('button.info-btn', {
    type: 'button', 'aria-label': `About ${name}`, 'aria-expanded': 'false', 'aria-controls': 'info-pop', 'aria-haspopup': 'dialog',
    dataset: { keepLive: '', info: name },
    // Inside a <label> a tap would also focus/toggle its control: stop that.
    onclick: (e) => { e.preventDefault(); e.stopPropagation(); openInfo(b, name, text); },
  }, h('i.i.i-info', { 'aria-hidden': 'true' }));
  return b;
}
