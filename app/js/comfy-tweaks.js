// comfy-tweaks.js - runs INSIDE ComfyUI's own page (/comfy/), added by the app's
// proxy (server/proxy.js injectHtml). Plain script, no imports, defensive.
// -----------------------------------------------------------------------------
// 1. Comfy Agent: The owner never uses it. Its button is hidden, and its error
//    toasts ("Comfy Agent error" / "Comfy Agent hit a server error") are
//    removed as soon as they appear. ComfyUI's frontend is a Vue app whose class
//    names change between versions, so elements are found by what they SAY:
//      button  = a button / [role=button] whose visible text is exactly "Agent",
//                or whose aria-label / title names "Comfy Agent" or is "Agent";
//      toast   = any element whose text contains "Comfy Agent" inside a toast
//                container (PrimeVue .p-toast-message, [role=alert],
//                [role=status], or a class containing "toast").
//    A MutationObserver re-checks whatever ComfyUI adds later. Nothing else is
//    touched; if ComfyUI renames these, they simply show again.
// 2. Node view: when the page runs in the app's iframe, <html> gets the class
//    "concept-embedded" (comfy-tweaks.css can use it).
// UNVERIFIED against the real ComfyUI page (not reachable from the dev VM).
// -----------------------------------------------------------------------------
(function () {
  'use strict';
  if (window.__conceptTweaks) return;
  window.__conceptTweaks = { hidden: 0 };
  var embedded = false;
  try { embedded = window.top !== window && !!window.parent && window.parent.location.origin === location.origin; } catch (e) { embedded = false; }
  if (embedded) document.documentElement.classList.add('concept-embedded');

  var AGENT_TEXT = /^\s*agent\s*$/i;
  var AGENT_NAME = /(^\s*agent\s*$)|\bcomfy\s*agent\b/i;
  var TOAST = '.p-toast-message, [role="alert"], [role="status"], [class*="toast" i]';

  function hide(el, why) {
    if (!el || el.getAttribute('data-concept-hidden')) return;
    el.setAttribute('data-concept-hidden', why);
    el.style.setProperty('display', 'none', 'important');
    window.__conceptTweaks.hidden++;
  }

  function isAgentButton(el) {
    var label = (el.getAttribute('aria-label') || '') + '|' + (el.getAttribute('title') || '');
    if (AGENT_NAME.test(el.getAttribute('aria-label') || '') || AGENT_NAME.test(el.getAttribute('title') || '')) return true;
    var text = (el.textContent || '').replace(/\s+/g, ' ');
    return AGENT_TEXT.test(text) && label.length < 200;
  }

  function scan(root) {
    if (!root || root.nodeType !== 1) return;
    var buttons = root.matches && root.matches('button, [role="button"]') ? [root] : [];
    buttons = buttons.concat(Array.prototype.slice.call(root.querySelectorAll('button, [role="button"]')));
    for (var i = 0; i < buttons.length; i++) if (isAgentButton(buttons[i])) hide(buttons[i], 'agent-button');
    var text = root.textContent || '';
    if (!/comfy\s*agent/i.test(text)) return;
    // Agent toast: the smallest toast container whose text names Comfy Agent.
    var cands = root.matches && root.matches(TOAST) ? [root] : [];
    cands = cands.concat(Array.prototype.slice.call(root.querySelectorAll(TOAST)));
    for (var j = 0; j < cands.length; j++) {
      var t = cands[j];
      if (!/comfy\s*agent/i.test(t.textContent || '')) continue;
      // innermost only: never hide a whole toast stack that also holds other messages
      var inner = t.querySelectorAll(TOAST), deeper = false;
      for (var q = 0; q < inner.length; q++) if (/comfy\s*agent/i.test(inner[q].textContent || '')) { deeper = true; break; }
      if (deeper) continue;
      hide(t.closest('.p-toast-message') || t, 'agent-toast');
    }
  }

  var queued = [], scheduled = false;
  function flush() { scheduled = false; var list = queued.splice(0); for (var i = 0; i < list.length; i++) { try { scan(list[i]); } catch (e) { /* keep ComfyUI running */ } } }
  function queue(el) { queued.push(el); if (!scheduled) { scheduled = true; (window.requestAnimationFrame || setTimeout)(flush); } }

  function start() {
    try { scan(document.body); } catch (e) { /* ignore */ }
    try {
      new MutationObserver(function (records) {
        for (var i = 0; i < records.length; i++) {
          var r = records[i];
          if (r.type === 'characterData') { if (r.target.parentElement) queue(r.target.parentElement); continue; }
          for (var k = 0; k < r.addedNodes.length; k++) { var n = r.addedNodes[k]; queue(n.nodeType === 1 ? n : n.parentElement); }
        }
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    } catch (e) { /* no observer: the first scan is all we do */ }
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
