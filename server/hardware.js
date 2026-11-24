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

/** Batch 13: GPU use + power state ("32, P8"). */
export function runNvidiaUtilState(timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    execFile('nvidia-smi', ['--query-gpu=utilization.gpu,pstate', '--format=csv,noheader,nounits'], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

/** Batch 13: per-process GPU use for one sample (nvidia-smi pmon). */
export function runNvidiaPmon(timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    execFile('nvidia-smi', ['pmon', '-c', '1', '-s', 'u'], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

/** "32 %, P8" / "32, P8" -> { util: 32, pstate: 8 } (first GPU), or null. */
export function parseUtilState(text) {
  const m = String(text).split(/\r?\n/)[0].match(/(\d+)\s*%?\s*,\s*P(\d+)/i);
  return m ? { util: Number(m[1]), pstate: Number(m[2]) } : null;
}

/** ComfyUI's own processes: its desktop window and its Python. They never count as "busy". */
export const COMFY_PROCESS = /^(comfy|python)/i;

/** pmon text -> [{ pid, name, sm }] for rows with a number (a "-" means no use in that sample). */
export function parsePmon(text) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const p = line.trim().split(/\s+/);
    // gpu pid type sm mem enc dec [jpg ofa] command
    const sm = Number(p[3]);
    if (!Number.isFinite(sm)) continue;
    let k = 3; while (k < p.length && /^(-|\d+)$/.test(p[k])) k++; // the name can contain spaces ("Comfy Desktop.e")
    rows.push({ pid: Number(p[1]), name: p.slice(k).join(' '), sm });
  }
  return rows;
}

/**
 * Batch 13: how busy OTHER programs keep the GPU, in % (or null when unknown).
 *   - the card in a low-power state (P8 or lower power) is idle: 0;
 *   - ComfyUI's own window and Python are left out (its page redraws while it is
 *     on screen and read ~32 % on an idle card);
 *   - if the per-process sample shows nothing, the card total is used.
 */
export async function readGpuBusy({ runState = runNvidiaUtilState, runPmon = runNvidiaPmon } = {}) {
  let s;
  try { s = parseUtilState(await runState()); } catch { return null; }
  if (!s) return null;
  if (s.pstate >= 8 || s.util === 0) return 0;
  let rows = [];
  try { rows = parsePmon(await runPmon()); } catch { return s.util; }
  if (!rows.length) return s.util;
  return Math.min(100, rows.filter((r) => !COMFY_PROCESS.test(r.name)).reduce((a, r) => a + r.sm, 0));
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
