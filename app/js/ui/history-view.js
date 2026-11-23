// history-view.js - browse everything ever generated (from data/history.json
// on the PC, so it is the same on phone and tablet), grouped by session.
// Batch 3:
//   - Multi-select like Google Photos: long-press a tile to start, then tap to
//     add/remove; round check circles top-left on every tile; each date header
//     has a select-all circle on its right. The top bar turns into
//     X · count · share · + (Favorites or a folder) · trash · ⋮ (Select all,
//     Remove from this folder / from Favorites).
//   - Tiles are grouped by day (Today, Yesterday, Sat, Jun 20).
//   - Trash deletes the files from the PC after a confirm (server checks every
//     file is inside ComfyUI's output/concept-app folder).
//   - Folders screen: cover, name and count; Favorites first. Folders are labels.
//   - 3D tiles get real preview stills (ui/model-thumbs.js), rendered lazily.
import { h, toast } from './dom.js';
import { getHistory, deleteHistory, getFolders, createFolder, addToFolder, removeFromFolder, patchHistory } from '../api.js';
import { viewUrl } from '../comfy-client.js';
import { deleteThumb, thumbKey } from '../lib/thumb-cache.js';
import { fileLabel } from '../lib/outputs.js';
import { Overlay, overlayTop, afterBack } from './overlay.js';
import { bridge, has, absoluteUrl } from '../native.js';

const LONG_PRESS_MS = 450;

export class HistoryView {
  /**
   * openViewer(getItems, index) for pictures; openFile(file, meta) for 3D / audio / video.
   * Batch 5: History is a top bar toggle like the node view. It lives in `host`
   * (under the top bar, which stays put); `button` shows the pressed state;
   * onChange(on) lets main hide the node view / picker.
   */
  constructor(openViewer, openFile, { modelThumbs, host, button, onChange } = {}) {
    this.openViewer = openViewer; this.openFile = openFile; this.modelThumbs = modelThumbs;
    this.host = host || document.body; this.button = button; this.onChange = onChange;
    this.favOnly = false;
    this.folder = null;          // { id, name } when showing one folder
    this.selected = new Set();   // history entry ids
    this.selecting = false;
    this.entries = new Map();    // id -> entry (current list)
    this.list = h('div.history-list');
    this.title = h('h2', {}, 'History');
    this.favBtn = h('button.btn', { type: 'button', onclick: () => this.setView(null, !this.favOnly) }, '★ Favorites');
    // Inside a folder or Favorites: back to all of History (Back does the same).
    this.backBtn = h('button.icon-btn.hist-back', { type: 'button', hidden: true, 'aria-label': 'All history', title: 'All history', dataset: { act: 'all-history' }, onclick: () => this.setView(null, false) }, h('i.i.i-chevron-left'));
    this.foldersBtn = h('button.btn.icon', { type: 'button', 'aria-label': 'Folders', dataset: { act: 'folders' }, onclick: () => this.openFolders() }, h('i.i.i-folder'));
    // No close button: the History toggle in the top bar (or Back) closes it.
    this.normalBar = h('div.history-top', {}, this.backBtn, this.title, h('span.spacer'), this.foldersBtn, this.favBtn);
    this.count = h('span.sel-count', {}, '0');
    // Batch favourite: favourites the whole selection, or unfavourites it when it is all favourites already.
    this.selFavBtn = h('button.icon-btn.sel-fav', { type: 'button', 'aria-label': 'Favorite', dataset: { act: 'favorite' }, onclick: () => this.favoriteSelected() }, '☆');
    this.selBar = h('div.history-top.sel-bar', { hidden: true },
      h('button.icon-btn', { type: 'button', 'aria-label': 'Cancel selection', dataset: { act: 'cancel-sel' }, onclick: () => this.endSelect() }, '✕'),
      this.count, h('span.spacer'),
      this.selFavBtn,
      h('button.icon-btn', { type: 'button', 'aria-label': 'Share', dataset: { act: 'share' }, onclick: () => this.share() }, h('i.i.i-share-2')),
      h('button.icon-btn', { type: 'button', 'aria-label': 'Add to', dataset: { act: 'add' }, onclick: () => this.openAddTo() }, h('i.i.i-plus')),
      h('button.icon-btn', { type: 'button', 'aria-label': 'Delete', dataset: { act: 'delete' }, onclick: () => this.confirmDelete() }, h('i.i.i-trash-2')),
      h('button.icon-btn', { type: 'button', 'aria-label': 'More', dataset: { act: 'more' }, onclick: (e) => this.openMore(e.currentTarget) }, h('i.i.i-more-vertical')));
    this.root = h('div.history', { hidden: true }, this.normalBar, this.selBar, this.list);
    this.host.append(this.root);
    this.folders = new FoldersScreen((f) => (f?.id === 'favorites' ? this.setView(null, true) : this.setView(f, false)));
    // Android back button / gesture: leaves selection first, then closes History.
    window.addEventListener('popstate', () => {
      if (this.root.hidden) return;
      if (this.selecting && !history.state?.historySel) { this.endSelect(true); return; }
      if (!history.state?.history) { this.close(true); return; }
      if (this.inSub && !history.state.historySub) this.setView(null, false, true);
    });
  }

  get on() { return !this.root.hidden; }
  /** Showing one folder or Favorites (not all of History). */
  get inSub() { return !!(this.folder || this.favOnly); }

  /**
   * Switch between all of History, Favorites and one folder. Going from all of
   * History into a folder / Favorites adds one Back entry ({ historySub }), so
   * Back (or the arrow) returns to all of History before it closes History.
   */
  setView(folder, favOnly, fromPop = false) {
    const wasSub = this.inSub;
    this.folder = folder || null; this.favOnly = !!favOnly && !folder;
    this.favBtn.classList.toggle('on', this.favOnly);
    if (this.on && !fromPop) {
      if (this.inSub && !wasSub && !history.state?.historySub) history.pushState({ history: true, historySub: true }, '');
      else if (!this.inSub && wasSub && history.state?.historySub) history.back();
    }
    return this.load();
  }

  toggle() { return this.on ? this.close() : this.open(); }

  /** @param o.replace  take over the current history entry (switching over from the node view) */
  async open({ replace = false } = {}) {
    if (this.root.hidden) {
      if (replace) history.replaceState({ history: true }, ''); else history.pushState({ history: true }, '');
      // Opening History always starts on all of it, not the folder you left it in.
      this.folder = null; this.favOnly = false; this.favBtn.classList.remove('on');
      this.#paintOn(true);
    }
    await this.load();
  }

  /** @param fromPop  Back already popped the entry (or another view took it over) */
  close(fromPop) {
    if (this.root.hidden) return;
    this.endSelect(true);
    this.#paintOn(false);
    // Pops this view's entries in one go (a folder and a selection add one each).
    if (!fromPop && history.state?.history) history.go(-(1 + (history.state.historySub ? 1 : 0) + (history.state.historySel ? 1 : 0)));
  }

  #paintOn(on) {
    this.root.hidden = !on;
    if (this.host !== document.body) this.host.hidden = !on;
    document.body.classList.toggle('history-on', on);
    this.button?.setAttribute('aria-pressed', String(on));
    this.button?.classList.toggle('on', on);
    this.onChange?.(on);
  }

  /** Favourite every selected picture, or unfavourite them all when they all are already. */
  async favoriteSelected() {
    const ids = [...this.selected].filter((id) => this.entries.has(id));
    if (!ids.length) return;
    const fav = !ids.every((id) => this.entries.get(id).favorite);
    try { await Promise.all(ids.map((id) => patchHistory(id, { favorite: fav }))); } catch (e) { toast(e.message, 6000); }
    for (const id of ids) { const e = this.entries.get(id); if (e) e.favorite = fav; }
    toast(`${fav ? 'Added' : 'Removed'} ${ids.length} ${fav ? 'to' : 'from'} Favorites`);
    // Stay in selection mode; repaint the stars on the tiles (and drop them from the Favorites view).
    if (this.favOnly && !fav) { this.endSelect(); await this.load(); return; }
    for (const t of this.list.querySelectorAll('.thumb[data-id]')) {
      const e = this.entries.get(t.dataset.id);
      const label = t.querySelector('.thumb-label');
      if (e && label && e.images?.length) label.textContent = e.favorite ? '★' : '';
    }
    this.paintSelection();
  }

  // ---- selection ------------------------------------------------------------
  startSelect(id) {
    if (!this.selecting) { this.selecting = true; history.pushState({ history: true, historySub: !!history.state?.historySub, historySel: true }, ''); }
    if (id) this.selected.add(id);
    this.paintSelection();
  }

  endSelect(fromPop) {
    if (!this.selecting) return;
    this.selecting = false; this.selected.clear(); this.menu?.remove();
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
    const sel = [...this.selected].map((id) => this.entries.get(id)).filter(Boolean);
    const allFav = sel.length > 0 && sel.every((e) => e.favorite);
    this.selFavBtn.textContent = allFav ? '★' : '☆';
    this.selFavBtn.classList.toggle('on', allFav);
    this.selFavBtn.setAttribute('aria-label', allFav ? 'Remove from Favorites' : 'Add to Favorites');
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
    } catch (e) {
      toast(e.message, 8000);
    } finally {
      // Even after an error the server may have deleted part of the selection:
      // leave selection mode and show what is really there now.
      this.endSelect();
      await this.load();
    }
  }

  /** ⋮ menu on the selection bar. */
  openMore(anchor) {
    this.menu?.remove();
    const item = (act, label, fn) => h('button.sel-menu-item', { type: 'button', dataset: { act }, onclick: async () => { close(); await fn(); } }, label);
    const items = [item('select-all', 'Select all', () => { for (const g of this.list.querySelectorAll('.history-session')) for (const id of JSON.parse(g.dataset.ids || '[]')) this.selected.add(id); this.paintSelection(); })];
    if (this.folder) items.push(item('remove-folder', `Remove from ${this.folder.name}`, () => this.removeSelected(() => removeFromFolder(this.folder.id, [...this.selected]))));
    else if (this.favOnly) items.push(item('remove-fav', 'Remove from Favorites', () => this.removeSelected(() => Promise.all([...this.selected].map((id) => patchHistory(id, { favorite: false }))))));
    const scrim = h('div.sel-menu-scrim', { onclick: () => close() });
    const menu = h('div.sel-menu', { role: 'menu' }, ...items);
    const close = () => { scrim.remove(); menu.remove(); this.menu = null; };
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${Math.round(r.bottom + 4)}px`; menu.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
    document.body.append(scrim, menu);
    this.menu = { remove: close };
  }

  async removeSelected(fn) {
    try { await fn(); } catch (e) { toast(e.message, 6000); return; }
    this.endSelect();
    await this.load();
  }

  async openFolders() { await this.folders.open(); }

  // ---- list ----------------------------------------------------------------
  async load() {
    this.title.textContent = this.folder ? this.folder.name : this.favOnly ? 'Favorites' : 'History';
    this.backBtn.hidden = !this.inSub;
    this.list.replaceChildren(h('p.muted', {}, 'Loading…'));
    let sessions;
    try { sessions = await getHistory(this.favOnly, this.folder?.id); } catch (e) { this.list.replaceChildren(h('p.muted', {}, e.message)); return; }
    this.entries = new Map(sessions.flatMap((s) => s.entries.map((e) => [e.id, e])));
    for (const id of [...this.selected]) if (!this.entries.has(id)) this.selected.delete(id);
    if (!sessions.length) { this.list.replaceChildren(h('p.muted', {}, this.folder ? 'Empty folder.' : this.favOnly ? 'No favorites yet.' : 'Nothing generated yet.')); this.paintSelection(); return; }
    this.list.replaceChildren(...byDay(sessions).map((s) => {
      // Turn history entries into the same item shape the viewer uses.
      const items = s.entries.filter((e) => e.images.length).map((e) => ({
        key: e.id, historyId: e.id, image: e.images[0], favorite: e.favorite, status: 'done',
        meta: { prompt: e.prompt, negative: e.negative, seed: e.seed, workflow: e.workflow, legacyWorkflow: e.legacyWorkflow, width: e.width, height: e.height, strength: e.strength, reference: e.reference, action: e.action, parent: e.parent },
      }));
      // Non-image results (3D .glb, audio, video) open the 3D viewer / audio player / file sheet.
      const files = s.entries.filter((e) => !e.images.length && e.files?.length);
      const ids = [...items.map((i) => i.historyId), ...files.map((e) => e.id)];
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
          h('span.day', {}, s.label),
          h('button.sel-all', { type: 'button', 'aria-label': `Select all from ${s.label}`, onclick: () => this.toggleGroup(ids) }, h('i.i.i-check'))),
        h('div.thumbs.grid', {}, tiles));
    }));
    this.paintSelection();
  }
}

/** Sessions (newest first) regrouped by calendar day: [{ key, label, entries }]. */
export function byDay(sessions, now = new Date()) {
  const days = new Map();
  for (const e of sessions.flatMap((s) => s.entries).sort((a, b) => b.createdAt - a.createdAt)) {
    const d = new Date(e.createdAt), key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (!days.has(key)) days.set(key, { key, label: dayLabel(d, now), entries: [] });
    days.get(key).entries.push(e);
  }
  return [...days.values()];
}

/** Today / Yesterday / Sat, Jun 20 (with the year when it is not this year). */
export function dayLabel(d, now = new Date()) {
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(now) - start(d)) / 864e5);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  const o = { weekday: 'short', month: 'short', day: 'numeric' };
  if (d.getFullYear() !== now.getFullYear()) o.year = 'numeric';
  return d.toLocaleDateString('en-US', o);
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
    const card = (id, name, count, cover, pick) => h('button.folder-card', { type: 'button', dataset: { folder: id }, onclick: () => { this.ov.close(); afterBack().then(pick); } },
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
