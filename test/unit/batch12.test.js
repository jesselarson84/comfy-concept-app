// Batch 12: full-screen viewer tap, No project by default, stats colours,
// Details layout, desktop ComfyUI jobs in the app (pc-sync), batches (scheduler).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, pngBytes, startStack } from './helpers.js';
import { HistoryStore } from '../../server/history.js';
import { createPcSync, describeGraph, modelKey } from '../../server/pc-sync.js';
import { createScheduler } from '../../server/scheduler.js';
import { deleteAppFile } from '../../server/outputs.js';
import { statsOf, modelColor, TYPE_COLORS, GROUP_COLORS } from '../../app/js/lib/history-filter.js';
import { nextClockTime } from '../../app/js/ui/batch-sheet.js';

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const out = (f, sub = '') => ({ filename: f, subfolder: sub, type: 'output' });

/** A desktop-style API graph: checkpoint, two prompts, sampler, latent, save. */
const GRAPH = {
  4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'z_image_turbo_bf16.safetensors' } },
  6: { class_type: 'CLIPTextEncode', inputs: { text: 'a red rocket on a launch pad', clip: ['4', 1] } },
  7: { class_type: 'CLIPTextEncode', inputs: { text: 'blurry', clip: ['4', 1] } },
  5: { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 768, batch_size: 1 } },
  3: { class_type: 'KSampler', inputs: { seed: 1234, steps: 8, cfg: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
  9: { class_type: 'SaveImage', inputs: { filename_prefix: 'ComfyUI', images: ['8', 0] } },
};

test('viewer: hidden controls take no space, so the picture area is the whole screen', () => {
  assert.match(read('app/styles.css'), /\.viewer\.chrome-hidden \.viewer-top, \.viewer\.chrome-hidden \.viewer-bottom \{ display: none; \}/);
  const v = read('app/js/ui/viewer.js');
  assert.match(v, /tapTimer = setTimeout\(\(\) => this\.#toggleChrome\(\), 260\)/);
  assert.match(v, /this\.z\.x \*= k; this\.z\.y \*= k; this\.#clampPan\(\)/, 'zoom keeps its spot and is clamped to the new size');
});

test('No project by default: picked per device for this load only, never shared, never changed by moving', () => {
  const p = read('app/js/ui/projects.js');
  assert.match(p, /let current = null;/);
  assert.doesNotMatch(read('app/js/api.js'), /setCurrentProject/);
  assert.match(read('app/js/main.js'), /project: getCurrentProject\(\) \|\| undefined/);
  assert.doesNotMatch(read('server/index.js'), /setCurrent|\/api\/projects\/current/);
  // Move to… (ProjectSheet with move: true) only resolves an id; only the chip sets `current`
  assert.equal((p.match(/current = id \|\| null/g) || []).length, 1);
});

test('stats colours: tag kinds, model colour slots by first use (not rank), real colours for colour tags', () => {
  const e = (id, wf, at, tags) => ({ id, workflow: wf, createdAt: at, images: [out(id + '.png')], tags });
  const s = statsOf([
    e('a', 'ai:new', 300, { colors: ['black', 'light-blue'], mood: ['serious'] }),
    e('b', 'ai:new', 400, { genre: ['product'] }),
    e('c', 'ai:new', 500, {}),
    e('d', 'ai:old', 100, { colors: ['black'] }),
  ]);
  assert.equal(s.models[0].id, 'ai:new'); assert.equal(s.models[0].slot, 1, 'used second -> slot 1 even though it ranks first');
  assert.equal(s.models[1].slot, 0);
  // batch 13: old plain color tags are ignored (no Colors section, not searched)
  assert.deepEqual(Object.fromEntries(s.tags.map((t) => [t.tag, t.group])), { serious: 'mood', product: 'genre' });
  assert.notEqual(modelColor(0), modelColor(1));
  assert.ok(TYPE_COLORS.image && TYPE_COLORS['3d'] && GROUP_COLORS.mood);
  const hv = read('app/js/ui/history-view.js');
  assert.match(hv, /'By type'/); assert.doesNotMatch(hv, /'Colou?rs'/); assert.match(hv, /typeBar\('\.mini'\)/);
});

test('Details (option A): prompt card with Copy + Reuse, fact tiles, Saved to card, tags with kind dots, no Colours section', () => {
  const v = read('app/js/ui/viewer.js');
  assert.match(v, /div\.vd-facts/); assert.match(v, /'Saved to'/); assert.match(v, /'Reuse settings'/); assert.match(v, /'Copy prompt'/);
  const details = v.slice(v.indexOf('  #fillDetails() {'), v.indexOf('  #paintStrip('));
  assert.doesNotMatch(details, /'Colours'/);
});

test('pc-sync: reads prompt / negative / model / seed / size from a desktop graph', () => {
  const d = describeGraph(GRAPH);
  assert.deepEqual(d, { prompt: 'a red rocket on a launch pad', negative: 'blurry', model: 'z_image_turbo_bf16.safetensors', seed: 1234, width: 1024, height: 768, steps: 8 });
  assert.equal(modelKey(d.model), 'z_image_turbo_bf16');
  // Z-Image style: the negative is the positive zeroed out -> no negative
  const z = { ...GRAPH, 7: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['6', 0] } } };
  assert.equal(describeGraph(z).negative, '');
  assert.equal(describeGraph({ 1: { class_type: 'X', inputs: { text: 'short' } }, 2: { class_type: 'Y', inputs: { prompt: 'the longer one' } } }).prompt, 'the longer one');
});

/** ComfyUI /history + /queue over fake fetch. */
function comfyFake() {
  const env = { history: {}, running: [], pending: [] };
  const fetchImpl = async (url, o = {}) => {
    const u = new URL(String(url));
    if (u.pathname === '/history') return new Response(JSON.stringify(env.history));
    if (u.pathname.startsWith('/history/')) { const id = decodeURIComponent(u.pathname.slice(9)); return new Response(JSON.stringify(env.history[id] ? { [id]: env.history[id] } : {})); }
    if (u.pathname === '/queue') return new Response(JSON.stringify({ queue_running: [...env.running, ...(env.mine || []).filter((x) => !env.history[x[1]])], queue_pending: env.pending }));
    if (u.pathname === '/concept/progress') return env.progress ? new Response(JSON.stringify(env.progress)) : new Response('{"error":"no"}', { status: 404 });
    if (u.pathname === '/prompt' && o.method === 'POST') { const id = 'sched-' + Object.keys(env.history).length + '-' + Math.random().toString(36).slice(2, 6); env.lastPrompt = JSON.parse(o.body); env.queued = id; env.mine = [[9, id, env.lastPrompt.prompt, {}, []]]; return new Response(JSON.stringify({ prompt_id: id })); }
    return new Response('{}', { status: 404 });
  };
  const done = (id, at, outputs, extra = {}) => { env.history[id] = { prompt: [1, id, GRAPH, { client_id: 'desk', extra_pnginfo: { workflow: { nodes: [] } } }, ['9']], outputs, status: { status_str: 'success', completed: true, messages: [['execution_start', { timestamp: at }], ['execution_success', { timestamp: at + 1000 }]] }, ...extra }; };
  return { env, fetchImpl, done };
}

test('pc-sync: earlier and new desktop jobs land in History (Unsorted, desktop session) with their workflow kept; app jobs, deleted, preview-only and too-fresh ones do not', async () => {
  const dataDir = tmp('cc-pc-'); const outDir = tmp('cc-out-');
  for (const f of ['old.png', 'new.png']) fs.writeFileSync(path.join(outDir, f), pngBytes());
  const history = new HistoryStore(dataDir);
  const app = await history.add({ prompt: 'mine', promptId: 'app1', images: [out('mine.png', 'concept-app')] });
  const c = comfyFake();
  let t = 1_000_000;
  c.done('old1', 10_000, { 9: { images: [out('old.png')] } });          // earlier desktop run
  c.done('gone1', 20_000, { 9: { images: [out('deleted.png')] } });     // its file was deleted since
  c.done('prev1', 30_000, { 9: { images: [{ filename: 'p.png', subfolder: '', type: 'temp' }] } }); // preview only
  c.done('app1', 40_000, { 9: { images: [out('mine.png', 'concept-app')] } });   // the app's own
  c.done('fresh1', t - 5000, { 9: { images: [out('new.png')] } });       // finished 4 s ago
  const sync = createPcSync({ history, dataDir, getComfyUrl: () => 'http://comfy', outputDirOf: async () => outDir, fetchImpl: c.fetchImpl, now: () => t });
  let r = await sync.tick();
  assert.equal(r.added, 1);
  const old = history.data.entries.find((e) => e.promptId === 'old1');
  assert.equal(old.workflow, 'desktop:z_image_turbo_bf16'); assert.equal(old.prompt, 'a red rocket on a launch pad'); assert.equal(old.negative, 'blurry');
  assert.equal(old.seed, 1234); assert.equal(old.width, 1024); assert.equal(old.project, null); assert.equal(old.origin, 'desktop');
  assert.equal(old.sessionId, 's_desktop'); assert.equal(old.createdAt, 10_000);
  assert.equal(history.get(app.id).sessionId !== 's_desktop', true);
  assert.equal(history.data.entries.filter((e) => e.promptId === 'app1').length, 1, 'the app job is not recorded twice');
  assert.ok(!history.data.entries.some((e) => ['gone1', 'prev1', 'fresh1'].includes(e.promptId)));
  assert.deepEqual(sync.loadGraph('old1').graph, GRAPH, 'workflow kept for "keep editing on the phone"');
  t += 30000;
  r = await sync.tick();
  assert.equal(r.added, 1, 'fresh1 after the grace time');
  r = await sync.tick();
  assert.equal(r.added, 0, 'never twice');
  // a deleted entry never comes back
  sync.forget(['old1']); await history.remove([old.id]);
  assert.equal((await sync.tick()).added, 0);
});

test('pc-sync: what the PC runs now (not the app\'s own job) and a job\'s workflow for Open here', async () => {
  const dataDir = tmp('cc-pc-');
  const history = new HistoryStore(dataDir);
  await history.add({ prompt: 'mine', promptId: 'appjob' });
  const c = comfyFake();
  const sync = createPcSync({ history, dataDir, getComfyUrl: () => 'http://comfy', fetchImpl: c.fetchImpl, now: () => 5000 });
  assert.equal((await sync.now()).running, null);
  c.env.running = [[1, 'desk1', GRAPH, { client_id: 'desk', extra_pnginfo: { workflow: { nodes: [1] } } }, ['9']]];
  c.env.pending = [[2, 'x', GRAPH, {}, []]];
  const n = await sync.now();
  assert.deepEqual({ id: n.running.promptId, app: n.running.app, label: n.running.label, pending: n.pending }, { id: 'desk1', app: false, label: 'z_image_turbo_bf16', pending: 1 });
  const j = await sync.job('desk1');
  assert.deepEqual(j.graph, GRAPH); assert.deepEqual(j.workflow, { nodes: [1] }); assert.equal(j.meta.seed, 1234);
  assert.equal(n.running.progress, null, 'no add-on (or ComfyUI not restarted): time only');
  // the app's ComfyUI add-on reports the job's live progress
  c.env.progress = { prompt_id: 'desk1', node: '3', value: 12, max: 30, nodes_done: 2, cached: 1 };
  let p = (await sync.now()).running.progress;
  assert.equal(p.fraction, 0.4); assert.equal(p.value, 12); assert.equal(p.nodesTotal, 5);
  c.env.progress = { prompt_id: 'desk1', node: '9', value: 0, max: 0, nodes_done: 4, cached: 1 };
  p = (await sync.now()).running.progress;
  assert.equal(p.fraction, 0.8, 'no step progress: nodes done of nodes to run');
  c.env.progress = { prompt_id: 'other', value: 1, max: 2 };
  assert.equal((await sync.now()).running.progress, null, 'progress of another job is ignored');
  c.env.running = [[1, 'appjob', GRAPH, {}, []]];
  assert.equal((await sync.now()).running.app, true, 'the app shows its own job already');
  assert.equal(await sync.job('nope'), null);
});

test('pc-sync: a batch job running on the PC shows on the card (not hidden as an app job)', async () => {
  const dataDir = tmp('cc-pc-');
  const history = new HistoryStore(dataDir);
  await history.add({ prompt: 'batch', promptId: 'b1' });
  const c = comfyFake();
  c.env.running = [[1, 'b1', GRAPH, {}, []]];
  const sync = createPcSync({ history, dataDir, getComfyUrl: () => 'http://comfy', fetchImpl: c.fetchImpl, isScheduled: (id) => id === 'b1' });
  const r = (await sync.now()).running;
  assert.equal(r.app, false); assert.equal(r.scheduled, true);
});

test('ComfyUI add-on: keeps the progress of the running job at /concept/progress, ComfyUI messages unchanged', () => {
  const py = read('comfyui/ComfyUI-AIWorkflowMenu/__init__.py');
  assert.match(py, /@inst\.routes\.get\("\/concept\/progress"\)/);
  assert.match(py, /return original\(event, data, sid\)/, 'every message still goes where ComfyUI sends it');
  assert.match(py, /_concept_progress/, 'installed once');
  assert.match(read('app/js/ui/pc-card.js'), /step \$\{p\.value\} of \$\{p\.max\}/);
});

test('delete: a desktop job\'s files may be deleted anywhere in ComfyUI\'s output folder; app jobs still only in the app folder', async () => {
  const outDir = tmp('cc-out-');
  fs.mkdirSync(path.join(outDir, 'concept-app'));
  fs.writeFileSync(path.join(outDir, 'desk.png'), 'x');
  assert.equal((await deleteAppFile(out('desk.png'), { outputDir: outDir })).ok, false);
  assert.equal((await deleteAppFile(out('desk.png'), { outputDir: outDir, anywhere: true })).ok, true);
  assert.ok(!fs.existsSync(path.join(outDir, 'desk.png')));
  assert.equal((await deleteAppFile(out('x.png', '..'), { outputDir: outDir, anywhere: true })).ok, false, 'never outside the output folder');
});

function schedRig({ util = 5 } = {}) {
  const dataDir = tmp('cc-sch-');
  const history = new HistoryStore(dataDir);
  const c = comfyFake();
  let t = 1000;
  const env = { util };
  const s = createScheduler({ dataDir, history, getComfyUrl: () => 'http://comfy', gpuUtil: async () => env.util, fetchImpl: c.fetchImpl, now: () => t });
  const job = (label, extra = {}) => ({ graph: GRAPH, meta: { workflow: 'ai:z', prompt: label, seed: 1234, project: 'p_1' }, seeds: [{ node: '3', input: 'seed' }], randomSeed: false, label, ...extra });
  return { s, c, history, env, job, advance: (ms) => { t += ms; }, at: () => t };
}

test('scheduler: a saved batch starts at its time, runs one job after another, records History and keeps the project', async () => {
  const r = schedRig();
  r.s.add([r.job('one'), r.job('two')]);
  assert.equal(r.s.view().state, 'idle', 'nothing runs before Start');
  await r.s.tick(); assert.equal(r.c.env.queued, undefined);
  r.s.start(r.at() + 60000);
  assert.equal(r.s.view().state, 'scheduled');
  await r.s.tick(); assert.equal(r.c.env.queued, undefined, 'not before the clock time');
  r.advance(60000);
  await r.s.tick();
  const first = r.c.env.queued;
  assert.ok(first); assert.equal(r.c.env.lastPrompt.client_id, 'concept-scheduler');
  let v = r.s.view();
  assert.equal(v.state, 'running'); assert.equal(v.jobs[0].status, 'running');
  const e1 = r.history.data.entries.find((e) => e.promptId === first);
  assert.equal(e1.project, 'p_1'); assert.equal(e1.origin, 'schedule'); assert.equal(e1.prompt, 'one');
  await r.s.tick(); assert.equal(r.c.env.queued, first, 'the next waits for the first to finish');
  r.c.done(first, 5000, { 9: { images: [out('one.png', 'concept-app')] } });
  await r.s.tick();
  assert.equal(r.history.get(e1.id).status, 'done'); assert.equal(r.history.get(e1.id).images[0].filename, 'one.png');
  assert.notEqual(r.c.env.queued, first, 'second job started after the first finished');
  r.c.done(r.c.env.queued, 6000, { 9: { images: [out('two.png', 'concept-app')] } });
  await r.s.tick();
  v = r.s.view();
  assert.deepEqual(v.jobs.map((j) => j.status), ['done', 'done']); assert.equal(v.start, null, 'batch finished');
  assert.equal(v.jobs[0].graph, undefined, 'graphs are not sent to the app');
});

test('scheduler: waits while the PC is busy (game / other ComfyUI jobs), skips a failed job, random seeds are new, locked seeds kept', async () => {
  const r = schedRig({ util: 90 });
  r.s.add([r.job('bad', { randomSeed: true }), r.job('good')]);
  r.s.start(null);
  await r.s.tick();
  assert.equal(r.c.env.queued, undefined); assert.match(r.s.view().waitReason, /using the GPU/);
  r.env.util = 5; r.c.env.running = [[1, 'desk', GRAPH, {}, []]];
  await r.s.tick(); assert.equal(r.c.env.queued, undefined); assert.match(r.s.view().waitReason, /ComfyUI is busy/);
  r.c.env.running = [];
  await r.s.tick();
  const bad = r.c.env.queued;
  assert.notEqual(r.c.env.lastPrompt.prompt['3'].inputs.seed, 1234, 'random seed picked when it runs');
  r.c.env.history[bad] = { prompt: [], outputs: {}, status: { status_str: 'error', completed: false, messages: [['execution_error', { node_type: 'KSampler', exception_message: 'out of memory' }]] } };
  await r.s.tick();
  let v = r.s.view();
  assert.equal(v.jobs[0].status, 'failed'); assert.match(v.jobs[0].error, /out of memory/);
  assert.equal(v.jobs[1].status, 'running', 'the rest carries on');
  assert.equal(r.c.env.lastPrompt.prompt['3'].inputs.seed, 1234, 'locked seed kept');
  // remove / order / stop
  r.s.add([r.job('x'), r.job('y')]);
  v = r.s.view();
  const [x, y] = v.jobs.filter((j) => j.status === 'waiting');
  v = r.s.order([y.id, x.id]);
  assert.deepEqual(v.jobs.filter((j) => j.status === 'waiting').map((j) => j.label), ['y', 'x']);
  v = r.s.remove(x.id);
  assert.equal(v.jobs.some((j) => j.id === x.id), false);
  assert.throws(() => r.s.remove(v.jobs.find((j) => j.status === 'running').id), /running/);
  assert.equal(r.s.stop().start, null);
});

test('server: schedule routes and PC routes answer; the batch clock time picks the next 23:30', async () => {
  const s = await startStack({});
  const j = async (method, url, body) => { const r = await fetch(s.base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
  try {
    assert.deepEqual((await j('GET', '/api/schedule')).body.jobs, []);
    assert.equal((await j('POST', '/api/schedule/start', { at: null })).status, 400, 'empty batch');
    const r = await j('POST', '/api/schedule/jobs', { jobs: [{ graph: GRAPH, meta: { prompt: 'a' }, label: 'Z' }] });
    assert.equal(r.status, 201); assert.equal(r.body.jobs.length, 1);
    assert.equal((await j('POST', '/api/schedule/jobs', { jobs: [{ graph: 'nope' }] })).status, 400);
    assert.equal((await j('GET', '/api/pc/now')).status, 200);
    assert.equal((await j('GET', '/api/pc/job/unknown')).status, 404);
  } finally { await s.close(); }
  const now = new Date(2026, 10, 24, 22, 0);
  assert.equal(new Date(nextClockTime('23:30', now)).getHours(), 23);
  assert.equal(new Date(nextClockTime('21:00', now)).getDate(), 25, 'earlier today -> tomorrow');
});

test('UI wiring: PC card above the project chip, Save to batch + batch button next to Run, new files cached', () => {
  const html = read('app/index.html');
  assert.ok(html.indexOf('id="pc-card"') < html.indexOf('id="project-row"'));
  assert.match(html, /id="btn-batch-add"/); assert.match(html, /id="btn-batch"/);
  const main = read('app/js/main.js');
  assert.match(main, /new PcCard\(\$\('#pc-card'\)/); assert.match(main, /queue\.follow\(promptId/); assert.match(main, /randomSeed: r\.seedMode !== 'locked'/);
  const sw = read('app/sw.js');
  for (const f of ['pc-card.js', 'batch-sheet.js']) assert.match(sw, new RegExp(`'/js/ui/${f.replace('.', '\\.')}'`));
});
