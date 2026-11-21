// seed.js - seeds for a batch of N jobs.
// Random: each job gets a fresh random seed.
// Locked: job i gets seed+i, so a batch is reproducible and job 0 is exactly
// the locked seed (re-running a favourite reproduces it).
export const MAX_SEED = 2 ** 48; // well inside JS's exact-integer range

export function randomSeed() {
  // crypto.getRandomValues exists in browsers and in Node 22.
  const a = new Uint32Array(2);
  globalThis.crypto.getRandomValues(a);
  return (a[0] * 65536 + (a[1] & 0xffff)) % MAX_SEED;
}

export function batchSeeds(count, mode, lockedSeed) {
  const n = Math.max(1, Math.min(20, Math.floor(count) || 1));
  if (mode === 'locked') {
    const base = Math.floor(Number(lockedSeed) || 0);
    return Array.from({ length: n }, (_, i) => (base + i) % MAX_SEED);
  }
  return Array.from({ length: n }, () => randomSeed());
}
