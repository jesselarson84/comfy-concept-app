// Batch 16: Claude on the PC (server/claude.js). Never the real API: a fake
// Claude (test/mock-claude.js) stands in, reached through the SDK's baseURL.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStack, ROOT } from './helpers.js';
import { costOf, SpendStore, KeyStore, ClaudeSettings, normAspect, checkFields, graphShapeError, resetDate, toolsFor, describeError } from '../../server/claude.js';

const KEY = 'sk-ant-test-0123456789abcdefghijklmnop';
let s;
const call = async (method, p, body) => {
  const r = await fetch(s.base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};
const ask = (body) => call('POST', '/api/claude/ask', { mode: 'prompt', form: { preset: 'ai:klein-4b-t2i', prompt: 'a mech' }, ...body });
const requests = async () => (await fetch(s.claudeBase + '/mock/requests')).json();
const reset = () => fetch(s.claudeBase + '/mock/reset', { method: 'POST' });

before(async () => { s = await startStack({ claude: true, folderWorkflows: false }); });
after(async () => { await s?.close(); });

test('cost: input, output, cache write and cache read at each model\'s price', () => {
  const u = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 };
  assert.equal(costOf('claude-opus-5-5', u), 4 + 20 + 5 + 0.2);
  assert.equal(costOf('claude-sonnet-5-5', u), 2 + 10 + 2.5 + 0.1);
  assert.ok(Math.abs(costOf('claude-haiku-5-5', u) - (0.1 + 0.5 + 0.125 + 0.01)) < 1e-9);
  assert.equal(costOf('claude-mystery', { output_tokens: 1e6 }), 20, 'unknown model priced like Opus, never free');
});

test('spend: adds up per month, resets on the 1st, says when the limit is reached', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-spend-'));
  let now = new Date(2026, 10, 24, 12);
  const sp = new SpendStore(dir, { now: () => now });
  sp.add(1.5); sp.add(0.25);
  assert.equal(sp.spent(), 1.75);
  assert.deepEqual({ ...sp.status(2), requests: undefined }, { spentUsd: 1.75, requests: undefined, limitUsd: 2, month: '2026-11', resetsOn: '2026-12-01', limitReached: false });
  sp.add(0.3);
  assert.equal(sp.status(2).limitReached, true);
  now = new Date(2026, 11, 1, 0, 5);
  assert.equal(sp.spent(), 0, 'a new month starts at zero');
  assert.equal(resetDate(new Date(2026, 11, 31)), '2027-01-01');
});

test('key: saved on the PC with no way to read it back; env var works too', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-key-'));
  const k = new KeyStore(dir, {});
  assert.deepEqual(k.status(), { hasKey: false, source: null });
  assert.throws(() => k.set('hello'), /does not look like/);
  k.set(KEY);
  assert.equal(k.get(), KEY);
  assert.deepEqual(k.status(), { hasKey: true, source: 'saved' });
  assert.deepEqual(new KeyStore(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-key-')), { ANTHROPIC_API_KEY: KEY }).status(), { hasKey: true, source: 'env' });
  // over HTTP: never echoed back, in any route
  const r1 = await call('POST', '/api/claude/key', { key: KEY });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.hasKey, true);
  const all = JSON.stringify([r1.body, (await call('GET', '/api/claude')).body, (await call('POST', '/api/claude', { limitUsd: 20 })).body]);
  assert.doesNotMatch(all, /sk-ant/);
  assert.ok(fs.existsSync(path.join(s.dataDir, 'claude-key.json')), 'stored in data/');
  // git never sees it
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(gi, /^data\/$/m); assert.match(gi, /claude-key\.json/); assert.match(gi, /claude-spend\.json/);
});

test('settings: off by default, $20, Haiku; limits checked', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-set-'));
  const st = new ClaudeSettings(dir);
  assert.deepEqual(st.get(), { enabled: false, limitUsd: 20, defaultModel: 'haiku' });
  assert.throws(() => st.set({ limitUsd: -1 }), /between/);
  assert.throws(() => st.set({ defaultModel: 'gpt' }), /Unknown model/);
  assert.equal(st.set({ limitUsd: '12.345', defaultModel: 'opus' }).limitUsd, 12.35);
});

test('switched off: nothing is sent', async () => {
  await reset();
  await call('POST', '/api/claude', { enabled: false });
  const r = await ask({ text: 'make it rain' });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'off');
  assert.equal((await requests()).length, 0);
});

test('tool checks: aspect, resolution, batch, seed, preset', () => {
  assert.equal(normAspect('9:16'), '16:9-portrait');
  assert.equal(normAspect('16:9'), '16:9-landscape');
  assert.equal(normAspect('1:1'), '1:1');
  assert.equal(normAspect('3:2-portrait'), '3:2-portrait');
  assert.equal(normAspect('7:3'), null);
  const presetOf = (id) => ({ 'ai:x': { id: 'ai:x', ok: true }, 'ai:off': { id: 'ai:off', ok: true, availability: { status: 'unavailable', reason: 'model missing' } } })[id] || null;
  const r = checkFields({ aspect: '4:3', resolution: '2K', batch: 50, seed: 'random', preset: 'ai:x' }, { presetOf, maxBatch: 8 });
  assert.deepEqual(r.changes, { aspect: '4:3-landscape', res: '2k', batch: 8, seed: 'random', preset: 'ai:x' });
  assert.deepEqual(r.errors, []);
  const bad = checkFields({ aspect: 'tall', resolution: '8k', seed: -4, preset: 'ai:off' }, { presetOf });
  assert.equal(bad.errors.length, 4);
  assert.match(bad.errors.join(' '), /unavailable: model missing/);
  assert.equal(graphShapeError([]), 'graph must be an object of nodes keyed by id');
  assert.match(graphShapeError({ 1: { class_type: 'KSampler', inputs: {} } }), /no output node/);
  // what Claude can do: exactly these tools, nothing that deletes, queues or touches Drive
  const names = toolsFor(true).map((t) => t.name);
  assert.deepEqual(names, ['get_form', 'list_presets', 'get_preset', 'search_history', 'view_picture', 'set_form', 'set_preset_settings', 'load_pictures', 'add_variations', 'get_preset_graph', 'node_info', 'propose_graph']);
  assert.ok(!toolsFor(false).some((t) => t.name === 'propose_graph'), 'only Opus builds workflows');
  assert.equal(describeError(Object.assign(new Error('x'), { status: 401 })).message, 'The API key was refused. Replace it in Settings.');
});

test('the prompt box: Claude fills in the form (checked) and stops; cached prompt + tools, adaptive thinking, effort set', async () => {
  await call('POST', '/api/claude', { enabled: true, limitUsd: 20, defaultModel: 'haiku' });
  await reset();
  const r = await ask({ text: 'Same mech but at night in heavy rain, tall for a wallpaper' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.model, 'haiku');
  const form = r.body.actions.find((a) => a.type === 'form');
  assert.deepEqual(form.changes, { prompt: 'Cinematic low-angle shot of a weathered scout mech in a pine forest at night, heavy rain, sodium streetlight', negative: 'bright daylight, cartoon', aspect: '16:9-portrait', res: '2k' });
  assert.ok(!r.body.actions.some((a) => a.type === 'variations' || a.type === 'graph'));
  assert.match(r.body.reply, /night with heavy rain/);
  assert.ok(r.body.costUsd > 0);
  const reqs = await requests();
  assert.equal(reqs.length, 3);
  const b = reqs[0].body;
  assert.equal(b.model, 'claude-haiku-5-5');
  assert.deepEqual(b.thinking, { type: 'adaptive' });
  assert.equal(b.output_config.effort, 'low');
  assert.ok(b.max_tokens <= 16000);
  assert.deepEqual(b.system.at(-1).cache_control, { type: 'ephemeral' });
  assert.deepEqual(b.tools.at(-1).cache_control, { type: 'ephemeral' });
  assert.equal(b.fallbacks, undefined, 'Haiku has no server-side fallback');
  assert.ok(!b.tools.some((t) => /delete|drive|queue|run/i.test(t.name)));
  // send little: no preset list or graph in the first message, the form is fetched with a tool
  assert.ok(JSON.stringify(b.messages).length < 600, 'first request is small');
  // the same system prompt + tools bytes every request (cacheable)
  assert.equal(JSON.stringify(reqs[1].body.system), JSON.stringify(b.system));
  assert.equal(JSON.stringify(reqs[1].body.tools), JSON.stringify(b.tools));
  // memory: earlier turns go along as plain text
  await reset();
  await ask({ text: 'QUESTION what does guidance do?', memory: [{ role: 'user', text: 'make it rain' }, { role: 'assistant', text: 'Made it rain.' }] });
  const m = (await requests())[0].body.messages;
  assert.deepEqual(m.slice(0, 2), [{ role: 'user', content: 'make it rain' }, { role: 'assistant', content: 'Made it rain.' }]);
});

test('Opus: effort high for fix / files, server-side fallback on, workflow tools offered', async () => {
  await reset();
  const r = await ask({ mode: 'fix', model: 'haiku', text: 'The hands look melted', pictures: [{ media: 'image/jpeg', data: Buffer.from('fakejpeg').toString('base64'), image: { filename: 'a.png', subfolder: 'concept-app', type: 'output' }, meta: { prompt: 'a mech', seed: 48213, workflow: 'ai:klein-4b-t2i', width: 1152, height: 2048, steps: 4 } }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.model, 'opus', 'fixing a picture always uses Opus');
  const b = (await requests())[0].body;
  assert.equal(b.model, 'claude-opus-5-5');
  assert.equal(b.output_config.effort, 'high');
  assert.equal(b.fallbacks, 'default');
  assert.ok(b.tools.some((t) => t.name === 'propose_graph'));
  const content = b.messages.at(-1).content;
  assert.ok(content.some((c) => c.type === 'image'), 'the picture is attached');
  assert.match(JSON.stringify(content), /seed 48213/);
  assert.deepEqual(r.body.actions, [{ type: 'form', changes: { prompt: 'A weathered scout mech with clean five-fingered hands, scratched and rusty armor' } }], 'same seed: only the prompt changed');
});

test('preset settings are clamped to the preset\'s range', async () => {
  const r = await ask({ text: 'SETTINGS more steps' });
  const a = r.body.actions.find((x) => x.type === 'settings');
  assert.equal(a.preset, 'ai:klein-4b-t2i');
  const p = (await (await fetch(s.base + '/api/workflows')).json()).workflows.find((w) => w.id === 'ai:klein-4b-t2i');
  assert.equal(a.values.steps, p.ai.params.steps.max);
});

test('variations: N jobs for the batch, nothing queued on the PC', async () => {
  const before_ = (await call('GET', '/api/schedule')).body.jobs.length;
  const r = await ask({ mode: 'variations', text: 'Give me 6 takes: 3 lighting moods, each from a low and a high angle' });
  assert.equal(r.body.model, 'opus');
  const v = r.body.actions.find((x) => x.type === 'variations');
  assert.equal(v.jobs.length, 6);
  assert.equal(new Set(v.jobs.map((j) => j.changes.prompt)).size, 6, 'every job differs');
  assert.equal((await call('GET', '/api/schedule')).body.jobs.length, before_, 'the phone adds them (unstarted), not the server');
  assert.equal(s.mock.state?.queue?.length ?? 0, 0);
});

test('building a workflow: validated against ComfyUI; errors go back to Claude; 3 tries at most', async () => {
  const pic = (n) => ({ media: 'image/jpeg', data: 'AAAA', image: { filename: `p${n}.png`, subfolder: 'concept-app', type: 'output' } });
  await reset();
  const r = await ask({ mode: 'files', text: 'BADGRAPH the robot from 3, lighting from 1', pictures: [pic(1), pic(2), pic(3), pic(4)] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const reqs = await requests();
  const firstResult = reqs[2].body.messages.at(-1).content[0];
  assert.equal(firstResult.is_error, true);
  assert.match(firstResult.content, /ComfyUI has no "NoSuchNode" node/);
  const g = r.body.actions.find((x) => x.type === 'graph');
  assert.equal(g.name, 'Merge 4 looks');
  assert.ok(Object.values(g.graph).some((n) => n.class_type === 'LoadImage' && n.inputs.image === 'picture:1'));
  assert.equal(g.pictures.length, 4);
  // never valid -> it gives up and says so
  await reset();
  const n = await ask({ mode: 'files', text: 'NEVERGRAPH', pictures: [pic(1)] });
  assert.ok(!n.body.actions.some((x) => x.type === 'graph'));
  assert.match(n.body.reply, /could not build/);
  assert.equal((await requests()).length, 5, '3 tries + the "too many" answer + the final text');
});

test('refusal and runaway loops stop cleanly; a bad key says so', async () => {
  const r = await ask({ text: 'REFUSE' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.actions, []);
  assert.match(r.body.reply, /declined/);
  await reset();
  const l = await ask({ text: 'LOOP' });
  assert.equal(l.body.stopped, 'steps');
  assert.equal((await requests()).length, 8, 'Haiku: at most 8 steps');
  await call('POST', '/api/claude/key', { key: 'sk-ant-bad-0123456789abcdefghij' });
  const bad = await ask({ text: 'make it rain' });
  assert.equal(bad.status, 502);
  assert.match(bad.body.error, /API key was refused/);
  await call('POST', '/api/claude/key', { key: KEY });
});

test('monthly limit: once reached, requests are refused until next month', async () => {
  const st = (await call('GET', '/api/claude')).body;
  assert.ok(st.spentUsd > 0, 'real cost of the replies so far was added up');
  await call('POST', '/api/claude', { limitUsd: Math.floor(st.spentUsd * 100) / 100 });
  await reset();
  const r = await ask({ text: 'make it rain' });
  assert.equal(r.status, 429);
  assert.equal(r.body.code, 'limit');
  assert.match(r.body.error, /Monthly limit reached: about \$[\d.]+ of \$[\d.]+ used\. Claude is back on \d{4}-\d{2}-01/);
  assert.equal((await requests()).length, 0);
  await call('POST', '/api/claude', { limitUsd: 20 });
});

test('no key: asks for one', async () => {
  await call('DELETE', '/api/claude/key');
  const r = await ask({ text: 'make it rain' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'no-key');
  await call('POST', '/api/claude/key', { key: KEY });
});
