// check-models.mjs - which model files the app's presets need are missing
// (the list is config/models.json), and optionally download them.
//
//   node scripts/check-models.mjs                      check every model
//   node scripts/check-models.mjs --required           only the minimum to start (Z-Image Turbo)
//   node scripts/check-models.mjs --preset qwen-edit-2511,klein-4b-edit
//   node scripts/check-models.mjs --download           also download what is missing
//   node scripts/check-models.mjs --models-dir "D:\ComfyUI\models"
//   node scripts/check-models.mjs --comfy http://127.0.0.1:8188
//   node scripts/check-models.mjs --json               machine-readable result
//
// A file counts as present when the running ComfyUI lists it (GET /models/<folder>,
// so extra model folders count too) or it is on disk in the models folder.
// ComfyUI: --comfy, else COMFY_URL, else http://127.0.0.1:8188 (skipped if not running).
// Models folder (where downloads go): --models-dir, else COMFY_MODELS_DIR, else
// Comfy Desktop's default %LOCALAPPDATA%\Comfy-Desktop\ComfyUI-Shared\models.
// Exit code: 0 = nothing missing, 1 = something missing, 2 = bad input.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** ComfyUI also reads these older folder names (e.g. GGUF files in models/unet). */
const ALIASES = { diffusion_models: ['unet'], text_encoders: ['clip'] };
const norm = (p) => String(p).replace(/\\/g, '/');

export function loadModels(file = path.join(ROOT, 'config/models.json')) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).models;
}

export function defaultModelsDir(env = process.env) {
  if (env.COMFY_MODELS_DIR) return env.COMFY_MODELS_DIR;
  if (env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, 'Comfy-Desktop', 'ComfyUI-Shared', 'models');
  return null;
}

/** The models to look at: all, the required ones, or those of some presets (ids with or without "ai:"). */
export function pickModels(models, { required = false, presets = [] } = {}) {
  const want = new Set(presets.map((p) => String(p).replace(/^ai:/, '')));
  return models.filter((m) => (!required || m.required) && (!want.size || m.presets.some((p) => want.has(p))));
}

/** What the running ComfyUI lists: { key -> Set of paths } for the folders asked, or null if it is not reachable. */
export async function comfyListing(comfyUrl, keys) {
  const out = {};
  try {
    for (const k of new Set(keys)) {
      const r = await fetch(`${comfyUrl.replace(/\/$/, '')}/models/${encodeURIComponent(k)}`, { signal: AbortSignal.timeout(8000) });
      out[k] = new Set(r.ok ? (await r.json()).map(norm) : []);
    }
  } catch { return null; }
  return out;
}

/** -> [{ ...model, path (where it is, or where it goes), present }] */
export function checkModels(models, modelsDir, listing = null) {
  return models.map((m) => {
    const [top, ...rest] = m.folder.split('/');
    const comfy = norm(m.comfy || [m.folder, m.file].join('/')).split('/');
    const listed = !!listing && [comfy[0], ...(ALIASES[comfy[0]] || [])].some((k) => listing[k]?.has(comfy.slice(1).join('/')));
    const where = modelsDir ? [top, ...(ALIASES[top] || [])].map((f) => path.join(modelsDir, f, ...rest, m.file)) : [];
    const found = where.find((p) => fs.existsSync(p));
    return { ...m, path: found || where[0] || null, present: listed || !!found };
  });
}

async function download(m, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  const r = await fetch(m.url, { redirect: 'follow' });
  if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
  await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest); // only a finished download gets the real name
}

function parseArgs(argv) {
  const o = { required: false, presets: [], download: false, json: false, modelsDir: null, comfy: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--required') o.required = true;
    else if (a === '--download') o.download = true;
    else if (a === '--json') o.json = true;
    else if (a === '--preset') o.presets.push(...String(argv[++i] || '').split(',').filter(Boolean));
    else if (a === '--models-dir') o.modelsDir = argv[++i];
    else if (a === '--comfy') o.comfy = argv[++i];
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`Unknown option ${a} (try --help)`);
  }
  return o;
}

async function main() {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  if (o.help) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n')); return; }
  let dir = o.modelsDir || defaultModelsDir();
  if (dir && !fs.existsSync(dir)) { if (o.modelsDir) { console.error(`Models folder not found: ${dir}`); process.exit(2); } dir = null; }
  const picked = pickModels(loadModels(), o);
  if (!picked.length) { console.error('No models match.'); process.exit(2); }
  const comfyUrl = o.comfy || process.env.COMFY_URL || 'http://127.0.0.1:8188';
  const listing = await comfyListing(comfyUrl, picked.map((m) => norm(m.comfy || m.folder).split('/')[0]).flatMap((k) => [k, ...(ALIASES[k] || [])]));
  if (!listing && !dir) { console.error(`ComfyUI is not running at ${comfyUrl} and no models folder was found. Start ComfyUI or pass --models-dir "<path to ComfyUI>\\models".`); process.exit(2); }
  let rows = checkModels(picked, dir, listing);
  if (o.download) {
    if (!dir) { console.error('--download needs the models folder: pass --models-dir.'); process.exit(2); }
    for (const m of rows.filter((x) => !x.present)) {
      if (m.gated) { if (!o.json) console.log(`SKIP  ${m.folder}/${m.file}: needs a Hugging Face sign-in, download it in the browser: ${m.url}`); continue; }
      if (!o.json) console.log(`GET   ${m.folder}/${m.file} ...`);
      try { await download(m, m.path); m.present = true; } catch (e) { m.error = e.message; if (!o.json) console.log(`FAIL  ${m.folder}/${m.file}: ${e.message}`); }
    }
  }
  const missing = rows.filter((m) => !m.present);
  const from = [listing ? `ComfyUI at ${comfyUrl}` : null, dir].filter(Boolean).join(' + ');
  if (o.json) {
    console.log(JSON.stringify({ checkedIn: from, checked: rows.length, missing: missing.map(({ file, folder, url, presets, required, gated, error }) => ({ file, folder, url, presets, required: !!required, gated: !!gated, error })) }, null, 1));
  } else {
    for (const m of rows) console.log(`${m.present ? 'OK   ' : 'MISS '} ${m.folder}/${m.file}${m.present ? '' : `\n      ${m.url}${m.note ? `\n      ${m.note}` : ''}`}`);
    console.log(`\n${rows.length - missing.length} of ${rows.length} present (checked ${from}).${missing.length ? ` ${missing.length} missing${o.download ? '' : ' (add --download to fetch them)'}.` : ''}`);
  }
  process.exit(missing.length ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
