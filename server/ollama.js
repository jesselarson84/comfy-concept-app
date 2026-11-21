// ollama.js - the Chat tab's link to a local Ollama (127.0.0.1:11434).
// -----------------------------------------------------------------------------
// WHY a proxy (same idea as ComfyUI): Ollama stays bound to localhost and is
// never exposed. The phone talks only to this app (through Tailscale HTTPS),
// and this app forwards a SMALL, allow-listed part of Ollama's API:
//
//   GET  /ollama/api/tags      installed models (the Chat model picker)
//   GET  /ollama/api/version   is it running?
//   GET  /ollama/api/ps        which models are loaded in (V)RAM
//   POST /ollama/api/show      model details; `capabilities` says "vision"
//   POST /ollama/api/chat      the conversation (streamed NDJSON, passed through)
//
// Everything else (pull, delete, create, copy, push, embed...) answers 403, so
// nobody in the tailnet can download or delete models through the app.
//
// GPU sharing: the 2080 Ti (11 GB) is shared with ComfyUI. Ollama keeps a model
// loaded for 5 minutes after the last chat by default. Before each ComfyUI
// batch the browser calls POST /api/ollama/unload, which asks Ollama which
// models are loaded (/api/ps) and sends each one `keep_alive: 0` - Ollama's
// documented way to unload a model right away. The next chat message simply
// loads it again (a few seconds).
// -----------------------------------------------------------------------------
import { createComfyProxy } from './proxy.js';

const ALLOW = new Map([
  ['/api/tags', 'GET'], ['/api/version', 'GET'], ['/api/ps', 'GET'],
  ['/api/show', 'POST'], ['/api/chat', 'POST'],
]);

export function createOllama(getUrl) {
  const proxy = createComfyProxy(getUrl, '/ollama', { label: 'Ollama' });

  /** Handle a request under /ollama/. Returns nothing; always answers. */
  function web(req, res) {
    const p = new URL(req.url, 'http://x').pathname.slice('/ollama'.length);
    const method = ALLOW.get(p);
    if (!method || (req.method !== method && !(method === 'GET' && req.method === 'HEAD'))) {
      res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ error: `Not allowed through the app: ${req.method} ${p}` }));
    }
    return proxy.web(req, res);
  }

  /** Unload every loaded model (keep_alive 0). Never throws. */
  async function unloadAll(timeoutMs = 4000) {
    const base = getUrl();
    try {
      const ps = await (await fetch(base + '/api/ps', { signal: AbortSignal.timeout(timeoutMs) })).json();
      const names = (ps.models || []).map((m) => m.name || m.model).filter(Boolean);
      const unloaded = [];
      for (const model of names) {
        // An empty generate with keep_alive 0 = "unload now" (Ollama FAQ).
        const r = await fetch(base + '/api/generate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, keep_alive: 0 }), signal: AbortSignal.timeout(timeoutMs),
        });
        await r.arrayBuffer().catch(() => {});
        if (r.ok) unloaded.push(model);
      }
      // Confirm with /api/ps that nothing is left in (V)RAM.
      let stillLoaded = [];
      try { stillLoaded = ((await (await fetch(base + '/api/ps', { signal: AbortSignal.timeout(timeoutMs) })).json()).models || []).map((m) => m.name || m.model); } catch {}
      return { ollama: true, loaded: names, unloaded, stillLoaded };
    } catch (e) {
      return { ollama: false, loaded: [], unloaded: [], detail: e.message };
    }
  }

  return { web, unloadAll };
}
