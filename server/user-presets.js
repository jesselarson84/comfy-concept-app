// user-presets.js - setups the user saved from the chat builder, in
// data/user-presets.json (data/ is git-ignored). Only the BLOCK LIST is the
// source of truth: the graph is re-assembled and re-validated against the live
// /object_info every time the list is read, so a removed model shows up as
// "unavailable" instead of failing in ComfyUI.
//   { version: 1, presets: [{ id, name, blocks, output, createdAt, updatedAt }] }
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX = 200;
export const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);

export class UserPresetStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'user-presets.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.data = this.#load();
    this.writing = Promise.resolve();
  }
  #load() {
    try { const d = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (Array.isArray(d.presets)) return d; } catch (e) {
      if (e.code !== 'ENOENT') { try { fs.renameSync(this.file, this.file + '.corrupt-' + Date.now()); } catch {} }
    }
    return { version: 1, presets: [] };
  }
  #save() {
    const json = JSON.stringify(this.data, null, 1);
    this.writing = this.writing.then(async () => { const tmp = this.file + '.tmp'; await fs.promises.writeFile(tmp, json); await fs.promises.rename(tmp, this.file); });
    return this.writing;
  }
  list() { return [...this.data.presets]; }
  get(id) { return this.data.presets.find((p) => p.id === String(id).replace(/^user:/, '')) || null; }
  async add({ name, blocks, output }) {
    if (this.data.presets.length >= MAX) throw Object.assign(new Error(`At most ${MAX} saved setups`), { status: 400 });
    let n = cleanName(name) || 'My setup';
    const taken = new Set(this.data.presets.map((p) => p.name.toLowerCase()));
    if (taken.has(n.toLowerCase())) { let i = 2; while (taken.has(`${n} ${i}`.toLowerCase())) i++; n = `${n} ${i}`; }
    const now = Date.now();
    const p = { id: 'u_' + crypto.randomUUID().slice(0, 10), name: n, blocks, output, createdAt: now, updatedAt: now };
    this.data.presets.push(p);
    await this.#save();
    return p;
  }
  async rename(id, name) {
    const p = this.get(id); if (!p) return null;
    const n = cleanName(name);
    if (!n) throw Object.assign(new Error('Name cannot be empty'), { status: 400 });
    p.name = n; p.updatedAt = Date.now();
    await this.#save();
    return p;
  }
  async remove(id) {
    const p = this.get(id); if (!p) return false;
    this.data.presets = this.data.presets.filter((x) => x !== p);
    await this.#save();
    return true;
  }
}
