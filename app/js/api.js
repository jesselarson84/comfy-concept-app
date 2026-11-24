// api.js - calls to THIS app's server (/api/*): presets, history, config.
// (Calls to ComfyUI itself are in comfy-client.js.)
async function req(method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `${method} ${url} failed (${r.status})`);
  return data;
}
export const getConfig = () => req('GET', '/api/config');
export const getWorkflows = ({ fresh = false } = {}) => req('GET', '/api/workflows' + (fresh ? '?fresh=1' : '')).then((d) => d.workflows);
// Chat builder + saved setups ("My presets")
export const proposeSetup = (body) => req('POST', '/api/builder/propose', body);
export const checkSetup = (body) => req('POST', '/api/builder/check', body);
export const getBuilderConfig = () => req('GET', '/api/builder/config');
export const setBuilderModel = (model) => req('PUT', '/api/builder/config', { model });
export const saveUserPreset = (body) => req('POST', '/api/user-presets', body);
export const renameUserPreset = (id, name) => req('PATCH', `/api/user-presets/${encodeURIComponent(id)}`, { name });
export const deleteUserPreset = (id) => req('DELETE', `/api/user-presets/${encodeURIComponent(id)}`);
// Save as preset (node view): graphs saved into a picker section.
export const saveGraphPreset = (body) => req('POST', '/api/graph-presets', body);
export const updateGraphPreset = (id, patch) => req('PATCH', `/api/graph-presets/${encodeURIComponent(id)}`, patch);
export const deleteGraphPreset = (id) => req('DELETE', `/api/graph-presets/${encodeURIComponent(id)}`);
export function importWorkflow(file) {
  const fd = new FormData();
  fd.append('file', file, file.name);
  return req('POST', '/api/workflows', fd);
}
export const getHistory = (favoritesOnly, folder) => req('GET', '/api/history' + (folder ? `?folder=${encodeURIComponent(folder)}` : favoritesOnly ? '?favorites=1' : '')).then((d) => d.sessions);
// History multi-select (batch 3): delete from the PC, folders (labels only).
export const deleteHistory = (ids) => req('POST', '/api/history/delete', { ids });
export const getFolders = () => req('GET', '/api/folders');
export const createFolder = (name) => req('POST', '/api/folders', { name });
export const addToFolder = (id, ids) => req('POST', `/api/folders/${encodeURIComponent(id)}/items`, { add: ids });
export const removeFromFolder = (id, ids) => req('POST', `/api/folders/${encodeURIComponent(id)}/items`, { remove: ids });
export const renameFolder = (id, name) => req('PATCH', `/api/folders/${encodeURIComponent(id)}`, { name });
export const deleteFolder = (id) => req('DELETE', `/api/folders/${encodeURIComponent(id)}`);
export const addHistory = (entry) => req('POST', '/api/history', entry);
export const patchHistory = (id, patch) => req('PATCH', `/api/history/${encodeURIComponent(id)}`, patch);
// The app's results on the PC ("From Comfy UI") and Save to Drive.
export const getOutputs = ({ kind, offset = 0, limit = 60 } = {}) => req('GET', `/api/outputs?${new URLSearchParams({ ...(kind ? { kind } : {}), offset, limit })}`);
// Memory switches (batch 3): CPU text encoder, Ollama CPU mode.
export const getMemorySettings = () => req('GET', '/api/memory/settings');
export const setMemorySettings = (patch) => req('POST', '/api/memory/settings', patch);
export const saveToDrive = (f, kind, folder) => req('POST', '/api/drive/save', { filename: f.filename, subfolder: f.subfolder || '', type: f.type || 'output', ...(kind ? { kind } : {}), ...(typeof folder === 'string' ? { folder } : {}) });
// Batch 8: Save to… folder chooser (folders of My Drive).
export const getDriveFolders = (path = '') => req('GET', `/api/drive/folders?${new URLSearchParams({ path })}`);
export const makeDriveFolder = (path, name) => req('POST', '/api/drive/folders', { path, name });
// Batch 11: projects (folders under Creative/PROJECTS/ACTIVE on Drive).
export const getProjects = () => req('GET', '/api/projects');
export const browseProjects = (path = '') => req('GET', `/api/projects/browse?${new URLSearchParams({ path })}`);
export const markProject = (path) => req('POST', '/api/projects', { path });
export const newProject = (name, parent = '') => req('POST', '/api/projects/new', { name, parent });
export const setCurrentProject = (id) => req('POST', '/api/projects/current', { id: id || null });
export const moveToProject = (ids, project) => req('POST', '/api/projects/move', { ids, project: project || null });
// Batch 9: History tags (background tagger) and the stills it reads for 3D / video.
export const getTagger = () => req('GET', '/api/tagger');
export const setTagger = (enabled) => req('POST', '/api/tagger', { enabled });
export async function uploadPreview(id, blob) {
  const r = await fetch(`/api/history/${encodeURIComponent(id)}/preview`, { method: 'POST', headers: { 'Content-Type': blob.type || 'image/jpeg' }, body: blob });
  if (!r.ok) throw new Error(`Preview upload failed (${r.status})`);
  return r.json();
}
