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
  const img = n('LoadImage', { image: 'example.png' }, mode === 'edges' ? 'Greybox render #image' : 'Depth or gray pass #image');
  const fit = n('ImageScaleToTotalPixels', { image: L(img), upscale_method: 'lanczos', megapixels: 1, resolution_steps: 16 }, 'Fit to 1 MP');
  let ctrl = fit, canny = null;
  if (mode === 'edges') { canny = n('Canny', { image: L(fit), low_threshold: 0.2, high_threshold: 0.5 }, 'Edges (canny)'); ctrl = canny; }
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
  if (canny) {
    params.detail = { node: canny, input: 'low_threshold', type: 'number', min: 0.05, max: 0.6, step: 0.05, default: 0.2, label: 'Edge detail', control: 'slider', info: 'Which edges count. Lower picks up fine panel lines and texture edges; higher keeps only the strong silhouettes.' };
  }
  files[`wf-concept-${mode}`] = { preset: {
    kind: 'workflow', group: 'Concept', label: mode === 'edges' ? 'Concept Looks (Edges)' : 'Concept Looks (Depth Pass)', menuPath: `Concept/Concept Looks (${mode === 'edges' ? 'Edges' : 'Depth Pass'})`, menuOrder: mode === 'edges' ? 1 : 2,
    source: 'Comfy UI Ideas doc, ControlNet Concept Iteration (authored). Z-Image Turbo + Z-Image-Turbo-Fun-Controlnet-Union 2.1 (alibaba-pai).', output: 'image',
    description: mode === 'edges'
      ? 'Keeps the camera and layout of a Cinema 4D greybox or rough Redshift frame and changes the look from the prompt. Edges are found from the render (canny), so silhouettes and panel lines stay put.'
      : 'Same as Concept Looks (Edges), but guided by a depth pass (or a gray / AO pass) rendered out of Cinema 4D or Redshift: the exact spatial layout, without copying the greybox surfaces.',
    params, maxBatch: 8,
    vram: { estMB: 20500, basis: 'Z-Image Turbo bf16 12.3 GB + ControlNet patch 6.7 GB (2 GB lite); ComfyUI keeps what does not fit on the GPU in system RAM' },
    info: { image: mode === 'edges' ? 'A frame from Cinema 4D: greybox or rough Redshift lighting. Its shape (the picture is fitted to about 1 MP) is the shape of the result.' : 'A depth pass (white near, black far) or a gray / AO pass from Cinema 4D or Redshift. A dedicated pass gives tighter control than letting the model guess depth.', prompt: 'The look: materials, lighting and mood, e.g. "broadcast studio set, brushed steel, warm LED strips, glossy black floor, haze". Ten variations of one camera angle: raise Batch.' },
  }, workflow: g };
}

for (const [id, f] of Object.entries(files)) fs.writeFileSync(path.join(OUT, `${id}.json`), JSON.stringify(f, null, 1) + '\n');
console.log(Object.keys(files).join('\n'));
