// chat-panel.js - the Prompt assistant: a conversation with a local Ollama
// model, on the same screen as (and tied to) the prompt box.
// -----------------------------------------------------------------------------
// * The prompt box is the single source of truth. Every turn sends what is in
//   it right now (plus the negative if switched on) - see lib/chat-context.js.
// * The model answers JSON (Ollama `format` = schema): reply text, maybe a
//   complete new prompt, maybe a workflow action. lib/chat-reply.js parses it
//   with fallbacks; a reply that cannot be parsed is shown as chat only.
// * A proposed prompt is shown as a word diff against the box with ONE-TAP
//   Apply (not auto-apply: the box may hold edits you made meanwhile, and small
//   models sometimes drop details). Apply keeps the old text in Versions/Undo.
//   "Apply + Generate" also queues a batch; "same seed" re-runs the discussed
//   image's seed so only the prompt change shows.
// * Discuss (viewer button) attaches that image as imgN with its prompt and
//   seed; the next message sends it as base64 JPEG to a vision model.
// * Actions (upscale, 3D...) are only ever ready-made workflows from
//   workflows/actions/; the model picks one + params, the app clamps them and
//   shows a confirm chip. Nothing runs until you tap Run.
// * Setup builder: "make a setup / workflow / pipeline ..." (or /build ...) goes
//   to the server's guarded builder. The model may only propose TESTED BLOCKS;
//   the server assembles + validates the graph against ComfyUI's live
//   /object_info and installed models, then the chat shows a plain summary
//   card: Test run (reduced size, not saved) / Save as preset / Discard.
//   Rejected setups show the plain reason. Nothing runs or is saved by itself.
// * When a reply comes with an action to confirm, its text is rewritten to the
//   conditional ("I would upscale it"), never "I have increased the resolution".
// * Chats are saved on the PC in data/chats.json (via /api/chats).
// -----------------------------------------------------------------------------
import { h, toast } from './dom.js';
import { viewUrl } from '../comfy-client.js';
import * as ollama from '../ollama-client.js';
import { parseReply, replySchema, proposalTense, stripPraise } from '../lib/chat-reply.js';
import { isBuilderRequest } from '../lib/builder.js';
import * as api from '../api.js';
import { buildMessages } from '../lib/chat-context.js';
import { diffWords } from '../lib/prompt-diff.js';
import { resolveChoice, describeChoice } from '../lib/actions.js';

const OPEN_KEY = 'conceptChat.open';
const MODEL_KEY = 'conceptChat.model';
const CHAT_KEY = 'conceptChat.id';

async function jreq(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `${method} ${url} failed (${r.status})`);
  return d;
}

export class ChatPanel {
  /**
   * @param mount     element to build into (under the prompt box)
   * @param o.getContext()  { prompt, negative, negativeOn, hasNegative, preset, workflow }
   * @param o.versions      PromptVersions (apply / undo)
   * @param o.onGenerate({ seed })   queue a batch with the current workflow (seed: number = locked)
   * @param o.onRunAction(resolved)  queue a workflow action
   */
  constructor(mount, o) {
    Object.assign(this, { getContext: o.getContext, versions: o.versions, onGenerate: o.onGenerate, onRunAction: o.onRunAction, onTestRun: o.onTestRun, onSavedPreset: o.onSavedPreset });
    this.messages = []; this.images = {}; this.lastRef = null; this.pending = null;
    this.chatId = localStorage.getItem(CHAT_KEY) || null;
    this.models = []; this.model = localStorage.getItem(MODEL_KEY) || ''; this.vision = false;
    this.actions = []; this.busy = null; this.online = false;
    this.#build(mount);
  }

  #build(mount) {
    this.status = h('span.chat-status.muted');
    this.modelSel = h('select.chat-model', { 'aria-label': 'Ollama model', onchange: () => this.#pickModel(this.modelSel.value) });
    this.threadSel = h('select.chat-thread', { 'aria-label': 'Conversation', onchange: () => this.load(this.threadSel.value) });
    this.offline = h('div.chat-offline', { hidden: true },
      h('strong', {}, 'Ollama is offline. '), h('span.chat-offline-msg'), ' ',
      h('button.btn', { type: 'button', onclick: () => this.refresh() }, 'Retry'));
    this.log = h('div.chat-log', { 'aria-live': 'polite' });
    this.attach = h('div.chat-attach', { hidden: true });
    this.input = h('textarea.chat-input', { rows: 2, placeholder: 'Describe an idea, or tell it what to change…', enterkeyhint: 'send' });
    this.input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.send(); } });
    this.sendBtn = h('button.btn.icon.chat-send', { type: 'button', 'aria-label': 'Send', title: 'Send', onclick: () => this.send() }, h('i.i.i-arrow-up'));
    this.stopBtn = h('button.btn.danger.chat-stop', { type: 'button', hidden: true, onclick: () => this.busy?.abort() }, 'Stop');
    this.root = h('details.chat', {},
      h('summary', {}, h('i.i.i-sparkles'), h('span', {}, 'Prompt assistant'), ' ', this.status, h('i.i.i-chevron-down.chat-chev')),
      h('div.chat-bar', {}, this.modelSel, this.threadSel, h('button.btn.text', { type: 'button', onclick: () => this.newChat() }, h('i.i.i-plus'), 'New chat')),
      this.offline, this.log, this.attach,
      h('div.chat-compose', {}, this.input, this.sendBtn, this.stopBtn));
    this.root.id = 'chat';
    this.root.open = localStorage.getItem(OPEN_KEY) === '1';
    this.root.addEventListener('toggle', () => { localStorage.setItem(OPEN_KEY, this.root.open ? '1' : '0'); if (this.root.open && !this.started) this.start(); });
    mount.replaceChildren(this.root);
    if (this.root.open) this.start();
  }

  async start() {
    this.started = true;
    await this.refresh();
    await this.#loadThreads();
    if (this.chatId) await this.load(this.chatId, true); else this.render();
  }

  open() { if (!this.root.open) this.root.open = true; if (!this.started) return this.start(); }

  // ---- models, actions, offline state ---------------------------------------
  async refresh() {
    try {
      this.models = await ollama.listModels();
      this.online = true;
      this.offline.hidden = true;
      this.modelSel.replaceChildren(...this.models.map((m) => new Option(m.name, m.name)));
      if (!this.models.length) { this.#setOffline('Ollama is running but has no models. Pull one (e.g. gemma3:4b) on the PC.'); return; }
      await this.#fitModels();
      const usable = this.models.filter((m) => !m.unusable);
      await this.#pickModel(usable.some((m) => m.name === this.model) ? this.model : (usable[0] || this.models[0]).name);
    } catch (e) {
      this.online = false;
      this.#setOffline(e instanceof ollama.OllamaOffline ? 'Start Ollama on the PC (it listens on 127.0.0.1:11434), then tap Retry.' : e.message);
    }
    try { this.actions = ((await jreq('GET', '/api/actions')).actions || []).filter((a) => a.ok); } catch { this.actions = []; }
    this.#paintState();
  }

  // Fit of each model on THIS PC's GPU/RAM (server: /api/memory, memory profile).
  async #fitModels() {
    let s; try { s = await ollama.memoryStatus(); } catch { return; }
    this.memory = s;
    for (const m of this.models) {
      const f = s.models?.find((x) => x.name === m.name);
      if (!f) continue;
      m.fit = f; m.unusable = f.fit === 'no-fit' || f.fit === 'too-big';
      const opt = [...this.modelSel.options].find((o) => o.value === m.name);
      if (!opt) continue;
      opt.textContent = m.name + (f.fit === 'partial' ? ' - slower, partly in RAM' : m.unusable ? " - won't fit" : '');
      opt.title = f.message; opt.disabled = m.unusable;
    }
    this.#paintBadge(s);
  }
  async #refreshBadge() { try { this.#paintBadge(await ollama.memoryStatus()); } catch {} }
  #paintBadge(s) {
    const l = s?.ollama?.loaded?.find((x) => x.name === this.model);
    this.badge = l?.badge?.text || null;
    this.#paintState();
  }

  #setOffline(msg) {
    this.offline.hidden = false;
    this.offline.querySelector('.chat-offline-msg').textContent = msg;
    this.modelSel.hidden = !this.models.length;
    this.#paintState();
  }

  async #pickModel(name) {
    this.model = name; this.modelSel.value = name; this.badge = null;
    localStorage.setItem(MODEL_KEY, name);
    const known = this.models.find((m) => m.name === name);
    this.vision = known?.capabilities ? known.capabilities.includes('vision') : (await ollama.modelInfo(name)).vision;
    if (known && !known.capabilities) known.capabilities = this.vision ? ['vision'] : [];
    this.#paintAttach(); this.#paintState();
  }

  #paintState(text) {
    const ready = this.online && this.models.length;
    this.status.textContent = text ?? (this.busy ? '' : ready ? `· ${this.model}${this.vision ? ' (sees images)' : ''}${this.badge ? ` · ${this.badge}` : ''}` : '· offline');
    this.status.classList.toggle('is-partial', !!this.badge);
    this.sendBtn.disabled = !ready || !!this.busy;
    this.sendBtn.hidden = !!this.busy; this.stopBtn.hidden = !this.busy;
    this.root.classList.toggle('is-offline', !ready);
  }

  // ---- conversations (data/chats.json on the PC) ---------------------------
  async #loadThreads() {
    let list = [];
    try { list = (await jreq('GET', '/api/chats')).chats; } catch {}
    this.threadSel.replaceChildren(new Option('New conversation', ''), ...list.map((c) => new Option(c.title, c.id)));
    this.threadSel.value = this.chatId && list.some((c) => c.id === this.chatId) ? this.chatId : '';
    this.threadSel.hidden = !list.length;
  }

  async load(id, quiet) {
    if (!id) return this.newChat();
    try {
      const c = await jreq('GET', `/api/chats/${encodeURIComponent(id)}`);
      this.chatId = c.id; localStorage.setItem(CHAT_KEY, c.id);
      this.messages = c.messages; this.images = {}; this.lastRef = null; this.pending = null;
      for (const m of this.messages) for (const i of m.images || []) if (i.ref) { this.images[i.ref] = i; this.lastRef = i.ref; }
      if (c.model && this.models.some((m) => m.name === c.model)) await this.#pickModel(c.model);
    } catch (e) { if (!quiet) toast(e.message); this.chatId = null; localStorage.removeItem(CHAT_KEY); this.messages = []; }
    this.threadSel.value = this.chatId || '';
    this.render();
  }

  newChat() {
    this.chatId = null; localStorage.removeItem(CHAT_KEY);
    this.messages = []; this.images = {}; this.lastRef = null; this.pending = null;
    this.threadSel.value = '';
    this.render();
  }

  async save() {
    const body = { model: this.model, messages: this.messages };
    try {
      if (!this.chatId) {
        const first = this.messages.find((m) => m.role === 'user')?.content || 'New chat';
        const c = await jreq('POST', '/api/chats', { ...body, title: first.slice(0, 60) });
        this.chatId = c.id; localStorage.setItem(CHAT_KEY, c.id);
        await this.#loadThreads();
      } else await jreq('PUT', `/api/chats/${encodeURIComponent(this.chatId)}`, body);
    } catch (e) { toast('Chat not saved: ' + e.message); }
  }

  // ---- image feedback (viewer "Discuss") -------------------------------------
  /** item = viewer item { image, meta: { prompt, seed, workflow }, historyId } */
  discuss(item) {
    if (!item?.image) return;
    let ref = Object.keys(this.images).find((k) => this.images[k].filename === item.image.filename && this.images[k].subfolder === (item.image.subfolder || ''));
    if (!ref) {
      ref = 'img' + (Object.keys(this.images).length + 1);
      this.images[ref] = { ref, filename: item.image.filename, subfolder: item.image.subfolder || '', type: item.image.type || 'output', prompt: item.meta?.prompt, seed: item.meta?.seed, preset: item.meta?.legacyWorkflow || item.meta?.workflow, historyId: item.historyId };
    }
    this.pending = ref; this.lastRef = ref;
    this.open();
    this.#paintAttach();
    this.input.placeholder = 'What should change? e.g. "looks like a swan, not a duck"';
    this.root.scrollIntoView({ block: 'nearest' });
    setTimeout(() => this.input.focus(), 50);
  }

  #paintAttach() {
    const i = this.pending && this.images[this.pending];
    this.attach.hidden = !i;
    if (!i) return;
    this.attach.replaceChildren(
      h('img', { src: viewUrl(i, { thumb: true }), alt: '' }),
      h('span', {}, `${i.ref}${i.seed !== undefined ? ` · seed ${i.seed}` : ''}`, this.vision ? '' : h('span.muted', {}, ' (this model cannot see images: only its prompt and seed are sent)')),
      h('button.link', { type: 'button', 'aria-label': 'Remove image', onclick: () => { this.pending = null; this.#paintAttach(); } }, '✕'));
  }

  // ---- one turn ---------------------------------------------------------------
  async send(textArg) {
    const text = (textArg ?? this.input.value).trim();
    if (!text || this.busy) return;
    if (isBuilderRequest(text)) return this.build(text);
    if (!this.online) { await this.refresh(); if (!this.online) return; }
    // Memory profile: refuse a model that would swap to disk; on small GPUs ask
    // ComfyUI to free VRAM first when it is low (server side, see memory.js).
    const prep = await ollama.prepareChat(this.model);
    if (prep && prep.ok === false) { this.#note(`${this.model}: ${prep.message}. Pick a smaller model.`); return; }
    const ctx = this.getContext();
    const img = this.pending ? this.images[this.pending] : null;
    let newImages = [];
    if (img && this.vision) {
      try { newImages = [{ ref: img.ref, base64: await ollama.imageToBase64(viewUrl(img)) }]; } catch (e) { toast('Could not attach the image: ' + e.message); }
    }
    const userMsg = { role: 'user', content: text, at: Date.now(), images: img ? [img] : undefined };
    const messages = buildMessages({
      current: ctx, images: this.images, actions: this.actions, userText: text, newImages,
      history: this.messages.map((m) => ({ role: m.role, content: m.content, prompt: m.prompt, negative: m.negative, action: m.action, images: m.images?.map((i) => i.ref) })),
    });
    this.messages.push(userMsg);
    this.input.value = ''; this.pending = null; this.#paintAttach();
    this.input.placeholder = 'Describe an idea, or tell it what to change…';
    this.render();
    const ctrl = new AbortController();
    this.busy = ctrl; this.#paintState();
    const warm = await ollama.isLoaded(this.model);
    const thinking = this.#thinking(warm ? 'Thinking…' : `Warming up ${this.model}… the first reply after a while can take 30-40 s while it loads into memory.${prep?.freed?.ok ? ' (ComfyUI freed GPU memory for it.)' : ''}${prep?.fit === 'partial' ? ' It runs partly in RAM, so it is slower.' : ''}`);
    const req = { model: this.model, messages, format: replySchema(this.actions), options: { temperature: 0.4 }, keep_alive: prep?.keepAlive, signal: ctrl.signal, onChunk: (s) => thinking(`Writing… ${s.length} chars`) };
    let res;
    try {
      try { res = await ollama.chat(req); } catch (e) {
        if (ctrl.signal.aborted || !ollama.isMemoryError(e.message)) throw e;
        // Not enough VRAM to load the model: ask ComfyUI to unload its models
        // (an API call - ComfyUI keeps running) and try once more.
        thinking('Not enough GPU memory - asking ComfyUI to free its models, then retrying…');
        await ollama.freeComfyVram().catch(() => {});
        res = await ollama.chat(req);
      }
    } catch (e) {
      thinking(null);
      this.busy = null; this.#paintState();
      if (ctrl.signal.aborted) { this.#note('Stopped.'); return; }
      if (e instanceof ollama.OllamaOffline) { this.online = false; this.#setOffline('Ollama stopped answering. Start it on the PC, then tap Retry.'); }
      this.#note('Error: ' + e.message);
      return;
    }
    thinking(null);
    this.busy = null; this.#paintState();
    this.#refreshBadge();
    const p = parseReply(res.content, { prompt: ctx.prompt, negative: ctx.negativeOn ? ctx.negative : '' });
    // An action still needs the user's Run: the text must not claim it already happened.
    const msg = { role: 'assistant', content: p.action ? proposalTense(p.reply) : p.reply, at: Date.now(), basePrompt: ctx.prompt };
    if (p.prompt) msg.prompt = p.prompt;
    if (p.negative && ctx.hasNegative) msg.negative = p.negative;
    if (p.action) msg.action = p.action;
    this.messages.push(msg);
    this.lastParse = p;
    this.render();
    await this.save();
  }

  #thinking(text) {
    let el = this.log.querySelector('.chat-thinking');
    const set = (t) => {
      el = this.log.querySelector('.chat-thinking');
      if (t === null) { el?.remove(); this.#paintState(); return; }
      if (!el) { el = h('div.chat-msg.assistant.chat-thinking'); this.log.append(el); }
      el.textContent = t; this.status.textContent = '· ' + t.split('…')[0] + '…';
      this.log.scrollTop = this.log.scrollHeight;
    };
    set(text);
    return set;
  }

  #note(text) { this.log.append(h('div.chat-note.muted', {}, text)); this.log.scrollTop = this.log.scrollHeight; }

  // ---- rendering ------------------------------------------------------------
  render() {
    const els = this.messages.map((m, i) => (m.role === 'user' ? this.#userEl(m) : this.#assistantEl(m, i)));
    if (!els.length) els.push(h('p.chat-empty.muted', {}, 'Ask for ideas or a prompt, or open an image and tap Discuss to fix what it got wrong. Proposed prompts appear with a diff and an Apply button.'));
    this.log.replaceChildren(...els);
    this.log.scrollTop = this.log.scrollHeight;
  }

  #userEl(m) {
    return h('div.chat-msg.user', {}, m.content,
      (m.images || []).map((i) => h('span.chat-img', {}, h('img', { src: viewUrl(i, { thumb: true }), alt: '' }), i.ref || '')));
  }

  #assistantEl(m, i) {
    const box = h('div.chat-msg.assistant', {}, h('div.chat-text', {}, m.content));
    if (m.prompt) box.append(this.#proposalEl(m));
    const actionEl = m.action ? this.#actionEl(m, this.messages[i - 1]?.content || '') : null;
    if (actionEl) box.append(actionEl);
    if (m.builder) box.append(this._builderEl(m));
    // Small models sometimes say "I revised the prompt" but send it back unchanged (seen live).
    if (!m.prompt && !m.negative && !m.action && /\b(?:revised|adjusted|updated|changed|added|modified|rewrote|replaced|removed)\b/i.test(m.content || '')) {
      box.append(h('div.chat-note.muted.chat-unchanged', {}, 'The model sent the prompt back unchanged, so the prompt box was not touched. Ask again, or say exactly what to change.'));
    }
    return box;
  }

  #proposalEl(m) {
    const ctx = this.getContext();
    const base = m.applied ? (m.basePrompt || '') : ctx.prompt;
    // Keep a visible gap between neighbouring segments ("duck" + "purple" must not read "duckpurple").
    const parts = [];
    for (const d of diffWords(base, m.prompt)) {
      const prev = parts.length ? parts[parts.length - 1].text : '';
      if (prev && !/\s$/.test(prev) && !/^\s/.test(d.text)) parts.push({ op: 'same', text: ' ' });
      parts.push(d);
    }
    const diff = h('div.chat-diff', {}, parts.map((d) => (d.op === 'same' ? d.text : h(d.op === 'add' ? 'ins' : 'del', {}, d.text))));
    const seed = this.images[this.lastRef]?.seed;
    const buttons = m.applied
      ? [h('span.chat-applied', {}, 'Applied ✓'), h('button.link', { type: 'button', onclick: () => { if (this.versions.undo()) { m.applied = false; this.render(); this.save(); toast('Prompt restored'); } } }, 'Undo')]
      : [
        h('button.btn.primary', { type: 'button', onclick: () => this.apply(m) }, 'Apply'),
        h('button.btn', { type: 'button', onclick: () => this.apply(m, { generate: true }) }, 'Apply + Run (new seed)'),
        seed !== undefined && seed !== null ? h('button.btn', { type: 'button', title: 'Re-run the discussed image\'s seed so only the prompt change shows', onclick: () => this.apply(m, { generate: true, seed }) }, `Apply + same seed ${seed}`) : null,
      ];
    return h('div.chat-proposal', {}, h('div.label', {}, m.applied ? 'Prompt (applied)' : 'Proposed prompt - changes vs the box'), diff,
      m.negative ? h('div.chat-neg', {}, h('span.label', {}, 'Negative '), m.negative) : null,
      h('div.chat-buttons', {}, buttons));
  }

  apply(m, { generate = false, seed } = {}) {
    this.versions.apply(m.prompt, m.negative ?? null, 'chat');
    m.applied = true;
    this.render(); this.save();
    if (generate) this.onGenerate({ seed });
    else toast('Prompt updated (Undo is under the prompt box)');
  }

  #actionEl(m, userText) {
    const r = resolveChoice(m.action, this.actions, this.images, this.lastRef, userText);
    const wrap = h('div.chat-action');
    if (r.unasked) return null;
    if (!r.ok) { wrap.append(h('span.muted', {}, r.error)); return wrap; }
    const img = r.image;
    wrap.append(
      h('img', { src: viewUrl(img, { thumb: true }), alt: '' }),
      h('div', {}, h('div', {}, `${describeChoice(r)} on ${r.imageRef}.`, m.actionState ? '' : ' Run?'),
        r.notes.length ? h('div.muted.chat-notes', {}, r.notes.join('; ')) : null));
    if (m.actionState === 'run') wrap.append(h('span.chat-applied', {}, 'Queued ✓'));
    else if (m.actionState === 'dismissed') wrap.append(h('span.muted', {}, 'Dismissed'));
    else wrap.append(h('div.chat-buttons', {},
      h('button.btn.primary', { type: 'button', onclick: async () => { m.actionState = 'run'; this.render(); this.save(); await this.onRunAction(r); } }, 'Run'),
      h('button.btn', { type: 'button', onclick: () => { m.actionState = 'dismissed'; this.render(); this.save(); } }, 'Dismiss')));
    return wrap;
  }
}

// ---- setup builder ------------------------------------------------------------
// Kept outside the class body edits above: methods are attached to the prototype.
Object.assign(ChatPanel.prototype, {
  /** One builder turn: the server asks the builder model for blocks and validates them. */
  async build(text) {
    const userMsg = { role: 'user', content: text, at: Date.now() };
    const history = this.messages.slice(-6).map((m) => ({ role: m.role, content: m.content }));
    this.messages.push(userMsg);
    this.input.value = '';
    this.render();
    const ctrl = { abort: () => {} };
    this.busy = ctrl; this._paint();
    const el = h('div.chat-msg.assistant.chat-thinking', {}, 'Planning a setup… (the builder model only picks tested blocks; the app checks them against ComfyUI)');
    this.log.append(el); this.log.scrollTop = this.log.scrollHeight;
    let r;
    try { r = await api.proposeSetup({ text: text.replace(/^\/build\s*/i, ''), history }); } catch (e) { r = { ok: false, errors: [e.message], reply: '' }; }
    el.remove();
    this.busy = null; this._paint();
    // A rejected setup must not be described as if it were built: say so, the card lists the reasons.
    const content = r.ok ? (stripPraise(r.reply || '') || 'Proposed setup below. Nothing has run yet.') : 'That setup cannot be built as asked; the reasons are below. Nothing was run or saved.';
    this.messages.push({
      role: 'assistant', content, at: Date.now(),
      builder: { name: r.name || 'My setup', ok: !!r.ok, blocks: r.blocks || [], errors: r.errors || [], notes: r.notes || [], summary: r.summary || [], estMB: r.estMB, output: r.output },
    });
    this.render();
    await this.save();
    return r;
  },

  _paint() { this.sendBtn.disabled = !!this.busy; this.sendBtn.hidden = !!this.busy; },

  _builderEl(m) {
    const b = m.builder;
    const state = b.state || (b.ok ? 'proposed' : 'rejected');
    const card = h('div.setup-card', { dataset: { state } },
      h('div.ch', {}, h('i.i.i-blocks'), h('span.nm', {}, b.name || 'New setup'), h('span.tag', {}, state)));
    (b.summary.length ? b.summary : b.blocks.map((x) => x.type)).forEach((line, i) => {
      const [head, ...rest] = String(line).split(/:\s|,\s(?=\d)/);
      card.append(h('div.blk', {}, h('span.n', {}, String(i + 1)), h('b', {}, head), rest.length ? h('span', {}, rest.join(', ')) : null));
    });
    if (b.ok) {
      const gb = b.estMB ? `Estimated VRAM ~${(b.estMB / 1024).toFixed(1)} GB (estimate).` : '';
      card.append(h('div.chk', {}, h('i.i.i-check'), h('span', {}, `Checked against ComfyUI: ${b.blocks.length} blocks, every node and model file found. ${gb}`)));
    } else {
      card.append(h('div.chk.bad', {}, h('i.i.i-x'), h('span', {}, b.errors.join(' ') || 'Rejected.')));
    }
    if (b.notes.length) card.append(h('div.fine', {}, b.notes.join(' ')));
    if (b.ok && !b.state) {
      card.append(h('div.acts', {},
        h('button.btn.out', { type: 'button', onclick: () => this._testRun(m) }, h('i.i.i-play'), 'Test run'),
        h('button.btn.out', { type: 'button', onclick: () => this._saveSetup(m) }, h('i.i.i-save'), 'Save as preset'),
        h('button.btn.ghost', { type: 'button', onclick: () => { b.state = 'discarded'; this.render(); this.save(); } }, h('i.i.i-x'), 'Discard')));
      card.append(h('div.fine', {}, 'Test run makes one result at reduced size. It is not saved as a preset until you tap Save.'));
    } else if (b.ok && b.state === 'tested') {
      card.append(h('div.acts', {},
        h('button.btn.out', { type: 'button', onclick: () => this._saveSetup(m) }, h('i.i.i-save'), 'Save as preset'),
        h('button.btn.ghost', { type: 'button', onclick: () => { b.state = 'discarded'; this.render(); this.save(); } }, h('i.i.i-x'), 'Discard')));
    } else if (b.state === 'saved') card.append(h('div.fine', {}, 'Saved under My presets (rename or delete it in the picker).'));
    return card;
  },

  async _testRun(m) {
    const b = m.builder;
    try {
      const r = await api.checkSetup({ blocks: b.blocks, name: b.name, test: true });
      if (!r.ok) { b.ok = false; b.errors = r.errors; this.render(); this.save(); return; }
      await this.onTestRun?.({ graph: r.graph, name: b.name, output: r.output });
      b.state = 'tested'; this.render(); this.save();
    } catch (e) { toast(e.message, 6000); }
  },

  async _saveSetup(m) {
    const b = m.builder;
    try {
      const p = await api.saveUserPreset({ name: b.name, blocks: b.blocks });
      b.state = 'saved'; b.presetId = p.id; b.name = p.name;
      this.render(); this.save();
      this.onSavedPreset?.(p.id);
    } catch (e) { toast(e.message, 8000); }
  },
});
