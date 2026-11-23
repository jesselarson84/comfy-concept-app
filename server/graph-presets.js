// graph-presets.js - presets saved from the node view ("Save as preset"), in
// data/graph-presets.json (data/ is git-ignored).
//   { version: 1, presets: [{ id, name, group, subgroup, workflow, from, createdAt, updatedAt }] }
// workflow is the API-format graph ComfyUI's canvas produced (graphToPrompt).
// group is one of the picker sections; subgroup one of that section's sub
// sections (only Image has them). Built-in presets are never changed: saving
// over one always makes a new entry here (`from` remembers which it came from).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { checkApiFormat } from '../app/js/lib/workflow-detect.js';
import { SUBGROUPS } from '../app/js/lib/presets.js';
import { cleanName } from './user-presets.js';

const MAX = 200;
export const GROUPS = ['3D', 'Image', 'Video', 'Audio', 'Textures', 'Concept', 'VFX', '3D Assets', 'Sound', 'My presets'];
// Anything that writes a result: SaveImage, SaveVideo, SaveAudio, SaveGLB, VHS_VideoCombine ...
const OUTPUT_NODES = /Save|PreviewImage|VideoCombine/;
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

/** What the graph makes, from its save nodes: image / video / audio / 3d (null when unclear). */
export function outputKind(wf) {
  const t = Object.values(wf || {}).map((n) => n.class_type || '').join(' ');
  if (/SaveGLB|Save3D|Mesh|Trellis|Hunyuan3D/i.test(t)) return '3d';
  if (/SaveVideo|SaveWEBM|VideoCombine|SaveAnimated/i.test(t)) return 'video';
  if (/SaveAudio/i.test(t)) return 'audio';
  if (/SaveImage|PreviewImage/i.test(t)) return 'image';
  return null;
}

/** Section / sub section the picker understands (anything else -> My presets, no sub section). */
export function placement(group, subgroup) {
  const g = GROUPS.includes(group) ? group : 'My presets';
  const subs = SUBGROUPS[g] || [];
  return { group: g, subgroup: subs.includes(subgroup) ? subgroup : null };
}

/** Clean API graph: "_" keys dropped; must be API format with at least one output node. */
export function cleanGraph(workflow) {
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) throw bad('No graph to save');
  const wf = Object.fromEntries(Object.entries(workflow).filter(([k]) => !k.startsWith('_')));
  const fmt = checkApiFormat(wf);
  if (!fmt.ok) throw bad(fmt.reason);
  if (!Object.values(wf).some((n) => OUTPUT_NODES.test(n.class_type || ''))) throw bad('This graph saves nothing: add a Save node (e.g. Save Image) first.');
  if (JSON.stringify(wf).length > 4 * 1024 * 1024) throw bad('Graph too large');
  return wf;
}

export class GraphPresetStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'graph-presets.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.data = this.#load();
    this.writing = Promise.resolve();
  }
  #load() {
    try { const d = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (Array.isArray(d.presets)) return d; } catch (e) {
      if (e.code !== 'ENOENT') { try { fs.renameSync(this.file, this.file + '.corrupt-' + Date.now()); } catch {} }
    }
    return { version: 1, presets: [] };
  }
  #save() {
    const json = JSON.stringify(this.data, null, 1);
    this.writing = this.writing.then(async () => { const tmp = this.file + '.tmp'; await fs.promises.writeFile(tmp, json); await fs.promises.rename(tmp, this.file); });
    return this.writing;
  }
  #uniqueName(name, exceptId) {
    let n = cleanName(name) || 'My preset';
    const taken = new Set(this.data.presets.filter((p) => p.id !== exceptId).map((p) => p.name.toLowerCase()));
    if (taken.has(n.toLowerCase())) { let i = 2; while (taken.has(`${n} ${i}`.toLowerCase())) i++; n = `${n} ${i}`; }
    return n;
  }
  list() { return [...this.data.presets]; }
  get(id) { return this.data.presets.find((p) => p.id === String(id).replace(/^graph:/, '')) || null; }

  async add({ name, group, subgroup, workflow, from }) {
    if (this.data.presets.length >= MAX) throw bad(`At most ${MAX} saved presets`);
    const wf = cleanGraph(workflow);
    const now = Date.now();
    const p = { id: 'g_' + crypto.randomUUID().slice(0, 10), name: this.#uniqueName(name), ...placement(group, subgroup), workflow: wf, from: typeof from === 'string' ? from.slice(0, 120) : null, createdAt: now, updatedAt: now };
    this.data.presets.push(p);
    await this.#save();
    return p;
  }

  /** patch: { name?, group?, subgroup?, workflow? } */
  async update(id, patch = {}) {
    const p = this.get(id); if (!p) return null;
    if (patch.workflow !== undefined) p.workflow = cleanGraph(patch.workflow);
    if (patch.name !== undefined) { if (!cleanName(patch.name)) throw bad('Name cannot be empty'); p.name = this.#uniqueName(patch.name, p.id); }
    if (patch.group !== undefined || patch.subgroup !== undefined) Object.assign(p, placement(patch.group ?? p.group, patch.subgroup === undefined ? p.subgroup : patch.subgroup));
    p.updatedAt = Date.now();
    await this.#save();
    return p;
  }

  async remove(id) {
    const p = this.get(id); if (!p) return false;
    this.data.presets = this.data.presets.filter((x) => x !== p);
    await this.#save();
    return true;
  }
}
