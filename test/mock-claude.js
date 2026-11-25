// mock-claude.js - a fake Claude API (POST /v1/messages) for tests. The tests
// never call the real API: the server's Anthropic SDK is pointed here with
// baseURL. Same response shape as the Messages API (content blocks, stop_reason,
// usage). It plays a small scripted agent: the script is picked by a trigger in
// the user's latest text, and the step by how many assistant turns followed it.
//
//   (default)    get_form -> set_form (prompt, negative, 9:16, 2k) -> text
//   QUESTION     a text answer, no tools
//   SETTINGS     set_preset_settings { steps: 999 } (clamped) -> text
//   takes        add_variations (6 jobs that differ in light and angle) -> text
//   Fix this     set_form { prompt } (same seed) -> text            (viewer)
//   from 3       get_preset_graph klein-4b-edit -> propose_graph (picture:1..) -> text  (Files)
//   BADGRAPH     propose_graph with a node ComfyUI does not have, then a good one
//   NEVERGRAPH   propose_graph that is never valid (the server stops it after 3 tries)
//   REFUSE       stop_reason "refusal"
//   LOOP         get_form forever (the server's step cap stops it)
// Batch 19:
//   (write_prompt offered) get_form -> write_prompt -> text        (Prompt / Negative prompt ⋮)
//   REMEMBER     chat: "I see N earlier message(s)."
//   SETUP        chat: set_form { preset klein-4b-t2i, prompt } -> text
//   BUILDIT      chat on Haiku/Sonnet: build_workflow -> text; the Opus hand-off:
//                get_preset_graph z-image-turbo -> propose_graph "Chat build" -> text
//
// GET /mock/requests -> every request body (+ headers); POST /mock/reset.
// key (x-api-key or Authorization: Bearer) "sk-ant-bad-…" -> 401 authentication_error.
import http from 'node:http';
import { readBody } from '../server/multipart.js';

const USAGE = { input_tokens: 1200, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 2000 };

const tool = (name, input) => ({ type: 'tool_use', id: `toolu_${Math.random().toString(36).slice(2, 12)}`, name, input });
const text = (t) => ({ type: 'text', text: t });

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return { text: m.content, index: i };
    const t = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (t && !m.content.some((b) => b.type === 'tool_result')) return { text: t, index: i, images: m.content.filter((b) => b.type === 'image').length };
  }
  return { text: '', index: 0 };
}
const lastToolResult = (messages) => { const m = messages.at(-1); return Array.isArray(m?.content) ? m.content.find((b) => b.type === 'tool_result') : null; };

function script(body) {
  const { text: t, index, images = 0 } = lastUserText(body.messages);
  const step = body.messages.slice(index + 1).filter((m) => m.role === 'assistant').length;
  const res = lastToolResult(body.messages);
  const has = (name) => (body.tools || []).some((x) => x.name === name);
  if (/^Build a one-off workflow for this chat/.test(t)) {
    if (step === 0) return { content: [tool('get_preset_graph', { id: 'ai:z-image-turbo' })] };
    if (step === 1 && res && !res.is_error) return { content: [tool('propose_graph', { name: 'Chat build', graph: JSON.parse(res.content), prompt: 'a lighthouse at dawn' })] };
    return { content: [text('Built it from Z-Image Turbo.')] };
  }
  if (/REMEMBER/.test(t)) return { content: [text(`I see ${body.messages.length - 1} earlier message(s).`)] };
  if (/SETUP/.test(t)) {
    if (step === 0) return { content: [tool('set_form', { preset: 'ai:klein-4b-t2i', prompt: 'a lighthouse at dawn' })] };
    return { content: [text('Set up FLUX.2 Klein 4B with your lighthouse prompt.')] };
  }
  if (/BUILDIT/.test(t) && has('build_workflow')) {
    if (step === 0) return { content: [tool('build_workflow', { what: 'text to image of a lighthouse' })] };
    return { content: [text('Built a workflow and loaded it into the form.')] };
  }
  if (has('write_prompt') && !/QUESTION|REFUSE|LOOP/.test(t)) {
    if (step === 0) return { content: [tool('get_form', {})] };
    if (step === 1) return { content: [tool('write_prompt', { text: /NEGATIVE/.test(t) ? 'blurry, low detail, watermark' : 'Cinematic low-angle shot of a weathered scout mech in a pine forest at night, heavy rain, sodium streetlight' })] };
    return { content: [text('Wrote it.')] };
  }
  if (/REFUSE/.test(t)) return { content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'test' } };
  if (/QUESTION/.test(t)) return { content: [text(`A higher guidance makes it follow the prompt more closely. (I can see ${images} picture(s).)`)] };
  if (/LOOP/.test(t)) return { content: [tool('get_form', {})] };
  if (/SETTINGS/.test(t)) {
    if (step === 0) return { content: [tool('set_preset_settings', { values: { steps: 999 } })] };
    return { content: [text('Raised the steps as far as this preset allows.')] };
  }
  if (/takes/.test(t)) {
    if (step === 0) {
      const moods = ['Sodium streetlight, heavy rain', 'Moonlit blue fog, drizzle', 'Lightning flash, storm'];
      const jobs = moods.flatMap((m) => [['Low angle · 24mm', 'low angle shot, 24mm'], ['High angle · 50mm', 'high angle shot, 50mm']].map(([a, p]) => ({ label: `${m} · ${a}`, prompt: `A weathered scout mech, ${m.toLowerCase()}, ${p}` })));
      return { content: [tool('add_variations', { jobs })] };
    }
    return { content: [text('Added 6 jobs to the batch: three lighting moods, each from a low and a high angle.')] };
  }
  if (/NEVERGRAPH/.test(t)) {
    if (res && /Too many tries/.test(JSON.stringify(res.content))) return { content: [text('I could not build a workflow for that on your PC.')] };
    return { content: [tool('propose_graph', { name: 'Never', graph: { 1: { class_type: 'NoSuchNode', inputs: {} }, 2: { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'x' } } } })] };
  }
  if (/from 3|BADGRAPH/.test(t)) {
    if (step === 0) return { content: [tool('get_preset_graph', { id: 'ai:klein-4b-edit' })] };
    if (step === 1 && /BADGRAPH/.test(t)) return { content: [tool('propose_graph', { name: 'Broken', graph: { 1: { class_type: 'NoSuchNode', inputs: {} }, 2: { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'x' } } } })] };
    if (res && !res.is_error && /"class_type"/.test(String(res.content))) {
      const g = JSON.parse(res.content);
      let n = 0;
      for (const node of Object.values(g)) if (node.class_type === 'LoadImage') node.inputs.image = `picture:${++n}`;
      return { content: [tool('propose_graph', { name: 'Merge 4 looks', graph: g, prompt: 'The robot from picture 3, lit like picture 1', roles: ['lighting', 'colours', 'subject', 'texture'] })] };
    }
    if (res?.is_error) return { content: [tool('get_preset_graph', { id: 'ai:klein-4b-edit' })] };
    return { content: [text('No preset takes 4 pictures, so I built one. It uses picture 3 as the subject.')] };
  }
  if (/Fix this result/.test(t)) {
    if (step === 0) return { content: [tool('set_form', { prompt: 'A weathered scout mech with clean five-fingered hands, scratched and rusty armor' })] };
    return { content: [text('Rewrote the prompt for cleaner hands and dirtier armor; same seed so you can compare.')] };
  }
  // default: fill in the form
  if (step === 0) return { content: [text('Let me look at the form.'), tool('get_form', {})] };
  if (step === 1) return { content: [tool('set_form', { prompt: 'Cinematic low-angle shot of a weathered scout mech in a pine forest at night, heavy rain, sodium streetlight', negative: 'bright daylight, cartoon', aspect: '9:16', resolution: '2k' })] };
  return { content: [text('Made it night with heavy rain, tall 9:16 for a wallpaper, at 2K.')] };
}

export function createMockClaude() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'request-id': 'req_mock' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/mock/requests') return json(200, requests);
    if (url.pathname === '/mock/reset') { requests.length = 0; return json(200, { ok: true }); }
    if (url.pathname !== '/v1/messages' || req.method !== 'POST') return json(404, { type: 'error', error: { type: 'not_found_error', message: 'Not found' } });
    let body;
    try { body = JSON.parse((await readBody(req, 50 * 1024 * 1024)).toString('utf8')); } catch { return json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Bad JSON' } }); }
    // The key comes as x-api-key (older SDKs, the stand-in) or Authorization: Bearer (SDK 1.x).
    const key = req.headers['x-api-key'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    requests.push({ body, headers: { 'x-api-key': key ? 'present' : '', 'anthropic-beta': req.headers['anthropic-beta'] || '', 'anthropic-version': req.headers['anthropic-version'] || '' } });
    if (!key) return json(401, { type: 'error', error: { type: 'authentication_error', message: 'x-api-key header is required' } });
    if (/^sk-ant-bad/.test(key)) return json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    if (!body.model || !Array.isArray(body.messages) || !body.max_tokens) return json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'model, messages and max_tokens are required' } });
    const s = script(body);
    const stop = s.stop_reason || (s.content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn');
    json(200, { id: `msg_${Math.random().toString(36).slice(2, 12)}`, type: 'message', role: 'assistant', model: body.model, content: s.content, stop_reason: stop, stop_sequence: null, stop_details: s.stop_details || null, usage: USAGE });
  });
  return { server, requests };
}

/**
 * Tests only, when @anthropic-ai/sdk is not installed in node_modules: a tiny
 * stand-in with the same call the server makes (client.beta.messages.create),
 * sent to the fake server above. Production code always uses the real SDK.
 */
export function fetchClient({ apiKey, baseURL }) {
  return { beta: { messages: { async create({ betas, ...body }) {
    const r = await fetch(`${baseURL}/v1/messages?beta=true`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', ...(betas?.length ? { 'anthropic-beta': betas.join(',') } : {}) }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw Object.assign(new Error(j?.error?.message || `HTTP ${r.status}`), { status: r.status });
    return j;
  } } } };
}

/** Use the real SDK when it is installed (pointed at baseURL), else fetchClient. */
export async function testClaudeOptions(baseURL) {
  try { await import('@anthropic-ai/sdk'); return { baseURL, sdk: 'real' }; } catch { return { baseURL, makeClient: fetchClient, sdk: 'stand-in' }; }
}

// node test/mock-claude.js -> a fake Claude on :8799
if (process.argv[1] && /mock-claude\.js$/.test(process.argv[1])) {
  const { server } = createMockClaude();
  server.listen(8799, '127.0.0.1', () => console.log('mock Claude on http://127.0.0.1:8799'));
}
