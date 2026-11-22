// mask-paint.js - pure helpers for the inpaint mask editor (ui/mask-editor.js):
// which pointer paints, erases or is ignored, brush width from pen pressure,
// stroke smoothing, pinch/pan view maths, and the export to a black/white PNG
// mask (white = repaint) at the picture's own size.

/** Eraser: the pen's eraser end (button 5 / buttons bit 32) or its barrel
 *  button (button 2 / buttons bit 2). */
export function isEraserPointer(e) {
  if (e.pointerType !== 'pen') return false;
  return e.button === 5 || e.button === 2 || ((e.buttons || 0) & (32 | 2)) !== 0;
}

/** Palm rejection: while a pen is in use (down, or seen in the last 1.5 s),
 *  touches never paint; a very large contact patch is a palm too. */
export function isPalm(e, { penActiveAt = 0, now = Date.now() } = {}) {
  if (e.pointerType !== 'touch') return false;
  if (now - penActiveAt < 1500) return true;
  return Math.max(e.width || 0, e.height || 0) > 48;
}

/** Brush width in image pixels. Pressure (pen only, when switched on) scales
 *  between 20 % and 100 % of the size; mouse/touch report 0.5 and are ignored. */
export function brushWidth(size, e, pressureOn) {
  if (!pressureOn || e.pointerType !== 'pen' || !(e.pressure > 0)) return size;
  return size * (0.2 + 0.8 * Math.min(1, e.pressure));
}

/** Light smoothing: each point moves part of the way from the last smoothed
 *  point (factor 0 = raw, low latency; the editor uses ~0.35). */
export function smoothPoint(prev, p, factor = 0.35) {
  if (!prev) return { ...p };
  return { ...p, x: prev.x + (p.x - prev.x) * (1 - factor), y: prev.y + (p.y - prev.y) * (1 - factor) };
}

/** Pinch/pan: new view from the two touch points at gesture start (a0, b0)
 *  and now (a1, b1). view = { scale, x, y } maps image px -> screen px as
 *  screen = image * scale + (x, y). Scale is clamped to [min, max]. */
export function pinchView(view0, a0, b0, a1, b1, { min = 0.1, max = 16 } = {}) {
  const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y) || 1;
  const d1 = Math.hypot(b1.x - a1.x, b1.y - a1.y) || 1;
  const scale = Math.min(max, Math.max(min, view0.scale * (d1 / d0)));
  const k = scale / view0.scale;
  const m0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
  const m1 = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 };
  // The image point under the old midpoint stays under the new midpoint.
  return { scale, x: m1.x - (m0.x - view0.x) * k, y: m1.y - (m0.y - view0.y) * k };
}

/** View that fits a w x h picture inside a box (centered, with a margin). */
export function fitView(w, h, boxW, boxH, margin = 8) {
  const scale = Math.max(0.01, Math.min((boxW - 2 * margin) / w, (boxH - 2 * margin) / h));
  return { scale, x: (boxW - w * scale) / 2, y: (boxH - h * scale) / 2 };
}

export const toImage = (view, sx, sy) => ({ x: (sx - view.x) / view.scale, y: (sy - view.y) / view.scale });

/** RGBA of the painted layer (alpha = paint) -> RGBA of the mask PNG:
 *  white where painted (alpha >= 128), black elsewhere; invert flips it. */
export function maskPixels(rgba, invert = false) {
  const out = new Uint8ClampedArray(rgba.length);
  let painted = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    let on = rgba[i + 3] >= 128;
    if (invert) on = !on;
    if (on) painted++;
    const v = on ? 255 : 0;
    out[i] = out[i + 1] = out[i + 2] = v; out[i + 3] = 255;
  }
  return { data: out, painted };
}
