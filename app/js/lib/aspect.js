// aspect.js - turn "portrait/square/landscape" into width/height.
// We keep the preset's pixel count (e.g. 1024x1024 = ~1MP) and change only the
// shape, rounding to a multiple of 16 (Flux-family VAEs/latents want /16).
export const ASPECTS = { portrait: [2, 3], square: [1, 1], landscape: [3, 2] };

export function sizeFor(aspect, baseW = 1024, baseH = 1024, multiple = 16) {
  const [rw, rh] = ASPECTS[aspect] || ASPECTS.square;
  const area = baseW * baseH;
  const w = Math.sqrt((area * rw) / rh);
  const h = w * (rh / rw);
  const round = (x) => Math.max(multiple, Math.round(x / multiple) * multiple);
  return { width: round(w), height: round(h) };
}
