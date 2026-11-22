// builder.js - the GUARDED workflow builder.
// -----------------------------------------------------------------------------
// The chat model never writes a ComfyUI graph. It may only propose a short list
// of TESTED BLOCKS with params (JSON, enforced with Ollama's `format` schema):
//   { "reply": "...", "name": "...", "blocks": [ { "type": "load_model", "params": { "family": "flux1-schnell" } }, ... ] }
// The SERVER then
//   1. checks the chain (known blocks, order, compatible model/LoRA/ControlNet),
//   2. clamps params (with a note for each change) and rejects bad ones,
//   3. assembles the API graph from the templates below,
//   4. validates every node against ComfyUI's live /object_info (class exists,
//      required inputs, link types, combo values = installed models, ranges),
// and only then can the user Test run it or Save it as a preset.
// Every rejection carries one plain-language reason.
// Pure JS (no I/O): used by server/builder.js and the unit tests.
// -----------------------------------------------------------------------------
import { comboOptions } from './presets.js';

export const BLOCK_TYPES = ['input_image', 'load_model', 'lora', 'controlnet', 'txt2img', 'img2img', 'upscale', 'image_to_3d', 'video', 'audio', 'save'];
export const MAX_BLOCKS = 10;

export const BLOCK_INFO = {
  input_image: 'a picture the user picks (needed by img2img, controlnet, image_to_3d without txt2img)',
  load_model: 'pick the image model family: params.family',
  lora: 'add a LoRA to the loaded model: params.name, params.strength 0-2',
  controlnet: 'guide composition with the input picture: params.name, params.strength 0-1.5',
  txt2img: 'make a picture from the prompt: params.width, params.height (256-2048), params.steps',
  img2img: 'redraw the input picture with the prompt: params.strength 0.05-1 (how much changes), params.steps',
  upscale: 'enlarge the picture: params.scale 1.5-4, params.model (upscale model)',
  image_to_3d: 'turn the picture into a 3D mesh (Hunyuan3D 2.1): params.steps 10-50, params.detail 128-384',
  video: 'text/image to video (Wan 2.2 5B): params.frames 17-121, params.steps',
  audio: 'text to speech from the prompt: params.engine "chatterbox" or "vibevoice"',
  save: 'save the result (added automatically if missing)',
};

// Image model families. Files are checked live against /object_info before use.
export const FAMILIES = {
  'flux2-klein': {
    label: 'FLUX.2 Klein 4B (4 steps)', name: 'FLUX.2 Klein 4B', estMB: 9000, steps: [2, 8, 4], sampler: 'custom', img2img: false, controlnet: null,
    lora: /klein|flux[-_.]?2/i,
    loaders: { unet: ['UNETLoader', { unet_name: 'flux-2-klein-4b.safetensors', weight_dtype: 'default' }], clip: ['CLIPLoader', { clip_name: 'qwen_3_4b.safetensors', type: 'flux2', device: 'default' }], vae: ['VAELoader', { vae_name: 'flux2-vae.safetensors' }] },
  },
  'flux1-schnell': {
    label: 'FLUX.1 schnell (GGUF, 4 steps)', name: 'FLUX.1 schnell (GGUF)', estMB: 9600, steps: [1, 8, 4], sampler: 'ksampler', ks: { sampler_name: 'euler', scheduler: 'simple' }, img2img: true, controlnet: null,
    lora: /flux[-_.]?(1|dev|schnell)|flux-dev/i,
    loaders: { unet: ['UnetLoaderGGUF', { unet_name: 'flux1-schnell-Q5_K_S.gguf' }], clip: ['DualCLIPLoader', { clip_name1: 't5xxl_fp8_e4m3fn.safetensors', clip_name2: 'clip_l.safetensors', type: 'flux', device: 'default' }], vae: ['VAELoader', { vae_name: 'ae.safetensors' }] },
  },
  'flux1-dev': {
    label: 'FLUX.1 dev (GGUF, 20 steps, non-commercial)', name: 'FLUX.1 dev (GGUF, non-commercial)', estMB: 9600, steps: [8, 30, 20], sampler: 'ksampler', ks: { sampler_name: 'euler', scheduler: 'simple' }, guidance: 3.5, img2img: true, controlnet: null,
    lora: /flux[-_.]?(1|dev)|flux-dev/i,
    loaders: { unet: ['UnetLoaderGGUF', { unet_name: 'flux1-dev-Q5_K_S.gguf' }], clip: ['DualCLIPLoader', { clip_name1: 't5xxl_fp8_e4m3fn.safetensors', clip_name2: 'clip_l.safetensors', type: 'flux', device: 'default' }], vae: ['VAELoader', { vae_name: 'ae.safetensors' }] },
  },
  'z-image-turbo': {
    label: 'Z-Image Turbo (8 steps)', name: 'Z-Image Turbo', estMB: 13800, steps: [4, 12, 8], sampler: 'ksampler', ks: { sampler_name: 'res_multistep', scheduler: 'simple' }, shift: 3, img2img: true, controlnet: null,
    lora: /z[-_.]?image/i,
    loaders: { unet: ['UNETLoader', { unet_name: 'z_image_turbo_bf16.safetensors', weight_dtype: 'default' }], clip: ['CLIPLoader', { clip_name: 'qwen_3_4b.safetensors', type: 'lumina2', device: 'default' }], vae: ['VAELoader', { vae_name: 'ae.safetensors' }] },
  },
  'qwen-image': {
    label: 'Qwen-Image 2512 (fp8 + Lightning 4 steps, heavy)', name: 'Qwen-Image 2512 (fp8 + Lightning)', estMB: 21500, steps: [2, 8, 4], sampler: 'ksampler', ks: { sampler_name: 'euler', scheduler: 'simple' }, shift: 3.1, img2img: true, realNegative: true,
    controlnet: /qwen/i, lora: /qwen/i,
    builtinLora: { lora_name: 'Qwen-Image-2512-Lightning-4steps-V1.0-fp32.safetensors', strength_model: 1 },
    loaders: { unet: ['UNETLoader', { unet_name: 'qwen_image_2512_fp8_e4m3fn.safetensors', weight_dtype: 'default' }], clip: ['CLIPLoader', { clip_name: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', type: 'qwen_image', device: 'default' }], vae: ['VAELoader', { vae_name: 'qwen_image_vae.safetensors' }] },
  },
};
const TTS = {
  chatterbox: { cls: 'ChatterboxTTS', inputs: { model_pack_name: 'chatterbox', max_new_tokens: 400, device: 'default' }, estMB: 3500, label: 'Chatterbox TTS' },
  // VibeVoice 1.5B clones a reference voice: it needs a speech sample (LoadAudio) on speaker 1.
  vibevoice: { cls: 'VibeVoiceTTS', inputs: { model_name: 'VibeVoice-1.5B', force_offload: true, voice_preset: 'None' }, estMB: 6500, label: 'VibeVoice 1.5B TTS', wrap: true, voice: 'verify-voice.flac' },
};
const EST = { upscale: 1500, image_to_3d: 9000, video: 14000 };

const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v.replace(/x$/i, '')) : NaN);

/** Installed option lists, read from /object_info combos. */
export function installedLists(objectInfo) {
  const opt = (cls, input) => comboOptions(objectInfo?.[cls]?.input?.required?.[input] || objectInfo?.[cls]?.input?.optional?.[input]) || [];
  return {
    loras: opt('LoraLoaderModelOnly', 'lora_name'),
    controlnets: opt('ControlNetLoader', 'control_net_name'),
    upscalers: opt('UpscaleModelLoader', 'model_name'),
  };
}

/** JSON schema for Ollama's `format`: the model can ONLY answer with blocks. */
export function builderSchema(families = Object.keys(FAMILIES)) {
  return {
    type: 'object',
    properties: {
      reply: { type: 'string' },
      name: { type: 'string' },
      blocks: {
        type: 'array', maxItems: MAX_BLOCKS,
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: BLOCK_TYPES },
            params: {
              type: 'object',
              properties: {
                family: { type: 'string', enum: families }, name: { type: 'string' }, model: { type: 'string' }, engine: { type: 'string', enum: Object.keys(TTS) },
                strength: { type: 'number' }, width: { type: 'integer' }, height: { type: 'integer' }, steps: { type: 'integer' },
                scale: { type: 'number' }, detail: { type: 'integer' }, frames: { type: 'integer' },
              },
            },
          },
          required: ['type'],
        },
      },
    },
    required: ['reply', 'blocks'],
  };
}

/** System prompt for the builder model (lists only what is installed). */
export function builderSystemPrompt(ctx) {
  const L = installedLists(ctx.objectInfo);
  const fam = Object.entries(FAMILIES).map(([id, f]) => `- ${id}: ${f.label}${ctx.familyStatus?.[id] ? ` [${ctx.familyStatus[id]}]` : ''}`).join('\n');
  return [
    'You design image/3D/audio setups for a ComfyUI app by choosing BLOCKS. You never write node graphs.',
    'Answer ONLY with JSON: {"reply": one or two plain sentences saying what the setup WOULD do (conditional/future tense, it has not run), "name": short preset name, "blocks": [{"type": ..., "params": {...}}]}.',
    'Blocks (in this order):',
    ...Object.entries(BLOCK_INFO).map(([k, v]) => `- ${k}: ${v}`),
    'Rules: one load_model before lora/controlnet/txt2img/img2img; txt2img OR img2img, not both; upscale and image_to_3d come after a picture exists; audio and video stand alone; at most 10 blocks.',
    'Model families (params.family):', fam,
    `Installed LoRAs: ${L.loras.join(', ') || 'none'}. A LoRA must match the model family.`,
    `Installed ControlNets: ${L.controlnets.join(', ') || 'none'}.`,
    `Installed upscale models: ${L.upscalers.join(', ') || 'none'}.`,
    'Do not praise the user or their pictures. Keep the reply short and factual.',
    'Example: {"reply":"This would make a 1024x1024 picture with FLUX.1 schnell and upscale it 2x.","name":"Schnell + 2x","blocks":[{"type":"load_model","params":{"family":"flux1-schnell"}},{"type":"txt2img","params":{"width":1024,"height":1024}},{"type":"upscale","params":{"scale":2}},{"type":"save"}]}',
  ].join('\n');
}

/**
 * Check + clamp the block list. Returns { ok, blocks, notes, errors, output }.
 * errors are plain sentences; notes are clamp/auto-fix messages.
 */
export function checkChain(rawBlocks, ctx = {}) {
  const errors = [], notes = [];
  const L = installedLists(ctx.objectInfo);
  if (!Array.isArray(rawBlocks) || !rawBlocks.length) return { ok: false, errors: ['The setup has no blocks.'], notes, blocks: [] };
  if (rawBlocks.length > MAX_BLOCKS) return { ok: false, errors: [`The setup has ${rawBlocks.length} blocks; the limit is ${MAX_BLOCKS}.`], notes, blocks: [] };
  const blocks = [];
  const st = { family: null, sampled: false, picture: false, inputImage: false, out: null, saved: false, cn: false };
  const clamp = (label, v, lo, hi, def, int) => {
    if (v === undefined || v === null || v === '') return def;
    const n = num(v);
    if (!Number.isFinite(n)) { errors.push(`${label} "${v}" is not a number.`); return def; }
    let c = Math.min(hi, Math.max(lo, n)); if (int) c = Math.round(c);
    if (c !== n) notes.push(`${label} ${n} is outside ${lo}-${hi}, using ${c}.`);
    return c;
  };
  for (let i = 0; i < rawBlocks.length; i++) {
    const b = rawBlocks[i] || {};
    const type = String(b.type || '').trim().toLowerCase();
    const p = b.params && typeof b.params === 'object' ? b.params : {};
    const where = `Block ${i + 1} (${type || 'no type'})`;
    if (!BLOCK_TYPES.includes(type)) { errors.push(`${where}: "${b.type}" is not a known block. Known blocks: ${BLOCK_TYPES.join(', ')}.`); continue; }
    if (st.saved) { errors.push(`${where}: nothing can come after save.`); continue; }
    const out = { type, params: {} };
    switch (type) {
      case 'input_image':
        if (st.inputImage) { errors.push(`${where}: only one input picture is supported.`); break; }
        if (st.out && st.out !== 'image') { errors.push(`${where}: an input picture cannot follow ${st.out}.`); break; }
        st.inputImage = true; if (!st.family) st.picture = true; break;
      case 'load_model': {
        if (st.family) { errors.push(`${where}: only one load_model per setup.`); break; }
        if (st.sampled || st.out === 'mesh' || st.out === 'audio' || st.out === 'video') { errors.push(`${where}: load_model must come before the picture is made.`); break; }
        const f = String(p.family || '').toLowerCase();
        if (!FAMILIES[f]) { errors.push(`${where}: unknown model family "${p.family || ''}". Choose one of: ${Object.keys(FAMILIES).join(', ')}.`); break; }
        st.family = f; out.params.family = f; st.picture = false; break;
      }
      case 'lora': {
        if (!st.family) { errors.push(`${where}: a LoRA needs a load_model block before it.`); break; }
        if (st.sampled) { errors.push(`${where}: a LoRA must come before txt2img/img2img.`); break; }
        const name = String(p.name || p.model || '');
        const hit = L.loras.find((x) => x.toLowerCase() === name.toLowerCase() || x.toLowerCase() === `${name.toLowerCase()}.safetensors`);
        if (!hit) { errors.push(`${where}: LoRA "${name}" is not installed. Installed: ${L.loras.join(', ') || 'none'}.`); break; }
        if (!FAMILIES[st.family].lora.test(hit)) { errors.push(`${where}: LoRA ${hit} does not match the ${FAMILIES[st.family].label} model; it would fail or give garbage.`); break; }
        if (FAMILIES[st.family].builtinLora?.lora_name === hit) { errors.push(`${where}: ${hit} is already built into the ${st.family} setup.`); break; }
        out.params = { name: hit, strength: clamp('LoRA strength', p.strength, 0, 2, 1) }; break;
      }
      case 'controlnet': {
        if (!st.family) { errors.push(`${where}: a ControlNet needs a load_model block before it.`); break; }
        if (st.sampled) { errors.push(`${where}: a ControlNet must come before txt2img.`); break; }
        if (!st.inputImage) { errors.push(`${where}: a ControlNet needs an input_image block (the picture that guides the layout).`); break; }
        const fam = FAMILIES[st.family];
        const usable = L.controlnets.filter((x) => fam.controlnet?.test(x));
        if (!usable.length) { errors.push(`${where}: the installed ControlNet (${L.controlnets.join(', ') || 'none'}) only works with Qwen-Image; this setup uses ${fam.label}, and no ControlNet for that model is installed.`); break; }
        // exact name, or a loose match ("InstantX ControlNet Union" -> Qwen-Image-InstantX-ControlNet-Union.safetensors)
        const key = (s) => String(s).toLowerCase().replace(/\.safetensors$/, '').replace(/[^a-z0-9]+/g, '');
        const name = String(p.name || p.model || '') || usable[0];
        const hit = usable.find((x) => key(x) === key(name)) || usable.find((x) => key(name) && key(x).includes(key(name)));
        if (!hit) { errors.push(`${where}: ControlNet "${name}" is not installed. Installed for ${fam.label}: ${usable.join(', ')}.`); break; }
        st.cn = true; out.params = { name: hit, strength: clamp('ControlNet strength', p.strength, 0, 1.5, 0.8) }; break;
      }
      case 'txt2img': case 'img2img': {
        if (!st.family) { errors.push(`${where}: ${type} needs a load_model block before it.`); break; }
        if (st.sampled) { errors.push(`${where}: use txt2img or img2img once.`); break; }
        const fam = FAMILIES[st.family];
        if (type === 'img2img') {
          if (!fam.img2img) { errors.push(`${where}: ${fam.label} does reference editing, not img2img. Use the "FLUX.2 Klein 4B Image Edit" preset, or flux1-schnell for img2img.`); break; }
          if (!st.inputImage) { errors.push(`${where}: img2img needs an input_image block.`); break; }
          if (st.cn) { errors.push(`${where}: ControlNet is only supported with txt2img here.`); break; }
          out.params.strength = clamp('img2img strength', p.strength, 0.05, 1, 0.6);
        } else {
          out.params.width = clamp('Width', p.width, 256, 2048, 1024, true);
          out.params.height = clamp('Height', p.height, 256, 2048, 1024, true);
          for (const k of ['width', 'height']) { const r = Math.max(16, Math.round(out.params[k] / 16) * 16); if (r !== out.params[k]) { notes.push(`${k} rounded to ${r} (multiple of 16).`); out.params[k] = r; } }
        }
        out.params.steps = clamp('Steps', p.steps, fam.steps[0], fam.steps[1], fam.steps[2], true);
        st.sampled = true; st.picture = true; st.out = 'image'; break;
      }
      case 'upscale': {
        if (!(st.picture || st.inputImage) || (st.family && !st.sampled) || (st.out && st.out !== 'image')) { errors.push(`${where}: upscale needs a picture first (txt2img, img2img or input_image).`); break; }
        const model = String(p.model || '') || (L.upscalers.includes('4x-UltraSharp.safetensors') ? '4x-UltraSharp.safetensors' : L.upscalers[0] || '');
        const hit = L.upscalers.find((x) => x.toLowerCase() === model.toLowerCase() || x.toLowerCase().startsWith(model.toLowerCase() + '.'));
        if (!hit) { errors.push(`${where}: upscale model "${model}" is not installed. Installed: ${L.upscalers.join(', ') || 'none'}.`); break; }
        out.params = { model: hit, scale: clamp('Upscale', p.scale, 1.5, 4, 2) };
        st.picture = true; st.out = 'image'; break;
      }
      case 'image_to_3d':
        if (!(st.picture || st.inputImage) || (st.family && !st.sampled) || (st.out && st.out !== 'image')) { errors.push(`${where}: image_to_3d needs a picture first (txt2img, img2img or input_image).`); break; }
        out.params = { steps: clamp('3D steps', p.steps, 10, 50, 30, true), detail: clamp('3D detail', p.detail, 128, 384, 256, true) };
        st.out = 'mesh'; break;
      case 'video':
        if (st.family || st.out) { errors.push(`${where}: video is a standalone block (Wan 2.2); it cannot be chained after ${st.family ? 'load_model' : st.out}.`); break; }
        out.params = { frames: clamp('Frames', p.frames, 17, 121, 49, true), steps: clamp('Video steps', p.steps, 10, 30, 20, true) };
        st.out = 'video'; break;
      case 'audio': {
        if (st.family || st.out || st.inputImage) { errors.push(`${where}: audio (text to speech) stands alone; it cannot be combined with picture blocks.`); break; }
        const e = String(p.engine || 'chatterbox').toLowerCase();
        if (!TTS[e]) { errors.push(`${where}: engine "${p.engine}" is not available. Use chatterbox or vibevoice.`); break; }
        out.params = { engine: e }; st.out = 'audio'; break;
      }
      case 'save':
        if (!st.out && !(st.inputImage && !st.family)) { errors.push(`${where}: there is nothing to save yet.`); break; }
        if (!st.out) { errors.push(`${where}: an input picture alone is not a setup; add img2img, upscale or image_to_3d.`); break; }
        st.saved = true; break;
    }
    blocks.push(out);
  }
  if (!errors.length) {
    if (st.family && !st.sampled) errors.push('The model is loaded but nothing makes a picture: add txt2img or img2img.');
    else if (!st.out) errors.push('Nothing in this setup produces an output.');
    else if (st.inputImage && st.family && !st.cn && !blocks.some((b) => b.type === 'img2img')) errors.push('The input picture is not used by txt2img: use img2img, a controlnet, or remove input_image.');
  }
  if (!errors.length && !st.saved) { blocks.push({ type: 'save', params: {} }); notes.push('Added a save block at the end.'); }
  return { ok: !errors.length, blocks, notes, errors, output: st.out === 'mesh' ? '3d' : st.out };
}

/** Assemble the API graph from checked blocks. Returns { graph, estMB, output }. */
export function assemble(blocks, { prefix = 'concept-app/builder', objectInfo } = {}) {
  const g = {};
  let n = 0;
  const add = (cls, inputs, title) => { const id = String(++n); g[id] = { class_type: cls, inputs, _meta: { title: title || cls } }; return id; };
  let model, clip, vae, pos, neg, image, latent, mesh, video, audio, famId, fam, estMB = 0, cn, inputImg;
  const est = (mb) => { estMB = Math.max(estMB, mb); };
  for (const b of blocks) {
    const p = b.params;
    switch (b.type) {
      case 'input_image': inputImg = image = [add('LoadImage', { image: 'example.png' }, 'Input picture #image'), 0]; break;
      case 'load_model': {
        famId = p.family; fam = FAMILIES[famId]; est(fam.estMB);
        model = [add(fam.loaders.unet[0], { ...fam.loaders.unet[1] }, 'Load model'), 0];
        clip = [add(fam.loaders.clip[0], { ...fam.loaders.clip[1] }, 'Load text encoder'), 0];
        vae = [add(fam.loaders.vae[0], { ...fam.loaders.vae[1] }, 'Load VAE'), 0];
        if (fam.builtinLora) model = [add('LoraLoaderModelOnly', { model, ...fam.builtinLora }, 'Lightning LoRA (built in)'), 0];
        break;
      }
      case 'lora': model = [add('LoraLoaderModelOnly', { model, lora_name: p.name, strength_model: p.strength }, `LoRA ${p.name}`), 0]; break;
      case 'controlnet': cn = { loader: add('ControlNetLoader', { control_net_name: p.name }, 'Load ControlNet'), strength: p.strength }; break;
      case 'txt2img': case 'img2img': {
        if (fam.shift) model = [add('ModelSamplingAuraFlow', { model, shift: fam.shift, sampling: 'flow' }), 0];
        const enc = add('CLIPTextEncode', { text: '', clip }, 'Prompt #prompt');
        pos = [enc, 0];
        neg = fam.realNegative ? [add('CLIPTextEncode', { text: '', clip }, 'Negative #negative'), 0] : [add('ConditioningZeroOut', { conditioning: pos }), 0];
        if (fam.guidance) pos = [add('FluxGuidance', { conditioning: pos, guidance: fam.guidance }), 0];
        if (cn) {
          const a = add('ControlNetApplyAdvanced', { positive: pos, negative: neg, control_net: [cn.loader, 0], image: inputImg, strength: cn.strength, start_percent: 0, end_percent: 1, vae }, 'Apply ControlNet');
          pos = [a, 0]; neg = [a, 1];
        }
        if (b.type === 'img2img') {
          const scaled = [add('ImageScaleToTotalPixels', { image: inputImg, upscale_method: 'lanczos', megapixels: 1, resolution_steps: 16 }, 'Scale input to 1 MP'), 0];
          latent = [add('VAEEncode', { pixels: scaled, vae }), 0];
        } else if (fam.sampler === 'custom') latent = [add('EmptyFlux2LatentImage', { width: p.width, height: p.height, batch_size: 1 }), 0];
        else latent = [add('EmptySD3LatentImage', { width: p.width, height: p.height, batch_size: 1 }), 0];
        let samples;
        if (fam.sampler === 'custom') {
          const sig = add('Flux2Scheduler', { steps: p.steps, width: p.width, height: p.height });
          const smp = add('KSamplerSelect', { sampler_name: 'euler' });
          const noise = add('RandomNoise', { noise_seed: 0 });
          const guider = add('CFGGuider', { model, positive: pos, negative: neg, cfg: 1 });
          samples = [add('SamplerCustomAdvanced', { noise: [noise, 0], guider: [guider, 0], sampler: [smp, 0], sigmas: [sig, 0], latent_image: latent }), 0];
        } else {
          samples = [add('KSampler', { seed: 0, steps: p.steps, cfg: 1, sampler_name: fam.ks.sampler_name, scheduler: fam.ks.scheduler, denoise: b.type === 'img2img' ? p.strength : 1, model, positive: pos, negative: neg, latent_image: latent }), 0];
        }
        image = [add('VAEDecode', { samples, vae }), 0];
        break;
      }
      case 'upscale': {
        est(EST.upscale);
        const m = add('UpscaleModelLoader', { model_name: p.model }, 'Load upscale model');
        const up = add('ImageUpscaleWithModel', { upscale_model: [m, 0], image });
        image = [add('ImageScaleBy', { image: [up, 0], upscale_method: 'lanczos', scale_by: Number((p.scale / 4).toFixed(4)) }, `Scale to ${p.scale}x`), 0];
        break;
      }
      case 'image_to_3d': {
        est(EST.image_to_3d);
        const ck = add('ImageOnlyCheckpointLoader', { ckpt_name: 'hunyuan_3d_v2.1.safetensors' }, 'Load Hunyuan3D 2.1');
        const ms = add('ModelSamplingAuraFlow', { model: [ck, 0], shift: 1, sampling: 'flow' });
        // Hunyuan3D needs the object cut out: on an opaque backdrop it models the
        // whole frame and returns a box. Mask with BiRefNet, composite on white.
        const bgm = add('LoadBackgroundRemovalModel', { bg_removal_name: 'birefnet.safetensors' }, 'Load background removal');
        const fg = add('RemoveBackground', { bg_removal_model: [bgm, 0], image });
        const bgMask = add('InvertMask', { mask: [fg, 0] });
        const white = add('EmptyImage', { width: 64, height: 64, batch_size: 1, color: 0xffffff });
        const cut = add('ImageCompositeMasked', { destination: image, source: [white, 0], x: 0, y: 0, resize_source: true, mask: [bgMask, 0] }, 'Object on white');
        const enc = add('CLIPVisionEncode', { clip_vision: [ck, 1], image: [cut, 0], crop: 'center' });
        const cond = add('Hunyuan3Dv2Conditioning', { clip_vision_output: [enc, 0] });
        const lat = add('EmptyLatentHunyuan3Dv2', { resolution: 4096, batch_size: 1 });
        const ks = add('KSampler', { seed: 0, steps: p.steps, cfg: 5, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: [ms, 0], positive: [cond, 0], negative: [cond, 1], latent_image: [lat, 0] });
        const vox = add('VAEDecodeHunyuan3D', { samples: [ks, 0], vae: [ck, 2], num_chunks: 8000, octree_resolution: p.detail });
        mesh = [add('VoxelToMesh', { voxel: [vox, 0], algorithm: 'surface net', threshold: 0.6 }), 0];
        image = null; break;
      }
      case 'video': {
        est(EST.video);
        const un = add('UNETLoader', { unet_name: 'wan2.2_ti2v_5B_fp16.safetensors', weight_dtype: 'default' }, 'Load Wan 2.2 5B');
        const cl = add('CLIPLoader', { clip_name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', type: 'wan', device: 'default' });
        const va = add('VAELoader', { vae_name: 'wan2.2_vae.safetensors' });
        const ms = add('ModelSamplingSD3', { model: [un, 0], shift: 8 });
        const ps = add('CLIPTextEncode', { text: '', clip: [cl, 0] }, 'Prompt #prompt');
        const ng = add('CLIPTextEncode', { text: '', clip: [cl, 0] }, 'Negative #negative');
        const lat = add('Wan22ImageToVideoLatent', { vae: [va, 0], width: 1280, height: 704, length: p.frames, batch_size: 1 });
        const ks = add('KSampler', { seed: 0, steps: p.steps, cfg: 5, sampler_name: 'uni_pc', scheduler: 'simple', denoise: 1, model: [ms, 0], positive: [ps, 0], negative: [ng, 0], latent_image: [lat, 0] });
        const dec = add('VAEDecode', { samples: [ks, 0], vae: [va, 0] });
        video = [add('CreateVideo', { images: [dec, 0], fps: 24 }), 0];
        break;
      }
      case 'audio': {
        const t = TTS[p.engine]; est(t.estMB);
        const voice = t.voice ? { speaker_1_voice: [add('LoadAudio', { audio: t.voice }, 'Voice sample'), 0] } : {};
        audio = [add(t.cls, { ...t.inputs, text: '', seed: 0, ...voice }, `${t.label} #prompt`), 0];
        break;
      }
      case 'save':
        if (mesh) add('SaveGLB', { mesh, filename_prefix: prefix }, 'Save 3D model');
        else if (video) add('SaveVideo', { video, filename_prefix: prefix, format: 'auto', 'format.codec': 'auto', codec: 'auto' }, 'Save video');
        else if (audio) add('SaveAudio', { audio, filename_prefix: prefix }, 'Save audio');
        else add('SaveImage', { images: image, filename_prefix: prefix }, 'Save image');
        break;
    }
  }
  if (objectInfo) fillDefaults(g, objectInfo);
  return { graph: g, estMB, output: mesh ? '3d' : video ? 'video' : audio ? 'audio' : 'image', family: famId || null };
}

/** Required literal inputs a template left out get ComfyUI's own default (never a model combo). */
export function fillDefaults(g, objectInfo) {
  for (const node of Object.values(g)) {
    const req = objectInfo[node.class_type]?.input?.required;
    if (!req) continue;
    for (const [k, spec] of Object.entries(req)) {
      if (k in node.inputs) continue;
      const t = spec[0], o = spec[1] || {};
      if ('default' in o && (['INT', 'FLOAT', 'STRING', 'BOOLEAN'].includes(t) || t === 'COMBO')) node.inputs[k] = o.default;
      else if (t === 'COMBO' && o.options?.length && !/model|name|ckpt|pack/i.test(k)) node.inputs[k] = o.options[0];
    }
  }
  return g;
}

// Inputs the user fills in later (uploaded files): not checked against the combo list.
const USER_INPUTS = new Set(['LoadImage.image', 'LoadVideo.file']);

/**
 * Validate a graph against the live /object_info. Returns plain-language errors.
 * Checks: class exists, required inputs present, links point at real nodes with
 * the right output type, combo values are installed options, numbers in range.
 */
export function validateGraph(g, objectInfo) {
  const errors = [];
  if (!objectInfo) return ['ComfyUI is not reachable, so the setup cannot be checked.'];
  const missingModel = new Set();
  for (const [id, node] of Object.entries(g)) {
    const def = objectInfo[node.class_type];
    if (!def) { errors.push(`ComfyUI has no "${node.class_type}" node (custom node not installed).`); continue; }
    const req = def.input?.required || {}, opt = def.input?.optional || {};
    for (const k of Object.keys(req)) if (!(k in node.inputs) && !k.includes('.') && !Object.keys(node.inputs).some((x) => x.startsWith(k + '.'))) errors.push(`${node.class_type} is missing its required input "${k}".`);
    for (const [k, v] of Object.entries(node.inputs)) {
      const spec = req[k] || opt[k];
      if (!spec) continue; // dynamic sub-inputs like "format.codec"
      const type = spec[0];
      if (Array.isArray(v)) {
        const src = g[String(v[0])];
        if (!src) { errors.push(`${node.class_type}.${k} is linked to a node that does not exist.`); continue; }
        const outs = objectInfo[src.class_type]?.output || [];
        const outType = outs[v[1]];
        if (outType === undefined) { errors.push(`${node.class_type}.${k} is linked to output ${v[1]} of ${src.class_type}, which has only ${outs.length}.`); continue; }
        if (typeof type === 'string' && !type.startsWith('COMFY_') && !String(outType).startsWith('COMFY_') && type !== '*' && outType !== '*') { // COMFY_MATCHTYPE_V3 etc. = generic (switch nodes)
          const want = type.split(','), have = String(outType).split(',');
          if (!want.some((w) => have.includes(w))) errors.push(`${node.class_type}.${k} needs ${type} but gets ${outType} from ${src.class_type}.`);
        }
        continue;
      }
      const opts = comboOptions(spec);
      if (opts) {
        if (USER_INPUTS.has(`${node.class_type}.${k}`)) continue;
        if (node.class_type === 'LoadAudio' && !opts.includes(v)) { errors.push(`VibeVoice needs a voice sample: ComfyUI's input folder has no "${v}". Use the VibeVoice preset and pick a short speech clip there.`); continue; }
        const norm = (s) => String(s).replace(/\\/g, '/');
        if (!opts.map(norm).includes(norm(v))) {
          if (/\.(safetensors|gguf|pth|pt|ckpt|bin)$/i.test(String(v)) || /model|name|ckpt/i.test(k)) missingModel.add(String(v));
          else errors.push(`${node.class_type}.${k}: "${v}" is not an allowed value.`);
        }
        continue;
      }
      const o = spec[1] || {};
      if ((type === 'INT' || type === 'FLOAT') && typeof v === 'number') {
        if (o.min !== undefined && v < o.min || o.max !== undefined && v > o.max) errors.push(`${node.class_type}.${k} = ${v} is outside ${o.min}-${o.max}.`);
      } else if ((type === 'INT' || type === 'FLOAT') && typeof v !== 'number') errors.push(`${node.class_type}.${k} must be a number.`);
    }
  }
  if (missingModel.size) errors.unshift(`Missing model file${missingModel.size > 1 ? 's' : ''} (needs download): ${[...missingModel].join(', ')}.`);
  return errors;
}

/** Plain summary lines for the chat card. */
export function summarize(blocks) {
  const L = [];
  for (const b of blocks) {
    const p = b.params;
    switch (b.type) {
      case 'input_image': L.push('Use a picture you pick'); break;
      // The model line carries no step count: the sampler line below shows the
      // steps actually used (after clamping), so the card matches its clamp note.
      case 'load_model': L.push(`Model: ${FAMILIES[p.family].name || FAMILIES[p.family].label}`); break;
      case 'lora': L.push(`LoRA ${p.name.replace(/\.\w+$/, '')} at ${p.strength}`); break;
      case 'controlnet': L.push(`ControlNet ${p.name.replace(/\.\w+$/, '')} at ${p.strength} (layout from your picture)`); break;
      case 'txt2img': L.push(`Text to image, ${p.width}×${p.height}, ${p.steps} steps`); break;
      case 'img2img': L.push(`Redraw your picture (strength ${p.strength}), ${p.steps} steps`); break;
      case 'upscale': L.push(`Upscale ${p.scale}× with ${p.model.replace(/\.\w+$/, '')}`); break;
      case 'image_to_3d': L.push(`Turn it into a 3D model (Hunyuan3D 2.1, ${p.steps} steps, detail ${p.detail})`); break;
      case 'video': L.push(`Video: Wan 2.2 5B, ${p.frames} frames, ${p.steps} steps`); break;
      case 'audio': L.push(`Speech: ${TTS[p.engine].label}`); break;
      case 'save': L.push('Save the result'); break;
    }
  }
  return L;
}

/**
 * Test-run version of a graph: smaller size / fewer steps so a check is quick.
 * Returns { graph, notes }.
 */
export function testRunGraph(graph) {
  const g = structuredClone(graph), notes = [];
  for (const n of Object.values(g)) {
    if (['EmptySD3LatentImage', 'EmptyFlux2LatentImage', 'Flux2Scheduler'].includes(n.class_type) && typeof n.inputs.width === 'number') {
      const s = Math.min(1, 768 / Math.max(n.inputs.width, n.inputs.height));
      if (s < 1) { n.inputs.width = Math.round(n.inputs.width * s / 16) * 16; n.inputs.height = Math.round(n.inputs.height * s / 16) * 16; }
    }
    if (n.class_type === 'Wan22ImageToVideoLatent') { n.inputs.length = Math.min(n.inputs.length, 17); n.inputs.width = 640; n.inputs.height = 352; }
    if (n.class_type === 'ChatterboxTTS') n.inputs.max_new_tokens = Math.min(n.inputs.max_new_tokens || 400, 200);
    if (n.class_type === 'ImageScaleBy') n.inputs.scale_by = Math.min(n.inputs.scale_by, 0.5);
    if (n.class_type === 'VAEDecodeHunyuan3D') n.inputs.octree_resolution = Math.min(n.inputs.octree_resolution, 192);
  }
  notes.push('Test run: at most 768 px before upscaling, 2x upscale max, short audio/video.');
  return { graph: g, notes };
}

/** Full pipeline used by the server. */
export function buildSetup(rawBlocks, ctx = {}) {
  const chain = checkChain(rawBlocks, ctx);
  if (!chain.ok) return { ok: false, stage: 'chain', errors: chain.errors, notes: chain.notes, blocks: chain.blocks };
  const a = assemble(chain.blocks, { prefix: ctx.prefix, objectInfo: ctx.objectInfo });
  const errors = validateGraph(a.graph, ctx.objectInfo);
  const summary = summarize(chain.blocks);
  if (errors.length) return { ok: false, stage: 'graph', errors, notes: chain.notes, blocks: chain.blocks, summary, estMB: a.estMB, output: a.output };
  return { ok: true, blocks: chain.blocks, notes: chain.notes, graph: a.graph, estMB: a.estMB, output: a.output, family: a.family, summary };
}

/** Does this chat message ask for a SETUP (builder) rather than a prompt? */
export function isBuilderRequest(text) {
  const t = String(text || '').trim();
  if (/^\/build\b/i.test(t)) return true;
  return /\b(make|build|create|set ?up|design|put together|assemble|new)\b/i.test(t) && /\b(setup|set-up|workflow|pipeline|preset|chain)s?\b/i.test(t);
}
