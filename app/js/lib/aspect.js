// aspect.js - turn an aspect choice into width/height.
// We keep the preset's pixel count (e.g. 1024x1024 = ~1MP) and change only the
// shape, rounding to a multiple of 16 (Flux-family VAEs/latents want /16).
// Aspect values:
//   ratio chips + orientation: "1:1", "4:3-landscape", "3:2-portrait", "16:9-landscape" ...
//   legacy names (saved state / history before batch1): portrait, square, landscape
export const RATIOS = { '1:1': [1, 1], '4:3': [4, 3], '3:2': [3, 2], '16:9': [16, 9] };
export const ASPECTS = { portrait: [2, 3], square: [1, 1], landscape: [3, 2] };

/** "3:2-portrait" -> { ratio: '3:2', orient: 'portrait' }; legacy names map to the same chips. */
export function parseAspect(a) {
  if (a && typeof a === 'object') return { ratio: RATIOS[a.ratio] ? a.ratio : '1:1', orient: a.orient === 'portrait' ? 'portrait' : 'landscape' };
  const s = String(a || '');
  if (s === 'square') return { ratio: '1:1', orient: 'landscape' };
  if (s === 'portrait') return { ratio: '3:2', orient: 'portrait' };
  if (s === 'landscape') return { ratio: '3:2', orient: 'landscape' };
  const m = /^(\d+:\d+)(?:-(portrait|landscape))?$/.exec(s);
  if (m && RATIOS[m[1]]) return { ratio: m[1], orient: m[2] || 'landscape' };
  return { ratio: '1:1', orient: 'landscape' };
}

/** { ratio, orient } -> canonical string ("1:1" has no orientation). */
export function aspectKey({ ratio, orient }) { return ratio === '1:1' ? '1:1' : `${ratio}-${orient === 'portrait' ? 'portrait' : 'landscape'}`; }

function shape(aspect) {
  const { ratio, orient } = parseAspect(aspect);
  const [a, b] = RATIOS[ratio];
  return orient === 'portrait' ? [Math.min(a, b), Math.max(a, b)] : [Math.max(a, b), Math.min(a, b)];
}

export function sizeFor(aspect, baseW = 1024, baseH = 1024, multiple = 16) {
  const [rw, rh] = shape(aspect);
  const area = baseW * baseH;
  const w = Math.sqrt((area * rw) / rh);
  const h = w * (rh / rw);
  const round = (x) => Math.max(multiple, Math.round(x / multiple) * multiple);
  return { width: round(w), height: round(h) };
}
