// history-view.js - browse everything ever generated (from data/history.json
// on the PC, so it is the same on phone and tablet), grouped by session.
// Batch 3:
//   - Multi-select like Google Photos: long-press a tile to start, then tap to
//     add/remove; round check circles top-left on every tile; each date header
//     has a select-all circle on its right. The top bar turns into
//     X · count · ★ · move to project · share · trash · ⋮ (Select all,
//     Remove from Favorites). Batch 13: Folders (labels) are gone - projects
//     do that job; the old data/folders.json is left on the PC, unused.
//   - Tiles are grouped by day (Today, Yesterday, Sat, Jun 20).
//   - Trash deletes the files from the PC after a confirm (server checks every
//     file is inside ComfyUI's output/concept-app folder).
//   - 3D tiles get real preview stills (ui/model-thumbs.js), rendered lazily.
import { h, toast } from './dom.js';
import { getHistory, deleteHistory, patchHistory, getTagger, setTagger, uploadPreview } from '../api.js';
import { TYPES, DATES, entryType, entryTags, matches, isFiltering, statsOf, TYPE_COLORS, GROUP_COLORS, GROUP_LABELS, modelColor } from '../lib/history-filter.js';
import { viewUrl } from '../comfy-client.js';
import { deleteThumb, thumbKey } from '../lib/thumb-cache.js';
import { fileLabel } from '../lib/outputs.js';
import { bridge, has, absoluteUrl } from '../native.js';
import { loadProjects, projectsCache } from './projects.js';
import { claudeLogo } from './claude.js';

const LONG_PRESS_MS = 450;

export class HistoryView {
  /**
   * openViewer(getItems, index) for pictures; openFile(file, meta) for 3D / audio / video.
   * Batch 5: History is a top bar toggle like the node view. It lives in `host`
   * (under the top bar, which stays put); `button` shows the pressed state;
   * onChange(on) lets main hide the node view / picker.
   */
  constructor(openViewer, openFile, { modelThumbs, host, button, onChange, labelOf, onMove, onAskClaude, claudeOn } = {}) {
    this.openViewer = openViewer; this.openFile = openFile; this.modelThumbs = modelThumbs;
    // Batch 11: History is grouped by project by default ("By date" = the day groups).
    this.onMove = onMove;
    // Batch 16: Ask Claude about the selected pictures (numbered in tap order), only while Use Claude is on.
    this.onAskClaude = onAskClaude; this.claudeOn = claudeOn || (() => false);
    this.groupBy = localStorage.getItem('historyGroup') === 'date' ? 'date' : 'project';
    try { this.collapsed = new Set(JSON.parse(localStorage.getItem('historyCollapsed') || '[]')); } catch { this.collapsed = new Set(); }
    // Batch 9: model names for search / filters / stats (main.js knows the presets).
    this.labelOf = labelOf || ((id) => id);
    this.filter = { q: '', types: new Set(), models: new Set(), date: null, tags: new Set() };
    this.sessions = [];
    this.previewing = new Set(); // entries whose still is being made / sent
    this.host = host || document.body; this.button = button; this.onChange = onChange;
    this.favOnly = false;
    this.selected = new Set();   // history entry ids
    this.selecting = false;
    this.entries = new Map();    // id -> entry (current list)
    this.list = h('div.history-list');
    this.title = h('h2', {}, 'Files'); // batch 13: History is called Files
    this.favBtn = h('button.btn', { type: 'button', onclick: () => this.setView(null, !this.favOnly) }, '★ Favorites');
    // Inside Favorites: back to all of Files (Back does the same).
    this.backBtn = h('button.btn.icon.hist-back', { type: 'button', hidden: true, 'aria-label': 'All files', title: 'All files', dataset: { act: 'all-history' }, onclick: () => this.setView(null, false) }, h('i.i.i-chevron-left'));
    // No close button: the History toggle in the top bar (or Back) closes it.
    this.normalBar = h('div.history-top', {}, this.backBtn, this.title, h('span.spacer'), this.favBtn);
    this.count = h('span.sel-count', {}, '0');
    // Favorite: favorites the whole selection, or unfavorites it when it is all favorites already.
    this.selFavBtn = h('button.icon-btn.sel-fav', { type: 'button', 'aria-label': 'Favorite', dataset: { act: 'favorite' }, onclick: () => this.favoriteSelected() }, '☆');
    this.selBar = h('div.history-top.sel-bar', { hidden: true },
      h('button.icon-btn', { type: 'button', 'aria-label': 'Cancel selection', dataset: { act: 'cancel-sel' }, onclick: () => this.endSelect() }, '✕'),
      this.count, h('span.spacer'),
      this.claudeBtn = h('button.icon-btn.sel-claude', { type: 'button', 'aria-label': 'Ask Claude', title: 'Ask Claude', dataset: { act: 'ask-claude' }, hidden: true, onclick: () => this.askClaude() }, claudeLogo(18)),
      this.selFavBtn,
      h('button.icon-btn', { type: 'button', 'aria-label': 'Move to project', title: 'Move to project', dataset: { act: 'move' }, onclick: () => this.moveSelected() }, h('i.i.i-folder-input')),
      h('button.icon-btn', { type: 'button', 'aria-label': 'Share', dataset: { act: 'share' }, onclick: () => this.share() }, h('i.i.i-share-2')),
      h('button.icon-btn', { type: 'button', 'aria-label': 'Delete', dataset: { act: 'delete' }, onclick: () => this.confirmDelete() }, h('i.i.i-trash-2')));
    // Batch 17: no ⋮ here (it only held Select all; each group's circle selects the group,
    // and in Favorites the star removes the selection from Favorites).
    // Batch 9: search + filter chips, and the stats strip (tap to open).
    this.search = h('input.hsearch', { type: 'search', placeholder: 'Search prompts and tags', 'aria-label': 'Search Files', autocomplete: 'off', enterkeyhint: 'search',
      oninput: () => { this.filter.q = this.search.value; this.render(); } });
    this.chips = h('div.hfilters');
    // Batch 11: By project (default) / By date.
    const seg = (key, label) => h('button.hseg-btn', { type: 'button', dataset: { group: key }, 'aria-pressed': String(this.groupBy === key), onclick: () => {
      this.groupBy = key; localStorage.setItem('historyGroup', key);
      for (const b of this.groupSeg.children) b.setAttribute('aria-pressed', String(b.dataset.group === key));
      this.render();
    } }, label);
    this.groupSeg = h('div.hseg', { role: 'group', 'aria-label': 'Group Files' }, seg('project', 'By project'), seg('date', 'By date'));
    this.tools = h('div.history-tools', {}, h('label.hsearch-row', {}, h('i.i.i-search', { 'aria-hidden': 'true' }), this.search), this.groupSeg, this.chips);
    this.statsOpen = localStorage.getItem('historyStatsOpen') === '1';
    this.stats = h('div.hstats', { role: 'button', tabindex: 0, dataset: { act: 'stats' } });
    this.stats.addEventListener('click', (e) => { if (e.target.closest('button, .hswitch')) return; this.statsOpen = !this.statsOpen; localStorage.setItem('historyStatsOpen', this.statsOpen ? '1' : '0'); this.paintStats(); });
    this.root = h('div.history', { hidden: true }, this.normalBar, this.selBar, this.tools, this.stats, this.list);
    this.host.append(this.root);
    // Android back button / gesture: leaves selection first, then closes History.
    window.addEventListener('popstate', () => {
      if (this.root.hidden) return;
      if (this.selecting && !history.state?.historySel) { this.endSelect(true); return; }
      if (!history.state?.history) { this.close(true); return; }
      if (this.inSub && !history.state.historySub) this.setView(null, false, true);
    });
  }

  get on() { return !this.root.hidden; }
  /** Showing Favorites (not all of Files). */
  get inSub() { return this.favOnly; }

  /**
   * Switch between all of Files and Favorites. Going into Favorites adds one
   * Back entry ({ historySub }), so Back (or the arrow) returns to all of Files
   * before it closes Files. (The first argument was a folder before batch 13.)
   */
  setView(_unused, favOnly, fromPop = false) {
    const wasSub = this.inSub;
    this.favOnly = !!favOnly;
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
      // Opening Files always starts on all of it, not Favorites.
      this.favOnly = false; this.favBtn.classList.remove('on');
      this.#paintOn(true);
    }
    await this.load();
  }

  /** @param fromPop  Back already popped the entry (or another view took it over) */
  close(fromPop) {
    if (this.root.hidden) return;
    this.endSelect(true);
    this.#paintOn(false);
    // Pops this view's entries in one go (Favorites and a selection add one each).
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
    if (this.claudeBtn) this.claudeBtn.hidden = !(this.onAskClaude && this.claudeOn());
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
  /** Batch 16: the selected pictures, in the order they were tapped (a Set keeps insertion order). */
  askClaude() {
    const entries = [...this.selected].map((id) => this.entries.get(id)).filter((e) => e?.images?.length);
    if (!entries.length) { toast('Pick pictures first (3D / audio / video cannot be sent)'); return; }
    this.onAskClaude?.(entries.slice(0, 8));
  }

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

  /** Batch 11: the selection (and what was made from it) to another project; its Drive files move too. */
  async moveSelected() {
    const ids = [...this.selected];
    if (!ids.length || !this.onMove) return;
    if (await this.onMove(ids)) { this.endSelect(); await this.load(); }
  }

  async confirmDelete() {
    const ids = [...this.selected];
    if (!ids.length) return;
    const n = ids.length;
    const ok = await confirmDialog(`Delete ${n} ${n === 1 ? 'item' : 'items'} from the PC? ${n === 1 ? 'Its' : 'Their'} Drive ${n === 1 ? 'copy goes' : 'copies go'} to the Drive trash.`, 'Delete');
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

  // ---- list ----------------------------------------------------------------
  async load() {
    this.title.textContent = this.favOnly ? 'Favorites' : 'Files';
    this.backBtn.hidden = !this.inSub;
    this.list.replaceChildren(h('p.muted', {}, 'Loading…'));
    let sessions;
    // Batch 11: the projects (names, grouping folders) come along for the project groups.
    try { [sessions] = await Promise.all([getHistory(this.favOnly), loadProjects().catch(() => null)]); } catch (e) { this.list.replaceChildren(h('p.muted', {}, e.message)); return; }
    this.sessions = sessions;
    this.entries = new Map(sessions.flatMap((s) => s.entries.map((e) => [e.id, e])));
    for (const id of [...this.selected]) if (!this.entries.has(id)) this.selected.delete(id);
    this.refreshTagger();
    this.render();
    this.sendPreviews();
  }

  // ---- batch 9: search, filters, stats ----------------------------------------
  /** Everything in the current view (all / Favorites), newest first. */
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
    // Batch 12 (option C): color only where it means something - the type bar,
    // the model bars and a dot per kind of tag.
    const types = TYPES.filter((t) => TYPE_COLORS[t.key]);
    const typeBar = (cls) => h(`span.htbar${cls}`, { 'aria-hidden': 'true' }, ...types.filter((t) => s.byType[t.key]).map((t) => h('i', { style: `flex:${s.byType[t.key]};background:${TYPE_COLORS[t.key]}` })));
    if (!this.statsOpen) {
      this.stats.replaceChildren(h('span', {}, h('b', {}, String(s.total)), 'outputs'), h('span', {}, h('b', {}, String(s.today)), 'today'), h('span', {}, h('b', {}, String(s.month)), 'this month'), typeBar('.mini'), ch);
      return;
    }
    const max = Math.max(1, ...s.models.map((m) => m.n));
    const tg = this.taggerState;
    const tagLine = tg ? h('div.htagger', {},
      h('span.hdot', { dataset: { status: tg.status } }),
      h('span', {}, `${{ off: 'Tagging is off', done: 'All tagged', tagging: 'Tagging…', paused: `Tagging paused: ${tg.reason}`, waiting: 'Tagging waits for a quiet GPU' }[tg.status] || 'Tagging'} · ${tg.tagged} of ${tg.total} tagged`),
      h('label.hswitch', { title: 'Background tagging' }, h('input', { type: 'checkbox', checked: tg.enabled, 'aria-label': 'Background tagging', onchange: async (e) => { try { this.taggerState = await setTagger(e.target.checked); this.paintStats(); } catch (err) { toast(err.message, 6000); } } }), h('span'))) : null;
    const others = s.tags.filter((t) => t.group).slice(0, 16); // batch 13: no Colors section
    const groups = [...new Set(others.map((t) => t.group).filter((g) => GROUP_COLORS[g]))];
    const tagBtn = (t, mark) => h('button.htag', { type: 'button', dataset: { tag: t.tag }, onclick: () => this.searchTag(t.tag) }, mark, t.tag, h('em', {}, String(t.n)));
    this.stats.replaceChildren(...[
      h('div.hnums', {}, h('div', {}, h('b', {}, String(s.total)), h('span', {}, 'outputs')), h('div', {}, h('b', {}, String(s.today)), h('span', {}, 'today')), h('div', {}, h('b', {}, String(s.month)), h('span', {}, 'this month'))),
      h('div.hsec', {}, 'By type'), typeBar(''),
      h('div.hlegend', {}, ...types.map((t) => h(`span${s.byType[t.key] ? '' : '.zero'}`, {}, h('i.hsw', { style: `background:${s.byType[t.key] ? TYPE_COLORS[t.key] : 'var(--c-border)'}` }), `${t.label} ${s.byType[t.key] || 0}`))),
      s.models.length ? h('div.hsec', {}, 'Top models') : null,
      ...s.models.map((m) => h('button.hbar', { type: 'button', dataset: { model: m.id }, onclick: () => { this.filter.models = new Set([m.id]); this.render(); } }, h('span', {}, m.label), h('i', {}, h('b', { style: `width:${Math.round((m.n / max) * 100)}%;background:${modelColor(m.slot)}` })), h('span.n', {}, String(m.n)))),
      others.length ? h('div.hsec', {}, 'Tags') : null,
      others.length ? h('div.htags', {}, ...others.map((t) => tagBtn(t, GROUP_COLORS[t.group] ? h('i.hdot2', { style: `background:${GROUP_COLORS[t.group]}` }) : null))) : null,
      groups.length ? h('div.hlegend.hgroups', {}, ...groups.map((g) => h('span', {}, h('i.hdot2', { style: `background:${GROUP_COLORS[g]}` }), GROUP_LABELS[g]))) : null,
      tagLine, ch].filter(Boolean));
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
    if (!all.length) { this.list.replaceChildren(h('p.muted', {}, this.favOnly ? 'No favorites yet.' : 'Nothing generated yet.')); this.paintSelection(); return; }
    const filtering = isFiltering(this.filter);
    const shown = filtering ? all.filter((e) => matches(e, this.filter, { labelOf: this.labelOf })) : all;
    const head = filtering ? [h('div.hresults', {}, `${shown.length} ${shown.length === 1 ? 'result' : 'results'}`, h('button.link', { type: 'button', dataset: { act: 'clear-filters' }, onclick: () => this.clearFilters() }, 'Clear'))] : [];
    if (!shown.length) { this.list.replaceChildren(...head, h('p.muted', {}, 'Nothing matches.')); this.paintSelection(); return; }
    const body = this.groupBy === 'project'
      ? byProject(shown, projectsCache()).flatMap((b) => {
        const secs = b.projects.map((p) => this.#section(p.label, p.entries, { sub: p.sub, cls: p.id ? '' : '.unsorted', key: p.id || 'unsorted' }));
        if (!b.head) return secs;
        const key = `g:${b.head}`, closed = this.collapsed.has(key);
        const n = b.projects.reduce((a, p) => a + p.entries.length, 0);
        const hd = h('button.hgroup', { type: 'button', dataset: { group: b.head }, 'aria-expanded': String(!closed), onclick: () => {
          if (this.collapsed.has(key)) this.collapsed.delete(key); else this.collapsed.add(key);
          localStorage.setItem('historyCollapsed', JSON.stringify([...this.collapsed]));
          this.render();
        } }, h('i.i.i-folder'), h('span.hg-name', {}, b.head), h('span.hg-n', {}, `${b.projects.length} ${b.projects.length === 1 ? 'project' : 'projects'} · ${n}`), h(`i.i.${closed ? 'i-chevron-right' : 'i-chevron-down'}`));
        return [hd, ...(closed ? [] : secs)];
      })
      : byDay([{ entries: shown }]).map((s) => this.#section(s.label, s.entries));
    this.list.replaceChildren(...head, ...body);
    this.paintSelection();
  }

  /** One group of tiles (a day, or a project) with its header and select-all circle. */
  #section(label, entries, { sub = '', cls = '', key = '' } = {}) {
    {
      const s = { label, entries };
      // Turn history entries into the same item shape the viewer uses.
      const items = s.entries.filter((e) => e.images.length).map((e) => ({
        key: e.id, historyId: e.id, image: e.images[0], favorite: e.favorite, status: 'done', tags: [...new Set(entryTags(e))], at: e.createdAt,
        meta: { prompt: e.prompt, negative: e.negative, seed: e.seed, workflow: e.workflow, legacyWorkflow: e.legacyWorkflow, width: e.width, height: e.height, steps: e.steps, strength: e.strength, reference: e.reference, action: e.action, parent: e.parent, promptId: e.promptId },
        project: e.project ?? null, drive: driveInfo(e, projectsCache()), tagsBy: e.tags || null,
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
      return h(`section.history-session${cls}`, { dataset: { ids: JSON.stringify(ids), ...(key ? { project: key } : {}) } },
        h('h3', {},
          h('span.day', {}, s.label, sub ? h('small.proj-sub', {}, sub) : null), h('small.day-n', {}, String(s.entries.length)),
          h('button.sel-all', { type: 'button', 'aria-label': `Select all from ${s.label}`, onclick: () => this.toggleGroup(ids) }, h('i.i.i-check'))),
        h('div.thumbs.grid', {}, tiles));
    }
  }
}

/**
 * Batch 11: entries (newest first) grouped by project for History:
 * [{ head: 'Apps' | null, projects: [{ id, label, sub, entries }] }]
 * A grouping folder (Apps, GTA 6 Mods) gathers its projects under one header; a
 * project right in ACTIVE stands alone. Most recently used first; Unsorted (no
 * project, or a project no longer known) always last.
 */
export function byProject(entries, data, now = new Date()) {
  const known = new Map((data?.projects || []).map((p) => [p.id, p]));
  const per = new Map();
  for (const e of [...entries].sort((a, b) => b.createdAt - a.createdAt)) {
    const id = e.project && known.has(e.project) ? e.project : null;
    if (!per.has(id)) per.set(id, []);
    per.get(id).push(e);
  }
  const blocks = new Map();
  for (const [id, list] of per) {
    if (!id) continue;
    const p = known.get(id);
    const head = p.group.length ? p.group.join(' › ') : null;
    const key = head ? `g:${head}` : `p:${id}`;
    if (!blocks.has(key)) blocks.set(key, { head, latest: 0, projects: [] });
    const b = blocks.get(key);
    b.projects.push({ id, label: p.name, sub: `${dayLabel(new Date(list[0].createdAt), now)}${p.missing ? ' · folder not found on Drive' : ''}`, entries: list, latest: list[0].createdAt });
    b.latest = Math.max(b.latest, list[0].createdAt);
  }
  const out = [...blocks.values()].sort((a, b) => b.latest - a.latest);
  for (const b of out) b.projects.sort((x, y) => y.latest - x.latest);
  if (per.has(null)) out.push({ head: null, projects: [{ id: null, label: 'Unsorted', sub: `In ${data?.root || 'ACTIVE'}/__Comfy UI · select some to move them into a project`, entries: per.get(null) }] });
  return out;
}

/** Batch 11: where an entry's (first) output is filed on Drive, for the viewer's Details. */
export function driveInfo(e, data) {
  const f = e.images?.[0] || e.files?.[0];
  if (!f) return null;
  const rec = e.filed?.[`${f.subfolder || ''}/${f.filename}`];
  const root = data?.root || 'ACTIVE';
  const p = (id) => data?.projects.find((x) => x.id === id);
  const base = (id) => (id && p(id) ? `${root}/${[...p(id).group, p(id).name].join('/')}/__comfy outputs` : `${root}/__Comfy UI`);
  if (!rec) return { state: 'waiting', path: '' };
  if (rec.s === 'missing') return { state: 'missing', path: `${base(rec.p)}/${rec.f}` };
  if (rec.s === 'gone') return { state: 'gone', path: '' };
  if ((rec.p ?? null) !== (e.project ?? null)) return { state: 'moving', path: `${base(rec.p)}/${rec.f}` };
  return { state: 'ok', path: `${base(rec.p)}/${rec.f}` };
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

/** Bottom sheet. */
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
