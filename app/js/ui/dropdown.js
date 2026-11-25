// dropdown.js - the app's own dropdown (batch 15), in place of the phone's <select> menu.
// -----------------------------------------------------------------------------
// A button that opens a list in the same style as the aspect ratio grid. Like the
// ratio grid it STAYS OPEN after a pick: a tap outside or Escape closes it. Only one is open at a time.
//
//   const dd = dropdown({ options: [['1k', '1K'], ...], value: '1k', label: 'Resolution', onChange })
//   dd.value            current value (string); setting it repaints, no change event
//   dd.setOptions(opts) replace the list ([value, label] pairs or plain values)
//   'change' event      fires (bubbles) on a pick, like a <select>
// The list is fixed-positioned in <body> so sheets and scrolling menus don't clip it.
// An invisible scrim sits under it: the tap that closes it does nothing else
// (it used to also move the slider or press the button underneath).
// -----------------------------------------------------------------------------
import { h } from './dom.js';

let openDd = null;

/**
 * A see-through layer under a pop-up: a tap on it only calls onClose.
 * The scrim stays until the tap is over (it closes on the tap's click), so the
 * whole tap - down, up and click - lands on it and nothing underneath reacts.
 * If no click follows (a cancelled touch), it still closes shortly after.
 */
export function tapOutScrim(onClose, cls = 'dd-scrim') {
  const el = h(`div.${cls}`, { 'aria-hidden': 'true' });
  el.addEventListener('pointerdown', (e) => e.preventDefault()); // no focus / text selection underneath
  let waiting = false;
  el.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); waiting = false; onClose(); });
  el.addEventListener('pointerup', () => { waiting = true; setTimeout(() => { if (waiting) { waiting = false; onClose(); } }, 400); });
  el.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
  el.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  return el;
}

function closeOpen() { openDd?.close(); }

let wired = false;
function wireGlobal() {
  if (wired) return;
  wired = true;
  // Capture + stop, so Escape closes only the list (not the sheet or menu under it).
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openDd) { e.stopImmediatePropagation(); e.preventDefault(); const b = openDd.btn; closeOpen(); b.focus(); } }, true);
  window.addEventListener('resize', closeOpen);
}

const norm = (opts) => opts.map((o) => (Array.isArray(o) ? [String(o[0]), String(o[1] ?? o[0])] : [String(o), String(o)]));

export function dropdown({ options = [], value, label = '', className = '', onChange } = {}) {
  wireGlobal();
  let opts = norm(options);
  let cur = value !== undefined ? String(value) : opts[0]?.[0] ?? '';
  const text = h('span.dd-text');
  const btn = h('button.dd-btn', { type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-label': label }, text, h('i.i.i-chevron-down', { 'aria-hidden': 'true' }));
  const list = h('div.dd-list');
  const pop = h('div.dd-pop', { role: 'listbox', 'aria-label': label, hidden: true }, list);
  const scrim = tapOutScrim(() => root.close());
  const root = h(`div.dd${className ? '.' + className.split(' ').filter(Boolean).join('.') : ''}`, { dataset: { label } }, btn);

  const paint = () => {
    text.textContent = opts.find(([v]) => v === cur)?.[1] ?? cur;
    for (const b of list.children) b.setAttribute('aria-selected', String(b.dataset.value === cur));
  };
  const build = () => {
    list.replaceChildren(...opts.map(([v, l]) => h('button.dd-opt', { type: 'button', role: 'option', dataset: { value: v }, onclick: () => pick(v) }, l)));
    paint();
  };
  const pick = (v) => {
    if (v !== cur) { cur = v; paint(); onChange?.(v); root.dispatchEvent(new Event('change', { bubbles: true })); }
  };
  const place = () => {
    const r = btn.getBoundingClientRect();
    pop.style.minWidth = `${Math.round(r.width)}px`;
    const ph = pop.offsetHeight, pw = pop.offsetWidth;
    const below = r.bottom + 6 + ph <= innerHeight - 8 || r.top - 6 - ph < 8 && innerHeight - r.bottom > r.top;
    pop.style.top = `${Math.max(8, below ? r.bottom + 6 : r.top - 6 - ph)}px`;
    pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - pw - 8))}px`;
    pop.style.maxHeight = `${Math.max(120, below ? innerHeight - r.bottom - 14 : r.top - 14)}px`;
  };
  const open = () => {
    closeOpen();
    document.body.append(scrim, pop);
    pop.hidden = false;
    place();
    btn.setAttribute('aria-expanded', 'true'); btn.classList.add('open');
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    openDd = root;
  };
  root.close = () => {
    pop.hidden = true; pop.remove(); scrim.remove();
    btn.setAttribute('aria-expanded', 'false'); btn.classList.remove('open');
    if (openDd === root) openDd = null;
  };
  root.btn = btn; root.pop = pop;
  btn.addEventListener('click', () => (pop.hidden ? open() : root.close()));
  Object.defineProperty(root, 'value', { get: () => cur, set: (v) => { cur = String(v); paint(); } });
  Object.defineProperty(root, 'disabled', { get: () => btn.disabled, set: (v) => { btn.disabled = !!v; if (v) root.close(); } });
  root.setOptions = (o) => { opts = norm(o); if (!opts.some(([v]) => v === cur)) cur = opts[0]?.[0] ?? ''; build(); };
  build();
  return root;
}
