// main.js - wires the pieces together.
//
//  presets (server /api/workflows) --> PromptPanel shows matching controls
//  Generate: for i in 1..N: injectParams(preset, controls, values+seed_i)
//            --> JobQueue.submit --> ComfyClient POST /comfy/prompt
//  websocket events --> JobQueue updates items --> thumbs + viewer re-render
import { $, h, toast } from './ui/dom.js';
import * as api from './api.js';
import { ComfyClient } from './comfy-client.js';
import { JobQueue } from './job-queue.js';
import { injectParams } from './lib/workflow-inject.js';
import { viewUrl, inputViewUrl } from './comfy-client.js';
import { sizeFor } from './lib/aspect.js';
import { batchSeeds } from './lib/seed.js';
import { PromptPanel } from './ui/prompt-panel.js';
import { ReferenceSlots } from './ui/reference.js';
import { renderThumbs } from './ui/thumbs.js';
import { ModelThumbs } from './ui/model-thumbs.js';
import { Viewer } from './ui/viewer.js';
import { HistoryView } from './ui/history-view.js';
import { setKeepAwake, setRunStatus, bridge as nativeBridge, has as hasNative, absoluteUrl } from './native.js';
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
import { ImportSheet, presetsFor } from './ui/import-sheet.js';
import { afterBack } from './ui/overlay.js';
import { DriveFolderSheet, rememberFolder, PHONE } from './ui/drive-folder.js';
import { RunLock, runProgress } from './lib/run-lock.js';
import { lockControls } from './ui/form-lock.js';
import { ConnectionBanner } from './lib/conn-banner.js';
import { infoFor } from './lib/setting-info.js';
import { NodeView } from './ui/node-view.js';
import { SavePresetSheet } from './ui/save-preset.js';
import { textEncoderOnCpu, tiledVaeDecode, hasVaeDecode, wantTiledDecode, isOom } from './lib/memory-options.js';
import { withUpscale, pickUpscaleModel, RESOLUTIONS } from './lib/resolution.js';
import { ProjectChip, ProjectSheet, loadProjects, projectLabel, getCurrentProject } from './ui/projects.js';
import { PcCard } from './ui/pc-card.js';
import { BatchSheet, rowsOf } from './ui/batch-sheet.js';
import { ClaudeBox, AskSheet, VariationsSheet, downscale, wantsVariations, claudeLogo } from './ui/claude.js';
import { SettingsSheet } from './ui/settings-sheet.js';
import { aspectLabel } from './lib/aspect.js';

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
// Batch 11: the project chip (top of the form) and "Move to project".
const projectChip = new ProjectChip($('#project-row'));
const projectSheet = new ProjectSheet();
/** Move History entries (and what was made from them) to a project picked in the sheet. */
async function moveToProject(ids) {
  if (!ids.length) return false;
  const to = await projectSheet.pick({ title: `Move ${ids.length} ${ids.length === 1 ? 'item' : 'items'} to…`, move: true });
  if (to === undefined) return false;
  try {
    const r = await api.moveToProject(ids, to);
    await loadProjects().catch(() => {});
    const extra = r.ids.length - ids.length;
    toast(`Moved to ${projectLabel(to)}${extra > 0 ? ` (+${extra} made from them)` : ''}`);
    projectChip.paint();
    return true;
  } catch (e) { toast(e.message, 6000); return false; }
}
// "Use as reference": which History entry a reference picture came from, so what
// is made from it lands in the same project (sent as meta.source).
const refSources = new Map(); // ref value ("subfolder/name.png") -> history id
// Node view (canvas button): ComfyUI's graph in an iframe under the top bar,
// kept alive between toggles. Batch 5: the workflow dropdown is hidden while it
// is shown, it opens the selected preset's graph, and it switches straight
// over to / from History (one or the other, never both).
const nodeView = new NodeView({
  button: $('#btn-canvas'), host: $('#node-view'),
  graph: () => (current?.ok && current.workflow ? { id: current.id, label: current.label, workflow: current.workflow } : null),
  beforeShow: async () => { if (historyView.on) await leaveHistory(); },
  onChange: () => { picker.close(); paintThumbs(); },
});
// Save as preset (node view): the canvas graph into a picker section.
const savePreset = new SavePresetSheet({
  getGraph: () => nodeView.currentGraph(),
  target: () => current,
  save: async ({ mode, id, name, group, subgroup, workflow }) => {
    const g = mode === 'update'
      ? await api.updateGraphPreset(id, { name, group, subgroup, workflow })
      : await api.saveGraphPreset({ name, group, subgroup, workflow, from: current?.id });
    // The canvas already shows this graph: no reload there; the form switches to the saved preset.
    nodeView.loadedId = g.id;
    await loadWorkflows(g.id, { remember: true });
    return g;
  },
});
$('#btn-save-graph').addEventListener('click', () => { if (isLocked()) return busy(); savePreset.open(); });
/** Close History without leaving a stale Back entry, so the node view can take its place. */
async function leaveHistory() {
  if (historyView.selecting) { historyView.endSelect(); await afterBack(); }
  // Inside a folder: drop its Back entry too, so the node view takes over History's own.
  if (history.state?.historySub) { history.back(); await afterBack(); }
  historyView.close(true);
}

const viewer = new Viewer({
  onFavorite: (it) => (it.historyId ? api.patchHistory(it.historyId, { favorite: it.favorite }) : Promise.reject(new Error('not saved yet'))),
  onReuse: (it) => {
    if (isLocked()) return busy(); // Reuse rewrites the form: wait for the run to end
    // Batch 12: a job made in desktop ComfyUI: open its own workflow (kept by the server).
    if (String(it.meta?.workflow || '').startsWith('desktop:') && it.meta?.promptId) return openPcJob(it.meta.promptId, { follow: false });
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
  onUseAsReference: (it) => useAsReference(it.image, it.historyId),
  onMove: async (it) => { const ok = await moveToProject([it.historyId]); if (ok) historyDirty = true; return ok; },
  // Batch 10: one Save - the Drive folder sheet, with "Save to this phone instead".
  onSave: (it) => saveToDrive(it.image, 'image', { phone: () => viewer.save() }),
  labelOf: (id) => labelOf(id),
  // Batch 9: a tag under the picture -> History searched for it.
  // Batch 16: ⋮ Ask Claude about this (only while Use Claude is on).
  onAskClaude: (it) => openAsk('fix', [{ image: it.image, historyId: it.historyId, meta: it.meta || {} }]),
  claudeOn: () => claudeOn(),
  onTag: (tag) => { if (!historyView.on) $('#btn-history').click(); historyView.searchTag(tag); },
  // Trash in the viewer: this one picture, from the PC (History entries hold one picture each).
  onDelete: async (it) => {
    const r = await api.deleteHistory([it.historyId]);
    if (r.refused.length) { toast(`Not deleted: ${r.refused[0].reason}`, 8000); return false; }
    for (const q of queue.items) if (q.historyId === it.historyId) q.deleted = true;
    toast('Deleted');
    historyDirty = true;
    return true;
  },
});
let historyDirty = false;
viewer.onClose = () => { paintThumbs(); if (historyDirty && historyView.on) historyView.load(); historyDirty = false; };
// 3D tiles: preview stills rendered once (one shared offscreen renderer, lazy) and cached on this device.
const modelThumbs = new ModelThumbs();
// History (batch 5): a top bar toggle like the node view; the top bar stays put.
const historyView = new HistoryView((getItems, i) => viewer.open(getItems, i), (f, meta) => openFile(f, meta), {
  modelThumbs, host: $('#history-host'), button: $('#btn-history'),
  onChange: () => { picker.close(); paintThumbs(); },
  // Batch 9: model names for History search / filters / stats (old ids map to today's presets).
  labelOf: (id) => labelOf(id),
  // Batch 11: selection bar "Move to project".
  onMove: (ids) => moveToProject(ids),
  // Batch 16: the selection bar's Claude button (pictures numbered in tap order).
  onAskClaude: (entries) => openAsk('files', entries.map((e) => ({ image: e.images[0], historyId: e.id, meta: { prompt: e.prompt, seed: e.seed, workflow: e.workflow, width: e.width, height: e.height, steps: e.steps } }))),
  claudeOn: () => claudeOn(),
});
$('#btn-history').addEventListener('click', () => {
  if (historyView.on) return historyView.close();
  // Switching over from the node view: take over its Back entry instead of stacking a new one.
  const replace = nodeView.on;
  if (replace) nodeView.hide(true);
  historyView.open({ replace });
});

// ---- non-image results: 3D viewer, audio player, file sheet ------------------
/** Model name for a preset id (old ids map to today's presets). */
function labelOf(id) { const w = workflows.find((x) => x.id === resolvePresetId(id)) || workflows.find((x) => x.id === id); if (w) return w.short || w.label; const s = String(id || ''); return s.startsWith('desktop:') ? `PC · ${s.slice(8)}` : s.replace(/^(ai|user|graph):/, ''); }
// Batch 10: the 3D / video / audio / file viewers' ⋮ menu: Save… (Drive or this phone) and Share.
const fileHooks = { onSave: (f) => saveToDrive(f, fileKind(f), { phone: () => downloadFile(f) }), onShare: (f) => shareFile(f) };
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

// ---- batch 12: desktop ComfyUI on the phone, and batches ---------------------
/**
 * Open a PC job here: its workflow becomes a temporary preset ("From PC · model")
 * with the controls the app finds in it, filled in with what the PC used, so it
 * can be changed and run again from the phone (the canvas button shows the whole
 * workflow). follow: also show the running job in This session until it is done.
 */
async function openPcJob(promptId, { follow = true } = {}) {
  if (isLocked()) return busy();
  let j;
  try { j = await api.getPcJob(promptId); } catch (e) { toast(e.message, 6000); return; }
  const controls = detectControls(j.graph);
  if (!controls.ok) { toast(`Cannot open that workflow: ${controls.error}`, 8000); return; }
  const id = `desktop:${j.label}`;
  const preset = { id, ok: true, file: null, label: `From PC · ${j.label}`, short: `PC · ${j.label}`, group: 'From PC', workflow: j.graph, controls, output: 'image', pc: true };
  workflows = [...workflows.filter((w) => !w.pc), preset];
  picker.setItems(workflows);
  selectPreset(id, { remember: false });
  panel.reuse({ prompt: j.meta.prompt, negative: j.meta.negative, seed: j.meta.seed, steps: j.meta.steps });
  if (follow) { queue.follow(promptId, { prompt: j.meta.prompt, seed: j.meta.seed, workflow: id }); paintThumbs(); }
  toast(follow ? 'The PC job is here: change it and Run, or wait for its result below' : 'Workflow loaded: change it and Run');
}
const pcCard = new PcCard($('#pc-card'), { onOpen: (promptId) => openPcJob(promptId), onProgress: (promptId, f) => queue.progressOf(promptId, f) });
// A followed PC job sends its progress only to the desktop page: look in /history every few seconds.
setInterval(() => { if (queue.following && !document.hidden) queue.resync().then(paintThumbs); }, 5000);
const batchSheet = new BatchSheet({ button: $('#btn-batch'), badge: $('#batch-count'), onEdit: (row) => startEdit(row) });

// ---- Save to Drive (server copies the file into a folder of Q:\My Drive) ----
// Batch 8: asks where every time (ui/drive-folder.js), starting in the folder
// last used for that kind of file.
const driveSheet = new DriveFolderSheet();
/** phone(): batch 10 - "Save to this phone instead" at the bottom of the sheet. */
async function saveToDrive(f, kind, { phone } = {}) {
  const k = kind || fileKind(f);
  const driveKind = ['3d', 'audio', 'video'].includes(k) ? k : 'image';
  const folder = await driveSheet.choose(driveKind, { phone: !!phone });
  if (folder === PHONE) { phone(); return null; }
  if (folder === null) return null;
  try {
    const r = await api.saveToDrive(f, kind, folder);
    rememberFolder(driveKind, r.drivePath ?? folder);
    toast(`Saved to Drive: ${r.drivePath ? `${r.drivePath}/` : ''}${r.name}`, 5000);
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
async function useAsReference(img, historyId) {
  if (!img) return;
  if (isLocked()) { busy(); return null; } // the reference slots are locked during a run
  if (!viewer.root.hidden) { viewer.close(); await afterBack(); }
  const load = async () => { const ref = await refs.useImage(refs.targetNode(), img); if (ref) { if (historyId) refSources.set(ref, historyId); toast('Reference image ready'); } return ref; };
  if (current && takesPicture(current)) return load();
  const list = referencePresets();
  if (!list.length) { toast('No preset with a reference image slot'); return null; }
  presetChooser.open(list, async (w) => { if (isLocked()) return busy(); selectPreset(w.id); await afterBack(); await load(); });
  return null;
}

// ---- Import (batch 7): photo / video / recording -> "What next?" ------------
// The file is uploaded to ComfyUI's input folder first; the chooser then lists
// only the presets that take that kind of file (grouped like the picker), and
// the picked one gets it in its slot.
const importSheet = new ImportSheet({
  button: $('#btn-attach'),
  upload: async (file) => (await comfy.uploadImage(file)).ref,
  // "From Comfy UI": one of the app's pictures, at full size, like a picked file.
  fromComfy: () => outputPicker.open({ session: sessionImages, onPick: async (img) => {
    try {
      const r = await fetch(viewUrl(img));
      if (!r.ok) throw new Error(`Could not load ${img.filename} (${r.status})`);
      const blob = await r.blob();
      await importSheet.take(new File([blob], img.filename, { type: blob.type || 'image/png' }));
    } catch (e) { toast(e.message, 6000); }
  } }),
  onImported: async ({ kind, ref }) => {
    if (isLocked()) return busy();
    // Batch 8 (+ button): the current preset takes it -> straight into its slot.
    if (current?.ok && kind === 'image' && current.controls?.images?.length) { refs.set(refs.targetNode(), ref); return toast('Picture added'); }
    if (current?.ok && kind !== 'image') {
      const slot = fileInputs.slots.find((s) => s.kind === kind && !fileInputs.values[fileInputs.key(s)]) || fileInputs.slots.find((s) => s.kind === kind);
      if (slot) { fileInputs.set(slot, ref); return toast(`${kind === 'video' ? 'Video' : 'Recording'} added`); }
    }
    const list = presetsFor(kind, workflows, usable);
    if (!list.length) return toast(`No preset takes ${kind === 'image' ? 'a picture' : `a ${kind} file`}`, 6000);
    const preview = kind === 'image' ? h('img', { src: inputViewUrl(ref), alt: 'Imported photo' })
      : kind === 'video' ? h('video', { src: inputViewUrl(ref), muted: true, playsInline: true, controls: true })
        : h('audio', { src: inputViewUrl(ref), controls: true });
    presetChooser.open(list, async (w) => {
      if (isLocked()) return busy();
      selectPreset(w.id);
      await afterBack();
      if (kind === 'image') refs.set(refs.targetNode(), ref);
      else { const slot = fileInputs.slots.find((s) => s.kind === kind); if (slot) fileInputs.set(slot, ref); }
      toast(`${kind === 'image' ? 'Photo' : kind === 'video' ? 'Video' : 'Recording'} ready in ${w.short || w.label}`);
    }, { title: 'What next?', preview });
  },
});

// ---- presets ---------------------------------------------------------------
// The picker lists the AI Workflow presets (3D / Image / Video / Audio,
// availability computed live on the server) and My presets: presets saved from
// the node view plus any workflow imported or dropped into workflows/.
// The old built-in "App presets" are retired; their ids still resolve (see
// lib/legacy-presets.js). Default preset: FLUX.2 Klein 4B Text to Image.
const picker = new WorkflowPicker({
  onPick: (id) => (isLocked() ? busy() : selectPreset(id)),
  // Presets saved from the node view: rename and move to another section in one go.
  onEditGraph: async (w, patch) => { try { const g = await api.updateGraphPreset(w.graph.id, patch); toast(`Saved "${g.name}"`); await loadWorkflows(current?.id, { fresh: false }); } catch (e) { toast(e.message, 6000); } },
  onDelete: async (w) => { try { await api.deleteGraphPreset(w.graph.id); toast(`Deleted "${w.label}"`); await loadWorkflows(current?.id === w.id ? undefined : current?.id); } catch (e) { toast(e.message, 6000); } },
});
const usable = isUsable;
// remember: true only when keepId is a real user choice (just imported / saved).
// Otherwise nothing is written: the remembered pick stays what the user last
// picked, and a fresh client keeps getting the default (lib/preset-choice.js).
async function loadWorkflows(keepId, { fresh = false, remember = false } = {}) {
  // Batch 16: one-off presets Claude built stay until the app closes.
  try { workflows = [...(await api.getWorkflows({ fresh })), ...workflows.filter((w) => w.claude)]; } catch (e) { toast('Could not load presets: ' + e.message); return; }
  picker.setItems(workflows);
  // Last pick (old "fast-concept" etc. map to Klein) -> else Klein 4B T2I -> else first available AI Workflow entry.
  const pick = choosePreset(workflows, { keep: keepId, saved: localStorage.getItem('preset') });
  selectPreset(pick.id, { remember: remember && pick.source === 'keep' });
}

/**
 * Batch 8: switching presets keeps what was loaded. Pictures move into the new
 * preset's image slots in order, videos / recordings into its slots of the same
 * kind; they are dropped only when the new preset has no slot for them (a
 * text-only preset). The picture slots are keyed by node id, which differs
 * between presets, so the values are re-keyed here.
 */
function carryInputs(prev, next) {
  if (!prev || !next || prev.id === next.id) return;
  const imgs = refs.slots.map((s) => refs.values[s.node]).filter(Boolean);
  const files = {};
  for (const s of fileInputs.slots) { const v = fileInputs.values[fileInputs.key(s)]; if (v) (files[s.kind] ||= []).push(v); }
  const nextImgs = next.ok ? next.controls?.images || [] : [];
  refs.values = {};
  nextImgs.forEach((s, i) => { if (imgs[i]) refs.values[s.node] = imgs[i]; });
  fileInputs.values = {};
  const used = {};
  for (const s of (next.ok ? next.ai?.inputs || [] : [])) {
    const i = used[s.kind] = (used[s.kind] ?? -1) + 1;
    const v = files[s.kind]?.[i];
    if (v) fileInputs.values[fileInputs.key(s)] = v;
  }
  // A painted mask belongs to the old picture and the old preset.
  maskSlot.value = null; maskSlot.preview = null;
}

function selectPreset(id, { remember = true } = {}) {
  const prev = current;
  current = workflows.find((w) => w.id === id) || null;
  carryInputs(prev, current);
  picker.setCurrent(current);
  if (id && current && remember) localStorage.setItem('preset', id);
  panel.setWorkflow(current);
  // Optional slots (Wan start frame, Chatterbox voice sample) can stay empty.
  const optional = new Set((current?.ok ? current.ai?.optional || [] : []).map((o) => o.node));
  const m = current?.ok ? current.ai : null; // (i) texts: lib/setting-info.js
  refs.render(current?.ok && current.controls ? current.controls.images.map((s) => ({ ...s, ...(optional.has(s.node) ? { optional: true } : {}), info: infoFor('image', { manifest: m, node: s.node }) })) : []);
  fileInputs.render((m?.inputs || []).map((f) => ({ ...f, info: infoFor(f.kind, { manifest: m }) })));
  paintMask();
  $('#btn-generate').classList.toggle('is-unavailable', current?.availability?.status === 'unavailable');
  // Batch 13: the + in the prompt box only when this preset takes a picture, video or audio.
  const kinds = new Set([...(current?.ok && current.controls?.images?.length ? ['image'] : []), ...(m?.inputs || []).map((f) => f.kind)].filter((k) => ['image', 'video', 'audio'].includes(k)));
  importSheet.setKinds(kinds);
  $('#btn-attach').hidden = !kinds.size;
}

// ---- GPU sharing with Ollama ---------------------------------------------------
// Before ANY ComfyUI queue (batches and workflow actions) the server applies the
// memory profile picked from the detected GPU (config/memory-profiles.json):
//   small (< 12 GB, 2080 Ti): always unload the chat model (keep_alive 0, checked
//         with /api/ps) - measured ~6.8 GB ComfyUI + ~2.9 GB gemma3:4b leaves < 0.7 GB.
//   large (16 GB+, 5080): keep it loaded unless free VRAM is below what this
//         workflow needs (workflowVramNeedMB).
async function beforeComfyQueue(workflowId) {
  const r = await api.prepareComfyQueue(workflowId);
  if (r?.result?.stillLoaded?.length) console.warn('Ollama models still loaded:', r.result.stillLoaded);
  if (r) console.info('memory:', r.profile, r.unload ? 'unloaded Ollama model' : 'kept Ollama model', '-', r.reason);
}

// ---- generate --------------------------------------------------------------
async function generate() {
  if (isLocked()) return busy();
  const r = await buildRun();
  if (r?.jobs) await startRun(r.workflowId, r.jobs);
}

/**
 * Batch 12: "Save to batch" - the same jobs Run would queue, kept by the PC's
 * scheduler (server/scheduler.js) and run later, one after another.
 */
async function saveToBatch() {
  const jobs = await batchJobs();
  if (jobs) await batchSheet.add(jobs);
}

/** The form as batch jobs (one row in the batch sheet), or null after saying what is missing. */
async function batchJobs() {
  const r = await buildRun();
  if (!r?.jobs) return null;
  const label = current.short || current.label;
  const seeds = (current.controls?.seed || []).map((t) => ({ node: String(t.node), input: String(t.input) }));
  const group = 'g' + Math.random().toString(36).slice(2, 10); // one row in the batch sheet for this Save
  return withMemoryOptions(r.workflowId, r.jobs).map((j) => ({ graph: j.workflow, meta: j.meta, seeds, randomSeed: r.seedMode !== 'locked', label, group }));
}

// ---- Batch 13: Edit a job that is in the batch ----------------------------------
// ⋮ Edit in the batch sheet loads the row into the form (like Reuse); an orange
// bar on top says what is being edited, and the bottom bar swaps Run + the batch
// group for Cancel and "Update job N". Update replaces the row in place;
// Cancel puts the form back the way it was. Running / finished jobs can't be edited.
let editing = null; // { ids, index, label, prev: { preset, panel, refs, mask } }
function startEdit(row) {
  if (isLocked()) return busy();
  if (editing) endEdit(true);
  const j = row.jobs[0], meta = j.meta || {};
  editing = { ids: row.ids, index: row.index, label: row.label, prev: { preset: current?.id, panel: panel.snapshot(), refs: { ...refs.values }, mask: maskSlot.value } };
  const wid = resolvePresetId(meta.workflow);
  if (wid && wid !== current?.id && workflows.some((w) => w.id === wid)) selectPreset(wid, { remember: false });
  if (meta.reference && typeof meta.reference === 'object') {
    const slots = current?.ok ? current.controls?.images || [] : [];
    const refMap = slots.length ? remapReference(meta.reference, slots) : {};
    for (const [node, ref] of Object.entries(refMap)) refs.set(node, ref);
  }
  if (typeof meta.mask === 'string' && current?.ai?.mask) { maskSlot.value = meta.mask; paintMask(); }
  panel.reuse(meta);
  panel.setSeed(j.randomSeed ? undefined : meta.seed);
  panel.setBatch(row.jobs.length);
  paintEdit();
  window.scrollTo?.({ top: 0 });
  $('#panel')?.scrollTo?.({ top: 0 });
}
function paintEdit() {
  const bar = $('#edit-bar');
  $('.actionbar').classList.toggle('editing', !!editing);
  $('#btn-edit-cancel').hidden = $('#btn-edit-update').hidden = !editing;
  bar.hidden = !editing;
  if (!editing) { bar.replaceChildren(); return; }
  $('#edit-update-label').textContent = `Update job ${editing.index + 1}`;
  bar.replaceChildren(h('i.i.i-pencil'), h('span', {}, 'Editing ', h('b', {}, `batch job ${editing.index + 1}`), ` · ${editing.label}`), h('span.spacer'),
    h('button.link', { type: 'button', onclick: () => endEdit(true) }, 'Cancel'));
}
/** restore = true: put the form back the way it was before Edit. */
function endEdit(restore) {
  const e = editing; editing = null;
  if (e && restore) {
    if (e.prev.preset && e.prev.preset !== current?.id && workflows.some((w) => w.id === e.prev.preset)) selectPreset(e.prev.preset, { remember: false });
    panel.restore(e.prev.panel);
    for (const [node, ref] of Object.entries(e.prev.refs)) if (ref) refs.set(node, ref);
    maskSlot.value = e.prev.mask ?? null; paintMask();
  }
  paintEdit();
}
async function updateEdited() {
  if (!editing) return;
  const jobs = await batchJobs();
  if (!jobs) return;
  const n = editing.index + 1;
  try {
    await batchSheet.replace(editing.ids, jobs);
    toast(`Job ${n} updated`);
  } catch (e) {
    if (!/already started|not found/i.test(e.message)) return toast(e.message, 6000);
    // it started (or finished) while being edited: keep the change as a new job instead
    if (!(await batchSheet.add(jobs))) return;
    toast(`Job ${n} had already started, so this was saved as a new job`, 6000);
  }
  endEdit(true);
  batchSheet.open();
}

/** The jobs for the form as it is now ({ workflowId, jobs, seedMode }), or null after saying what is missing. */
async function buildRun() {
  if (!current?.ok || !current.workflow) return toast(current?.availability?.reason || 'Pick a usable preset first', 6000);
  if (current.availability?.status === 'unavailable') return toast(`Unavailable: ${current.availability.reason}`, 8000);
  const c = current.controls;
  const v = panel.values();
  const missing = refs.missing();
  if (missing.length) return toast(c.images.length > 1 || current.ai ? `Add a picture first (${missing[0].title.replace(/#\w+/g, '').trim() || 'image'})` : 'Add a reference image first');
  const missingFile = fileInputs.missing();
  if (missingFile.length) return toast(`Pick a ${missingFile[0].kind} first`);
  if (maskSlot.missing()) return toast('Paint a mask first');
  const ai = current.ai;
  // Workflows with a built-in instruction (e.g. Remove Lighting) run with an empty prompt.
  if (c.prompt.length && !v.prompt.trim() && !ai?.promptDefault) return toast('Type a prompt');
  // Text-to-image presets: the 1K / 2K / 4K picker sets the size (lib/resolution.js);
  // others keep the preset's pixel count.
  let size = c.width.length && c.height.length ? (v.res ? panel.renderSize() : sizeFor(v.aspect, ...(ai?.size ? ai.size.base : [c.defaults.width || 1024, c.defaults.height || 1024]), ai?.size?.multiple || 16)) : {};
  // 4K = 2K render + 2x upscale in the same graph; needs an installed upscale model.
  const upscale = v.res ? RESOLUTIONS[v.res].upscale : 1;
  let upscaleModel = null;
  if (upscale > 1) {
    upscaleModel = pickUpscaleModel(await installedUpscaleModels());
    if (!upscaleModel) return toast('4K needs an upscale model (e.g. 4x-UltraSharp) in ComfyUI/models/upscale_models', 8000);
  }
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
    if (upscaleModel) workflow = withUpscale(workflow, upscaleModel, upscale);
    return {
      workflow,
      meta: {
        workflow: current.id, prompt: v.prompt, negative: v.negative || undefined, seed, aspect: v.aspect, res: v.res,
        width: size.width * upscale, height: size.height * upscale, renderWidth: upscale > 1 ? size.width : undefined, renderHeight: upscale > 1 ? size.height : undefined, steps: v.steps, strength: v.strength, params: ai ? params : undefined, output: ai?.output,
        reference: c.images.length ? Object.fromEntries(c.images.map((s) => [s.node, refs.values[s.node]])) : undefined,
        mask: maskSlot.value || undefined,
        // Batch 11: made from a History picture -> the server files it in that picture's project.
        source: Object.values(refs.values).map((r) => refSources.get(r)).find(Boolean),
        project: getCurrentProject() || undefined, // batch 12: this device's pick (No project by default)
      },
    };
  });
  return { workflowId: current.id, jobs, seedMode: v.seedMode };
}

// ---- memory options (lib/memory-options.js) ------------------------------------
let memSettings = { textEncoderCpu: false };
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
// Batch 5: the menu switches are gone; a value saved earlier on the server
// (data/memory.json) is still honoured.
async function loadMemorySettings() {
  try { memSettings = await api.getMemorySettings(); } catch {}
}

/** Upscale models ComfyUI has installed (for 4K), from /object_info. */
async function installedUpscaleModels() {
  try {
    const j = await (await fetch('/comfy/object_info/UpscaleModelLoader')).json();
    const spec = j?.UpscaleModelLoader?.input?.required?.model_name;
    // Old format: [[names...]]; new format: ['COMBO', { options: [names...] }].
    const list = Array.isArray(spec?.[0]) ? spec[0] : spec?.[1]?.options;
    return Array.isArray(list) ? list : [];
  } catch { return []; }
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

$('#btn-generate').addEventListener('click', generate);
$('#btn-batch-add').addEventListener('click', saveToBatch);
$('#btn-edit-cancel').addEventListener('click', () => endEdit(true));
$('#btn-edit-update').addEventListener('click', updateEdited);
$('#prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) generate(); });
$('#btn-cancel').addEventListener('click', async () => { lock.cancel(); await queue.cancelAll(); paintThumbs(); toast('Queue cleared'); });
$('#btn-clear').addEventListener('click', () => queue.clearFinished());

// ---- thumbnails ------------------------------------------------------------
function paintThumbs() {
  const live = () => queue.items.filter((x) => !x.deleted); // deleted from the viewer's trash
  renderThumbs($('#thumbs'), live(), (it) => {
    if (!it.image && it.files?.length) { openFile(it.files[0], it.meta); return; }
    if (!it.image) { if (it.error) toast(it.error, 8000); return; }
    const done = live().filter((x) => x.image);
    viewer.open(live, done.indexOf(it));
  }, modelThumbs);
  const locked = isLocked();
  setKeepAwake(locked); // Android app: screen stays on while a run is going
  $('#btn-cancel').hidden = !locked;
  const run = $('#btn-generate');
  run.disabled = locked;
  run.classList.toggle('is-running', locked);
  $('#preset-btn').disabled = locked;
  // The whole form is read-only during a run (ui/form-lock.js).
  lockControls([$('#panel')], locked);
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

/** Share a 3D / video / audio result: the Android share sheet in the app, else the Web Share API. */
async function shareFile(f) {
  if (hasNative('shareImage')) {
    try { nativeBridge().shareImage(absoluteUrl(viewUrl(f)), f.filename); } catch (e) { toast('Share failed: ' + e.message); }
    return;
  }
  try {
    const blob = await (await fetch(viewUrl(f))).blob();
    const file = new File([blob], f.filename, { type: blob.type || 'application/octet-stream' });
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file] });
    else if (navigator.share) await navigator.share({ url: new URL(viewUrl(f), location.href).href });
    else toast('Sharing is not supported in this browser');
  } catch (e) { if (e.name !== 'AbortError') toast('Share failed: ' + e.message); }
}

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
    const target = workflows.find((w) => w.id === editId && hasSlot(w)) || workflows.find(hasSlot);
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

// ---- Batch 16: Claude ----------------------------------------------------------
// Off by default (Settings). Claude fills in the form and stops; the user presses
// Run or + Batch. Changed fields get an orange dot; one Undo reverts everything a
// reply changed. The chat is kept in memory until the app closes.
let claudeStatus = null;
let claudeBox = null;
const claudeOn = () => !!claudeStatus?.enabled;
const settingsSheet = new SettingsSheet({ button: $('#btn-settings'), onChange: (st) => { claudeStatus = st; paintClaude(); } });
const askSheet = new AskSheet();
const variationsSheet = new VariationsSheet();
function paintClaude() {
  const host = $('#claude-host');
  host.hidden = !claudeOn();
  if (claudeOn() && !claudeBox) claudeBox = new ClaudeBox(host, { ask: askFromBox, apply: applyClaude, defaultModel: () => claudeStatus?.defaultModel || 'haiku' });
}
async function loadClaude() { try { claudeStatus = await api.getClaude(); } catch { claudeStatus = null; } paintClaude(); }

/** The form as Claude sees it (get_form). */
function formForClaude() {
  const v = panel.values();
  return {
    preset: current?.id, presetName: current?.label, prompt: v.prompt, negative: v.negative, aspect: v.aspect, resolution: v.res, batch: v.batch,
    seed: v.seedMode === 'locked' ? v.seed : 'random', settings: current?.ai ? v.params : undefined,
    pictureSlots: refs.slots.map((sl) => (refs.values[sl.node] ? 'filled' : 'empty')),
  };
}

/** /api/claude/ask, with the next step for the known refusals (no key -> Settings). */
async function claudeAsk(body) {
  try { return await api.askClaude(body); } catch (e) {
    if (e.code === 'no-key') settingsSheet.open({ askKey: true });
    if (e.code === 'off') loadClaude();
    throw e;
  }
}
function askFromBox({ text, model, memory }) {
  if (isLocked()) throw new Error('Wait for the run to finish first');
  // "6 takes, vary the light": variations into the batch (always Opus)
  return claudeAsk({ mode: wantsVariations(text) ? 'variations' : 'prompt', model, text, memory, form: formForClaude() });
}

/** Viewer "Fix this result" (one picture) and Files (several, in tap order). */
function openAsk(mode, items) {
  if (!claudeOn()) return;
  const line = (m) => [labelOf(m.workflow), m.seed !== undefined && m.seed !== null ? `seed ${m.seed}` : null, m.width && m.height ? `${m.width}×${m.height}` : null, m.steps ? `${m.steps} steps` : null].filter(Boolean).join(' · ');
  const list = items.map((it) => ({ ...it, line: line(it.meta || {}) }));
  askSheet.open({
    mode, items: list,
    title: mode === 'fix' ? 'Fix this result' : `Ask Claude about ${list.length} ${list.length === 1 ? 'picture' : 'pictures'}`,
    onAsk: async (text) => {
      if (isLocked()) throw new Error('Wait for the run to finish first');
      // long side about 1024 px: enough to judge hands and texture, small enough to be cheap
      const pictures = await Promise.all(list.map(async (it) => ({ ...(await downscale(it.image)), image: it.image, meta: { ...it.meta, historyId: it.historyId } })));
      return claudeAsk({ mode, text, form: formForClaude(), pictures, memory: claudeBox?.memory.slice() || [] });
    },
    // Claude changed the form: back to the form, the reply (with Undo) in the Claude box.
    onDone: async (text, r) => {
      if (!viewer.root.hidden) { viewer.close(); await afterBack(); }
      if (historyView.on) { await leaveHistory(); await afterBack(); }
      if (nodeView.on) nodeView.hide();
      paintClaude();
      await claudeBox.show(text, r);
      claudeBox.root.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    },
  });
}

/** Orange dot / outline on what the last reply changed (cleared by Undo or the next reply). */
function markChanged(keys) {
  for (const el of document.querySelectorAll('.claude-changed')) el.classList.remove('claude-changed');
  const sel = { preset: '#preset-btn', prompt: '.prompt-field', negative: '#neg-row', aspect: '#aspect-field', res: '#aspect-field', batch: '#batch-field', seed: '#seed-field', refs: '#refs' };
  for (const k of keys) {
    const q = k.startsWith('param:') ? `#params [data-key="${k.slice(6)}"], #params-open [data-key="${k.slice(6)}"]` : sel[k];
    for (const el of q ? document.querySelectorAll(q) : []) el.classList.add('claude-changed');
    if (k === 'negative') $('#negative').classList.add('claude-changed');
    if (k.startsWith('param:')) $('#settings').open = true;
  }
}

/** A graph Claude built -> a one-off preset ("Claude › name") in the picker. */
function claudePreset(a) {
  const g = structuredClone(a.graph);
  const pictureNodes = [];
  for (const [id, n] of Object.entries(g)) {
    const m = n.class_type === 'LoadImage' && typeof n.inputs?.image === 'string' && /^picture:(\d+)$/.exec(n.inputs.image);
    if (m) { pictureNodes.push({ node: id, n: Number(m[1]) }); n.inputs.image = 'example.png'; }
  }
  const controls = detectControls(g);
  if (!controls.ok) { toast(`Claude's workflow could not be loaded: ${controls.error}`, 8000); return null; }
  const slug = String(a.name || 'one-off').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'one-off';
  const preset = { id: `claude:${slug}-${Date.now().toString(36)}`, ok: true, file: null, label: a.name, short: a.name, group: 'Claude', workflow: g, controls, output: 'image', claude: true, oneOff: true };
  workflows = [...workflows, preset];
  picker.setItems(workflows);
  return { preset, pictureNodes };
}
// Save a Claude one-off as a real preset (node view's Save as preset, with this graph).
const saveClaudePreset = new SavePresetSheet({
  getGraph: async () => {
    const g = structuredClone(current?.workflow || {});
    for (const [id, n] of Object.entries(g)) if (n.class_type === 'LoadImage' && refs.values[id]) n.inputs.image = refs.values[id];
    return g;
  },
  target: () => (current ? { ...current, label: current.label, group: 'My presets' } : null),
  save: async ({ name, group, subgroup, workflow }) => {
    const g = await api.saveGraphPreset({ name, group, subgroup, workflow, from: current?.id });
    await loadWorkflows(g.id, { remember: true });
    return g;
  },
});

/** Labels for what panel.applyChanges changed. */
function changeLabels(keys, ch = {}, values = {}) {
  const s = panel.state;
  return keys.map((k) => {
    if (k === 'prompt') return 'prompt rewritten';
    if (k === 'negative') return s.negative ? `negative: “${s.negative.length > 40 ? s.negative.slice(0, 40) + '…' : s.negative}”` : 'negative off';
    if (k === 'aspect') return `aspect ${aspectLabel(s.aspect)}`;
    if (k === 'res') return String(s.res).toUpperCase();
    if (k === 'batch') return `batch ${s.batch}`;
    if (k === 'seed') return s.seedMode === 'locked' ? `seed ${s.seed}` : 'random seed';
    if (k.startsWith('param:')) { const key = k.slice(6); return `${current?.ai?.params?.[key]?.label || key} ${values[key]}`; }
    return k;
  });
}

/** Apply a reply's actions to the form (and batch). -> { changed, undo, extra } */
async function applyClaude(r) {
  const acts = r.actions || [];
  if (!acts.length) { markChanged([]); return { changed: [] }; }
  if (isLocked()) { toast('A run is going: Claude\'s changes were not applied', 6000); return { changed: [] }; }
  if (editing) endEdit(true);
  const prev = { preset: current?.id, panel: panel.snapshot(), refs: { ...refs.values } };
  const changed = [], marks = new Set(), extra = [];
  let addedJobs = [], built = null;
  for (const a of acts) {
    if (a.type === 'graph') {
      built = claudePreset(a);
      if (!built) continue;
      selectPreset(built.preset.id, { remember: false });
      marks.add('preset');
      changed.push(`built “${a.name}”`);
      for (const { node, n } of built.pictureNodes) { const pic = a.pictures?.find((p) => p.n === n); if (pic) await refs.useImage(node, pic.image); }
      if (built.pictureNodes.length) marks.add('refs');
      if (a.prompt) { const k = panel.applyChanges({ prompt: a.prompt }); k.forEach((x) => marks.add(x)); }
      extra.push(h('div.cl-built', {},
        h('span.cl-reply-head', {}, claudeLogo(14), 'Built a one-off workflow'),
        a.roles?.length ? h('span.cl-changes', {}, a.roles.map((role, i) => `${i + 1} · ${role}`).join('   ')) : null,
        h('span.cl-ok', {}, h('i.i.i-check'), 'Checked against your ComfyUI: every node and model is installed'),
        h('div.cl-built-btns', {},
          h('button.btn', { type: 'button', dataset: { act: 'save-claude-preset' }, onclick: () => saveClaudePreset.open() }, 'Save as preset…'),
          h('button.btn', { type: 'button', dataset: { act: 'open-node-view' }, onclick: () => nodeView.show() }, 'Open in node view'))));
    }
    if (a.type === 'form') {
      const ch = a.changes || {};
      if (ch.preset && ch.preset !== current?.id && workflows.some((w) => w.id === ch.preset)) {
        selectPreset(ch.preset, { remember: false });
        changed.push(`Preset → ${current.short || current.label}`); marks.add('preset');
      }
      const keys = panel.applyChanges(ch);
      keys.forEach((k) => marks.add(k));
      changed.push(...changeLabels(keys, ch));
    }
    if (a.type === 'settings' && a.preset === current?.id) {
      const keys = panel.applyChanges({}, a.values);
      keys.forEach((k) => marks.add(k));
      changed.push(...changeLabels(keys, {}, a.values));
    }
    if (a.type === 'pictures') {
      let n = 0;
      for (const [i, pic] of (a.pictures || []).entries()) {
        const slot = refs.slots[i]; if (!slot) break;
        const ref = await refs.useImage(slot.node, pic.image);
        if (ref) { n++; if (pic.historyId) refSources.set(ref, pic.historyId); }
      }
      if (n) { changed.push(`${n} ${n === 1 ? 'picture' : 'pictures'} loaded`); marks.add('refs'); }
    }
    if (a.type === 'variations') {
      addedJobs = await addVariations(a, r);
      if (addedJobs.length) changed.push(`${addedJobs.length} jobs added to the batch (not started)`);
    }
  }
  markChanged(marks);
  const undo = async () => {
    if (isLocked()) return busy();
    for (const j of addedJobs) { try { await api.removeScheduled(j.id); } catch { /* already started: it stays */ } }
    if (addedJobs.length) { batchSheet.refresh(); variationsSheet.close(); }
    if (prev.preset && prev.preset !== current?.id && workflows.some((w) => w.id === prev.preset)) selectPreset(prev.preset, { remember: false });
    panel.restore(prev.panel);
    refs.values = Object.fromEntries(Object.entries(prev.refs).filter(([, v]) => v));
    refs.render(refs.slots); paintMask();
    if (built) { workflows = workflows.filter((w) => w.id !== built.preset.id); picker.setItems(workflows); }
    markChanged([]);
    toast('Undone');
  };
  return { changed, undo, extra };
}

/** N variations -> N batch jobs (built like + Batch), added NOT started; the Variations sheet. */
async function addVariations(a, r) {
  const keep = { preset: current?.id, panel: panel.snapshot() };
  if (a.preset && a.preset !== current?.id && workflows.some((w) => w.id === a.preset)) selectPreset(a.preset, { remember: false });
  const base = panel.snapshot();
  const all = [];
  try {
    for (const j of a.jobs) {
      panel.restore(base);
      panel.applyChanges({ ...j.changes, batch: 1 }, j.settings);
      const jobs = await batchJobs();
      if (!jobs) return [];
      all.push(...jobs.map((x) => ({ ...x, label: `${x.label} · ${j.label}`, meta: { ...x.meta, claudeLabel: j.label } })));
    }
  } finally {
    if (keep.preset && keep.preset !== current?.id && workflows.some((w) => w.id === keep.preset)) selectPreset(keep.preset, { remember: false });
    panel.restore(keep.panel);
  }
  let before, data;
  try { before = new Set((await api.getSchedule()).jobs.map((j) => j.id)); data = await api.addToSchedule(all); } catch (e) { toast(e.message, 6000); return []; }
  await batchSheet.refresh();
  const added = data.jobs.filter((j) => !before.has(j.id));
  const rows = added.map((j) => ({ ids: [j.id], jobs: [j], label: j.meta?.claudeLabel || j.label, sub: String(j.meta?.prompt || '').slice(0, 80) }));
  variationsSheet.open({
    rows, cost: r.costUsd,
    onEdit: async (row) => {
      const d = await api.getSchedule();
      const waiting = rowsOf(d.jobs).filter((x) => x.status === 'waiting');
      const index = waiting.findIndex((x) => x.jobs[0].id === row.ids[0]);
      if (index < 0) return toast('That job already started');
      startEdit({ ids: row.ids, jobs: waiting[index].jobs, index, label: waiting[index].jobs[0].label });
    },
    onRemoveAll: async () => { for (const j of added) { try { await api.removeScheduled(j.id); } catch {} } await batchSheet.refresh(); toast(`Removed ${added.length} jobs`); },
    onOpenBatch: () => batchSheet.open(),
  });
  return added;
}

// ---- start ---------------------------------------------------------------
async function start() {
  try { config = await api.getConfig(); if (!config.comfyReachable) banner(`ComfyUI not reachable at ${config.comfyUrl}`); } catch { banner('App server not reachable'); }
  await loadWorkflows();
  loadMemorySettings();
  await loadClaude();
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
window.conceptApp = { savePreset, maskSlot, modelThumbs, historyView, isLegacyPreset, choosePreset, comfy, queue, panel, refs, fileInputs, viewer, picker, selectPreset, loadWorkflows,
  lock, resume, connBanner, claude: { get box() { return claudeBox; }, get status() { return claudeStatus; }, settingsSheet, askSheet, variationsSheet, applyClaude, loadClaude }, nodeView, modelViewer, audioPlayer, videoPlayer, fileSheet, outputPicker, presetChooser, importSheet, openFile, useAsReference, saveToDrive, referencePresets, get workflows() { return workflows; }, get current() { return current; } };
