// chat-reply.js - turn the model's answer into { reply, prompt, negative, action }.
// -----------------------------------------------------------------------------
// The Chat panel asks Ollama for STRUCTURED output: /api/chat with `format` set
// to the JSON schema below, so the model must answer with
//   { "reply": "...", "prompt": "..." | null, "negative": "..." | null,
//     "action": { "action": "upscale", "params": {...}, "image_ref": "img1" } | null }
// Small local models still slip sometimes (extra prose, a ```json block, a
// truncated object), so parseReply() tries, in order:
//   1. the whole text as JSON
//   2. a ```json / ``` fenced block, or the first {...} span, as JSON
//   3. a ```prompt fenced block or a "Prompt:" line -> prompt only
//   4. otherwise: chat text only, prompt unchanged (never guess a prompt)
// A prompt identical to the current one counts as "no change".
// The model can NEVER send a node graph: `action` only names a ready-made
// workflow action plus a few params, which actions.js validates and clamps.
// -----------------------------------------------------------------------------

export const REPLY_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    prompt: { type: ['string', 'null'] },
    negative: { type: ['string', 'null'] },
    action: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: {
            action: { type: 'string' },
            params: { type: 'object' },
            image_ref: { type: ['string', 'null'] },
          },
          required: ['action'],
        },
      ],
    },
  },
  required: ['reply', 'prompt'],
};

/**
 * Schema for this turn: like REPLY_SCHEMA, but "action" may only be one of
 * the available action ids, each with its own typed params. Constraining the
 * grammar this way stops small models from inventing actions.
 */
export function replySchema(actions = []) {
  if (!actions.length) return { ...REPLY_SCHEMA, properties: { ...REPLY_SCHEMA.properties, action: { type: 'null' } } };
  const variants = actions.map((a) => ({
    type: 'object',
    properties: {
      action: { type: 'string', enum: [a.id] },
      params: { type: 'object', properties: Object.fromEntries(Object.entries(a.manifest.params).map(([k, p]) => [k, p.type === 'enum' ? { type: 'string', enum: p.options } : { type: p.type === 'int' ? 'integer' : 'number' }])) },
      image_ref: { type: ['string', 'null'] },
    },
    required: ['action'],
  }));
  return { ...REPLY_SCHEMA, properties: { ...REPLY_SCHEMA.properties, action: { anyOf: [{ type: 'null' }, ...variants] } } };
}

/** Prompt equality that ignores whitespace, curly vs straight quotes and dash styles. */
export function samePrompt(a, b) {
  const n = (t) => String(t ?? '').replace(/[\u2018\u2019\u201A\u2032]/g, "'").replace(/[\u201C\u201D\u201E\u2033]/g, '"').replace(/[\u2013\u2014]/g, '-').replace(/\s+/g, ' ').trim();
  return n(a) === n(b);
}
// ---- praise guard -------------------------------------------------------------
// The owner does not want the tools to flatter them or grade their images. The system
// prompt asks for plain replies; this strips what small models add anyway, but
// ONLY whole leading sentences that are clearly praise/filler, never anything
// after the first real sentence, and never everything.
const INTERJ = '(?:fantastic|great|excellent|awesome|amazing|wonderful|perfect|brilliant|lovely|beautiful|superb|nice|cool|sweet|wow|absolutely|definitely|sure thing|got it|okay|ok|alright|all right|of course|certainly)';
const INTERJ_ONLY = new RegExp(`^${INTERJ}(?:[\\s,]+${INTERJ})*(?:\\s+(?:idea|choice|question|call|plan|start|thinking))?\\s*[!.]*$`, 'i');
const INTERJ_BANG = new RegExp(`^${INTERJ}[,\\s]+(?:let'?s|let us) (?:do|build on|go with|get started(?: on)?|work on|dive in(?:to)?) ?(?:this|that|it)?\\s*!$`, 'i');
const PRAISE = /\b(?:looks? (?:great|amazing|fantastic|awesome|beautiful|stunning|lovely|wonderful|fantastic|perfect|good|nice)|you(?:'ve| have)? nailed|nailed (?:it|the)|(?:love|loving) (?:it|this|that|the)|great (?:idea|choice|start|starting point|concept|job|work|eye|question)|(?:what )?a (?:great|fantastic|wonderful|lovely|beautiful|brilliant|fun|cool) (?:idea|image|concept|choice|start)|(?:sounds|that's|this is|it's) (?:like )?(?:a )?(?:great|fantastic|awesome|amazing|wonderful|lovely|brilliant|fun|cool)\b|you(?:'re| are) (?:absolutely |totally |completely )?right|well done|good job|beautifully done|stunning)\b/i;
export function stripPraise(text) {
  const src = String(text ?? '');
  let rest = src.replace(/^\s+/, '');
  for (let i = 0; i < 3; i++) {
    // first sentence: up to . ! ? (followed by space/end), max 160 chars
    const m = /^([^\n]{1,160}?[.!?]+)(?=\s|$)/.exec(rest);
    if (!m) break;
    const s = m[1].trim();
    const filler = INTERJ_ONLY.test(s) || INTERJ_BANG.test(s);
    // a sentence that also carries a critique ("looks great but the neck is long") is kept
    const praise = PRAISE.test(s) && s.length <= 140 && !/\b(?:but|however|though|although|except|apart from|too|not)\b/i.test(s);
    if (!filler && !praise) break;
    const next = rest.slice(m[0].length).replace(/^[\s\u2013\u2014-]+/, '');
    if (!next.trim()) break; // never strip everything
    rest = next;
  }
  return rest === src.replace(/^\s+/, '') ? src : rest;
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

function tryJson(text) {
  try { const v = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}

/** First balanced {...} span in text (string-aware), or null. */
export function firstJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

function fromObject(o, how) {
  const reply = typeof o.reply === 'string' ? o.reply : (typeof o.message === 'string' ? o.message : '');
  let action = null;
  const a = o.action ?? o.tool;
  if (a && typeof a === 'object' && typeof (a.action ?? a.name) === 'string') {
    const params = a.params && typeof a.params === 'object' ? { ...a.params } : {};
    // Models sometimes put image_ref inside params; lift it out.
    let ref = str(a.image_ref);
    if ('image_ref' in params) { ref = ref || str(params.image_ref); delete params.image_ref; }
    action = { action: String(a.action ?? a.name), params, image_ref: ref };
  } else if (typeof a === 'string' && a.trim()) action = { action: a.trim(), params: o.params && typeof o.params === 'object' ? o.params : {}, image_ref: str(o.image_ref) };
  return { reply: reply.trim(), prompt: str(o.prompt), negative: str(o.negative), action, how };
}

/**
 * @param {string} text           raw model output
 * @param {object} [current]      { prompt, negative } now in the prompt box
 * @returns {{reply, prompt, negative, action, how, changed}}
 *   prompt/negative are null when unchanged or absent; how = json|json-block|prompt-block|text
 */
export function parseReply(text, current = {}) {
  const raw = String(text ?? '').trim();
  let r = null;
  const whole = tryJson(raw);
  if (whole) r = fromObject(whole, 'json');
  if (!r) {
    const fence = /```(?:json)?\s*\n?([\s\S]*?)```/i.exec(raw);
    const cand = (fence && tryJson(fence[1].trim())) || (() => { const s = firstJsonObject(raw); return s && tryJson(s); })();
    if (cand && ('reply' in cand || 'prompt' in cand || 'action' in cand)) {
      r = fromObject(cand, 'json-block');
      if (!r.reply) r.reply = raw.replace(fence ? fence[0] : '', '').trim();
    }
  }
  if (!r) {
    const pb = /```prompt\s*\n([\s\S]*?)```/i.exec(raw) || /^\s*(?:\*\*)?(?:revised |new |updated )?prompt(?:\*\*)?\s*:\s*(.+)$/im.exec(raw);
    if (pb) r = { reply: raw.replace(pb[0], '').trim(), prompt: str(pb[1].replace(/^["']|["']$/g, '')), negative: null, action: null, how: 'prompt-block' };
  }
  if (!r) {
    // Output that starts like our JSON but is cut off: show the readable part of
    // "reply" and never apply a half-written prompt.
    let reply = raw;
    if (/^\s*\{\s*"reply"/.test(raw)) {
      const m = /"reply"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(raw);
      let txt = '';
      try { txt = m ? JSON.parse('"' + m[1].replace(/\\$/, '') + '"') : ''; } catch { txt = m ? m[1] : ''; }
      reply = (txt ? txt + '\n\n' : '') + '(The model\'s answer was cut off, so the prompt box was left as is. Try again.)';
    }
    r = { reply, prompt: null, negative: null, action: null, how: 'text' };
  }
  // "Same" ignores whitespace and typographic quotes/dashes (seen live: gemma3:4b
  // answered an image critique by only turning duck's into duck’s).
  if (r.prompt && current.prompt !== undefined && samePrompt(r.prompt, current.prompt)) r.prompt = null;
  if (r.negative && current.negative !== undefined && samePrompt(r.negative, current.negative || '')) r.negative = null;
  r.changed = !!(r.prompt || r.negative);
  r.reply = stripPraise(r.reply.replace(/\n{3,}/g, '\n\n').trim()).trim();
  if (!r.reply) r.reply = r.changed ? 'Here is a revised prompt.' : (r.action ? '' : '(no reply)');
  return r;
}

// ---- proposal tense -----------------------------------------------------------
// When a reply comes with an action the user still has to confirm (Run), the
// text must not claim it already happened ("I have increased the resolution").
// Small models do it anyway, so past/perfect claims are rewritten to the
// conditional, deterministically: "I have increased" -> "I would increase".
const BASE = {
  increased: 'increase', upscaled: 'upscale', enlarged: 'enlarge', doubled: 'double', tripled: 'triple', quadrupled: 'quadruple',
  added: 'add', applied: 'apply', made: 'make', created: 'create', generated: 'generate', converted: 'convert', turned: 'turn',
  set: 'set', run: 'run', ran: 'run', started: 'start', queued: 'queue', boosted: 'boost', raised: 'raise', improved: 'improve',
  sharpened: 'sharpen', changed: 'change', updated: 'update', edited: 'edit', adjusted: 'adjust', resized: 'resize', scaled: 'scale',
  enhanced: 'enhance', done: 'do', built: 'build', rendered: 'render', transformed: 'transform', processed: 'process', modeled: 'model',
  modelled: 'model', produced: 'produce', prepared: 'prepare', upgraded: 'upgrade', bumped: 'bump',
};
const VERBS = Object.keys(BASE).join('|');
const GERUND = Object.fromEntries([...new Set(Object.values(BASE))].map((b) => [b === 'set' ? 'setting' : b === 'run' ? 'running' : b.endsWith('e') && b !== 'see' ? b.slice(0, -1) + 'ing' : b + 'ing', b]));
export function proposalTense(text, { cta = 'Tap Run to start it.' } = {}) {
  let t = String(text ?? '');
  const before = t;
  // "I have increased" / "I've just upscaled" / "I increased" -> "I would increase"
  t = t.replace(new RegExp(`\\bI(?:'ve| have)?(?: just| now| already)? (${VERBS})\\b`, 'gi'), (_, v) => `I would ${BASE[v.toLowerCase()]}`);
  // "has been upscaled" / "have been increased" / "was upscaled" -> "would be upscaled"
  t = t.replace(new RegExp(`\\b(?:has|have) been (${VERBS})\\b`, 'gi'), 'would be $1');
  t = t.replace(new RegExp(`\\b(?:is|are|was|were) (?:now )?(${VERBS})\\b`, 'gi'), 'would be $1');
  // "is now 2x" -> "would then be 2x"
  t = t.replace(/\b(is|are) now\b/gi, 'would then be');
  // "Upscaling it now." (sounds like it is already running) -> "I would upscale it."
  t = t.replace(/(^|[.!?]\s+)(\w+ing)(?= (?:it|this|that|the|your)\b)/g, (m, pre, g) => {
    const base = GERUND[g.toLowerCase()];
    return base ? `${pre}I would ${base}` : m;
  }).replace(/\b(I would \w+ (?:it|this|that)) now\b/gi, '$1');
  // Leading "Done." / "Here you go." / "All set." claims
  t = t.replace(/^\s*(?:done|all set|here you go|here it is|finished)[.!]\s*/i, '');
  if (t !== before && cta && !/\btap run\b|\bconfirm\b|nothing has run/i.test(t)) t = t.replace(/\s*$/, '') + ' ' + cta;
  return t.trim() || before;
}
