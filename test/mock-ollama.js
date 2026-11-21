// mock-ollama.js - a fake Ollama for development and tests.
// -----------------------------------------------------------------------------
// Same shapes as the real Ollama HTTP API (https://github.com/ollama/ollama/blob/main/docs/api.md):
//   GET  /api/tags      -> { models: [{ name, model, size, details }] }
//   GET  /api/version   -> { version }
//   GET  /api/ps        -> { models: [...loaded] }
//   POST /api/show      -> { capabilities: ['completion', 'vision'?], details }
//   POST /api/chat      -> streamed NDJSON: {message:{role,content}, done:false} ... {done:true}
//                          (or one JSON object with stream:false)
//   POST /api/generate  -> with keep_alive 0 and no prompt: unloads the model
// Plus test helpers: GET /mock/requests (with a timestamp), POST /mock/reset.
// Like the real Ollama, it refuses (403) an Origin that is not localhost.
// The reply always contains one ```prompt fenced block so the UI can show
// Use / Generate buttons; if the last user message carried images it says so.
// -----------------------------------------------------------------------------
import http from 'node:http';
import { readBody } from '../server/multipart.js';

export const MOCK_MODELS = [
  { name: 'gemma3:4b', vision: true, size: 3338801804, family: 'gemma3' },
  { name: 'llama3.2:3b', vision: false, size: 2019393189, family: 'llama' },
];

// Old-style prose answer (no `format`): a ```prompt fenced block.
function proseReply(msgs, last) {
  const seen = last.images?.length ? `I can see your image (${last.images.length}). ` : '';
  const turns = msgs.filter((x) => x.role === 'user').length;
  return `${seen}Nice idea (turn ${turns}). Here is a prompt you can try:\n\n\`\`\`prompt\nconcept art of ${String(last.content).slice(0, 60).replace(/`/g, '')}, dramatic lighting, wide shot\n\`\`\`\n\nWant a moodier variant?`;
}

// Structured answer (request had `format`). Trigger words in the user's text
// exercise the app's parser and action paths:
//   NOCHANGE  -> returns the CURRENT prompt (from the system message) = no change
//   MALFORMED -> prose around a ```json block (not pure JSON)
//   GARBAGE   -> plain text, no JSON at all
//   TRUNCATED -> JSON cut off mid-way
//   upscale   -> action "upscale", scale 9 (out of range), no image_ref
//   3d        -> action "image-to-3d"
//   BOGUSACTION -> action "teleport" (unknown)
function structuredReply(msgs, last) {
  const text = String(last.content || '');
  const sys = msgs.find((m) => m.role === 'system')?.content || '';
  const current = (/CURRENT PROMPT BOX[^\n]*\n"""([\s\S]*?)"""/.exec(sys) || [])[1] || '';
  const subject = text.split('\n')[0].replace(/[`"{}]/g, '').slice(0, 60);
  if (/CLAIM/.test(text)) return JSON.stringify({ reply: 'I revised the prompt to fix the neck.', prompt: current, negative: null, action: null });
  if (/PRAISE/.test(text)) return JSON.stringify({ reply: 'Fantastic! The image looks great \u2013 you nailed the mood. I changed the light to dusk.', prompt: `${current || 'a duck'}, at dusk`, negative: null, action: null });
  if (/NOCHANGE/.test(text)) return JSON.stringify({ reply: 'The prompt already says that.', prompt: current, negative: null, action: null });
  if (/GARBAGE/.test(text)) return 'Sure! I think the image is lovely as it is.';
  if (/TRUNCATED/.test(text)) return '{"reply": "Here is a new prompt", "prompt": "a purple duck on a la';
  if (/MALFORMED/.test(text)) return 'Here you go:\n```json\n' + JSON.stringify({ reply: 'Fixed it.', prompt: `concept art of ${subject}, fixed` }) + '\n```\nEnjoy!';
  if (/UNASKED/.test(text)) return JSON.stringify({ reply: 'Here is a prompt, and a 3D model too.', prompt: 'a purple duck, unasked', negative: null, action: { action: 'image-to-3d', params: {}, image_ref: 'img1' } });
  if (/BOGUSACTION/.test(text)) return JSON.stringify({ reply: 'Teleporting.', prompt: null, action: { action: 'teleport', params: {} } });
  if (/upscale/i.test(text)) return JSON.stringify({ reply: 'Upscaling it.', prompt: null, negative: null, action: { action: 'upscale', params: { scale: 9 } } });
  if (/\b3d\b/i.test(text)) return JSON.stringify({ reply: 'Making a 3D model.', prompt: null, negative: null, action: { action: 'image-to-3d', params: { steps: 20 }, image_ref: 'img1' } });
  if (last.images?.length) {
    return JSON.stringify({ reply: `I can see the image (${last.images.length}): the neck is too long, so it reads as a swan.`, prompt: `${current || 'a purple duck'}, a duck with a short neck and a flat orange bill`, negative: null, action: null });
  }
  return JSON.stringify({ reply: 'Nice idea. Here is a prompt.', prompt: `concept art of ${subject}, dramatic lighting, wide shot`, negative: null, action: null });
}

// extraModels: more installed models (e.g. a 12B one) for fit tests.
// vramFraction: { name: 0.6 } -> /api/ps reports size_vram = size * 0.6 (partly in RAM).
export function createMockOllama({ tokenMs = 5, extraModels = [], vramFraction = {} } = {}) {
  const MODELS = [...MOCK_MODELS, ...extraModels];
  const requests = [];
  const loaded = new Set();
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const find = (name) => MODELS.find((m) => m.name === name || m.name === name + ':latest');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    let body = null;
    if (req.method === 'POST') { try { body = JSON.parse((await readBody(req, 64 * 1024 * 1024)).toString('utf8') || '{}'); } catch { return json(res, 400, { error: 'bad json' }); } }
    requests.push({ t: Date.now(), method: req.method, path: p, headers: { ...req.headers }, body });
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) { res.writeHead(403); return res.end(); }

    if (p === '/mock/requests') return json(res, 200, requests);
    if (p === '/mock/reset') { requests.length = 0; loaded.clear(); return json(res, 200, {}); }
    if (p === '/api/version') return json(res, 200, { version: '0.0.0-mock' });
    if (p === '/api/tags') return json(res, 200, { models: MODELS.map((m) => ({ name: m.name, model: m.name, size: m.size, modified_at: '2026-11-21T00:00:00Z', details: { family: m.family, families: [m.family], parameter_size: '4B', quantization_level: 'Q4_K_M' } })) });
    if (p === '/api/ps') return json(res, 200, { models: [...loaded].map((n) => ({ name: n, model: n, size: find(n)?.size || 0, size_vram: Math.round((find(n)?.size || 0) * (vramFraction[n] ?? 1)) })) });
    if (p === '/api/show') {
      const m = find(body?.model);
      if (!m) return json(res, 404, { error: `model '${body?.model}' not found` });
      return json(res, 200, { capabilities: m.vision ? ['completion', 'vision'] : ['completion'], details: { family: m.family, families: [m.family] }, model_info: {} });
    }
    if (p === '/api/generate') {
      const m = find(body?.model);
      if (!m) return json(res, 404, { error: 'model not found' });
      if (body.keep_alive === 0 || body.keep_alive === '0') { loaded.delete(m.name); return json(res, 200, { model: m.name, response: '', done: true, done_reason: 'unload' }); }
      loaded.add(m.name);
      return json(res, 200, { model: m.name, response: 'ok', done: true });
    }
    if (p === '/api/chat') {
      const m = find(body?.model);
      if (!m) return json(res, 404, { error: `model '${body?.model}' not found, try pulling it first` });
      const msgs = Array.isArray(body.messages) ? body.messages : [];
      const last = [...msgs].reverse().find((x) => x.role === 'user') || { content: '' };
      if (last.images?.length && !m.vision) return json(res, 400, { error: 'this model does not support images' });
      loaded.add(m.name);
      const reply = body.format ? structuredReply(msgs, last) : proseReply(msgs, last);
      if (body.stream === false) return json(res, 200, { model: m.name, message: { role: 'assistant', content: reply }, done: true });
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      const chunks = reply.match(/[\s\S]{1,7}/g);
      for (const c of chunks) {
        if (res.destroyed) return;
        res.write(JSON.stringify({ model: m.name, created_at: new Date().toISOString(), message: { role: 'assistant', content: c }, done: false }) + '\n');
        await new Promise((r) => setTimeout(r, tokenMs));
      }
      res.end(JSON.stringify({ model: m.name, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', eval_count: chunks.length }) + '\n');
      return;
    }
    json(res, 404, { error: 'not found' });
  });
  return { server, requests, loaded };
}

// Run standalone: `node test/mock-ollama.js` -> http://127.0.0.1:11434 (dev only)
if (process.argv[1] && process.argv[1].endsWith('mock-ollama.js')) {
  const port = Number(process.env.PORT) || 11434;
  createMockOllama({ tokenMs: 20 }).server.listen(port, '127.0.0.1', () => console.log(`Mock Ollama on http://127.0.0.1:${port}`));
}
