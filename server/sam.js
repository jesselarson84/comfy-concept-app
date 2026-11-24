// sam.js - batch 14: "Select" in the mask editor. One tap on an object -> SAM 2.1
// (kijai's ComfyUI-segment-anything-2 nodes, model sam2.1_hiera_large) finds it
// and the mask comes back as a black/white PNG at the picture's size.
// The graph only previews (nothing is saved), so the PC sync never records it.
// -----------------------------------------------------------------------------
const MODEL = 'sam2.1_hiera_large.safetensors';
const err = (status, message) => Object.assign(new Error(message), { status });

/** The API graph for one selection. points: [{ x, y }] in picture pixels (positive), negative likewise. */
export function samGraph(image, points, negative = []) {
  const pts = (list) => JSON.stringify(list.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })));
  const g = {
    1: { class_type: 'LoadImage', inputs: { image } },
    2: { class_type: 'DownloadAndLoadSAM2Model', inputs: { model: MODEL, segmentor: 'single_image', device: 'cuda', precision: 'fp16' } },
    3: { class_type: 'Sam2Segmentation', inputs: { sam2_model: ['2', 0], image: ['1', 0], keep_model_loaded: false, coordinates_positive: pts(points), individual_objects: false } },
    4: { class_type: 'MaskToImage', inputs: { mask: ['3', 0] } },
    5: { class_type: 'PreviewImage', inputs: { images: ['4', 0] } },
  };
  if (negative.length) g[3].inputs.coordinates_negative = pts(negative);
  return g;
}

export function createSam({ getComfyUrl, fetchImpl = fetch, timeoutMs = 120000, pollMs = 400 }) {
  const comfy = async (p, opts = {}) => {
    const r = await fetchImpl(`${getComfyUrl()}${p}`, { signal: AbortSignal.timeout(15000), ...opts });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw err(502, j?.error?.message || `ComfyUI ${p} answered ${r.status}`); }
    return r;
  };
  /** -> PNG bytes (Buffer) of the mask (white = the object). */
  async function select({ image, points, negative = [] }) {
    if (typeof image !== 'string' || !image || image.includes('..')) throw err(400, 'Bad picture');
    const ok = (l) => Array.isArray(l) && l.every((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y) && p.x >= 0 && p.y >= 0);
    if (!ok(points) || !points.length || points.length > 20 || !ok(negative) || negative.length > 20) throw err(400, 'Tap on the picture first');
    const r = await comfy('/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: samGraph(image, points, negative), client_id: 'concept-sam' }) });
    const id = (await r.json()).prompt_id;
    if (!id) throw err(502, 'ComfyUI did not take the selection');
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      await new Promise((s) => setTimeout(s, pollMs));
      const h = (await (await comfy(`/history/${encodeURIComponent(id)}`)).json())[id];
      if (!h) continue;
      if (h.status?.status_str === 'error') {
        const m = (h.status.messages || []).find((x) => x?.[0] === 'execution_error')?.[1];
        throw err(502, `SAM 2: ${m?.exception_message || 'failed'}`);
      }
      if (!h.status?.completed) continue;
      const im = Object.values(h.outputs || {}).flatMap((o) => o.images || [])[0];
      if (!im) throw err(502, 'SAM 2 returned no mask');
      const q = new URLSearchParams({ filename: im.filename, subfolder: im.subfolder || '', type: im.type || 'temp' });
      return Buffer.from(await (await comfy(`/view?${q}`)).arrayBuffer());
    }
    throw err(504, 'SAM 2 took too long (is ComfyUI busy?)');
  }
  return { select };
}
