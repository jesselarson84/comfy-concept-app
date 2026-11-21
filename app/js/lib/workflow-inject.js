// workflow-inject.js
// -----------------------------------------------------------------------------
// Takes a preset workflow + the controls found by detectControls() + what the
// user typed, and returns a NEW workflow object ready to POST to ComfyUI's
// /prompt endpoint. Pure function: the preset itself is never modified.
// -----------------------------------------------------------------------------

import { OUTPUT_NODES } from './workflow-detect.js';

/**
 * @param {object} wf        API-format workflow (preset file contents)
 * @param {object} controls  result of detectControls(wf)
 * @param {object} v         values: { prompt, negative, seed, steps, width,
 *                           height, strength, images: {nodeId: filename},
 *                           expose: {"node.input": value}, outputPrefix }
 */
export function injectParams(wf, controls, v = {}) {
  const out = structuredClone(wf);
  // Drop app-only metadata keys ("_app" etc.) - ComfyUI would treat every
  // top-level key as a node id and fail on them.
  for (const k of Object.keys(out)) if (k.startsWith('_')) delete out[k];

  const set = (targets, value) => {
    if (value === undefined || value === null || value === '') return;
    for (const t of targets) if (out[t.node]) out[t.node].inputs[t.input] = value;
  };

  set(controls.prompt, v.prompt);
  // Empty negative is a valid choice ("no negative"), so allow ''.
  if (v.negative !== undefined) for (const t of controls.negative) out[t.node].inputs[t.input] = v.negative;
  // Seeds must be integers; ComfyUI accepts 0 .. 2^64-1 but JS numbers are
  // only exact up to 2^53, so the app keeps seeds below that.
  set(controls.seed, v.seed === undefined ? undefined : Math.floor(Number(v.seed)));
  set(controls.steps, v.steps === undefined ? undefined : Math.round(Number(v.steps)));
  // Width/height usually appear twice in Flux.2 graphs (EmptyFlux2LatentImage
  // AND Flux2Scheduler). Both must match, so every target gets the value.
  set(controls.width, v.width);
  set(controls.height, v.height);
  set(controls.strength, v.strength === undefined ? undefined : Number(v.strength));
  // Batch inside one job stays at 1: the app runs N separate jobs instead,
  // so each image arrives (and can be viewed) as soon as it is done.
  set(controls.batch, v.batchSize);

  // Reference images: LoadImage.image takes a filename relative to
  // ComfyUI's input/ folder - exactly the "name" (plus "subfolder/") that
  // /upload/image returned.
  for (const slot of controls.images) {
    const f = v.images?.[slot.node];
    if (f) out[slot.node].inputs[slot.input] = f;
  }
  for (const e of controls.expose) {
    const key = `${e.node}.${e.input}`;
    if (v.expose && key in v.expose) out[e.node].inputs[e.input] = v.expose[key];
  }
  // Put the app's outputs in their own subfolder of ComfyUI/output.
  if (v.outputPrefix) {
    for (const [, n] of Object.entries(out)) {
      // SaveImage, SaveGLB, Save3DAdvanced, SaveVideo, SaveAudio, SaveAudioAdvanced...
      if (/^Save/.test(n.class_type) && typeof n.inputs.filename_prefix === 'string') {
        const base = n.inputs.filename_prefix.split('/').pop() || 'concept';
        n.inputs.filename_prefix = `${v.outputPrefix}/${base}`;
      }
    }
  }
  return out;
}

/** Node ids whose outputs we expect images from. */
export function outputNodeIds(wf) {
  return Object.entries(wf).filter(([, n]) => n && OUTPUT_NODES.has(n.class_type)).map(([k]) => k);
}
