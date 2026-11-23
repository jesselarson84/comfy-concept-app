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
import { getHistory, deleteHistory, getFolders, createFolder, addToFolder, removeFromFolder, patchHistory, getTagger, setTagger, uploadPreview } from '../api.js';
import { TYPES, DATES, entryType, entryTags, matches, isFiltering, statsOf, timeLabel } from '../lib/history-filter.js';
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
  constructor(openViewer, openFile, { modelThumbs, host, button, onChange, labelOf } = {}) {
    this.openViewer = openViewer; this.openFile = openFile; this.modelThumbs = modelThumbs;
    // Batch 9: model names for search / filters / stats (main.js knows the presets).
    this.labelOf = labelOf || ((id) => id);
    this.filter = { q: '', types: new Set(), models: new Set(), date: null, tags: new Set() };
    this.sessions = [];
    this.previewing = new Set(); // entries whose still is being made / sent
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
    this.backBtn = h('button.btn.icon.hist-back', { type: 'button', hidden: true, 'aria-label': 'All history', title: 'All history', dataset: { act: 'all-history' }, onclick: () => this.setView(null, false) }, h('i.i.i-chevron-left'));
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
    // Batch 9: search + filter chips, and the stats strip (tap to open).
    this.search = h('input.hsearch', { type: 'search', placeholder: 'Search prompts, tags, colours', 'aria-label': 'Search History', autocomplete: 'off', enterkeyhint: 'search',
      oninput: () => { this.filter.q = this.search.value; this.render(); } });
    this.chips = h('div.hfilters');
    this.tools = h('div.history-tools', {}, h('label.hsearch-row', {}, h('i.i.i-search', { 'aria-hidden': 'true' }), this.search), this.chips);
    this.statsOpen = localStorage.getItem('historyStatsOpen') === '1';
    this.stats = h('div.hstats', { role: 'button', tabindex: 0, dataset: { act: 'stats' } });
    this.stats.addEventListener('click', (e) => { if (e.target.closest('button, .hswitch')) return; this.statsOpen = !this.statsOpen; localStorage.setItem('historyStatsOpen', this.statsOpen ? '1' : '0'); this.paintStats(); });
    this.root = h('div.history', { hidden: true }, this.normalBar, this.selBar, this.tools, this.stats, this.list);
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
    // Batch 9: the tagging line in the stats strip stays current while History is open.
    clearInterval(this.tagTimer);
    if (on) this.tagTimer = setInterval(() => { if (!document.hidden) this.refreshTagger(); }, 10000);
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
    this.sessions = sessions;
    this.entries = new Map(sessions.flatMap((s) => s.entries.map((e) => [e.id, e])));
    for (const id of [...this.selected]) if (!this.entries.has(id)) this.selected.delete(id);
    this.refreshTagger();
    this.render();
    this.sendPreviews();
  }

  // ---- batch 9: search, filters, stats ----------------------------------------
  /** Everything in the current view (all / Favorites / a folder), newest first. */
  allEntries() { return this.sessions.flatMap((s) => s.entries).filter((e) => e.images?.length || e.files?.length).sort((a, b) => b.createdAt - a.createdAt); }

  /** History searched for one tag (a tag tapped in the viewer or the stats). */
  async searchTag(tag) {
    this.filter = { q: '', types: new Set(), models: new Set(), date: null, tags: new Set([tag]) };
    this.search.value = '';
    if (!this.on) await this.open(); else this.render();
  }

  clearFilters() { this.filter = { q: '', types: new Set(), models: new Set(), date: null, tags: new Set() }; this.search.value = ''; this.render(); }

  paintChips() {
    const f = this.filter;
    const chip = (label, act, on, onX) => h(`button.hchip${on ? '.on' : ''}`, { type: 'button', dataset: { act }, onclick: (e) => { if (on && e.target.closest('.x')) { onX(); this.render(); } else this.openFilters(act); } },
      label, on ? h('span.x', { 'aria-label': 'Remove' }, '✕') : h('i.i.i-chevron-down', { 'aria-hidden': 'true' }));
    const typeLabel = [...f.types].map((t) => TYPES.find((x) => x.key === t)?.label || t).join(', ');
    const modelLabel = f.models.size === 1 ? this.labelOf([...f.models][0]) : `${f.models.size} models`;
    const dateLabel = f.date ? (DATES.find((d) => d.key === f.date.key)?.label || `${f.date.from || '…'} – ${f.date.to || '…'}`) : '';
    this.chips.replaceChildren(
      chip(f.types.size ? typeLabel : 'Type', 'type', f.types.size > 0, () => f.types.clear()),
      chip(f.models.size ? modelLabel : 'Model', 'model', f.models.size > 0, () => f.models.clear()),
      chip(f.date ? dateLabel : 'Date', 'date', !!f.date, () => { f.date = null; }),
      ...[...f.tags].map((t) => chip(t, 'tags', true, () => f.tags.delete(t))),
      ...(f.tags.size ? [] : [h('button.hchip', { type: 'button', dataset: { act: 'tags' }, onclick: () => this.openFilters('tags') }, h('i.i.i-sliders-horizontal', { 'aria-hidden': 'true' }), 'Tags')]));
  }

  paintStats() {
    const all = this.allEntries();
    const s = statsOf(all, { labelOf: this.labelOf });
    this.stats.classList.toggle('open', this.statsOpen);
    this.stats.setAttribute('aria-expanded', String(this.statsOpen));
    this.stats.hidden = !all.length;
    const ch = h('i.i.i-chevron-down.hstats-ch', { 'aria-hidden': 'true' });
    if (!this.statsOpen) {
      this.stats.replaceChildren(h('span', {}, h('b', {}, String(s.total)), 'outputs'), h('span', {}, h('b', {}, String(s.today)), 'today'), h('span', {}, h('b', {}, String(s.month)), 'this month'), ch);
      return;
    }
    const types = TYPES.filter((t) => s.byType[t.key]).map((t) => `${s.byType[t.key]} ${t.label.toLowerCase()}`).join(', ');
    const max = Math.max(1, ...s.models.map((m) => m.n));
    const tg = this.taggerState;
    const tagLine = tg ? h('div.htagger', {},
      h('span.hdot', { dataset: { status: tg.status } }),
      h('span', {}, `${{ off: 'Tagging is off', done: 'All tagged', tagging: 'Tagging…', paused: `Tagging paused: ${tg.reason}`, waiting: 'Tagging waits for a quiet GPU' }[tg.status] || 'Tagging'} · ${tg.tagged} of ${tg.total} tagged`),
      h('label.hswitch', { title: 'Background tagging' }, h('input', { type: 'checkbox', checked: tg.enabled, 'aria-label': 'Background tagging', onchange: async (e) => { try { this.taggerState = await setTagger(e.target.checked); this.paintStats(); } catch (err) { toast(err.message, 6000); } } }), h('span'))) : null;
    this.stats.replaceChildren(
      h('div.hnums', {}, h('div', {}, h('b', {}, String(s.total)), h('span', {}, `outputs${types ? ` · ${types}` : ''}`)), h('div', {}, h('b', {}, String(s.today)), h('span', {}, 'today')), h('div', {}, h('b', {}, String(s.month)), h('span', {}, 'this month'))),
      s.models.length ? h('div.hsec', {}, 'Top models') : null,
      ...s.models.map((m) => h('button.hbar', { type: 'button', dataset: { model: m.id }, onclick: () => { this.filter.models = new Set([m.id]); this.render(); } }, h('span', {}, m.label), h('i', {}, h('b', { style: `width:${Math.round((m.n / max) * 100)}%` })), h('span.n', {}, String(m.n)))),
      s.tags.length ? h('div.hsec', {}, 'Tags') : null,
      s.tags.length ? h('div.htags', {}, ...s.tags.slice(0, 12).map((t) => h('button.htag', { type: 'button', dataset: { tag: t.tag }, onclick: () => this.searchTag(t.tag) }, t.tag, h('em', {}, String(t.n))))) : null,
      tagLine, ch);
  }

  async refreshTagger() {
    try { this.taggerState = await getTagger(); } catch { this.taggerState = null; }
    if (this.on) this.paintStats();
  }

  /** Filter sheet: Type, Model, Date, Tags; opens scrolled to the chip that was tapped. */
  openFilters(section = 'type') {
    const f = this.filter, s = statsOf(this.allEntries(), { labelOf: this.labelOf });
    const sheet = new Sheet();
    const pill = (label, on, click, data = {}) => h(`button.htag${on ? '.on' : ''}`, { type: 'button', dataset: data, onclick: (e) => { click(); e.currentTarget.classList.toggle('on'); count(); } }, label);
    const toggle = (set, v) => (set.has(v) ? set.delete(v) : set.add(v));
    const showBtn = h('button.btn.primary', { type: 'button', dataset: { act: 'show' }, onclick: () => { sheet.close(); this.render(); } });
    const count = () => { showBtn.textContent = `Show ${this.allEntries().filter((e) => matches(e, f, { labelOf: this.labelOf })).length}`; };
    const from = h('input.sheet-input', { type: 'date', value: f.date?.from || '', 'aria-label': 'From', onchange: () => { f.date = { from: from.value, to: to.value }; dateRow.querySelectorAll('.htag').forEach((b) => b.classList.remove('on')); count(); } });
    const to = h('input.sheet-input', { type: 'date', value: f.date?.to || '', 'aria-label': 'To', onchange: () => from.onchange() });
    const dateRow = h('div.htags', {}, ...DATES.map((d) => h(`button.htag${f.date?.key === d.key ? '.on' : ''}`, { type: 'button', dataset: { date: d.key }, onclick: (e) => {
      const on = f.date?.key === d.key; f.date = on ? null : { key: d.key };
      dateRow.querySelectorAll('.htag').forEach((b) => b.classList.remove('on')); if (!on) e.currentTarget.classList.add('on'); from.value = ''; to.value = ''; count();
    } }, d.label)));
    const sec = (key, title, ...body) => h('div.hf-sec', { dataset: { sec: key } }, h('div.hsec', {}, title), ...body);
    sheet.open('Filters', [
      sec('type', 'Type', h('div.htags', {}, ...TYPES.filter((t) => s.byType[t.key]).map((t) => pill(`${t.label} ${s.byType[t.key]}`, f.types.has(t.key), () => toggle(f.types, t.key), { type: t.key })))),
      sec('model', 'Model', h('div.htags', {}, ...s.allModels.map((m) => pill(`${m.label} ${m.n}`, f.models.has(m.id), () => toggle(f.models, m.id), { model: m.id })))),
      sec('date', 'Date', dateRow, h('div.hdates', {}, from, h('span.muted', {}, 'to'), to)),
      sec('tags', 'Tags', s.tags.length ? h('div.htags', {}, ...s.tags.slice(0, 60).map((t) => pill(`${t.tag} ${t.n}`, f.tags.has(t.tag), () => toggle(f.tags, t.tag), { tag: t.tag }))) : h('p.muted', {}, 'No tags yet: they are added in the background while the GPU is quiet.')),
      h('div.sp-actions.hf-actions', {}, h('button.btn', { type: 'button', dataset: { act: 'clear' }, onclick: () => { sheet.close(); this.clearFilters(); } }, 'Clear'), showBtn),
    ]);
    sheet.el.classList.add('filter-sheet');
    count();
    sheet.el.querySelector(`[data-sec="${section}"]`)?.scrollIntoView({ block: 'start' });
  }

  /**
   * Send the tagger a still for 3D models and videos, once: a 3D tile's still when
   * the tile renders it (ModelThumbs.onStill, lazy as before), a video's first frame.
   */
  async sendPreviews() {
    const need = (e) => e && !e.tags && !e.preview && !this.previewing.has(e.id);
    const send = async (e, blob) => { this.previewing.add(e.id); try { if (blob) { await uploadPreview(e.id, blob); e.preview = true; } } catch { /* the tagger skips it */ } };
    if (this.modelThumbs) {
      const byFile = new Map(this.allEntries().filter((e) => need(e) && entryType(e) === '3d').map((e) => [`${e.files[0].subfolder || ''}/${e.files[0].filename}`, e]));
      this.modelThumbs.onStill = (file, blob) => { const e = byFile.get(`${file.subfolder || ''}/${file.filename}`); if (need(e)) send(e, blob); };
    }
    for (const e of this.allEntries()) if (need(e) && entryType(e) === 'video') await send(e, await firstFrame(viewUrl(e.files[0])));
  }

  render() {
    this.paintChips();
    this.paintStats();
    const all = this.allEntries();
    if (!all.length) { this.list.replaceChildren(h('p.muted', {}, this.folder ? 'Empty folder.' : this.favOnly ? 'No favorites yet.' : 'Nothing generated yet.')); this.paintSelection(); return; }
    const filtering = isFiltering(this.filter);
    const shown = filtering ? all.filter((e) => matches(e, this.filter, { labelOf: this.labelOf })) : all;
    const head = filtering ? [h('div.hresults', {}, `${shown.length} ${shown.length === 1 ? 'result' : 'results'}`, h('button.link', { type: 'button', dataset: { act: 'clear-filters' }, onclick: () => this.clearFilters() }, 'Clear'))] : [];
    if (!shown.length) { this.list.replaceChildren(...head, h('p.muted', {}, 'Nothing matches.')); this.paintSelection(); return; }
    this.list.replaceChildren(...head, ...byDay([{ entries: shown }]).map((s) => {
      // Turn history entries into the same item shape the viewer uses.
      const items = s.entries.filter((e) => e.images.length).map((e) => ({
        key: e.id, historyId: e.id, image: e.images[0], favorite: e.favorite, status: 'done', tags: [...new Set(entryTags(e))], at: e.createdAt,
        meta: { prompt: e.prompt, negative: e.negative, seed: e.seed, workflow: e.workflow, legacyWorkflow: e.legacyWorkflow, width: e.width, height: e.height, strength: e.strength, reference: e.reference, action: e.action, parent: e.parent },
      }));
      // Non-image results (3D .glb, audio, video) open the 3D viewer / audio player / file sheet.
      const files = s.entries.filter((e) => !e.images.length && e.files?.length);
      const ids = [...items.map((i) => i.historyId), ...files.map((e) => e.id)];
      const check = () => h('span.sel-check', { 'aria-hidden': 'true' }, h('i.i.i-check'));
      const tiles = [
        ...items.map((it, i) => {
          const b = h('button.thumb.s-done', { type: 'button', dataset: { id: it.historyId }, title: it.meta.prompt },
            h('img', { src: viewUrl(it.image, { thumb: true }), loading: 'lazy', alt: '' }), h('span.thumb-label', {}, it.favorite ? '★' : ''), h('span.thumb-time', {}, timeLabel(it.at)), check());
          this.#press(b, it.historyId, () => this.openViewer(() => items, i));
          return b;
        }),
        ...files.map((e) => {
          const img = h('img', { alt: '', loading: 'lazy' });
          const b = h('button.thumb.s-done.is-file', { type: 'button', dataset: { id: e.id }, title: e.prompt }, img, h('span.thumb-label', {}, fileLabel(e.files[0])), h('span.thumb-time', {}, timeLabel(e.createdAt)), check());
          if (this.modelThumbs && /\.(glb|gltf)$/i.test(e.files[0].filename || '')) this.modelThumbs.attach(b, img, e.files[0], e.parent?.image || sourceImage(e));
          else if (e.parent?.image) img.src = viewUrl(e.parent.image, { thumb: true });
          else img.hidden = true;
          this.#press(b, e.id, () => this.openFile?.(e.files[0], { prompt: e.prompt, seed: e.seed, workflow: e.workflow }));
          return b;
        }),
      ];
      return h('section.history-session', { dataset: { ids: JSON.stringify(ids) } },
        h('h3', {},
          h('span.day', {}, s.label), h('small.day-n', {}, String(s.entries.length)),
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

/** Batch 9: a video's first frame as a JPEG (for the History tagger). */
export function firstFrame(url, maxSide = 768) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    let done = false;
    const end = (b) => { if (done) return; done = true; clearTimeout(t); v.removeAttribute('src'); v.load(); resolve(b); };
    const t = setTimeout(() => end(null), 15000);
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
    v.addEventListener('loadeddata', () => { v.currentTime = Math.min(0.1, (v.duration || 1) / 2); }, { once: true });
    v.addEventListener('seeked', () => {
      const k = Math.min(1, maxSide / Math.max(v.videoWidth || 1, v.videoHeight || 1));
      const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(v.videoWidth * k)); c.height = Math.max(1, Math.round(v.videoHeight * k));
      try { c.getContext('2d').drawImage(v, 0, 0, c.width, c.height); c.toBlob((b) => end(b), 'image/jpeg', 0.85); } catch { end(null); }
    }, { once: true });
    v.addEventListener('error', () => end(null), { once: true });
    v.src = url;
  });
}
