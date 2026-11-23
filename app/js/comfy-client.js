// comfy-client.js - talking to ComfyUI (through this app's /comfy proxy).
// -----------------------------------------------------------------------------
// THE COMFYUI API FLOW, step by step:
//
// 1. Open a websocket:  ws(s)://<host>/comfy/ws?clientId=<our id>
//    The clientId is any unique string we pick. ComfyUI remembers it and
//    sends progress for jobs queued with that id only to this socket.
//
// 2. Queue a job:  POST /comfy/prompt  { "prompt": <API workflow>, "client_id": <same id> }
//    Answer: { "prompt_id": "uuid", "number": 7, "node_errors": {} }
//    The prompt_id is how every later message refers to this job.
//    A 400 answer means validation failed (missing model, bad value...) and
//    "node_errors" says which node.
//
// 3. Listen on the websocket (JSON text messages {type, data}):
//      status            queue length changed (data.status.exec_info.queue_remaining)
//      execution_start   our job started running        (data.prompt_id)
//      execution_cached  these nodes were reused from cache (data.nodes)
//      executing         now running node data.node; node === null => job finished
//      progress          data.value / data.max steps of the current node (the sampler)
//      executed          an output node finished: data.output.images = [{filename, subfolder, type}]
//      execution_success job done OK (newer ComfyUI)
//      execution_error   job failed (data.exception_message, data.node_type)
//      execution_interrupted  job was stopped by /interrupt
//    Binary messages are live preview JPEGs/PNGs; this app ignores them.
//
// 4. Show the image:  GET /comfy/view?filename=..&subfolder=..&type=output
//    (type is "output" for SaveImage, "temp" for PreviewImage, "input" for
//    uploads). Adding &preview=webp;70 asks ComfyUI for a smaller webp copy.
//
// 5. If we missed messages (phone slept, socket dropped):
//    GET /comfy/history/<prompt_id> returns { <prompt_id>: { outputs: {node: {images:[..]}}, status: {...} } }
//
// Cancel:  POST /comfy/queue { "delete": [prompt_id, ...] } removes pending
//          jobs; POST /comfy/interrupt { "prompt_id": id } stops the running one.
// Upload:  POST /comfy/upload/image (multipart "image") saves into ComfyUI/input
//          and returns { name, subfolder, type } - put "name" (or
//          "subfolder/name") into a LoadImage node's "image" input.
// -----------------------------------------------------------------------------

const BASE = '/comfy';

function getClientId() {
  // Kept per tab (sessionStorage) so a reload re-attaches to the same jobs.
  let id = sessionStorage.getItem('comfyClientId');
  if (!id) { id = crypto.randomUUID(); sessionStorage.setItem('comfyClientId', id); }
  return id;
}

export class ComfyClient extends EventTarget {
  constructor() {
    super();
    this.clientId = getClientId();
    this.ws = null;
    this.retry = 0;
    this.connected = false;
    this.timer = 0;
  }

  /** Back from the background (or the network came back): reconnect now
   *  instead of waiting out the back-off. A socket that is open stays, unless
   *  force (the page was hidden long enough that an "open" socket may be dead
   *  without knowing it yet). A socket stuck connecting for more than 3 s is
   *  replaced too. Returns true when a new socket was started. */
  reconnectNow({ force = false } = {}) {
    const ws = this.ws;
    const open = ws?.readyState === WebSocket.OPEN;
    const connecting = ws?.readyState === WebSocket.CONNECTING && Date.now() - (this.startedAt || 0) < 3000;
    if (!force && (open || connecting)) return false;
    clearTimeout(this.timer);
    this.retry = Math.max(1, this.retry); // counts as a reconnect: the queue resyncs from /history
    if (ws) { this.ws = null; try { ws.close(); } catch { /* already closing */ } } // its close event is ignored (replaced)
    this.connect();
    return true;
  }

  connect() {
    clearTimeout(this.timer);
    // Never two sockets for one client: the old one would deliver every message twice.
    if (this.ws) { const old = this.ws; this.ws = null; try { old.close(); } catch { /* closing */ } }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}${BASE}/ws?clientId=${encodeURIComponent(this.clientId)}`);
    this.ws = ws; this.startedAt = Date.now();
    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      const wasRetry = this.retry > 0;
      this.retry = 0; this.connected = true;
      this.dispatchEvent(new CustomEvent('connection', { detail: { connected: true, reconnected: wasRetry } }));
    });
    ws.addEventListener('message', (ev) => {
      if (this.ws !== ws) return; // a replaced socket
      if (typeof ev.data !== 'string') return; // binary preview frame
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      // Re-emit each ComfyUI message type as its own DOM event.
      this.dispatchEvent(new CustomEvent(msg.type, { detail: msg.data }));
      this.dispatchEvent(new CustomEvent('message', { detail: msg }));
    });
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return; // replaced by reconnectNow()
      this.connected = false;
      this.dispatchEvent(new CustomEvent('connection', { detail: { connected: false } }));
      // Reconnect with back-off (1s, 2s, 4s ... max 15s).
      const delay = Math.min(15000, 1000 * 2 ** this.retry++);
      this.timer = setTimeout(() => this.connect(), delay);
    });
  }

  async queuePrompt(workflow) {
    const r = await fetch(`${BASE}/prompt`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: this.clientId }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(describeError(data, r.status));
    return data; // { prompt_id, number, node_errors }
  }

  async history(promptId) {
    const r = await fetch(`${BASE}/history/${encodeURIComponent(promptId)}`);
    if (!r.ok) return null;
    return (await r.json())[promptId] || null;
  }

  /** prompt_ids still pending or running in ComfyUI's queue (a Set), or null. */
  async queueState() {
    const r = await fetch(`${BASE}/queue`);
    if (!r.ok) return null;
    const q = await r.json();
    return new Set([...(q.queue_running || []), ...(q.queue_pending || [])].map((e) => e?.[1]).filter(Boolean));
  }

  async deleteQueued(promptIds) {
    if (!promptIds.length) return;
    await fetch(`${BASE}/queue`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delete: promptIds }) });
  }

  async interrupt(promptId) {
    // Passing prompt_id makes newer ComfyUI only interrupt if that job is the
    // one running (older versions ignore the body and stop whatever runs).
    await fetch(`${BASE}/interrupt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(promptId ? { prompt_id: promptId } : {}) });
  }

  async uploadImage(file, filename) {
    const fd = new FormData();
    fd.append('image', file, filename || file.name || 'reference.png');
    fd.append('type', 'input');
    fd.append('overwrite', 'false');
    const r = await fetch(`${BASE}/upload/image`, { method: 'POST', body: fd });
    if (!r.ok) throw new Error(`Upload failed (${r.status})`);
    const d = await r.json();
    return { ...d, ref: d.subfolder ? `${d.subfolder}/${d.name}` : d.name };
  }
}

export function viewUrl(img, { thumb = false } = {}) {
  const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output' });
  // v: what makes this file unique (prompt id, or mtime for files found on disk).
  // ComfyUI reuses a deleted file's name (its counter restarts after the highest
  // file left), so filename alone can show a cached copy of an older image.
  if (img.v != null && img.v !== '') q.set('v', String(img.v));
  if (thumb) q.set('preview', 'webp;70');
  return `${BASE}/view?${q}`;
}

// Turns a LoadImage value like "sub/name.png" into a /view URL for the input folder.
export function inputViewUrl(ref) {
  const i = ref.lastIndexOf('/');
  return viewUrl({ filename: i >= 0 ? ref.slice(i + 1) : ref, subfolder: i >= 0 ? ref.slice(0, i) : '', type: 'input' });
}

function describeError(data, status) {
  // ComfyUI's 400: { error: {type, message, details}, node_errors: { id: { errors: [{message, details}], class_type } } }
  const parts = [];
  if (data?.error?.message) parts.push(data.error.message);
  for (const [id, ne] of Object.entries(data?.node_errors || {})) {
    for (const e of ne.errors || []) parts.push(`${ne.class_type || 'node'} #${id}: ${e.message}${e.details ? ' (' + e.details + ')' : ''}`);
  }
  return parts.join(' - ') || `ComfyUI rejected the job (${status})`;
}
