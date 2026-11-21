// history-view.js - browse everything ever generated (from data/history.json
// on the PC, so it is the same on phone and tablet), grouped by session.
import { h, toast } from './dom.js';
import { getHistory } from '../api.js';
import { viewUrl } from '../comfy-client.js';
import { fileLabel } from '../lib/outputs.js';

export class HistoryView {
  constructor(openViewer) {
    this.openViewer = openViewer;
    this.favOnly = false;
    this.list = h('div.history-list');
    this.favBtn = h('button.btn', { onclick: () => { this.favOnly = !this.favOnly; this.favBtn.classList.toggle('on', this.favOnly); this.load(); } }, '★ Favorites');
    this.root = h('div.history', { hidden: true, role: 'dialog' },
      h('div.history-top', {}, h('button.icon-btn', { 'aria-label': 'Close', onclick: () => this.close() }, '✕'), h('h2', {}, 'History'), h('span.spacer'), this.favBtn),
      this.list);
    document.body.append(this.root);
    // Android back button / gesture closes History instead of leaving the app.
    // A viewer opened on top pushes its own entry, so its Back lands back here
    // (state.history) and History stays open.
    window.addEventListener('popstate', () => { if (!this.root.hidden && !history.state?.history) this.close(true); });
  }

  async open() {
    if (this.root.hidden) history.pushState({ history: true }, '');
    this.root.hidden = false;
    await this.load();
  }

  close(fromPop) {
    if (this.root.hidden) return;
    this.root.hidden = true;
    if (!fromPop && history.state?.history) history.back();
  }

  async load() {
    this.list.replaceChildren(h('p.muted', {}, 'Loading…'));
    let sessions;
    try { sessions = await getHistory(this.favOnly); } catch (e) { this.list.replaceChildren(h('p.muted', {}, e.message)); return; }
    if (!sessions.length) { this.list.replaceChildren(h('p.muted', {}, this.favOnly ? 'No favorites yet.' : 'Nothing generated yet.')); return; }
    this.list.replaceChildren(...sessions.map((s) => {
      // Turn history entries into the same item shape the viewer uses.
      const items = s.entries.filter((e) => e.images.length).map((e) => ({
        key: e.id, historyId: e.id, image: e.images[0], favorite: e.favorite, status: 'done',
        meta: { prompt: e.prompt, negative: e.negative, seed: e.seed, workflow: e.workflow, width: e.width, height: e.height, strength: e.strength, reference: e.reference, action: e.action, parent: e.parent },
      }));
      // Non-image results (the 3D action's .glb) are download tiles.
      const files = s.entries.filter((e) => !e.images.length && e.files?.length);
      const when = new Date(s.startedAt);
      return h('section.history-session', {},
        h('h3', {}, `${when.toLocaleDateString()} ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, h('span.muted', {}, `  ${items.length} images${files.length ? `, ${files.length} files` : ''}`)),
        h('div.thumbs.grid', {}, items.map((it, i) => h('button.thumb.s-done', { onclick: () => this.openViewer(() => items, i), title: it.meta.prompt },
          h('img', { src: viewUrl(it.image, { thumb: true }), loading: 'lazy', alt: '' }), h('span.thumb-label', {}, it.favorite ? '★' : ''))),
          files.map((e) => h('a.thumb.s-done.is-file', { href: viewUrl(e.files[0]), download: e.files[0].filename, title: e.prompt },
            e.parent?.image ? h('img', { src: viewUrl(e.parent.image, { thumb: true }), loading: 'lazy', alt: '' }) : null, h('span.thumb-label', {}, fileLabel(e.files[0]))))));
    }));
  }
}
