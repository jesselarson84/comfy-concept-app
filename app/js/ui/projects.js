// projects.js - batch 11: the project chip on the form and the project sheet.
// Projects are folders under Creative/PROJECTS/ACTIVE on Google Drive (server
// projects.js); every output is filed into <project>/__comfy outputs/... and,
// with no project, into ACTIVE/__Comfy UI/... (Unsorted).
//
// One picker, three views (batch 19: a dropdown under the form's project button;
// the Files "Move N items to…" picker is still a bottom sheet):
//   list   - Recent projects (most recently used first), No project, New project…, Browse ACTIVE…
//   browse - ACTIVE's folders: grouping folders open (›), projects show "✓ project",
//            other folders get "Use". Projects never open (no projects inside projects).
//   new    - name + "Put it in" (ACTIVE or a grouping folder), then Create project.
// pick() resolves with a project id, null (No project / Unsorted) or undefined (closed).
import { h, toast } from './dom.js';
import * as api from '../api.js';
import { tapOutScrim } from './dropdown.js';

let cache = null; // last /api/projects answer
// Batch 12: the project new outputs go to, picked on THIS device. Every load of the
// app starts on No project (null); moving things never changes it.
let current = null;
export const getCurrentProject = () => (current && projectById(current) ? current : null);
export async function loadProjects() { cache = await api.getProjects(); return cache; }
export const projectsCache = () => cache;
export function projectById(id) { return id ? cache?.projects.find((p) => p.id === id) || null : null; }
/** "Apps › Cache" (grouping folders + name), "Unsorted" for null. */
export function projectLabel(id) { const p = projectById(id); return p ? [...p.group, p.name].join(' › ') : id ? 'Unknown project' : 'Unsorted'; }

const ago = (t) => {
  if (!t) return '';
  const d = Math.round((Date.now() - t) / 864e5);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

export class ProjectSheet {
  /**
   * @param o.title  sheet title ("Project", "Move 3 items to…")
   * @param o.move   true: picking moves things (No project = "Unsorted"), no ✓ on the current one
   */
  /**
   * @param o.anchor  batch 19: open as a dropdown under this button (the form's project
   *                  button) instead of a bottom sheet (the Files "Move N items to…" picker).
   */
  pick({ title = 'Project', move = false, anchor = null } = {}) {
    this.close();
    return new Promise((resolve) => {
      this.resolve = resolve; this.move = move; this.title = title; this.anchor = anchor;
      this.head = h('div.sheet-title.pj-title');
      this.body = h('div.df-list.pj-list');
      if (anchor) {
        // Same look as the app's other dropdowns (ui/dropdown.js): fixed under its button,
        // a see-through scrim to tap out, a max height with its own scroll.
        this.scrim = tapOutScrim(() => this.finish(undefined));
        this.el = h('div.dd-pop.pj-pop', { role: 'dialog', 'aria-label': title }, this.head, this.body);
        anchor.setAttribute('aria-expanded', 'true'); anchor.classList.add('open');
        // The keyboard (New project's name box) shrinks the window: keep the list fitted under the button.
        this.onResize = () => this.place();
        window.addEventListener('resize', this.onResize);
        window.visualViewport?.addEventListener('resize', this.onResize);
      } else {
        this.scrim = h('div.sheet-scrim', { onclick: () => this.finish(undefined) });
        this.el = h('div.sheet.pj-sheet', { role: 'dialog', 'aria-label': title }, this.head, this.body);
      }
      document.body.append(this.scrim, this.el);
      this.keydown = (e) => { if (e.key === 'Escape') this.finish(undefined); };
      document.addEventListener('keydown', this.keydown);
      this.showList();
    });
  }

  /** Dropdown mode: under the button, as tall as the room below it (above when there is more room there). */
  place() {
    if (!this.anchor || !this.el?.isConnected) return;
    const r = this.anchor.getBoundingClientRect();
    const vh = window.visualViewport?.height || innerHeight;
    const w = Math.min(innerWidth - 16, Math.max(r.width, 340));
    this.el.style.width = `${Math.round(w)}px`;
    this.el.style.left = `${Math.round(Math.max(8, Math.min(r.left, innerWidth - w - 8)))}px`;
    const below = vh - r.bottom - 14, above = r.top - 14;
    const down = below >= 260 || below >= above;
    const max = Math.max(160, Math.min(down ? below : above, 560));
    this.el.style.maxHeight = `${Math.round(max)}px`;
    if (down) { this.el.style.top = `${Math.round(r.bottom + 6)}px`; this.el.style.bottom = ''; }
    else { this.el.style.top = ''; this.el.style.bottom = `${Math.round(innerHeight - r.top + 6)}px`; }
  }

  #title(text, back) {
    // Dropdown mode: no title bar on the first list (it sits right under its button);
    // New project / Browse get one with a back arrow.
    this.head.hidden = !!this.anchor && !back;
    this.head.replaceChildren(...[
      back ? h('button.btn.icon.pj-back', { type: 'button', 'aria-label': 'Back', dataset: { act: 'back' }, onclick: back }, h('i.i.i-chevron-left')) : null,
      h('span', {}, text), h('span.spacer'),
      this.anchor ? null : h('button.btn.icon', { type: 'button', 'aria-label': 'Close', dataset: { act: 'close' }, onclick: () => this.finish(undefined) }, h('i.i.i-x')),
    ].filter(Boolean));
    this.body.scrollTop = 0;
    requestAnimationFrame(() => this.place());
  }

  #row({ icon = 'i-folder', name, sub, end, on, act, data = {}, click }) {
    return h(`button.sheet-row.pj-row${on ? '.on' : ''}`, { type: 'button', dataset: { act, ...data }, onclick: click },
      h(`i.i.${icon}`), h('span.pj-t', {}, h('span.nm', {}, name), sub ? h('span.pj-sub', {}, sub) : null), end || h('span'));
  }

  async showList() {
    this.#title(this.title);
    this.body.replaceChildren(h('div.muted.df-msg', {}, 'Loading…'));
    let d;
    try { d = await loadProjects(); } catch (e) { this.body.replaceChildren(h('div.muted.df-msg', {}, e.message)); return; }
    const rows = [];
    if (!d.available) rows.push(h('div.muted.df-msg.pj-warn', {}, 'Google Drive is not available on the PC right now. Outputs are filed once it is back.'));
    const live = d.projects.filter((p) => !p.missing);
    if (live.length) rows.push(h('div.pj-sec', {}, 'Recent'));
    for (const p of live) {
      const on = !this.move && current === p.id;
      rows.push(this.#row({ icon: 'i-clipboard-list', name: p.name, sub: [p.group.join(' › ') || d.root, `${p.count} ${p.count === 1 ? 'output' : 'outputs'}`, ago(p.lastAt || p.lastUsedAt)].filter(Boolean).join(' · '),
        on, act: 'project', data: { project: p.id }, end: on ? h('i.i.i-check') : null, click: () => this.finish(p.id) }));
    }
    const noOn = !this.move && !current;
    rows.push(this.#row({ icon: 'i-circle', name: this.move ? 'Unsorted' : 'No project', sub: `Files go to ${d.root}/__Comfy UI`, on: noOn, act: 'no-project', end: noOn ? h('i.i.i-check') : null, click: () => this.finish(null) }));
    rows.push(h('div.pj-sec', {}, 'Find another'));
    rows.push(this.#row({ icon: 'i-plus', name: 'New project…', sub: 'Makes a new folder on Drive', act: 'new-project', end: h('i.i.i-chevron-right'), click: () => this.showNew() }));
    rows.push(this.#row({ icon: 'i-folder-open', name: `Browse ${d.root}…`, sub: 'Pick any folder, however deep it is', act: 'browse', end: h('i.i.i-chevron-right'), click: () => this.showBrowse('') }));
    const missing = d.projects.filter((p) => p.missing);
    if (missing.length) rows.push(h('div.muted.pj-note', {}, `Not found on Drive: ${missing.map((p) => p.name).join(', ')} (moved out of ${d.root}?)`));
    this.body.replaceChildren(...rows);
  }

  async showBrowse(path) {
    this.body.replaceChildren(h('div.muted.df-msg', {}, 'Loading…'));
    let r;
    try { r = await api.browseProjects(path); } catch (e) { toast(e.message, 6000); this.body.replaceChildren(h('div.muted.df-msg', {}, e.message)); return; }
    const parts = r.path ? r.path.split('/') : [];
    this.#title(parts.at(-1) || r.root, () => (parts.length ? this.showBrowse(parts.slice(0, -1).join('/')) : this.showList()));
    const crumb = (label, to, last) => h(`button.df-crumb${last ? '.on' : ''}`, { type: 'button', onclick: () => !last && this.showBrowse(to) }, label);
    const crumbs = h('div.df-crumbs', {}, crumb(r.root, '', !parts.length), ...parts.flatMap((p, i) => [h('span.df-sep', {}, '›'), crumb(p, parts.slice(0, i + 1).join('/'), i === parts.length - 1)]));
    const rows = r.folders.map((f) => {
      if (f.project) return this.#row({ icon: 'i-clipboard-list', name: f.name, sub: 'Project', act: 'project', data: { project: f.project, folder: f.name }, end: h('span.pj-tag', {}, '✓ project'), click: () => this.finish(f.project) });
      const use = h('span.btn.primary.pj-use', { role: 'button', dataset: { act: 'use' }, onclick: async (e) => {
        e.stopPropagation();
        try { const p = await api.markProject(f.path); toast(`"${p.name}" is a project now`); this.finish(p.id); } catch (err) { toast(err.message, 6000); }
      } }, 'Use');
      return this.#row({ name: f.name, sub: f.projects ? `${f.projects} ${f.projects === 1 ? 'project' : 'projects'} inside` : '', act: 'open', data: { folder: f.name },
        end: h('span.pj-ends', {}, f.projects ? null : use, h('i.i.i-chevron-right')), click: () => this.showBrowse(f.path) });
    });
    // The open folder itself as the project (e.g. inside Apps/Cache: "Use Cache as the project").
    const useHere = parts.length && !r.here?.projects ? h('button.btn.primary.pj-here', { type: 'button', dataset: { act: 'use-here' }, onclick: async () => {
      try { const p = await api.markProject(r.path); toast(`"${p.name}" is a project now`); this.finish(p.id); } catch (err) { toast(err.message, 6000); }
    } }, h('i.i.i-check'), `Use "${parts.at(-1)}" as the project`) : null;
    this.body.replaceChildren(...[crumbs, useHere, ...(rows.length ? rows : [h('div.muted.df-msg', {}, 'No sub folders here.')]),
      h('div.muted.pj-note', {}, 'Tap a folder to open it, or "Use" to make it a project. The app makes the "__comfy outputs" folder itself (folders starting with "__" are hidden).')].filter(Boolean));
  }

  async showNew() {
    this.#title('New project', () => this.showList());
    this.body.replaceChildren(h('div.muted.df-msg', {}, 'Loading…'));
    let r;
    try { r = await api.browseProjects(''); } catch (e) { this.body.replaceChildren(h('div.muted.df-msg', {}, e.message)); return; }
    let parent = '';
    const name = h('input.sheet-input.pj-name', { type: 'text', placeholder: 'Project name', maxlength: 120, 'aria-label': 'Project name', autocomplete: 'off' });
    const preview = h('div.muted.pj-note');
    const paint = () => { const n = name.value.trim() || '<name>'; preview.replaceChildren('Will create ', h('code', {}, `${[r.root, parent, n].filter(Boolean).join('/')}/__comfy outputs/`)); };
    // Grouping folders only (folders that are not projects); ACTIVE itself first.
    const groups = [{ name: r.root, path: '', sub: 'Top level' }, ...r.folders.filter((f) => !f.project).map((f) => ({ name: f.name, path: f.path, sub: f.projects ? `${f.projects} ${f.projects === 1 ? 'project' : 'projects'}` : '' }))];
    const list = h('div.pj-groups');
    const paintGroups = () => list.replaceChildren(...groups.map((g) => this.#row({ name: g.name, sub: g.sub, on: g.path === parent, act: 'parent', data: { parent: g.path || '.' }, end: g.path === parent ? h('i.i.i-check') : null, click: () => { parent = g.path; paintGroups(); paint(); } })));
    const create = h('button.btn.primary.pj-create', { type: 'button', dataset: { act: 'create' }, onclick: async () => {
      const n = name.value.trim();
      if (!n) { name.focus(); return toast('Type a name'); }
      create.disabled = true;
      try { const p = await api.newProject(n, parent); toast(`Created ${[parent, p.name].filter(Boolean).join('/')}`); this.finish(p.id); } catch (e) { toast(e.message, 6000); create.disabled = false; }
    } }, 'Create project');
    name.addEventListener('input', paint);
    name.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') create.click(); });
    paintGroups(); paint();
    this.body.replaceChildren(h('div.pj-sec', {}, 'Name'), name, h('div.pj-sec', {}, 'Put it in'), list, preview, create);
    setTimeout(() => name.focus(), 0);
  }

  finish(v) { const r = this.resolve; this.resolve = null; this.close(); r?.(v); }

  close() {
    this.scrim?.remove(); this.el?.remove(); this.scrim = this.el = null;
    if (this.keydown) document.removeEventListener('keydown', this.keydown);
    if (this.onResize) { window.removeEventListener('resize', this.onResize); window.visualViewport?.removeEventListener('resize', this.onResize); this.onResize = null; }
    if (this.anchor) { this.anchor.setAttribute('aria-expanded', 'false'); this.anchor.classList.remove('open'); this.anchor = null; }
    if (this.resolve) { const r = this.resolve; this.resolve = null; r(undefined); }
  }
}

/** The chip at the top of the form: which project new outputs go to. */
export class ProjectChip {
  constructor(host, { isLocked = () => false } = {}) {
    this.sheet = new ProjectSheet();
    this.isLocked = isLocked;
    this.crumb = h('span.crumb'); this.name = h('span.name', {}, 'No project');
    // batch 13: clipboard for a project (not mixed up with Files' folder); batch 17:
    // the empty circle for No project, the same icon as in the list.
    this.icon = h('i.i.i-circle');
    this.btn = h('button.btn.picker.project-chip', { type: 'button', 'aria-label': 'Project', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', dataset: { act: 'project' }, onclick: () => this.open() },
      this.icon, this.crumb, this.name, h('i.i.i-chevron-down'));
    this.where = h('div.project-where.muted');
    host.replaceChildren(this.btn, this.where);
    host.hidden = false;
    this.refresh();
  }

  async refresh() {
    try { await loadProjects(); } catch { /* server not there yet: keep the last state */ }
    this.paint();
  }

  paint() {
    const d = projectsCache();
    const p = projectById(getCurrentProject());
    this.crumb.textContent = p?.group.length ? `${p.group.join(' › ')} ›` : '';
    this.name.textContent = p ? p.name : 'No project';
    this.icon.className = `i ${p ? 'i-clipboard-list' : 'i-circle'}`;
    this.btn.classList.toggle('none', !p);
    const root = d?.root || 'ACTIVE';
    this.where.textContent = d && !d.available ? 'Google Drive is offline: outputs are filed once it is back'
      : p ? `Saves to ${[...p.group, p.name].join('/')}/__comfy outputs` : `Saves to ${root}/__Comfy UI (Unsorted)`;
  }

  async open() {
    const id = await this.sheet.pick({ title: 'Project', anchor: this.btn }); // batch 19: a dropdown under the button
    if (id === undefined) return;
    current = id || null;
    await this.refresh();
    toast(id ? `Project: ${projectLabel(id)}` : 'No project: outputs go to Unsorted');
  }
}
