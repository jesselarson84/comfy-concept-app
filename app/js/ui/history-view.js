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
// Batch 19: always grouped by project (projects collapsible, closed at first); a filter
// button in the search box with removable chips for active filters; Favorites is a
// filter (no ★ Favorites button); the stats' today / this month toggle.
import { h, toast } from './dom.js';
import { getHistory, deleteHistory, patchHistory, getTagger, setTagger, uploadPreview } from '../api.js';
import { TYPES, DATES, entryType, entryTags, matches, isFiltering, filterCount, inPeriod, statsOf, TYPE_COLORS, TYPE_KEY } from '../lib/history-filter.js';
import { viewUrl } from '../comfy-client.js';
import { deleteThumb, thumbKey } from '../lib/thumb-cache.js';
import { fileLabel } from '../lib/outputs.js';
import { bridge, has, absoluteUrl } from '../native.js';
import { loadProjects, projectsCache } from './projects.js';
import { claudeLogo } from './claude.js';

const LONG_PRESS_MS = 450;
/** No filters on: no search text, no Favorites, empty sets. */
const emptyFilter = () => ({ q: '', fav: false, types: new Set(), models: new Set(), date: null, tags: new Set() });

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
    // Batch 19: always grouped by project (the By project / By date toggle is gone).
    // Projects are collapsible and start collapsed (this app load); folder groups stay open.
    this.openProjects = new Set();
    // Batch 9: model names for search / filters / stats (main.js knows the presets).
    this.labelOf = labelOf || ((id) => id);
    this.filter = emptyFilter();
    // Batch 19: the stats' period toggle (By type, Top models, Tags); This month by default.
    this.statsPeriod = 'month';
    this.tagsOpen = false;
    this.sessions = [];
    this.previewing = new Set(); // entries whose still is being made / sent
    this.host = host || document.body; this.button = button; this.onChange = onChange;
    this.selected = new Set();   // history entry ids
    this.selecting = false;
    this.entries = new Map();    // id -> entry (current list)
    this.list = h('div.history-list');
    this.title = h('h2', {}, 'Files'); // batch 13: History is called Files
    // No close button: the Files toggle in the top bar (or Back) closes it.
    // Batch 19: no ★ Favorites button: Favorites is an option in the Filters box.
    this.normalBar = h('div.history-top', {}, this.title);
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
    // Batch 9: search and the stats strip (tap to open). Batch 19: the Type/Model/Date/Tags
    // chips are gone: a filter button sits inside the search box (with a count when filters
    // are on) and opens the Filters box; the active filters show as removable chips below.
    this.search = h('input.hsearch', { type: 'search', placeholder: 'Search prompts and tags', 'aria-label': 'Search Files', autocomplete: 'off', enterkeyhint: 'search',
      oninput: () => { this.filter.q = this.search.value; this.render(); } });
    this.filterN = h('span.hfilter-n', { hidden: true });
    this.filterBtn = h('button.hfilter-btn', { type: 'button', 'aria-label': 'Filters', title: 'Filters', dataset: { act: 'filters' }, onclick: (e) => { e.preventDefault(); this.openFilters(); } },
      h('i.i.i-funnel', { 'aria-hidden': 'true' }), this.filterN);
    this.chips = h('div.hfilters', { hidden: true });
    this.tools = h('div.history-tools', {}, h('div.hsearch-row', {}, h('i.i.i-search', { 'aria-hidden': 'true' }), this.search, this.filterBtn), this.chips);
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
    });
  }

  get on() { return !this.root.hidden; }

  toggle() { return this.on ? this.close() : this.open(); }

  /** @param o.replace  take over the current history entry (switching over from the node view) */
  async open({ replace = false } = {}) {
    if (this.root.hidden) {
      if (replace) history.replaceState({ history: true }, ''); else history.pushState({ history: true }, '');
      this.#paintOn(true);
    }
    await this.load();
  }

  /** @param fromPop  Back already popped the entry (or another view took it over) */
  close(fromPop) {
    if (this.root.hidden) return;
    this.endSelect(true);
    this.#paintOn(false);
    // Pops this view's entries in one go (a selection adds one).
    if (!fromPop && history.state?.history) history.go(-(1 + (history.state.historySel ? 1 : 0)));
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
    // Stay in selection mode; repaint the stars on the tiles (and drop them while the Favorites filter is on).
    if (this.filter.fav && !fav) { this.endSelect(); this.render(); return; }
    for (const t of this.list.querySelectorAll('.thumb[data-id]')) {
      const e = this.entries.get(t.dataset.id);
      const label = t.querySelector('.thumb-label');
      if (e && label && e.images?.length) label.textContent = e.favorite ? '★' : '';
    }
    this.paintSelection();
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
    this.list.replaceChildren(h('p.muted', {}, 'Loading…'));
    let sessions;
    // Batch 11: the projects (names, grouping folders) come along for the project groups.
    try { [sessions] = await Promise.all([getHistory(false), loadProjects().catch(() => null)]); } catch (e) { this.list.replaceChildren(h('p.muted', {}, e.message)); return; }
    this.sessions = sessions;
    this.entries = new Map(sessions.flatMap((s) => s.entries.map((e) => [e.id, e])));
    for (const id of [...this.selected]) if (!this.entries.has(id)) this.selected.delete(id);
    this.refreshTagger();
    this.render();
    this.sendPreviews();
  }

  // ---- batch 9: search, filters, stats ----------------------------------------
  /** Everything in Files, newest first. */
  allEntries() { return this.sessions.flatMap((s) => s.entries).filter((e) => e.images?.length || e.files?.length).sort((a, b) => b.createdAt - a.createdAt); }

  /** History searched for one tag (a tag tapped in the viewer or the stats). */
  async searchTag(tag) {
    this.filter = { ...emptyFilter(), tags: new Set([tag]) };
    this.search.value = '';
    if (!this.on) await this.open(); else this.render();
  }

  clearFilters() { this.filter = emptyFilter(); this.search.value = ''; this.render(); }

  /**
   * Batch 19: the filter button's count, and one small removable chip per active filter
   * (✕ removes it; tapping the chip opens the Filters box at its section). The row is
   * hidden when no filter is on.
   */
  paintChips() {
    const f = this.filter;
    const n = filterCount(f);
    this.filterN.hidden = !n; this.filterN.textContent = String(n);
    this.filterBtn.classList.toggle('on', n > 0);
    this.filterBtn.setAttribute('aria-label', n ? `Filters (${n} on)` : 'Filters');
    const chip = (label, sec, onX, data = {}) => h('button.hchip.on', { type: 'button', dataset: { act: sec, ...data }, onclick: (e) => { if (e.target.closest('.x')) { onX(); this.render(); } else this.openFilters(sec); } },
      h('span.hchip-t', {}, label), h('span.x', { 'aria-label': `Remove ${label}` }, '✕'));
    const dateLabel = f.date ? (DATES.find((d) => d.key === f.date.key)?.label || `${f.date.from || '…'} – ${f.date.to || '…'}`) : '';
    const chips = [
      f.fav ? chip('★ Favorites', 'fav', () => { f.fav = false; }) : null,
      ...[...f.types].map((t) => chip(TYPES.find((x) => x.key === t)?.label || t, 'type', () => f.types.delete(t), { type: t })),
      ...[...f.models].map((m) => chip(this.labelOf(m), 'model', () => f.models.delete(m), { model: m })),
      f.date ? chip(dateLabel, 'date', () => { f.date = null; }) : null,
      ...[...f.tags].map((t) => chip(t, 'tags', () => f.tags.delete(t), { tag: t })),
    ].filter(Boolean);
    this.chips.replaceChildren(...chips);
    this.chips.hidden = !chips.length;
  }

  paintStats() {
    const all = this.allEntries();
    const s = statsOf(all, { labelOf: this.labelOf });
    this.stats.classList.toggle('open', this.statsOpen);
    this.stats.setAttribute('aria-expanded', String(this.statsOpen));
    this.stats.hidden = !all.length;
    const ch = h('i.i.i-chevron-down.hstats-ch', { 'aria-hidden': 'true' });
    // Batch 19 (mockup v2): one color per type (key order Images, 3D, Video, Audio);
    // the bar only shows the types that were used.
    const typeBar = (cls, st) => h(`span.htbar${cls}`, { 'aria-hidden': 'true' }, ...TYPE_KEY.filter((k) => st.byType[k]).map((k) => h('i', { style: `flex:${st.byType[k]};background:${TYPE_COLORS[k]}` })));
    if (!this.statsOpen) {
      this.stats.replaceChildren(h('span', {}, h('b', {}, String(s.total)), 'outputs'), h('span', {}, h('b', {}, String(s.today)), 'today'), h('span', {}, h('b', {}, String(s.month)), 'this month'), typeBar('.mini', s), ch);
      return;
    }
    // Batch 19: today / this month is a two-way toggle for By type, Top models and Tags.
    // "outputs" stays the all-time count; the file list is not affected.
    const sp = statsOf(all.filter((e) => inPeriod(e, this.statsPeriod)), { labelOf: this.labelOf });
    const period = (key, n, label) => h(`button.hperiod${this.statsPeriod === key ? '.on' : ''}`, { type: 'button', role: 'radio', 'aria-checked': String(this.statsPeriod === key), dataset: { period: key },
      onclick: () => { if (this.statsPeriod !== key) { this.statsPeriod = key; this.paintStats(); } } }, h('b', {}, String(n)), h('span', {}, label));
    const max = Math.max(1, ...sp.models.map((m) => m.n));
    const tg = this.taggerState;
    const tagLine = tg ? h('div.htagger', {},
      h('span.hdot', { dataset: { status: tg.status } }),
      h('span', {}, `${{ off: 'Tagging is off', done: 'All tagged', tagging: 'Tagging…', paused: `Tagging paused: ${tg.reason}`, waiting: 'Tagging waits for a quiet GPU' }[tg.status] || 'Tagging'} · ${tg.tagged} of ${tg.total} tagged`),
      h('label.hswitch', { title: 'Background tagging' }, h('input', { type: 'checkbox', checked: tg.enabled, 'aria-label': 'Background tagging', onchange: async (e) => { try { this.taggerState = await setTagger(e.target.checked); this.paintStats(); } catch (err) { toast(err.message, 6000); } } }), h('span'))) : null;
    const tags = sp.tags.filter((t) => t.group); // batch 13: no Colors section
    // Batch 19: Tags starts collapsed ("TAGS · N ›"); tap the heading to open it. No colored dots.
    const tagsHead = h('button.hsec.hsec-btn', { type: 'button', 'aria-expanded': String(this.tagsOpen), dataset: { act: 'tags-toggle' }, onclick: () => { this.tagsOpen = !this.tagsOpen; this.paintStats(); } },
      `Tags · ${tags.length}`, h(`i.i.${this.tagsOpen ? 'i-chevron-down' : 'i-chevron-right'}`, { 'aria-hidden': 'true' }));
    this.stats.replaceChildren(...[
      h('div.hnums', {}, h('div', {}, h('b', {}, String(s.total)), h('span', {}, 'outputs')),
        h('div.hperiods', { role: 'radiogroup', 'aria-label': 'Stats period' }, period('today', s.today, 'today'), period('month', s.month, 'this month'))),
      h('div.hsec', {}, 'By type'), typeBar('', sp),
      // The key always shows all four types at full strength, with no numbers.
      h('div.hlegend', {}, ...TYPE_KEY.map((k) => h('span', { dataset: { type: k } }, h('i.hsw', { style: `background:${TYPE_COLORS[k]}` }), TYPES.find((t) => t.key === k)?.label || k))),
      sp.models.length ? h('div.hsec', {}, 'Top models') : null,
      // Each model's bar takes the color of the type it makes.
      ...sp.models.map((m) => h('button.hbar', { type: 'button', dataset: { model: m.id, type: m.type }, onclick: () => { this.filter.models = new Set([m.id]); this.render(); } }, h('span', {}, m.label), h('i', {}, h('b', { style: `width:${Math.round((m.n / max) * 100)}%;background:${TYPE_COLORS[m.type] || TYPE_COLORS.image}` })), h('span.n', {}, String(m.n)))),
      tags.length ? tagsHead : null,
      tags.length && this.tagsOpen ? h('div.htags', {}, ...tags.slice(0, 60).map((t) => h('button.htag', { type: 'button', dataset: { tag: t.tag }, onclick: () => this.searchTag(t.tag) }, t.tag, h('em', {}, String(t.n))))) : null,
      tagLine, ch].filter(Boolean));
  }

  async refreshTagger() {
    try { this.taggerState = await getTagger(); } catch { this.taggerState = null; }
    if (this.on) this.paintStats();
  }

  /** Filter sheet: Favorites (batch 19), Type, Model, Date, Tags; opens scrolled to the chip that was tapped. */
  openFilters(section = 'fav') {
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
    const favN = this.allEntries().filter((e) => e.favorite).length;
    sheet.open('Filters', [
      sec('fav', 'Favorites', h('div.htags', {}, pill(`★ Favorites ${favN}`, f.fav, () => { f.fav = !f.fav; }, { fav: '1' }))),
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
    if (!all.length) { this.list.replaceChildren(h('p.muted', {}, 'Nothing generated yet.')); this.paintSelection(); return; }
    const filtering = isFiltering(this.filter);
    const shown = filtering ? all.filter((e) => matches(e, this.filter, { labelOf: this.labelOf })) : all;
    const head = filtering ? [h('div.hresults', {}, `${shown.length} ${shown.length === 1 ? 'result' : 'results'}`, h('button.link', { type: 'button', dataset: { act: 'clear-filters' }, onclick: () => this.clearFilters() }, 'Clear'))] : [];
    if (!shown.length) { this.list.replaceChildren(...head, h('p.muted', {}, 'Nothing matches.')); this.paintSelection(); return; }
    // Batch 19: always by project. Folder groups (most recently used first) stay open;
    // the projects in them (also most recent first) are collapsible and start collapsed.
    const body = byProject(shown, projectsCache()).flatMap((b) => {
      const secs = b.projects.map((p) => this.#section(p.label, p.entries, { sub: p.sub, cls: p.id ? '' : '.unsorted', key: p.id || 'unsorted' }));
      if (!b.head) return secs;
      const n = b.projects.reduce((a, p) => a + p.entries.length, 0);
      const hd = h('div.hgroup', { dataset: { group: b.head } }, h('i.i.i-folder'), h('span.hg-name', {}, b.head), h('span.hg-n', {}, `${b.projects.length} ${b.projects.length === 1 ? 'project' : 'projects'} · ${n}`));
      return [hd, ...secs];
    });
    this.list.replaceChildren(...head, ...body);
    this.paintSelection();
  }

  /**
   * One project's tiles with its header and select-all circle. Batch 19: tapping the
   * header opens / closes it (closed at first); a closed project builds no tiles.
   */
  #section(label, entries, { sub = '', cls = '', key = '' } = {}) {
    {
      const open = this.openProjects.has(key);
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
      const tiles = !open ? [] : [
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
      const flip = () => { if (this.openProjects.has(key)) this.openProjects.delete(key); else this.openProjects.add(key); this.render(); };
      return h(`section.history-session${cls}${open ? '' : '.closed'}`, { dataset: { ids: JSON.stringify(ids), ...(key ? { project: key } : {}) } },
        h('h3', { role: 'button', tabindex: 0, 'aria-expanded': String(open), onclick: flip, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } } },
          h(`i.i.hp-ch.${open ? 'i-chevron-down' : 'i-chevron-right'}`, { 'aria-hidden': 'true' }),
          h('span.day', {}, s.label, sub ? h('small.proj-sub', {}, sub) : null), h('small.day-n', {}, String(s.entries.length)),
          h('button.sel-all', { type: 'button', 'aria-label': `Select all from ${s.label}`, onclick: (e) => { e.stopPropagation(); this.toggleGroup(ids); } }, h('i.i.i-check'))),
        open ? h('div.thumbs.grid', {}, tiles) : null);
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
