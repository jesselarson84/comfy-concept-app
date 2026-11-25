// form-lock.js - the form is read-only while a run is going (batch 4, the owner:
// "No interaction till the current batch of images or whatever is running is
// finished").
// -----------------------------------------------------------------------------
// While locked, every control inside the given roots is disabled: the prompt
// and negative boxes, aspect + orientation, the batch stepper, seed, the
// reference / file / mask slots, Settings, the Prompt assistant and the menu's
// switches. Still usable: Cancel queue, the thumbnails and viewer, History,
// the canvas toggle, opening the Settings / assistant twirl-downs, scrolling.
//
// Text boxes become readOnly + aria-disabled instead of disabled, so a long
// prompt can still be scrolled and read (a disabled textarea cannot). Every
// other control gets the real `disabled` property. What each control was
// before is remembered (data-run-lock="on" = we disabled it, "was" = it was
// already disabled), so unlocking puts back exactly the previous state, e.g.
// Batch stays greyed for one-result presets. lockControls is called on every
// repaint while a run is going, so controls re-rendered during the run are
// locked too. Elements with data-keep-live are left alone.
// -----------------------------------------------------------------------------
const SEL = 'input, select, textarea, button';
const isText = (el) => el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search|)$/.test(el.type));

export function lockControls(roots, locked) {
  for (const root of roots) {
    if (!root) continue;
    root.classList.toggle('is-run-locked', locked);
    for (const el of root.querySelectorAll(SEL)) {
      if (el.closest('[data-keep-live]')) continue;
      const mark = el.dataset.runLock;
      if (locked) {
        if (isText(el)) {
          if (!mark) el.dataset.runLock = el.readOnly ? 'was' : 'on';
          if (el.dataset.runLock === 'on') { el.readOnly = true; el.setAttribute('aria-disabled', 'true'); }
        } else {
          if (!mark) el.dataset.runLock = el.disabled ? 'was' : 'on';
          if (el.dataset.runLock === 'on') el.disabled = true; // re-assert: some panels re-enable their own buttons
        }
      } else if (mark) {
        if (mark === 'on') {
          if (isText(el)) { el.readOnly = false; el.removeAttribute('aria-disabled'); } else el.disabled = false;
        }
        delete el.dataset.runLock;
      }
    }
  }
}
