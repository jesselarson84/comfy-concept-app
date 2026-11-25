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
 * match; "_" keys dropped. Presets exported from subgraphs use ids like "75:68";
 * plain ids keep the canvas tidy and avoid any id parsing in loadApiJson.
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

/**
 * Batch 16: every node in view. Found on a Pixel 10 Pro (2026-11-24): with
 * Z-Image Turbo the canvas looked empty - ComfyUI's stats said "N: 10 [0]"
 * (10 nodes, none in view) at 90 % zoom - until ComfyUI's own fit-view button
 * was tapped. So after a graph is loaded or the node view is shown, do what
 * that button does (the Comfy.Canvas.FitView command); on frontends without the
 * command, fit the nodes' bounds into the canvas by hand (LiteGraph's
 * DragAndScale: screen = (pos + offset) * scale).
 */
export async function fitGraph(app) {
  const c = app?.canvas, nodes = app?.graph?._nodes || app?.graph?.nodes || [];
  if (!c || !nodes.length) return false;
  // let the canvas take its size first (it was hidden until now)
  await new Promise((r) => setTimeout(r, 60));
  try {
    const cmd = app.extensionManager?.command;
    if (cmd?.commands?.some?.((x) => x.id === 'Comfy.Canvas.FitView') || typeof cmd?.execute === 'function') {
      await cmd.execute('Comfy.Canvas.FitView');
      if (!c.ds || graphVisible(app)) return true;
    }
  } catch { /* fall back to doing it by hand */ }
  const ds = c.ds;
  if (!ds?.offset) return false;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    const [x, y] = n.pos || [0, 0], [w, h] = n.size || [200, 100], title = 30; // title bar above pos
    x0 = Math.min(x0, x); y0 = Math.min(y0, y - title); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h);
  }
  const el = c.canvas || c.el;
  const cw = el?.clientWidth || el?.width || 800, ch = el?.clientHeight || el?.height || 600;
  const pad = 24, bw = Math.max(1, x1 - x0), bh = Math.max(1, y1 - y0);
  const scale = Math.max(0.1, Math.min(1, Math.min((cw - pad * 2) / bw, (ch - pad * 2) / bh)));
  ds.scale = scale;
  ds.offset[0] = cw / (2 * scale) - (x0 + bw / 2);
  ds.offset[1] = ch / (2 * scale) - (y0 + bh / 2);
  c.setDirty?.(true, true);
  app.graph.setDirtyCanvas?.(true, true);
  return true;
}

/** True when every node lies inside the visible canvas. */
export function graphVisible(app) {
  const c = app?.canvas, ds = c?.ds, el = c?.canvas || c?.el, nodes = app?.graph?._nodes || app?.graph?.nodes || [];
  if (!ds?.offset || !el) return true;
  const cw = el.clientWidth || el.width, ch = el.clientHeight || el.height;
  return nodes.every((n) => {
    const sx = (n.pos[0] + ds.offset[0]) * ds.scale, sy = (n.pos[1] + ds.offset[1]) * ds.scale;
    return sx >= 0 && sy >= 0 && sx + n.size[0] * ds.scale <= cw + 1 && sy + n.size[1] * ds.scale <= ch + 1;
  });
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

  /**
   * Make the canvas show the selected preset's graph. Kept as it is (with your
   * canvas edits) only while that preset's tab is still the active ComfyUI tab;
   * if you closed it or switched tabs inside ComfyUI, the preset is loaded again
   * (found on the phone: after closing the tab, coming back showed a blank canvas).
   */
  async syncGraph() {
    const g = this.graph?.();
    if (!g) return;
    const app = await this.#comfyApp();
    if (!app) { console.warn('node view: ComfyUI app not found, preset graph not loaded'); return; }
    if (!this.on && this.graph?.()?.id !== g.id) return; // the user moved on meanwhile
    const store = app.extensionManager?.workflow;
    const name = `${g.label}.json`;
    const esc = g.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const same = new RegExp(`(^|/)${esc}( \\(\\d+\\))?\\.json$`);
    const showing = () => same.test(String(store?.activeWorkflow?.path || ''));
    if (g.id === this.loadedId && (!store || showing())) { await fitGraph(app); return; }
    try {
      const wf = canvasIds(g.workflow);
      // Build the object inside the iframe: ComfyUI tells links from values with
      // `instanceof Array`, which is false for arrays made in this page (found on
      // the phone: every link became a NaN value and nothing was connected).
      const fw = this.frame.contentWindow;
      // One tab per preset: close earlier copies ("<label>.json", "<label> (2).json" ...)
      // instead of stacking a new numbered tab every time the app starts.
      for (const w of [...(store?.openWorkflows || [])]) if (same.test(w.path || '')) { try { await store.closeWorkflow(w); } catch {} }
      const load = async () => { await app.loadApiJson(fw.JSON.parse(JSON.stringify(wf)), name); try { app.graph.arrange?.(); app.graph.setDirtyCanvas?.(true, true); } catch {} };
      await load();
      // Tested on the phone (batch 5): on the very first open ComfyUI can still
      // put its last tab back on top after we load. Make ours the active tab.
      for (let i = 0; i < 3 && store; i++) {
        await new Promise((r) => setTimeout(r, 400));
        if (!store.activeWorkflow || showing()) break;
        await load();
      }
      this.loadedId = g.id;
      await fitGraph(app);
    } catch (e) { toast('Could not open the preset graph: ' + e.message, 6000); }
  }

  /** The graph on the canvas right now, API format (what "Queue" would send). */
  async currentGraph() {
    const app = await this.#comfyApp();
    if (!app || typeof app.graphToPrompt !== 'function') throw new Error('ComfyUI canvas is not ready');
    const { output } = await app.graphToPrompt();
    // Copy into this page (the iframe's objects stay there).
    return JSON.parse(JSON.stringify(output || {}));
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
