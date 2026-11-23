// node-view.js - ComfyUI's node graph inside the app (batch 4).
// -----------------------------------------------------------------------------
// The canvas button in the top bar toggles between the app's normal view and
// ComfyUI's own page (/comfy/, through this app's proxy, same origin) shown in
// an iframe under the top bar. The iframe is created on the first toggle and
// afterwards only hidden / shown, never unloaded: the graph, its undo history
// and its websocket survive, and ComfyUI's "Changes you made may not be saved"
// prompt never fires (that prompt is a beforeunload, and nothing unloads).
//
// Batch 5:
//   - It opens the SELECTED PRESET's graph (ComfyUI's app.loadApiJson, same
//     origin). The graph is loaded when you enter the node view after picking
//     a different preset; going in and out with the same preset keeps whatever
//     you changed on the canvas.
//   - The workflow dropdown is hidden meanwhile (CSS: body.node-view-on).
//   - History and the node view are one or the other: switching takes over the
//     other's Back entry (replaceState) instead of stacking a new one.
//
// Back (browser, Android back button / gesture): opening the node view pushes
// one history entry ({ nodeView: true }); Back pops it and returns to the
// normal view, the same pattern as the overlays (ui/overlay.js). The Android
// app's onBackPressed already calls WebView.goBack(), so no native change.
// -----------------------------------------------------------------------------
import { h, toast } from './dom.js';

/**
 * The API graph with plain numeric node ids (1, 2, 3 ...), links renumbered to
 * match; "_" keys dropped. Presets exported from subgraphs use ids like "75:68",
 * which ComfyUI's loadApiJson cannot link (found on the phone: widgets showed
 * NaN and links were lost).
 */
export function canvasIds(workflow) {
  const keys = Object.keys(workflow).filter((k) => !k.startsWith('_'));
  const map = new Map(keys.map((k, i) => [k, String(i + 1)]));
  const out = {};
  for (const k of keys) {
    const n = structuredClone(workflow[k]);
    for (const [name, v] of Object.entries(n.inputs || {})) {
      if (Array.isArray(v) && v.length === 2 && map.has(String(v[0])) && Number.isInteger(v[1])) n.inputs[name] = [map.get(String(v[0])), v[1]];
    }
    out[map.get(k)] = n;
  }
  return out;
}

export class NodeView {
  /**
   * @param o.button  the top bar toggle  @param o.host  where the iframe goes  @param o.onChange(on)
   * @param o.graph()  -> { id, label, workflow } of the selected preset (API format), or null
   * @param o.beforeShow()  async; lets main close History first
   */
  constructor({ button, host, onChange, graph, beforeShow, src = '/comfy/' }) {
    Object.assign(this, { button, host, onChange, graph, beforeShow, src });
    this.frame = null;
    this.on = false;
    this.loadedId = null; // preset whose graph the canvas shows
    button.addEventListener('click', () => this.toggle());
    window.addEventListener('popstate', () => { if (this.on && history.state?.nodeView !== true && !history.state?.overlay) this.hide(true); });
  }

  toggle() { return this.on ? this.hide() : this.show(); }

  async show() {
    if (this.on) return;
    let replace = false;
    if (this.beforeShow) { await this.beforeShow(); replace = history.state?.history === true; }
    if (!this.frame) {
      // allow: ComfyUI's copy / paste of nodes uses the clipboard.
      this.frame = h('iframe.node-frame', { src: this.src, title: 'ComfyUI node view', allow: 'clipboard-read; clipboard-write; fullscreen' });
      this.host.append(this.frame);
    }
    this.on = true;
    this.host.hidden = false;
    document.body.classList.add('node-view-on');
    this.button.setAttribute('aria-pressed', 'true');
    this.button.classList.add('on');
    // Coming from History: take over its Back entry.
    if (replace) history.replaceState({ nodeView: true }, '');
    else if (history.state?.nodeView !== true) history.pushState({ nodeView: true }, '');
    this.onChange?.(true);
    this.syncGraph();
  }

  hide(fromPop = false) {
    if (!this.on) return;
    this.on = false;
    this.host.hidden = true;
    document.body.classList.remove('node-view-on');
    this.button.setAttribute('aria-pressed', 'false');
    this.button.classList.remove('on');
    if (!fromPop && history.state?.nodeView === true) history.back();
    this.onChange?.(false);
  }

  /** Load the selected preset's graph unless the canvas already shows it. */
  async syncGraph() {
    const g = this.graph?.();
    if (!g || g.id === this.loadedId) return;
    const app = await this.#comfyApp();
    if (!app) { console.warn('node view: ComfyUI app not found, preset graph not loaded'); return; }
    if (!this.on && this.graph?.()?.id !== g.id) return; // the user moved on meanwhile
    try {
      const wf = canvasIds(g.workflow);
      const name = `${g.label}.json`;
      const load = async () => { await app.loadApiJson(structuredClone(wf), name); try { app.graph.arrange?.(); app.graph.setDirtyCanvas?.(true, true); } catch {} };
      await load();
      // Tested on the phone (batch 5): on the very first open ComfyUI can still
      // put its last tab back on top after we load. Make ours the active tab.
      await new Promise((r) => setTimeout(r, 400));
      const ws = app.extensionManager?.workflow;
      if (ws?.activeWorkflow && !String(ws.activeWorkflow.path || '').endsWith(name)) await load();
      this.loadedId = g.id;
    } catch (e) { toast('Could not open the preset graph: ' + e.message, 6000); }
  }

  /** ComfyUI's app object inside the iframe, once its frontend has started and restored its tabs (up to ~20 s). */
  async #comfyApp() {
    for (let i = 0; i < 80; i++) {
      try {
        const w = this.frame?.contentWindow;
        const app = w?.app || w?.comfyAPI?.app?.app;
        // tabsRestored: ComfyUI reopens the tabs from last time on start; loading
        // before that finishes would be covered by the restored tab.
        const restored = app?.extensionManager?.workflow?.tabsRestored;
        if (app?.graph && typeof app.loadApiJson === 'function' && restored !== false) return app;
      } catch { return null; } // not same origin
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  }
}
