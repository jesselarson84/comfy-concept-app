// media.js - tiny real media files for tests (the mock ComfyUI serves these as
// SaveGLB / SaveAudio / SaveVideo results, so the 3D viewer and the audio and video
// players have something real to load). clip.webm: 2 s, 96x64, VP8 (ffmpeg testsrc) - plays in
// the open-source Chromium used by the browser tests, which has no H.264.
import { readFileSync } from 'node:fs';

/** A valid binary glTF (GLB): one untextured cube, 8 vertices, 12 triangles, no normals. */
export function makeGlb() {
  const pos = new Float32Array([-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1]);
  const idx = new Uint16Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 0, 4, 7, 0, 7, 3]);
  const bin = Buffer.concat([Buffer.from(pos.buffer), Buffer.from(idx.buffer)]);
  const json = {
    asset: { version: '2.0', generator: 'comfy-concept-app test' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-1, -1, -1], max: [1, 1, 1] },
      { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.byteLength, target: 34962 }, { buffer: 0, byteOffset: pos.byteLength, byteLength: idx.byteLength, target: 34963 }],
    buffers: [{ byteLength: bin.length }],
  };
  const pad = (b, fill) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4), fill)]) : b);
  const j = pad(Buffer.from(JSON.stringify(json)), 0x20), bb = pad(bin, 0);
  const chunk = (data, type) => { const hdr = Buffer.alloc(8); hdr.writeUInt32LE(data.length, 0); hdr.write(type, 4, 'latin1'); return Buffer.concat([hdr, data]); };
  const body = Buffer.concat([chunk(j, 'JSON'), chunk(bb, 'BIN\0')]);
  const head = Buffer.alloc(12); head.write('glTF', 0, 'latin1'); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([head, body]);
}

/** A mono 16-bit PCM WAV: a tone whose loudness rises then falls. */
export function makeWav(seconds = 2, rate = 8000) {
  const n = Math.round(seconds * rate), data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * Math.sin((Math.PI * i) / n) * 30000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1'); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** A real 2-second video (WebM/VP8). */
export const makeVideo = () => readFileSync(new URL('./clip.webm', import.meta.url));
