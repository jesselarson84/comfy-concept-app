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
export const getWorkflows = () => req('GET', '/api/workflows').then((d) => d.workflows);
export function importWorkflow(file) {
  const fd = new FormData();
  fd.append('file', file, file.name);
  return req('POST', '/api/workflows', fd);
}
export const getHistory = (favoritesOnly) => req('GET', '/api/history' + (favoritesOnly ? '?favorites=1' : '')).then((d) => d.sessions);
export const addHistory = (entry) => req('POST', '/api/history', entry);
export const patchHistory = (id, patch) => req('PATCH', `/api/history/${encodeURIComponent(id)}`, patch);
