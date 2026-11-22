// conn-banner.js - when to show "Not connected to ComfyUI - retrying…" (batch 4).
// -----------------------------------------------------------------------------
// Coming back from another app, the phone's old websocket is usually dead and
// a new one takes a moment to open. That is normal and not worth a banner, so:
//   * the banner appears only after the connection has been down for graceMs
//     (4 s) without coming back;
//   * resume() (the app is visible again, the network came back) hides the
//     banner and starts a fresh grace period, because a reconnect is starting
//     right now;
//   * the banner hides the moment the socket opens.
// Pure logic with injectable timers, so the unit tests can drive it.
// -----------------------------------------------------------------------------
export const GRACE_MS = 4000;

export class ConnectionBanner {
  /** @param o.show() / o.hide()  @param o.graceMs  @param o.setTimer / o.clearTimer (tests) */
  constructor({ show, hide, graceMs = GRACE_MS, setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t) } = {}) {
    Object.assign(this, { show, hide, graceMs, setTimer, clearTimer });
    this.up = true; this.timer = null; this.shown = false;
  }

  #arm() {
    if (this.timer !== null) return;
    this.timer = this.setTimer(() => { this.timer = null; if (!this.up) { this.shown = true; this.show(); } }, this.graceMs);
  }
  #disarm() { if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; } }

  /** The socket opened. */
  connected() { this.up = true; this.#disarm(); if (this.shown) { this.shown = false; this.hide(); } }

  /** The socket closed (or failed to open). The banner waits out the grace period. */
  disconnected() { this.up = false; if (!this.shown) this.#arm(); }

  /** Back in the foreground: a reconnect starts now, so give it a fresh grace period. */
  resume() {
    this.#disarm();
    if (this.shown) { this.shown = false; this.hide(); }
    if (!this.up) this.#arm();
  }
}
