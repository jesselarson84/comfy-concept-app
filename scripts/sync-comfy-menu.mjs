// sync-comfy-menu.mjs - rebuilds ComfyUI's right-click "AI Models" / "AI Workflows"
// menus (comfyui/ComfyUI-AIWorkflowMenu) from the app's presets, and optionally
// installs the pack into ComfyUI.
//
//   node scripts/sync-comfy-menu.mjs                       rebuild the manifest in this repo
//   node scripts/sync-comfy-menu.mjs --install <custom_nodes folder>
//                                                          ... and copy the pack there
//
// Menus follow the app's picker: every preset in workflows/ai goes under its
// kind's menu at its menuPath ("Image/Text to Image/Z-Image Turbo"). Model
// presets that came from one of the pack's hand-laid-out UI-format files keep
// that file (named in the preset's "source"); everything else is opened from an
// API-format copy of the preset's graph (web/workflows/api/<id>.json). Entries
// of the pack that no preset uses (e.g. MoGe) stay in AI Models as they were.
// After installing, reload the ComfyUI page (no restart needed: web files only).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePreset, GROUPS, WORKFLOW_GROUPS } from '../app/js/lib/presets.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACK = path.join(ROOT, 'comfyui/ComfyUI-AIWorkflowMenu');
const WEB = path.join(PACK, 'web/workflows');

/** Pack files written by an earlier sync: everything under api/. */
const isGenerated = (file) => file.startsWith('api/');

export function buildManifest({ presets, packEntries }) {
  const entries = [];
  const usedFiles = new Set();
  const apiFiles = {};
  for (const p of presets) {
    const m = p.manifest;
    const ui = packEntries.find((e) => !isGenerated(e.file) && m.source.includes(e.file));
    const menu = m.kind === 'workflow' ? 'workflows' : 'models';
    if (ui) usedFiles.add(ui.file);
    const file = ui ? ui.file : `api/${p.id}.json`;
    if (!ui) apiFiles[file] = p.workflow;
    // folders = section (+ sub section); a "/" inside the name itself ("Text/Image to
    // Video") would read as one more folder, so it becomes a fraction slash.
    const folders = [m.group, ...(m.subgroup ? [m.subgroup] : [])];
    const leaf = m.menuPath.split('/').slice(folders.length).join('/').replace(/ \(needs download\)$/, '').replace(/\//g, '⁄');
    entries.push({ menu, path: [...folders, leaf].join('/'), file, format: ui ? 'ui' : 'api', preset: `ai:${p.id}`, order: m.menuOrder });
  }
  // the pack's own entries no preset uses stay in AI Models
  for (const e of packEntries) if (!isGenerated(e.file) && !usedFiles.has(e.file) && !entries.some((x) => x.file === e.file)) entries.push({ menu: 'models', path: e.path, file: e.file, format: 'ui', order: 999 });
  const groupOrder = (menu) => (menu === 'workflows' ? WORKFLOW_GROUPS : GROUPS);
  entries.sort((a, b) => a.menu.localeCompare(b.menu) || groupOrder(a.menu).indexOf(a.path.split('/')[0]) - groupOrder(b.menu).indexOf(b.path.split('/')[0]) || a.path.split('/').slice(0, -1).join('/').localeCompare(b.path.split('/').slice(0, -1).join('/')) || a.order - b.order);
  return {
    manifest: {
      version: 2,
      menus: [
        { key: 'models', label: 'AI Models', groups: GROUPS },
        { key: 'workflows', label: 'AI Workflows', groups: WORKFLOW_GROUPS },
      ],
      entries: entries.map(({ order, ...e }) => e),
    },
    apiFiles,
  };
}

function main() {
  const dir = path.join(ROOT, 'workflows/ai');
  const presets = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => validatePreset(f.slice(0, -5), JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))))
    .filter((p) => { if (!p.ok) console.warn(`skipped ${p.id}: ${p.error}`); return p.ok; });
  const old = JSON.parse(fs.readFileSync(path.join(WEB, 'manifest.json'), 'utf8'));
  const { manifest, apiFiles } = buildManifest({ presets, packEntries: old.entries || [] });
  fs.rmSync(path.join(WEB, 'api'), { recursive: true, force: true });
  fs.mkdirSync(path.join(WEB, 'api'), { recursive: true });
  for (const [file, wf] of Object.entries(apiFiles)) fs.writeFileSync(path.join(WEB, file), JSON.stringify(wf, null, 1) + '\n');
  fs.writeFileSync(path.join(WEB, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const n = (k) => manifest.entries.filter((e) => e.menu === k).length;
  console.log(`AI Models: ${n('models')} entries, AI Workflows: ${n('workflows')} entries (${Object.keys(apiFiles).length} API-format files)`);
  const i = process.argv.indexOf('--install');
  if (i > 0) {
    const target = path.join(process.argv[i + 1], 'ComfyUI-AIWorkflowMenu');
    fs.cpSync(PACK, target, { recursive: true, force: true });
    // drop generated files the repo no longer has
    const keep = new Set(fs.readdirSync(path.join(WEB, 'api')));
    const tApi = path.join(target, 'web/workflows/api');
    for (const f of fs.readdirSync(tApi)) if (!keep.has(f)) fs.rmSync(path.join(tApi, f));
    console.log(`installed into ${target} - reload the ComfyUI page`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
