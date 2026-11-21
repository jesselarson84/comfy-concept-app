// workflows.js - the presets dropdown = every *.json in workflows/.
// The folder is watched: drop a file in (or save one from ComfyUI there) and
// the list refreshes; connected browsers are told via /api/events.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { detectControls, checkApiFormat } from '../app/js/lib/workflow-detect.js';

export function labelFromFile(file) {
  const base = path.basename(file, '.json').replace(/[-_]+/g, ' ').trim();
  return base.charAt(0).toUpperCase() + base.slice(1);
}

export class WorkflowStore extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.cache = null;
    try {
      // fs.watch fires several events per save; debounce them.
      let t;
      this.watcher = fs.watch(dir, () => { clearTimeout(t); t = setTimeout(() => { this.cache = null; this.emit('change'); }, 200); });
      this.watcher.on('error', () => {});
    } catch { this.watcher = null; }
  }

  close() { this.watcher?.close(); }

  list() {
    // Cache keyed on file names + mtimes, so even without fs.watch (network
    // drives) a changed file is picked up on the next request.
    const files = fs.readdirSync(this.dir).filter((f) => f.toLowerCase().endsWith('.json')).sort();
    const key = files.map((f) => { try { return f + fs.statSync(path.join(this.dir, f)).mtimeMs; } catch { return f; } }).join('|');
    if (this.cache?.key === key) return this.cache.items;
    const items = files.map((file) => {
      const id = path.basename(file, '.json');
      const base = { id, file, label: labelFromFile(file) };
      let wf;
      try { wf = JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf8')); } catch (e) {
        return { ...base, ok: false, error: 'Invalid JSON: ' + e.message };
      }
      const controls = detectControls(wf);
      if (!controls.ok) return { ...base, ok: false, error: controls.error };
      return { ...base, ok: true, controls, workflow: wf };
    });
    this.cache = { key, items };
    return items;
  }

  /** Save an uploaded API-format workflow. Returns { id, file }. */
  import(filename, text) {
    let wf;
    try { wf = JSON.parse(text); } catch (e) { throw Object.assign(new Error('Not valid JSON: ' + e.message), { status: 400 }); }
    const fmt = checkApiFormat(wf);
    if (!fmt.ok) throw Object.assign(new Error(fmt.reason), { status: 400 });
    let base = path.basename(String(filename || 'imported')).replace(/\.json$/i, '').replace(/[^\w\- ]+/g, '_').trim() || 'imported';
    let file = base + '.json', n = 2;
    while (fs.existsSync(path.join(this.dir, file))) file = `${base}-${n++}.json`; // never overwrite
    const tmp = path.join(this.dir, '.' + file + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify(wf, null, 2));
    fs.renameSync(tmp, path.join(this.dir, file));
    this.cache = null;
    return { id: path.basename(file, '.json'), file };
  }
}
