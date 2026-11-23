// tagger.js - batch 9: History tags written in the background by a vision model
// (gemma3:4b in Ollama): genre, mood, palette, colours, setting, lighting, medium.
// -----------------------------------------------------------------------------
// The owner games on this PC with ComfyUI open, so tagging must never cause frame
// stutter. The rules, checked every `intervalMs` (20 s) BETWEEN items:
//   - ComfyUI has anything running or queued       -> paused
//   - GPU utilisation above `busyPercent` (30 %)   -> paused, and the model is
//     unloaded at once (a game, the chat ...); the quiet clock restarts. (This PC's
//     desktop alone sits around 10 %; games run far above 30 %.)
//   - only after `quietMs` (3 min) of a quiet GPU is ONE item tagged, then the
//     loop waits for the next tick and checks again.
// The tagger's own inference is never sampled (samples are taken only between
// items), and the model is loaded with a short keep_alive so its VRAM goes back
// within seconds. One item takes a couple of seconds on the GPU.
//
// What gets tagged: every History entry that is done and not deleted - pictures
// from ComfyUI's /view; 3D models and videos from a preview still the app
// uploads (POST /api/history/:id/preview, data/previews/<id>.img: the 3D tile
// still / a video's first frame). Audio is not tagged (it is found by prompt).
// Settings (on / off) live in data/tagger.json.
// -----------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';

export const TAG_GROUPS = ['genre', 'mood', 'palette', 'colors', 'setting', 'lighting', 'medium'];
const LIMITS = { genre: 3, mood: 3, palette: 2, colors: 5, setting: 2, lighting: 2, medium: 1 };
const MAX_FAILS = 3;

export const TAG_PROMPT = [
  'Tag this picture for a searchable image library.',
  'Answer with JSON only. Every tag is lower case, one or two words joined by a hyphen.',
  'genre: 1-3 (e.g. sci-fi, fantasy, sports, architecture, portrait, product, nature, abstract).',
  'mood: 1-3 (e.g. epic, calm, moody, playful, dramatic, eerie).',
  'palette: 1-2 colour schemes (e.g. cool-blues, warm-earth-tones, neon, monochrome, pastel, high-contrast).',
  'colors: 2-5 plain colour names that dominate (e.g. blue, orange, teal, black, gold).',
  'setting: 1-2 (e.g. interior, city-street, stadium, forest, space, studio).',
  'lighting: 1-2 (e.g. neon-lit, golden-hour, studio, overcast, night, dramatic).',
  'medium: exactly 1 of photograph, 3d-render, digital-paint, illustration, cartoon, pixel-art, sketch, mixed-media.',
].join('\n');

export const TAG_SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(TAG_GROUPS.map((g) => [g, { type: 'array', items: { type: 'string' } }])),
  required: TAG_GROUPS,
};

/** Model answer -> clean tags: lower case, hyphenated, short, no repeats, capped per group. */
export function normalizeTags(raw) {
  let o = raw;
  if (typeof raw === 'string') { try { o = JSON.parse(raw.replace(/^```(?:json)?|```$/g, '').trim()); } catch { return null; } }
  if (!o || typeof o !== 'object') return null;
  const out = {};
  for (const g of TAG_GROUPS) {
    const list = Array.isArray(o[g]) ? o[g] : typeof o[g] === 'string' ? [o[g]] : [];
    const seen = new Set();
    out[g] = list.map((t) => String(t).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, ''))
      .filter((t) => t && t.length <= 24 && !seen.has(t) && seen.add(t)).slice(0, LIMITS[g]);
  }
  return TAG_GROUPS.some((g) => out[g].length) ? out : null;
}

/** What the tagger looks at for an entry: { kind: 'image', image } | { kind: 'preview' } | null. */
export function tagSource(e, hasPreview) {
  if (!e || e.tags || (e.tagFails || 0) >= MAX_FAILS) return null;
  if (e.status === 'error' || e.status === 'cancelled') return null;
  if (e.images?.length) return { kind: 'image', image: e.images[0] };
  const f = e.files?.[0];
  if (!f) return null;
  const k = f.kind || (/\.(glb|gltf)$/i.test(f.filename) ? '3d' : /\.(mp4|webm|mov|mkv|gif)$/i.test(f.filename) ? 'video' : /\.(wav|mp3|flac|ogg|m4a|opus)$/i.test(f.filename) ? 'audio' : '');
  if (k === '3d' || k === 'video') return hasPreview ? { kind: 'preview' } : null;
  return null;
}

/** Entries that can be tagged at all (pictures, 3D, video; not audio). */
export function taggable(e) {
  if (e.images?.length) return true;
  const f = e.files?.[0];
  return !!f && !/\.(wav|mp3|flac|ogg|m4a|opus)$/i.test(f.filename) && f.kind !== 'audio';
}

/** nvidia-smi GPU utilisation in % (first GPU), or null when it can't be read. */
export async function readGpuUtil(run) {
  try { const n = Number(String(await run()).split(/\r?\n/)[0].trim()); return Number.isFinite(n) ? n : null; } catch { return null; }
}

export function createTagger({ history, dataDir, getComfyUrl, getOllamaUrl, gpuUtil, model = 'gemma3:4b', intervalMs = 20000, quietMs = 180000, busyPercent = 30, keepAlive = '20s', fetchImpl = fetch, now = () => Date.now(), log = () => {} }) {
  const settingsFile = path.join(dataDir, 'tagger.json');
  const previewsDir = path.join(dataDir, 'previews');
  let enabled = true;
  try { enabled = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).enabled !== false; } catch {}
  const state = { status: enabled ? 'waiting' : 'off', reason: '', quietSince: null, lastTagAt: null, running: false };
  let timer = null;

  const previewFile = (id) => path.join(previewsDir, `${id}.img`);
  const hasPreview = (id) => /^[\w-]+$/.test(id) && fs.existsSync(previewFile(id));

  async function savePreview(id, buf) {
    if (!/^[\w-]+$/.test(id) || !history.get(id)) { const e = new Error('No such entry'); e.status = 404; throw e; }
    await fs.promises.mkdir(previewsDir, { recursive: true });
    await fs.promises.writeFile(previewFile(id), buf);
    return { ok: true };
  }
  async function dropPreviews(ids) { for (const id of ids) if (/^[\w-]+$/.test(id)) await fs.promises.rm(previewFile(id), { force: true }); }

  function counts() {
    const all = history.data.entries.filter((e) => e.status !== 'error' && e.status !== 'cancelled' && (e.images?.length || e.files?.length) && taggable(e));
    return { tagged: all.filter((e) => e.tags).length, total: all.length };
  }
  const next = () => history.data.entries.slice().reverse().map((e) => ({ e, src: tagSource(e, hasPreview(e.id)) })).find((x) => x.src);

  function status() { return { enabled, status: state.status, reason: state.reason, model, ...counts() }; }

  async function setEnabled(on) {
    enabled = !!on;
    await fs.promises.mkdir(dataDir, { recursive: true });
    await fs.promises.writeFile(settingsFile, JSON.stringify({ enabled }, null, 1));
    state.status = enabled ? 'waiting' : 'off'; state.reason = ''; state.quietSince = null;
    if (!enabled) unload();
    return status();
  }

  async function comfyBusy() {
    try {
      const q = await (await fetchImpl(getComfyUrl() + '/queue', { signal: AbortSignal.timeout(3000) })).json();
      return (q.queue_running?.length || 0) + (q.queue_pending?.length || 0) > 0;
    } catch { return true; } // ComfyUI unreachable: don't guess, wait
  }

  function unload() {
    fetchImpl(getOllamaUrl() + '/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, keep_alive: 0 }), signal: AbortSignal.timeout(4000) })
      .then((r) => r.arrayBuffer()).catch(() => {});
  }

  async function imageBytes(e, src) {
    if (src.kind === 'preview') return fs.promises.readFile(previewFile(e.id));
    const i = src.image;
    const q = new URLSearchParams({ filename: i.filename, subfolder: i.subfolder || '', type: i.type || 'output' });
    const r = await fetchImpl(`${getComfyUrl()}/view?${q}`, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw Object.assign(new Error(`ComfyUI /view ${r.status}`), { gone: r.status === 404 });
    return Buffer.from(await r.arrayBuffer());
  }

  async function tagOne(e, src) {
    const bytes = await imageBytes(e, src);
    const r = await fetchImpl(getOllamaUrl() + '/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120000),
      body: JSON.stringify({ model, prompt: TAG_PROMPT, images: [bytes.toString('base64')], format: TAG_SCHEMA, stream: false, keep_alive: keepAlive, options: { temperature: 0 } }),
    });
    if (!r.ok) throw new Error(`Ollama ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
    const tags = normalizeTags((await r.json()).response);
    if (!tags) throw new Error('the model gave no usable tags');
    return tags;
  }

  /** One check (and at most one item tagged). Returns the status. */
  async function tick() {
    if (state.running) return status();
    state.running = true;
    try {
      if (!enabled) { state.status = 'off'; state.reason = ''; return status(); }
      const item = next();
      if (!item) { state.status = 'done'; state.reason = ''; return status(); }
      if (await comfyBusy()) { state.status = 'paused'; state.reason = 'ComfyUI is working'; state.quietSince = null; return status(); }
      const util = await gpuUtil();
      if (util !== null && util > busyPercent) {
        if (state.status === 'tagging' || state.quietSince !== null) unload();
        state.status = 'paused'; state.reason = 'another program is using the GPU'; state.quietSince = null;
        return status();
      }
      const t = now();
      state.quietSince ??= t;
      if (t - state.quietSince < quietMs) { state.status = 'waiting'; state.reason = 'waiting for the GPU to stay quiet'; return status(); }
      state.status = 'tagging'; state.reason = '';
      try {
        const tags = await tagOne(item.e, item.src);
        await history.setTags(item.e.id, { ...tags, model, at: now() });
        state.lastTagAt = now();
      } catch (err) {
        log('tagger:', item.e.id, err.message);
        await history.tagFailed(item.e.id, err.gone ? MAX_FAILS : 1);
        if (/ollama|ECONNREFUSED|fetch failed/i.test(err.message)) { state.status = 'paused'; state.reason = 'Ollama is not answering'; state.quietSince = null; return status(); }
      }
      state.status = next() ? 'tagging' : 'done';
      return status();
    } finally { state.running = false; }
  }

  function start() { if (!timer) { timer = setInterval(() => tick().catch(() => {}), intervalMs); timer.unref?.(); } }
  function stop() { clearInterval(timer); timer = null; }

  return { tick, start, stop, status, setEnabled, savePreview, dropPreviews, hasPreview };
}
