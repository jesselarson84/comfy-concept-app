// prompt-versions.js - Undo and a short version history for the prompt box.
// Every time the Chat applies a prompt (or you restore a version), the text
// that was in the box is pushed here first, so nothing typed is ever lost.
// Kept in localStorage (per device), newest last, at most 30.
import { h } from './dom.js';

const STORE = 'conceptPromptVersions.v1';
const MAX = 30;

export class PromptVersions {
  constructor(panel, container) {
    this.panel = panel;
    this.list = (() => { try { return JSON.parse(localStorage.getItem(STORE)) || []; } catch { return []; } })();
    this.undoBtn = h('button.link', { type: 'button', onclick: () => this.undo() }, '↶ Undo');
    this.undoBtn.id = 'prompt-undo';
    this.menu = h('div.versions-list');
    this.details = h('details.versions', {}, h('summary.link', {}, 'Versions'), this.menu);
    this.details.addEventListener('toggle', () => this.#paintMenu());
    this.root = h('div.prompt-tools', {}, this.undoBtn, this.details);
    container.replaceChildren(this.root);
    this.#paint();
  }

  #save() { localStorage.setItem(STORE, JSON.stringify(this.list.slice(-MAX))); }
  #paint() {
    this.undoBtn.hidden = !this.list.length;
    this.details.hidden = !this.list.length;
    this.details.querySelector('summary').textContent = `Versions (${this.list.length})`;
    if (this.details.open) this.#paintMenu();
  }
  #paintMenu() {
    this.menu.replaceChildren(...[...this.list].reverse().map((v, i) => h('button.version', { type: 'button', title: v.prompt, onclick: () => this.restore(this.list.length - 1 - i) },
      h('span.muted', {}, new Date(v.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + (v.source ? ` · ${v.source}` : '')), ' ', v.prompt.slice(0, 120) || '(empty)')));
  }
  current() { return { prompt: this.panel.state.prompt || '', negative: this.panel.state.negative || '' }; }

  /** Replace the prompt (and negative if given), remembering the old one. */
  apply(prompt, negative, source = 'chat') {
    const cur = this.current();
    if (prompt === cur.prompt && (negative == null || negative === cur.negative)) return false;
    this.list.push({ ...cur, at: Date.now(), source });
    this.list = this.list.slice(-MAX);
    this.#save();
    this.panel.setPrompt(prompt);
    if (negative != null) this.panel.setNegative(negative);
    this.#paint();
    return true;
  }

  undo() {
    const v = this.list.pop();
    if (!v) return false;
    this.#save();
    this.panel.setPrompt(v.prompt);
    this.panel.setNegative(v.negative);
    this.#paint();
    return true;
  }

  restore(i) {
    const v = this.list[i];
    if (v) this.apply(v.prompt, v.negative, 'restored');
  }
}
