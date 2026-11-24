// index.js - the app server.
// -----------------------------------------------------------------------------
//   /            -> the PWA (static files from app/)
//   /comfy/*     -> reverse proxy to ComfyUI (HTTP + websocket), see proxy.js
//   /api/config     GET   app settings + whether ComfyUI answers
//   /api/workflows  GET   presets with detected controls + default (fresh-client preset); POST import (multipart or JSON)
//   /api/history    GET   sessions -> entries; POST add entry
//   /api/history/:id PATCH favourite / images / status
//   /api/history/:id/preview POST image bytes: 3D still / video first frame for the tagger (batch 9)
//   /api/tagger     GET status, POST {enabled}  background History tags (server/tagger.js)
//   /api/events     GET   Server-Sent Events ("workflows" when the folder changes)
//   /share          POST  Android share target
//   /ollama/*       -> allow-listed proxy to a local Ollama (Chat tab), see ollama.js
//   /api/chats      GET list, POST create; /api/chats/:id GET, PUT/PATCH, DELETE
//   /api/ollama/unload POST  unload Ollama models (keep_alive 0) now
//   /api/memory     GET   detected GPU/RAM, memory profile (always auto, from VRAM), chat model fit (?fresh=1)
//   /api/memory/before-queue POST {workflow}  unload Ollama if this profile/free VRAM says so
//   /api/memory/before-chat  POST {model}     fit check; maybe ComfyUI /free first (small GPU)
//   /api/memory/free-for-chat POST           OOM fallback: ComfyUI /free per profile
//   /api/memory/settings GET, POST {textEncoderCpu, ollamaCpu}  the two memory switches (data/memory-settings.json)
//   /api/actions    GET   workflow actions (workflows/actions/*.json) for the Chat
//   /api/workflows?fresh=1 also lists the AI Workflow presets (workflows/ai/*.json,
//                   availability computed live from ComfyUI /object_info + model
//                   lists + GPU/RAM) and the user's saved builder setups
//   /api/builder/propose POST {text, history, model}  chat builder: Ollama proposes blocks, server validates
//   /api/builder/check   POST {blocks, name, test}    re-validate (Test run gets the graph)
//   /api/builder/config  GET / PUT {model}            builder model (data/builder.json)
//   /api/user-presets    GET, POST {name, blocks}; /api/user-presets/:id PATCH {name}, DELETE
//   /api/outputs    GET   ?kind=image&offset&limit  the app's results on the PC ("From Comfy UI"), see outputs.js
//   /api/drive/save POST  {filename, subfolder, type, kind, folder?}  copy a result into Google Drive (drive.js)
//   /api/drive/folders GET ?path= / POST {path, name}  list / make folders in My Drive (Save to…)
//   Batch 11 - projects (folders under Creative/PROJECTS/ACTIVE, server/projects.js) and
//   filing every output there (server/filer.js):
//   /api/projects          GET   projects + counts, current, Unsorted count, filing status
//   /api/projects/browse   GET   ?path=Apps  sub folders of ACTIVE (project / grouping folder)
//   /api/projects          POST  {path}            an existing folder becomes a project
//   /api/projects/new      POST  {name, parent}    new folder (+ "__comfy outputs") as a project
//   /api/projects/current  POST  {id|null}         the project new outputs go to
//   /api/projects/move     POST  {ids, project}    entries (+ what was made from them) to a project
//   /scripts/* /extensions/* /assets/* -> ComfyUI too (custom-node extensions
//                   that import from the ComfyUI root instead of /comfy/)
// Binds 127.0.0.1 only. Remote access = `tailscale serve` in front of it.
// -----------------------------------------------------------------------------
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, probeComfy, ROOT } from './config.js';
import { createComfyProxy } from './proxy.js';
import { serveStatic } from './static.js';
import { WorkflowStore } from './workflows.js';
import { HistoryStore } from './history.js';
import { ChatStore } from './chats.js';
import { createOllama } from './ollama.js';
import { ActionStore } from './actions.js';
import { createHardware, runNvidiaUtil } from './hardware.js';
import { createTagger, readGpuUtil } from './tagger.js';
import { createMemory } from './memory.js';
import { handleShare } from './share.js';
import { readBody, parseMultipart } from './multipart.js';
import { createComfyInfo } from './comfy-info.js';
import { PresetStore } from './presets.js';
import { UserPresetStore } from './user-presets.js';
import { GraphPresetStore, outputKind } from './graph-presets.js';
import { createBuilder } from './builder.js';
import { detectControls } from '../app/js/lib/workflow-detect.js';
import { vramFit } from '../app/js/lib/presets.js';
import { isHeavy } from '../app/js/lib/memory-options.js';
import { splitOutputs } from '../app/js/lib/outputs.js';
import { isLegacyPreset, migrateHistoryEntry } from '../app/js/lib/legacy-presets.js';
import { defaultPreset } from '../app/js/lib/preset-choice.js';
import { historyOutputs, comfyOutputDir, createOutputDirCache, scanAppFolder, mergeOutputs, deleteAppFile } from './outputs.js';
import { FolderStore } from './folders.js';
import { saveToDrive, listDriveFolders, makeDriveFolder } from './drive.js';
import { ProjectStore, KIND_DIRS } from './projects.js';
import { createFiler } from './filer.js';

const GROUP_OF = { image: 'Image', '3d': '3D', video: 'Video', audio: 'Audio' };
const COMFY_SNIPPET = '<link rel="stylesheet" href="/comfy-tweaks.css" data-concept-tweaks><script src="/js/comfy-tweaks.js" data-concept-tweaks></script>';

// Written to stdout/stderr, which start-background.vbs sends to data\server.log.
const log = (...a) => console.error(new Date().toISOString(), ...a);

const json = (res, status, body) => {
  if (status === 409 || status >= 500) log(`answered ${status}:`, body?.error || '', body?.detail || '');
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body));
};

export function createApp(cfg, opts = {}) {
  const { runSmi, os, env } = opts;
  const appDir = path.join(ROOT, 'app');
  const workflows = new WorkflowStore(cfg.workflowsDir);
  const history = new HistoryStore(cfg.dataDir, { sessionGapMinutes: cfg.sessionGapMinutes });
  const folders = new FolderStore(cfg.dataDir);
  // Batch 11: projects on Drive, and every output filed into its project's folder.
  const projects = new ProjectStore(cfg.dataDir, { projectsDir: cfg.projectsDir });
  const filer = createFiler({ history, projects, getComfyUrl: () => cfg.comfyUrl, outputSubfolder: cfg.outputSubfolder, log, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}), ...(opts.filer || {}) });
  // /comfy/ page: + app/comfy-tweaks.css and app/js/comfy-tweaks.js (hide the Agent
  // button / toasts, node-view mode); framing allowed for the app's node view.
  const proxy = createComfyProxy(() => cfg.comfyUrl, '/comfy', { injectHtml: COMFY_SNIPPET, frameable: true });
  // Some ComfyUI custom-node extensions import "/scripts/app.js" or call
  // "/api/<their-route>" from the ComfyUI root instead of relative to the page,
  // which under /comfy/ would hit this app. Forward those unchanged.
  const rootProxy = createComfyProxy(() => cfg.comfyUrl, '');
  const chats = new ChatStore(cfg.dataDir);
  const ollama = createOllama(() => cfg.ollamaUrl);
  const actions = new ActionStore(path.join(cfg.workflowsDir, 'actions'));
  const hardware = createHardware({ getComfyUrl: () => cfg.comfyUrl, ...(runSmi ? { runSmi } : {}), ...(os ? { os } : {}) });
  const memory = createMemory({ cfg, hardware, ollama, getComfyUrl: () => cfg.comfyUrl, ...(env ? { env } : {}) });
  const comfyInfo = createComfyInfo({ getComfyUrl: () => cfg.comfyUrl });
  // Batch 9: History tags in the background, only while the GPU is quiet (no game, no ComfyUI job).
  const tagger = createTagger({ history, dataDir: cfg.dataDir, getComfyUrl: () => cfg.comfyUrl, getOllamaUrl: () => cfg.ollamaUrl, gpuUtil: opts.gpuUtil || (() => readGpuUtil(runNvidiaUtil)), log, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}), ...(opts.tagger || {}) });
  const presets = new PresetStore(path.join(cfg.workflowsDir, 'ai'));
  const userPresets = new UserPresetStore(cfg.dataDir);
  const graphPresets = new GraphPresetStore(cfg.dataDir); // saved from the node view (Save as preset)
  const builder = createBuilder({ cfg, comfyInfo, presets, memory, hardware });
  const sseClients = new Set();
  // ComfyUI's output folder (delete, "From Comfy UI"): last good value cached in data/.
  const outDirCache = createOutputDirCache(cfg.dataDir);
  const outputDirOf = () => comfyOutputDir(cfg, { cache: outDirCache, log, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });

  // Everything the preset picker shows: AI Workflow presets (live
  // availability), saved builder setups (re-validated live) and workflows
  // imported/dropped into workflows/ (both under My presets). A leftover
  // fast-concept.json / from-reference-image.json is not listed: those ids
  // are retired and resolve to the Klein 4B presets (lib/legacy-presets.js).
  async function allWorkflows({ fresh = false } = {}) {
    const info = await comfyInfo.get({ fresh });
    const hw = await hardware.detect();
    let profileId; try { profileId = (await memory.status()).profile.id; } catch {}
    const hwOpts = { gpuTotalMB: hw.gpu?.totalMB, ramFreeMB: hw.ram?.freeMB };
    const ai = presets.list(info, hwOpts, { profileId });
    const mine = await Promise.all(userPresets.list().map(async (u) => {
      const base = { id: `user:${u.id}`, file: null, label: u.name, group: 'My presets', user: { id: u.id, name: u.name, blocks: u.blocks, output: u.output } };
      if (!info.objectInfo) return { ...base, ok: true, workflow: null, availability: { status: 'unknown', label: 'ComfyUI offline', reason: 'ComfyUI is not reachable' } };
      const r = await builder.check({ blocks: u.blocks, name: u.name });
      if (!r.ok) return { ...base, ok: true, workflow: null, availability: { status: 'unavailable', label: 'unavailable', reason: r.errors.join(' ') } };
      return { ...base, ok: true, workflow: r.graph, controls: detectControls(r.graph), description: r.summary.join(' · '), output: r.output, ai: { output: r.output, params: {}, size: null, maxBatch: r.output === 'image' ? 8 : 2, vram: { estMB: r.estMB }, promptFormat: r.blocks.some((b) => b.type === 'audio' && b.params.engine === 'vibevoice') ? { unless: '\\[\\d+\\]|Speaker \\d+:', template: '[1] {text}' } : null }, availability: { ...vramFit({ estMB: r.estMB, ...hwOpts, profileId }), estMB: r.estMB } };
    }));
    const folder = workflows.list().filter((w) => !isLegacyPreset(w.id)).map((w) => ({ ...w, group: 'My presets', folder: true }));
    // Saved from the node view: in the section / sub section the user picked;
    // controls detected like a dropped-in workflow.
    const graphs = graphPresets.list().map((g) => {
      const controls = detectControls(g.workflow);
      const base = { id: `graph:${g.id}`, file: null, label: g.name, short: g.name, group: g.group, subgroup: g.subgroup || undefined, menuOrder: 900, output: outputKind(g.workflow), graph: { id: g.id, name: g.name, group: g.group, subgroup: g.subgroup, from: g.from, updatedAt: g.updatedAt } };
      return controls.ok ? { ...base, ok: true, controls, workflow: g.workflow } : { ...base, ok: false, error: controls.error };
    });
    const list = [...ai, ...mine, ...graphs, ...folder];
    // default: what a fresh client opens on (same rule as the browser, lib/preset-choice.js).
    return { workflows: list, default: defaultPreset(list), comfy: { reachable: !!info.objectInfo, error: info.error || null } };
  }
  /** { estMB, heavy } for the before-queue memory step (GGUF path per profile). */
  async function memoryFor(id) {
    if (id.startsWith('ai:')) {
      const info = await comfyInfo.get().catch(() => ({}));
      return presets.memoryFor(id, { objectInfo: info?.objectInfo, profileId: await memory.profileId() });
    }
    const estMB = await estMBFor(id);
    return { estMB, heavy: isHeavy(null, estMB ?? 0) };
  }
  async function estMBFor(id) {
    if (id.startsWith('ai:')) { const p = presets.get(id); return p ? (p.manifest.vram.measuredMB || p.manifest.vram.estMB) : undefined; }
    if (id.startsWith('user:')) { const u = userPresets.get(id); if (!u) return undefined; const r = await builder.check({ blocks: u.blocks, name: u.name }); return r.estMB; }
    if (id.startsWith('builder:')) return undefined;
    return undefined;
  }
  /**
   * Batch 11: Save… starts in the current project's "__comfy outputs/<kind>" (or
   * ACTIVE/__Comfy UI/<kind>), as paths relative to My Drive, so the old top-level
   * My Drive\Comfy UI folder is no longer made. null when ACTIVE is not inside My Drive.
   */
  function saveDefaults() {
    if (!projects.available()) return null;
    const root = path.dirname(path.resolve(cfg.driveDir));
    const base = projects.outputsDir(projects.current) || projects.outputsDir(null);
    const rel = path.relative(root, base);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const r = rel.split(path.sep).join('/');
    return Object.fromEntries(Object.entries(KIND_DIRS).map(([k, f]) => [k, `${r}/${f}`]));
  }
  workflows.on('change', () => { for (const r of sseClients) r.write('event: workflows\ndata: {}\n\n'); });

  // If a browser lost track of a job (phone slept, tab closed), the history
  // entry has a promptId but no images. Ask ComfyUI's GET /history/<id>,
  // which keeps finished jobs' outputs, and fill them in.
  async function resolvePending() {
    const pend = history.pending().filter((e) => Date.now() - e.createdAt < 7 * 864e5).slice(-20);
    await Promise.all(pend.map(async (e) => {
      try {
        const r = await fetch(`${cfg.comfyUrl}/history/${encodeURIComponent(e.promptId)}`, { signal: AbortSignal.timeout(1500) });
        if (!r.ok) return;
        const h = (await r.json())[e.promptId];
        if (!h) return;
        const { images, files } = splitOutputs(h.outputs);
        if (images.length || files.length) await history.update(e.id, { images, files, status: 'done' });
        else if (h.status?.status_str === 'error') await history.update(e.id, { status: 'error' });
      } catch { /* ComfyUI offline: leave as is */ }
    }));
  }

  async function api(req, res, url) {
    const p = url.pathname;
    if (p === '/api/config' && req.method === 'GET') {
      const probe = await probeComfy({ ...cfg, comfyUrlExplicit: true }, 1500);
      return json(res, 200, { comfyUrl: cfg.comfyUrl, comfyReachable: probe.ok, comfyStats: probe.stats || null, outputSubfolder: cfg.outputSubfolder, sessionGapMinutes: cfg.sessionGapMinutes });
    }
    if (p === '/api/workflows' && req.method === 'GET') return json(res, 200, await allWorkflows({ fresh: url.searchParams.get('fresh') === '1' }));
    // ---- Chat builder + saved setups ----
    if (p.startsWith('/api/builder/') || p.startsWith('/api/user-presets')) {
      let body = {};
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        try { const t = (await readBody(req, 256 * 1024)).toString('utf8'); body = t ? JSON.parse(t) : {}; } catch { return json(res, 400, { error: 'Bad JSON' }); }
      }
      if (p === '/api/builder/config' && req.method === 'GET') return json(res, 200, builder.config());
      if (p === '/api/builder/config' && req.method === 'PUT') { try { return json(res, 200, builder.setModel(body.model)); } catch (e) { return json(res, e.status || 500, { error: e.message }); } }
      if (p === '/api/builder/propose' && req.method === 'POST') return json(res, 200, await builder.propose({ text: body.text, history: Array.isArray(body.history) ? body.history : [], model: body.model }));
      if (p === '/api/builder/check' && req.method === 'POST') return json(res, 200, await builder.check({ blocks: body.blocks, name: body.name, test: !!body.test }));
      if (p === '/api/user-presets' && req.method === 'GET') return json(res, 200, { presets: userPresets.list() });
      if (p === '/api/user-presets' && req.method === 'POST') {
        const r = await builder.check({ blocks: body.blocks, name: body.name });
        if (!r.ok) return json(res, 422, { error: r.errors.join(' '), errors: r.errors });
        const u = await userPresets.add({ name: body.name, blocks: r.blocks, output: r.output });
        for (const c of sseClients) c.write('event: workflows\ndata: {}\n\n');
        return json(res, 201, { ...u, id: `user:${u.id}` });
      }
      let dp = p; try { dp = decodeURIComponent(p); } catch {}
      const um = /^\/api\/user-presets\/(?:user:)?([\w-]+)$/.exec(dp);
      if (um && req.method === 'PATCH') { try { const u = await userPresets.rename(um[1], body.name); if (!u) return json(res, 404, { error: 'Not found' }); for (const c of sseClients) c.write('event: workflows\ndata: {}\n\n'); return json(res, 200, { ...u, id: `user:${u.id}` }); } catch (e) { return json(res, e.status || 500, { error: e.message }); } }
      if (um && req.method === 'DELETE') { const ok = await userPresets.remove(um[1]); if (ok) for (const c of sseClients) c.write('event: workflows\ndata: {}\n\n'); return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Not found' }); }
      return json(res, 404, { error: 'Unknown API route' });
    }
    // ---- Save as preset (node view) ----
    //   POST /api/graph-presets {name, group, subgroup, workflow, from}   new preset
    //   PATCH /api/graph-presets/:id {name?, group?, subgroup?, workflow?} rename / move / update graph
    //   DELETE /api/graph-presets/:id
    if (p.startsWith('/api/graph-presets')) {
      let body = {};
      if (req.method === 'POST' || req.method === 'PATCH') {
        try { const t = (await readBody(req, 5 * 1024 * 1024)).toString('utf8'); body = t ? JSON.parse(t) : {}; } catch { return json(res, 400, { error: 'Bad JSON' }); }
      }
      const changed = () => { for (const c of sseClients) c.write('event: workflows\ndata: {}\n\n'); };
      const reply = (g, status = 200) => json(res, status, { ...g, id: `graph:${g.id}`, workflow: undefined });
      try {
        if (p === '/api/graph-presets' && req.method === 'POST') { const g = await graphPresets.add(body); changed(); return reply(g, 201); }
        let dp = p; try { dp = decodeURIComponent(p); } catch {}
        const gm = /^\/api\/graph-presets\/(?:graph:)?([\w-]+)$/.exec(dp);
        if (gm && req.method === 'PATCH') { const g = await graphPresets.update(gm[1], body); if (!g) return json(res, 404, { error: 'Not found' }); changed(); return reply(g); }
        if (gm && req.method === 'DELETE') { const ok = await graphPresets.remove(gm[1]); if (ok) changed(); return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Not found' }); }
      } catch (e) { return json(res, e.status || 500, { error: e.message }); }
      return json(res, 404, { error: 'Unknown API route' });
    }
    if (p === '/api/workflows' && req.method === 'POST') {
      const body = await readBody(req, 10 * 1024 * 1024);
      const ct = req.headers['content-type'] || '';
      let name = url.searchParams.get('name') || 'imported.json', text;
      if (ct.startsWith('multipart/')) {
        const f = parseMultipart(body, ct).find((x) => x.filename);
        if (!f) return json(res, 400, { error: 'No file in upload' });
        name = f.filename; text = f.data.toString('utf8');
      } else text = body.toString('utf8');
      try { return json(res, 201, workflows.import(name, text)); } catch (e) { return json(res, e.status || 500, { error: e.message }); }
    }
    if (p === '/api/history' && req.method === 'GET') {
      await resolvePending();
      const fid = url.searchParams.get('folder');
      const folder = fid ? folders.get(fid) : null;
      if (fid && !folder) return json(res, 404, { error: 'No such folder' });
      const sessions = history.list({ favoritesOnly: url.searchParams.get('favorites') === '1', only: folder ? new Set(folder.items) : null });
      // preview: the tagger already has a still for this 3D model / video (batch 9)
      for (const s of sessions) s.entries = s.entries.map((e) => (tagger.hasPreview(e.id) ? { ...e, preview: true } : e));
      return json(res, 200, { sessions });
    }
    if (p === '/api/tagger' && req.method === 'GET') return json(res, 200, tagger.status());
    if (p === '/api/tagger' && req.method === 'POST') {
      let body;
      try { body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8')); } catch { return json(res, 400, { error: 'Bad JSON' }); }
      return json(res, 200, await tagger.setEnabled(body.enabled !== false));
    }
    const pv = /^\/api\/history\/([\w-]+)\/preview$/.exec(p);
    if (pv && req.method === 'POST') {
      const buf = await readBody(req, 4 * 1024 * 1024);
      if (!buf.length) return json(res, 400, { error: 'Empty image' });
      try { return json(res, 200, await tagger.savePreview(pv[1], buf)); } catch (e) { return json(res, e.status || 500, { error: e.message }); }
    }
    // Delete results from the PC (History multi-select). Each file must resolve
    // inside ComfyUI's output/<outputSubfolder>/ (server/outputs.js deleteAppFile);
    // an entry leaves History only when all its files are gone.
    if (p === '/api/history/delete' && req.method === 'POST') {
      let body;
      try { body = JSON.parse((await readBody(req, 256 * 1024)).toString('utf8')); } catch { return json(res, 400, { error: 'Bad JSON' }); }
      const ids = Array.isArray(body?.ids) ? body.ids.filter((x) => typeof x === 'string').slice(0, 2000) : [];
      if (!ids.length) return json(res, 400, { error: 'Nothing to delete' });
      const outputDir = await outputDirOf();
      if (!outputDir) return json(res, 409, { error: 'ComfyUI output folder is unknown, nothing was deleted. Set "comfyOutputDir" in config.local.json (see README).' });
      const deleted = [], refused = [], trimmed = new Map();
      // One locked or refused file never stops the rest of the selection, and
      // History always ends up matching the disk: an entry whose files are all
      // gone is removed; an entry with some files left keeps only those (finally,
      // so this also happens if something unexpected throws half way).
      try {
        for (const id of ids) {
          const e = history.get(id);
          if (!e) { refused.push({ id, reason: 'Not found' }); continue; }
          const left = { images: [], files: [] }, gone = [];
          for (const key of ['images', 'files']) {
            for (const f of e[key] || []) {
              let r;
              try { r = await deleteAppFile(f, { outputDir, outputSubfolder: cfg.outputSubfolder, unlink: opts.unlink, wait: opts.wait }); } catch (err) { r = { ok: false, reason: err.message }; }
              if (r.ok) { gone.push(f); continue; }
              left[key].push(f);
              refused.push({ id, file: `${f.subfolder ? f.subfolder + '/' : ''}${f.filename}`, reason: r.reason });
            }
          }
          // Batch 11: its filed copies on Drive go too (Drive for Desktop puts them in the Drive trash).
          if (gone.length) await filer.trash(e, gone);
          if (!left.images.length && !left.files.length) deleted.push(id);
          else if (left.images.length + left.files.length < (e.images?.length || 0) + (e.files?.length || 0)) trimmed.set(id, left);
        }
      } finally {
        await history.remove(deleted);
        await tagger.dropPreviews(deleted);
        for (const [id, left] of trimmed) await history.update(id, left);
        await folders.forget(deleted);
      }
      if (refused.length) log(`delete: ${refused.length} not deleted (${refused.slice(0, 3).map((x) => `${x.file || x.id}: ${x.reason}`).join('; ')})`);
      return json(res, 200, { deleted, refused });
    }
    // ---- History folders (labels only) ----
    if (p === '/api/folders' && req.method === 'GET') {
      const all = history.list({}).flatMap((s) => s.entries);
      const byId = new Map(all.map((e) => [e.id, e]));
      const cover = (entries) => { const e = entries.find((x) => x.images?.length || x.parent?.image || x.files?.length); return e ? (e.images?.[0] || e.parent?.image || e.files?.[0]) : null; };
      const favs = all.filter((e) => e.favorite);
      return json(res, 200, {
        favorites: { count: favs.length, cover: cover(favs) },
        folders: folders.list().map((f) => { const es = f.items.map((x) => byId.get(x)).filter(Boolean).sort((a, b) => b.createdAt - a.createdAt); return { id: f.id, name: f.name, count: es.length, cover: cover(es) }; }),
      });
    }
    {
      const fm = /^\/api\/folders(?:\/(f_[\w-]+))?(\/items)?$/.exec(p);
      if (fm && ['POST', 'PATCH', 'DELETE'].includes(req.method)) {
        let body = {};
        if (req.method !== 'DELETE') { try { const t = (await readBody(req, 256 * 1024)).toString('utf8'); body = t ? JSON.parse(t) : {}; } catch { return json(res, 400, { error: 'Bad JSON' }); } }
        try {
          if (!fm[1] && req.method === 'POST') return json(res, 201, await folders.create(body.name));
          if (fm[1] && fm[2] && req.method === 'POST') { const f = await folders.edit(fm[1], { add: Array.isArray(body.add) ? body.add.filter((x) => history.get(x)) : [], remove: Array.isArray(body.remove) ? body.remove : [] }); return f ? json(res, 200, f) : json(res, 404, { error: 'No such folder' }); }
          if (fm[1] && !fm[2] && req.method === 'PATCH') { const f = await folders.rename(fm[1], body.name); return f ? json(res, 200, f) : json(res, 404, { error: 'No such folder' }); }
          if (fm[1] && !fm[2] && req.method === 'DELETE') return (await folders.remove(fm[1])) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'No such folder' });
        } catch (e) { return json(res, e.status || 500, { error: e.message }); }
      }
    }
    if (p === '/api/history' && req.method === 'POST') {
      let body;
      try { body = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8')); } catch { return json(res, 400, { error: 'Bad JSON' }); }
      // Batch 11: the project of the picture it was made from (upscale / 3D / Use as
      // reference), else the current project, else Unsorted. Never what the client says.
      const from = history.get(body?.parent?.historyId) || history.get(body?.source);
      const project = from ? (from.project ?? null) : projects.current;
      if (project) projects.touch(project);
      const e = await history.add({ ...body, project, source: from && history.get(body?.source) ? body.source : undefined });
      if (e.images.length || e.files.length) filer.kick();
      return json(res, 201, e);
    }
    const m = /^\/api\/history\/([\w-]+)$/.exec(p);
    if (m && (req.method === 'PATCH' || req.method === 'POST')) {
      let body;
      try { body = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8')); } catch { return json(res, 400, { error: 'Bad JSON' }); }
      const e = await history.update(m[1], body);
      if (e && ('images' in body || 'files' in body)) filer.kick(); // finished: file it on Drive
      return e ? json(res, 200, migrateHistoryEntry(e)) : json(res, 404, { error: 'Not found' });
    }
    // ---- Batch 11: projects ----
    if (p.startsWith('/api/projects')) {
      let body = {};
      if (req.method === 'POST') { try { const t = (await readBody(req, 256 * 1024)).toString('utf8'); body = t ? JSON.parse(t) : {}; } catch { return json(res, 400, { error: 'Bad JSON' }); } }
      try {
        if (p === '/api/projects' && req.method === 'GET') {
          const list = projects.list();
          const counts = new Map(), lastAt = new Map();
          let unsorted = 0;
          for (const e of history.data.entries) {
            if (!e.images?.length && !e.files?.length) continue;
            const id = e.project ?? null;
            if (!id || !projects.get(id)) { unsorted++; continue; }
            counts.set(id, (counts.get(id) || 0) + 1);
            lastAt.set(id, Math.max(lastAt.get(id) || 0, e.createdAt || 0));
          }
          return json(res, 200, {
            available: projects.available(), root: path.basename(projects.root), current: projects.current,
            projects: list.map((x) => ({ id: x.id, name: x.name, path: x.rel, group: x.group, missing: x.missing, lastUsedAt: x.lastUsedAt || 0, count: counts.get(x.id) || 0, lastAt: lastAt.get(x.id) || 0 })),
            unsorted: { count: unsorted }, filing: filer.status(),
          });
        }
        if (p === '/api/projects/browse' && req.method === 'GET') return json(res, 200, projects.browse(url.searchParams.get('path') || ''));
        if (p === '/api/projects' && req.method === 'POST') { const x = await projects.mark(body.path); await projects.setCurrent(x.id); return json(res, 201, x); }
        if (p === '/api/projects/new' && req.method === 'POST') return json(res, 201, await projects.create(body.parent || '', body.name));
        if (p === '/api/projects/current' && req.method === 'POST') return json(res, 200, { current: await projects.setCurrent(body.id || null) });
        if (p === '/api/projects/move' && req.method === 'POST') {
          const target = body.project || null;
          if (target && !projects.get(target)) return json(res, 404, { error: 'No such project' });
          const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string' && history.get(x)).slice(0, 2000) : [];
          if (!ids.length) return json(res, 400, { error: 'Nothing to move' });
          // What was made from them (upscales, 3D, references) moves along.
          const all = history.descendants(ids);
          const moved = await history.setProject(all, target);
          if (target) await projects.touch(target);
          filer.kick();
          return json(res, 200, { moved, ids: all });
        }
      } catch (e) { return json(res, e.status || 500, { error: e.message }); }
      return json(res, 404, { error: 'Unknown API route' });
    }
    // ---- Chat tab ----
    if (p === '/api/chats' && req.method === 'GET') return json(res, 200, { chats: chats.list() });
    if (p === '/api/chats' && req.method === 'POST') {
      let body;
      try { body = JSON.parse((await readBody(req, 4 * 1024 * 1024)).toString('utf8') || '{}'); } catch { return json(res, 400, { error: 'Bad JSON' }); }
      return json(res, 201, await chats.create(body));
    }
    const cm = /^\/api\/chats\/([\w-]+)$/.exec(p);
    if (cm) {
      if (req.method === 'GET') { const c = chats.get(cm[1]); return c ? json(res, 200, c) : json(res, 404, { error: 'Not found' }); }
      if (req.method === 'DELETE') return (await chats.remove(cm[1])) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Not found' });
      if (req.method === 'PUT' || req.method === 'PATCH') {
        let body;
        try { body = JSON.parse((await readBody(req, 4 * 1024 * 1024)).toString('utf8')); } catch { return json(res, 400, { error: 'Bad JSON' }); }
        const c = await chats.update(cm[1], body);
        return c ? json(res, 200, c) : json(res, 404, { error: 'Not found' });
      }
    }
    if (p === '/api/actions' && req.method === 'GET') return json(res, 200, { actions: actions.list() });
    if (p === '/api/ollama/unload' && req.method === 'POST') return json(res, 200, await ollama.unloadAll());
    if (p === '/api/memory/settings' && req.method === 'GET') return json(res, 200, memory.getSettings());
    if (p === '/api/memory' && req.method === 'GET') return json(res, 200, await memory.status({ fresh: url.searchParams.has('fresh') }));
    // The memory profile is always picked automatically from the detected VRAM (no override route).
    if (req.method === 'POST' && p.startsWith('/api/memory/')) {
      let body = {};
      try { const t = (await readBody(req, 64 * 1024)).toString('utf8'); body = t ? JSON.parse(t) : {}; } catch { return json(res, 400, { error: 'Bad JSON' }); }
      if (p === '/api/memory/before-queue') { const id = String(body.workflow || 'default'); return json(res, 200, await memory.beforeQueue(id, await memoryFor(id))); }
      if (p === '/api/memory/settings') return json(res, 200, memory.setSettings(body));
      if (p === '/api/memory/before-chat') return json(res, 200, await memory.beforeChat(String(body.model || '')));
      if (p === '/api/memory/free-for-chat') return json(res, 200, await memory.freeForChat());
    }
    // ---- the app's results: "From Comfy UI" grid + Save to Drive ----
    if (p === '/api/outputs' && req.method === 'GET') {
      const kind = url.searchParams.get('kind') || undefined;
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 120));
      const dir = await outputDirOf();
      return json(res, 200, { ...mergeOutputs([historyOutputs(history), scanAppFolder(dir, cfg.outputSubfolder)], { kind, offset, limit }), scanned: !!dir });
    }
    // Batch 8: the "Save to…" folder chooser (any folder in My Drive).
    if (p === '/api/drive/folders' && req.method === 'GET') {
      try { return json(res, 200, listDriveFolders(cfg.driveDir, url.searchParams.get('path') || '', saveDefaults())); } catch (e) { return json(res, e.status || 500, { error: e.message }); }
    }
    if (p === '/api/drive/folders' && req.method === 'POST') {
      let body;
      try { body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8')); } catch { return json(res, 400, { error: 'Bad JSON' }); }
      try { return json(res, 200, makeDriveFolder(cfg.driveDir, body.path || '', body.name)); } catch (e) { return json(res, e.status || 500, { error: e.message }); }
    }
    if (p === '/api/drive/save' && req.method === 'POST') {
      let body;
      try { body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8')); } catch { return json(res, 400, { error: 'Bad JSON' }); }
      const historyFiles = new Set(historyOutputs(history).map((f) => `${f.subfolder}/${f.filename}`));
      try { return json(res, 200, await saveToDrive(body, { driveDir: cfg.driveDir, comfyUrl: cfg.comfyUrl, outputSubfolder: cfg.outputSubfolder, historyFiles, defaults: saveDefaults() })); } catch (e) { return json(res, e.status || 500, { error: e.message }); }
    }
    if (p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 5000\n\n');
      sseClients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
      return;
    }
    if (fromComfyPage(req)) return rootProxy.web(req, res); // a ComfyUI extension's own /api route
    return json(res, 404, { error: 'Unknown API route' });
  }

  // True when the request comes from the proxied ComfyUI frontend (/comfy/...).
  function fromComfyPage(req) {
    try { return new URL(req.headers.referer).pathname.startsWith('/comfy/'); } catch { return false; }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/comfy' ) { res.writeHead(301, { Location: '/comfy/' }); return res.end(); }
      if (url.pathname.startsWith('/comfy/')) return proxy.web(req, res);
      if (url.pathname.startsWith('/ollama/')) return ollama.web(req, res);
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (url.pathname === '/share' && req.method === 'POST') return await handleShare(req, res, cfg);
      // Browsers ask for /favicon.ico regardless of <link rel=icon>; answer with the app icon.
      if (url.pathname === '/favicon.ico') req.url = '/icons/icon-192.png';
      if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(appDir, req, res)) return;
      // ComfyUI root paths used by custom-node extensions (the app has no such folders).
      if (/^\/(scripts|extensions|assets)\//.test(url.pathname)) return rootProxy.web(req, res);
      // Unknown paths in the app (e.g. "/?ref=..") fall back to index.html.
      if (req.method === 'GET' && !path.extname(url.pathname)) { req.url = '/'; if (serveStatic(appDir, req, res)) return; }
      json(res, 404, { error: 'Not found' });
    } catch (e) {
      if (!e.status || e.status >= 500) log(`${req.method} ${url.pathname} failed:`, e.stack || e.message);
      if (!res.headersSent) json(res, e.status || 500, { error: e.message });
      else res.end();
    }
  });
  // Upgraded (websocket) sockets are no longer tracked by the http server, so
  // keep them ourselves to be able to shut down cleanly.
  const upgraded = new Set();
  server.on('upgrade', (req, socket, head) => {
    upgraded.add(socket); socket.on('close', () => upgraded.delete(socket));
    if (req.url.startsWith('/comfy/')) proxy.upgrade(req, socket, head);
    else socket.destroy();
  });
  const close = server.close.bind(server);
  server.close = (cb) => {
    workflows.close();
    tagger.stop();
    filer.stop();
    for (const r of sseClients) r.end();
    for (const sock of upgraded) sock.destroy();
    server.closeAllConnections?.();
    return close(cb);
  };
  return { server, workflows, history, folders, chats, memory, hardware, cfg, presets, userPresets, builder, comfyInfo, tagger, projects, filer };
}

// Run directly: `node server/index.js` / `npm start` / start.bat
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig();
  const probe = await probeComfy(cfg);
  if (probe.ok) cfg.comfyUrl = probe.url;
  const { server, memory, tagger, filer } = createApp(cfg);
  tagger.start(); // only in the real server (tests drive tagger.tick() themselves)
  filer.start();  // batch 11: files every output on Drive (tests drive filer.tick())
  server.listen(cfg.port, cfg.host, () => {
    console.log(`Comfy UI app:       http://${cfg.host}:${cfg.port}/`);
    console.log(`ComfyUI target:     ${cfg.comfyUrl}  (${probe.ok ? 'reachable' : 'NOT reachable yet - start Comfy Desktop'})`);
    console.log(`Workflows folder:   ${cfg.workflowsDir}`);
    console.log(`Projects folder:    ${cfg.projectsDir}`);
    memory.status({ fresh: true }).then((s) => console.log(`GPU / RAM:          ${s.hardware.gpu ? `${s.hardware.gpu.name} ${s.hardware.gpu.totalMB} MiB (${s.hardware.gpu.source})` : 'no GPU detected'} / ${s.hardware.ram.totalMB} MiB RAM -> memory profile "${s.profile.id}" (${s.profile.source})`)).catch(() => {});
    console.log(`Remote access:      tailscale serve --bg ${cfg.port}`);
  });
}
