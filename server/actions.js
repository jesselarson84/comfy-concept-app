// actions.js (server) - workflow ACTIONS in workflows/actions/*.json.
// Each file = { action: manifest, workflow: API graph }; validated with the
// shared app/js/lib/actions.js. Invalid files are listed with their error
// (and never offered to the model). Cached on file names + mtimes.
import fs from 'node:fs';
import path from 'node:path';
import { validateAction } from '../app/js/lib/actions.js';

export class ActionStore {
  constructor(dir) { this.dir = dir; this.cache = null; }

  list() {
    let files = [];
    try { files = fs.readdirSync(this.dir).filter((f) => f.toLowerCase().endsWith('.json')).sort(); } catch { return []; }
    const key = files.map((f) => { try { return f + fs.statSync(path.join(this.dir, f)).mtimeMs; } catch { return f; } }).join('|');
    if (this.cache?.key === key) return this.cache.items;
    const items = files.map((f) => {
      const id = path.basename(f, '.json');
      try { return validateAction(id, JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'))); } catch (e) { return { ok: false, id, error: 'Invalid JSON: ' + e.message }; }
    });
    this.cache = { key, items };
    return items;
  }
}
