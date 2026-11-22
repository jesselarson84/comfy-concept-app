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
export function importWorkflow(file) {
  const fd = new FormData();
  fd.append('file', file, file.name);
  return req('POST', '/api/workflows', fd);
}
export const getHistory = (favoritesOnly) => req('GET', '/api/history' + (favoritesOnly ? '?favorites=1' : '')).then((d) => d.sessions);
export const addHistory = (entry) => req('POST', '/api/history', entry);
export const patchHistory = (id, patch) => req('PATCH', `/api/history/${encodeURIComponent(id)}`, patch);
