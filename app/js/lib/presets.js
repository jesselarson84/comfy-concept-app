// presets.js - the AI Workflow presets (workflows/ai/*.json): one ready-made
// API graph per entry of ComfyUI's "AI Workflow" right-click menu (custom node
// pack ComfyUI-AIWorkflowMenu), plus the TTS presets.
// Shared by the server (validation + live availability) and the browser
// (clamping what the user typed before a graph is queued). No I/O here.
// -----------------------------------------------------------------------------
// A preset file is { "preset": <manifest>, "workflow": <API graph> }, the same
// pattern as workflows/actions/*.json:
//   manifest = {
//     group: "3D" | "Image" | "Video" | "Audio", label, menuPath, menuOrder, source,
//     output: "image" | "video" | "audio" | "3d", description,
//     size:   { base: [w, h], min, max, multiple }   (aspect chips -> clamped size)
//     params: { key: { node, input, also?: [{node,input}], set?: { option: [{node,input,value}] },
//                      type: "int"|"number"|"enum"|"text",
//                      min, max, default, options, label, divideBy } }
//     inputs: [{ kind: "video", node, input, label }]   file slots other than LoadImage
//     promptFormat: { unless: regex, template: "[1] {text}" }
//     info:   { prompt | negative | image | image.<node> | video | audio | ...: text }
//             and params.<key>.info: the (i) texts (lib/setting-info.js)
//     maxBatch, vram: { estMB, basis, measuredMB }, files: [{ folder, file }]
//   }
// Prompt / negative / seed / reference images / width+height are found by
// detectControls() from the #tags in node titles, exactly like the other
// presets; params are clamped to [min, max] (bad enum -> default) with a note
// for every change. The graph always comes from the file.
// -----------------------------------------------------------------------------
import { clampParams } from './actions.js';

export const GROUPS = ['3D', 'Image', 'Video', 'Audio'];
// Two kinds of preset (picker tabs "Models" / "Workflows", ComfyUI right-click
// "AI Models" / "AI Workflows"): a model preset runs one model as it comes; a
// workflow preset is a multi-step pipeline for a task (manifest kind: "workflow"),
// grouped by task instead of by output.
export const KINDS = ['model', 'workflow'];
export const WORKFLOW_GROUPS = ['Textures', 'Concept', 'VFX', '3D Assets', 'Sound'];
export const groupsFor = (kind) => (kind === 'workflow' ? WORKFLOW_GROUPS : GROUPS);
// Sub sections of a group in the picker (batch 4), in this order. A preset is in
// one when its menuPath is "<group>/<sub section>/<short name>", e.g.
// "Image/Text to Image/Z-Image Turbo"; the short name is what the row shows
// (the full label stays the preset's name everywhere else).
export const SUBGROUPS = { Image: ['Text to Image', 'Image Edit', 'Inpainting', 'Outpainting', 'Upscale'] }; // batch 14: Outpainting

/** { subgroup, short } from a menuPath ("Video/Wan 2.2 5B Text/Image to Video" has no sub section). */
export function menuParts(group, menuPath, label) {
  const parts = String(menuPath || '').split('/');
  if (parts[0] === group && parts.length >= 3 && SUBGROUPS[group]?.includes(parts[1])) return { subgroup: parts[1], short: parts.slice(2).join('/').trim() || label };
  return { subgroup: null, short: label };
}
export const OUTPUTS = ['image', 'video', 'audio', '3d'];
// Literal inputs that name a model file: checked against ComfyUI's model lists.
export const MODEL_EXT = /\.(safetensors|gguf|pth|pt|ckpt|bin|sft)$/i;

/** Validate one preset file. Returns { ok, id, manifest, workflow, error }. */
export function validatePreset(id, file) {
  const fail = (error) => ({ ok: false, id, error });
  if (!file || typeof file !== 'object') return fail('not an object');
  const m = file.preset, wf = file.workflow;
  if (!m || typeof m !== 'object') return fail('missing "preset" manifest');
  if (!wf || typeof wf !== 'object' || !Object.keys(wf).length) return fail('missing "workflow" graph');
  for (const [k, n] of Object.entries(wf)) if (!k.startsWith('_') && (!n || typeof n.class_type !== 'string' || typeof n.inputs !== 'object')) return fail(`workflow node ${k} is not API format`);
  const kind = m.kind ?? 'model';
  if (!KINDS.includes(kind)) return fail(`kind must be one of ${KINDS.join(', ')}`);
  if (!groupsFor(kind).includes(m.group)) return fail(`group must be one of ${groupsFor(kind).join(', ')}`);
  if (m.promptDefault !== undefined && typeof m.promptDefault !== 'string') return fail('promptDefault must be a string');
  if (typeof m.label !== 'string' || !m.label.trim()) return fail('manifest needs a label');
  if (!OUTPUTS.includes(m.output)) return fail(`output must be one of ${OUTPUTS.join(', ')}`);
  const params = {};
  for (const [key, p] of Object.entries(m.params || {})) {
    for (const t of [p, ...(p.also || [])]) {
      const n = wf[t?.node];
      if (!n) return fail(`param ${key}: node ${t?.node} not in workflow`);
      if (!(t.input in n.inputs)) return fail(`param ${key}: input ${t.input} not on node ${t.node}`);
      if (Array.isArray(n.inputs[t.input])) return fail(`param ${key}: input ${t.input} on node ${t.node} is a link, not a value`);
    }
    if (p.type === 'enum') {
      if (!Array.isArray(p.options) || !p.options.length) return fail(`param ${key}: enum needs options`);
      if (!p.options.includes(p.default)) return fail(`param ${key}: default not in options`);
      // Batch 13+: { set: { option: [{ node, input, value }] } } - one choice sets several inputs (switches).
      if (p.set !== undefined) {
        if (!p.set || typeof p.set !== 'object') return fail(`param ${key}: set must be { option: [...] }`);
        for (const [opt, list] of Object.entries(p.set)) {
          if (!p.options.map(String).includes(opt)) return fail(`param ${key}: set names unknown option ${opt}`);
          for (const t of Array.isArray(list) ? list : [null]) {
            const n = wf[t?.node];
            if (!n || !(t.input in n.inputs) || Array.isArray(n.inputs[t.input])) return fail(`param ${key}: set ${opt}: ${t?.node}.${t?.input} is not a value on a node`);
          }
        }
      }
    } else if (p.type === 'number' || p.type === 'int') {
      if (!(Number.isFinite(p.min) && Number.isFinite(p.max) && p.min <= p.max)) return fail(`param ${key}: needs min <= max`);
      if (!(p.default >= p.min && p.default <= p.max)) return fail(`param ${key}: default outside [min, max]`);
    } else if (p.type === 'text') {
      if (typeof p.default !== 'string') return fail(`param ${key}: text default must be a string`);
    } else return fail(`param ${key}: type must be int, number, enum or text`);
    if (p.control && !CONTROLS.includes(p.control)) return fail(`param ${key}: control must be one of ${CONTROLS.join(', ')}`);
    if (p.when && !(m.params[p.when.param])) return fail(`param ${key}: "when" names unknown param ${p.when.param}`);
    if (p.modes && !(m.params[p.modes.param])) return fail(`param ${key}: "modes" names unknown param ${p.modes.param}`);
    if (p.auto && (p.auto !== 'key' || !p.options.includes('auto'))) return fail(`param ${key}: auto must be "key" with an "auto" option`);
    if (p.info !== undefined && typeof p.info !== 'string') return fail(`param ${key}: info must be a string`);
    if (p.installed && !((p.installed.folder && p.installed.prefix) || (p.installed.fsFolder && p.installed.dir))) return fail(`param ${key}: "installed" needs folder + prefix or fsFolder + dir`);
    params[key] = { ...p, label: p.label || key };
  }
  // Optional picture/audio slots: when left empty the node and its links are dropped.
  for (const o of m.optional || []) {
    if (!wf[o.node]) return fail(`optional slot: node ${o.node} not in workflow`);
    for (const d of o.drop || []) if (!wf[d.node] || !Array.isArray(wf[d.node].inputs[d.input]) || wf[d.node].inputs[d.input][0] !== String(o.node)) return fail(`optional slot ${o.node}: ${d.node}.${d.input} is not linked to it`);
  }
  if (m.size) {
    const s = m.size;
    if (!Array.isArray(s.base) || s.base.length !== 2 || !(s.min > 0 && s.max >= s.min)) return fail('size needs base [w, h], min and max');
  }
  // Painted mask (inpaint presets): a LoadImage the mask editor fills, for the picture in mask.image.
  if (m.mask) {
    const mn = wf[m.mask.node], src = wf[m.mask.image];
    if (!mn || mn.class_type !== 'LoadImage' || !('image' in mn.inputs)) return fail('mask.node must be a LoadImage in the workflow');
    if (!src || src.class_type !== 'LoadImage') return fail('mask.image must be the LoadImage of the picture');
  }
  // Info texts for the (i) icons (lib/setting-info.js): { controlKey: text }.
  if (m.info !== undefined && (!m.info || typeof m.info !== 'object' || Object.values(m.info).some((t) => typeof t !== 'string'))) return fail('info must be { key: text }');
  for (const inp of m.inputs || []) {
    const n = wf[inp.node];
    if (!n || !(inp.input in n.inputs)) return fail(`input slot ${inp.kind}: node ${inp.node}.${inp.input} not in workflow`);
  }
  return {
    ok: true, id,
    manifest: {
      kind, promptDefault: m.promptDefault || '', assistant: typeof m.assistant === 'string' ? m.assistant : '',
      group: m.group, label: m.label.trim(), menuPath: m.menuPath || `${m.group}/${m.label}`, source: String(m.source || ''),
      ...menuParts(m.group, m.menuPath, m.label.trim()), menuOrder: Number.isFinite(m.menuOrder) ? m.menuOrder : 999,
      output: m.output, description: String(m.description || ''), params, size: m.size || null,
      inputs: (m.inputs || []).map((x) => ({ ...x, node: String(x.node) })), promptFormat: m.promptFormat || null,
      maxBatch: Number.isFinite(m.maxBatch) ? m.maxBatch : 20, vram: { estMB: 0, ...(m.vram || {}) }, files: m.files || [],
      optional: (m.optional || []).map((o) => ({ node: String(o.node), drop: o.drop || [] })),
      mask: m.mask ? { node: String(m.mask.node), input: 'image', image: String(m.mask.image) } : null,
      info: { ...(m.info || {}) },
      heavy: m.heavy === true, gguf: m.gguf && wf[m.gguf.node] && typeof m.gguf.unet_name === 'string' ? { ...m.gguf, node: String(m.gguf.node) } : null,
    },
    workflow: wf,
  };
}

// Manifest param hints for the Settings area (ui/prompt-panel.js):
//   control  stepper | slider | select | seg | text (else picked from type/range)
//   group    small group title inside Settings;  span2: full row;  open: on the main screen
//   labels   { optionValue: 'Shown name' };  format: x | k | s | px | frames (value readout)
//   when     { param, is | in | notIn }  the setting only applies then (dimmed otherwise;
//            offValue, if given, is what the graph gets while it doesn't apply)
//   modes    { param, values: { [value]: { min, max, default } } }  range follows another setting
//   zeroAtMax  the top of the range sends 0 (e.g. DecimateMesh 0 = full mesh)
//   multiplyBy / divideBy  unit conversion into the graph (seconds -> tokens, % -> 0..1)
//   auto     'key' (ACE-Step): the enum has an "auto" option although the node has no
//            native auto (keyscale is a required combo, so it cannot be omitted).
//            Auto = the key named in the prompt/tags if there is one ("... in A minor"),
//            else one picked from the seed (same seed, same key). Nothing is
//            added to the tags. See resolveAutoKey().
//   installed  enum of model packs the node lists even when not downloaded: keep only
//            packs found on the PC. { folder, prefix: '{v}/' } = a .safetensors under
//            /models/<folder>; { fsFolder, dir: 'X/{v}' } = a .safetensors in that
//            folder of ComfyUI's model paths (server/presets.js withInstalledOptions)
export const CONTROLS = ['stepper', 'slider', 'select', 'seg', 'text'];

/** Range of a numeric param (it may follow another param, manifest "modes"). */
export function paramRange(p, values = {}) {
  const m = p.modes ? p.modes.values?.[String(values[p.modes.param])] : null;
  return { min: m?.min ?? p.min, max: m?.max ?? p.max, default: m?.default ?? p.default };
}

/** Does this setting apply with the other values (manifest "when")? */
export function paramActive(p, values = {}, params = {}) {
  const w = p.when;
  if (!w) return true;
  const v = String(values[w.param] ?? params[w.param]?.default);
  if ('is' in w) return v === String(w.is);
  if (w.in) return w.in.map(String).includes(v);
  if (w.notIn) return !w.notIn.map(String).includes(v);
  return true;
}

/** Control a param gets in the Settings area. */
export function controlFor(p) {
  if (p.control) return p.control;
  if (p.type === 'text') return 'text';
  if (p.type === 'enum') return p.options.length <= 3 ? 'seg' : 'select';
  if (p.type === 'int' && (p.max - p.min) / (p.step || 1) <= 200) return 'stepper';
  return 'slider';
}

/** Value readout for a param ("2.0×", "300k", "16 s", "Full"). */
export function formatParam(p, v, values = {}) {
  if (p.zeroAtMax && Number(v) >= p.max) return 'Full';
  if (p.labels && String(v) in p.labels) return p.labels[String(v)];
  const n = Number(v);
  if (p.format === 'x') return `${n.toFixed(1)}×`;
  if (p.format === 'k') return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
  if (p.format === 's') return `${n} s`;
  if (p.format === 'dB') return `${n > 0 ? '+' : ''}${n} dB`;
  if (p.format === 'frames') { const fps = Number(values[p.fpsParam || 'fps']) || 24; return `${n} · ${(n / fps).toFixed(1)} s`; }
  if (p.format === 'px') return `${n} px`;
  if (p.type === 'int' || !Number.isFinite(n)) return String(v);
  const st = p.step || 0.01;
  const dec = st >= 1 ? 0 : Math.min(3, Math.max(1, String(st).split('.')[1]?.length || 1));
  return n.toFixed(dec);
}

/** Drop the optional slots (manifest "optional") that were left empty. */
export function dropEmptyOptional(manifest, workflow, filled = new Set()) {
  for (const o of manifest.optional || []) {
    if (filled.has(o.node)) continue;
    delete workflow[o.node];
    for (const d of o.drop) if (workflow[d.node]) delete workflow[d.node].inputs[d.input];
  }
  return workflow;
}

/** Clamp the user's values for a preset. Returns { params, size, batch, notes }. */
export function clampPresetValues(manifest, { params = {}, width, height, batch } = {}) {
  const numeric = Object.fromEntries(Object.entries(manifest.params).filter(([, d]) => d.type !== 'text'));
  const given = Object.fromEntries(Object.entries(params || {}).filter(([k]) => manifest.params[k]?.type !== 'text'));
  const { params: p, notes } = clampParams({ params: numeric }, given);
  // Ranges that follow another setting (e.g. Qwen steps 2-8 with Lightning, 20-50 without).
  for (const [k, d] of Object.entries(manifest.params)) {
    if (!d.modes || d.type === 'enum' || d.type === 'text') continue;
    const r = paramRange(d, p);
    const given = params?.[k];
    const v = given === undefined || given === null || given === '' ? r.default : p[k];
    const c = Math.min(r.max, Math.max(r.min, v));
    if (c !== v && given !== undefined) notes.push(`${d.label}: ${v} is outside ${r.min}-${r.max}, using ${c}`);
    p[k] = c;
  }
  // text params: any string, but bounded length
  for (const [k, d] of Object.entries(manifest.params)) {
    if (d.type === 'text') { const v = params[k]; p[k] = typeof v === 'string' ? v.slice(0, 4000) : d.default; }
  }
  let size;
  if (manifest.size && width !== undefined && height !== undefined) {
    const { min, max, multiple = 16 } = manifest.size;
    const fix = (v, name) => {
      let x = Math.min(max, Math.max(min, Number(v) || min));
      x = Math.max(multiple, Math.round(x / multiple) * multiple);
      if (x !== Number(v)) notes.push(`${name}: ${v} -> ${x} (allowed ${min}-${max}, multiple of ${multiple})`);
      return x;
    };
    size = { width: fix(width, 'width'), height: fix(height, 'height') };
  }
  let b;
  if (batch !== undefined) {
    b = Math.max(1, Math.min(manifest.maxBatch || 20, Math.round(Number(batch) || 1)));
    if (b !== Number(batch)) notes.push(`batch: ${batch} -> ${b} (this preset allows up to ${manifest.maxBatch})`);
  }
  return { params: p, size, batch: b, notes };
}

/**
 * ACE-Step "Auto" key: the node has no auto value, so the app resolves it.
 * 1) a key named in the text ("in F# minor", "Bb major", "Am", "C#m") -> that key,
 *    spelled as one of the options (enharmonic: A# = Bb, Db = C#, ...);
 * 2) otherwise a key picked from the seed, so a seed always gives the same key.
 */
export function resolveAutoKey(options, text = '', seed = 0) {
  const keys = options.filter((o) => o !== 'auto');
  const ENH = { 'A#': 'Bb', Bb: 'A#', 'C#': 'Db', Db: 'C#', 'D#': 'Eb', Eb: 'D#', 'F#': 'Gb', Gb: 'F#', 'G#': 'Ab', Ab: 'G#' };
  const re = /(?:^|[^A-Za-z#])([A-G])\s?(#|b|♯|♭)?\s?(major|minor|maj|min|m)(?![A-Za-z])/g;
  for (const m of String(text || '').matchAll(re)) {
    const root = m[1] + (m[2] === '#' || m[2] === '♯' ? '#' : m[2] === 'b' || m[2] === '♭' ? 'b' : '');
    const q = /^m(in(or)?)?$/.test(m[3]) ? 'minor' : 'major';
    for (const r of [root, ENH[root]]) if (r && keys.includes(`${r} ${q}`)) return `${r} ${q}`;
  }
  const n = Math.abs(Math.floor(Number(seed) || 0));
  return keys[n % keys.length];
}

/** Write clamped params into a copy of the graph (divideBy applied). */
export function applyPresetParams(manifest, workflow, params) {
  const out = structuredClone(workflow);
  for (const [key, p] of Object.entries(manifest.params)) {
    let v = params[key] ?? p.default;
    if (!paramActive(p, params, manifest.params) && 'offValue' in p) v = p.offValue;
    if (p.auto === 'key' && v === 'auto') v = resolveAutoKey(p.options, out[p.node]?.inputs?.tags, out[p.node]?.inputs?.seed);
    if (p.zeroAtMax && Number(v) >= p.max) v = 0;
    if (p.multiplyBy) v = Math.round(v * p.multiplyBy);
    if (p.divideBy) v = Number((v / p.divideBy).toFixed(4));
    for (const t of [p, ...(p.also || [])]) if (out[t.node]) out[t.node].inputs[t.input] = v;
    for (const t of p.set?.[String(v)] || []) if (out[t.node]) out[t.node].inputs[t.input] = t.value;
  }
  return out;
}

/** TTS engines want "[1] text": add the speaker tag when the user typed plain text. */
export function formatPrompt(manifest, text) {
  // Workflows with a built-in instruction (manifest promptDefault): an empty prompt uses it.
  if (manifest?.promptDefault && (typeof text !== 'string' || !text.trim())) text = manifest.promptDefault;
  const f = manifest?.promptFormat;
  if (!f || typeof text !== 'string' || !text.trim()) return text;
  if (f.unless && new RegExp(f.unless).test(text)) return text;
  return String(f.template || '{text}').replace('{text}', text.trim());
}

/** Model files a graph loads: [{ node, input, file, classType }]. */
export function modelRefs(workflow) {
  const out = [];
  for (const [id, n] of Object.entries(workflow || {})) {
    if (id.startsWith('_') || !n?.inputs) continue;
    for (const [k, v] of Object.entries(n.inputs)) if (typeof v === 'string' && MODEL_EXT.test(v)) out.push({ node: id, input: k, file: v, classType: n.class_type });
  }
  return out;
}

const norm = (s) => String(s).replace(/\\/g, '/');

/**
 * Is everything this graph needs present in ComfyUI right now?
 * @param info { objectInfo: {class: def}, models: {folder: [files]} } (live, from ComfyUI)
 * Returns { ok, missingNodes[], missingModels[{file, where}], reasons[] }.
 */
export function checkInstalled(workflow, info, files = []) {
  const oi = info?.objectInfo || {};
  const missingNodes = [], missingModels = [];
  for (const [id, n] of Object.entries(workflow || {})) {
    if (id.startsWith('_') || !n?.class_type) continue;
    if (!oi[n.class_type]) { if (!missingNodes.includes(n.class_type)) missingNodes.push(n.class_type); continue; }
    const spec = { ...(oi[n.class_type].input?.required || {}), ...(oi[n.class_type].input?.optional || {}) };
    for (const [k, v] of Object.entries(n.inputs)) {
      if (typeof v !== 'string' || !MODEL_EXT.test(v)) continue;
      const opts = comboOptions(spec[k]);
      if (opts && !opts.map(norm).includes(norm(v))) missingModels.push({ file: v, where: `${n.class_type}.${k}` });
    }
  }
  for (const f of files) {
    if (f.fsFolder) {
      const hit = info?.fsFiles?.[`${f.fsFolder}/${f.file}`];
      if (hit !== true) missingModels.push({ file: f.file, where: `models/${f.fsFolder}`, unverified: hit === undefined });
      continue;
    }
    const list = (info?.models?.[f.folder] || []).map(norm);
    if (!list.includes(norm(f.file))) missingModels.push({ file: f.file, where: `models/${f.folder}` });
  }
  const reasons = [];
  if (missingNodes.length) reasons.push(`missing custom node${missingNodes.length > 1 ? 's' : ''}: ${missingNodes.join(', ')}`);
  const unverified = missingModels.filter((m) => m.unverified), absent = missingModels.filter((m) => !m.unverified);
  if (absent.length) reasons.push(`needs download: ${[...new Set(absent.map((m) => m.file.split(/[\\/]/).pop()))].join(', ')}`);
  if (unverified.length) reasons.push(`cannot check ${unverified.length} model file(s) on a remote ComfyUI: ${unverified.map((m) => m.file).join(', ')}`);
  return { ok: !reasons.length, missingNodes, missingModels, reasons };
}

/** Options of a COMBO input spec in /object_info (old [[...]] or new ["COMBO", {options}]). */
export function comboOptions(spec) {
  if (!Array.isArray(spec)) return null;
  if (Array.isArray(spec[0])) return spec[0];
  if (spec[0] === 'COMBO' && Array.isArray(spec[1]?.options)) return spec[1].options;
  return null;
}

/**
 * VRAM fit of an estimate on this GPU, per memory profile.
 *   ok       estimate <= 85 % of usable VRAM
 *   tight    <= usable VRAM
 *   offload  more than VRAM but fits VRAM + spare system RAM: ComfyUI keeps part
 *            of the weights in RAM
 *   unavailable  not even that
 * usable = total - desktopReserveMB (Windows desktop + driver).
 * Only "unavailable" carries a label/reason: no warning labels or badges on
 * presets that run (tight / RAM offload are statuses only).
 */
export function vramFit({ estMB, gpuTotalMB, ramFreeMB, desktopReserveMB = 1200, ramReserveMB = 8192, profileId } = {}) {
  if (!estMB) return { status: 'ok', label: '' };
  if (!gpuTotalMB) return { status: 'unknown', label: 'GPU not detected' };
  const usable = gpuTotalMB - desktopReserveMB;
  const gb = (mb) => (mb / 1024).toFixed(1);
  const vramGb = Math.round(gpuTotalMB / 1024);
  if (estMB <= usable * 0.85) return { status: 'ok', label: '' };
  if (estMB <= usable) return { status: 'tight', label: '' };
  const spare = Math.max(0, (ramFreeMB ?? 0) - ramReserveMB);
  if (estMB <= usable + spare) return { status: 'offload', label: '' };
  return { status: 'unavailable', label: 'not enough memory', reason: `needs ~${gb(estMB)} GB; GPU ${vramGb} GB + free RAM is not enough` };
}

/** Availability of a preset = installed check + VRAM fit. */
export function presetAvailability(p, info, hw = {}, opts = {}) {
  if (!info?.objectInfo) return { status: 'unknown', label: 'ComfyUI offline', reason: 'ComfyUI is not reachable, so availability could not be checked' };
  const inst = checkInstalled(p.workflow, info, p.manifest.files);
  if (!inst.ok) {
    const dl = inst.missingModels.length && !inst.missingNodes.length;
    return { status: 'unavailable', label: dl ? 'needs download' : 'missing node', reason: inst.reasons.join('; '), missing: inst };
  }
  const est = p.manifest.vram?.measuredMB || p.manifest.vram?.estMB || 0;
  const fit = vramFit({ estMB: est, gpuTotalMB: hw.gpuTotalMB, ramFreeMB: hw.ramFreeMB, desktopReserveMB: opts.desktopReserveMB, ramReserveMB: opts.ramReserveMB, profileId: opts.profileId });
  return { ...fit, estMB: est };
}
