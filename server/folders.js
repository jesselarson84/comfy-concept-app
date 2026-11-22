// folders.js - History folders, stored on the PC in data/folders.json.
// Folders are labels only: a folder is a name and a list of history entry ids.
// Nothing is moved or copied on disk; deleting a folder deletes the label.
// Favorites stay the entries' own "favorite" flag (shown as the first folder).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_NAME = 60;
export const cleanName = (n) => String(n ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, MAX_NAME);

export class FolderStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'folders.json');
    fs.mkdirSync(dataDir, { recursive: true });
    try { const d = JSON.parse(fs.readFileSync(this.file, 'utf8')); this.data = Array.isArray(d.folders) ? d : { version: 1, folders: [] }; } catch { this.data = { version: 1, folders: [] }; }
    this.writing = Promise.resolve();
  }

  #save() {
    const json = JSON.stringify(this.data, null, 1);
    this.writing = this.writing.then(async () => { const tmp = this.file + '.tmp'; await fs.promises.writeFile(tmp, json); await fs.promises.rename(tmp, this.file); });
    return this.writing;
  }

  list() { return this.data.folders.map((f) => ({ ...f, items: [...f.items] })); }
  get(id) { return this.data.folders.find((f) => f.id === id) || null; }

  async create(name) {
    const n = cleanName(name);
    if (!n) throw Object.assign(new Error('Folder needs a name'), { status: 400 });
    const existing = this.data.folders.find((f) => f.name.toLowerCase() === n.toLowerCase());
    if (existing) return existing;
    const f = { id: 'f_' + crypto.randomUUID().slice(0, 8), name: n, createdAt: Date.now(), items: [] };
    this.data.folders.push(f);
    await this.#save();
    return f;
  }

  async rename(id, name) {
    const f = this.get(id), n = cleanName(name);
    if (!f) return null;
    if (!n) throw Object.assign(new Error('Folder needs a name'), { status: 400 });
    f.name = n; await this.#save(); return f;
  }

  async remove(id) {
    const before = this.data.folders.length;
    this.data.folders = this.data.folders.filter((f) => f.id !== id);
    if (before !== this.data.folders.length) await this.#save();
    return before !== this.data.folders.length;
  }

  async edit(id, { add = [], remove = [] } = {}) {
    const f = this.get(id);
    if (!f) return null;
    const set = new Set(f.items);
    for (const x of add) if (typeof x === 'string' && x) set.add(x);
    for (const x of remove) set.delete(x);
    f.items = [...set];
    await this.#save();
    return f;
  }

  /** Drop deleted history entries from every folder. */
  async forget(ids) {
    const drop = new Set(ids);
    let changed = false;
    for (const f of this.data.folders) { const n = f.items.length; f.items = f.items.filter((x) => !drop.has(x)); changed ||= n !== f.items.length; }
    if (changed) await this.#save();
  }
}
