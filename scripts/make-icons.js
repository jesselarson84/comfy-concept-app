// make-icons.js - draws the PWA icons (dark tile, warm "spark" circle).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from './png.js';
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app', 'icons');
fs.mkdirSync(out, { recursive: true });
function icon(size, maskable) {
  const c = size / 2, r = size * (maskable ? 0.26 : 0.34), ring = size * 0.05;
  return encodePng(size, size, (x, y) => {
    const d = Math.hypot(x - c, y - c);
    if (d < r) { const t = d / r; return [255, Math.round(170 - 60 * t), Math.round(60 + 30 * t)]; }
    if (d < r + ring && d > r + ring * 0.4) return [90, 110, 255];
    return [17, 19, 26];
  });
}
for (const [name, size, m] of [['icon-192.png', 192, false], ['icon-512.png', 512, false], ['maskable-512.png', 512, true]]) fs.writeFileSync(path.join(out, name), icon(size, m));
console.log('icons written to', out);
