// actions.js - ready-made workflow ACTIONS the Chat can offer (upscale, 3D...).
// Shared by the server (loads + validates workflows/actions/*.json) and the
// browser (resolves the model's choice, builds the graph to queue).
// -----------------------------------------------------------------------------
// An action file is { "action": <manifest>, "workflow": <API-format graph> }:
//   manifest = {
//     name, description,            shown to the model and on the confirm chip
//     output: "image" | "3d",
//     image: { node: "10" },        a LoadImage node whose title has #image
//     params: { <key>: { node, input, type: "number"|"int"|"enum",
//                        min, max, default, options, label, divideBy } }
//   }
// Params must point at LITERAL inputs (not links) of nodes tagged #expose or
// #image in the graph. The model can only pick an action id and param values;
// values are clamped to [min, max] (or reset to the default for a bad enum),
// and every adjustment is reported back so the chip can say so. The model
// never sends nodes or links: the graph always comes from the file.
// -----------------------------------------------------------------------------

/** Validate one action file. Returns { ok, id, manifest, workflow, error }. */
export function validateAction(id, file) {
  const fail = (error) => ({ ok: false, id, error });
  if (!file || typeof file !== 'object') return fail('not an object');
  const m = file.action, wf = file.workflow;
  if (!m || typeof m !== 'object') return fail('missing "action" manifest');
  if (!wf || typeof wf !== 'object' || !Object.keys(wf).length) return fail('missing "workflow" graph');
  for (const [k, n] of Object.entries(wf)) if (!k.startsWith('_') && (!n || typeof n.class_type !== 'string' || typeof n.inputs !== 'object')) return fail(`workflow node ${k} is not API format`);
  if (typeof m.name !== 'string' || !m.name.trim()) return fail('manifest needs a name');
  if (!['image', '3d'].includes(m.output || 'image')) return fail('output must be "image" or "3d"');
  const img = wf[m.image?.node];
  if (!img || img.class_type !== 'LoadImage') return fail('image.node must be a LoadImage node');
  if (!/#image\b/.test(img._meta?.title || '')) return fail('the image node title must contain #image');
  const params = {};
  for (const [key, p] of Object.entries(m.params || {})) {
    const n = wf[p?.node];
    if (!n) return fail(`param ${key}: node ${p?.node} not in workflow`);
    if (!/#expose\b/.test(n._meta?.title || '')) return fail(`param ${key}: node ${p.node} title must contain #expose`);
    if (!(p.input in n.inputs)) return fail(`param ${key}: input ${p.input} not on node ${p.node}`);
    if (Array.isArray(n.inputs[p.input])) return fail(`param ${key}: input ${p.input} is a link, not a value`);
    if (p.type === 'enum') {
      if (!Array.isArray(p.options) || !p.options.length) return fail(`param ${key}: enum needs options`);
      if (!p.options.includes(p.default)) return fail(`param ${key}: default not in options`);
    } else if (p.type === 'number' || p.type === 'int') {
      if (!(Number.isFinite(p.min) && Number.isFinite(p.max) && p.min <= p.max)) return fail(`param ${key}: needs min <= max`);
      if (!(p.default >= p.min && p.default <= p.max)) return fail(`param ${key}: default outside [min, max]`);
    } else return fail(`param ${key}: type must be number, int or enum`);
    params[key] = { ...p, label: p.label || key };
  }
  return { ok: true, id, manifest: { name: m.name.trim(), description: String(m.description || ''), output: m.output || 'image', image: { node: String(m.image.node) }, params, verb: m.verb || m.name, keywords: Array.isArray(m.keywords) ? m.keywords.map((k) => String(k).toLowerCase()) : [] }, workflow: wf };
}

/** Clamp/validate params. Returns { params, notes[] }. */
export function clampParams(manifest, given = {}) {
  const params = {}, notes = [];
  for (const [key, p] of Object.entries(manifest.params)) {
    let v = given?.[key];
    if (v === undefined || v === null || v === '') { params[key] = p.default; continue; }
    if (p.type === 'enum') {
      const hit = p.options.find((o) => String(o).toLowerCase() === String(v).toLowerCase());
      if (hit === undefined) { notes.push(`${p.label}: "${v}" is not an option, using ${p.default}`); params[key] = p.default; } else params[key] = hit;
      continue;
    }
    const num = Number(typeof v === 'string' ? v.replace(/x$/i, '') : v);
    if (!Number.isFinite(num)) { notes.push(`${p.label}: "${v}" is not a number, using ${p.default}`); params[key] = p.default; continue; }
    let c = Math.min(p.max, Math.max(p.min, num));
    if (p.type === 'int') c = Math.round(c);
    if (c !== num) notes.push(`${p.label}: ${num} is outside ${p.min}-${p.max}, using ${c}`);
    params[key] = c;
  }
  for (const k of Object.keys(given || {})) if (!(k in manifest.params)) notes.push(`ignored unknown setting "${k}"`);
  return { params, notes };
}

/**
 * Resolve the model's action choice.
 * @param choice   { action, params, image_ref } from parseReply
 * @param actions  [{ id, manifest }] (valid actions only)
 * @param images   { [ref]: imageObj } images the chat knows (img1, img2...)
 * @param fallbackRef  the last-discussed image ref
 * @param userText  what the user asked; if it names exactly one action by its
 *                  keywords and the model picked a different one, the user's
 *                  words win (small models mix up similar-looking options)
 * @returns { ok, action, params, notes, imageRef, image, error }
 */
export function resolveChoice(choice, actions, images = {}, fallbackRef = null, userText = '') {
  if (!choice?.action) return { ok: false, error: 'no action' };
  const want = String(choice.action).toLowerCase().trim();
  let a = actions.find((x) => x.id.toLowerCase() === want) || actions.find((x) => x.manifest.name.toLowerCase() === want);
  if (!a) return { ok: false, error: `Unknown action "${choice.action}". Available: ${actions.map((x) => x.id).join(', ') || 'none'}` };
  let given = choice.params;
  const text = String(userText || '').toLowerCase();
  const named = text ? actions.filter((x) => x.manifest.keywords?.some((k) => text.includes(k))) : [];
  // Small models sometimes attach an action nobody asked for (seen live: gemma3:4b
  // proposed image-to-3d on the very first 'make me a prompt' turn). Only offer an
  // action when the user's words name one (keywords, id or name).
  const mentions = (x) => text.includes(x.id.toLowerCase()) || text.includes(x.manifest.name.toLowerCase()) || x.manifest.keywords?.some((k) => text.includes(k));
  if (text && !actions.some(mentions)) return { ok: false, unasked: true, error: 'the model suggested an action you did not ask for (ignored)' };
  const preNotes = [];
  if (named.length === 1 && named[0] !== a) {
    preNotes.push(`you asked for ${named[0].manifest.name}, not ${a.manifest.name}`);
    a = named[0]; given = {};
    // Keep an explicit "3x" / "2.5x" from the user's words for a scale param.
    const mx = /(\d+(?:\.\d+)?)\s*x\b/.exec(text);
    if (mx && a.manifest.params.scale) given.scale = Number(mx[1]);
  }
  const { params, notes: n2 } = clampParams(a.manifest, given);
  const notes = [...preNotes, ...n2];
  let ref = choice.image_ref && images[choice.image_ref] ? choice.image_ref : null;
  if (!ref) {
    if (choice.image_ref) notes.push(`image "${choice.image_ref}" unknown, using the last discussed image`);
    ref = fallbackRef && images[fallbackRef] ? fallbackRef : null;
  }
  if (!ref) return { ok: false, action: a, params, notes, error: 'No image to work on. Open an image and tap Discuss first.' };
  return { ok: true, action: a, params, notes, imageRef: ref, image: images[ref] };
}

/** Short human text for the confirm chip: "Upscale 2x with 4x-UltraSharp". */
export function describeChoice(r) {
  const m = r.action.manifest;
  const bits = Object.entries(r.params).map(([k, v]) => `${m.params[k].label} ${v}`);
  return `${m.verb}${bits.length ? ' (' + bits.join(', ') + ')' : ''}`;
}

/**
 * Build the graph to queue: copy of the action workflow with the image wired
 * into the #image LoadImage node, params written (divideBy applied), app-only
 * keys dropped and Save prefixes put under the app's output subfolder.
 * @param inputName  LoadImage value (a file in ComfyUI's input/ folder)
 */
export function buildActionGraph(action, params, inputName, outputPrefix = '') {
  const out = structuredClone(action.workflow);
  for (const k of Object.keys(out)) if (k.startsWith('_')) delete out[k];
  out[action.manifest.image.node].inputs.image = inputName;
  for (const [key, p] of Object.entries(action.manifest.params)) {
    let v = params[key] ?? p.default;
    if (p.divideBy) v = Number((v / p.divideBy).toFixed(4));
    out[p.node].inputs[p.input] = v;
  }
  if (outputPrefix) {
    for (const n of Object.values(out)) {
      if ((n.class_type === 'SaveImage' || n.class_type === 'SaveGLB') && typeof n.inputs.filename_prefix === 'string') {
        n.inputs.filename_prefix = `${outputPrefix}/${n.inputs.filename_prefix.split('/').pop() || 'action'}`;
      }
    }
  }
  return out;
}

/** Text block listing actions for the model's system prompt. */
export function actionsForPrompt(actions) {
  if (!actions.length) return 'No workflow actions are available.';
  return actions.map((a) => {
    const ps = Object.entries(a.manifest.params).map(([k, p]) => p.type === 'enum' ? `${k}: one of ${p.options.join(' | ')} (default ${p.default})` : `${k}: ${p.type} ${p.min}-${p.max} (default ${p.default})`);
    return `- "${a.id}": ${a.manifest.description || a.manifest.name}${ps.length ? '. Params: ' + ps.join('; ') : ''}`;
  }).join('\n');
}
