// recorder.js - record a voice line from the microphone (batch 7: voice swap).
// getUserMedia + MediaRecorder; the Android app grants the microphone to the
// server's page only (MainActivity.onPermissionRequest, RECORD_AUDIO).
// No echo cancellation / noise suppression / auto gain: the voice conversion
// should hear the performance as it was (the doc: "record dry").

/** Best container the browser can record (WebView: webm/opus; Safari: mp4). */
export function recordingType(isSupported = (t) => globalThis.MediaRecorder?.isTypeSupported?.(t)) {
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']) if (isSupported(t)) return t;
  return '';
}

const EXT = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a' };
export const extFor = (type) => EXT[String(type).split(';')[0]] || 'webm';

/**
 * Start recording. Returns { stop(): Promise<File>, cancel(), started, level() }.
 * level() is 0..1 (for a meter). Throws a plain message when the mic is refused.
 */
export async function startRecording({ maxSeconds = 300 } = {}) {
  if (!navigator.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) throw new Error('Recording is not supported here');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
  } catch (e) {
    throw new Error(e?.name === 'NotAllowedError' ? 'Microphone not allowed: allow it for Comfy UI in Android settings' : `Microphone not available (${e?.message || e})`);
  }
  const type = recordingType();
  const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
  // level meter
  let analyser = null, buf = null, ctx = null;
  try { ctx = new AudioContext(); analyser = ctx.createAnalyser(); analyser.fftSize = 512; buf = new Uint8Array(analyser.fftSize); ctx.createMediaStreamSource(stream).connect(analyser); } catch {}
  const release = () => { stream.getTracks().forEach((t) => t.stop()); ctx?.close().catch(() => {}); clearTimeout(limit); };
  const done = new Promise((resolve) => { rec.onstop = () => resolve(); });
  rec.start(250);
  const started = Date.now();
  const limit = setTimeout(() => { if (rec.state === 'recording') rec.stop(); }, maxSeconds * 1000);
  return {
    started,
    level() {
      if (!analyser) return 0;
      analyser.getByteTimeDomainData(buf);
      let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      return Math.min(1, peak / 100);
    },
    async stop() {
      if (rec.state === 'recording') rec.stop();
      await done; release();
      const mime = (rec.mimeType || type || 'audio/webm').split(';')[0];
      if (!chunks.length) throw new Error('Nothing was recorded');
      const stamp = new Date(started).toISOString().slice(0, 19).replace(/[-:T]/g, '');
      return new File(chunks, `recording_${stamp}.${extFor(mime)}`, { type: mime });
    },
    cancel() { if (rec.state === 'recording') rec.stop(); release(); },
  };
}
