// workflow-detect.js
// -----------------------------------------------------------------------------
// Looks at an API-format ComfyUI workflow and works out which inputs the app
// should drive: prompt, negative, seed, steps, width/height, batch size,
// reference image slots, strength, and any "#expose"d extras.
//
// This file is plain JS with no DOM or Node APIs, so the SAME code runs on the
// server (to list presets with their controls) and in the browser.
//
// A quick reminder of the API format (what "Export (API)" / "Save (API)" writes):
//
//   {
//     "40": { "class_type": "CLIPTextEncode",
//             "inputs": { "text": "a red fox", "clip": ["2", 0] },
//             "_meta": { "title": "CLIP Text Encode (Prompt)" } },
//     ...
//   }
//
// * The keys ("40") are node ids.
// * An input is either a LITERAL value (string/number/bool) or a LINK, written
//   as [sourceNodeId, outputIndex] - e.g. ["2", 0] = "output 0 of node 2".
// * The UI format (what plain "Save" writes, with "nodes" and "links" arrays)
//   is different and cannot be queued directly - ComfyUI's /prompt endpoint
//   only accepts the API format.
//
// A "target" below is { node, input } - the place a value gets written.
// -----------------------------------------------------------------------------

export const TAGS = ['prompt', 'negative', 'seed', 'image', 'strength', 'width', 'height', 'steps', 'expose'];

// For a #tag on a node, which input names we try (in order) to find the field.
const TAG_INPUT_NAMES = {
  prompt: ['text', 'prompt', 'string', 'value', 't5xxl', 'clip_l', 'text_g', 'text_l'],
  negative: ['text', 'prompt', 'string', 'value', 't5xxl', 'clip_l', 'text_g', 'text_l'],
  seed: ['seed', 'noise_seed', 'value'],
  image: ['image'],
  strength: ['denoise', 'strength', 'value'],
  width: ['width', 'value'],
  height: ['height', 'value'],
  steps: ['steps', 'value'],
};

// Text fields that hold a prompt on encoder nodes (CLIPTextEncode uses "text";
// CLIPTextEncodeFlux uses "clip_l" + "t5xxl"; SDXL uses "text_g" + "text_l";
// several newer encoders use "prompt").
const TEXT_FIELDS = ['text', 'prompt', 't5xxl', 'clip_l', 'text_g', 'text_l'];

// Inputs on sampler/guider nodes that carry conditioning.
const POSITIVE_INPUTS = ['positive', 'cond1', 'conditioning'];
const NEGATIVE_INPUTS = ['negative'];

// While tracing conditioning upstream we never follow these - they lead to
// models/encoders, never to prompt text, and would only waste time.
const DONT_TRACE = new Set(['model', 'clip', 'vae', 'latent', 'latent_image', 'samples', 'pixels', 'image', 'noise', 'sampler', 'sigmas']);

// Nodes that make a conditioning "empty". If the negative path goes through
// one of these, the workflow has no real negative prompt (Flux-style
// distilled models like klein run at cfg 1 with a zeroed negative).
const ZEROING_NODES = new Set(['ConditioningZeroOut']);

// Nodes that write images to disk / back to the client.
export const OUTPUT_NODES = new Set(['SaveImage', 'PreviewImage', 'SaveAnimatedWEBP', 'SaveAnimatedPNG']);

export const isLink = (v) => Array.isArray(v) && v.length === 2 && (typeof v[0] === 'string' || typeof v[0] === 'number') && typeof v[1] === 'number';

/** Is this object an API-format workflow? Returns { ok, reason }. */
export function checkApiFormat(wf) {
  if (!wf || typeof wf !== 'object' || Array.isArray(wf)) return { ok: false, reason: 'Not a JSON object.' };
  if (Array.isArray(wf.nodes) && Array.isArray(wf.links)) {
    return { ok: false, reason: 'This is a UI-format workflow. In ComfyUI use Workflow > Export (API) and import that file instead.' };
  }
  const nodes = Object.entries(wf).filter(([k]) => !k.startsWith('_'));
  if (nodes.length === 0) return { ok: false, reason: 'Workflow has no nodes.' };
  for (const [id, n] of nodes) {
    if (!n || typeof n !== 'object' || typeof n.class_type !== 'string' || typeof n.inputs !== 'object') {
      return { ok: false, reason: `Node "${id}" is missing class_type/inputs - not API format.` };
    }
  }
  return { ok: true };
}

/** Lower-cased tags found in a node's title, e.g. "Prompt #prompt" -> ['prompt']. */
export function tagsOf(node) {
  const title = node?._meta?.title || '';
  const out = [];
  for (const m of title.matchAll(/#([a-z]+)/gi)) {
    const t = m[1].toLowerCase();
    if (TAGS.includes(t)) out.push(t);
  }
  return out;
}

function nodeEntries(wf) {
  // Skip keys starting with "_" so a workflow can carry an optional
  // "_app" block (label/description) without confusing ComfyUI tooling here.
  return Object.entries(wf).filter(([k, n]) => !k.startsWith('_') && n && n.inputs);
}

// If an input is a link to a simple "primitive" node (PrimitiveInt,
// PrimitiveString, a seed node...), follow it so we edit the value at its
// source. Returns a target or null.
function resolveTarget(wf, nodeId, input, wantType, depth = 0) {
  const node = wf[nodeId];
  if (!node) return null;
  const v = node.inputs[input];
  if (!isLink(v)) {
    if (wantType && typeof v !== wantType) return null;
    return { node: String(nodeId), input };
  }
  if (depth > 3) return null;
  const src = wf[String(v[0])];
  if (!src) return null;
  // The source node must hold exactly one literal of the wanted type.
  const literals = Object.entries(src.inputs || {}).filter(([, x]) => !isLink(x) && (!wantType || typeof x === wantType));
  const preferred = literals.find(([k]) => ['value', 'string', 'text', 'seed', 'noise_seed', 'int', 'float'].includes(k));
  const pick = preferred || (literals.length === 1 ? literals[0] : null);
  if (!pick) return null;
  return resolveTarget(wf, String(v[0]), pick[0], wantType, depth + 1);
}

function valueAt(wf, t) { return wf[t.node]?.inputs?.[t.input]; }

function pushUnique(list, t) {
  if (t && !list.some((x) => x.node === t.node && x.input === t.input)) list.push(t);
}

// Walk upstream from a link, collecting text-encoder nodes. Returns
// { texts: [nodeId], zeroed: bool }.
function traceConditioning(wf, link, stopAtZero) {
  const texts = [];
  let zeroed = false;
  const seen = new Set();
  const stack = [String(link[0])];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const n = wf[id];
    if (!n) continue;
    if (ZEROING_NODES.has(n.class_type) && stopAtZero) { zeroed = true; continue; }
    if (TEXT_FIELDS.some((f) => n.inputs[f] !== undefined && (typeof n.inputs[f] === 'string' || isLink(n.inputs[f])))) {
      // A node with a text field is an encoder - record it. Do not keep
      // tracing past it (its "clip" input leads to the loader).
      if (TEXT_FIELDS.some((f) => resolveTarget(wf, id, f, 'string'))) { texts.push(id); continue; }
    }
    for (const [k, v] of Object.entries(n.inputs)) {
      if (isLink(v) && !DONT_TRACE.has(k)) stack.push(String(v[0]));
    }
  }
  return { texts, zeroed };
}

function textTargets(wf, nodeId) {
  const out = [];
  for (const f of TEXT_FIELDS) {
    if (wf[nodeId].inputs[f] !== undefined) pushUnique(out, resolveTarget(wf, nodeId, f, 'string'));
  }
  return out;
}

function titleOf(wf, id) { return wf[id]?._meta?.title || wf[id]?.class_type || id; }

/**
 * Main entry point. Returns:
 * {
 *   ok, error?,                      // false + error if not API format
 *   kind: 'txt2img' | 'img2img' | 'custom' | 'unknown',
 *   prompt: [targets], negative: [targets], seed: [targets], steps: [targets],
 *   width: [targets], height: [targets], batch: [targets], strength: [targets],
 *   images: [{ node, input, title }],      // reference image slots (LoadImage)
 *   expose: [{ node, input, label, type, value }],
 *   outputs: [nodeId],                      // SaveImage/PreviewImage nodes
 *   defaults: { prompt, negative, seed, steps, width, height, strength },
 *   warnings: [string], message?: string
 * }
 */
export function detectControls(wf) {
  const fmt = checkApiFormat(wf);
  if (!fmt.ok) return { ok: false, error: fmt.reason };

  const c = { ok: true, prompt: [], negative: [], seed: [], steps: [], width: [], height: [], batch: [], strength: [], images: [], expose: [], outputs: [], warnings: [] };
  const entries = nodeEntries(wf);

  // ---- 1. Explicit #tags in node titles win over auto-detection ----------
  const tagged = {};
  for (const [id, n] of entries) {
    for (const tag of tagsOf(n)) {
      if (tag === 'expose') {
        for (const [k, v] of Object.entries(n.inputs)) {
          if (!isLink(v) && ['string', 'number', 'boolean'].includes(typeof v)) {
            c.expose.push({ node: id, input: k, label: `${titleOf(wf, id).replace(/#\w+/g, '').trim() || n.class_type} - ${k}`, type: typeof v, value: v });
          }
        }
        continue;
      }
      tagged[tag] = tagged[tag] || [];
      const want = { prompt: 'string', negative: 'string', image: 'string' }[tag] || 'number';
      // Known input names first; otherwise the node's first literal of the
      // right type (so a custom node with a "words" field still works).
      const name = TAG_INPUT_NAMES[tag].find((k) => n.inputs[k] !== undefined && resolveTarget(wf, id, k, want))
        || Object.keys(n.inputs).find((k) => !isLink(n.inputs[k]) && typeof n.inputs[k] === want);
      const t = name ? resolveTarget(wf, id, name, want) : null;
      if (t) tagged[tag].push(tag === 'image' ? { ...t, title: titleOf(wf, id).replace(/#\w+/g, '').trim() } : t);
      else c.warnings.push(`Node ${id} is tagged #${tag} but has no suitable input.`);
    }
  }

  // ---- 2. Output nodes ----------------------------------------------------
  for (const [id, n] of entries) if (OUTPUT_NODES.has(n.class_type)) c.outputs.push(id);

  // ---- 3. Prompt / negative, by tracing from samplers/guiders ------------
  // Samplers (KSampler, KSamplerAdvanced, SamplerCustom) and guiders
  // (CFGGuider, BasicGuider, DualCFGGuider) have "positive"/"negative"
  // (or "conditioning") inputs. Tracing backwards tells us which text
  // encoder feeds which side, even through ReferenceLatent, FluxGuidance,
  // ConditioningCombine, etc.
  const pos = [], neg = [];
  let sawSampler = false, negZeroed = false;
  for (const [, n] of entries) {
    for (const k of POSITIVE_INPUTS) {
      if (isLink(n.inputs[k]) && /Sampler|Guider/i.test(n.class_type)) {
        sawSampler = true;
        traceConditioning(wf, n.inputs[k], false).texts.forEach((id) => pos.includes(id) || pos.push(id));
      }
    }
    for (const k of NEGATIVE_INPUTS) {
      if (isLink(n.inputs[k]) && /Sampler|Guider/i.test(n.class_type)) {
        const r = traceConditioning(wf, n.inputs[k], true);
        if (r.zeroed) negZeroed = true;
        r.texts.forEach((id) => neg.includes(id) || neg.push(id));
      }
    }
  }
  if (!sawSampler) {
    // No recognisable sampler: fall back to "any text encoder"; titles with
    // "neg" in them count as negative.
    for (const [id, n] of entries) {
      if (textTargets(wf, id).length && /Encode|Prompt|Text/i.test(n.class_type)) {
        (/neg/i.test(titleOf(wf, id)) ? neg : pos).push(id);
      }
    }
  }
  for (const id of pos) textTargets(wf, id).forEach((t) => pushUnique(c.prompt, t));
  for (const id of neg) if (!pos.includes(id)) textTargets(wf, id).forEach((t) => pushUnique(c.negative, t));
  if (negZeroed && !c.negative.length) c.notes = ['Negative is zeroed (ConditioningZeroOut) - no negative prompt.'];

  // ---- 4. Seed / steps / size / batch / denoise ---------------------------
  for (const [id, n] of entries) {
    for (const k of ['seed', 'noise_seed']) if (n.inputs[k] !== undefined) pushUnique(c.seed, resolveTarget(wf, id, k, 'number'));
    if (n.inputs.steps !== undefined) pushUnique(c.steps, resolveTarget(wf, id, 'steps', 'number'));
    // Only size inputs on latent/scheduler nodes count. (An ImageScale node
    // also has width/height but that resizes an input picture.) Links (e.g.
    // width coming from GetImageSize in the reference preset) are skipped
    // on purpose: there, the size follows the reference image.
    if (/Latent|Scheduler|ModelSampling/.test(n.class_type)) {
      for (const k of ['width', 'height']) if (typeof n.inputs[k] === 'number') pushUnique(c[k], { node: id, input: k });
      if (typeof n.inputs.batch_size === 'number') pushUnique(c.batch, { node: id, input: 'batch_size' });
    }
    if (n.class_type === 'LoadImage' && typeof n.inputs.image === 'string') c.images.push({ node: id, input: 'image', title: titleOf(wf, id) });
  }
  // Denoise/strength only makes sense when an image is fed in.
  if (c.images.length || tagged.image) {
    for (const [id, n] of entries) {
      if (typeof n.inputs.denoise === 'number') pushUnique(c.strength, { node: id, input: 'denoise' });
    }
  }

  // Tags replace auto-detected lists for their kind.
  for (const [tag, list] of Object.entries(tagged)) {
    const key = tag === 'image' ? 'images' : tag;
    if (list.length) c[key] = list;
  }
  c.seed = c.seed.filter(Boolean); c.steps = c.steps.filter(Boolean);

  // ---- 5. Defaults (current values in the file) ---------------------------
  const first = (list) => (list.length ? valueAt(wf, list[0]) : undefined);
  c.defaults = {
    prompt: first(c.prompt) ?? '',
    negative: first(c.negative) ?? '',
    seed: first(c.seed),
    steps: first(c.steps),
    width: first(c.width),
    height: first(c.height),
    strength: first(c.strength),
  };

  // ---- 6. Kind + friendly messages ---------------------------------------
  const detected = c.prompt.length + c.seed.length + c.images.length + c.width.length + c.expose.length;
  if (!c.outputs.length) c.warnings.push('No SaveImage/PreviewImage node - ComfyUI will reject it or return no images.');
  if (!detected) {
    c.kind = 'unknown';
    c.message = 'No controls detected. It will run exactly as saved. Add #prompt / #seed / #image ... to node titles in ComfyUI to expose controls.';
  } else if (c.images.length) c.kind = 'img2img';
  else if (c.prompt.length) c.kind = 'txt2img';
  else c.kind = 'custom';
  if (!c.prompt.length && detected) c.warnings.push('No prompt text node detected.');
  return c;
}
