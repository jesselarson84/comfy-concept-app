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
import { ModelThumbs } from './ui/model-thumbs.js';
import { Viewer } from './ui/viewer.js';
import { HistoryView } from './ui/history-view.js';
import { setKeepAwake, setRunStatus } from './native.js';
import { PromptVersions } from './ui/prompt-versions.js';
import { ChatPanel } from './ui/chat-panel.js';
import { prepareComfyQueue } from './ollama-client.js';
import { buildActionGraph } from './lib/actions.js';
import { clampPresetValues, applyPresetParams, formatPrompt, dropEmptyOptional } from './lib/presets.js';
import { detectControls } from './lib/workflow-detect.js';
import { WorkflowPicker } from './ui/workflow-picker.js';
import { resolvePresetId, remapReference, isLegacyPreset } from './lib/legacy-presets.js';
import { choosePreset, isUsable, isAiWorkflow } from './lib/preset-choice.js';
import { FileInputs } from './ui/file-inputs.js';
import { MaskSlot } from './ui/mask-editor.js';
import { fileKind } from './lib/outputs.js';
import { ModelViewer } from './ui/model-viewer.js';
import { AudioPlayer } from './ui/audio-player.js';
import { FileSheet } from './ui/file-sheet.js';
import { VideoPlayer } from './ui/video-player.js';
import { OutputPicker } from './ui/output-picker.js';
import { PresetChooser } from './ui/preset-chooser.js';
import { afterBack } from './ui/overlay.js';
import { RunLock, runProgress } from './lib/run-lock.js';
import { lockControls } from './ui/form-lock.js';
import { ConnectionBanner } from './lib/conn-banner.js';
import { textEncoderOnCpu, tiledVaeDecode, hasVaeDecode, wantTiledDecode, isOom } from './lib/memory-options.js';

const comfy = new ComfyClient();
const queue = new JobQueue(comfy);
const panel = new PromptPanel();
const refs = new ReferenceSlots($('#refs'), comfy);
const fileInputs = new FileInputs($('#file-inputs'), comfy);
// Inpaint presets (manifest.mask): the painted mask for the picture in mask.image.
const maskSlot = new MaskSlot($('#mask-slot'), comfy);
const paintMask = () => { const m = current?.ok ? current.ai?.mask || null : null; maskSlot.render(m, m ? refs.values[m.image] : null); };
refs.onChange = paintMask;
{ const set = refs.set.bind(refs); refs.set = (node, ref) => { set(node, ref); paintMask(); }; }
let workflows = [];
let config = {};
let current = null;
// One run at a time (lib/run-lock.js): Run stays disabled until the run's jobs
// are all finished or cancelled; Cancel stays active; no preset switching.
const lock = new RunLock();
const isLocked = () => lock.locked() || queue.active.length > 0;
const busy = () => { toast('Running'); };

const viewer = new Viewer({
  onFavorite: (it) => (it.historyId ? api.patchHistory(it.historyId, { favorite: it.favorite }) : Promise.reject(new Error('not saved yet'))),
  onReuse: (it) => {
    if (isLocked()) return busy(); // Reuse rewrites the form: wait for the run to end
    // Switch back to the preset that made it (if it still exists). Results made
    // with the retired Fast concept / From reference image presets map to the
    // Klein 4B presets (lib/legacy-presets.js; history.json is not rewritten).
    const wid = resolvePresetId(it.meta?.legacyWorkflow || it.meta?.workflow);
    if (wid && wid !== current?.id && workflows.some((w) => w.id === wid)) { if (isLocked()) return busy(); selectPreset(wid); }
    if (it.meta?.reference && typeof it.meta.reference === 'object') {
      const slots = current?.ok ? current.controls?.images || [] : [];
      // Old reference node ids (e.g. "10") point at the new preset's image slot.
      const refMap = slots.length ? remapReference(it.meta.reference, slots) : {};
      for (const [node, ref] of Object.entries(refMap)) refs.set(node, ref);
    }
    if (typeof it.meta?.mask === 'string' && current?.ai?.mask) { maskSlot.value = it.meta.mask; paintMask(); }
    panel.reuse(it.meta || {});
    toast(`Prompt + seed ${it.meta?.seed ?? ''} loaded`);
  },
  onDiscuss: (it) => chat.discuss(it),
  onUseAsReference: (it) => useAsReference(it.image),
  onSaveToDrive: (it) => saveToDrive(it.image, 'image'),
});
viewer.onClose = () => paintThumbs();
// 3D tiles: preview stills rendered once (one shared offscreen renderer, lazy) and cached on this device.
const modelThumbs = new ModelThumbs();
const historyView = new HistoryView((getItems, i) => viewer.open(getItems, i), (f, meta) => openFile(f, meta), { modelThumbs });

// ---- non-image results: 3D viewer, audio player, file sheet ------------------
const fileHooks = { onDownload: (f) => downloadFile(f), onSaveToDrive: (f) => saveToDrive(f, fileKind(f)) };
const modelViewer = new ModelViewer(fileHooks);
const audioPlayer = new AudioPlayer(fileHooks);
const videoPlayer = new VideoPlayer(fileHooks);
const fileSheet = new FileSheet(fileHooks);
/** Tap on a 3D / audio / video result (session strip or History). */
function openFile(f, meta = {}) {
  const k = fileKind(f);
  if (k === '3d' && /\.(glb|gltf)$/i.test(f.filename || '')) return modelViewer.open(f, meta);
  if (k === 'audio') return audioPlayer.open(f, meta);
  if (k === 'video' && /\.(mp4|webm|mov|mkv)$/i.test(f.filename || '')) return videoPlayer.open(f, meta);
  return fileSheet.open(f, meta);
}

// ---- Save to Drive (server copies the file into Q:\My Drive\Comfy UI\<kind>\) ----
async function saveToDrive(f, kind) {
  try {
    const r = await api.saveToDrive(f, kind);
    toast(`Saved to Drive: Comfy UI/${r.folder}/${r.name}`, 5000);
    return r;
  } catch (e) { toast(e.message, 8000); return null; }
}

// ---- reference pictures from ComfyUI results ---------------------------------
// "From Comfy UI" (reference slot button): this session's pictures + earlier ones.
const outputPicker = new OutputPicker();
const sessionImages = () => queue.items.filter((i) => i.image).flatMap((i) => [i.image, ...(i.extraImages || [])]).reverse();
refs.onPickFromComfy = (node) => outputPicker.open({ session: sessionImages, onPick: (img) => refs.useImage(node, img) });
// "Use as reference" (image viewer): into the current preset's slot, or pick
// one of the presets that take a picture (3D and Image Edit) first.
const presetChooser = new PresetChooser();
const takesPicture = (w) => isUsable(w) && !!w.controls?.images?.length;
const referencePresets = () => workflows.filter((w) => takesPicture(w) && isAiWorkflow(w) && (w.group === '3D' || (w.group === 'Image' && /edit/i.test(w.label))));
async function useAsReference(img) {
  if (!img) return;
  if (isLocked()) { busy(); return null; } // the reference slots are locked during a run
  if (!viewer.root.hidden) { viewer.close(); await afterBack(); }
  const load = async () => { const ref = await refs.useImage(refs.targetNode(), img); if (ref) toast('Reference image ready'); return ref; };
  if (current && takesPicture(current)) return load();
  const list = referencePresets();
  if (!list.length) { toast('No preset with a reference image slot'); return null; }
  presetChooser.open(list, async (w) => { if (isLocked()) return busy(); selectPreset(w.id); await afterBack(); await load(); });
  return null;
}

// ---- presets ---------------------------------------------------------------
// The picker lists the AI Workflow presets (3D / Image / Video / Audio,
// availability computed live on the server) and My presets: setups saved from
// the chat builder plus any workflow imported or dropped into workflows/.
// The old built-in "App presets" are retired; their ids still resolve (see
// lib/legacy-presets.js). Default preset: FLUX.2 Klein 4B Text to Image.
const picker = new WorkflowPicker({
  onPick: (id) => (isLocked() ? busy() : selectPreset(id)),
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
  // Optional slots (Wan start frame, Chatterbox voice sample) can stay empty.
  const optional = new Set((current?.ok ? current.ai?.optional || [] : []).map((o) => o.node));
  refs.render(current?.ok && current.controls ? current.controls.images.map((s) => (optional.has(s.node) ? { ...s, optional: true } : s)) : []);
  fileInputs.render(current?.ok ? current.ai?.inputs || [] : []);
  paintMask();
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
  if (isLocked()) return busy();
  if (!current?.ok || !current.workflow) return toast(current?.availability?.reason || 'Pick a usable preset first', 6000);
  if (current.availability?.status === 'unavailable') return toast(`Unavailable: ${current.availability.reason}`, 8000);
  const c = current.controls;
  const v = panel.values();
  const missing = refs.missing();
  if (missing.length) return toast(c.images.length > 1 || current.ai ? `Add a picture first (${missing[0].title.replace(/#\w+/g, '').trim() || 'image'})` : 'Add a reference image first');
  const missingFile = fileInputs.missing();
  if (missingFile.length) return toast(`Pick a ${missingFile[0].kind} first`);
  if (maskSlot.missing()) return toast('Paint a mask first');
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
    if (ai) {
      workflow = applyPresetParams(ai, workflow, params); fileInputs.apply(workflow); maskSlot.apply(workflow);
      dropEmptyOptional(ai, workflow, new Set([...Object.keys(refs.values).filter((n) => refs.values[n]), ...fileInputs.filled()]));
    }
    return {
      workflow,
      meta: {
        workflow: current.id, prompt: v.prompt, negative: v.negative || undefined, seed, aspect: v.aspect,
        width: size.width, height: size.height, steps: v.steps, strength: v.strength, params: ai ? params : undefined, output: ai?.output,
        reference: c.images.length ? Object.fromEntries(c.images.map((s) => [s.node, refs.values[s.node]])) : undefined,
        mask: maskSlot.value || undefined,
      },
    };
  });
  await startRun(current.id, jobs);
}

// ---- memory options (lib/memory-options.js) ------------------------------------
let memSettings = { textEncoderCpu: false, ollamaCpu: false };
const OOM_STORE = 'conceptOom.v1'; // { workflowId: time } presets that ran out of memory (12 h)
const oomMap = () => { try { return JSON.parse(localStorage.getItem(OOM_STORE)) || {}; } catch { return {}; } };
const oomBefore = (id) => Date.now() - (oomMap()[id] || 0) < 12 * 3600e3;
/** CPU text encoder (menu switch) and the tiled VAE decode fallback (> ~2 MP or after an OOM). */
function withMemoryOptions(workflowId, jobs) {
  return jobs.map((j) => {
    let workflow = j.workflow;
    if (memSettings.textEncoderCpu) workflow = textEncoderOnCpu(workflow);
    const t = wantTiledDecode({ width: j.meta?.width, height: j.meta?.height, oomBefore: oomBefore(workflowId) });
    if (t.tiled && hasVaeDecode(workflow)) { workflow = tiledVaeDecode(workflow); j = { ...j, meta: { ...j.meta, tiledVae: t.reason } }; }
    return { ...j, workflow };
  });
}
queue.addEventListener('change', (e) => {
  const it = e.detail;
  if (it?.status === 'error' && isOom(it.error) && it.meta?.workflow && !it.oomNoted) {
    it.oomNoted = true;
    const m = oomMap(); m[it.meta.workflow] = Date.now(); localStorage.setItem(OOM_STORE, JSON.stringify(m));
    toast('Out of memory: the next run decodes in tiles', 6000);
  }
});
async function paintMemorySettings() {
  try { memSettings = await api.getMemorySettings(); } catch { return; }
  $('#mem-te-cpu').checked = memSettings.textEncoderCpu;
  $('#mem-ollama-cpu').checked = memSettings.ollamaCpu;
}
for (const [sel, key] of [['#mem-te-cpu', 'textEncoderCpu'], ['#mem-ollama-cpu', 'ollamaCpu']]) {
  $(sel).addEventListener('change', async (e) => {
    try { memSettings = await api.setMemorySettings({ [key]: e.target.checked }); } catch (err) { e.target.checked = !e.target.checked; toast(err.message, 6000); }
  });
}

/** Lock, free memory, queue the run's jobs; the lock lifts when they all end. */
async function startRun(workflowId, jobs) {
  if (!lock.begin()) { busy(); return []; }
  paintThumbs();
  let run = [];
  try {
    await beforeComfyQueue(workflowId);
    if (lock.abort) { lock.started([]); return []; }
    const p = queue.submit(withMemoryOptions(workflowId, jobs));
    run = queue.lastRun; // submit() adds the run's items before its first await
    lock.started(run);
    await p;
  } catch (e) { toast(e.message, 8000); } finally { if (lock.starting) lock.started([]); paintThumbs(); }
  return run;
}

// ---- chat builder: Test run of a proposed setup (never saved as a preset) ---
async function runBuilderTest({ graph, name }) {
  if (isLocked()) return busy();
  const c = detectControls(graph);
  const v = panel.values();
  if (c.images.length) return toast('This setup needs a picture: Save it, then pick it under My presets and add the picture there.', 8000);
  if (c.prompt.length && !v.prompt.trim()) return toast('Type a prompt first');
  const seed = batchSeeds(1, v.seedMode, v.seed)[0];
  // VibeVoice reads "[1] text": add the speaker tag to plain text (same rule as the VibeVoice preset).
  const vv = Object.values(graph).some((n) => n.class_type === 'VibeVoiceTTS');
  const prompt = vv ? formatPrompt({ promptFormat: { unless: '\\[\\d+\\]|Speaker \\d+:', template: '[1] {text}' } }, v.prompt) : v.prompt;
  const workflow = injectParams(graph, c, { prompt, negative: v.negative, seed, outputPrefix: '', batchSize: 1 });
  const run = await startRun('builder:test', [{ workflow, meta: { workflow: 'builder:test', prompt: `Test run · ${name} · ${v.prompt}`.slice(0, 400), seed } }]);
  if (run.length) toast('Test run queued');
}

// ---- workflow actions (from the chat's confirm chip) -------------------------
/** LoadImage value for an image ComfyUI already has: inputs by name, outputs
 *  with the "[output]" annotation LoadImage understands (no re-upload needed). */
function loadImageName(img) {
  const rel = img.subfolder ? `${img.subfolder}/${img.filename}` : img.filename;
  return img.type === 'input' ? rel : `${rel} [${img.type || 'output'}]`;
}
async function runAction(r) {
  if (isLocked()) return busy();
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
  const run = await startRun('action:' + r.action.id, [{ workflow, meta }]);
  if (run.length) toast(`${r.action.manifest.name} queued`);
}
$('#btn-generate').addEventListener('click', generate);
$('#prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) generate(); });
$('#btn-cancel').addEventListener('click', async () => { lock.cancel(); await queue.cancelAll(); paintThumbs(); toast('Queue cleared'); });
$('#btn-clear').addEventListener('click', () => queue.clearFinished());

// ---- thumbnails ------------------------------------------------------------
function paintThumbs() {
  renderThumbs($('#thumbs'), queue.items, (it) => {
    if (!it.image && it.files?.length) { openFile(it.files[0], it.meta); return; }
    if (!it.image) { if (it.error) toast(it.error, 8000); return; }
    const done = queue.items.filter((x) => x.image);
    viewer.open(() => queue.items, done.indexOf(it));
  }, modelThumbs);
  const locked = isLocked();
  setKeepAwake(locked); // Android app: screen stays on while a run is going
  $('#btn-cancel').hidden = !locked;
  const run = $('#btn-generate');
  run.disabled = locked;
  run.classList.toggle('is-running', locked);
  $('#preset-btn').disabled = locked;
  // The whole form is read-only during a run (ui/form-lock.js); the menu still
  // opens but its switches and Import wait too (Import could switch the preset).
  lockControls([$('#panel'), $('.menu-pop')], locked);
  const pr = runProgress(lock.run.length ? lock.run : queue.active);
  $('#run-label').textContent = locked && pr.total ? `Running ${pr.current} of ${pr.total}` : 'Run';
  // Android: foreground service with "Running N of M"; vibrates when the run ends.
  setRunStatus({ current: pr.current, total: pr.total, running: locked && pr.total > 0, done: pr.done });
  $('#results-count').textContent = queue.items.length ? `${queue.items.filter((i) => i.image).length} / ${queue.items.length}` : '';
  $('#results').classList.toggle('empty', !queue.items.length);
}
let raf = 0;
queue.addEventListener('change', () => {
  // Progress events arrive many times a second; repaint once per frame.
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => { paintThumbs(); viewer.refresh(); });
});

// Download a non-image result (the Download button in the 3D viewer, audio
// player and file sheet; the Android app's download handler puts it in
// Download/Comfy UI).
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
  onSavedPreset: (id) => loadWorkflows(id, { remember: true }).then(() => toast('Saved under My presets')),
});
// The memory profile is always Auto (picked on the server from the detected
// VRAM); the menu has no GPU & memory section.
$('details.menu').addEventListener('toggle', (e) => { if (e.target.open) { paintBuilderModel(); paintMemorySettings(); } });

// Setup builder model (server: data/builder.json): a plain picker of the models Ollama has.
async function paintBuilderModel() {
  const sel = $('#builder-model');
  try {
    const [cfgB, tags] = await Promise.all([api.getBuilderConfig(), fetch('/ollama/api/tags').then((r) => r.json()).catch(() => ({ models: [] }))]);
    const names = [...new Set([cfgB.model, ...(tags.models || []).map((m) => m.name)])];
    sel.replaceChildren(...names.map((n) => new Option(n, n)));
    sel.value = cfgB.model;
  } catch (e) { toast('Builder settings unavailable: ' + e.message, 6000); }
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
// Shown only when the socket has been down for 4 s (lib/conn-banner.js), so a
// normal reconnect after switching apps never flashes it.
const connBanner = new ConnectionBanner({ show: () => banner('Not connected to ComfyUI - retrying…'), hide: () => banner('') });
comfy.addEventListener('connection', (e) => {
  if (e.detail.connected) { banner(''); connBanner.connected(); } else connBanner.disconnected();
});

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

// ---- back from the background: reconnect at once, then catch up -------------
// Called on visibilitychange (visible), focus, pageshow, online and by the
// Android app's onResume. Several of these fire together, so one resume per
// second. After more than 10 s hidden the socket is replaced even if it still
// says "open": Android often leaves a dead socket that only notices later.
let hiddenAt = 0, lastResume = 0, started = false;
document.addEventListener('visibilitychange', () => { if (document.hidden) hiddenAt = Date.now(); });
function resume() {
  if (!started || document.hidden) return; // start() opens the first socket itself
  const now = Date.now();
  if (now >= lastResume && now - lastResume < 1000) return; // (clock going back: never stuck)
  lastResume = now;
  const longAway = hiddenAt && now - hiddenAt > 10000;
  hiddenAt = 0;
  connBanner.resume();
  comfy.reconnectNow({ force: longAway });
  queue.resync().then(() => paintThumbs());
}

// ---- start ---------------------------------------------------------------
async function start() {
  try { config = await api.getConfig(); if (!config.comfyReachable) banner(`ComfyUI not reachable at ${config.comfyUrl}`); } catch { banner('App server not reachable'); }
  await loadWorkflows();
  paintMemorySettings();
  await handleLaunchParams();
  // Jobs still active when the page was dropped (Android background): back in
  // the strip and locked, results caught up from /history.
  const back = queue.restore();
  if (back.length) lock.started(back);
  comfy.connect();
  started = true;
  paintThumbs();
  if (back.length) queue.resync();
  // The server watches workflows/ and pushes an event when it changes.
  try { new EventSource('/api/events').addEventListener('workflows', () => loadWorkflows(current?.id)); } catch {}
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { resume(); loadWorkflows(current?.id); } });
  window.addEventListener('pageshow', (e) => { if (e.persisted) resume(); });
  window.addEventListener('focus', resume);
  window.addEventListener('online', resume);
  // Restored jobs belong to the old page's websocket client: poll /history for them.
  setInterval(() => { if (!document.hidden && queue.active.some((i) => i.restored)) queue.resync(); }, 4000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}
start();
// For tests and poking around from DevTools.
window.conceptApp = { maskSlot, modelThumbs, historyView, isLegacyPreset, choosePreset, comfy, queue, panel, refs, fileInputs, viewer, chat, versions, picker, selectPreset, loadWorkflows,
  lock, resume, connBanner, modelViewer, audioPlayer, videoPlayer, fileSheet, outputPicker, presetChooser, openFile, useAsReference, saveToDrive, referencePresets, get workflows() { return workflows; }, get current() { return current; } };
