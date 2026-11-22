// audio-player.js - in-app player for audio results (Chatterbox, VibeVoice,
// ACE-Step): play/pause, scrub bar, waveform, duration, Download and Save to
// Drive. Playback streams from ComfyUI's /view with a plain <audio> element;
// the waveform is drawn from the decoded file (Web Audio decodeAudioData).
import { h } from './dom.js';
import { viewUrl } from '../comfy-client.js';
import { Overlay, overlayTop } from './overlay.js';

/** "m:ss" (or "h:mm:ss"). */
export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60), m = Math.floor(sec / 60) % 60, hh = Math.floor(sec / 3600);
  return hh ? `${hh}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** Peak (max |sample|) per bucket over all channels, 0..1. */
export function peaks(channels, buckets) {
  const n = channels[0]?.length || 0, out = new Float32Array(buckets);
  if (!n) return out;
  const step = n / buckets;
  for (let b = 0; b < buckets; b++) {
    const a = Math.floor(b * step), z = Math.max(a + 1, Math.floor((b + 1) * step));
    let m = 0;
    for (const ch of channels) for (let i = a; i < z && i < n; i++) { const v = Math.abs(ch[i]); if (v > m) m = v; }
    out[b] = Math.min(1, m);
  }
  return out;
}

export class AudioPlayer {
  /** hooks: { onDownload(file), onSaveToDrive(file) } */
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.ov = new Overlay('audio-player', 'Audio player');
    this.ov.onClose = () => this.#stop();
    this.audio = new Audio();
    this.audio.preload = 'metadata';
    this.canvas = h('canvas.ap-wave', { 'aria-hidden': 'true' });
    this.playBtn = h('button.btn.ap-play', { type: 'button', 'aria-label': 'Play', onclick: () => this.toggle() }, h('i.i.i-play'));
    this.scrub = h('input.ap-scrub', { type: 'range', min: 0, max: 0, step: 0.01, value: 0, 'aria-label': 'Position' });
    this.time = h('span.ap-time', {}, '0:00 / 0:00');
    this.caption = h('div.ap-caption');
    this.top = overlayTop('', () => this.close());
    this.ov.root.append(this.top,
      h('div.ap-body', {},
        h('div.ap-icon', {}, h('i.i.i-volume-2')),
        this.caption,
        h('div.ap-wave-wrap', { onpointerdown: (e) => this.#seekFromWave(e) }, this.canvas),
        this.scrub,
        h('div.ap-row', {}, this.playBtn, this.time),
        h('div.ov-actions', {},
          h('button.btn', { type: 'button', dataset: { act: 'download' }, onclick: () => this.file && this.hooks.onDownload?.(this.file) }, h('i.i.i-download'), 'Download'),
          h('button.btn', { type: 'button', dataset: { act: 'drive' }, onclick: () => this.file && this.hooks.onSaveToDrive?.(this.file) }, h('i.i.i-cloud-upload'), 'Save to Drive'))));
    const a = this.audio;
    a.addEventListener('loadedmetadata', () => this.#paint());
    a.addEventListener('durationchange', () => this.#paint());
    a.addEventListener('timeupdate', () => this.#paint());
    a.addEventListener('play', () => this.#paint());
    a.addEventListener('pause', () => this.#paint());
    a.addEventListener('ended', () => this.#paint());
    this.scrub.addEventListener('input', () => { a.currentTime = Number(this.scrub.value); this.#paint(); });
    this.ro = new ResizeObserver(() => this.#draw());
    this.ro.observe(this.canvas);
  }

  get root() { return this.ov.root; }
  get duration() { const d = this.audio.duration; return Number.isFinite(d) && d > 0 ? d : (this.decodedDuration || 0); }

  close() { this.ov.close(); }

  open(file, meta = {}) {
    this.#stop();
    this.file = file;
    this.top.setTitle(file.filename);
    this.caption.textContent = meta.prompt || '';
    this.peaks = null; this.decodedDuration = 0; this.waveState = 'loading';
    this.audio.src = viewUrl(file);
    this.audio.load();
    this.ov.show();
    this.#paint();
    this.#loadWave(file);
  }

  toggle() { if (this.audio.paused) this.audio.play().catch(() => {}); else this.audio.pause(); }

  async #loadWave(file) {
    const token = (this.token = {});
    try {
      const buf = await (await fetch(viewUrl(file))).arrayBuffer();
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      try {
        const audio = await ctx.decodeAudioData(buf);
        if (token !== this.token) return;
        const chans = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i));
        this.peaks = peaks(chans, 400);
        this.decodedDuration = audio.duration;
        this.waveState = 'ready';
      } finally { ctx.close?.(); }
    } catch {
      if (token === this.token) this.waveState = 'error';
    }
    if (token === this.token) this.#paint();
  }

  #seekFromWave(e) {
    const r = this.canvas.getBoundingClientRect(), d = this.duration;
    if (!d || !r.width) return;
    this.audio.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * d;
    this.#paint();
  }

  #paint() {
    const a = this.audio, d = this.duration;
    this.scrub.max = String(d || 0);
    this.scrub.value = String(a.currentTime || 0);
    this.time.textContent = `${fmtTime(a.currentTime)} / ${fmtTime(d)}`;
    const playing = !a.paused && !a.ended;
    this.playBtn.replaceChildren(h(`i.i.${playing ? 'i-pause' : 'i-play'}`));
    this.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    this.playBtn.classList.toggle('on', playing);
    this.#draw();
  }

  #draw() {
    const c = this.canvas, dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(c.clientWidth * dpr)), hh = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== hh) { c.width = w; c.height = hh; }
    const g = c.getContext('2d');
    g.clearRect(0, 0, w, hh);
    const p = this.peaks, d = this.duration, at = d ? (this.audio.currentTime || 0) / d : 0;
    const bars = Math.max(1, Math.floor(w / (3 * dpr)));
    for (let i = 0; i < bars; i++) {
      const v = p ? p[Math.min(p.length - 1, Math.floor((i / bars) * p.length))] : 0;
      const bh = Math.max(2 * dpr, v * hh * 0.92);
      g.fillStyle = i / bars < at ? '#ffffff' : '#55565e';
      g.fillRect(i * 3 * dpr, (hh - bh) / 2, 2 * dpr, bh);
    }
  }

  #stop() {
    this.token = null;
    try { this.audio.pause(); } catch {}
    this.audio.removeAttribute('src');
    try { this.audio.load(); } catch {}
  }
}
