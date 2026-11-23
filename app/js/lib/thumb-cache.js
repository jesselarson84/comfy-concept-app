// thumb-cache.js - rendered 3D preview stills, kept in this device's IndexedDB
// ("conceptThumbs" / "glb", key = "subfolder/filename#v", value = PNG Blob), so a
// model is rendered once and never again. Nothing is written to the PC or to
// ComfyUI's output folders. Falls back to memory when IndexedDB is unavailable.
const DB = 'conceptThumbs', STORE = 'glb', VERSION = 1;
const mem = new Map();
let dbp = null;

// v (prompt id / mtime, see comfy-client.js viewUrl): a reused file name is a new model.
export const thumbKey = (f) => `${f?.subfolder || ''}/${f?.filename || ''}${f?.v ? '#' + f.v : ''}`;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      const r = indexedDB.open(DB, VERSION);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
      r.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbp;
}

function tx(db, mode, fn) {
  return new Promise((resolve) => {
    try {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req?.result);
      t.onerror = t.onabort = () => resolve(undefined);
    } catch { resolve(undefined); }
  });
}

export async function getThumb(key) {
  if (mem.has(key)) return mem.get(key);
  const db = await open();
  const v = db ? await tx(db, 'readonly', (s) => s.get(key)) : undefined;
  if (v) mem.set(key, v);
  return v || null;
}

export async function putThumb(key, blob) {
  mem.set(key, blob);
  const db = await open();
  if (db) await tx(db, 'readwrite', (s) => s.put(blob, key));
}

export async function deleteThumb(key) {
  mem.delete(key);
  const db = await open();
  if (db) await tx(db, 'readwrite', (s) => s.delete(key));
}
