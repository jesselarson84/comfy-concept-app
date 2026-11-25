// ollama.js - unloads the local Ollama's models (127.0.0.1:11434) to free VRAM.
// -----------------------------------------------------------------------------
// GPU sharing: the 2080 Ti (11 GB) is shared between ComfyUI and Ollama (the
// History tagger's gemma3:4b, server/tagger.js). Before each ComfyUI batch the
// memory profile (server/memory.js) may call unloadAll(), which asks Ollama
// which models are loaded (/api/ps) and sends each one `keep_alive: 0` -
// Ollama's documented way to unload a model right away.
// (Batch 15: the Prompt assistant and its /ollama/* proxy are gone.)
// -----------------------------------------------------------------------------

export function createOllama(getUrl) {
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

  return { unloadAll };
}
