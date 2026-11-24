// projects.js - batch 11: projects are real folders on Google Drive.
// -----------------------------------------------------------------------------
// Projects live under the ACTIVE folder (default Q:\My Drive\Creative\PROJECTS\
// ACTIVE, "projectsDir" in config.local.json or PROJECTS_DIR). A project can sit
// right in ACTIVE or inside plain grouping folders (ACTIVE\Apps\Cache). A project
// never sits inside another project.
//
//   <project>\__comfy outputs\Images | 3D | Video | Audio   every output is filed here
//   ACTIVE\__Comfy UI\Images | ...                         no project set (Unsorted)
//   <project>\.comfy-project                               marker {id, name}: the project
//                                                          stays linked after a rename / move
//
// data/projects.json holds the list (id, name, rel path inside ACTIVE, last used)
// and the current project (shared by every device, like History sessions).
// Folders starting with "." "__" or "$" are never shown or used as projects.
// -----------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_PROJECTS_DIR = 'Q:\\My Drive\\Creative\\PROJECTS\\ACTIVE';
export const OUTPUTS_DIR = '__comfy outputs';
export const UNSORTED_DIR = '__Comfy UI';
export const MARKER = '.comfy-project';
export const KIND_DIRS = { image: 'Images', '3d': '3D', video: 'Video', audio: 'Audio' };

const err = (status, message) => Object.assign(new Error(message), { status });
const BAD = /[\\/:*?"<>|\u0000-\u001f]/;
/** A folder name the app may create or use. */
export const goodName = (s) => typeof s === 'string' && !!s && s === s.trim() && s.length <= 120 && !BAD.test(s) && s !== '.' && s !== '..' && !s.endsWith('.');
/** Folders the app never lists: hidden, system and the app's own "__" folders. */
export const hiddenDir = (n) => n.startsWith('.') || n.startsWith('__') || n.startsWith('$') || n === 'desktop.ini' || n === 'System Volume Information';
const splitRel = (rel) => String(rel ?? '').split('/').filter((p) => p !== '');

export class ProjectStore {
  constructor(dataDir, { projectsDir = DEFAULT_PROJECTS_DIR, now = Date.now } = {}) {
    this.root = path.resolve(projectsDir);
    this.file = path.join(dataDir, 'projects.json');
    this.now = now;
    fs.mkdirSync(dataDir, { recursive: true });
    let d = null;
    try { d = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {}
    this.data = d && Array.isArray(d.projects) ? { version: 1, current: d.current ?? null, projects: d.projects } : { version: 1, current: null, projects: [] };
    this.writing = Promise.resolve();
    this.lastScan = 0;
  }

  #save() {
    const json = JSON.stringify(this.data, null, 1);
    this.writing = this.writing.then(async () => { const tmp = this.file + '.tmp'; await fs.promises.writeFile(tmp, json); await fs.promises.rename(tmp, this.file); }).catch(() => {});
    return this.writing;
  }

  /** ACTIVE is there (Drive for Desktop running, Q: mounted). */
  available() { try { return fs.statSync(this.root).isDirectory(); } catch { return false; } }
  #need() { if (!this.available()) throw err(503, `Google Drive is not available: ${this.root} was not found.`); }

  /** "Apps/Cache" -> absolute, refusing anything that leads out of ACTIVE. */
  abs(rel) {
    const parts = splitRel(rel);
    if (parts.some((p) => !goodName(p))) throw err(400, 'Bad folder');
    const dir = path.resolve(this.root, ...parts);
    if (dir !== this.root && !dir.startsWith(this.root + path.sep)) throw err(400, 'Bad folder');
    return dir;
  }

  get(id) { return this.data.projects.find((p) => p.id === id) || null; }
  byRel(rel) { const r = splitRel(rel).join('/').toLowerCase(); return this.data.projects.find((p) => p.rel.toLowerCase() === r) || null; }
  get current() { return this.get(this.data.current) ? this.data.current : null; }

  #readMarker(dir) { try { const m = JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8')); return typeof m?.id === 'string' ? m : null; } catch { return null; } }
  #writeMarker(dir, p) { fs.writeFileSync(path.join(dir, MARKER), JSON.stringify({ id: p.id, name: p.name, app: 'Comfy UI' }, null, 1)); }

  /** Is the project's folder still where we think? If not, look for its marker (rename / move). */
  #check(p) {
    let dir; try { dir = this.abs(p.rel); } catch { dir = null; }
    if (dir && this.#readMarker(dir)?.id === p.id) { delete p.missing; return true; }
    return false;
  }

  /** Walk ACTIVE (a few levels) for marker files; adopts unknown ones, re-links moved ones. */
  scan({ depth = 3, force = false } = {}) {
    if (!this.available()) return false;
    if (!force && this.now() - this.lastScan < 60000) return false;
    this.lastScan = this.now();
    const found = new Map();
    const walk = (dir, rel, d) => {
      let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      const m = rel.length ? this.#readMarker(dir) : null;
      if (m) { found.set(m.id, { rel: rel.join('/'), name: path.basename(dir) }); return; } // never look inside a project
      if (d >= depth) return;
      for (const e of ents) if (e.isDirectory() && !hiddenDir(e.name)) walk(path.join(dir, e.name), [...rel, e.name], d + 1);
    };
    walk(this.root, [], 0);
    let changed = false;
    for (const p of this.data.projects) {
      const f = found.get(p.id);
      if (f) { if (p.rel !== f.rel || p.missing) { p.rel = f.rel; p.name = f.name; delete p.missing; changed = true; } found.delete(p.id); }
      else if (!this.#check(p) && !p.missing) { p.missing = true; changed = true; }
    }
    for (const [id, f] of found) { this.data.projects.push({ id, name: f.name, rel: f.rel, createdAt: this.now(), lastUsedAt: 0 }); changed = true; }
    if (changed) this.#save();
    return changed;
  }

  /** Every project, most recently used first; missing ones are looked for first. */
  list() {
    if (this.available()) {
      const lost = this.data.projects.filter((p) => !this.#check(p));
      if (lost.length) this.scan({ force: lost.some((p) => !p.missing) });
    }
    return this.data.projects.map((p) => ({ ...p, group: splitRel(p.rel).slice(0, -1), missing: !!p.missing }))
      .sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0) || a.name.localeCompare(b.name));
  }

  /** Inside ACTIVE: a folder's sub folders, each marked as a project or a grouping folder. */
  browse(rel = '') {
    this.#need();
    const parts = splitRel(rel);
    const dir = this.abs(rel);
    for (let i = 1; i <= parts.length; i++) if (this.#readMarker(this.abs(parts.slice(0, i).join('/')))) throw err(400, 'Projects cannot hold other projects');
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { throw err(404, 'Folder not found'); }
    const folders = ents.filter((e) => e.isDirectory() && !hiddenDir(e.name)).map((e) => {
      const r = [...parts, e.name].join('/');
      const m = this.#readMarker(path.join(dir, e.name));
      let p = m ? this.get(m.id) : null;
      if (m && !p) { p = { id: m.id, name: e.name, rel: r, createdAt: this.now(), lastUsedAt: 0 }; this.data.projects.push(p); this.#save(); }
      else if (p && p.rel !== r) { p.rel = r; p.name = e.name; delete p.missing; this.#save(); }
      const inside = this.data.projects.filter((x) => x.rel.toLowerCase().startsWith(r.toLowerCase() + '/')).length;
      return { name: e.name, path: r, project: p ? p.id : null, projects: inside };
    }).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    return { root: path.basename(this.root), path: parts.join('/'), folders };
  }

  /** The folder under `rel` is a project from now on. */
  async mark(rel) {
    this.#need();
    const parts = splitRel(rel);
    if (!parts.length) throw err(400, 'Pick a folder inside ' + path.basename(this.root));
    if (parts.some(hiddenDir)) throw err(400, 'That folder cannot be a project');
    const dir = this.abs(rel);
    try { if (!fs.statSync(dir).isDirectory()) throw new Error(); } catch { throw err(404, 'Folder not found'); }
    const m = this.#readMarker(dir);
    if (m && this.get(m.id)) return this.get(m.id);
    for (let i = 1; i < parts.length; i++) if (this.#readMarker(this.abs(parts.slice(0, i).join('/')))) throw err(400, 'Projects cannot hold other projects');
    const r = parts.join('/').toLowerCase();
    if (this.data.projects.some((p) => p.rel.toLowerCase().startsWith(r + '/'))) throw err(400, 'This folder already holds a project; projects cannot hold other projects');
    const p = { id: m?.id || 'p_' + crypto.randomUUID().slice(0, 8), name: parts.at(-1), rel: parts.join('/'), createdAt: this.now(), lastUsedAt: this.now() };
    this.#writeMarker(dir, p);
    this.data.projects.push(p);
    await this.#save();
    return p;
  }

  /** New project folder `name` in ACTIVE or a grouping folder, with "__comfy outputs" inside. */
  async create(parentRel, name) {
    this.#need();
    const n = String(name ?? '').trim().replace(/\s+/g, ' ');
    if (!goodName(n) || hiddenDir(n)) throw err(400, 'Project names cannot start with "." or "__" or contain \\ / : * ? " < > |');
    const parts = splitRel(parentRel);
    if (parts.some(hiddenDir)) throw err(400, 'Bad folder');
    const parent = this.abs(parentRel);
    try { if (!fs.statSync(parent).isDirectory()) throw new Error(); } catch { throw err(404, 'Folder not found'); }
    for (let i = 1; i <= parts.length; i++) if (this.#readMarker(this.abs(parts.slice(0, i).join('/')))) throw err(400, 'Projects cannot hold other projects');
    const dir = path.join(parent, n);
    const taken = (() => { try { return fs.readdirSync(parent).some((x) => x.toLowerCase() === n.toLowerCase()); } catch { return false; } })();
    if (taken) throw err(409, `"${n}" already exists there. Pick another name.`);
    fs.mkdirSync(path.join(dir, OUTPUTS_DIR), { recursive: true });
    const p = { id: 'p_' + crypto.randomUUID().slice(0, 8), name: n, rel: [...parts, n].join('/'), createdAt: this.now(), lastUsedAt: this.now() };
    this.#writeMarker(dir, p);
    this.data.projects.push(p);
    this.data.current = p.id;
    await this.#save();
    return p;
  }

  async setCurrent(id) {
    if (id && !this.get(id)) throw err(404, 'No such project');
    this.data.current = id || null;
    if (id) this.get(id).lastUsedAt = this.now();
    await this.#save();
    return this.current;
  }

  async touch(id) { const p = this.get(id); if (p) { p.lastUsedAt = this.now(); await this.#save(); } }

  /** Where a project's outputs go (null = Unsorted). null when the project folder is lost. */
  outputsDir(id) {
    if (!id) return path.join(this.root, UNSORTED_DIR);
    const p = this.get(id);
    if (!p || p.missing) return null;
    let dir; try { dir = this.abs(p.rel); } catch { return null; }
    return this.#readMarker(dir)?.id === p.id ? path.join(dir, OUTPUTS_DIR) : null;
  }

  /** "Apps › Cache" / "Unsorted" (for the viewer's Details). */
  label(id) { const p = id ? this.get(id) : null; return p ? [...splitRel(p.rel).slice(0, -1), p.name].join(' › ') : 'Unsorted'; }
}
