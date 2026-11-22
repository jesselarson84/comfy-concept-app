// node-view.js - ComfyUI's node graph inside the app (batch 4).
// -----------------------------------------------------------------------------
// The canvas button in the top bar toggles between the app's normal view and
// ComfyUI's own page (/comfy/, through this app's proxy, same origin) shown in
// an iframe under the top bar. The iframe is created on the first toggle and
// afterwards only hidden / shown, never unloaded: the graph, its undo history
// and its websocket survive, and ComfyUI's "Changes you made may not be saved"
// prompt never fires (that prompt is a beforeunload, and nothing unloads).
//
// Back (browser, Android back button / gesture): opening the node view pushes
// one history entry ({ nodeView: true }); Back pops it and returns to the
// normal view, the same pattern as the overlays (ui/overlay.js). The Android
// app's onBackPressed already calls WebView.goBack(), so no native change.
// While the node view is shown the workflow dropdown is greyed out.
// -----------------------------------------------------------------------------
import { h } from './dom.js';

export class NodeView {
  /** @param o.button  the top bar toggle  @param o.host  where the iframe goes  @param o.onChange(on) */
  constructor({ button, host, onChange, src = '/comfy/' }) {
    Object.assign(this, { button, host, onChange, src });
    this.frame = null;
    this.on = false;
    button.addEventListener('click', () => this.toggle());
    window.addEventListener('popstate', () => { if (this.on && history.state?.nodeView !== true && !history.state?.overlay) this.hide(true); });
  }

  toggle() { return this.on ? this.hide() : this.show(); }

  show() {
    if (this.on) return;
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
    if (history.state?.nodeView !== true) history.pushState({ nodeView: true }, '');
    this.onChange?.(true);
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
}
