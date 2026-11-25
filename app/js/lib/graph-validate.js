// graph-validate.js - checks an API-format graph against ComfyUI's live /object_info.
// (Batch 15: kept from the retired workflow builder; the tests use it to prove
// every shipped preset graph is valid.) Pure JS, no I/O.
import { comboOptions } from './presets.js';

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
