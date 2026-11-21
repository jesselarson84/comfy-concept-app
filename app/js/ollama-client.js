// ollama-client.js - calls to the local Ollama, always through THIS app's
// allow-listed proxy (/ollama/* -> 127.0.0.1:11434, see server/ollama.js).
// -----------------------------------------------------------------------------
// Ollama API flow used by the Chat panel:
//   GET  /api/tags   -> installed models for the picker
//   POST /api/show   -> { capabilities: [...,'vision'] } = can it see images?
//   GET  /api/ps     -> loaded models; if ours is not loaded, the first reply
//                       includes a cold load (25-40 s on the owner's PC)
//   POST /api/chat   -> { model, messages, format: <JSON schema>, stream: true }
//                       answers NDJSON lines {message:{content}, done}; with a
//                       schema in `format` the content pieces add up to JSON.
// -----------------------------------------------------------------------------
const BASE = '/ollama';

export class OllamaOffline extends Error {}

async function call(path, opts = {}) {
  let r;
  try { r = await fetch(BASE + path, opts); } catch (e) { throw new OllamaOffline('Ollama is not reachable'); }
  if (r.status === 502) throw new OllamaOffline('Ollama is not running on the PC (127.0.0.1:11434)');
  return r;
}

export async function listModels() {
  const r = await call('/api/tags');
  if (!r.ok) throw new Error(`Ollama /api/tags failed (${r.status})`);
  return ((await r.json()).models || []).map((m) => ({ name: m.name, size: m.size, details: m.details || {}, capabilities: m.capabilities }));
}

/** { vision: bool } from /api/show (falls back to the 'clip' family hint). */
export async function modelInfo(name) {
  const r = await call('/api/show', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: name }) });
  if (!r.ok) return { vision: false };
  const d = await r.json();
  const caps = d.capabilities || [];
  return { vision: caps.includes('vision') || (d.details?.families || []).includes('clip'), capabilities: caps };
}

export async function isLoaded(name) {
  try { const r = await call('/api/ps'); const d = await r.json(); return (d.models || []).some((m) => m.name === name || m.model === name); } catch { return false; }
}

/** True for Ollama errors that mean "not enough (V)RAM to load the model". */
export function isMemoryError(msg) {
  return /memory|out of memory|cudaMalloc|unable to allocate|insufficient|requires more system|runner process has terminated/i.test(String(msg || ''));
}

/**
 * Streamed chat. onChunk(textSoFar) is called for every piece.
 * Returns { content, stats }. Throws Error(message) on HTTP errors.
 */
export async function chat({ model, messages, format, options, keep_alive, signal, onChunk }) {
  const r = await call('/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ model, messages, format, options, keep_alive, stream: true }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    let msg = t; try { msg = JSON.parse(t).error || t; } catch {}
    throw Object.assign(new Error(msg || `Ollama chat failed (${r.status})`), { status: r.status });
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', content = '', stats = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.error) throw new Error(o.error);
      if (o.message?.content) { content += o.message.content; onChunk?.(content); }
      if (o.done) stats = o;
    }
  }
  if (buf.trim()) { try { const o = JSON.parse(buf); if (o.message?.content) content += o.message.content; if (o.done) stats = o; } catch {} }
  return { content, stats };
}

const post = async (url, body, ms = 10000) => {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(ms) });
  return r.json();
};

/** Before any ComfyUI queue: the server applies the memory profile (unload
 *  Ollama always on small GPUs, only when free VRAM is short on big ones). */
export async function prepareComfyQueue(workflow) {
  try { return await post('/api/memory/before-queue', { workflow }); } catch { return null; }
}

/** Before a chat turn: fit check (refuses models that would swap to disk) and,
 *  on small GPUs, ComfyUI /free when free VRAM is low. -> { ok, fit, message, keepAlive } */
export async function prepareChat(model) {
  try { return await post('/api/memory/before-chat', { model }, 15000); } catch { return { ok: true, fit: 'unknown' }; }
}

/** Fallback when Ollama cannot load for lack of VRAM: ComfyUI /free per the
 *  memory profile (an API call; ComfyUI keeps running). */
export async function freeComfyVram() {
  return post('/api/memory/free-for-chat', {});
}

/** Detected GPU/RAM, active profile, loaded models (with partial-offload badges), model fit. */
export async function memoryStatus(fresh = false) {
  const r = await fetch('/api/memory' + (fresh ? '?fresh=1' : ''), { signal: AbortSignal.timeout(10000) });
  return r.json();
}

/** Image URL -> base64 JPEG (longest side <= max) for messages[].images. */
export async function imageToBase64(url, max = 896) {
  const blob = await (await fetch(url)).blob();
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.9).split(',')[1];
}
