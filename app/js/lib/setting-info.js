// setting-info.js - the short "what does this do?" text behind every (i) icon
// next to a setting (batch 4). Shared by the browser (ui/info-tip.js) and the
// unit test that checks every bundled workflow is covered. No DOM, no I/O.
// -----------------------------------------------------------------------------
// Where a text comes from, first match wins:
//   1. the preset's own param:  workflows/ai/x.json  preset.params.<key>.info
//   2. the preset's info map:   preset.info.<key>  (controls that are not params:
//      "prompt", "negative", "aspect", "batch", "seed", "image", "image.<node>",
//      "mask", "video", "audio")
//   3. GLOSSARY below, by the control's key (or, for #expose controls of an
//      imported workflow, by the node input name, e.g. "cfg", "denoise")
//   4. for #expose controls: a generic text naming the node and input.
// So a workflow JSON can change or add any text without touching code. Write
// for someone new to ComfyUI: what it does, what more / less means, and when
// to leave it alone. Say nothing a preset cannot back up.
// -----------------------------------------------------------------------------

export const GLOSSARY = {
  // ---- main screen ----
  prompt: 'Describe what you want to see. Plain sentences work: say the subject first, then the style, lighting and framing. The more specific, the closer the result.',
  negative: 'Things you do NOT want in the result (for example: blurry, text, watermark, extra fingers). Only some models use a negative prompt, so the switch only appears for those.',
  aspect: 'The shape and size of the result. Pick a ratio (1:1 is square); the two icons flip it to portrait (tall) or landscape (wide). The numbers show the exact size in pixels, kept inside what this model supports.',
  batch: 'How many results one Run makes. Each one is its own job with its own seed, so you get different variations of the same prompt. They appear one by one as they finish.',
  seed: 'The random number a result starts from. The same prompt, settings and seed give the same result again. Lock keeps the number (a batch then uses it, +1, +2, and so on); the shuffle button picks a new one and locks it. Unlocked, every result gets a new random seed.',
  strength: 'How much the reference picture may change. Low keeps the result close to the original; 1.0 repaints almost everything. (This is the sampler\'s "denoise".)',
  denoise: 'How much of the starting picture is repainted. 1.0 = start from pure noise (ignore the picture); lower keeps more of the original.',
  image: 'The picture this preset works from. Pick one from the phone, take a photo, paste, or use one of your earlier results ("From Comfy UI").',
  mask: 'Paint over the part of the picture that should change. Only the painted area is repainted; everything else stays exactly as it was.',
  video: 'The video clip to work on. Short clips are much faster.',
  audio: 'A short recording of a voice (a few seconds of clean speech, no music) for the model to copy.',
  expose: 'A value from the workflow that was marked to show here (#expose). It is written straight into that node when you Run.',
  // ---- sampling (most image and video presets) ----
  steps: 'How many refinement passes the model makes. More steps take longer; past the model\'s sweet spot they rarely make it better.',
  cfg: 'How strictly the model follows the prompt (CFG). Higher sticks closer to the words but can look harsh or over-cooked; lower is looser and more natural.',
  guidance: 'How strictly the model follows the prompt. Higher sticks closer to the words but can look harsh; lower is looser and more natural.',
  shift: 'How the model splits its effort between the overall layout (big shapes, composition) and the fine detail. Higher spends more of the steps on layout. Leave it at the default unless you are experimenting.',
  sampler: 'The method used to take each step. Different samplers give a slightly different look and sharpness. The default is the one this preset was set up with.',
  sampler_name: 'The method used to take each step. Different samplers give a slightly different look and sharpness.',
  scheduler: 'How the steps are spaced between rough and fine. Leave it on the default unless you are experimenting.',
  seconds: 'Length of the result in seconds. Longer takes longer to make.',
  temperature: 'How much randomness goes in. Lower is steadier and more predictable; higher is more varied but can go off the rails.',
  model: 'Which model file this preset loads. Only the ones installed on the PC can run.',
  scale: 'How much bigger the result is than the input (2× = twice the width and twice the height).',
  width: 'Width of the result in pixels.',
  height: 'Height of the result in pixels.',
};

const clean = (s) => (typeof s === 'string' && s.trim() ? s.trim() : null);

/**
 * Text for one control.
 * @param key      control key: a manifest param key, or prompt / negative / aspect /
 *                 batch / seed / strength / steps / image / mask / video / audio / expose
 * @param o.param  the manifest param (for params)
 * @param o.manifest  the preset manifest (wf.ai) if any
 * @param o.node   node id (reference image slots: "image.<node>" override)
 * @param o.input  node input name (#expose controls: looked up in the glossary)
 * @param o.label  shown label (#expose fallback text)
 */
export function infoFor(key, { param, manifest, node, input, label } = {}) {
  const own = manifest?.info || {};
  const hit = clean(param?.info) || (node !== undefined ? clean(own[`${key}.${node}`]) : null) || clean(own[key]);
  if (hit) return hit;
  if (key === 'expose') return clean(GLOSSARY[input]) || `${GLOSSARY.expose}${label ? ` (${label})` : ''}`;
  return clean(GLOSSARY[key]);
}

/**
 * Every control the app shows for a workflow item from /api/workflows, with its
 * info text: [{ key, label, info }]. Mirrors ui/prompt-panel.js, reference.js,
 * file-inputs.js and mask-editor.js (the unit test checks bundled presets).
 */
export function exposedControls(wf) {
  if (!wf?.ok) return [];
  const c = wf.controls || {}, m = wf.ai || null, out = [];
  const add = (key, label, o = {}) => out.push({ key, label, info: infoFor(key, { manifest: m, ...o }) });
  if (c.prompt?.length) add('prompt', 'Prompt');
  if (c.negative?.length) add('negative', 'Negative prompt');
  if (c.width?.length && c.height?.length) add('aspect', 'Aspect');
  add('batch', 'Batch');
  if (c.seed?.length) add('seed', 'Seed');
  if (c.strength?.length) add('strength', 'Strength');
  for (const s of c.images || []) add('image', (s.title || 'Image').replace(/#\w+/g, '').trim(), { node: s.node });
  for (const f of m?.inputs || []) add(f.kind, f.label || f.kind);
  if (m?.mask) add('mask', 'Mask');
  if (c.steps?.length && !m?.params?.steps) add('steps', 'Steps');
  for (const [key, p] of Object.entries(m?.params || {})) add(key, p.label || key, { param: p });
  for (const x of c.expose || []) add('expose', x.label, { input: x.input, label: x.label });
  return out;
}
