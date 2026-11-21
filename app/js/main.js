// main.js - wires the pieces together.
//
//  presets (server /api/workflows) --> PromptPanel shows matching controls
//  Generate: for i in 1..N: injectParams(preset, controls, values+seed_i)
//            --> JobQueue.submit --> ComfyClient POST /comfy/prompt
//  websocket events --> JobQueue updates items --> thumbs + viewer re-render
import { $, toast } from './ui/dom.js';
import * as api from './api.js';
import { ComfyClient } from './comfy-client.js';
import { JobQueue } from './job-queue.js';
import { injectParams } from './lib/workflow-inject.js';
import { viewUrl } from './comfy-client.js';
import { sizeFor } from './lib/aspect.js';
import { batchSeeds } from './lib/seed.js';
import { PromptPanel } from './ui/prompt-panel.js';
import { ReferenceSlots } from './ui/reference.js';
import { renderThumbs } from './ui/thumbs.js';
import { Viewer } from './ui/viewer.js';
import { HistoryView } from './ui/history-view.js';
import { setKeepAwake } from './native.js';
import { PromptVersions } from './ui/prompt-versions.js';
import { ChatPanel } from './ui/chat-panel.js';
import { prepareComfyQueue } from './ollama-client.js';
import { MemoryPanel } from './ui/memory-panel.js';
import { buildActionGraph } from './lib/actions.js';
import { clampPresetValues, applyPresetParams, formatPrompt } from './lib/presets.js';
import { detectControls } from './lib/workflow-detect.js';
import { WorkflowPicker } from './ui/workflow-picker.js';
import { resolvePresetId, remapReference, isLegacyPreset } from './lib/legacy-presets.js';
import { choosePreset, isUsable } from './lib/preset-choice.js';
import { FileInputs } from './ui/file-inputs.js';

const comfy = new ComfyClient();
const queue = new JobQueue(comfy);
const panel = new PromptPanel();
const refs = new ReferenceSlots($('#refs'), comfy);
const fileInputs = new FileInputs($('#file-inputs'), comfy);
let workflows = [];
let config = {};
let current = null;

const viewer = new Viewer({
  onFavorite: (it) => (it.historyId ? api.patchHistory(it.historyId, { favorite: it.favorite }) : Promise.reject(new Error('not saved yet'))),
  onReuse: (it) => {
    // Switch back to the preset that made it (if it still exists). Results made
    // with the retired Fast concept / From reference image presets map to the
    // Klein 4B presets (lib/legacy-presets.js; history.json is not rewritten).
    const wid = resolvePresetId(it.meta?.legacyWorkflow || it.meta?.workflow);
    if (wid && workflows.some((w) => w.id === wid)) selectPreset(wid);
    if (it.meta?.reference && typeof it.meta.reference === 'object') {
      const slots = current?.ok ? current.controls?.images || [] : [];
      // Old reference node ids (e.g. "10") point at the new preset's image slot.
      const refMap = slots.length ? remapReference(it.meta.reference, slots) : {};
      for (const [node, ref] of Object.entries(refMap)) refs.set(node, ref);
    }
    panel.reuse(it.meta || {});
    toast(`Prompt + seed ${it.meta?.seed ?? ''} loaded`);
  },
  onDiscuss: (it) => chat.discuss(it),
});
viewer.onClose = () => paintThumbs();
const historyView = new HistoryView((getItems, i) => viewer.open(getItems, i));

// ---- presets ---------------------------------------------------------------
// The picker lists the AI Workflow presets (3D / Image / Video / Audio,
// availability computed live on the server) and My presets: setups saved from
// the chat builder plus any workflow imported or dropped into workflows/.
// The old built-in "App presets" are retired; their ids still resolve (see
// lib/legacy-presets.js). Default preset: FLUX.2 Klein 4B Text to Image.
const picker = new WorkflowPicker({
  onPick: (id) => selectPreset(id),
  onRename: async (w, name) => { try { await api.renameUserPreset(w.user.id, name); toast('Renamed'); await loadWorkflows(current?.id, { fresh: false }); } catch (e) { toast(e.message, 6000); } },
  onDelete: async (w) => { try { await api.deleteUserPreset(w.user.id); toast(`Deleted "${w.label}"`); await loadWorkflows(current?.id === w.id ? undefined : current?.id); } catch (e) { toast(e.message, 6000); } },
});
const usable = isUsable;
// remember: true only when keepId is a real user choice (just imported / saved).
// Otherwise nothing is written: the remembered pick stays what the user last
// picked, and a fresh client keeps getting the default (lib/preset-choice.js).
async function loadWorkflows(keepId, { fresh = false, remember = false } = {}) {
  try { workflows = await api.getWorkflows({ fresh }); } catch (e) { toast('Could not load presets: ' + e.message); return; }
  picker.setItems(workflows);
  // Last pick (old "fast-concept" etc. map to Klein) -> else Klein 4B T2I -> else first available AI Workflow entry.
  const pick = choosePreset(workflows, { keep: keepId, saved: localStorage.getItem('preset') });
  selectPreset(pick.id, { remember: remember && pick.source === 'keep' });
}

function selectPreset(id, { remember = true } = {}) {
  current = workflows.find((w) => w.id === id) || null;
  picker.setCurrent(current);
  if (id && current && remember) localStorage.setItem('preset', id);
  panel.setWorkflow(current);
  refs.render(current?.ok && current.controls ? current.controls.images : []);
  fileInputs.render(current?.ok ? current.ai?.inputs || [] : []);
  $('#btn-generate').classList.toggle('is-unavailable', current?.availability?.status === 'unavailable');
}

// ---- GPU sharing with Ollama ---------------------------------------------------
// Before ANY ComfyUI queue (batches and workflow actions) the server applies the
// memory profile picked from the detected GPU (config/memory-profiles.json):
//   small (< 12 GB, 2080 Ti): always unload the chat model (keep_alive 0, checked
//         with /api/ps) - measured ~6.8 GB ComfyUI + ~2.9 GB gemma3:4b leaves < 0.7 GB.
//   large (16 GB+, 5080): keep it loaded unless free VRAM is below what this
//         workflow needs (workflowVramNeedMB).
async function beforeComfyQueue(workflowId) {
  const r = await prepareComfyQueue(workflowId);
  if (r?.result?.stillLoaded?.length) console.warn('Ollama models still loaded:', r.result.stillLoaded);
  if (r) console.info('memory:', r.profile, r.unload ? 'unloaded chat model' : 'kept chat model', '-', r.reason);
}

// ---- generate --------------------------------------------------------------
async function generate() {
  if (!current?.ok || !current.workflow) return toast(current?.availability?.reason || 'Pick a usable preset first', 6000);
  if (current.availability?.status === 'unavailable') return toast(`Unavailable: ${current.availability.reason}`, 8000);
  const c = current.controls;
  const v = panel.values();
  const missing = refs.missing();
  if (missing.length) return toast(c.images.length > 1 || current.ai ? `Add a picture first (${missing[0].title.replace(/#\w+/g, '').trim() || 'image'})` : 'Add a reference image first');
  const missingFile = fileInputs.missing();
  if (missingFile.length) return toast(`Pick a ${missingFile[0].kind} first`);
  if (c.prompt.length && !v.prompt.trim()) return toast('Type a prompt');
  const ai = current.ai;
  let size = c.width.length && c.height.length ? sizeFor(v.aspect, ...(ai?.size ? ai.size.base : [c.defaults.width || 1024, c.defaults.height || 1024]), ai?.size?.multiple || 16) : {};
  // AI Workflow presets: every value is clamped to the preset's range (notes say what changed).
  let params = {}, batch = v.batch;
  if (ai) {
    const r = clampPresetValues(ai, { params: v.params, width: size.width, height: size.height, batch: v.batch });
    params = r.params; batch = r.batch ?? v.batch;
    if (r.size) size = r.size;
    if (r.notes.length) toast(r.notes.join('; '), 6000);
  }
  const prompt = ai ? formatPrompt(ai, v.prompt) : v.prompt;
  const seeds = c.seed.length ? batchSeeds(batch, v.seedMode, v.seed) : Array.from({ length: batch }, () => undefined);
  const outputPrefix = config.outputSubfolder || '';
  const jobs = seeds.map((seed) => {
    const values = { ...v, prompt, seed, ...size, images: refs.values, outputPrefix, batchSize: 1 };
    let workflow = injectParams(current.workflow, c, values);
    if (ai) { workflow = applyPresetParams(ai, workflow, params); fileInputs.apply(workflow); }
    return {
      workflow,
      meta: {
        workflow: current.id, prompt: v.prompt, negative: v.negative || undefined, seed, aspect: v.aspect,
        width: size.width, height: size.height, steps: v.steps, strength: v.strength, params: ai ? params : undefined, output: ai?.output,
        reference: c.images.length ? Object.fromEntries(c.images.map((s) => [s.node, refs.values[s.node]])) : undefined,
      },
    };
  });
  await beforeComfyQueue(current.id);
  try { await queue.submit(jobs); } catch (e) { toast(e.message, 8000); }
}

// ---- chat builder: Test run of a proposed setup (never saved as a preset) ---
async function runBuilderTest({ graph, name }) {
  const c = detectControls(graph);
  const v = panel.values();
  if (c.images.length) return toast('This setup needs a picture: Save it, then pick it under My presets and add the picture there.', 8000);
  if (c.prompt.length && !v.prompt.trim()) return toast('Type a prompt in the prompt box first (the test run uses it)');
  const seed = batchSeeds(1, v.seedMode, v.seed)[0];
  // VibeVoice reads "[1] text": add the speaker tag to plain text (same rule as the VibeVoice preset).
  const vv = Object.values(graph).some((n) => n.class_type === 'VibeVoiceTTS');
  const prompt = vv ? formatPrompt({ promptFormat: { unless: '\\[\\d+\\]|Speaker \\d+:', template: '[1] {text}' } }, v.prompt) : v.prompt;
  const workflow = injectParams(graph, c, { prompt, negative: v.negative, seed, outputPrefix: '', batchSize: 1 });
  await beforeComfyQueue('builder:test');
  try { await queue.submit([{ workflow, meta: { workflow: 'builder:test', prompt: `Test run · ${name} · ${v.prompt}`.slice(0, 400), seed } }]); toast('Test run queued (not saved as a preset)'); } catch (e) { toast(e.message, 8000); }
}

// ---- workflow actions (from the chat's confirm chip) -------------------------
/** LoadImage value for an image ComfyUI already has: inputs by name, outputs
 *  with the "[output]" annotation LoadImage understands (no re-upload needed). */
function loadImageName(img) {
  const rel = img.subfolder ? `${img.subfolder}/${img.filename}` : img.filename;
  return img.type === 'input' ? rel : `${rel} [${img.type || 'output'}]`;
}
async function runAction(r) {
  const img = r.image;
  let input = loadImageName(img);
  if (img.type === 'temp') {
    // temp files may vanish: copy the bytes into ComfyUI's input/ first.
    const blob = await (await fetch(viewUrl(img))).blob();
    input = (await comfy.uploadImage(new File([blob], img.filename, { type: blob.type }))).ref;
  }
  const workflow = buildActionGraph(r.action, r.params, input, config.outputSubfolder || '');
  const meta = {
    workflow: 'action:' + r.action.id, action: r.action.id, params: r.params,
    prompt: `${r.action.manifest.verb} · ${img.prompt || img.filename}`, seed: img.seed,
    parent: { historyId: img.historyId, image: { filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output' } },
  };
  await beforeComfyQueue('action:' + r.action.id);
  try { await queue.submit([{ workflow, meta }]); toast(`${r.action.manifest.name} queued`); } catch (e) { toast(e.message, 8000); }
}
$('#btn-generate').addEventListener('click', generate);
$('#prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) generate(); });
$('#btn-cancel').addEventListener('click', async () => { await queue.cancelAll(); toast('Queue cleared'); });
$('#btn-clear').addEventListener('click', () => queue.clearFinished());

// ---- thumbnails ------------------------------------------------------------
function paintThumbs() {
  renderThumbs($('#thumbs'), queue.items, (it) => {
    if (!it.image && it.files?.length) { downloadFile(it.files[0]); return; }
    if (!it.image) { if (it.error) toast(it.error, 8000); return; }
    const done = queue.items.filter((x) => x.image);
    viewer.open(() => queue.items, done.indexOf(it));
  });
  const active = queue.active.length;
  setKeepAwake(active > 0); // Android app: screen stays on while a batch runs
  $('#btn-cancel').hidden = !active;
  $('#run-label').textContent = active ? `Run (+${active} running)` : 'Run';
  $('#results-count').textContent = queue.items.length ? `${queue.items.filter((i) => i.image).length} / ${queue.items.length}` : '';
  $('#results').classList.toggle('empty', !queue.items.length);
}
let raf = 0;
queue.addEventListener('change', () => {
  // Progress events arrive many times a second; repaint once per frame.
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => { paintThumbs(); viewer.refresh(); });
});

// A non-image result (3D .glb, video, audio): download it (the Android app's
// download handler puts it in Download/Comfy UI). No 3D viewer: that would
// need a WebGL library, and the app has no dependencies.
function downloadFile(f) {
  const a = document.createElement('a');
  a.href = viewUrl(f); a.download = f.filename; document.body.append(a); a.click(); a.remove();
}

// ---- prompt versions + Prompt assistant (Ollama chat) -----------------------
const versions = new PromptVersions(panel, $('#prompt-tools'));
const chat = new ChatPanel($('#chat-mount'), {
  versions,
  getContext: () => {
    const c = current?.ok ? current.controls : null;
    const v = panel.values();
    return { prompt: v.prompt, negative: v.negative || '', negativeOn: !!(c?.negative.length && panel.state.negOn), hasNegative: !!c?.negative.length, preset: current?.label, workflow: current };
  },
  onGenerate: ({ seed } = {}) => { panel.setSeed(seed); return generate(); },
  onRunAction: (r) => runAction(r),
  onTestRun: (r) => runBuilderTest(r),
  onSavedPreset: (id) => loadWorkflows(id, { remember: true }).then(() => toast('Saved under My presets in the picker')),
});
const memory = new MemoryPanel($('#memory-mount'), { onChange: () => chat.refresh() });
$('details.menu').addEventListener('toggle', (e) => { if (e.target.open) { memory.refresh(true); paintBuilderModel(); } });

// Setup builder model (server: data/builder.json). gemma3:4b now; a 12-14B model after the GPU upgrade.
async function paintBuilderModel() {
  const sel = $('#builder-model'), note = $('#builder-model-note');
  try {
    const [cfgB, tags] = await Promise.all([api.getBuilderConfig(), fetch('/ollama/api/tags').then((r) => r.json()).catch(() => ({ models: [] }))]);
    const names = [...new Set([cfgB.model, ...(tags.models || []).map((m) => m.name)])];
    sel.replaceChildren(...names.map((n) => new Option(n, n)));
    sel.value = cfgB.model;
    note.textContent = `Recommended after the 16 GB GPU: ${cfgB.recommended.model} (or ${cfgB.recommended.alt}).`;
  } catch (e) { note.textContent = 'Builder settings unavailable: ' + e.message; }
}
$('#builder-model').addEventListener('change', async (e) => { try { await api.setBuilderModel(e.target.value); toast(`Setup builder uses ${e.target.value}`); } catch (err) { toast(err.message, 6000); } });

// ---- menu: history, advanced (real ComfyUI), import -------------------------
$('#btn-history').addEventListener('click', () => historyView.open());
$('#btn-advanced').addEventListener('click', () => {
  // Same tab, so it works inside the installed PWA too. Come back with the
  // browser/Android back button; presets reload when the app is shown again.
  location.href = '/comfy/';
});
$('#btn-import').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try { const r = await api.importWorkflow(f); toast(`Imported "${r.file}"`); await loadWorkflows(r.id, { remember: true }); } catch (err) { toast(err.message, 8000); }
});

// ---- connection banner -------------------------------------------------------
function banner(text) { const b = $('#banner'); b.textContent = text || ''; b.hidden = !text; }
comfy.addEventListener('connection', (e) => banner(e.detail.connected ? '' : 'Not connected to ComfyUI - retrying…'));

// ---- arriving from the Android share sheet (/share redirects here) --------
async function handleLaunchParams() {
  const q = new URLSearchParams(location.search);
  if (![...q.keys()].length) return;
  if (q.get('shareError')) toast('Share failed: ' + q.get('shareError'), 8000);
  if (q.get('text') && !q.get('ref')) panel.setPrompt(q.get('text'));
  const ref = q.get('ref');
  if (ref) {
    // Auto-switch to a preset with a reference slot: FLUX.2 Klein 4B Image Edit
    // (it replaced "From reference image"), else any usable preset with one.
    const editId = resolvePresetId('from-reference-image');
    const hasSlot = (w) => usable(w) && w.controls?.images?.length;
    const target = workflows.find((w) => w.id === editId && hasSlot(w)) || workflows.find((w) => hasSlot(w) && !w.user) || workflows.find(hasSlot);
    if (target) {
      if (current?.id !== target.id) selectPreset(target.id);
      refs.set(target.controls.images[0].node, ref);
      toast('Reference image ready');
    } else toast('No preset with a reference image slot');
  }
  history.replaceState(null, '', '/'); // clean URL so a reload doesn't re-apply
}

// ---- start ---------------------------------------------------------------
async function start() {
  try { config = await api.getConfig(); if (!config.comfyReachable) banner(`ComfyUI not reachable at ${config.comfyUrl} - is Comfy Desktop running?`); } catch { banner('App server not reachable'); }
  await loadWorkflows();
  await handleLaunchParams();
  comfy.connect();
  paintThumbs();
  // The server watches workflows/ and pushes an event when it changes.
  try { new EventSource('/api/events').addEventListener('workflows', () => loadWorkflows(current?.id)); } catch {}
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadWorkflows(current?.id); queue.resync(); } });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}
start();
// For tests and poking around from DevTools.
window.conceptApp = { isLegacyPreset, choosePreset, comfy, queue, panel, refs, fileInputs, viewer, chat, versions, memory, picker, selectPreset, loadWorkflows, get workflows() { return workflows; }, get current() { return current; } };
