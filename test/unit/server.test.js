// Server: workflows API + import + watch, history API, share endpoint,
// proxy HTTP (incl. Origin rewrite) and websocket passthrough, full job flow.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startStack, pngBytes, ROOT } from './helpers.js';

let s;
before(async () => { s = await startStack(); });
after(async () => { await s.close(); });

const j = (r) => r.json();

test('GET /api/config reports reachable mock', async () => {
  const c = await j(await fetch(s.base + '/api/config'));
  assert.equal(c.comfyReachable, true);
  assert.equal(c.outputSubfolder, 'concept-app');
});

test('GET /api/workflows: AI presets first, folder workflows under My presets with controls', async () => {
  const { workflows } = await j(await fetch(s.base + '/api/workflows'));
  assert.deepEqual(workflows.filter((w) => !w.ai).map((w) => [w.id, w.label, w.ok, w.controls.kind, w.group, w.folder]), [
    ['basic-reference', 'Basic reference', true, 'img2img', 'My presets', true],
    ['basic-txt2img', 'Basic txt2img', true, 'txt2img', 'My presets', true],
  ]);
  assert.ok(workflows[0].ai, 'AI Workflow presets come first');
  assert.ok(workflows.find((w) => w.id === 'basic-txt2img').workflow['40']);
  assert.ok(!workflows.some((w) => w.id === 'fast-concept' || w.id === 'from-reference-image'), 'retired presets are not listed');
});

test('POST /api/workflows imports API JSON (multipart), never overwrites, rejects UI format', async () => {
  const wf = fs.readFileSync(path.join(ROOT, 'test/fixtures/sd15-negative.json'));
  const send = async (name, buf) => { const fd = new FormData(); fd.append('file', new Blob([buf]), name); return fetch(s.base + '/api/workflows', { method: 'POST', body: fd }); };
  const r1 = await send('My SD graph.json', wf);
  assert.equal(r1.status, 201);
  assert.deepEqual(await r1.json(), { id: 'My SD graph', file: 'My SD graph.json' });
  const r2 = await j(await send('My SD graph.json', wf));
  assert.equal(r2.file, 'My SD graph-2.json');
  const bad = await send('ui.json', fs.readFileSync(path.join(ROOT, 'test/fixtures/ui-format.json')));
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /UI-format/);
  const junk = await send('../../evil.json', Buffer.from('nope'));
  assert.equal(junk.status, 400);
  const { workflows } = await j(await fetch(s.base + '/api/workflows'));
  assert.ok(workflows.some((w) => w.id === 'My SD graph' && w.controls.negative.length === 1));
  assert.ok(!fs.existsSync(path.join(s.wfDir, '..', 'evil.json')));
});

test('dropping a file into workflows/ -> SSE "workflows" event and it lists (also invalid files list with error)', async () => {
  const ctrl = new AbortController();
  const res = await fetch(s.base + '/api/events', { signal: ctrl.signal });
  const reader = res.body.getReader();
  await reader.read(); // "retry:" preamble
  fs.writeFileSync(path.join(s.wfDir, 'dropped.json'), fs.readFileSync(path.join(ROOT, 'test/fixtures/nothing-detectable.json')));
  fs.writeFileSync(path.join(s.wfDir, 'broken.json'), '{oops');
  let got = '';
  const deadline = Date.now() + 3000;
  while (!got.includes('event: workflows') && Date.now() < deadline) got += new TextDecoder().decode((await reader.read()).value);
  ctrl.abort();
  assert.match(got, /event: workflows/);
  const { workflows } = await j(await fetch(s.base + '/api/workflows'));
  const d = workflows.find((w) => w.id === 'dropped');
  assert.equal(d.controls.kind, 'unknown');
  assert.match(d.controls.message, /No controls detected/);
  const b = workflows.find((w) => w.id === 'broken');
  assert.equal(b.ok, false);
  assert.match(b.error, /Invalid JSON/);
});

test('history API: POST, PATCH favorite, GET grouped; persisted to data/history.json', async () => {
  const e = await j(await fetch(s.base + '/api/history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'fox', seed: 3, workflow: 'basic-txt2img', width: 1024, height: 1024, images: [{ filename: 'x.png', subfolder: 'concept-app', type: 'output' }] }) }));
  assert.ok(e.id && e.sessionId);
  const p = await j(await fetch(`${s.base}/api/history/${e.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ favorite: true }) }));
  assert.equal(p.favorite, true);
  const { sessions } = await j(await fetch(s.base + '/api/history?favorites=1'));
  assert.equal(sessions[0].entries[0].id, e.id);
  const disk = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'history.json'), 'utf8'));
  assert.ok(disk.entries.some((x) => x.id === e.id && x.favorite));
  assert.equal((await fetch(`${s.base}/api/history/nope`, { method: 'PATCH', body: '{}' })).status, 404);
});

test('proxy HTTP: /comfy/system_stats passes; Origin/Host rewritten so ComfyUI origin check passes', async () => {
  // Direct to the mock with a foreign Origin is refused (like real ComfyUI)...
  assert.equal((await fetch(s.mockBase + '/system_stats', { headers: { Origin: 'https://pc.tailnet.ts.net' } })).status, 403);
  // ...but through the proxy it works.
  const r = await fetch(s.base + '/comfy/system_stats', { headers: { Origin: 'https://pc.tailnet.ts.net', Cookie: 'secret=1' } });
  assert.equal(r.status, 200);
  const seen = (await j(await fetch(s.mockBase + '/mock/requests'))).filter((x) => x.path === '/system_stats').at(-1);
  assert.equal(seen.headers.origin, s.mockBase);
  assert.equal(seen.headers.host, new URL(s.mockBase).host);
  assert.equal(seen.headers.cookie, undefined, 'app cookies not forwarded');
  const home = await fetch(s.base + '/comfy/');
  assert.match(await home.text(), /Mock ComfyUI/);
});

function openWs(url, origin) {
  // Node 22 has a global WebSocket (browser-compatible API).
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, origin ? { headers: { Origin: origin } } : undefined);
    const msgs = [];
    ws.addEventListener('message', (e) => msgs.push(JSON.parse(e.data)));
    ws.addEventListener('open', () => resolve({ ws, msgs }));
    ws.addEventListener('error', reject);
  });
}
const waitFor = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); } throw new Error('timeout'); };

test('proxy WS + full job flow: queue via /comfy/prompt, progress/executed/executing(null) arrive, /comfy/view serves PNG', async () => {
  const { ws, msgs } = await openWs(`ws://127.0.0.1:${s.port}/comfy/ws?clientId=test-client`);
  await waitFor(() => msgs.find((m) => m.type === 'status'));
  const { workflows } = await j(await fetch(s.base + '/api/workflows'));
  const wf = workflows.find((w) => w.id === 'basic-txt2img').workflow;
  const q = await j(await fetch(s.base + '/comfy/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: wf, client_id: 'test-client' }) }));
  assert.ok(q.prompt_id);
  const done = await waitFor(() => msgs.find((m) => m.type === 'executing' && m.data.node === null && m.data.prompt_id === q.prompt_id));
  assert.ok(done);
  const prog = msgs.filter((m) => m.type === 'progress');
  assert.equal(prog.at(-1).data.value, 4); assert.equal(prog.at(-1).data.max, 4);
  const ex = msgs.find((m) => m.type === 'executed');
  const img = ex.data.output.images[0];
  const v = await fetch(`${s.base}/comfy/view?` + new URLSearchParams({ filename: img.filename, subfolder: img.subfolder, type: img.type }));
  assert.equal(v.headers.get('content-type'), 'image/png');
  const buf = Buffer.from(await v.arrayBuffer());
  assert.equal(buf.subarray(1, 4).toString(), 'PNG');
  const h = await j(await fetch(`${s.base}/comfy/history/${q.prompt_id}`));
  assert.equal(h[q.prompt_id].outputs['58'].images[0].filename, img.filename);
  ws.close();
});

test('proxy WS with a foreign Origin is still accepted (Origin rewritten on upgrade)', async () => {
  const { ws, msgs } = await openWs(`ws://127.0.0.1:${s.port}/comfy/ws?clientId=o`, 'https://pc.tailnet.ts.net');
  await waitFor(() => msgs.length);
  ws.close();
});

test('cancel: /comfy/queue delete removes pending, /comfy/interrupt stops running', async () => {
  const slow = await startStack({ stepMs: 300 });
  try {
    const { ws, msgs } = await openWs(`ws://127.0.0.1:${slow.port}/comfy/ws?clientId=c`);
    const { workflows } = await j(await fetch(slow.base + '/api/workflows'));
    const wf = workflows.find((w) => w.id === 'basic-txt2img').workflow;
    const post = async () => j(await fetch(slow.base + '/comfy/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: wf, client_id: 'c' }) }));
    const a = await post(), b = await post(), c = await post();
    await waitFor(() => msgs.find((m) => m.type === 'progress' && m.data.prompt_id === a.prompt_id));
    let qs = await j(await fetch(slow.base + '/comfy/queue'));
    assert.equal(qs.queue_pending.length, 2);
    await fetch(slow.base + '/comfy/queue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delete: [b.prompt_id, c.prompt_id] }) });
    await fetch(slow.base + '/comfy/interrupt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt_id: a.prompt_id }) });
    await waitFor(() => msgs.find((m) => m.type === 'execution_interrupted' && m.data.prompt_id === a.prompt_id));
    qs = await j(await fetch(slow.base + '/comfy/queue'));
    assert.equal(qs.queue_pending.length + qs.queue_running.length, 0);
    ws.close();
  } finally { await slow.close(); }
});

test('history entry queued without images is filled from ComfyUI /history on GET', async () => {
  const { workflows } = await j(await fetch(s.base + '/api/workflows'));
  const wf = workflows.find((w) => w.id === 'basic-txt2img').workflow;
  const q = await j(await fetch(s.base + '/comfy/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: wf, client_id: 'nobody' }) }));
  const e = await j(await fetch(s.base + '/api/history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'lost', promptId: q.prompt_id }) }));
  assert.equal(e.status, 'queued');
  await waitFor(() => s.mock.history[q.prompt_id]);
  const { sessions } = await j(await fetch(s.base + '/api/history'));
  const got = sessions.flatMap((x) => x.entries).find((x) => x.id === e.id);
  assert.equal(got.status, 'done');
  assert.equal(got.images.length, 1);
});

test('POST /share (Android share target): image uploaded to ComfyUI input, 303 into app with ?ref', async () => {
  const fd = new FormData();
  fd.append('title', 'Screenshot');
  fd.append('text', '');
  fd.append('image', new Blob([pngBytes()], { type: 'image/png' }), 'Screenshot_2026.png');
  const r = await fetch(s.base + '/share', { method: 'POST', body: fd, redirect: 'manual' });
  assert.equal(r.status, 303);
  const loc = new URL(r.headers.get('location'), s.base);
  assert.equal(loc.pathname, '/');
  assert.equal(loc.searchParams.get('ref'), 'Screenshot_2026.png');
  assert.equal(loc.searchParams.get('from'), 'share');
  assert.ok(s.mock.files.has('input//Screenshot_2026.png'));
  // Same name again -> ComfyUI-style rename, ref follows it.
  const fd2 = new FormData(); fd2.append('image', new Blob([pngBytes()], { type: 'image/png' }), 'Screenshot_2026.png');
  const r2 = await fetch(s.base + '/share', { method: 'POST', body: fd2, redirect: 'manual' });
  assert.equal(new URL(r2.headers.get('location'), s.base).searchParams.get('ref'), 'Screenshot_2026 (1).png');
});

test('POST /share with text only -> ?text; with ComfyUI down -> ?shareError', async () => {
  const fd = new FormData(); fd.append('text', 'a moody forest');
  const r = await fetch(s.base + '/share', { method: 'POST', body: fd, redirect: 'manual' });
  assert.equal(new URL(r.headers.get('location'), s.base).searchParams.get('text'), 'a moody forest');
  const down = await startStack({ comfyDown: true });
  try {
    const fd2 = new FormData(); fd2.append('image', new Blob([pngBytes()], { type: 'image/png' }), 'a.png');
    const r2 = await fetch(down.base + '/share', { method: 'POST', body: fd2, redirect: 'manual' });
    assert.equal(r2.status, 303);
    assert.ok(new URL(r2.headers.get('location'), down.base).searchParams.get('shareError'));
    // Proxy to a dead ComfyUI -> 502 JSON
    const p = await fetch(down.base + '/comfy/system_stats');
    assert.equal(p.status, 502);
  } finally { await down.close(); }
});

test('static: app shell, manifest share_target, SPA fallback, path traversal blocked', async () => {
  assert.match(await (await fetch(s.base + '/')).text(), /<title>Comfy UI<\/title>/);
  const m = await j(await fetch(s.base + '/manifest.webmanifest'));
  assert.equal(m.share_target.action, '/share');
  assert.equal(m.share_target.enctype, 'multipart/form-data');
  assert.equal((await fetch(s.base + '/sw.js')).status, 200);
  assert.equal((await fetch(s.base + '/js/lib/workflow-detect.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.match(await (await fetch(s.base + '/some/deep/link')).text(), /Comfy UI/);
  const trav = await fetch(s.base + '/%2e%2e/config.json');
  assert.notEqual(trav.status, 200);
});
