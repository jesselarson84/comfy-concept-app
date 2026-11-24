// video-player.js - in-app player for video results (Wan, video upscales):
// play/pause, scrub bar, duration, loop toggle; ⋮ = Save… (Drive or phone), Share.
// Streams from ComfyUI's /view with a plain <video> element (inline on
// Android, no browser controls, so it matches the audio player).
import { h } from './dom.js';
import { viewUrl } from '../comfy-client.js';
import { Overlay, overlayTop } from './overlay.js';
import { fileMoreButton } from './action-menu.js';
import { fmtTime } from './audio-player.js';

const LOOP_KEY = 'conceptVideo.loop';

export class VideoPlayer {
  /** hooks: { onSave(file) (Drive or this phone), onShare(file) } - the ⋮ menu (batch 10) */
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.ov = new Overlay('video-player', 'Video player');
    this.ov.onClose = () => this.#stop();
    this.state = 'closed';
    const v = (this.video = h('video.vp-video', { playsInline: true, preload: 'metadata' }));
    v.setAttribute('playsinline', '');
    v.loop = this.loop = localStorage.getItem(LOOP_KEY) !== '0';
    this.status = h('div.mv-status');
    this.playBtn = h('button.btn.ap-play', { type: 'button', 'aria-label': 'Play', onclick: () => this.toggle() }, h('i.i.i-play'));
    this.loopBtn = h('button.btn.vp-loop', { type: 'button', 'aria-label': 'Loop', title: 'Loop', onclick: () => this.setLoop(!this.loop) }, h('i.i.i-repeat'));
    this.scrub = h('input.ap-scrub', { type: 'range', min: 0, max: 0, step: 0.01, value: 0, 'aria-label': 'Position' });
    this.time = h('span.ap-time', {}, '0:00 / 0:00');
    this.top = overlayTop('', () => this.close(), fileMoreButton(() => this.file, this.hooks));
    this.ov.root.append(this.top,
      h('div.vp-stage', { onclick: () => this.toggle() }, v, this.status),
      h('div.ov-bottom', {},
        this.scrub,
        h('div.ap-row', {}, this.playBtn, this.time, h('span.spacer'), this.loopBtn)));
    for (const ev of ['loadedmetadata', 'durationchange', 'timeupdate', 'play', 'pause', 'ended', 'seeked']) v.addEventListener(ev, () => this.#paint());
    v.addEventListener('loadeddata', () => { if (this.state === 'loading') { this.state = 'ready'; this.status.hidden = true; } });
    v.addEventListener('error', () => { if (this.state !== 'closed' && v.getAttribute('src')) { this.state = 'error'; this.status.textContent = 'This video cannot be played here. Download it instead.'; this.status.hidden = false; } });
    this.scrub.addEventListener('input', () => { v.currentTime = Number(this.scrub.value); this.#paint(); });
    this.#paintLoop();
  }

  get root() { return this.ov.root; }
  get duration() { const d = this.video.duration; return Number.isFinite(d) && d > 0 ? d : 0; }

  close() { this.ov.close(); }

  open(file) {
    this.#stop();
    this.file = file;
    this.top.setTitle(file.filename);
    this.state = 'loading';
    this.status.textContent = 'Loading…'; this.status.hidden = false;
    this.video.src = viewUrl(file);
    this.video.load();
    this.ov.show();
    this.#paint();
  }

  toggle() { const v = this.video; if (v.paused || v.ended) v.play().catch(() => {}); else v.pause(); }

  setLoop(on) {
    this.loop = this.video.loop = !!on;
    localStorage.setItem(LOOP_KEY, on ? '1' : '0');
    this.#paintLoop();
  }

  #paintLoop() {
    this.loopBtn.classList.toggle('on', this.loop);
    this.loopBtn.setAttribute('aria-pressed', String(this.loop));
  }

  #paint() {
    const v = this.video, d = this.duration;
    this.scrub.max = String(d);
    this.scrub.value = String(v.currentTime || 0);
    this.time.textContent = `${fmtTime(v.currentTime)} / ${fmtTime(d)}`;
    const playing = !v.paused && !v.ended;
    this.playBtn.replaceChildren(h(`i.i.${playing ? 'i-pause' : 'i-play'}`));
    this.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  #stop() {
    this.state = 'closed';
    try { this.video.pause(); } catch {}
    this.video.removeAttribute('src');
    try { this.video.load(); } catch {}
  }
}
