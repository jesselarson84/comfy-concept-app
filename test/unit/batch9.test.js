// Batch 9: History search, filters, stats, times, and the background tagger
// (gaming-safe: pauses for ComfyUI jobs and a busy GPU, needs a quiet spell).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStack, ROOT, pngBytes } from './helpers.js';
import { HistoryStore } from '../../server/history.js';
import { createTagger, normalizeTags, tagSource, taggable, TAG_GROUPS } from '../../server/tagger.js';
import { entryType, matches, dateRange, statsOf, isFiltering, timeLabel, entryTags } from '../../app/js/lib/history-filter.js';

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const img = (f) => ({ filename: f, subfolder: 'concept-app', type: 'output' });

test('tags from the model are cleaned: lower case, hyphenated, no repeats, capped per group; junk is refused', () => {
  const t = normalizeTags('```json\n{"genre":["Sci-Fi","sci fi","Product","x","y"],"mood":"Epic!","palette":["cool blues"],"colors":["blue","Orange","blue","teal","red","gold","pink"],"setting":[],"lighting":["neon lit"],"medium":["3D Render","photo"]}\n```');
  assert.deepEqual(t.genre, ['sci-fi', 'product', 'x']);
  assert.deepEqual(t.mood, ['epic']);
  assert.deepEqual(t.palette, ['cool-blues']);
  assert.deepEqual(t.colors, ['blue', 'orange', 'teal', 'red', 'gold']);
  assert.deepEqual(t.medium, ['3d-render']);
  assert.deepEqual(Object.keys(t), TAG_GROUPS);
  assert.equal(normalizeTags('not json'), null);
  assert.equal(normalizeTags({}), null);
});

test('what gets tagged: pictures, 3D and video (from a preview still), not audio, not cancelled or already tagged', () => {
  const pic = { id: 'a', status: 'done', images: [img('a.png')] };
  assert.deepEqual(tagSource(pic, false), { kind: 'image', image: img('a.png') });
  assert.equal(tagSource({ ...pic, tags: {} }, false), null);
  assert.equal(tagSource({ ...pic, tagFails: 3 }, false), null);
  const glb = { id: 'b', status: 'done', images: [], files: [{ ...img('m.glb'), kind: '3d' }] };
  assert.equal(tagSource(glb, false), null, 'waits for the app to send the still');
  assert.deepEqual(tagSource(glb, true), { kind: 'preview' });
  assert.deepEqual(tagSource({ id: 'c', status: 'done', images: [], files: [img('clip.mp4')] }, true), { kind: 'preview' });
  const wav = { id: 'd', status: 'done', images: [], files: [img('line.flac')] };
  assert.equal(tagSource(wav, true), null);
  assert.equal(taggable(wav), false);
  assert.equal(tagSource({ id: 'e', status: 'cancelled', images: [], files: [] }, false), null);
});

/** A tagger over a temp History with fake ComfyUI / Ollama / GPU. */
function rig({ util = 3, queue = [], answer } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-tag-'));
  const history = new HistoryStore(dir);
  const calls = [];
  let t = 0;
  const env = { util, queue, answer: answer || JSON.stringify({ genre: ['sci-fi'], mood: ['epic'], palette: ['neon'], colors: ['blue', 'pink'], setting: ['city-street'], lighting: ['neon-lit'], medium: ['3d-render'] }) };
  const fetchImpl = async (url, o = {}) => {
    const u = String(url); calls.push({ url: u, body: o.body ? JSON.parse(o.body) : null });
    if (u.endsWith('/queue')) return new Response(JSON.stringify({ queue_running: env.queue, queue_pending: [] }));
    if (u.includes('/view?')) return new Response(pngBytes());
    if (u.endsWith('/api/generate')) return new Response(JSON.stringify({ response: env.answer, done: true }));
    return new Response('{}', { status: 404 });
  };
  const tagger = createTagger({ history, dataDir: dir, getComfyUrl: () => 'http://comfy', getOllamaUrl: () => 'http://ollama', gpuUtil: async () => env.util, fetchImpl, now: () => t, quietMs: 180000 });
  return { dir, history, tagger, calls, env, advance: (ms) => { t += ms; } };
}

test('tagger: waits for 3 quiet minutes, then tags ONE item per check with the vision model (short keep_alive)', async () => {
  const r = rig();
  await r.history.add({ workflow: 'ai:z-image-turbo', prompt: 'a', images: [img('a.png')] });
  await r.history.add({ workflow: 'ai:z-image-turbo', prompt: 'b', images: [img('b.png')] });
  assert.equal((await r.tagger.tick()).status, 'waiting');
  r.advance(170000);
  assert.equal((await r.tagger.tick()).status, 'waiting', 'not yet 3 minutes');
  r.advance(15000);
  let s = await r.tagger.tick();
  assert.equal(s.tagged, 1, 'one item per check');
  const gen = r.calls.find((c) => c.url.endsWith('/api/generate'));
  assert.equal(gen.body.model, 'gemma3:4b');
  assert.equal(gen.body.images.length, 1);
  assert.equal(gen.body.keep_alive, '20s', 'VRAM goes back within seconds');
  assert.ok(gen.body.format?.properties?.palette, 'JSON schema answer');
  s = await r.tagger.tick();
  assert.deepEqual([s.tagged, s.total, s.status], [2, 2, 'done']);
  const e = r.history.data.entries[1];
  assert.deepEqual(e.tags.colors, ['blue', 'pink']);
  assert.equal(e.tags.model, 'gemma3:4b');
});

test('tagger never competes with a game or ComfyUI: a busy GPU pauses it, unloads the model and restarts the quiet clock', async () => {
  const r = rig();
  await r.history.add({ workflow: 'x', prompt: 'a', images: [img('a.png')] });
  await r.history.add({ workflow: 'x', prompt: 'b', images: [img('b.png')] });
  await r.tagger.tick(); r.advance(200000);
  assert.equal((await r.tagger.tick()).tagged, 1);
  // a game starts: 85 % GPU
  r.env.util = 85;
  let s = await r.tagger.tick();
  assert.deepEqual([s.status, s.reason], ['paused', 'another program is using the GPU']);
  assert.ok(r.calls.some((c) => c.url.endsWith('/api/generate') && c.body.keep_alive === 0), 'model unloaded at once');
  // the game ends: the 3-minute quiet clock starts again from zero
  r.env.util = 4; r.advance(10000);
  assert.equal((await r.tagger.tick()).status, 'waiting');
  r.advance(100000);
  assert.equal((await r.tagger.tick()).status, 'waiting');
  // ComfyUI starts a job: paused too
  r.env.queue = [[1, 'p']];
  s = await r.tagger.tick();
  assert.deepEqual([s.status, s.reason], ['paused', 'ComfyUI is working']);
  r.env.queue = []; r.advance(1000); await r.tagger.tick(); r.advance(181000);
  assert.equal((await r.tagger.tick()).tagged, 2);
  // the desktop alone (~10 %) is quiet; above 30 % is busy
  r.env.util = 25; assert.notEqual((await r.tagger.tick()).reason, 'another program is using the GPU');
});

test('tagger: off switch (saved), skips after repeated failures, 3D / video read the uploaded still', async () => {
  const r = rig({ answer: 'nonsense' });
  const e = await r.history.add({ workflow: 'x', prompt: 'a', images: [img('a.png')] });
  assert.equal((await r.tagger.setEnabled(false)).status, 'off');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(r.dir, 'tagger.json'), 'utf8')), { enabled: false });
  r.advance(999999);
  assert.equal((await r.tagger.tick()).status, 'off');
  await r.tagger.setEnabled(true);
  await r.tagger.tick(); r.advance(200000);
  for (let i = 0; i < 3; i++) await r.tagger.tick();
  assert.equal(r.history.get(e.id).tagFails, 3);
  assert.equal((await r.tagger.tick()).status, 'done', 'given up on it');
  // 3D: nothing until the app sends a still
  r.env.answer = JSON.stringify({ genre: ['props'], mood: [], palette: [], colors: ['grey'], setting: [], lighting: [], medium: ['3d-render'] });
  const m = await r.history.add({ workflow: 'ai:hunyuan3d-21', prompt: '', images: [], files: [{ ...img('m.glb'), kind: '3d' }], status: 'done' });
  assert.equal((await r.tagger.tick()).status, 'done');
  await r.tagger.savePreview(m.id, pngBytes());
  assert.equal(r.tagger.hasPreview(m.id), true);
  await r.tagger.tick();
  assert.deepEqual(r.history.get(m.id).tags.genre, ['props']);
  await assert.rejects(r.tagger.savePreview('../x', pngBytes()), /No such entry/);
  await r.tagger.dropPreviews([m.id]);
  assert.equal(r.tagger.hasPreview(m.id), false);
});

test('API: /api/tagger status + switch, still upload, History says which entries have a still; tags show in History', async () => {
  const s = await startStack({ appOptions: { gpuUtil: async () => 2, tagger: { quietMs: 0 } } });
  try {
    s.mock.files.set('output/concept-app/p_00001_.png', pngBytes());
    const add = (b) => fetch(s.base + '/api/history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
    const pic = await add({ workflow: 'ai:z-image-turbo', prompt: 'neon city', images: [img('p_00001_.png')], status: 'done' });
    const glb = await add({ workflow: 'ai:hunyuan3d-21', prompt: '', images: [], files: [{ ...img('m_00001_.glb'), kind: '3d' }], status: 'done' });
    let st = await (await fetch(s.base + '/api/tagger')).json();
    assert.deepEqual([st.enabled, st.tagged, st.total, st.model], [true, 0, 2, 'gemma3:4b']);
    assert.equal((await fetch(`${s.base}/api/history/${glb.id}/preview`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: pngBytes() })).status, 200);
    assert.equal((await fetch(`${s.base}/api/history/nope/preview`, { method: 'POST', body: pngBytes() })).status, 404);
    await s.app.tagger.tick(); await s.app.tagger.tick();
    const sessions = (await (await fetch(s.base + '/api/history')).json()).sessions;
    const entries = sessions.flatMap((x) => x.entries);
    const p = entries.find((e) => e.id === pic.id), g = entries.find((e) => e.id === glb.id);
    assert.equal(g.preview, true);
    assert.deepEqual(p.tags.medium, ['3d-render'], 'mock vision answer, cleaned');
    assert.deepEqual(p.tags.colors, ['blue', 'orange']);
    assert.ok(g.tags, 'the 3D model was tagged from its still');
    st = await (await fetch(s.base + '/api/tagger', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) })).json();
    assert.equal(st.status, 'off');
  } finally { await s.close(); }
});

test('History filters: type, model, date range, tags and every search word (prompt, model name, tags, colours)', () => {
  const now = new Date(2026, 10, 23, 15, 0);
  const at = (d, h = 12) => new Date(2026, 10, d, h).getTime();
  const E = [
    { id: '1', createdAt: at(23), workflow: 'ai:klein-4b-t2i', prompt: 'a night market', images: [img('a.png')], tags: { genre: ['sci-fi'], colors: ['blue'], palette: ['neon'], lighting: ['neon-lit'] } },
    { id: '2', createdAt: at(22), workflow: 'ai:z-image-turbo', prompt: 'a red barn', images: [img('b.png')], tags: { colors: ['red'] } },
    { id: '3', createdAt: at(20), workflow: 'ai:hunyuan3d-21', prompt: '', images: [], files: [{ ...img('m.glb'), kind: '3d' }] },
    { id: '4', createdAt: at(2), workflow: 'ai:tts-chatterbox', prompt: 'hello there', images: [], files: [img('x.flac')] },
  ];
  const labelOf = (id) => ({ 'ai:klein-4b-t2i': 'FLUX.2 Klein 4B', 'ai:z-image-turbo': 'Z-Image Turbo' })[id] || id;
  const ids = (f) => E.filter((e) => matches(e, f, { labelOf, now })).map((e) => e.id);
  assert.deepEqual(E.map(entryType), ['image', 'image', '3d', 'audio']);
  assert.deepEqual(ids({ q: 'neon blue' }), ['1'], 'tags + colours');
  assert.deepEqual(ids({ q: 'klein' }), ['1'], 'model name');
  assert.deepEqual(ids({ q: 'red' }), ['2']);
  assert.deepEqual(ids({ types: new Set(['3d', 'audio']) }), ['3', '4']);
  assert.deepEqual(ids({ models: new Set(['ai:z-image-turbo']) }), ['2']);
  assert.deepEqual(ids({ date: { key: 'today' } }), ['1']);
  assert.deepEqual(ids({ date: { key: 'yesterday' } }), ['2']);
  assert.deepEqual(ids({ date: { key: 'week' } }), ['1', '2', '3']);
  assert.deepEqual(ids({ date: { key: 'month' } }), ['1', '2', '3', '4']);
  assert.deepEqual(ids({ date: { from: '2026-11-20', to: '2026-11-22' } }), ['2', '3']);
  assert.deepEqual(ids({ tags: new Set(['neon-lit']) }), ['1']);
  assert.equal(dateRange(null), null);
  assert.equal(isFiltering({ q: ' ', types: new Set() }), false);
  assert.equal(isFiltering({ tags: new Set(['x']) }), true);
  const st = statsOf(E, { now, labelOf });
  assert.deepEqual([st.total, st.today, st.month, st.byType.image, st.byType['3d']], [4, 1, 4, 2, 1]);
  assert.equal(st.models[0].n, 1);
  assert.ok(st.tags.find((t) => t.tag === 'blue'));
  assert.deepEqual(entryTags(E[0]), ['sci-fi', 'neon', 'blue', 'neon-lit']);
  assert.match(timeLabel(at(23, 15)), /^3:00\sPM$/);
});

test('History UI wiring: search + chips + stats strip + tagging switch; viewer tags; module cached', () => {
  const hv = read('app/js/ui/history-view.js'), viewer = read('app/js/ui/viewer.js'), main = read('app/js/main.js');
  assert.match(hv, /placeholder: 'Search prompts, tags, colours'/);
  assert.doesNotMatch(hv, /thumb-time/, 'batch 10: no times on the tiles (the date is in the viewer)');
  assert.match(hv, /localStorage\.setItem\('historyStatsOpen'/);
  assert.match(hv, /setTagger\(e\.target\.checked\)/);
  assert.match(hv, /uploadPreview\(e\.id, blob\)/);
  assert.match(hv, /this\.modelThumbs\.onStill = /, '3D stills only as tiles render them (lazy)');
  assert.match(read('app/js/ui/model-thumbs.js'), /this\.onStill\?\.\(t\.file, blob\)/);
  assert.match(viewer, /this\.hooks\.onTag\?\.\(t\)/);
  assert.match(main, /onTag: \(tag\) =>/);
  assert.match(main, /labelOf: \(id\) =>/);
  assert.match(read('app/sw.js'), /'\/js\/lib\/history-filter\.js'/);
  assert.match(read('server/index.js'), /tagger\.start\(\); \/\/ only in the real server/);
});
