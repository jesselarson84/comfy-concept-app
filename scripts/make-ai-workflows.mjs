// make-ai-workflows.mjs - writes the AI Workflows presets (workflows/ai/wf-*.json,
// kind "workflow", from the Comfy UI Ideas doc). The JSON files are what the app
// and the tests read; this script is how they are made, so change the graphs here
// and re-run it (hand edits to wf-*.json are overwritten), then
// node scripts/sync-comfy-menu.mjs for ComfyUI's menus.
//   node scripts/make-ai-workflows.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const REPO = process.argv[2] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(REPO, 'workflows/ai');
const read = (f) => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));

/** Tiny graph builder: n(class, inputs, title) -> id; L(id, slot) -> link. */
function graph() {
  const g = {}; let i = 0;
  const n = (class_type, inputs, title) => { const id = String(++i); g[id] = { inputs, class_type, _meta: { title: title || class_type } }; return id; };
  return { g, n };
}
const L = (id, slot = 0) => [String(id), slot];
const math = (n, expr, vals, title) => n('ComfyMathExpression', { expression: expr, ...Object.fromEntries(Object.entries(vals).map(([k, v]) => [`values.${k}`, v])) }, title || `= ${expr}`);
const INT = 1; // ComfyMathExpression outputs: FLOAT, INT, BOOL

/**
 * Seamless: shift by half (the old edges meet in the middle as a cross), fix the
 * cross, shift back. Only the cross changes; the borders of the result wrap
 * because they were neighbouring pixels in the source. Two ways to fix the cross
 * (o.mode 'repaint' | 'blend' | 'both' = a lazy switch, only the chosen one runs):
 *   repaint  Z-Image + Fun ControlNet in inpaint mode repaints a band over the
 *            cross (the model sees the picture around it). Best for shapes and
 *            structure (bricks, planks, tiles).
 *   blend    the classic offset blend: the unshifted picture (whole in the middle)
 *            is faded in over the cross with a wide soft mask. No model, instant.
 *            Best for noise-like textures (grunge, concrete, dirt): tested, the
 *            repaint smoothed their grain into flat grey bands.
 */
function seamFix(n, img, o) {
  const mode = o.mode || 'repaint';
  const size = n('GetImageSize', { image: img }, 'Seam: image size');
  const w = math(n, 'a', { a: L(size, 0) }, 'Seam: width');
  const h = math(n, 'a', { a: L(size, 1) }, 'Seam: height');
  const hw = math(n, 'a // 2', { a: L(w, INT) }, 'Seam: half width');
  const hh = math(n, 'a // 2', { a: L(h, INT) }, 'Seam: half height');
  const sh = (src, sx, sy, tag) => {
    const rx = math(n, 'a - b', { a: L(w, INT), b: L(sx, INT) }, `${tag}: rest of width`);
    const ry = math(n, 'a - b', { a: L(h, INT), b: L(sy, INT) }, `${tag}: rest of height`);
    const crop = (cw, ch, x, y, t) => n('ImageCrop', { image: src, width: cw, height: ch, x, y }, `${tag}: ${t}`);
    const A = crop(L(sx, INT), L(sy, INT), 0, 0, 'top left');
    const B = crop(L(rx, INT), L(sy, INT), L(sx, INT), 0, 'top right');
    const C = crop(L(sx, INT), L(ry, INT), 0, L(sy, INT), 'bottom left');
    const D = crop(L(rx, INT), L(ry, INT), L(sx, INT), L(sy, INT), 'bottom right');
    const st = (a, dir, b, t) => n('ImageStitch', { image1: L(a), direction: dir, match_image_size: false, spacing_width: 0, spacing_color: 'black', image2: L(b) }, `${tag}: ${t}`);
    return { out: st(st(D, 'right', C, 'top row'), 'down', st(B, 'right', A, 'bottom row'), 'shifted'), rx, ry };
  };
  const s1 = sh(img, hw, hh, 'Seam: shift half');
  // a cross mask over where the old edges meet: x = width - half, y = height - half
  const cross = (expr, tag) => {
    const band = math(n, expr, { a: L(w, INT), b: L(h, INT) }, `${tag}: band width`);
    const bx = math(n, 'a - b // 2', { a: L(s1.rx, INT), b: L(band, INT) }, `${tag}: band x`);
    const by = math(n, 'a - b // 2', { a: L(s1.ry, INT), b: L(band, INT) }, `${tag}: band y`);
    const base = n('SolidMask', { value: 0, width: L(w, INT), height: L(h, INT) }, `${tag}: empty mask`);
    const vb = n('SolidMask', { value: 1, width: L(band, INT), height: L(h, INT) }, `${tag}: vertical band`);
    const hb = n('SolidMask', { value: 1, width: L(w, INT), height: L(band, INT) }, `${tag}: horizontal band`);
    const m1 = n('MaskComposite', { destination: L(base), source: L(vb), x: L(bx, INT), y: 0, operation: 'or' }, `${tag}: + vertical`);
    return n('MaskComposite', { destination: L(m1), source: L(hb), x: 0, y: L(by, INT), operation: 'or' }, `${tag}: cross mask`);
  };
  let repaint = null, blend = null, ks = null, patch = null, inp = null;
  if (mode !== 'blend') ({ comp: repaint, ks, patch, inp } = repaintCross());
  if (mode !== 'repaint') blend = blendCross();
  const fixed = mode === 'both'
    ? n('ComfySwitchNode', { switch: true, on_false: L(blend), on_true: L(repaint) }, 'Seam method (repaint / blend)')
    : (repaint || blend);
  // shift back, so the picture sits where it was (by the rest: half + rest = full width)
  const s2 = sh(L(fixed), s1.rx, s1.ry, 'Seam: shift back');
  return { out: s2.out, sampler: ks, patch, inp, method: mode === 'both' ? fixed : null };

  function blendCross() {
    // wide cross (a third of the short side), feathered: blurred small, scaled back up
    const m = cross('max(64, min(a, b) // 3)', 'Blend');
    const small = n('ImageScale', { image: L(n('MaskToImage', { mask: L(m) }, 'Blend: mask to image')), upscale_method: 'bilinear', width: 64, height: 64, crop: 'disabled' }, 'Blend: shrink mask');
    const blurred = n('ImageBlur', { image: L(small), blur_radius: 8, sigma: 4 }, 'Blend: feather');
    const big = n('ImageScale', { image: L(blurred), upscale_method: 'bilinear', width: L(w, INT), height: L(h, INT), crop: 'disabled' }, 'Blend: mask full size');
    const soft = n('ImageToMask', { image: L(big), channel: 'red' }, 'Blend: soft cross');
    return n('ImageCompositeMasked', { destination: L(s1.out), source: img, x: 0, y: 0, resize_source: false, mask: L(soft) }, 'Blend: original over the cross');
  }

  function repaintCross() {
  const m2 = cross('max(32, min(a, b) // 12 // 16 * 16)', 'Seam');
  const soft = n('ImageToMask', { image: L(n('ImageBlur', { image: L(n('MaskToImage', { mask: L(m2) }, 'Seam: mask to image')), blur_radius: 31, sigma: 10 }, 'Seam: soften edge')), channel: 'red' }, 'Seam: soft mask');
  const enc = n('VAEEncode', { pixels: L(s1.out), vae: o.vae }, 'Seam: encode');
  const masked = n('SetLatentNoiseMask', { samples: L(enc), mask: L(m2) }, 'Seam: repaint only the cross');
  // Z-Image Fun ControlNet in inpaint mode: the model sees the picture around the cross.
  const patch = n('ModelPatchLoader', { name: o.patch }, 'Seam: load ControlNet (inpaint)');
  // the inpaint guide gets the cross blanked to mid grey (what the inpaint mode is trained on)
  const grey = n('MaskToImage', { mask: L(n('SolidMask', { value: 0.5, width: L(w, INT), height: L(h, INT) }, 'Seam: mid grey')) }, 'Seam: grey image');
  const blanked = n('ImageCompositeMasked', { destination: L(s1.out), source: L(grey), x: 0, y: 0, resize_source: false, mask: L(m2) }, 'Seam: cross blanked');
  const inp = n('ZImageFunControlnet', { model: o.model, model_patch: L(patch), vae: o.vae, strength: 1, inpaint_image: L(blanked), mask: L(m2), start_percent: 0, end_percent: 1 }, 'Seam: ControlNet inpaint');
  const ks = n('KSampler', { seed: 0, steps: o.steps, cfg: o.cfg ?? 1, sampler_name: o.sampler || 'res_multistep', scheduler: o.scheduler || 'simple', denoise: o.denoise, model: L(inp), positive: o.positive, negative: o.negative, latent_image: L(masked) }, 'Seam fix sampler');
  const dec = n('VAEDecode', { samples: L(ks), vae: o.vae }, 'Seam: decode');
  const comp = n('ImageCompositeMasked', { destination: L(s1.out), source: L(dec), x: 0, y: 0, resize_source: false, mask: L(soft) }, 'Seam: blend repaint in');
  return { comp, ks, patch, inp };
  }
}

/** Z-Image Turbo model / text encoder / vae nodes. */
function zimage(n, promptTitle = 'Prompt #prompt', promptText = '') {
  const unet = n('UNETLoader', { unet_name: 'z_image_turbo_bf16.safetensors', weight_dtype: 'default' }, 'Load Diffusion Model');
  const clip = n('CLIPLoader', { clip_name: 'qwen_3_4b.safetensors', type: 'lumina2', device: 'default' }, 'Load CLIP');
  const vae = n('VAELoader', { vae_name: 'ae.safetensors' }, 'Load VAE');
  const ms = n('ModelSamplingAuraFlow', { shift: 3, sampling: 'flow', model: L(unet) }, 'ModelSamplingAuraFlow');
  const pos = n('CLIPTextEncode', { text: promptText, clip: L(clip) }, promptTitle);
  const neg = n('ConditioningZeroOut', { conditioning: L(pos) }, 'Conditioning Zero Out');
  return { unet, clip, vae, ms, pos, neg };
}

const LITE = 'Z-Image-Turbo-Fun-Controlnet-Union-2.1-lite-2602-8steps.safetensors';
const FULL = 'Z-Image-Turbo-Fun-Controlnet-Union-2.1-2602-8steps.safetensors';
const UPSCALERS = { options: ['4x-UltraSharp.safetensors', '4x-ClearRealityV1.safetensors', '4x_NMKD-Siax_200k.pth', '4x_foolhardy_Remacri.pth', 'RealESRGAN_x4plus.safetensors'], labels: { '4x-UltraSharp.safetensors': 'UltraSharp', '4x-ClearRealityV1.safetensors': 'ClearReality', '4x_NMKD-Siax_200k.pth': 'NMKD-Siax', '4x_foolhardy_Remacri.pth': 'Remacri', 'RealESRGAN_x4plus.safetensors': 'RealESRGAN x4plus' } };
const files = {};

// ---- Textures / Upscale Texture --------------------------------------------
{
  const { g, n } = graph();
  const img = n('LoadImage', { image: 'example.png' }, 'Texture #image');
  const um = n('UpscaleModelLoader', { model_name: '4x-UltraSharp.safetensors' }, 'Load Upscale Model');
  const up = n('ImageUpscaleWithModel', { upscale_model: L(um), image: L(img) }, 'Upscale 4x (model)');
  const fit = n('ResizeImagesByLongerEdge', { images: L(up), longer_edge: 2048 }, 'Fit to texture size');
  n('SaveImage', { filename_prefix: 'concept-app/texture_upscale', images: L(fit) }, 'Save Image');
  files['wf-texture-upscale'] = { preset: {
    kind: 'workflow', group: 'Textures', label: 'Upscale Texture', menuPath: 'Textures/Upscale Texture', menuOrder: 1,
    source: 'Comfy UI Ideas doc, Texture Cleanup and Prep: upscale (authored)', output: 'image',
    description: 'Enlarge a texture, logo or photo with an upscale model, then fit it to 1K / 2K / 4K on the long side. No AI repainting, so logos and text stay exact.',
    params: {
      model: { node: um, input: 'model_name', type: 'enum', ...UPSCALERS, default: '4x-UltraSharp.safetensors', label: 'Model', control: 'select', info: 'Which upscale model. UltraSharp and Remacri keep edges crisp (logos, flat graphics); ClearReality and NMKD-Siax suit photos and scans; RealESRGAN is an all-rounder.' },
      size: { node: fit, input: 'longer_edge', type: 'enum', options: [1024, 2048, 4096], default: 2048, label: 'Texture size', control: 'seg', labels: { 1024: '1K', 2048: '2K', 4096: '4K' }, info: 'Size of the long side of the result. The model enlarges 4x, then the picture is fitted to this size (the shape is kept).' },
    },
    maxBatch: 4, vram: { estMB: 1800, basis: '67 MB upscale model; 4x activations on a 1K input' },
    info: { image: 'The texture, logo or photo to enlarge. Nothing is repainted, so it stays faithful to the original.' },
  }, workflow: g };
}

// ---- Textures / Remove Lighting (delight) -----------------------------------
{
  const q = read('qwen-edit-2511.json');
  const wf = structuredClone(q.workflow);
  wf['6']._meta.title = 'Photo texture #image';
  wf['7']._meta.title = 'Instruction #prompt';
  wf['12'].inputs.filename_prefix = 'concept-app/texture_delight';
  const params = structuredClone(q.preset.params);
  files['wf-remove-lighting'] = { preset: {
    kind: 'workflow', group: 'Textures', label: 'Remove Lighting', menuPath: 'Textures/Remove Lighting', menuOrder: 2,
    source: 'Comfy UI Ideas doc, Texture Cleanup and Prep: delighting. Graph from the Qwen Image Edit 2511 preset.', output: 'image',
    description: 'Removes baked-in shadows and highlights from a photo texture so it works as albedo under Unreal lighting (Qwen Image Edit 2511). Not physically exact; compare with the original.',
    promptDefault: 'Remove all shadows, highlights and reflections. Flat, even, diffuse lighting from every side. Keep exactly the same surface, colors, pattern and framing. Clean albedo texture.',
    params, maxBatch: 4, vram: q.preset.vram, optional: q.preset.optional, files: q.preset.files, gguf: q.preset.gguf,
    info: { image: 'A photo texture with lighting baked in (shadows, hot spots, reflections).', prompt: 'Leave empty to use the built-in instruction (shown in the box). Type your own to change what is removed, e.g. "remove the shadow in the top left only".' },
  }, workflow: wf };
}

// ---- Textures / Make Seamless ----------------------------------------------
{
  const { g, n } = graph();
  const z = zimage(n, 'Describe the material #prompt');
  const img = n('LoadImage', { image: 'example.png' }, 'Texture #image');
  const fit = n('ResizeImagesByLongerEdge', { images: L(img), longer_edge: 1024 }, 'Working size');
  const sz = n('GetImageSize', { image: L(fit) }, 'Size');
  const w16 = math(n, 'a // 16 * 16', { a: L(sz, 0) }, 'Width, multiple of 16');
  const h16 = math(n, 'a // 16 * 16', { a: L(sz, 1) }, 'Height, multiple of 16');
  const snap = n('ImageScale', { image: L(fit), upscale_method: 'lanczos', width: L(w16, INT), height: L(h16, INT), crop: 'center' }, 'Snap to multiple of 16');
  const s = seamFix(n, L(snap), { mode: 'both', model: L(z.ms), positive: L(z.pos), negative: L(z.neg), vae: L(z.vae), steps: 8, denoise: 1, patch: LITE });
  n('SaveImage', { filename_prefix: 'concept-app/texture_seamless', images: L(s.out) }, 'Save Image');
  files['wf-make-seamless'] = { preset: {
    kind: 'workflow', group: 'Textures', label: 'Make Seamless', menuPath: 'Textures/Make Seamless', menuOrder: 3,
    source: 'Comfy UI Ideas doc, Texture Cleanup and Prep: seamless tiling (half offset + seam inpaint, authored)', output: 'image',
    description: 'Makes a texture tile: shifts it by half so the edges meet in the middle, fixes that cross (AI repaint with Z-Image Turbo, or a soft blend), and shifts it back. The rest of the picture is untouched.',
    promptDefault: 'seamless continuous texture, same material, same pattern and scale, flat lighting',
    params: {
      size: { node: fit, input: 'longer_edge', type: 'enum', options: [1024, 2048], default: 1024, label: 'Working size', control: 'seg', labels: { 1024: '1K', 2048: '2K' }, info: 'Size of the long side while the seam is repainted, and of the result. 2K keeps more detail but takes about four times as long.' },
      method: { node: s.method, input: 'switch', type: 'enum', options: [false, true], default: true, label: 'Seam fix', control: 'seg', labels: { false: 'Blend', true: 'AI repaint' }, span2: true, info: 'How the seam cross is fixed. AI repaint redraws it with Z-Image so shapes carry on across the seam: best for bricks, planks, tiles, anything with structure. Blend fades the original over the seam with a soft mask: instant, no AI, best for noise-like surfaces (concrete, dirt, grunge), where a repaint can come out flat.' },
      blend: { node: s.sampler, input: 'denoise', type: 'number', min: 0.5, max: 1, step: 0.05, default: 1, label: 'Repaint strength', control: 'slider', when: { param: 'method', is: true }, info: 'How much of the seam cross is redrawn. 1 redraws it completely so shapes join up cleanly; lower keeps more of the original there but can leave a faint line.' },
      steps: { node: s.sampler, input: 'steps', type: 'int', min: 4, max: 12, default: 8, label: 'Steps', control: 'stepper', when: { param: 'method', is: true }, info: 'Refinement passes for the seam repaint. Z-Image Turbo is made for about 8.' },
    },
    maxBatch: 4, vram: { estMB: 15800, basis: 'Z-Image Turbo bf16 + 2 GB lite ControlNet patch (inpaint) at the working size' }, files: [{ folder: 'model_patches', file: LITE }],
    info: { image: 'The texture to make tileable. Square power-of-two textures work best; other shapes are kept.', prompt: 'Optional: what the material is ("mossy cobblestones"). Helps the repainted seam match. Leave empty for a neutral instruction.' },
  }, workflow: g };
}

// ---- Textures / Grunge Map ---------------------------------------------------
{
  const { g, n } = graph();
  const z = zimage(n, 'Grunge prompt #prompt');
  const lat = n('EmptySD3LatentImage', { width: 1024, height: 1024, batch_size: 1 }, 'EmptySD3LatentImage');
  const ks = n('KSampler', { seed: 0, steps: 8, cfg: 1, sampler_name: 'res_multistep', scheduler: 'simple', denoise: 1, model: L(z.ms), positive: L(z.pos), negative: L(z.neg), latent_image: L(lat) }, 'KSampler');
  const dec = n('VAEDecode', { samples: L(ks), vae: L(z.vae) }, 'VAE Decode');
  const s = seamFix(n, L(dec), { mode: 'blend' });
  const yuv = n('ImageRGBToYUV', { image: L(s.out) }, 'Grayscale (luma)');
  const con = n('AdjustContrast', { images: L(yuv, 0), factor: 1.4 }, 'Push contrast');
  n('SaveImage', { filename_prefix: 'concept-app/grunge_map', images: L(con) }, 'Save Image');
  files['wf-grunge-map'] = { preset: {
    kind: 'workflow', group: 'Textures', label: 'Grunge Map', menuPath: 'Textures/Grunge Map', menuOrder: 4,
    source: 'Comfy UI Ideas doc, VFX Sprites and Grunge Maps: grunge, scratch and stain maps (authored)', output: 'image',
    description: 'Seamless grayscale mask (grunge, scratches, stains, noise) to drive roughness or dirt blends in Unreal. Z-Image Turbo, then an offset blend makes it tile, then grayscale and a contrast push.',
    promptFormat: { template: '{text}, dense high-contrast grunge pattern filling the entire frame edge to edge, black and white, seamless tileable texture, top-down flat scan, even lighting, no objects' },
    size: { base: [1024, 1024], min: 512, max: 2048, multiple: 16 },
    params: {
      contrast: { node: con, input: 'factor', type: 'number', min: 1, max: 2, step: 0.1, default: 1.4, label: 'Contrast', control: 'slider', format: 'x', info: 'How hard the grays are pushed toward black and white. Higher gives a cleaner mask for blends; lower keeps soft in-between values.' },
      steps: { node: ks, input: 'steps', type: 'int', min: 4, max: 12, default: 8, label: 'Steps', control: 'stepper', info: 'Refinement passes. Z-Image Turbo is made for about 8.' },
    },
    maxBatch: 8, vram: { estMB: 13800, basis: 'Z-Image Turbo bf16 at 1 MP (the seam blend needs no model)' },
    info: { prompt: 'What kind of grunge: "concrete stains", "fine scratches", "rust patches", "dust and dirt". The words for a flat, tileable black-and-white mask are added for you.' },
  }, workflow: g };
}

// ---- VFX / Flipbook Sheet ------------------------------------------------------
{
  const w = read('wan22-5b-ti2v.json');
  const wf = structuredClone(w.workflow);
  wf['6']._meta.title = 'Effect #prompt';
  delete wf['58'];
  wf['55'].inputs.width = 704; wf['55'].inputs.height = 704; wf['55'].inputs.length = 81;
  // frames out of the clip, evenly spaced, into a grid
  const add = (id, class_type, inputs, title) => { wf[id] = { inputs, class_type, _meta: { title } }; return id; };
  add('70', 'VideoFrameSample', { video: ['57', 0], num_frames: 16, strategy: 'uniform', seed: 0 }, 'Pick evenly spaced frames');
  add('71', 'GetVideoComponents', { video: ['70', 0] }, 'Frames');
  add('72', 'ComfyMathExpression', { expression: 'int(round(a ** 0.5))', 'values.a': 16 }, 'Columns = square root of frames');
  add('73', 'ImageGrid', { images: ['71', 0], columns: ['72', 1], cell_width: 256, cell_height: 256, padding: 0 }, 'Tile into a sheet');
  add('74', 'SaveImage', { filename_prefix: 'concept-app/flipbook', images: ['73', 0] }, 'Save Image');
  const p = w.preset.params;
  files['wf-flipbook'] = { preset: {
    kind: 'workflow', group: 'VFX', label: 'Flipbook Sheet', menuPath: 'VFX/Flipbook Sheet', menuOrder: 1,
    source: 'Comfy UI Ideas doc, VFX Sprites and Grunge Maps: flipbook sprite sheets, route 1 (Wan video, frames tiled). Graph from the Wan 2.2 5B preset.', output: 'image',
    description: 'Smoke, fire, dust or sparks as a flipbook texture sheet for Unreal particle materials: a short Wan 2.2 clip on black, evenly spaced frames tiled into a grid. Use it additive, or remove the black.',
    promptFormat: { template: 'Close-up VFX element: {text}. Large, filling most of the frame, it grows and changes shape over time, full life cycle from start to end. Isolated on a pure black background, centered, static locked-off camera, no camera movement.' },
    size: { base: [704, 704], min: 480, max: 1024, multiple: 32 },
    params: {
      grid: { node: '70', input: 'num_frames', also: [{ node: '72', input: 'values.a' }], type: 'enum', options: [16, 36, 64], default: 16, label: 'Sheet', control: 'seg', labels: { 16: '4Ã—4', 36: '6Ã—6', 64: '8Ã—8' }, info: 'How many frames go into the sheet (a square grid). More frames play smoother but each one is smaller in the texture.' },
      cell: { node: '73', input: 'cell_width', also: [{ node: '73', input: 'cell_height' }], type: 'enum', options: [128, 256, 512], default: 256, label: 'Frame size', control: 'seg', labels: { 128: '128', 256: '256', 512: '512' }, format: 'px', info: 'Size of each frame in the sheet. 4Ã—4 at 256 gives a 1024 sheet; 8Ã—8 at 256 a 2048 sheet.' },
      frames: { ...p.frames, min: 33, default: 81, info: 'Length of the clip the frames are picked from. Longer clips show more of the motion (a whole puff of smoke) but take longer to make.' },
      steps: p.steps, cfg: p.cfg, shift: p.shift,
    },
    maxBatch: 1, vram: w.preset.vram, optional: w.preset.optional,
    info: { prompt: 'The effect: "thick white smoke puff rising and dissipating", "campfire flames", "dust burst". Black background and a still camera are added for you.', image: 'Optional first frame, e.g. a still of the effect to animate.' },
  }, workflow: wf };
}

// ---- Concept / Concept Looks (edges + depth) ---------------------------------
for (const mode of ['edges', 'depth']) {
  const { g, n } = graph();
  const z = zimage(n, 'Look #prompt');
  const img = n('LoadImage', { image: 'example.png' }, mode === 'edges' ? 'Greybox render #image' : 'Depth pass or render #image');
  const fit = n('ImageScaleToTotalPixels', { image: L(img), upscale_method: 'lanczos', megapixels: 1, resolution_steps: 16 }, 'Fit to 1 MP');
  let ctrl = fit, canny = null, source = null;
  if (mode === 'edges') { canny = n('Canny', { image: L(fit), low_threshold: 0.2, high_threshold: 0.5 }, 'Edges (canny)'); ctrl = canny; }
  else {
    // batch 7: depth from a beauty render with MoGe (installed), or the pass as it is
    const moge = n('MoGeRender', { moge_geometry: L(n('MoGeInference', { moge_model: L(n('LoadMoGeModel', { model_name: 'moge_2_vitl_normal_fp16.safetensors' }, 'Load MoGe')), image: L(fit), resolution_level: 9, fov_x_degrees: 0, batch_size: 1, force_projection: true, apply_mask: false, refine_steps: 0 }, 'MoGe: estimate geometry')), output: 'depth' }, 'MoGe: depth (white near)');
    source = n('ComfySwitchNode', { switch: false, on_false: L(fit), on_true: L(moge) }, 'Depth source (pass / estimated)');
    ctrl = source;
  }
  const sz = n('GetImageSize', { image: L(fit) }, 'Size');
  const lat = n('EmptySD3LatentImage', { width: L(sz, 0), height: L(sz, 1), batch_size: 1 }, 'Latent (same shape as the render)');
  const patch = n('ModelPatchLoader', { name: 'Z-Image-Turbo-Fun-Controlnet-Union-2.1-2602-8steps.safetensors' }, 'Load ControlNet (model patch)');
  const cn = n('ZImageFunControlnet', { model: L(z.ms), model_patch: L(patch), vae: L(z.vae), strength: 0.75, image: L(ctrl), start_percent: 0, end_percent: 1 }, 'Z-Image Fun ControlNet');
  const ks = n('KSampler', { seed: 0, steps: 8, cfg: 1, sampler_name: 'res_multistep', scheduler: 'simple', denoise: 1, model: L(cn), positive: L(z.pos), negative: L(z.neg), latent_image: L(lat) }, 'KSampler');
  const dec = n('VAEDecode', { samples: L(ks), vae: L(z.vae) }, 'VAE Decode');
  n('SaveImage', { filename_prefix: `concept-app/concept_${mode}`, images: L(dec) }, 'Save Image');
  const params = {
    strength: { node: cn, input: 'strength', type: 'number', min: 0.3, max: 1.2, step: 0.05, default: mode === 'edges' ? 0.75 : 0.8, label: 'Follow layout', control: 'slider', info: 'How strictly the picture follows the render. Too high copies the greybox too literally (flat grey surfaces); too low and the layout drifts. 0.65-0.9 is the usual range.' },
    release: { node: cn, input: 'end_percent', type: 'number', min: 0.4, max: 1, step: 0.05, default: 1, label: 'Release at', control: 'slider', info: 'When the layout guide lets go, as a share of the steps. 1 = guided to the end. Lower (0.6-0.8) lets the last steps add free detail and texture on top of the fixed layout.' },
    patch: { node: patch, input: 'name', type: 'enum', options: ['Z-Image-Turbo-Fun-Controlnet-Union-2.1-2602-8steps.safetensors', 'Z-Image-Turbo-Fun-Controlnet-Union-2.1-lite-2602-8steps.safetensors'], default: 'Z-Image-Turbo-Fun-Controlnet-Union-2.1-2602-8steps.safetensors', label: 'ControlNet', control: 'seg', labels: { 'Z-Image-Turbo-Fun-Controlnet-Union-2.1-2602-8steps.safetensors': 'Full', 'Z-Image-Turbo-Fun-Controlnet-Union-2.1-lite-2602-8steps.safetensors': 'Lite' }, info: 'Full (6.7 GB) follows the layout more closely. Lite (2 GB) is lighter on memory and a bit looser, so it suits higher "Follow layout" values.' },
    steps: { node: ks, input: 'steps', type: 'int', min: 6, max: 12, default: 8, label: 'Steps', control: 'stepper', info: 'Refinement passes. The model and the ControlNet are made for 8.' },
  };
  if (source) {
    params.source = { node: source, input: 'switch', type: 'enum', options: [false, true], default: false, label: 'Depth from', control: 'seg', labels: { false: 'Depth pass', true: 'Estimate (MoGe)' }, span2: true, info: 'Depth pass: the picture already is a depth pass (white near, black far) rendered out of Cinema 4D or Redshift; most exact. Estimate: the picture is a normal render (greybox or rough lighting) and MoGe works out the depth from it; no extra render needed.' };
  }
  if (canny) {
    params.detail = { node: canny, input: 'low_threshold', type: 'number', min: 0.05, max: 0.6, step: 0.05, default: 0.2, label: 'Edge detail', control: 'slider', info: 'Which edges count. Lower picks up fine panel lines and texture edges; higher keeps only the strong silhouettes.' };
  }
  files[`wf-concept-${mode}`] = { preset: {
    kind: 'workflow', group: 'Concept', label: mode === 'edges' ? 'Concept Looks (Edges)' : 'Concept Looks (Depth)', menuPath: `Concept/Concept Looks (${mode === 'edges' ? 'Edges' : 'Depth'})`, menuOrder: mode === 'edges' ? 1 : 2,
    source: 'Comfy UI Ideas doc, ControlNet Concept Iteration (authored). Z-Image Turbo + Z-Image-Turbo-Fun-Controlnet-Union 2.1 (alibaba-pai).', output: 'image',
    description: mode === 'edges'
      ? 'Keeps the camera and layout of a Cinema 4D greybox or rough Redshift frame and changes the look from the prompt. Edges are found from the render (canny), so silhouettes and panel lines stay put.'
      : 'Same as Concept Looks (Edges), but guided by depth: a depth pass rendered out of Cinema 4D or Redshift, or depth estimated from a normal render with MoGe. Keeps the spatial layout without copying the greybox surfaces.',
    params, maxBatch: 8,
    vram: { estMB: 20500, basis: 'Z-Image Turbo bf16 12.3 GB + ControlNet patch 6.7 GB (2 GB lite); ComfyUI keeps what does not fit on the GPU in system RAM' },
    info: { image: mode === 'edges' ? 'A frame from Cinema 4D: greybox or rough Redshift lighting. Its shape (the picture is fitted to about 1 MP) is the shape of the result.' : 'A depth pass (white near, black far) from Cinema 4D or Redshift, or a normal render with "Depth from" set to Estimate. A dedicated pass gives the tightest control.', prompt: 'The look: materials, lighting and mood, e.g. "broadcast studio set, brushed steel, warm LED strips, glossy black floor, haze". Ten variations of one camera angle: raise Batch.' },
  }, workflow: g };
}

// =============================================================================
// Batch 7: PBR maps, depth + normal, Photo to Texture, SFX, voice swap
// =============================================================================

/** Image size as two INT math nodes (links to widget inputs need INT outputs). */
function sizeOf(n, img, tag = 'Size') {
  const sz = n('GetImageSize', { image: img }, tag);
  return { w: math(n, 'a', { a: L(sz, 0) }, `${tag}: width`), h: math(n, 'a', { a: L(sz, 1) }, `${tag}: height`) };
}
/** Wrap-around shift: out[x] = img[(x + sx) mod w] (sx, sy plain numbers; negative = the other way). */
function wrapShift(n, img, s, sx, sy, tag) {
  const ax = math(n, `(${sx}) % a`, { a: L(s.w, INT) }, `${tag}: x shift`);
  const ay = math(n, `(${sy}) % a`, { a: L(s.h, INT) }, `${tag}: y shift`);
  const rx = math(n, 'a - b', { a: L(s.w, INT), b: L(ax, INT) }, `${tag}: rest x`);
  const ry = math(n, 'a - b', { a: L(s.h, INT), b: L(ay, INT) }, `${tag}: rest y`);
  // a shift of 0 would make empty crops: the expressions keep it at 1..w-1 by using (sx % w) with sx never a multiple of w
  const crop = (cw, ch, x, y, t) => n('ImageCrop', { image: img, width: cw, height: ch, x, y }, `${tag}: ${t}`);
  const st = (a, dir, b, t) => n('ImageStitch', { image1: L(a), direction: dir, match_image_size: false, spacing_width: 0, spacing_color: 'black', image2: L(b) }, `${tag}: ${t}`);
  const A = crop(L(ax, INT), L(ay, INT), 0, 0, 'A'), B = crop(L(rx, INT), L(ay, INT), L(ax, INT), 0, 'B');
  const C = crop(L(ax, INT), L(ry, INT), 0, L(ay, INT), 'C'), D = crop(L(rx, INT), L(ry, INT), L(ax, INT), L(ay, INT), 'D');
  return st(st(D, 'right', C, 'top'), 'down', st(B, 'right', A, 'bottom'), 'shifted');
}
/** 0.5 + (a - b) / 2: a signed difference around mid grey (ImageBlend of a and 1 - b). */
const signedDiff = (n, a, b, t) => n('ImageBlend', { image1: a, image2: L(n('ImageInvert', { image: b }, `${t}: invert`)), blend_factor: 0.5, blend_mode: 'normal' }, t);
const contrast = (n, img, factor, t) => n('AdjustContrast', { images: img, factor }, t);
const solid = (n, s, color, t) => n('EmptyImage', { width: L(s.w, INT), height: L(s.h, INT), batch_size: 1, color }, t);
const tint = (n, img, s, color, t) => n('ImageBlend', { image1: img, image2: L(solid(n, s, color, `${t}: colour`)), blend_factor: 1, blend_mode: 'multiply' }, t);
const screen = (n, a, b, t) => n('ImageBlend', { image1: a, image2: b, blend_factor: 1, blend_mode: 'screen' }, t);
/** Three grey maps into the R, G, B channels of one image (b may be null = black). */
function packRGB(n, s, r, g, b, t) {
  let out = screen(n, L(tint(n, r, s, 0xFF0000, `${t}: red`)), L(tint(n, g, s, 0x00FF00, `${t}: green`)), `${t}: R+G`);
  if (b) out = screen(n, L(out), L(tint(n, b, s, 0x0000FF, `${t}: blue`)), `${t}: R+G+B`);
  return out;
}
/** Cavity AO from a height map: crevices (below their surroundings) darken, flat stays white. */
function cavityAO(n, height, s, t = 'AO') {
  const cav = signedDiff(n, height, L(n('ImageBlur', { image: height, blur_radius: 8, sigma: 4 }, `${t}: local average`)), `${t}: cavity`);
  const ao = n('AdjustBrightness', { images: L(contrast(n, L(cav), 2, `${t}: deepen`)), factor: 2 }, `${t}: flat = white`);
  const white = solid(n, s, 0xFFFFFF, `${t}: white`);
  return n('ImageBlend', { image1: L(white), image2: L(ao), blend_factor: 0.8, blend_mode: 'normal' }, `${t}: strength`);
}
const save = (n, img, prefix, title) => n('SaveImage', { filename_prefix: `concept-app/${prefix}`, images: img }, title);

// ---- Textures / PBR Maps (fast: image math, no AI) ---------------------------
{
  const { g, n } = graph();
  const img = n('LoadImage', { image: 'example.png' }, 'Texture / albedo #image');
  const fit = n('ResizeImagesByLongerEdge', { images: L(img), longer_edge: 2048 }, 'Working size');
  const s = sizeOf(n, L(fit));
  const lum = n('ImageRGBToYUV', { image: L(fit) }, 'Brightness (luma)');
  // height = the picture's own detail: brightness minus its wide average (drops lighting gradients)
  const wide = n('ImageBlur', { image: L(lum, 0), blur_radius: 31, sigma: 10 }, 'Height: wide average');
  const hp0 = signedDiff(n, L(lum, 0), L(wide), 'Height: detail');
  // light = high fits most textures (dark crevices); light mortar / grout needs the other way
  const hp = n('ComfySwitchNode', { switch: false, on_false: L(hp0), on_true: L(n('ImageInvert', { image: L(hp0) }, 'Height: dark is high')) }, 'Height from (light / dark is high)');
  const heightC = contrast(n, L(hp), 2, 'Height: depth');
  const height = n('ImageBlur', { image: L(heightC), blur_radius: 1, sigma: 0.6 }, 'Height');
  // normal: slopes of the height (wrap-around, so a tiling texture stays tiling)
  const dx = signedDiff(n, L(wrapShift(n, L(height), s, -2, 0, 'Normal x-2')), L(wrapShift(n, L(height), s, 2, 0, 'Normal x+2')), 'Normal: slope x');
  const dy = signedDiff(n, L(wrapShift(n, L(height), s, 0, -2, 'Normal y-2')), L(wrapShift(n, L(height), s, 0, 2, 'Normal y+2')), 'Normal: slope y');
  const gx = contrast(n, L(contrast(n, L(dx), 2, 'Normal x: x2')), 2, 'Normal x: strength');
  const gy = contrast(n, L(contrast(n, L(dy), 2, 'Normal y: x2')), 2, 'Normal y: strength');
  // DirectX (Unreal): green = 0.5 + (h(y-1) - h(y+1)) / 2, which is what dy is; OpenGL flips it
  const gyFlip = n('ImageInvert', { image: L(gy) }, 'Normal y: OpenGL flip');
  const green = n('ComfySwitchNode', { switch: true, on_false: L(gyFlip), on_true: L(gy) }, 'Normal convention (DirectX / OpenGL)');
  const normal = packRGB(n, s, L(gx), L(green), L(solid(n, s, 0xFFFFFF, 'Normal: blue = up')), 'Normal map');
  const rough = n('AdjustBrightness', { images: L(contrast(n, L(n('ImageInvert', { image: L(hp) }, 'Roughness: dark = rough')), 1.4, 'Roughness: spread')), factor: 1 }, 'Roughness level');
  const ao = cavityAO(n, L(height), s);
  const orm = packRGB(n, s, L(ao), L(rough), null, 'ORM (AO, roughness, metal)');
  save(n, L(fit), 'pbr_basecolor', 'Save base colour'); save(n, L(normal), 'pbr_normal', 'Save normal');
  save(n, L(height), 'pbr_height', 'Save height'); save(n, L(rough), 'pbr_roughness', 'Save roughness');
  save(n, L(ao), 'pbr_ao', 'Save AO'); save(n, L(orm), 'pbr_orm', 'Save ORM');
  const strength = [gx, gy].map((id) => ({ node: String(id), input: 'factor' }));
  files['wf-pbr-maps'] = { preset: {
    kind: 'workflow', group: 'Textures', label: 'PBR Maps', menuPath: 'Textures/PBR Maps', menuOrder: 5,
    source: 'Comfy UI Ideas doc, PBR textures: single-image material extraction. Classic image-based method (like Materialize / CrazyBump), core nodes only.', output: 'image',
    description: 'Normal, height, roughness and AO maps from one texture or albedo, plus an ORM map packed for Unreal (R = AO, G = roughness, B = metal). Worked out from the picture itself, no AI: instant, local, fine for client work. Normal and height are solid; roughness and AO are a starting point to refine.',
    params: {
      size: { node: fit, input: 'longer_edge', type: 'enum', options: [1024, 2048, 4096], default: 2048, label: 'Map size', control: 'seg', labels: { 1024: '1K', 2048: '2K', 4096: '4K' }, info: 'Size of the long side of every map (the base colour is resized to match).' },
      normal: { node: strength[0].node, input: 'factor', also: [strength[1]], type: 'number', min: 1, max: 2, step: 0.1, default: 2, label: 'Normal strength', control: 'slider', info: 'How deep the surface detail looks in the normal map. Lower for subtle surfaces (painted plaster), higher for strong relief (brick, bark).' },
      depth: { node: heightC, input: 'factor', type: 'number', min: 1, max: 2, step: 0.1, default: 2, label: 'Height contrast', control: 'slider', info: 'How far apart the high and low points of the height map are. Also drives the normal map and AO.' },
      invert: { node: hp, input: 'switch', type: 'enum', options: [false, true], default: false, label: 'Raised parts are', control: 'seg', labels: { false: 'Lighter', true: 'Darker' }, info: 'Which parts of the picture stick out. Most surfaces: lighter (dark crevices and cracks sit lower). Light mortar or grout between darker bricks or tiles: darker.' },
      roughness: { node: rough, input: 'factor', type: 'number', min: 0.4, max: 1.6, step: 0.05, default: 1, label: 'Roughness', control: 'slider', info: 'Overall roughness: lower is shinier, higher is duller. The pattern comes from the picture (darker crevices rougher).' },
      green: { node: green, input: 'switch', type: 'enum', options: [false, true], default: true, label: 'Normal for', control: 'seg', labels: { false: 'OpenGL', true: 'Unreal (DirectX)' }, info: 'Which way the normal map\'s green channel points. Unreal uses DirectX; Blender, Substance, Unity and glTF use OpenGL.' },
    },
    maxBatch: 4, vram: { estMB: 600, basis: 'image math only, no model' },
    info: { image: 'A flat, evenly lit texture or albedo (front-on). Run Remove Lighting or Photo to Texture first if it has shadows: baked lighting would turn into fake bumps.' },
  }, workflow: g };
}

// ---- Textures / PBR Maps (CHORD) ----------------------------------------------
{
  const { g, n } = graph();
  const img = n('LoadImage', { image: 'example.png' }, 'Texture / photo #image');
  const model = n('ChordLoadModel', { ckpt_name: 'chord_v1.safetensors' }, 'CHORD: load model');
  const est = n('ChordMaterialEstimation', { chord_model: L(model), image: L(img) }, 'CHORD: material estimation');
  const height = n('ChordNormalToHeight', { normal: L(est, 1) }, 'CHORD: normal to height');
  const s = sizeOf(n, L(img));
  // CHORD's normal follows its training data (OpenGL); Unreal wants the green channel flipped
  const ch = n('SplitImageChannels', { image: L(est, 1) }, 'Normal: channels');
  const gFlip = n('ImageInvert', { image: L(ch, 1) }, 'Normal: green flipped');
  const green = n('ComfySwitchNode', { switch: true, on_false: L(ch, 1), on_true: L(gFlip) }, 'Normal convention (DirectX / OpenGL)');
  const normal = packRGB(n, s, L(ch, 0), L(green), L(ch, 2), 'Normal map');
  const ao = cavityAO(n, L(height), s);
  const orm = packRGB(n, s, L(ao), L(est, 2), L(est, 3), 'ORM (AO, roughness, metal)');
  save(n, L(est, 0), 'chord_basecolor', 'Save base colour'); save(n, L(normal), 'chord_normal', 'Save normal');
  save(n, L(height), 'chord_height', 'Save height'); save(n, L(est, 2), 'chord_roughness', 'Save roughness');
  save(n, L(est, 3), 'chord_metalness', 'Save metalness'); save(n, L(ao), 'chord_ao', 'Save AO'); save(n, L(orm), 'chord_orm', 'Save ORM');
  files['wf-pbr-chord'] = { preset: {
    kind: 'workflow', group: 'Textures', label: 'PBR Maps (CHORD)', menuPath: 'Textures/PBR Maps (CHORD)', menuOrder: 6,
    source: 'Ubisoft La Forge CHORD (ComfyUI-Chord nodes, chord_v1.safetensors). Research-only license.', output: 'image',
    description: 'AI material estimation with Ubisoft\'s CHORD: base colour (lighting removed), normal, height, roughness and metalness from one texture, plus AO and an Unreal ORM map. Best quality, but the license is research-only: personal work, not client or broadcast work.',
    params: {
      green: { node: green, input: 'switch', type: 'enum', options: [false, true], default: true, label: 'Normal for', control: 'seg', labels: { false: 'OpenGL', true: 'Unreal (DirectX)' }, info: 'Which way the normal map\'s green channel points. Unreal uses DirectX; Blender, Substance, Unity and glTF use OpenGL.' },
    },
    maxBatch: 4, vram: { estMB: 7000, basis: 'CHORD (Stable Diffusion 2.1 based) at 1024 x 1024' },
    info: { image: 'A texture or photo of a surface, front-on. CHORD works at 1024 x 1024 and resizes back to the picture\'s size.' },
  }, workflow: g };
}

// ---- Textures / Depth + Normal (MoGe) ----------------------------------------
{
  const { g, n } = graph();
  const img = n('LoadImage', { image: 'example.png' }, 'Photo or concept art #image');
  const geo = n('MoGeInference', { moge_model: L(n('LoadMoGeModel', { model_name: 'moge_2_vitl_normal_fp16.safetensors' }, 'Load MoGe')), image: L(img), resolution_level: 9, fov_x_degrees: 0, batch_size: 1, force_projection: true, apply_mask: false, refine_steps: 0 }, 'MoGe: estimate geometry');
  const depth = n('MoGeRender', { moge_geometry: L(geo), output: 'depth' }, 'Depth (white near)');
  const normal = n('MoGeRender', { moge_geometry: L(geo), output: 'normal_directx' }, 'Normal');
  save(n, L(depth), 'depth_map', 'Save depth'); save(n, L(normal), 'normal_map', 'Save normal');
  files['wf-depth-normal'] = { preset: {
    kind: 'workflow', group: 'Textures', label: 'Depth + Normal', menuPath: 'Textures/Depth + Normal', menuOrder: 7,
    source: 'Comfy UI Ideas doc, depth and normal estimation from images. MoGe-2 (installed, ComfyUI core nodes).', output: 'image',
    description: 'Depth and surface normals of a whole scene from one photo or piece of concept art (MoGe-2): sculpting reference, parallax cards, quick relief. For the fine detail of a flat texture use PBR Maps instead.',
    params: {
      detail: { node: geo, input: 'resolution_level', also: [], type: 'int', min: 0, max: 9, default: 9, label: 'Detail', control: 'stepper', info: 'How much detail MoGe resolves: 9 is the most (and slowest), 0 the fastest.' },
      convention: { node: normal, input: 'output', type: 'enum', options: ['normal_directx', 'normal_opengl'], default: 'normal_directx', label: 'Normal for', control: 'seg', labels: { normal_directx: 'Unreal (DirectX)', normal_opengl: 'OpenGL' }, info: 'Which way the normal map\'s green channel points. Unreal uses DirectX; Blender, Substance, Unity and glTF use OpenGL.' },
    },
    maxBatch: 4, vram: { estMB: 2500, basis: 'MoGe-2 ViT-L fp16 (0.6 GB) at full detail' },
    info: { image: 'A photo or concept art of a scene or object. MoGe estimates its 3D shape: depth is white near, black far.' },
  }, workflow: g };
}

// ---- Textures / Photo to Texture ------------------------------------------------
{
  const q = read('qwen-edit-2511.json');
  const wf = structuredClone(q.workflow);
  wf['6']._meta.title = 'Photo #image';
  wf['7']._meta.title = 'Your notes #prompt';
  delete wf['12']; // its own Save: the edit goes on into the tiling + sizing below
  const ids = Object.keys(wf).map(Number).filter(Number.isFinite);
  let next = Math.max(...ids) + 1;
  const n = (class_type, inputs, title) => { const id = String(next++); wf[id] = { inputs, class_type, _meta: { title } }; return id; };
  const edited = '11';
  // snap to a multiple of 16 for the seam repaint (Z-Image)
  const s0 = sizeOf(n, L(edited), 'Edited size');
  const snap = n('ImageScale', { image: L(edited), upscale_method: 'lanczos', width: L(math(n, 'a // 16 * 16', { a: L(s0.w, INT) }, 'Width, multiple of 16'), INT), height: L(math(n, 'a // 16 * 16', { a: L(s0.h, INT) }, 'Height, multiple of 16'), INT), crop: 'center' }, 'Snap to multiple of 16');
  const z = zimage(n, 'Seam prompt', 'seamless continuous texture, same material, same pattern and scale, flat lighting');
  const seam = seamFix(n, L(snap), { mode: 'both', model: L(z.ms), positive: L(z.pos), negative: L(z.neg), vae: L(z.vae), steps: 8, denoise: 1, patch: LITE });
  const tile = n('ComfySwitchNode', { switch: true, on_false: L(snap), on_true: L(seam.out) }, 'Make it tile (on / off)');
  const um = n('UpscaleModelLoader', { model_name: '4x-UltraSharp.safetensors' }, 'Load Upscale Model');
  const up = n('ImageUpscaleWithModel', { upscale_model: L(um), image: L(tile) }, 'Upscale 4x (model)');
  const fit = n('ResizeImagesByLongerEdge', { images: L(up), longer_edge: 2048 }, 'Texture size');
  n('SaveImage', { filename_prefix: 'concept-app/photo_texture', images: L(fit) }, 'Save Image');
  const p = q.preset.params;
  files['wf-photo-texture'] = { preset: {
    kind: 'workflow', group: 'Textures', label: 'Photo to Texture', menuPath: 'Textures/Photo to Texture', menuOrder: 0,
    source: 'Comfy UI Ideas doc, Camera to texture workflow. Qwen Image Edit 2511 (your notes + lighting removal), then the Make Seamless repaint / blend and a model upscale.', output: 'image',
    description: 'A phone photo of a surface in, a flat tiling texture out: your notes plus lighting removal (Qwen Image Edit 2511), then made seamless and sized to 1K / 2K / 4K. Say what to keep and what to lose, e.g. "flatten the dented panel underneath, keep the chipped paint and every chip".',
    promptDefault: 'keep all of the surface\'s own detail, colours and pattern',
    assistant: 'This preset turns a photo of a surface into a flat tiling texture with an image-EDIT model. The prompt box does NOT describe a picture: it holds short edit notes saying what to keep and what to remove or change about the surface, as one or two imperative sentences. Example: "Flatten the dented metal panel underneath so the surface is perfectly flat and straight; keep the chipped paint and every chip exactly as it is." Separate the surface the user wants (paint, rust, wood grain, chips, stains) from the shape or object it sits on (dents, curves, bolts, edges, perspective). The app already removes shadows, highlights and reflections and asks for a straight-on photo, so do not repeat that. No style words, no camera words.',
    // Worded like Remove Lighting (tested realistic); "texture map" / "flat" alone gave an illustrated look.
    promptFormat: { template: '{text}. Remove all shadows, highlights and reflections: even, diffuse lighting from every side. Keep exactly the same surface, colours, pattern and scale. Straight-on, photorealistic photo of the surface.' },
    params: {
      tile: { node: tile, input: 'switch', type: 'enum', options: [false, true], default: true, label: 'Tiling', control: 'seg', labels: { false: 'Off', true: 'Seamless' }, info: 'Seamless: the texture is made to tile (the edges are shifted to the middle and the seam fixed). Off: the cleaned-up photo as it is.' },
      method: { node: seam.method, input: 'switch', type: 'enum', options: [false, true], default: true, label: 'Seam fix', control: 'seg', labels: { false: 'Blend', true: 'AI repaint' }, when: { param: 'tile', is: true }, info: 'AI repaint redraws the seam so shapes join up (planks, tiles, bricks, chips). Blend fades the picture over the seam: instant, best for noise-like surfaces.' },
      size: { node: fit, input: 'longer_edge', type: 'enum', options: [1024, 2048, 4096], default: 2048, label: 'Texture size', control: 'seg', labels: { 1024: '1K', 2048: '2K', 4096: '4K' }, info: 'Size of the long side of the finished texture. It is enlarged with an upscale model (4x-UltraSharp), then fitted to this size.' },
      lightning: p.lightning, steps: p.steps,
    },
    maxBatch: 2, vram: q.preset.vram, files: [...(q.preset.files || []), { folder: 'model_patches', file: LITE }], gguf: q.preset.gguf,
    info: { image: 'A photo of the surface, as straight-on as you can. Take it with the Import button or the Camera button.', prompt: 'What to keep and what to lose, in plain words: "flatten the dented panel underneath, keep the chipped paint and every chip", "remove the screws", "make the planks run horizontally". Lighting is removed anyway. Leave empty to keep everything. The prompt assistant can help word it.' },
  }, workflow: wf };
}

// ---- Models / Audio: Stable Audio 3 Small SFX ------------------------------------
{
  const { g, n } = graph();
  const ck = n('CheckpointLoaderSimple', { ckpt_name: 'stable_audio_3_small_sfx.safetensors' }, 'Load Checkpoint');
  const clip = n('CLIPLoader', { clip_name: 't5gemma_b_b_ul2.safetensors', type: 'stable_audio', device: 'default' }, 'Load text encoder (T5Gemma)');
  const pos = n('CLIPTextEncode', { text: '', clip: L(clip) }, 'Sound #prompt');
  const neg = n('CLIPTextEncode', { text: '', clip: L(clip) }, 'Negative');
  const lat = n('EmptyLatentAudio', { seconds: 6, batch_size: 1 }, 'Length');
  const ks = n('KSampler', { seed: 0, steps: 8, cfg: 1, sampler_name: 'lcm', scheduler: 'simple', denoise: 1, model: L(ck, 0), positive: L(pos), negative: L(neg), latent_image: L(lat) }, 'KSampler');
  const dec = n('VAEDecodeAudio', { samples: L(ks), vae: L(ck, 2) }, 'VAE Decode Audio');
  n('SaveAudioAdvanced', { filename_prefix: 'concept-app/sfx', format: 'mp3', 'format.quality': 'V0', audio: L(dec) }, 'Save Audio');
  files['sa3-small-sfx'] = { preset: {
    kind: 'model', group: 'Audio', label: 'Stable Audio 3 SFX', menuPath: 'Audio/Stable Audio 3 SFX', menuOrder: 3,
    source: 'Stability AI Stable Audio 3 Small SFX (Comfy-Org/stable-audio-3 repackage), graph as ComfyUI\'s Stable Audio 3 template; settings from the upstream small-sfx example (8 steps, cfg 1). Stability AI Community License.', output: 'audio',
    description: 'Sound effects and short ambiences from a description (Stable Audio 3 Small SFX): impacts, whooshes, doors, machines, room tone. Up to 2 minutes. Weaker on music and very specific sounds.',
    params: {
      seconds: { node: lat, input: 'seconds', type: 'number', min: 1, max: 120, step: 0.5, default: 6, label: 'Length', control: 'slider', format: 's', info: 'Length of the sound in seconds (up to 2 minutes). Short one-shots: 1-5 s; ambiences: 20 s or more.' },
      steps: { node: ks, input: 'steps', type: 'int', min: 4, max: 16, default: 8, label: 'Steps', control: 'stepper', info: 'Refinement passes. The model is made for about 8.' },
    },
    maxBatch: 8, vram: { estMB: 6000, basis: '0.6B model (2.3 GB fp32) + T5Gemma encoder (1.2 GB)' },
    files: [{ folder: 'checkpoints', file: 'stable_audio_3_small_sfx.safetensors' }, { folder: 'text_encoders', file: 't5gemma_b_b_ul2.safetensors' }],
    info: { prompt: 'Describe the sound and where it happens: "heavy metal door slam in a concrete hallway", "distant thunder rumble, light rain", "sci-fi UI beep, short". Raise Batch for variations to pick from.' },
  }, workflow: g };
}

// ---- Models / Audio: Chatterbox Voice Swap ------------------------------------------
{
  const { g, n } = graph();
  const src = n('LoadAudio', { audio: 'recording.wav' }, 'Your recording');
  const target = n('LoadAudio', { audio: 'voice_sample.wav' }, 'Target voice');
  const vc = n('ChatterboxVC', { model_pack_name: 'chatterbox', source_audio: L(src), target_voice_audio: L(target), n_timesteps: 10, temperature: 1, flow_cfg_scale: 0.7, use_watermark: false, device: 'default', dtype: 'auto', attention_mode: 'sdpa', refinement_passes: 1, max_chunk_duration: 30, chunk_method: 'smart' }, 'Chatterbox voice conversion');
  n('SaveAudio', { filename_prefix: 'concept-app/voice_swap', audio: L(vc) }, 'Save Audio');
  files['chatterbox-voice-swap'] = { preset: {
    kind: 'model', group: 'Audio', label: 'Chatterbox Voice Swap', menuPath: 'Audio/Chatterbox Voice Swap', menuOrder: 4,
    source: 'Comfy UI Ideas doc, Audio: dialogue, option B (voice conversion). ChatterboxVC from ComfyUI-ChatterboxTTS (installed), zero-shot.', output: 'audio',
    description: 'Record a line yourself with the exact performance you want, then swap only the voice (Chatterbox voice conversion, no training): timing, pitch, slurring and emphasis carry over. Only use voices you have permission to use.',
    inputs: [
      { kind: 'audio', node: src, input: 'audio', label: 'Your recording' },
      { kind: 'audio', node: target, input: 'audio', label: 'Target voice' },
    ],
    params: {
      likeness: { node: vc, input: 'flow_cfg_scale', type: 'number', min: 0.3, max: 1.5, step: 0.05, default: 0.7, label: 'Voice likeness', control: 'slider', info: 'How closely it copies the target voice. Higher sounds more like the target but can lose naturalness; 0.7 is the default.' },
      passes: { node: vc, input: 'refinement_passes', type: 'int', min: 1, max: 5, default: 1, label: 'Passes', control: 'stepper', info: 'Runs the conversion again on its own result to move further toward the target voice. More than 3 or so starts to distort.' },
      steps: { node: vc, input: 'n_timesteps', type: 'int', min: 4, max: 30, default: 10, label: 'Steps', control: 'stepper', info: 'Refinement passes inside each conversion. 10 is the default; more is slower and only slightly cleaner.' },
    },
    maxBatch: 1, vram: { estMB: 3500, basis: 'Chatterbox S3Gen + voice encoder (as the Chatterbox TTS preset)' },
    info: { audio: 'Your recording: the line performed the way you want it (record it with the Record button, dry, in a quiet room). Target voice: 5-15 s of clean speech in the voice to end up with.' },
  }, workflow: g };
}

for (const [id, f] of Object.entries(files)) fs.writeFileSync(path.join(OUT, `${id}.json`), JSON.stringify(f, null, 1) + '\n');
console.log(Object.keys(files).join('\n'));
