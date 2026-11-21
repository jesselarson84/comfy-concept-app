// chats.js - Chat tab conversations, stored on the PC in data/chats.json
// (next to history.json, same style: atomic write = temp file + rename).
// -----------------------------------------------------------------------------
// A chat: { id, title, model, createdAt, updatedAt, messages: [
//   { role: 'user'|'assistant', content, images?: [{filename, subfolder, type}], at } ] }
// Attached images are stored as ComfyUI references (like history), never as
// bytes: the browser fetches them from /comfy/view when it sends them to the
// model. Deleting chats.json deletes no images.
// -----------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_MESSAGES = 400;
const MAX_CONTENT = 32 * 1024;

export class ChatStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'chats.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.data = this.#load();
    this.writing = Promise.resolve();
  }

  #load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(d.chats)) return d;
    } catch (e) {
      if (e.code !== 'ENOENT') { try { fs.renameSync(this.file, this.file + '.corrupt-' + Date.now()); } catch {} }
    }
    return { version: 1, chats: [] };
  }

  #save() {
    const json = JSON.stringify(this.data, null, 1);
    this.writing = this.writing.then(async () => {
      const tmp = this.file + '.tmp';
      await fs.promises.writeFile(tmp, json);
      await fs.promises.rename(tmp, this.file);
    });
    return this.writing;
  }

  /** Newest first, without messages (for the chat list). */
  list() {
    return [...this.data.chats].sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ messages, ...c }) => ({ ...c, count: messages.length, preview: (messages.find((m) => m.role === 'user')?.content || '').slice(0, 80) }));
  }

  get(id) { return this.data.chats.find((c) => c.id === id) || null; }

  async create(input = {}) {
    const now = Date.now();
    const c = { id: 'c_' + crypto.randomUUID().slice(0, 12), title: cleanTitle(input.title), model: String(input.model || ''), createdAt: now, updatedAt: now, messages: sanitizeMessages(input.messages) };
    this.data.chats.push(c);
    await this.#save();
    return c;
  }

  async update(id, patch = {}) {
    const c = this.get(id);
    if (!c) return null;
    if ('title' in patch) c.title = cleanTitle(patch.title);
    if ('model' in patch) c.model = String(patch.model || '');
    if ('messages' in patch) c.messages = sanitizeMessages(patch.messages);
    c.updatedAt = Date.now();
    await this.#save();
    return c;
  }

  async remove(id) {
    const n = this.data.chats.length;
    this.data.chats = this.data.chats.filter((c) => c.id !== id);
    if (this.data.chats.length === n) return false;
    await this.#save();
    return true;
  }
}

function cleanTitle(t) { return String(t || 'New chat').replace(/\s+/g, ' ').trim().slice(0, 80) || 'New chat'; }

const shortStr = (v, n = 4000) => (typeof v === 'string' && v ? v.slice(0, n) : undefined);
const prim = (v) => ['string', 'number', 'boolean'].includes(typeof v);

function sanitizeMessages(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(-MAX_MESSAGES)
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => {
      const out = { role: m.role, content: m.content.slice(0, MAX_CONTENT), at: Number(m.at) || Date.now() };
      // Attached images: ComfyUI references + the context the model saw.
      const imgs = Array.isArray(m.images) ? m.images.filter((i) => i && typeof i.filename === 'string').slice(0, 4)
        .map((i) => ({
          ref: shortStr(i.ref, 20), filename: i.filename, subfolder: String(i.subfolder || ''), type: ['output', 'input', 'temp'].includes(i.type) ? i.type : 'output',
          prompt: shortStr(i.prompt), seed: Number.isFinite(i.seed) ? i.seed : undefined, preset: shortStr(i.preset, 200), historyId: shortStr(i.historyId, 40),
        })) : [];
      if (imgs.length) out.images = imgs;
      // Assistant extras: the prompt it proposed, whether it was applied, an action.
      if (m.role === 'assistant') {
        if (shortStr(m.prompt)) out.prompt = shortStr(m.prompt);
        if (shortStr(m.negative)) out.negative = shortStr(m.negative);
        if (shortStr(m.basePrompt)) out.basePrompt = shortStr(m.basePrompt);
        if (m.applied) out.applied = true;
        if (m.action && typeof m.action.action === 'string') {
          const params = {};
          for (const [k, v] of Object.entries(m.action.params || {}).slice(0, 12)) if (prim(v)) params[k] = v;
          out.action = { action: m.action.action.slice(0, 60), params, image_ref: shortStr(m.action.image_ref, 20) || null };
          if (['run', 'dismissed'].includes(m.actionState)) out.actionState = m.actionState;
        }
        // Builder card: the proposed blocks + the server's verdict (the graph is
        // never stored here; the server re-assembles and re-validates on Save/Test).
        if (m.builder && typeof m.builder === 'object' && Array.isArray(m.builder.blocks)) {
          const b = m.builder;
          out.builder = {
            name: shortStr(b.name, 80) || 'My setup', ok: !!b.ok,
            blocks: b.blocks.slice(0, 12).map((x) => ({ type: shortStr(x?.type, 30), params: Object.fromEntries(Object.entries(x?.params || {}).slice(0, 12).filter(([, v]) => prim(v))) })),
            errors: strList(b.errors), notes: strList(b.notes), summary: strList(b.summary),
            estMB: Number.isFinite(b.estMB) ? b.estMB : undefined, output: shortStr(b.output, 10),
            state: ['saved', 'discarded', 'tested'].includes(b.state) ? b.state : undefined, presetId: shortStr(b.presetId, 60),
          };
        }
      }
      return out;
    });
}

function strList(a) { return Array.isArray(a) ? a.filter((x) => typeof x === 'string').slice(0, 12).map((x) => x.slice(0, 400)) : []; }
