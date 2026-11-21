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
