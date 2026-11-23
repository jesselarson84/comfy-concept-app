// native.js - optional bridge to the Android wrapper app (see android/).
// -----------------------------------------------------------------------------
// The Android app injects window.AndroidBridge (only for the configured server
// origin). When it is there, Save/Share go through the native gallery and share
// sheet, and the screen is kept on while a batch is running. In a normal browser
// or the PWA, window.AndroidBridge is undefined and nothing here does anything.
// The bridge is read on every call (never cached), so it can come and go.
// -----------------------------------------------------------------------------

/** The bridge object, or null when not running inside the Android app. */
export function bridge() {
  const b = typeof window !== 'undefined' ? window.AndroidBridge : undefined;
  return b && typeof b === 'object' ? b : null;
}

/** Absolute URL for a relative one (the native side needs a full https URL). */
export function absoluteUrl(u) { return new URL(u, location.href).href; }

/** True if the bridge has this method. */
export function has(name) { const b = bridge(); return !!b && typeof b[name] === 'function'; }

let awake = null; // last value sent, so we only call on changes
/** Keep the screen on while jobs are active (no-op without the bridge). */
export function setKeepAwake(on) {
  if (!has('keepAwake')) return;
  on = !!on;
  if (on === awake) return;
  awake = on;
  try { bridge().keepAwake(on); } catch { /* bridge refused (other origin) */ }
}

let runKey = null; // last run status sent
/**
 * Run progress for the Android app: while running the WebView is not paused
 * in the background; when it ends the phone vibrates. (Batch 8: no run
 * notification any more.)
 * Sent only on changes. No-op without the bridge.
 */
export function setRunStatus({ current = 0, total = 0, running = false, done = 0 } = {}) {
  if (!has('runStatus')) return;
  const key = running ? `${current}/${total}/${done}` : 'idle';
  if (key === runKey) return;
  // Nothing to finish if no run was reported yet (first paint).
  if (!running && runKey === null) { runKey = key; return; }
  runKey = key;
  try { bridge().runStatus(current | 0, total | 0, !!running, done | 0); } catch { /* bridge refused */ }
}
