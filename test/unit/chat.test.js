// Chat + workflow actions: reply parsing (valid / malformed / fallback /
// no-change), prompt diff, context building (prompt, seed, base64 image),
// action manifests (validation, clamping, resolving, graph wiring), and the
// server side: /ollama allow-listed proxy, /api/chats on disk, /api/actions,
// /api/ollama/unload, offline Ollama, ComfyUI root-path fallback.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startStack, ROOT } from './helpers.js';
import { parseReply, firstJsonObject, replySchema, REPLY_SCHEMA, stripPraise } from '../../app/js/lib/chat-reply.js';
import { diffWords } from '../../app/js/lib/prompt-diff.js';
import { buildMessages, styleFor } from '../../app/js/lib/chat-context.js';
import { validateAction, clampParams, resolveChoice, buildActionGraph, describeChoice, actionsForPrompt } from '../../app/js/lib/actions.js';

const loadAction = (id) => validateAction(id, JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows/actions', id + '.json'), 'utf8')));
const ACTIONS = ['upscale', 'image-to-3d'].map(loadAction);
const fast = { id: 'fast-concept', workflow: JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows/fast-concept.json'), 'utf8')) };

// ---- parseReply ----------------------------------------------------------------
test('parseReply: valid structured JSON -> reply + prompt (+ negative, action)', () => {
  const r = parseReply(JSON.stringify({ reply: 'Here you go', prompt: 'a purple duck', negative: 'blurry', action: null }), { prompt: 'a duck' });
  assert.equal(r.how, 'json'); assert.equal(r.reply, 'Here you go'); assert.equal(r.prompt, 'a purple duck'); assert.equal(r.negative, 'blurry');
  assert.equal(r.changed, true); assert.equal(r.action, null);
});

test('parseReply: malformed output - prose around a ```json block, or a bare {...} span', () => {
  const a = parseReply('Sure!\n```json\n{"reply":"Fixed","prompt":"a duck, short neck"}\n```\nEnjoy', { prompt: 'a duck' });
  assert.equal(a.how, 'json-block'); assert.equal(a.prompt, 'a duck, short neck'); assert.equal(a.reply, 'Fixed');
  const b = parseReply('Ok {"reply":"x {y}","prompt":"two \\"quoted\\" words"} trailing', {});
  assert.equal(b.how, 'json-block'); assert.equal(b.prompt, 'two "quoted" words');
  assert.equal(firstJsonObject('a {"k":"}"} b'), '{"k":"}"}');
});

test('parseReply: truncated JSON / plain text -> chat only, prompt untouched', () => {
  const t = parseReply('{"reply": "Here is a new prompt", "prompt": "a purple duck on a la', { prompt: 'keep me' });
  assert.equal(t.how, 'text'); assert.equal(t.prompt, null); assert.equal(t.changed, false);
  assert.match(t.reply, /^Here is a new prompt\n\n\(The model's answer was cut off/);
  const g = parseReply('Sure! I think it is lovely.', { prompt: 'keep me' });
  assert.deepEqual([g.how, g.prompt, g.reply], ['text', null, 'Sure! I think it is lovely.']);
});

test('parseReply: ```prompt block / "Prompt:" line fallback', () => {
  const a = parseReply('Try this:\n\n```prompt\na red fox in snow\n```\n\nMore?', {});
  assert.equal(a.how, 'prompt-block'); assert.equal(a.prompt, 'a red fox in snow'); assert.equal(a.reply, 'Try this:\n\nMore?');
  const b = parseReply('Revised prompt: "a blue fox"', {});
  assert.equal(b.prompt, 'a blue fox');
});

test('parseReply: same prompt as the box = no change; null prompt = no change', () => {
  const r = parseReply(JSON.stringify({ reply: 'Already there', prompt: '  a purple duck ' }), { prompt: 'a purple duck' });
  assert.equal(r.prompt, null); assert.equal(r.changed, false);
  const q = parseReply(JSON.stringify({ reply: 'Refocused', prompt: 'the duck\u2019s  solitary presence \u2014 at dusk' }), { prompt: "the duck's solitary presence - at dusk" });
  assert.equal(q.changed, false, 'typographic-only edits are not a change');
  const n = parseReply(JSON.stringify({ reply: 'Just chatting', prompt: null }), { prompt: 'x' });
  assert.equal(n.changed, false); assert.equal(n.reply, 'Just chatting');
});

test('parseReply: action choice parsed; image_ref lifted out of params', () => {
  const r = parseReply(JSON.stringify({ reply: 'ok', prompt: null, action: { action: 'upscale', params: { scale: 3, image_ref: 'img2' } } }), {});
  assert.deepEqual(r.action, { action: 'upscale', params: { scale: 3 }, image_ref: 'img2' });
  const s = replySchema(ACTIONS);
  const variants = s.properties.action.anyOf;
  assert.equal(variants[0].type, 'null');
  assert.deepEqual(variants.slice(1).map((v) => v.properties.action.enum[0]).sort(), ['image-to-3d', 'upscale']);
  assert.deepEqual(REPLY_SCHEMA.required, ['reply', 'prompt']);
});

test('stripPraise: removes leading praise/filler sentences only (live gemma3:4b examples)', () => {
  const cases = [
    ['Fantastic! The image looks great – you nailed the mood and the details. Let\'s upscale this to bring out the sharpness and detail.', "Let's upscale this to bring out the sharpness and detail."],
    ['Excellent! Adding dusk light and a red scarf will shift the mood. I updated the prompt.', 'Adding dusk light and a red scarf will shift the mood. I updated the prompt.'],
    ["Okay, let's build on that! This sounds like a great starting point. I'll refine the prompt.", "I'll refine the prompt."],
    ['You are absolutely right! The neck reads as a swan, so I shortened it.', 'The neck reads as a swan, so I shortened it.'],
    ['Got it! I added a red scarf.', 'I added a red scarf.'],
    ['What a fun idea! I wrote a prompt for it.', 'I wrote a prompt for it.'],
  ];
  for (const [inp, out] of cases) assert.equal(stripPraise(inp), out, inp);
});

test('stripPraise: never mangles real content', () => {
  const keep = [
    'Great Wall of China at dusk is now the setting.',
    'Nice, France is now the setting.',
    'Sure thing, I changed the sky to red! More text.',
    'The image looks great but the neck is too long, so I shortened it. Rest unchanged.',
    'Perfect symmetry was removed because it looked artificial.',
    'I added dusk light. The scarf is red.',
    'Great!', 'Love it!',
    'Changed: "a great idea for a poster" is now the subtitle text.',
    '',
  ];
  for (const t of keep) assert.equal(stripPraise(t), t, t);
  // praise later in the text is left alone (only LEADING sentences are touched)
  assert.equal(stripPraise('I set the light to dusk. It looks great.'), 'I set the light to dusk. It looks great.');
  // parseReply applies it to the reply, never to the prompt
  const r = parseReply(JSON.stringify({ reply: 'Fantastic! I added rain.', prompt: 'a fantastic, great looking duck. Love it!' }), { prompt: 'x' });
  assert.equal(r.reply, 'I added rain.'); assert.equal(r.prompt, 'a fantastic, great looking duck. Love it!');
});

test('system prompt asks for plain, praise-free replies', () => {
  const sys = buildMessages({ current: { prompt: 'x' }, history: [], images: {}, actions: [], userText: 'hi' })[0].content;
  assert.match(sys, /TONE: plain and factual/); assert.match(sys, /No compliments or praise/); assert.match(sys, /no exclamation marks/);
});

test('diffWords: marks added and removed words', () => {
  const d = diffWords('a purple swan on a pond', 'a purple duck on a pond at night');
  assert.deepEqual(d.filter((x) => x.op !== 'same').map((x) => [x.op, x.text.trim()]), [['del', 'swan'], ['add', 'duck'], ['add', 'at night']]);
});

// ---- context ----------------------------------------------------------------------
test('buildMessages: current prompt + negative + image prompt/seed in system; base64 only on the new message', () => {
  const msgs = buildMessages({
    current: { prompt: 'a purple duck', negative: 'blurry', negativeOn: true, hasNegative: true, preset: 'Fast concept', workflow: fast },
    history: [{ role: 'user', content: 'duck pls', images: ['img1'] }, { role: 'assistant', content: 'ok', prompt: 'a purple duck' }],
    images: { img1: { prompt: 'a purple duck', seed: 4242, preset: 'fast-concept' } },
    actions: ACTIONS, userText: 'looks like a swan', newImages: [{ ref: 'img1', base64: 'AAAA' }],
  });
  const sys = msgs[0].content;
  assert.equal(msgs[0].role, 'system');
  assert.match(sys, /CURRENT PROMPT BOX[\s\S]*a purple duck/);
  assert.match(sys, /CURRENT NEGATIVE PROMPT:\n"""blurry"""/);
  assert.match(sys, /img1: generated with prompt "a purple duck", seed 4242/);
  assert.match(sys, /FLUX\.2 \[klein\]/);
  assert.match(sys, /"upscale"/); assert.match(sys, /"image-to-3d"/);
  assert.equal(msgs[1].images, undefined);
  assert.match(msgs[1].content, /\[attached: img1\]/);
  assert.equal(JSON.parse(msgs[2].content).prompt, 'a purple duck');
  assert.deepEqual(msgs.at(-1).images, ['AAAA']);
  assert.match(msgs.at(-1).content, /looks like a swan\n\[attached: img1\]/);
  assert.match(styleFor(null), /natural-language/);
});

// ---- actions -----------------------------------------------------------------------
test('action manifests: shipped actions are valid; bad manifests are rejected with a reason', () => {
  assert.ok(ACTIONS.every((a) => a.ok), JSON.stringify(ACTIONS.map((a) => a.error)));
  const good = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows/actions/upscale.json'), 'utf8'));
  const bad = (mut) => { const f = structuredClone(good); mut(f); return validateAction('x', f); };
  assert.match(bad((f) => { delete f.action; }).error, /manifest/);
  assert.match(bad((f) => { f.workflow['10']._meta.title = 'Image'; }).error, /#image/);
  assert.match(bad((f) => { f.action.image.node = '12'; }).error, /LoadImage/);
  assert.match(bad((f) => { f.workflow['13']._meta.title = 'Resize'; }).error, /#expose/);
  assert.match(bad((f) => { f.action.params.scale.input = 'image'; }).error, /link/);
  assert.match(bad((f) => { f.action.params.scale.default = 9; }).error, /default outside/);
  assert.match(bad((f) => { f.action.params.model.default = 'nope.pth'; }).error, /default not in options/);
  assert.match(bad((f) => { f.action.params.scale.type = 'weird'; }).error, /type/);
  assert.match(bad((f) => { f.workflow['12'] = { inputs: {} }; }).error, /API format/);
});

test('clampParams: out-of-range clamped, ints rounded, bad enum -> default, unknown keys ignored (all noted)', () => {
  const up = ACTIONS[0].manifest, td = ACTIONS[1].manifest;
  const a = clampParams(up, { scale: 9, model: 'realesrgan_x4plus.safetensors', foo: 1 });
  assert.deepEqual(a.params, { scale: 4, model: 'RealESRGAN_x4plus.safetensors' });
  assert.equal(a.notes.length, 2);
  assert.deepEqual(clampParams(up, { scale: '3x' }).params.scale, 3);
  assert.deepEqual(clampParams(up, { model: 'evil.pth' }).params.model, '4x-UltraSharp.safetensors');
  assert.deepEqual(clampParams(td, { steps: 33.6, detail: 5000 }).params, { steps: 34, detail: 384, seed: 12345 });
  assert.deepEqual(clampParams(up, {}).params, { scale: 2, model: '4x-UltraSharp.safetensors' });
});

test('resolveChoice: unknown action rejected; missing/unknown image_ref falls back to the last discussed image; no image -> error', () => {
  const images = { img1: { filename: 'a.png', subfolder: 'concept-app', type: 'output' }, img2: { filename: 'b.png', subfolder: '', type: 'output' } };
  const u = resolveChoice({ action: 'teleport', params: {} }, ACTIONS, images, 'img1');
  assert.equal(u.ok, false); assert.match(u.error, /Unknown action "teleport"/);
  const f = resolveChoice({ action: 'upscale', params: { scale: 9 } }, ACTIONS, images, 'img2');
  assert.equal(f.ok, true); assert.equal(f.imageRef, 'img2'); assert.equal(f.params.scale, 4); assert.match(f.notes[0], /outside 1.5-4/);
  assert.equal(describeChoice(f), 'Upscale (scale 4, model 4x-UltraSharp.safetensors)');
  const x = resolveChoice({ action: 'upscale', image_ref: 'img9' }, ACTIONS, images, 'img1');
  assert.equal(x.imageRef, 'img1'); assert.ok(x.notes.some((n) => /img9/.test(n)));
  assert.equal(resolveChoice({ action: 'Upscale', image_ref: 'img1' }, ACTIONS, images, null).imageRef, 'img1');
  const none = resolveChoice({ action: 'upscale' }, ACTIONS, {}, null);
  assert.equal(none.ok, false); assert.match(none.error, /No image/);
});

test('resolveChoice: the user\'s words win when the model picks the wrong action (seen live with gemma3:4b)', () => {
  const r = resolveChoice({ action: 'image-to-3d', params: { steps: 30 } }, ACTIONS, { img1: { filename: 'a.png' } }, 'img1', 'Nice. Now upscale img1 3x please.');
  assert.equal(r.action.id, 'upscale'); assert.equal(r.params.scale, 3); assert.match(r.notes[0], /you asked for Upscale/);
});

test('resolveChoice: an action the user did not ask for is dropped (seen live with gemma3:4b)', () => {
  const imgs = { img1: { filename: 'a.png' } };
  const r = resolveChoice({ action: 'image-to-3d', params: {} }, ACTIONS, imgs, 'img1', 'A purple duck at a misty pond, concept art for a kids game');
  assert.equal(r.ok, false); assert.equal(r.unasked, true);
  assert.equal(resolveChoice({ action: 'image-to-3d' }, ACTIONS, imgs, 'img1', 'turn it into a mesh').ok, true);
  assert.equal(resolveChoice({ action: 'upscale' }, ACTIONS, imgs, 'img1', 'run Upscale on it').ok, true);
});

test('buildActionGraph: image wired into the #image LoadImage node, params written (divideBy), prefixes, source untouched', () => {
  const up = ACTIONS[0];
  const before = JSON.stringify(up.workflow);
  const g = buildActionGraph(up, { scale: 3, model: 'RealESRGAN_x4plus.safetensors' }, 'concept-app/concept_00001_.png [output]', 'concept-app');
  assert.equal(g['10'].inputs.image, 'concept-app/concept_00001_.png [output]');
  assert.equal(g['13'].inputs.scale_by, 0.75);
  assert.equal(g['11'].inputs.model_name, 'RealESRGAN_x4plus.safetensors');
  assert.equal(g['14'].inputs.filename_prefix, 'concept-app/upscale');
  assert.equal(JSON.stringify(up.workflow), before);
  const td = buildActionGraph(ACTIONS[1], { steps: 20, detail: 256, seed: 7 }, 'ref.png', 'concept-app');
  assert.equal(td['2'].inputs.image, 'ref.png'); assert.equal(td['7'].inputs.steps, 20); assert.equal(td['7'].inputs.seed, 7);
  assert.equal(td['10'].inputs.filename_prefix, 'concept-app/mesh');
  assert.ok(!Object.keys(td).some((k) => k.startsWith('_')));
  assert.match(actionsForPrompt(ACTIONS), /scale: number 1.5-4 \(default 2\)/);
});

// ---- server -----------------------------------------------------------------------
let s;
before(async () => { s = await startStack(); });
after(async () => { await s.close(); });
const j = (r) => r.json();
const oreq = async () => (await (await fetch(s.ollamaBase + '/mock/requests')).json());

test('/ollama proxy: tags + show pass through (Origin rewritten to localhost), chat streams NDJSON', async () => {
  const tags = await j(await fetch(s.base + '/ollama/api/tags', { headers: { Origin: 'https://pc.example.ts.net' } }));
  assert.deepEqual(tags.models.map((m) => m.name), ['gemma3:4b', 'llama3.2:3b']);
  const show = await j(await fetch(s.base + '/ollama/api/show', { method: 'POST', body: JSON.stringify({ model: 'gemma3:4b' }), headers: { Origin: 'https://evil.example' } }));
  assert.ok(show.capabilities.includes('vision'));
  const r = await fetch(s.base + '/ollama/api/chat', { method: 'POST', body: JSON.stringify({ model: 'gemma3:4b', messages: [{ role: 'user', content: 'a fox' }], format: REPLY_SCHEMA }) });
  assert.equal(r.status, 200);
  const lines = (await r.text()).trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.length > 3); assert.equal(lines.at(-1).done, true);
  const p = parseReply(lines.map((l) => l.message?.content || '').join(''), {});
  assert.equal(p.how, 'json'); assert.match(p.prompt, /a fox/);
  assert.ok((await oreq()).filter((q) => q.path === '/api/show').every((q) => /127\.0\.0\.1/.test(q.headers.origin)));
});

test('/ollama proxy: only the allow-list gets through (pull/delete/generate/create -> 403)', async () => {
  for (const [m, p] of [['POST', '/api/pull'], ['DELETE', '/api/delete'], ['POST', '/api/generate'], ['POST', '/api/create'], ['GET', '/api/chat'], ['POST', '/api/tags/../pull']]) {
    const r = await fetch(s.base + '/ollama' + p, { method: m, body: m === 'GET' ? undefined : '{}' });
    assert.equal(r.status, 403, `${m} ${p}`);
  }
  assert.ok(!(await oreq()).some((q) => ['/api/pull', '/api/delete', '/api/create'].includes(q.path)));
});

test('/api/ollama/unload: unloads loaded models with keep_alive 0 and confirms with /api/ps', async () => {
  await fetch(s.base + '/ollama/api/chat', { method: 'POST', body: JSON.stringify({ model: 'gemma3:4b', messages: [{ role: 'user', content: 'hi' }], stream: false }) });
  assert.deepEqual([...s.ollama.loaded], ['gemma3:4b']);
  const u = await j(await fetch(s.base + '/api/ollama/unload', { method: 'POST' }));
  assert.deepEqual(u, { ollama: true, loaded: ['gemma3:4b'], unloaded: ['gemma3:4b'], stillLoaded: [] });
  const gen = (await oreq()).filter((q) => q.path === '/api/generate').at(-1);
  assert.deepEqual(gen.body, { model: 'gemma3:4b', keep_alive: 0 });
});

test('/api/chats: create, update, list, get, delete - persisted in data/chats.json next to history.json', async () => {
  const c = await j(await fetch(s.base + '/api/chats', { method: 'POST', body: JSON.stringify({ title: 'Duck  ideas', model: 'gemma3:4b', messages: [{ role: 'user', content: 'a duck', images: [{ ref: 'img1', filename: 'a.png', subfolder: 'concept-app', type: 'output', prompt: 'a duck', seed: 5 }] }] }) }));
  assert.equal(c.title, 'Duck ideas');
  const u = await j(await fetch(`${s.base}/api/chats/${c.id}`, { method: 'PUT', body: JSON.stringify({ messages: [...c.messages, { role: 'assistant', content: 'ok', prompt: 'a purple duck', applied: true, action: { action: 'upscale', params: { scale: 2, evil: { x: 1 } }, image_ref: 'img1' }, actionState: 'run' }, { role: 'system', content: 'injected' }] }) }));
  assert.equal(u.messages.length, 2);
  assert.deepEqual(u.messages[1].action, { action: 'upscale', params: { scale: 2 }, image_ref: 'img1' });
  assert.equal(u.messages[1].applied, true);
  assert.equal(u.messages[0].images[0].seed, 5);
  const list = (await j(await fetch(s.base + '/api/chats'))).chats;
  assert.equal(list[0].id, c.id); assert.equal(list[0].count, 2); assert.equal(list[0].messages, undefined);
  const disk = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'chats.json'), 'utf8'));
  assert.equal(disk.chats[0].messages[1].prompt, 'a purple duck');
  assert.ok(fs.existsSync(path.join(s.dataDir, 'chats.json')) && path.dirname(path.join(s.dataDir, 'chats.json')) === s.dataDir);
  assert.equal((await fetch(`${s.base}/api/chats/${c.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(`${s.base}/api/chats/${c.id}`)).status, 404);
});

test('/api/actions lists the shipped actions; a broken action file is listed as invalid', async () => {
  fs.writeFileSync(path.join(s.wfDir, 'actions', 'broken.json'), '{"action":{"name":"x"},"workflow":{}}');
  const { actions } = await j(await fetch(s.base + '/api/actions'));
  assert.deepEqual(actions.filter((a) => a.ok).map((a) => a.id), ['image-to-3d', 'upscale']);
  assert.equal(actions.find((a) => a.id === 'broken').ok, false);
  // actions/ is a folder: it never shows up as a preset
  const { workflows } = await j(await fetch(s.base + '/api/workflows'));
  assert.ok(!workflows.some((w) => !w.ai && /actions|upscale|broken/.test(w.id)));
});

test('history keeps action results linked to their parent image (and non-image files)', async () => {
  const e = await j(await fetch(s.base + '/api/history', { method: 'POST', body: JSON.stringify({ prompt: 'Make a 3D model · a duck', workflow: 'action:image-to-3d', action: 'image-to-3d', params: { steps: 20 }, parent: { historyId: 'h_x', image: { filename: 'a.png', subfolder: 'concept-app', type: 'output' } }, promptId: 'p1' }) }));
  const p = await j(await fetch(`${s.base}/api/history/${e.id}`, { method: 'PATCH', body: JSON.stringify({ files: [{ filename: 'mesh_00001_.glb', subfolder: 'concept-app', type: 'output' }], status: 'done' }) }));
  assert.equal(p.files[0].filename, 'mesh_00001_.glb'); assert.equal(p.parent.historyId, 'h_x'); assert.equal(p.action, 'image-to-3d');
});

test('ComfyUI extensions that use root paths (/scripts/*, /api/* from a /comfy/ page) reach ComfyUI', async () => {
  const a = await fetch(s.base + '/scripts/app.js');
  assert.match(await a.text(), /mock: unknown \/scripts\/app\.js/);
  const b = await fetch(s.base + '/api/tts-audio-suite/settings', { headers: { Referer: s.base + '/comfy/' } });
  assert.match(await b.text(), /mock: unknown \/api\/tts-audio-suite\/settings/);
  const fav = await fetch(s.base + '/favicon.ico');
  assert.equal(fav.status, 200); assert.equal(fav.headers.get('content-type'), 'image/png');
  const c = await j(await fetch(s.base + '/api/tts-audio-suite/settings'));
  assert.equal(c.error, 'Unknown API route');
});

test('Ollama down: /ollama/* answers 502 "Ollama unreachable", unload reports ollama:false, app keeps working', async () => {
  const d = await startStack({ ollamaDown: true });
  try {
    const r = await fetch(d.base + '/ollama/api/tags');
    assert.equal(r.status, 502); assert.equal((await r.json()).error, 'Ollama unreachable');
    const u = await j(await fetch(d.base + '/api/ollama/unload', { method: 'POST' }));
    assert.equal(u.ollama, false);
    assert.equal((await j(await fetch(d.base + '/api/config'))).comfyReachable, true);
  } finally { await d.close(); }
});
