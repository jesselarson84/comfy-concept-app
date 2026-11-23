// resolution.js - the 1K / 2K / 4K picker next to Aspect (batch 5).
// -----------------------------------------------------------------------------
// The aspect ratio is locked to the chosen resolution's LONG side:
//   1K -> long side 1024 (16:9 = 1024x576), rendered natively
//   2K -> long side 2048 (16:9 = 2048x1152), rendered natively
//   4K -> rendered at 2K, then upscaled 2x in the same graph (16:9 = 4096x2304):
//         ESRGAN-type 4x model, then resized by 0.5 (same chain as the Upscale action)
// Only text-to-image presets with a size block use it; everything else keeps
// the old "keep the preset's pixel count" sizing (lib/aspect.js sizeFor).
// -----------------------------------------------------------------------------
import { parseAspect, RATIOS } from './aspect.js';

export const RESOLUTIONS = {
  '1k': { label: '1K', long: 1024, upscale: 1 },
  '2k': { label: '2K', long: 2048, upscale: 1 },
  '4k': { label: '4K', long: 2048, upscale: 2 },
};
export const normRes = (r) => (RESOLUTIONS[r] ? r : '1k');

/** Upscale models tried in this order for 4K (the Upscale action's list). */
export const UPSCALE_MODELS = ['4x-UltraSharp.safetensors', 'RealESRGAN_x4plus.safetensors', '4x-ClearRealityV1.safetensors', '4x_foolhardy_Remacri.pth'];

/** Does the 1K/2K/4K picker apply to this preset? (image output + a size block + width/height controls) */
export function resolutionApplies(wf) {
  const c = wf?.ok ? wf.controls : null;
  return !!(wf?.ai?.size && wf.ai.output === 'image' && c?.width?.length && c?.height?.length);
}

/** Render size (what the sampler makes) for an aspect at a resolution. */
export function renderSize(aspect, res, multiple = 16) {
  const { ratio, orient } = parseAspect(aspect);
  const [a, b] = RATIOS[ratio];
  const long = RESOLUTIONS[normRes(res)].long;
  const short = Math.max(multiple, Math.round((long * Math.min(a, b)) / Math.max(a, b) / multiple) * multiple);
  return orient === 'portrait' ? { width: short, height: long } : { width: long, height: short };
}

/** Final size after the optional upscale. */
export function finalSize(aspect, res, multiple = 16) {
  const s = renderSize(aspect, res, multiple), k = RESOLUTIONS[normRes(res)].upscale;
  return { width: s.width * k, height: s.height * k };
}

/**
 * Insert "4x model -> resize to factor" in front of every SaveImage, so the
 * saved picture is the upscaled one. Returns a new graph; node ids are fresh.
 */
export function withUpscale(workflow, modelName, factor = 2) {
  const out = structuredClone(workflow);
  let next = Math.max(0, ...Object.keys(out).map((k) => Number(String(k).split(':').pop())).filter(Number.isFinite)) + 1000;
  const id = () => String(next++);
  let loader = null;
  for (const [nid, n] of Object.entries(workflow)) {
    if (n?.class_type !== 'SaveImage' || !Array.isArray(n.inputs?.images)) continue;
    if (!loader) { loader = id(); out[loader] = { class_type: 'UpscaleModelLoader', inputs: { model_name: modelName }, _meta: { title: '4K upscale model' } }; }
    const up = id(), scale = id();
    out[up] = { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: [loader, 0], image: n.inputs.images }, _meta: { title: '4K upscale 4x' } };
    out[scale] = { class_type: 'ImageScaleBy', inputs: { image: [up, 0], upscale_method: 'lanczos', scale_by: factor / 4 }, _meta: { title: `4K resize to ${factor}x` } };
    out[nid].inputs.images = [scale, 0];
  }
  return out;
}

/** First installed upscale model from UPSCALE_MODELS, or the first installed at all; null when none. */
export function pickUpscaleModel(installed = []) {
  return UPSCALE_MODELS.find((m) => installed.includes(m)) || installed[0] || null;
}
