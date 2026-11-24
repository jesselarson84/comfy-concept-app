// history.js - generation history, stored on the PC in data/history.json.
// -----------------------------------------------------------------------------
// Only METADATA lives here (prompt, seed, preset, size, favourite, and the
// filename/subfolder/type that ComfyUI's /view needs). Image bytes stay in
// ComfyUI's output folder, so deleting this file never deletes images.
//
// Atomic writes: we write to history.json.tmp and then rename it over the real
// file. A rename is atomic on the same disk, so a crash mid-write leaves
// either the old file or the new one - never half a JSON file.
//
// Sessions: an entry joins the latest session if it was made within
// sessionGapMinutes of that session's last entry; otherwise a new session
// starts. This is device-independent: phone and tablet share sessions.
// -----------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { migrateHistoryEntry } from '../app/js/lib/legacy-presets.js';

export class HistoryStore {
  constructor(dataDir, { sessionGapMinutes = 90 } = {}) {
    this.file = path.join(dataDir, 'history.json');
    this.gapMs = sessionGapMinutes * 60 * 1000;
    fs.mkdirSync(dataDir, { recursive: true });
    this.data = this.#load();
    this.writing = Promise.resolve();
  }

  #load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(d.entries) && Array.isArray(d.sessions)) return d;
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // Corrupt file: keep it aside instead of silently overwriting.
        try { fs.renameSync(this.file, this.file + '.corrupt-' + Date.now()); } catch {}
      }
    }
    return { version: 1, sessions: [], entries: [] };
  }

  #save() {
    // Serialise writes so two quick POSTs can't interleave.
    const json = JSON.stringify(this.data, null, 1);
    this.writing = this.writing.then(async () => {
      const tmp = this.file + '.tmp';
      await fs.promises.writeFile(tmp, json);
      await fs.promises.rename(tmp, this.file);
    });
    return this.writing;
  }

  #sessionFor(now) {
    const last = this.data.sessions.at(-1);
    if (last && now - last.lastAt <= this.gapMs) { last.lastAt = now; return last; }
    const s = { id: 's_' + crypto.randomUUID().slice(0, 8), startedAt: now, lastAt: now };
    this.data.sessions.push(s);
    return s;
  }

  async add(input, { sessionId = null } = {}) {
    const now = Number(input.createdAt) || Date.now();
    const pick = (k) => (input[k] === undefined ? undefined : input[k]);
    const e = {
      id: 'h_' + crypto.randomUUID().slice(0, 12),
      sessionId: sessionId || this.#sessionFor(now).id,
      createdAt: now,
      promptId: pick('promptId'),
      workflow: String(input.workflow || ''),
      prompt: String(input.prompt ?? ''),
      negative: pick('negative'),
      seed: pick('seed'),
      width: pick('width'), height: pick('height'), steps: pick('steps'), strength: pick('strength'),
      reference: pick('reference'),
      // Workflow actions (upscale, 3D...): which action, its params, and the
      // image it was run on, so results link back to their parent.
      action: pick('action'), params: pick('params'), parent: pick('parent'),
      images: sanitizeImages(input.images),
      files: sanitizeImages(input.files), // non-image outputs, e.g. a .glb
      favorite: !!input.favorite,
      status: input.status || (input.images?.length ? 'done' : 'queued'),
      // Batch 11: the project (projects.js id) it belongs to; null = Unsorted.
      // source: the History entry its reference picture came from ("Use as reference").
      project: typeof input.project === 'string' && input.project ? input.project : null,
      source: typeof input.source === 'string' && input.source ? input.source : undefined,
      // Batch 12: where the job came from when not this app's form ("desktop" ComfyUI, "schedule").
      origin: ['desktop', 'schedule'].includes(input.origin) ? input.origin : undefined,
    };
    this.data.entries.push(e);
    await this.#save();
    return e;
  }

  /**
   * Batch 12: a job recorded from outside the app's form (desktop ComfyUI, possibly
   * long ago): one "desktop" session, so old runs never reshuffle the app's sessions.
   */
  async addExternal(input) {
    const sid = 's_desktop';
    const at = Number(input.createdAt) || Date.now();
    let s = this.data.sessions.find((x) => x.id === sid);
    if (!s) { s = { id: sid, startedAt: at, lastAt: at }; this.data.sessions.unshift(s); }
    s.startedAt = Math.min(s.startedAt, at); s.lastAt = Math.max(s.lastAt, at);
    return this.add(input, { sessionId: sid });
  }

  async update(id, patch) {
    const e = this.data.entries.find((x) => x.id === id);
    if (!e) return null;
    if ('favorite' in patch) e.favorite = !!patch.favorite;
    if ('images' in patch) e.images = sanitizeImages(patch.images);
    if ('files' in patch) e.files = sanitizeImages(patch.files);
    if ('status' in patch) e.status = String(patch.status);
    await this.#save();
    return e;
  }

  /** Batch 9: tags from the background tagger (server/tagger.js). */
  async setTags(id, tags) {
    const e = this.data.entries.find((x) => x.id === id);
    if (!e) return null;
    e.tags = tags; delete e.tagFails;
    await this.#save();
    return e;
  }

  /** Batch 11: where one output file was filed on Drive (server/filer.js). */
  async setFiled(id, key, rec) {
    const e = this.data.entries.find((x) => x.id === id);
    if (!e) return null;
    e.filed = { ...(e.filed || {}), [key]: rec };
    await this.#save();
    return e;
  }

  /** Batch 11: move entries to a project (null = Unsorted); the filer moves their files. */
  async setProject(ids, project) {
    const set = new Set(ids);
    let n = 0;
    for (const e of this.data.entries) if (set.has(e.id) && (e.project ?? null) !== (project || null)) { e.project = project || null; n++; }
    if (n) await this.#save();
    return n;
  }

  /** The entries made from these ones (upscale / 3D of a picture, "Use as reference"), all the way down. */
  descendants(ids) {
    const all = new Set(ids);
    let grew = true;
    while (grew) {
      grew = false;
      for (const e of this.data.entries) {
        if (all.has(e.id)) continue;
        if ((e.parent?.historyId && all.has(e.parent.historyId)) || (e.source && all.has(e.source))) { all.add(e.id); grew = true; }
      }
    }
    return [...all];
  }

  /** A tagging attempt failed; after a few the entry is skipped. */
  async tagFailed(id, n = 1) {
    const e = this.data.entries.find((x) => x.id === id);
    if (!e) return null;
    e.tagFails = (e.tagFails || 0) + n;
    await this.#save();
    return e;
  }

  /** Newest session first, entries newest first. Entries made with a retired
   *  preset id come back mapped (copies; the stored data is never rewritten). */
  list({ favoritesOnly = false, only = null } = {}) {
    const bySession = new Map(this.data.sessions.map((s) => [s.id, { ...s, entries: [] }]));
    for (const e of this.data.entries) {
      if (favoritesOnly && !e.favorite) continue;
      if (only && !only.has(e.id)) continue;
      bySession.get(e.sessionId)?.entries.push(withViewVersion(migrateHistoryEntry(e)));
    }
    return [...bySession.values()].filter((s) => s.entries.length).reverse().map((s) => ({ ...s, entries: s.entries.reverse() }));
  }

  /** Removes entries (metadata only; files are deleted by the caller first). */
  async remove(ids) {
    const drop = new Set(ids);
    const before = this.data.entries.length;
    this.data.entries = this.data.entries.filter((e) => !drop.has(e.id));
    const used = new Set(this.data.entries.map((e) => e.sessionId));
    this.data.sessions = this.data.sessions.filter((s) => used.has(s.id) || s === this.data.sessions.at(-1));
    if (this.data.entries.length !== before) await this.#save();
    return before - this.data.entries.length;
  }

  get(id) { return this.data.entries.find((e) => e.id === id) || null; }

  pending() { return this.data.entries.filter((e) => e.promptId && !e.images.length && !e.files?.length && e.status !== 'error' && e.status !== 'cancelled'); }
}

/** Copy of an entry whose images/files carry v (prompt id, else entry id) for /view URLs. */
export function withViewVersion(e) {
  const v = e.promptId || e.id;
  if (!v) return e;
  const s = (list) => (Array.isArray(list) ? list.map((i) => (i && i.v == null ? { ...i, v: String(v) } : i)) : list);
  return { ...e, images: s(e.images), files: s(e.files) };
}

function sanitizeImages(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((i) => i && typeof i.filename === 'string').map((i) => ({
    filename: i.filename, subfolder: String(i.subfolder || ''), type: String(i.type || 'output'),
    ...(['3d', 'video', 'audio'].includes(i.kind) ? { kind: i.kind } : {}),
  }));
}
