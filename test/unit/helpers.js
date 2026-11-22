// Shared test setup: a mock ComfyUI + the app server on random ports, with
// temp copies of workflows/ and data/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockComfy } from '../mock-comfy.js';
import { createMockOllama } from '../mock-ollama.js';
import { createApp } from '../../server/index.js';
import { loadConfig } from '../../server/config.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

// gpu: { name, totalMB, freeMB } as nvidia-smi would report (default: a 2080 Ti with 4 GB free),
//      or null = no nvidia-smi (falls back to ComfyUI /system_stats).
// ram: { totalMB, freeMB }. env: e.g. { MEMORY_PROFILE: 'large' }. memoryFile: a memory-profiles.json path.
export const GPU_2080TI = { name: 'NVIDIA GeForce RTX 2080 Ti', totalMB: 11264, freeMB: 4000 };
export const GPU_5080 = { name: 'NVIDIA GeForce RTX 5080', totalMB: 16303, freeMB: 9000 };
export async function startStack({ stepMs = 20, comfyDown = false, ollamaDown = false, gpu = GPU_2080TI, ram = { totalMB: 98204, freeMB: 60000 }, env = {}, memoryFile, ollamaOptions = {}, comfyOptions = {}, folderWorkflows = true, legacyFiles = false, data = null, drive = true, outputDir = null, appOptions = {} } = {}) {
  const mock = createMockComfy({ stepMs, ...comfyOptions });
  const mockPort = await listen(mock.server);
  const ollama = createMockOllama(ollamaOptions);
  const ollamaPort = await listen(ollama.server);
  const wfDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-wf-'));
  fs.cpSync(path.join(ROOT, 'workflows'), wfDir, { recursive: true }); // ai/ presets + actions/
  // folderWorkflows: two simple klein workflows as if the user had imported them
  // (they show under My presets). They are the old Fast concept / From reference
  // image graphs, which most of the older tests were written against.
  if (folderWorkflows) for (const f of ['basic-txt2img.json', 'basic-reference.json']) fs.copyFileSync(path.join(ROOT, 'test/fixtures/workflows', f), path.join(wfDir, f));
  // legacyFiles: a live folder that still has the retired preset files (they must stay hidden).
  if (legacyFiles) {
    fs.copyFileSync(path.join(ROOT, 'test/fixtures/workflows/basic-txt2img.json'), path.join(wfDir, 'fast-concept.json'));
    fs.copyFileSync(path.join(ROOT, 'test/fixtures/workflows/basic-reference.json'), path.join(wfDir, 'from-reference-image.json'));
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-data-'));
  // data: { 'history.json': {...}, 'chats.json': {...} } pre-existing saved state (old shapes).
  if (data) for (const [f, v] of Object.entries(data)) fs.writeFileSync(path.join(dataDir, f), typeof v === 'string' ? v : JSON.stringify(v, null, 1));
  const comfyUrl = comfyDown ? 'http://127.0.0.1:9' : `http://127.0.0.1:${mockPort}`;
  // ollamaDown: point at a closed port so the Chat tab shows its offline state.
  const ollamaUrl = ollamaDown ? 'http://127.0.0.1:9' : `http://127.0.0.1:${ollamaPort}`;
  // Save to Drive never touches a real drive in tests: a temp "Q:" with (drive:
  // true) or without (drive: false) its "My Drive" folder.
  const driveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-drive-'));
  if (drive) fs.mkdirSync(path.join(driveRoot, 'My Drive'));
  const driveDir = path.join(driveRoot, 'My Drive', 'Comfy UI');
  // outputDir: a temp ComfyUI output folder for "From Comfy UI" (else none: history only).
  const cfg = loadConfig({ comfyUrl, workflowsDir: wfDir, dataDir, ollamaUrl, driveDir, comfyOutputDir: outputDir || '', ...(memoryFile ? { memoryProfilesFile: memoryFile } : {}) });
  const hw = { gpu, ram };
  const runSmi = async () => { if (!hw.gpu) throw Object.assign(new Error('not found'), { code: 'ENOENT' }); return `${hw.gpu.name}, ${hw.gpu.totalMB}, ${hw.gpu.freeMB}\n`; };
  const fakeOs = { totalmem: () => hw.ram.totalMB * 1048576, freemem: () => hw.ram.freeMB * 1048576 };
  // appOptions: test seams of createApp (e.g. { unlink } to simulate a locked file).
  const app = createApp(cfg, { runSmi, os: fakeOs, env, ...appOptions });
  const port = await listen(app.server);
  const base = `http://127.0.0.1:${port}`;
  return {
    mock, app, base, mockBase: `http://127.0.0.1:${mockPort}`, wfDir, dataDir, port, driveRoot, driveDir,
    ollama, ollamaBase: `http://127.0.0.1:${ollamaPort}`, hw,
    async close() {
      app.server.closeAllConnections?.(); mock.server.closeAllConnections?.(); ollama.server.closeAllConnections?.();
      await new Promise((r) => app.server.close(r)); await new Promise((r) => mock.server.close(r)); await new Promise((r) => ollama.server.close(r));
    },
  };
}

export function pngBytes() {
  // 1x1 PNG
  return Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc0000003010100c9fe92ef0000000049454e44ae426082', 'hex');
}
