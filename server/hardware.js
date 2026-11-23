// hardware.js - what GPU and how much RAM this PC has, detected (never hardcoded).
//   GPU: nvidia-smi --query-gpu=name,memory.total,memory.free (MiB); if that is
//        missing or fails, ComfyUI's /system_stats (devices[0]).
//   RAM: os.totalmem() / os.freemem().
// Results are cached for a couple of seconds; detect({ fresh: true }) re-reads.
import { execFile } from 'node:child_process';
import nodeOs from 'node:os';

const MiB = 1024 * 1024;

export function runNvidiaSmi(timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    execFile('nvidia-smi', ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

/** Batch 9: GPU utilisation in % (the History tagger stays off the GPU while it is busy). */
export function runNvidiaUtil(timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    execFile('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

/** "NVIDIA GeForce RTX 2080 Ti, 11264, 1328" lines -> [{ name, totalMB, freeMB }] */
export function parseNvidiaSmi(text) {
  return String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const parts = l.split(',').map((x) => x.trim());
    const freeMB = Number(parts.pop()), totalMB = Number(parts.pop());
    return { name: parts.join(','), totalMB, freeMB };
  }).filter((g) => g.name && Number.isFinite(g.totalMB) && Number.isFinite(g.freeMB));
}

/** ComfyUI /system_stats -> { name, totalMB, freeMB } (first CUDA device). */
export function fromSystemStats(stats) {
  const d = (stats?.devices || []).find((x) => x.type === 'cuda') || stats?.devices?.[0];
  if (!d || !(d.vram_total > 0)) return null;
  const name = String(d.name || 'GPU').replace(/^cuda:\d+\s*/, '').replace(/\s*:\s*\w+$/, '').trim();
  return { name, totalMB: Math.round(d.vram_total / MiB), freeMB: Math.round((d.vram_free ?? 0) / MiB) };
}

export function createHardware({ getComfyUrl, runSmi = runNvidiaSmi, os = nodeOs, cacheMs = 2000 } = {}) {
  let cache = null;
  async function detect({ fresh = false } = {}) {
    if (!fresh && cache && Date.now() - cache.t < cacheMs) return cache.v;
    let gpu = null, gpus = [], source = 'none', error;
    try {
      gpus = parseNvidiaSmi(await runSmi());
      if (gpus.length) { gpu = gpus[0]; source = 'nvidia-smi'; }
    } catch (e) { error = 'nvidia-smi: ' + (e.code || e.message); }
    if (!gpu && getComfyUrl) {
      try {
        const r = await fetch(getComfyUrl() + '/system_stats', { signal: AbortSignal.timeout(2000) });
        gpu = fromSystemStats(await r.json());
        if (gpu) { source = 'comfyui'; gpus = [gpu]; }
      } catch (e) { error = (error ? error + '; ' : '') + 'ComfyUI: ' + e.message; }
    }
    if (gpu) gpu = { ...gpu, usedMB: gpu.totalMB - gpu.freeMB, source };
    const v = {
      gpu, gpus, error: gpu ? undefined : error,
      ram: { totalMB: Math.round(os.totalmem() / MiB), freeMB: Math.round(os.freemem() / MiB) },
      at: Date.now(),
    };
    cache = { t: Date.now(), v };
    return v;
  }
  return { detect };
}
