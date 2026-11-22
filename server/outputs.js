// outputs.js - the app's own results on the PC, for "From Comfy UI" (reference
// picker grid) and "Save to Drive".
// -----------------------------------------------------------------------------
// Which files count as the app's: everything ComfyUI saved under
// output/<outputSubfolder>/ (all presets, actions and builder setups write there,
// "concept-app" by default) plus any output image recorded in data/history.json.
// Nothing else in ComfyUI's output folder is listed or copied.
//
// ComfyUI's output folder on disk: config "comfyOutputDir", else the
// --output-directory ComfyUI was started with (GET /system_stats argv, only when
// ComfyUI runs on this PC). Without it, the list comes from history.json alone.
// The browser loads every file through ComfyUI's own /view (via /comfy/), so
// the server never serves output files itself.
import fs from 'node:fs';
import path from 'node:path';
import { isLocal } from './comfy-info.js';
import { fileKind } from '../app/js/lib/outputs.js';

const BAD_NAME = /[\\/:*?"<>|\u0000-\u001f]/;

/** Plain file name (no folders, no drive, no "..", no control characters). */
export function safeFileName(name) {
  const n = String(name ?? '');
  return !!n && n.length <= 255 && !BAD_NAME.test(n) && n !== '.' && n !== '..' && n.trim() === n;
}

/** "a/b" relative subfolder made of safe segments ('' allowed). */
export function safeSubfolder(sub) {
  const s = String(sub ?? '');
  if (s === '') return true;
  if (s.length > 255 || s.startsWith('/') || s.endsWith('/')) return false;
  return s.split('/').every((seg) => safeFileName(seg));
}

/**
 * Is { filename, subfolder, type } one of the app's own outputs?
 * type must be "output"; subfolder must be the app's folder (or below it), or
 * the exact file must be in history (an output the app recorded).
 * Returns null when allowed, else the reason.
 */
export function checkAppOutput(ref, { outputSubfolder = 'concept-app', historyFiles = new Set() } = {}) {
  if (!ref || typeof ref !== 'object') return 'No file given';
  const filename = ref.filename, subfolder = ref.subfolder ?? '', type = ref.type || 'output';
  if (type !== 'output') return 'Only saved results can be used';
  if (!safeFileName(filename)) return 'Bad file name';
  if (!safeSubfolder(subfolder)) return 'Bad folder';
  const root = String(outputSubfolder || '').replace(/^\/+|\/+$/g, '');
  if (root && (subfolder === root || subfolder.startsWith(root + '/'))) return null;
  if (historyFiles.has(`${subfolder}/${filename}`)) return null;
  return 'Not one of this app\'s results';
}

/** Output files recorded in history.json ("subfolder/filename" set + entries). */
export function historyOutputs(history) {
  const list = [];
  for (const s of history.list({})) {
    for (const e of s.entries) {
      for (const f of [...(e.images || []), ...(e.files || [])]) {
        if (!f || (f.type || 'output') !== 'output' || !safeFileName(f.filename) || !safeSubfolder(f.subfolder ?? '')) continue;
        list.push({ filename: f.filename, subfolder: f.subfolder || '', type: 'output', kind: fileKind(f) === 'file' ? 'image' : fileKind(f), mtime: e.updatedAt || e.createdAt || 0 });
      }
    }
  }
  return list;
}

/** ComfyUI's output folder on disk, or null. */
export async function comfyOutputDir(cfg, { fetchImpl = fetch } = {}) {
  if (cfg.comfyOutputDir) return path.resolve(cfg.comfyOutputDir);
  if (!isLocal(cfg.comfyUrl)) return null;
  try {
    const r = await fetchImpl(cfg.comfyUrl + '/system_stats', { signal: AbortSignal.timeout(2000) });
    const argv = (await r.json())?.system?.argv;
    if (!Array.isArray(argv)) return null;
    const i = argv.indexOf('--output-directory');
    if (i >= 0 && typeof argv[i + 1] === 'string') return path.resolve(argv[i + 1]);
  } catch { /* ComfyUI offline */ }
  return null;
}

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

/**
 * Files under <outputDir>/<outputSubfolder>/ (recursive, depth <= 4), newest
 * first. Symlinks are not followed; every path is checked to stay inside.
 */
export function scanAppFolder(outputDir, outputSubfolder, { max = 5000 } = {}) {
  if (!outputDir || !outputSubfolder || !safeSubfolder(outputSubfolder)) return [];
  const base = path.resolve(outputDir);
  const root = path.resolve(base, ...outputSubfolder.split('/'));
  if (!root.startsWith(base + path.sep)) return [];
  const out = [];
  const walk = (dir, rel, depth) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of ents) {
      if (out.length >= max) return;
      if (!safeFileName(d.name)) continue;
      const full = path.join(dir, d.name);
      if (!full.startsWith(root + path.sep)) continue;
      if (d.isDirectory() && depth < 4) walk(full, rel ? `${rel}/${d.name}` : d.name, depth + 1);
      else if (d.isFile()) {
        let st; try { st = fs.statSync(full); } catch { continue; }
        const f = { filename: d.name, subfolder: rel ? `${outputSubfolder}/${rel}` : outputSubfolder, type: 'output' };
        const k = IMAGE_EXT.test(d.name) ? 'image' : fileKind(f);
        if (k === 'file') continue;
        out.push({ ...f, kind: k, mtime: st.mtimeMs, size: st.size });
      }
    }
  };
  walk(root, '', 0);
  return out;
}

/** Merged, de-duplicated list (newest first), optionally one kind only. */
export function mergeOutputs(lists, { kind, offset = 0, limit = 120 } = {}) {
  const seen = new Map();
  for (const f of lists.flat()) {
    const key = `${f.subfolder}/${f.filename}`;
    const prev = seen.get(key);
    if (!prev || (f.mtime || 0) > (prev.mtime || 0)) seen.set(key, { ...prev, ...f });
  }
  let all = [...seen.values()];
  if (kind) all = all.filter((f) => f.kind === kind);
  all.sort((a, b) => (b.mtime || 0) - (a.mtime || 0) || a.filename.localeCompare(b.filename));
  return { total: all.length, items: all.slice(offset, offset + limit) };
}

/**
 * Deletes ONE of the app's result files from ComfyUI's output folder.
 * Only a regular file that really resolves inside <outputDir>/<outputSubfolder>/
 * is deleted: type "output", plain name, safe relative subfolder at or below the
 * app's folder, no absolute paths or "..", no symlink (the file itself, the app
 * folder or any folder in between) leading out of it. Anything else is refused.
 * Returns { ok: true, deleted | missing } or { ok: false, reason }.
 */
export async function deleteAppFile(ref, { outputDir, outputSubfolder = 'concept-app' } = {}) {
  const no = (reason) => ({ ok: false, reason });
  if (!outputDir) return no('ComfyUI output folder is unknown');
  if (!ref || typeof ref !== 'object') return no('No file given');
  const filename = ref.filename, subfolder = String(ref.subfolder ?? ''), type = ref.type || 'output';
  if (type !== 'output') return no('Only saved results can be deleted');
  if (!safeFileName(filename)) return no('Bad file name');
  if (!safeSubfolder(subfolder) || subfolder.split('/').some((s) => s === '..' || s === '.')) return no('Bad folder');
  const root = String(outputSubfolder || '').replace(/^\/+|\/+$/g, '');
  if (!root || !safeSubfolder(root)) return no('App folder not set');
  if (!(subfolder === root || subfolder.startsWith(root + '/'))) return no('Not in the app\'s output folder');
  let base, appRoot;
  try { base = await fs.promises.realpath(path.resolve(outputDir)); } catch { return no('ComfyUI output folder is missing'); }
  const appPath = path.resolve(base, ...root.split('/'));
  try {
    const st = await fs.promises.lstat(appPath);
    if (st.isSymbolicLink() || !st.isDirectory()) return no('App folder is not a plain folder');
    appRoot = await fs.promises.realpath(appPath);
  } catch { return no('App folder is missing'); }
  if (!appRoot.startsWith(base + path.sep)) return no('App folder is outside the output folder');
  const full = path.resolve(base, ...subfolder.split('/'), filename);
  if (!full.startsWith(appRoot + path.sep)) return no('Outside the app\'s output folder');
  let st;
  try { st = await fs.promises.lstat(full); } catch (e) { return e.code === 'ENOENT' ? { ok: true, missing: true } : no(e.message); }
  if (st.isSymbolicLink()) return no('Refusing to delete a link');
  if (!st.isFile()) return no('Not a file');
  let real;
  try { real = await fs.promises.realpath(full); } catch (e) { return no(e.message); }
  if (!real.startsWith(appRoot + path.sep)) return no('Resolves outside the app\'s output folder');
  await fs.promises.unlink(real);
  return { ok: true, deleted: true };
}
