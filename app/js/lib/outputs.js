// outputs.js - what a finished ComfyUI job produced, from its output dict(s)
// ({ images: [...] } per node, "3d": [...] from SaveGLB/Save3DAdvanced,
// "audio": [...] from SaveAudio*, SaveVideo's images + animated: [true]).
// Shared by the browser (job-queue.js) and the server (history fill-in).
export const VIDEO_EXT = /\.(mp4|webm|mov|mkv|gif)$/i;
export const AUDIO_EXT = /\.(mp3|flac|wav|ogg|opus|m4a)$/i;
export const MODEL3D_EXT = /\.(glb|gltf|obj|ply|stl|fbx|usdz)$/i;

/** { images, files } - images = pictures; files = 3D / video / audio (with kind). */
export function splitOutputs(outputs = {}) {
  const images = [], files = [];
  for (const o of Object.values(outputs || {})) {
    if (!o || typeof o !== 'object') continue;
    const animated = Array.isArray(o.animated) && o.animated[0] === true;
    for (const im of o.images || []) {
      if (animated || VIDEO_EXT.test(im.filename || '')) files.push({ ...im, kind: 'video' });
      else images.push(im);
    }
    for (const v of o.video || o.videos || []) files.push({ ...v, kind: 'video' });
    for (const f of o['3d'] || []) files.push({ ...f, kind: '3d' });
    for (const a of o.audio || []) files.push({ ...a, kind: 'audio' });
  }
  // Pass-through previews (temp) of a graph that also saved a real result are noise.
  const saved = files.length || images.some((i) => i.type !== 'temp');
  return { images: saved ? images.filter((i) => i.type !== 'temp') : images, files };
}

export function fileKind(f) {
  if (!f) return null;
  if (['3d', 'video', 'audio'].includes(f.kind)) return f.kind;
  const n = f.filename || '';
  return VIDEO_EXT.test(n) ? 'video' : AUDIO_EXT.test(n) ? 'audio' : MODEL3D_EXT.test(n) ? '3d' : 'file';
}

/** Short tile label for a non-image result. */
export function fileLabel(f) { return { '3d': '3D ↓', video: 'Video ↓', audio: 'Audio ↓' }[fileKind(f)] || 'File ↓'; }
