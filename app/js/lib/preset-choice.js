// preset-choice.js - which preset the app opens on.
// -----------------------------------------------------------------------------
// Returning user: the preset they last picked (localStorage "preset", ids of
// the retired App presets mapped by legacy-presets.js), even if it is
// unavailable right now - the panel then says why.
// Fresh client (nothing saved, or the saved preset no longer exists):
//   1. FLUX.2 Klein 4B Text to Image when it is available;
//   2. otherwise the first AVAILABLE AI Workflow entry, in list order;
//   3. otherwise Klein 4B T2I anyway (shown with its "unavailable" reason), or
//      the first AI Workflow entry;
//   never a My presets entry (saved or imported workflows).
// The automatic default is not written to localStorage: only a real pick is
// remembered, so a client that fell back while Klein was missing opens on
// Klein again once it is back.
// Shared by the browser (main.js) and the server (/api/workflows "default").
// -----------------------------------------------------------------------------
import { DEFAULT_PRESET, resolvePresetId } from './legacy-presets.js';

/** Ready to run: valid graph and not marked unavailable (unknown/offline still counts). */
export const isUsable = (w) => !!(w && w.ok && w.workflow && w.availability?.status !== 'unavailable');
/** An AI Workflow menu entry (workflows/ai/*.json), not My presets. */
export const isAiWorkflow = (w) => !!(w && typeof w.id === 'string' && w.id.startsWith('ai:') && !w.user && !w.folder);

/** The fresh-client default id (or null when there is no AI Workflow entry at all). */
export function defaultPreset(workflows) {
  const list = Array.isArray(workflows) ? workflows : [];
  const ai = list.filter(isAiWorkflow);
  const klein = ai.find((w) => w.id === DEFAULT_PRESET);
  if (isUsable(klein)) return klein.id;
  const firstOk = ai.find(isUsable);
  if (firstOk) return firstOk.id;
  return (klein || ai[0])?.id ?? null;
}

/**
 * @param workflows  the /api/workflows list
 * @param o.keep     id to stay on (the current preset during a reload), optional
 * @param o.saved    the remembered pick (localStorage "preset"), optional
 * @returns { id, source: 'keep' | 'saved' | 'default' }
 */
export function choosePreset(workflows, { keep, saved } = {}) {
  const list = Array.isArray(workflows) ? workflows : [];
  for (const [source, raw] of [['keep', keep], ['saved', saved]]) {
    if (!raw || typeof raw !== 'string') continue;
    const id = resolvePresetId(raw);
    if (list.some((w) => w.id === id && w.ok)) return { id, source };
  }
  return { id: defaultPreset(list), source: 'default' };
}
