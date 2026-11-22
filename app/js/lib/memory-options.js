// memory-options.js - batch 3 memory items (pure, shared by browser, server, tests).
// -----------------------------------------------------------------------------
//  - CPU text encoder: CLIPLoader / DualCLIPLoader get device "cpu" (their real
//    optional input, ['default', 'cpu'] in /object_info), so the encoder never
//    takes VRAM from the diffusion model. Off by default; a switch in the menu.
//  - Tiled VAE decode fallback: VAEDecode -> VAEDecodeTiled (tile 512, overlap
//    64, temporal 64/8 = the node's own defaults) when the output is above
//    ~2 MP, or for a preset whose last run ran out of memory.
//  - Heavy jobs: Ollama is unloaded (keep_alive 0) before them on every GPU.
//    Heavy = the manifest says so (Pixal3D) or it needs >= 12 GB.
//  - GGUF loader path: a preset with manifest.gguf runs its UNet through
//    UnetLoaderGGUF (Q5_K_M) on the small-GPU profile, or when the fp8 file is
//    not installed but the GGUF is.
// -----------------------------------------------------------------------------
export const TEXT_ENCODER_CLASSES = ['CLIPLoader', 'DualCLIPLoader'];
export const TILED_MP = 2.0;
export const HEAVY_MB = 12000;
export const TILED_INPUTS = { tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 };

const real = (g) => Object.entries(g || {}).filter(([id, n]) => !id.startsWith('_') && n && typeof n === 'object');

/** Copy of the graph with every text encoder loader on the CPU. */
export function textEncoderOnCpu(graph) {
  const out = structuredClone(graph);
  for (const [, n] of real(out)) if (TEXT_ENCODER_CLASSES.includes(n.class_type)) n.inputs.device = 'cpu';
  return out;
}

/** Copy of the graph with plain VAEDecode nodes swapped for VAEDecodeTiled (same links). */
export function tiledVaeDecode(graph, inputs = TILED_INPUTS) {
  const out = structuredClone(graph);
  for (const [, n] of real(out)) {
    if (n.class_type !== 'VAEDecode') continue;
    n.class_type = 'VAEDecodeTiled';
    n.inputs = { samples: n.inputs.samples, vae: n.inputs.vae, ...inputs };
    n._meta = { ...(n._meta || {}), title: 'VAE Decode (Tiled)' };
  }
  return out;
}

export const hasVaeDecode = (graph) => real(graph).some(([, n]) => n.class_type === 'VAEDecode');

/** Megapixels of one output image (null when the size is not known up front). */
export function outputMP({ width, height } = {}) {
  return width > 0 && height > 0 ? (width * height) / 1e6 : null;
}

/** Use the tiled decode? Above ~2 MP, or after this preset ran out of memory. */
export function wantTiledDecode({ width, height, oomBefore = false } = {}) {
  const mp = outputMP({ width, height });
  if (oomBefore) return { tiled: true, reason: 'out of memory last time' };
  if (mp !== null && mp > TILED_MP) return { tiled: true, reason: `${mp.toFixed(1)} MP output` };
  return { tiled: false, reason: '' };
}

/** ComfyUI / torch out-of-memory errors. */
export function isOom(text) {
  return /out of memory|OutOfMemory|\bOOM\b|CUDA error: out of memory|allocation on device|not enough memory/i.test(String(text || ''));
}

/** Heavy job: Ollama gets keep_alive 0 before it, whatever the GPU profile. */
export function isHeavy(manifest, estMB) {
  if (manifest?.heavy === true) return true;
  const est = estMB ?? manifest?.vram?.measuredMB ?? manifest?.vram?.estMB ?? 0;
  return est >= HEAVY_MB;
}

/**
 * GGUF loader path. manifest.gguf = { node, unet_name, estMB }.
 * Returns { workflow, manifest, loader: 'gguf' | 'default', reason }.
 * Uses the GGUF when UnetLoaderGGUF lists the file and either the profile is
 * the small one or the graph's own (fp8) UNet is not installed.
 */
export function ggufPath(workflow, manifest, { objectInfo, profileId } = {}) {
  const g = manifest?.gguf;
  if (!g || !workflow?.[g.node]) return { workflow, manifest, loader: 'default', reason: '' };
  const ggufList = optionsOf(objectInfo?.UnetLoaderGGUF, 'unet_name');
  if (!ggufList?.includes(g.unet_name)) return { workflow, manifest, loader: 'default', reason: 'GGUF not installed' };
  const n = workflow[g.node];
  const own = optionsOf(objectInfo?.[n.class_type], 'unet_name');
  const ownMissing = n.class_type !== 'UnetLoaderGGUF' && own && !own.includes(n.inputs.unet_name);
  if (profileId !== 'small' && !ownMissing && n.class_type !== 'UnetLoaderGGUF') return { workflow, manifest, loader: 'default', reason: `profile ${profileId}: default loader` };
  const wf = structuredClone(workflow);
  wf[g.node] = { class_type: 'UnetLoaderGGUF', inputs: { unet_name: g.unet_name }, _meta: { title: 'Unet Loader (GGUF)' } };
  const vram = { ...manifest.vram, estMB: g.estMB || manifest.vram?.estMB, measuredMB: g.measuredMB || undefined };
  return { workflow: wf, manifest: { ...manifest, vram }, loader: 'gguf', reason: ownMissing ? 'default UNet not installed' : `profile ${profileId}` };
}

function optionsOf(def, input) {
  const spec = def?.input?.required?.[input] || def?.input?.optional?.[input];
  if (!Array.isArray(spec)) return null;
  if (Array.isArray(spec[0])) return spec[0];
  if (spec[0] === 'COMBO' && Array.isArray(spec[1]?.options)) return spec[1].options;
  return null;
}
