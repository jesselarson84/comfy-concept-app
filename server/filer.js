// filer.js - batch 11: every finished output is filed on Google Drive.
// -----------------------------------------------------------------------------
//   project set     ->  <project>\__comfy outputs\Images|3D|Video|Audio\<file>
//   no project      ->  ACTIVE\__Comfy UI\Images|3D|Video|Audio\<file>   (Unsorted)
//
// ComfyUI's output folder keeps its copy (the app shows that one); the Drive copy
// is the filed one. Each History entry remembers where its files went:
//   entry.filed["<subfolder>/<filename>"] = { p: projectId|null, f: "Images/name.png", s }
//   s: "ok" | "missing" (moved / renamed / deleted outside the app: never re-filed)
//      | "gone" (ComfyUI no longer has the file, nothing to copy)
// The path is kept relative to the project, so renaming or moving a project
// folder (found again by its marker, projects.js) does not lose the files.
//
// Changing an entry's project moves its files. Drive offline (Q: missing) or
// ComfyUI offline: nothing happens and the next tick tries again. Same name in
// the target folder: "name (2).png" - nothing is ever overwritten.
// Deleting an entry in the app deletes its filed copies, which Drive for
// Desktop sends to the Drive trash.
// -----------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { openUnique, driveKind } from './drive.js';
import { checkAppOutput, historyOutputs, safeFileName } from './outputs.js';
import { KIND_DIRS } from './projects.js';

export const fileKey = (f) => `${f.subfolder || ''}/${f.filename}`;
const outputsOf = (e) => [...(e.images || []), ...(e.files || [])].filter((f) => f && (f.type || 'output') === 'output' && safeFileName(f.filename));
const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

export function createFiler({ history, projects, getComfyUrl, outputSubfolder = 'concept-app', log = () => {}, fetchImpl = fetch, intervalMs = 15000, verifyMs = 10 * 60000, perTick = 8 } = {}) {
  let timer = null, busy = false, again = false, lastError = null, lastVerify = 0;

  /** Absolute path of a filing record, or null when its project folder is lost. */
  function pathOf(rec) {
    const base = projects.outputsDir(rec.p ?? null);
    if (!base) return null;
    const parts = String(rec.f || '').split('/');
    if (parts.length !== 2 || !Object.values(KIND_DIRS).includes(parts[0]) || !safeFileName(parts[1])) return null;
    return path.join(base, ...parts);
  }

  async function copyIn(f, dir) {
    fs.mkdirSync(dir, { recursive: true });
    const q = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder || '', type: 'output' });
    let r;
    try { r = await fetchImpl(`${getComfyUrl()}/view?${q}`, { signal: AbortSignal.timeout(120000) }); } catch (e) { throw Object.assign(new Error(`ComfyUI did not send ${f.filename}: ${e.message}`), { retry: true }); }
    if (r.status === 404) throw Object.assign(new Error(`${f.filename} is no longer in ComfyUI's output folder`), { gone: true });
    if (!r.ok || !r.body) throw Object.assign(new Error(`ComfyUI did not send ${f.filename} (HTTP ${r.status})`), { retry: true });
    const out = openUnique(dir, f.filename);
    try { await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(out.full, { fd: out.fd })); } catch (e) { try { fs.unlinkSync(out.full); } catch {} throw Object.assign(new Error(`Copy failed: ${e.message}`), { retry: true }); }
    return out.name;
  }

  function moveTo(src, dir, name) {
    fs.mkdirSync(dir, { recursive: true });
    const out = openUnique(dir, name); // reserves a free name ("name (2).png")
    fs.closeSync(out.fd);
    try { fs.renameSync(src, out.full); } catch (e) {
      if (e.code !== 'EXDEV') { try { fs.unlinkSync(out.full); } catch {} throw e; }
      fs.copyFileSync(src, out.full); fs.unlinkSync(src);
    }
    return out.name;
  }

  /** One pass: file what is not filed yet, move what changed project. */
  async function tick() {
    if (busy) { again = true; return status(); }
    busy = true;
    try {
      if (!projects.available()) { lastError = 'Google Drive is not available'; return status(); }
      projects.scan(); // re-links moved / renamed project folders (at most once a minute)
      if (Date.now() - lastVerify > verifyMs) { lastVerify = Date.now(); await verify(); }
      const historyFiles = new Set(historyOutputs(history).map((f) => `${f.subfolder}/${f.filename}`));
      let budget = perTick;
      for (const e of [...history.data.entries]) {
        if (budget <= 0) { again = true; break; }
        const want = e.project ?? null;
        for (const f of outputsOf(e)) {
          if (budget <= 0) break;
          const key = fileKey(f), rec = e.filed?.[key];
          if (rec && rec.s !== 'ok') continue;
          if (rec && (rec.p ?? null) === want) continue;
          const base = projects.outputsDir(want);
          if (!base) continue; // the project folder is lost for now: wait
          const dir = path.join(base, KIND_DIRS[driveKind(f)] || KIND_DIRS.image);
          if (!rec && checkAppOutput(f, { outputSubfolder, historyFiles })) continue;
          budget--;
          try {
            if (!rec) {
              const name = await copyIn(f, dir);
              await history.setFiled(e.id, key, { p: want, f: `${path.basename(dir)}/${name}`, s: 'ok' });
            } else {
              const src = pathOf(rec);
              if (!src) continue; // its old project is lost: move it once that is found again
              if (!exists(src)) { await history.setFiled(e.id, key, { ...rec, s: 'missing' }); continue; }
              const name = moveTo(src, dir, path.basename(src));
              await history.setFiled(e.id, key, { p: want, f: `${path.basename(dir)}/${name}`, s: 'ok' });
            }
            lastError = null;
          } catch (err) {
            if (err.gone) await history.setFiled(e.id, key, { p: want, f: '', s: 'gone' });
            else { lastError = err.message; log(`filer: ${err.message}`); if (err.retry) return status(); }
          }
        }
      }
    } finally {
      busy = false;
      if (again) { again = false; timer && setTimeout(() => tick().catch(() => {}), 1000); }
    }
    return status();
  }

  /** Marks filed copies that were moved / renamed / deleted in Drive as missing. */
  async function verify() {
    for (const e of [...history.data.entries]) {
      for (const [key, rec] of Object.entries(e.filed || {})) {
        if (rec.s !== 'ok') continue;
        const p = pathOf(rec);
        if (p && !exists(p)) await history.setFiled(e.id, key, { ...rec, s: 'missing' });
      }
    }
  }

  /** Delete the filed copies of these files of an entry (Drive for Desktop -> Drive trash). */
  async function trash(entry, files) {
    let n = 0;
    for (const f of files) {
      const rec = entry.filed?.[fileKey(f)];
      if (!rec || rec.s !== 'ok') continue;
      const p = pathOf(rec);
      if (!p) continue;
      try { fs.unlinkSync(p); n++; } catch (e) { if (e.code !== 'ENOENT') log(`filer: could not delete ${p}: ${e.message}`); }
    }
    return n;
  }

  function status() {
    let waiting = 0, filed = 0, missing = 0;
    for (const e of history.data.entries) for (const f of outputsOf(e)) {
      const rec = e.filed?.[fileKey(f)];
      if (!rec || (rec.s === 'ok' && (rec.p ?? null) !== (e.project ?? null))) waiting++;
      else if (rec.s === 'ok') filed++;
      else if (rec.s === 'missing') missing++;
    }
    return { available: projects.available(), waiting, filed, missing, error: lastError };
  }

  return {
    tick, verify, trash, status, pathOf,
    kick() { setTimeout(() => tick().catch((e) => log(`filer: ${e.message}`)), 50); },
    start() { if (!timer) { timer = setInterval(() => tick().catch((e) => log(`filer: ${e.message}`)), intervalMs); this.kick(); } },
    stop() { clearInterval(timer); timer = null; },
  };
}
