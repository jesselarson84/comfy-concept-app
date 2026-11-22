// legacy-presets.js - the retired "App presets" and where they went.
// -----------------------------------------------------------------------------
// Before batch 1 the picker had two built-in folder presets: "Fast concept"
// (workflows/fast-concept.json, FLUX.2 klein txt2img) and "From reference
// image" (workflows/from-reference-image.json, klein img2img). They are gone;
// the same model now runs as the AI Workflow presets "FLUX.2 Klein 4B Text to
// Image" and "FLUX.2 Klein 4B Image Edit".
//
// Saved state still says "fast-concept" / "from-reference-image": the
// localStorage preset choice, history entries (workflow + reference
// {node: image}), chat images (preset). Nothing on disk is rewritten: every
// reader maps the old id when it reads it (migration on read), so old history,
// chats and settings keep working and the files stay exactly as they were.
// Shared by the browser and the server (no DOM, no Node APIs).
// -----------------------------------------------------------------------------

export const DEFAULT_PRESET = 'ai:klein-4b-t2i';

export const LEGACY_PRESETS = Object.freeze({
  'fast-concept': { to: 'ai:klein-4b-t2i', label: 'Fast concept', toLabel: 'FLUX.2 Klein 4B Text to Image' },
  'from-reference-image': { to: 'ai:klein-4b-edit', label: 'From reference image', toLabel: 'FLUX.2 Klein 4B Image Edit' },
});

export const isLegacyPreset = (id) => typeof id === 'string' && Object.hasOwn(LEGACY_PRESETS, id);

/** Old preset id -> current id; anything else is returned unchanged. */
export function resolvePresetId(id) {
  return isLegacyPreset(id) ? LEGACY_PRESETS[id].to : id;
}

/**
 * A label for a preset id as stored in old state ("fast-concept" or a current
 * id), using the loaded preset list when it can.
 * @param workflows  [{ id, label }] (optional)
 */
export function presetLabel(id, workflows = []) {
  if (!id || typeof id !== 'string') return '';
  const now = resolvePresetId(id);
  const w = Array.isArray(workflows) ? workflows.find((x) => x?.id === now) : null;
  if (isLegacyPreset(id)) return `${w?.label || LEGACY_PRESETS[id].toLabel} (was ${LEGACY_PRESETS[id].label})`;
  return w?.label || id;
}

/**
 * History "reference" ({ nodeId: imageName }) recorded for an old preset's
 * image slots, re-targeted to the image slots of the preset it now maps to.
 * Slots that still exist keep their node; the rest fill the free slots in
 * order. Extra references (more than the preset has slots) are dropped.
 * @param reference  { [node]: name } or anything else (ignored)
 * @param slots      [{ node }] the target preset's controls.images
 */
export function remapReference(reference, slots = []) {
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)) return {};
  const nodes = (Array.isArray(slots) ? slots : []).map((s) => String(s?.node ?? '')).filter(Boolean);
  const out = {};
  const rest = [];
  for (const [node, ref] of Object.entries(reference)) {
    if (typeof ref !== 'string' || !ref) continue;
    if (nodes.includes(node) && !(node in out)) out[node] = ref; else rest.push(ref);
  }
  for (const node of nodes) { if (!rest.length) break; if (!(node in out)) out[node] = rest.shift(); }
  return out;
}

/**
 * A history entry as the client should see it: workflow mapped to the current
 * preset, the original kept in legacyWorkflow. Returns a COPY (the stored
 * entry, and so data/history.json, is never changed).
 */
export function migrateHistoryEntry(e) {
  if (!e || typeof e !== 'object' || !isLegacyPreset(e.workflow)) return e;
  return { ...e, workflow: resolvePresetId(e.workflow), legacyWorkflow: e.workflow };
}
