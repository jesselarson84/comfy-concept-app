// drive.js - "Save to Drive": copy one of the app's results into the Google
// Drive for Desktop folder on this PC (default Q:\My Drive\Comfy UI\, set
// "driveDir" in config.local.json or DRIVE_DIR to change it). Drive for Desktop
// uploads it from there; there is no Google sign-in in the app.
//
//   Q:\My Drive\Comfy UI\Images  pictures      ...\Video  videos
//   Q:\My Drive\Comfy UI\3D      .glb models    ...\Audio  audio
//
// Batch 8: the app asks for a folder on every save ("Save to…", any folder in
// My Drive, starting in the last one used for that kind); `folder` in the
// request is that choice. /api/drive/folders lists and creates folders.
//
// Rules: the source must be one of the app's own outputs (outputs.js
// checkAppOutput) and is read through ComfyUI's /view; the target name is
// the plain file name, kept inside the kind folder, and an existing file is
// never overwritten ("name (2).png", "name (3).png", ...). If the Drive folder's
// parent (Q:\My Drive) is missing, nothing is written and a clear error is returned.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { checkAppOutput, safeFileName } from './outputs.js';
import { fileKind } from '../app/js/lib/outputs.js';

export const DRIVE_FOLDERS = { image: 'Images', video: 'Video', '3d': '3D', audio: 'Audio' };
export const DEFAULT_DRIVE_DIR = 'Q:\\My Drive\\Comfy UI';

const err = (status, message) => Object.assign(new Error(message), { status });

/** Kind of a result for the folder choice (pictures have no explicit kind). */
export function driveKind(ref) {
  if (ref?.kind && DRIVE_FOLDERS[ref.kind]) return ref.kind;
  const k = fileKind({ filename: ref?.filename || '' });
  return k === 'file' ? 'image' : k;
}

/** The first free "name.ext", "name (2).ext", ... opened exclusively ('wx'). */
export function openUnique(dir, name, { max = 999 } = {}) {
  const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
  for (let i = 1; i <= max; i++) {
    const candidate = i === 1 ? name : `${stem} (${i})${ext}`;
    const full = path.join(dir, candidate);
    if (path.dirname(full) !== dir) throw err(400, 'Bad file name');
    try { return { fd: fs.openSync(full, 'wx'), full, name: candidate }; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw err(409, 'Too many files with that name');
}

// ---- batch 8: "Save to…" picks any folder in My Drive ------------------------
// Folder paths travel as "Comfy UI/Images" (forward slashes, relative to the
// Drive root = the parent of driveDir, i.e. Q:\My Drive). Every part must be a
// plain name (no "..", separators, drive letters, NUL); the resolved folder (and
// its real path, so a link can't lead out) must stay inside the Drive root.
const badPart = (s) => !s || s === '.' || s === '..' || /[\\/:*?"<>|\0]/.test(s) || s.length > 200;

/** Drive root (Q:\My Drive) for a driveDir; 503 when Drive is not there. */
export function driveRoot(driveDir = DEFAULT_DRIVE_DIR) {
  const parent = path.dirname(path.resolve(driveDir));
  let ok = false; try { ok = fs.statSync(parent).isDirectory(); } catch {}
  if (!ok) throw err(503, `Google Drive is not available: ${parent} was not found.`);
  return parent;
}

/** "Comfy UI/Images" -> absolute folder inside root (must exist). */
export function resolveDriveFolder(root, rel) {
  const parts = String(rel ?? '').split('/').filter((p) => p !== '');
  if (parts.some(badPart)) throw err(400, 'Bad folder');
  const dir = path.resolve(root, ...parts);
  const inside = (p, r) => p === r || p.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
  if (!inside(dir, root)) throw err(400, 'Bad folder');
  let real;
  try { if (!fs.statSync(dir).isDirectory()) throw new Error(); real = fs.realpathSync(dir); } catch { throw err(404, 'Folder not found'); }
  if (!inside(real, fs.realpathSync(root))) throw err(400, 'Bad folder');
  return dir;
}

/** Absolute folder -> "Comfy UI/Images" ('' = the Drive root). */
export const relDriveFolder = (root, dir) => path.relative(root, dir).split(path.sep).filter(Boolean).join('/');

/** Default folder per kind, relative to the Drive root ("Comfy UI/Images").
 *  Batch 11: the server passes `defaults` = the current project's "__comfy outputs/<kind>"
 *  (or ACTIVE/__Comfy UI/<kind>), so My Drive\Comfy UI is no longer made. */
export function driveDefaults(driveDir = DEFAULT_DRIVE_DIR, defaults = null) {
  if (defaults) return defaults;
  const base = path.basename(path.resolve(driveDir));
  return Object.fromEntries(Object.entries(DRIVE_FOLDERS).map(([k, f]) => [k, `${base}/${f}`]));
}

/** A default kind folder ("Comfy UI/Images") is created when first asked for. */
function ensureDefaultFolder(driveDir, root, rel, defaults = null) {
  const r = String(rel ?? "").split("/").filter(Boolean).join("/");
  if (!Object.values(driveDefaults(driveDir, defaults)).includes(r)) return;
  fs.mkdirSync(path.join(root, ...r.split("/")), { recursive: true });
}

/** Sub folders of a Drive folder (hidden / system ones left out), sorted by name. */
export function listDriveFolders(driveDir, rel = '', defaults = null) {
  const root = driveRoot(driveDir);
  ensureDefaultFolder(driveDir, root, rel, defaults);
  // A remembered folder that was deleted or renamed: fall back to the Drive root.
  let dir;
  try { dir = resolveDriveFolder(root, rel); } catch (e) { if (e.status === 404) dir = root; else throw e; }
  const folders = fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('$') && d.name !== 'desktop.ini')
    .map((d) => d.name).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  return { root: path.basename(root) || root, path: relDriveFolder(root, dir), folders, defaults: driveDefaults(driveDir, defaults) };
}

/** New folder `name` inside `rel`; returns its relative path. An existing one is fine. */
export function makeDriveFolder(driveDir, rel, name) {
  const root = driveRoot(driveDir);
  const parent = resolveDriveFolder(root, rel);
  const n = String(name ?? '').trim();
  if (badPart(n) || n.startsWith('.')) throw err(400, 'Folder names cannot contain \\ / : * ? " < > |');
  const dir = path.join(parent, n);
  fs.mkdirSync(dir, { recursive: true });
  return { path: relDriveFolder(root, dir) };
}

/**
 * @param ref { filename, subfolder, type, kind?, folder? }  folder: "Comfy UI/Images"
 *            relative to the Drive root (batch 8, picked in the app); without it
 *            the file goes to driveDir\<kind folder> as before.
 * @param o { driveDir, comfyUrl, outputSubfolder, historyFiles, fetchImpl }
 * @returns { name, folder, drivePath, path }  drivePath: "Comfy UI/Images" (relative to the Drive root)
 */
export async function saveToDrive(ref, { driveDir = DEFAULT_DRIVE_DIR, comfyUrl, outputSubfolder, historyFiles, fetchImpl = fetch, defaults = null } = {}) {
  // Batch 11: no folder picked -> the default folder for its kind (the current project).
  if (typeof ref?.folder !== 'string' && defaults?.[driveKind(ref)]) ref = { ...ref, folder: defaults[driveKind(ref)] };
  const why = checkAppOutput(ref, { outputSubfolder, historyFiles });
  if (why) throw err(400, why);
  const root = path.resolve(driveDir);
  const parent = path.dirname(root);
  let ok = false; try { ok = fs.statSync(parent).isDirectory(); } catch {}
  if (!ok) throw err(503, `Google Drive is not available: ${parent} was not found.`);
  let folder, dir;
  if (typeof ref.folder === 'string') {
    // Batch 8: a folder picked in the app (relative to Q:\My Drive); it must exist
    // (the default kind folders are made on first use).
    ensureDefaultFolder(driveDir, parent, ref.folder, defaults);
    dir = resolveDriveFolder(parent, ref.folder);
    folder = relDriveFolder(parent, dir);
  } else {
    folder = DRIVE_FOLDERS[driveKind(ref)];
    dir = path.resolve(root, folder);
    if (path.dirname(dir) !== root) throw err(400, 'Bad folder');
    fs.mkdirSync(dir, { recursive: true });
  }
  const name = path.basename(String(ref.filename));
  if (!safeFileName(name) || name !== ref.filename) throw err(400, 'Bad file name');
  const q = new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder || '', type: 'output' });
  const r = await fetchImpl(`${comfyUrl}/view?${q}`, { signal: AbortSignal.timeout(120000) }).catch((e) => { throw err(502, `ComfyUI did not send the file: ${e.message}`); });
  if (!r.ok || !r.body) throw err(r.status === 404 ? 404 : 502, r.status === 404 ? 'File not found in ComfyUI output' : `ComfyUI did not send the file (HTTP ${r.status})`);
  const out = openUnique(dir, name);
  try {
    await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(out.full, { fd: out.fd }));
  } catch (e) {
    try { fs.unlinkSync(out.full); } catch {} // only the partial file this call created
    throw err(502, `Copy failed: ${e.message}`);
  }
  return { name: out.name, folder, drivePath: relDriveFolder(parent, dir), path: out.full };
}
