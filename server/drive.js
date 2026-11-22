// drive.js - "Save to Drive": copy one of the app's results into the Google
// Drive for Desktop folder on this PC (default Q:\My Drive\Comfy UI\, set
// "driveDir" in config.local.json or DRIVE_DIR to change it). Drive for Desktop
// uploads it from there; there is no Google sign-in in the app.
//
//   Q:\My Drive\Comfy UI\Images  pictures      ...\Video  videos
//   Q:\My Drive\Comfy UI\3D      .glb models    ...\Audio  audio
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

/**
 * @param ref { filename, subfolder, type, kind? }
 * @param o { driveDir, comfyUrl, outputSubfolder, historyFiles, fetchImpl }
 * @returns { name, folder, path }
 */
export async function saveToDrive(ref, { driveDir = DEFAULT_DRIVE_DIR, comfyUrl, outputSubfolder, historyFiles, fetchImpl = fetch } = {}) {
  const why = checkAppOutput(ref, { outputSubfolder, historyFiles });
  if (why) throw err(400, why);
  const root = path.resolve(driveDir);
  const parent = path.dirname(root);
  let ok = false; try { ok = fs.statSync(parent).isDirectory(); } catch {}
  if (!ok) throw err(503, `Google Drive is not available: ${parent} was not found.`);
  const folder = DRIVE_FOLDERS[driveKind(ref)];
  const dir = path.resolve(root, folder);
  if (path.dirname(dir) !== root) throw err(400, 'Bad folder');
  fs.mkdirSync(dir, { recursive: true });
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
  return { name: out.name, folder, path: out.full };
}
