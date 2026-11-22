// history-view.js - browse everything ever generated (from data/history.json
// on the PC, so it is the same on phone and tablet), grouped by session.
// Batch 3:
//   - Multi-select like Google Photos: long-press a tile to start, then tap to
//     add/remove; each date group has a select-all circle. The top bar turns
//     into  X · count · share · + (Favorites or a folder) · trash.
//   - Trash deletes the files from the PC after a confirm (server checks every
//     file is inside ComfyUI's output/concept-app folder).
//   - Folders screen: cover, name and count; Favorites first. Folders are labels.
//   - 3D tiles get real preview stills (ui/model-thumbs.js), rendered lazily.
import { h, toast } from './dom.js';
import { getHistory, deleteHistory, getFolders, createFolder, addToFolder, patchHistory } from '../api.js';
import { viewUrl } from '../comfy-client.js';
import { deleteThumb, thumbKey } from '../lib/thumb-cache.js';
import { fileLabel } from '../lib/outputs.js';
import { Overlay, overlayTop } from './overlay.js';
import { bridge, has, absoluteUrl } from '../native.js';

const LONG_PRESS_MS = 450;

export class HistoryView {
  /** openViewer(getItems, index) for pictures; openFile(file, meta) for 3D / audio / video. */
  constructor(openViewer, openFile, { modelThumbs } = {}) {
    this.openViewer = openViewer; this.openFile = openFile; this.modelThumbs = modelThumbs;
    this.favOnly = false;
    this.folder = null;          // { id, name } when showing one folder
    this.selected = new Set();   // history entry ids
    this.selecting = false;
    this.entries = new Map();    // id -> entry (current list)
    this.list = h('div.history-list');
    this.title = h('h2', {}, 'History');
    this.favBtn = h('button.btn', { type: 'button', onclick: () => { this.favOnly = !this.favOnly; this.folder = null; this.favBtn.classList.toggle('on', this.favOnly); this.load(); } }, '★ Favorites');
    this.foldersBtn = h('button.btn.icon', { type: 'button', 'aria-label': 'Folders', dataset: { act: 'folders' }, onclick: () => this.openFolders() }, h('i.i.i-folder'));
    this.normalBar = h('div.history-top', {}, h('button.icon-btn', { type: 'button', 'aria-label': 'Close', onclick: () => this.close() }, '✕'), this.title, h('span.spacer'), this.foldersBtn, this.favBtn);
    this.count = h('span.sel-count', {}, '0');
    this.selBar = h('div.history-top.sel-bar', { hidden: true },
      h('button.icon-btn', { type: 'button', 'aria-label': 'Cancel selection', dataset: { act: 'cancel-sel' }, onclick: () => this.endSelect() }, '✕'),
      this.count, h('span.spacer'),
      h('button.btn.icon', { type: 'button', 'aria-label': 'Share', dataset: { act: 'share' }, onclick: () => this.share() }, h('i.i.i-arrow-up')),
      h('button.btn.icon', { type: 'button', 'aria-label': 'Add to', dataset: { act: 'add' }, onclick: () => this.openAddTo() }, h('i.i.i-plus')),
      h('button.btn.icon', { type: 'button', 'aria-label': 'Delete', dataset: { act: 'delete' }, onclick: () => this.confirmDelete() }, h('i.i.i-trash-2')));
    this.root = h('div.history', { hidden: true, role: 'dialog' }, this.normalBar, this.selBar, this.list);
    document.body.append(this.root);
    this.folders = new FoldersScreen((f) => { this.folder = f; this.favOnly = f?.id === 'favorites'; if (this.favOnly) this.folder = null; this.favBtn.classList.toggle('on', this.favOnly); this.load(); });
    // Android back button / gesture: leaves selection first, then closes History.
    window.addEventListener('popstate', () => {
      if (this.root.hidden) return;
      if (this.selecting && !history.state?.historySel) { this.endSelect(true); return; }
      if (!history.state?.history) this.close(true);
    });
  }

  async open() {
    if (this.root.hidden) history.pushState({ history: true }, '');
    this.root.hidden = false;
    await this.load();
  }

  close(fromPop) {
    if (this.root.hidden) return;
    this.endSelect(true);
    this.root.hidden = true;
    if (!fromPop && history.state?.history) history.back();
  }

  // ---- selection ------------------------------------------------------------
  startSelect(id) {
    if (!this.selecting) { this.selecting = true; history.pushState({ history: true, historySel: true }, ''); }
    if (id) this.selected.add(id);
    this.paintSelection();
  }

  endSelect(fromPop) {
    if (!this.selecting) return;
    this.selecting = false; this.selected.clear();
    if (!fromPop && history.state?.historySel) history.back();
    this.paintSelection();
  }

  toggle(id) {
    if (this.selected.has(id)) this.selected.delete(id); else this.selected.add(id);
    if (!this.selected.size) { this.endSelect(); return; }
    this.paintSelection();
  }

  toggleGroup(ids) {
    const all = ids.every((id) => this.selected.has(id));
    if (!this.selecting) this.startSelect();
    for (const id of ids) if (all) this.selected.delete(id); else this.selected.add(id);
    if (!this.selected.size) { this.endSelect(); return; }
    this.paintSelection();
  }

  paintSelection() {
    this.root.classList.toggle('selecting', this.selecting);
    this.selBar.hidden = !this.selecting; this.normalBar.hidden = this.selecting;
    this.count.textContent = String(this.selected.size);
    for (const t of this.list.querySelectorAll('.thumb[data-id]')) {
      const on = this.selected.has(t.dataset.id);
      t.classList.toggle('selected', on); t.setAttribute('aria-pressed', String(on));
    }
    for (const g of this.list.querySelectorAll('.history-session')) {
      const ids = JSON.parse(g.dataset.ids || '[]');
      g.querySelector('.sel-all')?.classList.toggle('on', ids.length > 0 && ids.every((id) => this.selected.has(id)));
    }
  }

  /** Long-press starts selection; a tap opens (or toggles while selecting). */
  #press(el, id, open) {
    let timer = null, start = null, long = false;
    el.addEventListener('pointerdown', (e) => {
      long = false; start = { x: e.clientX, y: e.clientY };
      clearTimeout(timer);
      timer = setTimeout(() => { long = true; if (this.selecting) this.toggle(id); else this.startSelect(id); navigator.vibrate?.(15); }, LONG_PRESS_MS);
    });
    const cancel = () => clearTimeout(timer);
    el.addEventListener('pointermove', (e) => { if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel(); });
    el.addEventListener('pointerup', cancel); el.addEventListener('pointercancel', cancel); el.addEventListener('pointerleave', cancel);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('click', (e) => {
      e.preventDefault();
      if (long) { long = false; return; }
      if (this.selecting) this.toggle(id); else open();
    });
  }

  // ---- actions on the selection ----------------------------------------------
  selectedFiles() {
    return [...this.selected].map((id) => this.entries.get(id)).filter(Boolean).flatMap((e) => (e.images?.length ? e.images : e.files || []));
  }

  async share() {
    const files = this.selectedFiles();
    if (!files.length) return;
    if (has('shareImages')) {
      try { bridge().shareImages(JSON.stringify(files.map((f) => ({ url: absoluteUrl(viewUrl(f)), name: f.filename })))); } catch (e) { toast('Share failed: ' + e.message); }
      return;
    }
    if (files.length === 1 && has('shareImage')) { bridge().shareImage(absoluteUrl(viewUrl(files[0])), files[0].filename); return; }
    try {
      const blobs = await Promise.all(files.map(async (f) => { const r = await fetch(viewUrl(f)); if (!r.ok) throw new Error(`${f.filename} (${r.status})`); const b = await r.blob(); return new File([b], f.filename, { type: b.type || 'application/octet-stream' }); }));
      if (navigator.canShare?.({ files: blobs })) await navigator.share({ files: blobs });
      else toast('Sharing is not supported in this browser');
    } catch (e) { if (e.name !== 'AbortError') toast('Share failed: ' + e.message); }
  }

  async openAddTo() {
    const ids = [...this.selected];
    if (!ids.length) return;
    let data;
    try { data = await getFolders(); } catch (e) { toast(e.message); return; }
    const sheet = new Sheet();
    const done = async (fn, label) => { try { await fn(); toast(`Added ${ids.length} to ${label}`); sheet.close(); this.endSelect(); this.load(); } catch (e) { toast(e.message, 6000); } };
    const name = h('input.sheet-input', { type: 'text', maxlength: 60, 'aria-label': 'New folder' });
    sheet.open('Add to', [
      h('button.sheet-row', { type: 'button', dataset: { folder: 'favorites' }, onclick: () => done(() => Promise.all(ids.map((id) => patchHistory(id, { favorite: true }))), 'Favorites') }, h('span', {}, '★'), h('span', {}, 'Favorites')),
      ...data.folders.map((f) => h('button.sheet-row', { type: 'button', dataset: { folder: f.id }, onclick: () => done(() => addToFolder(f.id, ids), f.name) }, h('i.i.i-folder'), h('span', {}, f.name), h('span.muted', {}, String(f.count)))),
      h('form.sheet-new', { onsubmit: (e) => { e.preventDefault(); const n = name.value.trim(); if (n) done(async () => { const f = await createFolder(n); await addToFolder(f.id, ids); }, n); } },
        h('i.i.i-plus'), name, h('button.btn', { type: 'submit', dataset: { act: 'create' } }, 'Create')),
    ]);
  }

  async confirmDelete() {
    const ids = [...this.selected];
    if (!ids.length) return;
    const n = ids.length;
    const ok = await confirmDialog(`Delete ${n} ${n === 1 ? 'item' : 'items'} from the PC?`, 'Delete');
    if (!ok) return;
    const filesOf = new Map(ids.map((id) => [id, this.entries.get(id)?.files || []]));
    try {
      const r = await deleteHistory(ids);
      if (r.refused.length) toast(`Deleted ${r.deleted.length}; ${r.refused.length} not deleted: ${r.refused[0].reason}`, 8000);
      else toast(`Deleted ${r.deleted.length}`);
      for (const id of r.deleted) for (const f of filesOf.get(id) || []) deleteThumb(thumbKey(f));
    } catch (e) { toast(e.message, 8000); return; }
    this.endSelect();
    await this.load();
  }

  async openFolders() { await this.folders.open(); }

  // ---- list ----------------------------------------------------------------
  async load() {
    this.title.textContent = this.folder ? this.folder.name : this.favOnly ? 'Favorites' : 'History';
    this.list.replaceChildren(h('p.muted', {}, 'Loading…'));
    let sessions;
    try { sessions = await getHistory(this.favOnly, this.folder?.id); } catch (e) { this.list.replaceChildren(h('p.muted', {}, e.message)); return; }
    this.entries = new Map(sessions.flatMap((s) => s.entries.map((e) => [e.id, e])));
    for (const id of [...this.selected]) if (!this.entries.has(id)) this.selected.delete(id);
    if (!sessions.length) { this.list.replaceChildren(h('p.muted', {}, this.folder ? 'Empty folder.' : this.favOnly ? 'No favorites yet.' : 'Nothing generated yet.')); this.paintSelection(); return; }
    this.list.replaceChildren(...sessions.map((s) => {
      // Turn history entries into the same item shape the viewer uses.
      const items = s.entries.filter((e) => e.images.length).map((e) => ({
        key: e.id, historyId: e.id, image: e.images[0], favorite: e.favorite, status: 'done',
        meta: { prompt: e.prompt, negative: e.negative, seed: e.seed, workflow: e.workflow, legacyWorkflow: e.legacyWorkflow, width: e.width, height: e.height, strength: e.strength, reference: e.reference, action: e.action, parent: e.parent },
      }));
      // Non-image results (3D .glb, audio, video) open the 3D viewer / audio player / file sheet.
      const files = s.entries.filter((e) => !e.images.length && e.files?.length);
      const ids = [...items.map((i) => i.historyId), ...files.map((e) => e.id)];
      const when = new Date(s.startedAt);
      const check = () => h('span.sel-check', { 'aria-hidden': 'true' }, h('i.i.i-check'));
      const tiles = [
        ...items.map((it, i) => {
          const b = h('button.thumb.s-done', { type: 'button', dataset: { id: it.historyId }, title: it.meta.prompt },
            h('img', { src: viewUrl(it.image, { thumb: true }), loading: 'lazy', alt: '' }), h('span.thumb-label', {}, it.favorite ? '★' : ''), check());
          this.#press(b, it.historyId, () => this.openViewer(() => items, i));
          return b;
        }),
        ...files.map((e) => {
          const img = h('img', { alt: '', loading: 'lazy' });
          const b = h('button.thumb.s-done.is-file', { type: 'button', dataset: { id: e.id }, title: e.prompt }, img, h('span.thumb-label', {}, fileLabel(e.files[0])), check());
          if (this.modelThumbs && /\.(glb|gltf)$/i.test(e.files[0].filename || '')) this.modelThumbs.attach(b, img, e.files[0], e.parent?.image || sourceImage(e));
          else if (e.parent?.image) img.src = viewUrl(e.parent.image, { thumb: true });
          else img.hidden = true;
          this.#press(b, e.id, () => this.openFile?.(e.files[0], { prompt: e.prompt, seed: e.seed, workflow: e.workflow }));
          return b;
        }),
      ];
      return h('section.history-session', { dataset: { ids: JSON.stringify(ids) } },
        h('h3', {},
          h('button.sel-all', { type: 'button', 'aria-label': 'Select all', onclick: () => this.toggleGroup(ids) }, h('i.i.i-check')),
          h('span', {}, `${when.toLocaleDateString()} ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`),
          h('span.muted', {}, `  ${items.length} images${files.length ? `, ${files.length} files` : ''}`)),
        h('div.thumbs.grid', {}, tiles));
    }));
    this.paintSelection();
  }
}

/** The picture a 3D job started from (the reference in LoadImage), if known. */
function sourceImage(e) {
  const ref = e.reference && typeof e.reference === 'object' ? Object.values(e.reference).find((x) => typeof x === 'string' && x) : null;
  if (!ref) return null;
  const i = ref.lastIndexOf('/');
  return { filename: i >= 0 ? ref.slice(i + 1) : ref, subfolder: i >= 0 ? ref.slice(0, i) : '', type: 'input' };
}

/** Folders screen: Favorites + every folder as a card (cover, name, count). */
class FoldersScreen {
  constructor(onPick) {
    this.onPick = onPick;
    this.ov = new Overlay('folders', 'Folders');
    this.grid = h('div.folder-grid');
    this.ov.root.append(overlayTop('Folders', () => this.ov.close()), this.grid);
  }

  async open() {
    this.ov.show();
    this.grid.replaceChildren(h('p.muted', {}, 'Loading…'));
    let data;
    try { data = await getFolders(); } catch (e) { this.grid.replaceChildren(h('p.muted', {}, e.message)); return; }
    const card = (id, name, count, cover, pick) => h('button.folder-card', { type: 'button', dataset: { folder: id }, onclick: () => { this.ov.close(); setTimeout(() => pick(), 0); } },
      h('span.folder-cover', {}, cover && !/\.(glb|gltf|mp3|wav|flac|ogg|mp4|webm|mov|mkv)$/i.test(cover.filename) ? h('img', { src: viewUrl(cover, { thumb: true }), loading: 'lazy', alt: '' }) : h('i.i.i-folder')),
      h('span.folder-name', {}, name), h('span.folder-count', {}, String(count)));
    this.grid.replaceChildren(
      card('favorites', 'Favorites', data.favorites.count, data.favorites.cover, () => this.onPick({ id: 'favorites', name: 'Favorites' })),
      ...data.folders.map((f) => card(f.id, f.name, f.count, f.cover, () => this.onPick({ id: f.id, name: f.name }))));
  }
}

/** Bottom sheet for "Add to". */
class Sheet {
  open(title, rows) {
    this.scrim = h('div.sheet-scrim', { onclick: () => this.close() });
    this.el = h('div.sheet', { role: 'dialog', 'aria-label': title }, h('div.sheet-title', {}, title), ...rows);
    document.body.append(this.scrim, this.el);
    this.el.querySelector('input')?.addEventListener('keydown', (e) => e.stopPropagation());
  }
  close() { this.scrim?.remove(); this.el?.remove(); }
}

/** Confirm dialog; resolves true for the action, false for Cancel. */
export function confirmDialog(text, action) {
  return new Promise((resolve) => {
    const end = (v) => { scrim.remove(); box.remove(); resolve(v); };
    const scrim = h('div.sheet-scrim', { onclick: () => end(false) });
    const box = h('div.confirm', { role: 'alertdialog', 'aria-label': text },
      h('p', {}, text),
      h('div.confirm-actions', {}, h('button.btn', { type: 'button', dataset: { act: 'cancel' }, onclick: () => end(false) }, 'Cancel'), h('button.btn.danger', { type: 'button', dataset: { act: 'confirm' }, onclick: () => end(true) }, action)));
    document.body.append(scrim, box);
    box.querySelector('[data-act="cancel"]').focus();
  });
}
