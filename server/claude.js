// claude.js - batch 16: Claude (the Anthropic API) fills in the form.
// -----------------------------------------------------------------------------
// The API key lives ONLY on the PC (data/claude-key.json or ANTHROPIC_API_KEY);
// the phone never sees it. The phone sends what the user said (text, the chat so
// far, attached pictures) and the server runs the tool loop with Claude. What
// Claude may do is exactly the tools below, each one checked and clamped here:
//
//   look:   get_form, list_presets, get_preset, search_history, view_picture,
//           (Opus only) get_preset_graph, node_info
//   change: set_form, set_preset_settings, load_pictures, add_variations,
//           (Opus only) propose_graph
//
// "Change" tools do not touch anything on the PC: they collect ACTIONS that go
// back to the phone, which applies them to the form in one go (one Undo) or, for
// variations, adds them to the batch NOT started. Nothing is ever queued, deleted
// or sent to Drive by Claude; no other ComfyUI call is possible.
//
// Spend: every reply's real cost (usage x the model's price) is added to
// data/claude-spend.json for the current month; once the monthly limit
// (Settings, default $20) is reached, Claude requests are refused until the
// 1st of next month.
//
//   GET  /api/claude            settings + key status (never the key) + spend
//   POST /api/claude            { enabled?, limitUsd?, defaultModel? }
//   POST /api/claude/key        { key }   save (or replace) the key on this PC
//   DELETE /api/claude/key
//   POST /api/claude/ask        { mode, model, text, form, pictures, chat }
//
// Batch 19 modes:
//   prompt / negative - the ⋮ of Prompt / Negative prompt: Claude writes ONLY that
//                       text (write_prompt); no settings change. One-shot.
//   chat              - the floating Claude button: a ComfyUI-only chat. The phone
//                       sends the earlier turns (chat: [{ role, text }]); Claude may
//                       answer, pick a preset and set fields / preset settings, and
//                       build a one-off workflow (Opus; Haiku / Sonnet hand that part
//                       to Opus with build_workflow). No pictures, never runs.
//   fix / files / variations / question - as before.
// -----------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { validateGraph } from '../app/js/lib/graph-validate.js';
import { clampParams, comboOptions } from '../app/js/lib/presets.js';
import { matches, entryTags } from '../app/js/lib/history-filter.js';
import { RATIOS, ASPECT_GRID } from '../app/js/lib/aspect.js';

export const MODELS = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };
const NAMES = { 'claude-haiku-5-5': 'Haiku', 'claude-sonnet-5-5': 'Sonnet', 'claude-opus-5-5': 'Opus' };
/** $ per million tokens: input, output, cache write (5 min), cache read. */
export const PRICES = {
  'claude-haiku-5-5': { in: 0.10, out: 0.50, write: 0.125, read: 0.01 },
  'claude-sonnet-5-5': { in: 2, out: 10, write: 2.5, read: 0.10 },
  'claude-opus-5-5': { in: 4, out: 20, write: 5, read: 0.20 },
};
export const DEFAULT_SETTINGS = { enabled: false, limitUsd: 20, defaultModel: 'haiku' };
const MAX_SEED = 2 ** 50;
const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

/** Dollars for one reply's usage (unknown models are priced as Opus, never as free). */
export function costOf(model, usage = {}) {
  const p = PRICES[model] || PRICES[Object.keys(PRICES).find((k) => String(model || '').startsWith(k))] || PRICES['claude-opus-5-5'];
  const n = (x) => (Number.isFinite(x) ? x : 0);
  return (n(usage.input_tokens) * p.in + n(usage.output_tokens) * p.out + n(usage.cache_creation_input_tokens) * p.write + n(usage.cache_read_input_tokens) * p.read) / 1e6;
}

const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
/** "2026-12-01" for any day in November 2026. */
export function resetDate(d) { const x = new Date(d.getFullYear(), d.getMonth() + 1, 1); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-01`; }

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, v, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(v, null, 1), mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

/** This month's spend in data/claude-spend.json: { month, usd, requests }. */
export class SpendStore {
  constructor(dataDir, { now = () => new Date() } = {}) { this.file = path.join(dataDir, 'claude-spend.json'); this.now = now; }
  #read() {
    const m = monthKey(this.now());
    const d = readJson(this.file, null);
    return d && d.month === m ? { month: m, usd: Number(d.usd) || 0, requests: Number(d.requests) || 0 } : { month: m, usd: 0, requests: 0 };
  }
  spent() { return this.#read().usd; }
  add(usd) { const d = this.#read(); d.usd += Math.max(0, Number(usd) || 0); d.requests++; writeJson(this.file, d); return d.usd; }
  status(limitUsd) { const d = this.#read(); return { spentUsd: d.usd, requests: d.requests, limitUsd, month: d.month, resetsOn: resetDate(this.now()), limitReached: d.usd >= limitUsd }; }
}

/** The API key, on this PC only (data/claude-key.json), or ANTHROPIC_API_KEY. Never sent to the phone. */
export class KeyStore {
  constructor(dataDir, env = process.env) { this.file = path.join(dataDir, 'claude-key.json'); this.env = env; }
  get() { const d = readJson(this.file, null); if (typeof d?.key === 'string' && d.key) return d.key; return this.env.ANTHROPIC_API_KEY || null; }
  status() { const d = readJson(this.file, null); if (typeof d?.key === 'string' && d.key) return { hasKey: true, source: 'saved' }; return this.env.ANTHROPIC_API_KEY ? { hasKey: true, source: 'env' } : { hasKey: false, source: null }; }
  set(key) {
    const k = String(key || '').trim();
    if (!k || k.length < 20 || k.length > 400 || /\s/.test(k)) throw err(400, 'That does not look like an API key');
    writeJson(this.file, { key: k, savedAt: new Date().toISOString() }, 0o600);
  }
  remove() { try { fs.unlinkSync(this.file); } catch {} }
}

export class ClaudeSettings {
  constructor(dataDir) { this.file = path.join(dataDir, 'claude-settings.json'); }
  get() { return { ...DEFAULT_SETTINGS, ...readJson(this.file, {}) }; }
  set(patch = {}) {
    const s = this.get();
    if ('enabled' in patch) s.enabled = !!patch.enabled;
    if ('limitUsd' in patch) { const n = Number(patch.limitUsd); if (!Number.isFinite(n) || n < 0 || n > 10000) throw err(400, 'Monthly limit must be between $0 and $10,000'); s.limitUsd = Math.round(n * 100) / 100; }
    if ('defaultModel' in patch) { if (!MODELS[patch.defaultModel]) throw err(400, 'Unknown model'); s.defaultModel = patch.defaultModel; }
    writeJson(this.file, s);
    return s;
  }
}

// ---- form value checks (shared by set_form and add_variations) ---------------

/** "9:16" / "16:9-portrait" / "portrait 16:9" -> an aspect key of the ratio grid, or null. */
export function normAspect(a) {
  const s = String(a ?? '').trim().toLowerCase();
  if (ASPECT_GRID.includes(s)) return s;
  const m = /(\d+)\s*[:x×]\s*(\d+)/.exec(s);
  if (!m) return null;
  const w = Number(m[1]), h = Number(m[2]);
  if (w === h) return '1:1';
  const big = Math.max(w, h), small = Math.min(w, h), key = `${big}:${small}`;
  if (!RATIOS[key]) return null;
  const orient = /portrait/.test(s) ? 'portrait' : /landscape/.test(s) ? 'landscape' : h > w ? 'portrait' : 'landscape';
  return `${key}-${orient}`;
}

/** Checks the plain form fields; -> { changes, notes, errors }. */
export function checkFields(input, { presetOf, maxBatch = 20 } = {}) {
  const changes = {}, notes = [], errors = [];
  if (input.prompt !== undefined) { if (typeof input.prompt !== 'string') errors.push('prompt must be text'); else changes.prompt = input.prompt.slice(0, 4000); }
  if (input.negative !== undefined) { if (typeof input.negative !== 'string') errors.push('negative must be text'); else changes.negative = input.negative.slice(0, 2000); }
  if (input.aspect !== undefined) { const a = normAspect(input.aspect); if (a) changes.aspect = a; else errors.push(`aspect "${input.aspect}" is not one of ${ASPECT_GRID.join(', ')}`); }
  if (input.resolution !== undefined) { const r = String(input.resolution).toLowerCase(); if (['1k', '2k', '4k'].includes(r)) changes.res = r; else errors.push('resolution must be 1k, 2k or 4k'); }
  if (input.batch !== undefined) {
    const n = Math.round(Number(input.batch));
    if (!Number.isFinite(n)) errors.push('batch must be a number');
    else { const c = Math.max(1, Math.min(maxBatch, n)); if (c !== n) notes.push(`batch ${n} -> ${c}`); changes.batch = c; }
  }
  if (input.seed !== undefined) {
    if (input.seed === 'random' || input.seed === null) changes.seed = 'random';
    else { const n = Math.round(Number(input.seed)); if (!Number.isFinite(n) || n < 0 || n > MAX_SEED) errors.push(`seed must be "random" or 0-${MAX_SEED}`); else changes.seed = n; }
  }
  if (input.preset !== undefined) {
    const p = presetOf(input.preset);
    if (!p) errors.push(`no preset "${input.preset}" (use list_presets)`);
    else if (!p.ok) errors.push(`preset "${input.preset}" cannot be used`);
    else if (p.availability?.status === 'unavailable') errors.push(`preset "${input.preset}" is unavailable: ${p.availability.reason}`);
    else changes.preset = p.id;
  }
  return { changes, notes, errors };
}

/** A picture ref ({filename, subfolder, type}) that stays inside ComfyUI's own folders. */
function safeImage(img) {
  if (!img || typeof img !== 'object') return null;
  const filename = String(img.filename || ''), subfolder = String(img.subfolder || '');
  const type = ['output', 'input', 'temp'].includes(img.type) ? img.type : 'output';
  if (!filename || /[\\/]|\.\./.test(filename) || /\.\.|^[\\/]|:/.test(subfolder)) return null;
  return { filename, subfolder, type };
}

/** A graph Claude built: an API-format object of nodes. -> error text or null. */
export function graphShapeError(g) {
  if (!g || typeof g !== 'object' || Array.isArray(g)) return 'graph must be an object of nodes keyed by id';
  const ids = Object.keys(g);
  if (!ids.length) return 'graph is empty';
  if (ids.length > 80) return 'graph has more than 80 nodes';
  for (const [id, n] of Object.entries(g)) {
    if (!n || typeof n.class_type !== 'string' || !n.inputs || typeof n.inputs !== 'object') return `node ${id} needs class_type and inputs`;
  }
  if (!Object.values(g).some((n) => /^(SaveImage|PreviewImage|SaveVideo|SaveAnimatedWEBP|SaveAudio|Save.*)$/.test(n.class_type))) return 'graph has no output node (e.g. SaveImage)';
  return null;
}

// ---- prompt + tools (frozen: same bytes every request, so they cache) --------

const SYSTEM = `You help a concept artist fill in the form of a phone app that runs ComfyUI on their PC.
The form has: a preset (the model/workflow), a prompt, a negative prompt (some presets), aspect ratio, resolution 1k/2k/4k (text-to-image presets), batch count, seed (random or a fixed number), preset settings (steps, guidance, sampler, ...) and picture slots for presets that take pictures.

How to work:
- Look before you change: use get_form and, when you need it, list_presets / get_preset. Fetch only what you need.
- Change the form only with set_form, set_preset_settings and load_pictures. Then STOP: you never run anything. The user presses Run themselves.
- When the user only asks a question, answer it and change nothing.
- When fixing a picture, keep the same seed unless you say why you changed it.
- For "N takes / variations" use add_variations: each job must differ in a real, visible way (light, angle, palette, composition, setting...), never just a new seed. They are added to the user's batch, not started.
- Write prompts in the style the preset expects (natural sentences for FLUX/Qwen/Z-Image), concrete and visual.
- Tool results tell you what was clamped or refused; adjust and continue.
- Your final message is shown only when you changed nothing: 1-3 short plain sentences, no markdown, no lists.`;

const BUILD = `
Building a one-off workflow (only when no preset fits, e.g. more reference pictures than any preset takes):
- Read a close preset with get_preset_graph and the nodes you need with node_info, then call propose_graph with an API-format graph.
- Use only installed nodes and model files exactly as node_info lists them. Put the user's pictures in LoadImage nodes whose "image" input is "picture:N" (N = the attached picture number).
- propose_graph checks it against the user's ComfyUI. If it returns errors, fix them. After 3 failed tries, stop and say plainly that you could not build it.`;

const CHAT = `
CHAT MODE (the floating Claude button). Talk with the user about ComfyUI and this app only; politely decline anything else.
- Answer questions plainly: 1-5 short sentences, no markdown, no lists.
- When the user asks you to set something up, do it on the form: pick a preset and set fields and preset settings with set_form / set_preset_settings. Only change the form when the user asks for it in this chat.
- You cannot load pictures. If the preset needs pictures, tell the user to add them on the form.
- You never run anything; the user presses Run.
- After changing the form, say in one short sentence what you set. Your reply is always shown.`;

const CHAT_HANDOFF = `
- When no preset can do what the user wants, call build_workflow with a full description of the workflow. A bigger model builds it and loads it into the form.`;

const CHAT_BUILD = `
- In chat no pictures are attached: give every picture input a LoadImage node with image "example.png". The user loads the picture on the form.`;

const NO_BUILD = `
If the request needs a custom workflow that no preset offers, say so and suggest asking again from Files or the viewer (which use the bigger model).`;

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const FIELD_PROPS = {
  prompt: { type: 'string', description: 'Full new prompt text' },
  negative: { type: 'string', description: 'Negative prompt (only presets that have one); empty string clears it' },
  aspect: { type: 'string', description: 'Aspect ratio as W:H, e.g. "1:1", "9:16", "16:9", "3:2", "4:3", "5:4", "21:9" (portrait = taller)' },
  resolution: { type: 'string', enum: ['1k', '2k', '4k'], description: 'Long side for text-to-image presets; 4k = 2k plus an upscale' },
  seed: { description: '"random" or a whole number', anyOf: [{ type: 'string', enum: ['random'] }, { type: 'integer' }] },
};

/** Look-only tools (question mode never changes anything). */
export const READ_TOOLS = ['get_form', 'list_presets', 'get_preset', 'search_history', 'view_picture'];
/** Batch 19: what each kind of request may use (besides the look-only tools). */
const MODE_TOOLS = {
  prompt: ['write_prompt'],
  chat: ['set_form', 'set_preset_settings', 'build_workflow', 'get_preset_graph', 'node_info', 'propose_graph'],
};

/**
 * The tools of one request. kind: 'full' (fix / files / variations), 'question'
 * (look only), 'prompt' (write the prompt or negative only), 'chat'.
 * build: Opus may build workflows; a Haiku / Sonnet chat gets build_workflow instead.
 */
export function toolsFor(build, readOnly = false, kind = readOnly ? 'question' : 'full') {
  const all = allTools(build);
  if (kind === 'question') return all.filter((t) => READ_TOOLS.includes(t.name));
  if (kind === 'prompt' || kind === 'chat') {
    const extra = MODE_TOOLS[kind].filter((n) => kind !== 'chat' || (build ? n !== 'build_workflow' : !['get_preset_graph', 'node_info', 'propose_graph'].includes(n)));
    return all.filter((t) => READ_TOOLS.includes(t.name) || extra.includes(t.name));
  }
  return all.filter((t) => !['write_prompt', 'build_workflow'].includes(t.name));
}

function allTools(build) {
  const tools = [
    { name: 'get_form', description: 'The form as it is now: preset, prompt, negative, aspect, resolution, batch, seed, preset settings and loaded pictures.', input_schema: obj({}) },
    { name: 'list_presets', description: 'All presets: id, name, section, whether it is available on this PC, how many pictures it takes, and what it makes.', input_schema: obj({}) },
    { name: 'get_preset', description: 'One preset in detail: its settings (key, range or options, default), picture slots, sizes, max batch, negative prompt support.', input_schema: obj({ id: { type: 'string' } }, ['id']) },
    { name: 'search_history', description: 'Search the user\'s earlier results (Files) by words and/or tags. Returns up to 10: id, prompt, preset, seed, tags.', input_schema: obj({ query: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }) },
    { name: 'view_picture', description: 'Look at one earlier result from search_history.', input_schema: obj({ history_id: { type: 'string' } }, ['history_id']) },
    { name: 'set_form', description: 'Change form fields. Only the fields you pass change. Switch preset first if needed (preset settings belong to a preset).', input_schema: obj({ preset: { type: 'string', description: 'Preset id from list_presets' }, ...FIELD_PROPS, batch: { type: 'integer', minimum: 1, maximum: 20 } }) },
    { name: 'set_preset_settings', description: 'Change settings of the form\'s preset (keys from get_preset). Values are clamped to the allowed range.', input_schema: obj({ values: { type: 'object', description: 'key -> value' } }, ['values']) },
    { name: 'load_pictures', description: 'Put pictures into the preset\'s picture slots, in slot order. Each item is an attached picture number or a history_id.', input_schema: obj({ pictures: { type: 'array', items: { anyOf: [{ type: 'integer', description: 'attached picture number' }, { type: 'string', description: 'history id' }] } } }, ['pictures']) },
    { name: 'add_variations', description: 'Add 1-12 jobs to the user\'s batch (NOT started). Each job = the current form plus its own changes; each must differ in a real way.', input_schema: obj({ jobs: { type: 'array', maxItems: 12, items: obj({ label: { type: 'string', description: 'Short name, e.g. "Moonlit fog, low angle"' }, ...FIELD_PROPS, settings: { type: 'object', description: 'preset settings key -> value' } }, ['label']) } }, ['jobs']) },
    { name: 'write_prompt', description: 'Write the text this request is about (the prompt, or the negative prompt). The only change you can make here.', input_schema: obj({ text: { type: 'string', description: 'The full new text' } }, ['text']) },
    { name: 'build_workflow', description: 'Hand off to a bigger model that builds a one-off ComfyUI workflow and loads it into the form. Only when no preset can do it.', input_schema: obj({ what: { type: 'string', description: 'Everything the workflow must do, from the chat' } }, ['what']) },
  ];
  if (build) tools.push(
    { name: 'get_preset_graph', description: 'The ComfyUI API-format graph of a preset (to build from).', input_schema: obj({ id: { type: 'string' } }, ['id']) },
    { name: 'node_info', description: 'Inputs and outputs of ComfyUI node classes installed on this PC (combo lists = installed models).', input_schema: obj({ classes: { type: 'array', items: { type: 'string' }, maxItems: 12 } }, ['classes']) },
    { name: 'propose_graph', description: 'Load a one-off workflow you built into the form. It is checked against the user\'s ComfyUI first; errors come back to you. Never run.', input_schema: obj({ name: { type: 'string', description: 'Short name' }, graph: { type: 'object', description: 'API-format graph: { "1": { "class_type", "inputs" }, ... }' }, prompt: { type: 'string' }, roles: { type: 'array', items: { type: 'string' }, description: 'What each attached picture is used for, in order' } }, ['name', 'graph']) },
  );
  // the last tool carries the cache breakpoint for tools + system
  return tools;
}

/** Plain-language reason for a failed API call (typed SDK errors first). */
export function describeError(e, SDK) {
  const is = (name) => SDK && SDK[name] && e instanceof SDK[name];
  const st = e?.status;
  if (is('AuthenticationError') || st === 401) return { status: 502, message: 'The API key was refused. Replace it in Settings.' };
  if (is('PermissionDeniedError') || st === 403) return { status: 502, message: 'This API key may not use that model (check its Workspace at platform.claude.com).' };
  if (is('RateLimitError') || st === 429) return { status: 503, message: 'Claude is busy or the Workspace limit was reached. Try again in a minute.' };
  if (is('BadRequestError') || st === 400) return { status: 502, message: `Claude could not take that request: ${e.message}` };
  if (is('APIConnectionTimeoutError') || is('APIConnectionError') || e?.code === 'ECONNREFUSED') return { status: 503, message: 'Could not reach Claude from the PC (no internet?).' };
  if (st >= 500) return { status: 503, message: 'Claude had a problem on its side. Try again.' };
  return { status: 500, message: e?.message || 'Claude failed' };
}

/** The real SDK, when installed (npm install in the app folder). */
async function loadSdk() {
  try { const m = await import('@anthropic-ai/sdk'); return m.default || m.Anthropic; } catch { return null; }
}

/**
 * @param o.dataDir
 * @param o.presets()        async -> the preset list (/api/workflows items)
 * @param o.objectInfo()     async -> ComfyUI /object_info or null
 * @param o.history          HistoryStore
 * @param o.fetchPicture(img) async -> { data (base64), media } for an output picture
 * @param o.makeClient({ apiKey }) test seam -> { beta: { messages: { create } } }
 * @param o.baseURL          test seam: the fake Claude server
 */
export function createClaude({ dataDir, presets, objectInfo, history, fetchPicture, env = process.env, makeClient, baseURL, now = () => new Date(), log = () => {} }) {
  const keys = new KeyStore(dataDir, env);
  const spend = new SpendStore(dataDir, { now });
  const settings = new ClaudeSettings(dataDir);
  let sdk;

  function status() {
    const s = settings.get();
    return { ...s, ...keys.status(), ...spend.status(s.limitUsd), models: Object.keys(MODELS) };
  }

  async function client() {
    const apiKey = keys.get();
    if (!apiKey) throw err(409, 'No API key saved. Add it in Settings.', { code: 'no-key' });
    if (makeClient) return makeClient({ apiKey, baseURL });
    if (sdk === undefined) sdk = await loadSdk();
    if (!sdk) throw err(500, 'The Claude SDK is not installed on the PC. Run "npm install" in the app folder, then restart the app.');
    return new sdk({ apiKey, ...(baseURL ? { baseURL } : {}), maxRetries: 2, timeout: 120000 });
  }

  /**
   * One request from the phone. -> { reply, actions, model, costUsd, spentUsd, limitUsd, steps }
   * mode: prompt / question (model from the switch) | fix | files | variations (always Opus)
   * question: answers only, with the look-only tools; the form is never changed.
   */
  async function ask(body = {}) {
    const s = settings.get();
    if (!s.enabled) throw err(403, 'Claude is switched off in Settings.', { code: 'off' });
    const sp = spend.status(s.limitUsd);
    if (sp.limitReached) throw err(429, `Monthly limit reached: about $${sp.spentUsd.toFixed(2)} of $${s.limitUsd.toFixed(2)} used. Claude is back on ${sp.resetsOn}.`, { code: 'limit' });
    const mode = ['prompt', 'negative', 'chat', 'question', 'fix', 'files', 'variations'].includes(body.mode) ? body.mode : 'prompt';
    const key = ['prompt', 'negative', 'chat', 'question'].includes(mode) ? (MODELS[body.model] ? body.model : s.defaultModel) : 'opus';
    const model = MODELS[key];
    const readOnly = mode === 'question';
    // Batch 19: Write prompt (Prompt / Negative prompt) writes that text only, never builds.
    const kind = mode === 'prompt' || mode === 'negative' ? 'prompt' : mode === 'chat' ? 'chat' : readOnly ? 'question' : 'full';
    const build = key === 'opus' && (kind === 'full' || kind === 'chat');
    const text = String(body.text || '').trim().slice(0, 4000);
    if (!text) throw err(400, 'Say what you want first');
    const form = body.form && typeof body.form === 'object' ? body.form : {};
    const pics = (kind === 'chat' ? [] : Array.isArray(body.pictures) ? body.pictures : []).slice(0, 8).map((p, i) => ({
      n: i + 1, media: /^image\/(jpeg|png|webp)$/.test(p?.media) ? p.media : 'image/jpeg',
      data: typeof p?.data === 'string' && p.data.length < 7_000_000 ? p.data.replace(/^data:[^,]*,/, '') : null,
      image: safeImage(p?.image), meta: p?.meta && typeof p.meta === 'object' ? p.meta : {},
    }));
    const list = await presets();
    const presetOf = (id) => list.find((w) => w.id === id || w.id === `ai:${id}`) || null;
    let presetId = presetOf(form.preset)?.id || form.preset || null;

    // ---- actions collected for the phone ----
    const formChanges = {}; let params = null; let pictures = null; const variations = []; let graph = null;
    let graphTries = 0, handoffs = 0;
    // Batch 19: the chat so far (sent by the phone; wiped when the app closes).
    const chat = kind === 'chat' ? (Array.isArray(body.chat) ? body.chat : []).filter((m) => m && ['user', 'assistant'].includes(m.role) && typeof m.text === 'string' && m.text.trim())
      .slice(-30).map((m) => ({ role: m.role, text: m.text.slice(0, 4000) })) : [];
    const current = () => presetOf(formChanges.preset || presetId);

    const tools = {
      get_form: () => ({ ...form, ...formChanges, preset: formChanges.preset || presetId, settings: { ...(form.settings || {}), ...(params || {}) }, attachedPictures: pics.length }),
      list_presets: () => list.map((w) => ({ id: w.id, name: w.label, section: [w.group, w.subgroup].filter(Boolean).join(' › '), available: w.ok && w.availability?.status !== 'unavailable', pictures: w.ok ? w.controls?.images?.length || 0 : 0, makes: w.output || w.ai?.output || 'image' })),
      get_preset: ({ id }) => {
        const w = presetOf(id);
        if (!w) throw new Error(`no preset "${id}"`);
        if (!w.ok) return { id: w.id, usable: false, error: w.error };
        const m = w.ai, c = w.controls;
        return {
          id: w.id, name: w.label, description: m?.description, available: w.availability?.status !== 'unavailable', unavailableReason: w.availability?.reason,
          prompt: !!c.prompt.length, negative: !!c.negative.length, seed: !!c.seed.length, aspect: !!(c.width.length && c.height.length), resolution: !!m?.size && m?.subgroup === 'Text to Image',
          pictureSlots: (c.images || []).map((x, i) => ({ slot: i + 1, title: String(x.title || '').replace(/#\w+/g, '').trim() || `Picture ${i + 1}` })),
          maxBatch: m?.maxBatch || 20, size: m?.size,
          settings: Object.fromEntries(Object.entries(m?.params || {}).map(([k, p]) => [k, { label: p.label, type: p.type, ...(p.options ? { options: p.options } : { min: p.min, max: p.max }), default: p.default }])),
        };
      },
      search_history: ({ query = '', tags = [] }) => {
        const f = { q: String(query).slice(0, 200), tags: new Set((Array.isArray(tags) ? tags : []).map(String).slice(0, 10)) };
        const all = history.list({}).flatMap((x) => x.entries).filter((e) => e.images?.length && matches(e, f));
        return all.slice(0, 10).map((e) => ({ id: e.id, prompt: String(e.prompt || '').slice(0, 300), preset: e.workflow, seed: e.seed, tags: [...new Set(entryTags(e))].slice(0, 12), favorite: !!e.favorite, made: new Date(e.createdAt).toISOString().slice(0, 10) }));
      },
      view_picture: async ({ history_id }) => {
        const e = history.get(String(history_id));
        if (!e?.images?.length) throw new Error('no picture with that id');
        const p = await fetchPicture(e.images[0]);
        return { image: p, note: `${e.id}: ${String(e.prompt || '').slice(0, 200)}` };
      },
      set_form: (input) => {
        const target = input.preset !== undefined ? presetOf(input.preset) : current();
        const r = checkFields(input, { presetOf, maxBatch: Math.min(20, target?.ai?.maxBatch || 20) });
        if (r.errors.length) throw new Error(r.errors.join('; '));
        if (r.changes.preset && r.changes.preset !== current()?.id) params = null; // settings belong to the old preset
        Object.assign(formChanges, r.changes);
        return `OK: ${Object.keys(r.changes).join(', ') || 'nothing'} set${r.notes.length ? ` (${r.notes.join('; ')})` : ''}`;
      },
      set_preset_settings: ({ values }) => {
        const w = current();
        if (!w?.ai) throw new Error('the form\'s preset has no settings to change');
        if (!values || typeof values !== 'object') throw new Error('values must be an object');
        const known = Object.fromEntries(Object.entries(values).filter(([k]) => k in w.ai.params));
        const { params: clamped, notes } = clampParams(w.ai, known);
        const picked = Object.fromEntries(Object.keys(known).map((k) => [k, clamped[k]]));
        for (const k of Object.keys(values)) if (!(k in w.ai.params)) notes.push(`unknown setting "${k}" ignored`);
        params = { ...(params || {}), ...picked };
        return `OK: ${Object.entries(picked).map(([k, v]) => `${k}=${v}`).join(', ') || 'nothing'}${notes.length ? ` (${notes.join('; ')})` : ''}`;
      },
      load_pictures: ({ pictures: list_ }) => {
        const w = current();
        const slots = w?.ok ? w.controls?.images?.length || 0 : 0;
        if (!slots) throw new Error('the form\'s preset takes no pictures');
        const out = [];
        for (const x of (Array.isArray(list_) ? list_ : []).slice(0, slots)) {
          if (Number.isInteger(x)) { const p = pics[x - 1]; if (!p?.image) throw new Error(`attached picture ${x} cannot be loaded into a slot`); out.push({ image: p.image, from: `picture ${x}`, historyId: p.meta?.historyId }); }
          else { const e = history.get(String(x)); if (!e?.images?.[0]) throw new Error(`no picture "${x}" in Files`); out.push({ image: safeImage(e.images[0]), from: e.id, historyId: e.id }); }
        }
        pictures = out;
        return `OK: ${out.length} of ${slots} slot(s) filled`;
      },
      add_variations: ({ jobs }) => {
        if (!Array.isArray(jobs) || !jobs.length) throw new Error('jobs must be a non-empty list');
        if (variations.length + jobs.length > 12) throw new Error('at most 12 jobs per request');
        const notes = [];
        for (const j of jobs) {
          const r = checkFields({ ...j, preset: undefined, batch: undefined }, { presetOf });
          if (r.errors.length) throw new Error(`"${j.label}": ${r.errors.join('; ')}`);
          let settings_;
          if (j.settings && current()?.ai) { const c = clampParams(current().ai, Object.fromEntries(Object.entries(j.settings).filter(([k]) => k in current().ai.params))); settings_ = Object.fromEntries(Object.keys(j.settings).filter((k) => k in current().ai.params).map((k) => [k, c.params[k]])); notes.push(...c.notes); }
          variations.push({ label: String(j.label || `Take ${variations.length + 1}`).slice(0, 60), changes: r.changes, settings: settings_ });
        }
        return `OK: ${variations.length} job(s) will be added to the batch, not started${notes.length ? ` (${notes.join('; ')})` : ''}`;
      },
      write_prompt: ({ text: t }) => {
        const field = mode === 'negative' ? 'negative' : 'prompt';
        if (field === 'negative' && current()?.ok && !current().controls?.negative?.length) throw new Error('the form\'s preset has no negative prompt');
        formChanges[field] = String(t ?? '').slice(0, 4000);
        return `OK: the ${field === 'negative' ? 'negative prompt' : 'prompt'} is written. Stop now.`;
      },
      build_workflow: async ({ what }) => {
        if (++handoffs > 1) throw new Error('only one build per message');
        const transcript = [...chat, { role: 'user', text }].map((m) => `${m.role === 'user' ? 'User' : 'You'}: ${m.text}`).join('\n');
        const r = await runLoop({
          key: 'opus', toolDefs: cached(toolsFor(true, false, 'chat')), system: systemFor('chat', true), maxSteps: 14, effort: 'high',
          messages: [{ role: 'user', content: [{ type: 'text', text: `Build a one-off workflow for this chat and load it into the form.\n\nThe chat so far:\n${transcript}\n\nWhat to build: ${String(what || '').slice(0, 2000)}\n[form preset: ${formChanges.preset || presetId || 'none'}]` }] }],
        });
        usedOpus = true;
        return graph ? `Built "${graph.name}" and loaded it into the form. ${r.reply}` : `Not built: ${r.reply}`;
      },
      get_preset_graph: ({ id }) => { const w = presetOf(id); if (!w?.ok || !w.workflow) throw new Error(`no usable preset "${id}"`); return w.workflow; },
      node_info: async ({ classes }) => {
        const info = await objectInfo();
        if (!info) throw new Error('ComfyUI is not reachable');
        return Object.fromEntries((classes || []).slice(0, 12).map((c) => {
          const d = info[c];
          if (!d) return [c, 'not installed'];
          const slim = (sec) => Object.fromEntries(Object.entries(d.input?.[sec] || {}).map(([k, spec]) => { const o = comboOptions(spec); return [k, o ? { options: o.slice(0, 60) } : { type: spec[0], ...(spec[1] && typeof spec[1] === 'object' ? { min: spec[1].min, max: spec[1].max, default: spec[1].default } : {}) }]; }));
          return [c, { required: slim('required'), optional: slim('optional'), outputs: d.output }];
        }));
      },
      propose_graph: async ({ name, graph: g, prompt, roles }) => {
        graphTries++;
        if (graphTries > 3) throw new Error('Too many tries. Stop and tell the user plainly that you could not build this workflow.');
        const shape = graphShapeError(g);
        if (shape) throw new Error(shape);
        // picture:N -> a LoadImage placeholder the phone fills with that picture
        const check = structuredClone(g);
        for (const n of Object.values(check)) for (const [k, v] of Object.entries(n.inputs)) {
          const m = typeof v === 'string' && /^picture:(\d+)$/.exec(v);
          if (m) { if (!pics[Number(m[1]) - 1]?.image) throw new Error(`${v}: there is no attached picture ${m[1]} that can be loaded`); n.inputs[k] = '__picture__'; }
        }
        const info = await objectInfo();
        const errors = validateGraph(check, info);
        if (errors.length) throw new Error(`Not valid on this PC:\n- ${errors.slice(0, 12).join('\n- ')}`);
        graph = { name: String(name || 'One-off').slice(0, 60), graph: g, prompt: typeof prompt === 'string' ? prompt.slice(0, 4000) : undefined, roles: Array.isArray(roles) ? roles.map((x) => String(x).slice(0, 40)).slice(0, 8) : undefined, pictures: pics.filter((p) => p.image).map((p) => ({ n: p.n, image: p.image })) };
        return 'OK: checked against the user\'s ComfyUI (every node and model is installed). It loads into the form as a one-off preset.';
      },
    };

    // ---- the request ----
    const c = await client();
    /** The last tool carries the cache breakpoint for tools + system. */
    function cached(defs) { defs[defs.length - 1] = { ...defs[defs.length - 1], cache_control: { type: 'ephemeral' } }; return defs; }
    /** Frozen per kind of request (same bytes every time, so it caches). */
    function systemFor(k, b) { return [{ type: 'text', text: SYSTEM + (k === 'chat' ? CHAT + (b ? BUILD + CHAT_BUILD : CHAT_HANDOFF) : b ? BUILD : NO_BUILD), cache_control: { type: 'ephemeral' } }]; }
    const toolDefs = cached(toolsFor(build, readOnly, kind));
    const content = [];
    for (const p of pics) {
      if (!p.data) continue;
      content.push({ type: 'text', text: `Picture ${p.n}${p.meta?.prompt ? ` (made with preset ${p.meta.workflow || '?'}, seed ${p.meta.seed ?? '?'}${p.meta.width ? `, ${p.meta.width}x${p.meta.height}` : ''}${p.meta.steps ? `, ${p.meta.steps} steps` : ''}; prompt: ${String(p.meta.prompt).slice(0, 600)})` : ''}:` });
      content.push({ type: 'image', source: { type: 'base64', media_type: p.media, data: p.data } });
    }
    const lead = mode === 'question' ? 'QUESTION ONLY: answer it (you may look things up with the tools), change nothing. Answer in 1-5 short plain sentences, no markdown. '
      : mode === 'prompt' ? 'WRITE THE PROMPT ONLY: write it with write_prompt, then stop. Change nothing else (no preset, size or settings). '
      : mode === 'negative' ? 'WRITE THE NEGATIVE PROMPT ONLY: write what to keep out of the picture with write_prompt, then stop. Change nothing else. '
      : mode === 'fix' ? 'Fix this result (change the form so the next run is better). '
      : mode === 'files' ? `The user picked ${pics.length} picture(s) in Files, numbered in the order they tapped them. `
        : mode === 'variations' ? 'Make variations into the batch. ' : '';
    content.push({ type: 'text', text: `${lead}[form preset: ${presetId || 'none'}]\n${text}` });
    // One-shot requests start fresh; batch 19: the chat sends its earlier turns as plain text.
    const messages = [...chat.map((m) => ({ role: m.role, content: m.text })), { role: 'user', content }];
    if (messages[0].role !== 'user') messages.shift();

    let costUsd = 0, steps = 0, stopped = null, usedOpus = false;
    /** The tool loop with one model; shared state (form changes, graph) lives above. -> { reply } */
    async function runLoop({ key: k, toolDefs: defs, system, messages: msgs, maxSteps, effort }) {
      const allowed = new Set(defs.map((t) => t.name));
      let reply = '';
      for (let n = 1; ; n++) {
        steps++;
        if (spend.spent() >= s.limitUsd) { stopped = 'limit'; reply ||= 'The monthly limit was reached in the middle of this. Nothing more was done.'; break; }
        const req = {
          model: MODELS[k], max_tokens: k === 'opus' && defs.some((t) => t.name === 'propose_graph') ? 16000 : 8000, system, tools: defs, messages: msgs,
          cache_control: { type: 'ephemeral' }, // the conversation so far, re-read on every tool step
          thinking: { type: 'adaptive' }, output_config: { effort },
          // Opus / Sonnet: a declined request is retried on the fallback model by the API.
          ...(k !== 'haiku' ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
        };
        let res;
        try { res = await c.beta.messages.create(req); } catch (e) { const d = describeError(e, sdk); log(`claude: ${d.message}`); throw err(d.status, d.message); }
        const cost = costOf(res.model || MODELS[k], res.usage);
        costUsd += cost; spend.add(cost);
        msgs.push({ role: 'assistant', content: res.content });
        const textOut = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        if (res.stop_reason === 'refusal') { stopped = 'refusal'; reply = `Claude declined this request${res.stop_details?.category ? ` (${res.stop_details.category})` : ''}. Nothing was changed.`; formChangesClear(); break; }
        if (res.stop_reason === 'max_tokens') { stopped = 'max_tokens'; reply = textOut || 'The answer was too long and got cut off.'; break; }
        if (res.stop_reason !== 'tool_use') { reply = textOut; break; }
        if (n >= maxSteps) { stopped = 'steps'; reply = textOut || 'That took too many steps, so I stopped. What was set so far is on the form.'; break; }
        const results = [];
        for (const b of res.content) {
          if (b.type !== 'tool_use') continue;
          const fn = Object.hasOwn(tools, b.name) && allowed.has(b.name) ? tools[b.name] : null;
          try {
            if (!fn) throw new Error(`unknown tool ${b.name}`);
            const out = await fn(b.input || {});
            if (out?.image) results.push({ type: 'tool_result', tool_use_id: b.id, content: [{ type: 'image', source: { type: 'base64', media_type: out.image.media, data: out.image.data } }, { type: 'text', text: out.note }] });
            else results.push({ type: 'tool_result', tool_use_id: b.id, content: typeof out === 'string' ? out : JSON.stringify(out) });
          } catch (e) { results.push({ type: 'tool_result', tool_use_id: b.id, is_error: true, content: e.message }); }
        }
        msgs.push({ role: 'user', content: results });
      }
      return { reply };
    }

    const effort = key === 'haiku' ? 'low' : key === 'sonnet' ? 'medium' : kind === 'prompt' || kind === 'chat' ? 'medium' : 'high';
    const { reply } = await runLoop({ key, toolDefs, system: systemFor(kind, build), messages, maxSteps: build ? 14 : 8, effort });
    function formChangesClear() { for (const k of Object.keys(formChanges)) delete formChanges[k]; params = null; pictures = null; variations.length = 0; graph = null; }

    const actions = [];
    if (readOnly) formChangesClear(); // belt and braces: a question never changes the form
    if (graph) actions.push({ type: 'graph', ...graph });
    if (Object.keys(formChanges).length) actions.push({ type: 'form', changes: formChanges });
    if (params) actions.push({ type: 'settings', preset: current()?.id, values: params });
    if (pictures) actions.push({ type: 'pictures', pictures });
    if (variations.length) actions.push({ type: 'variations', preset: current()?.id, jobs: variations });
    const after = spend.status(s.limitUsd);
    return { reply: reply || 'Done.', actions, model: key, modelName: NAMES[model] + (usedOpus ? ' + Opus' : ''), costUsd, spentUsd: after.spentUsd, limitUsd: s.limitUsd, resetsOn: after.resetsOn, steps, stopped };
  }

  return { status, ask, keys, spend, settings };
}
