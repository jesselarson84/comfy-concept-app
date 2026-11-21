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
export async function startStack({ stepMs = 20, comfyDown = false, ollamaDown = false, gpu = GPU_2080TI, ram = { totalMB: 98204, freeMB: 60000 }, env = {}, memoryFile, ollamaOptions = {} } = {}) {
  const mock = createMockComfy({ stepMs });
  const mockPort = await listen(mock.server);
  const ollama = createMockOllama(ollamaOptions);
  const ollamaPort = await listen(ollama.server);
  const wfDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-wf-'));
  fs.cpSync(path.join(ROOT, 'workflows'), wfDir, { recursive: true }); // presets + actions/
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-data-'));
  const comfyUrl = comfyDown ? 'http://127.0.0.1:9' : `http://127.0.0.1:${mockPort}`;
  // ollamaDown: point at a closed port so the Chat tab shows its offline state.
  const ollamaUrl = ollamaDown ? 'http://127.0.0.1:9' : `http://127.0.0.1:${ollamaPort}`;
  const cfg = loadConfig({ comfyUrl, workflowsDir: wfDir, dataDir, ollamaUrl, ...(memoryFile ? { memoryProfilesFile: memoryFile } : {}) });
  const hw = { gpu, ram };
  const runSmi = async () => { if (!hw.gpu) throw Object.assign(new Error('not found'), { code: 'ENOENT' }); return `${hw.gpu.name}, ${hw.gpu.totalMB}, ${hw.gpu.freeMB}\n`; };
  const fakeOs = { totalmem: () => hw.ram.totalMB * 1048576, freemem: () => hw.ram.freeMB * 1048576 };
  const app = createApp(cfg, { runSmi, os: fakeOs, env });
  const port = await listen(app.server);
  const base = `http://127.0.0.1:${port}`;
  return {
    mock, app, base, mockBase: `http://127.0.0.1:${mockPort}`, wfDir, dataDir, port,
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
