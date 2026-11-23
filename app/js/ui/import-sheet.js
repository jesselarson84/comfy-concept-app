// import-sheet.js - the Import button in the top bar (batch 7, "Camera import").
// Bring in a photo, a video or a voice recording - taken live (camera / camcorder
// through the system camera app, microphone in the app) or picked from the
// device - then "What next?" lists only the presets that take that kind of
// file, and the picked one gets it in its slot.
import { h, toast } from './dom.js';
import { startRecording } from '../lib/recorder.js';

/** Kind of an imported file: image | video | audio (null = not usable). */
export function kindOf(file) {
  const t = String(file?.type || ''), n = String(file?.name || '').toLowerCase();
  // the type first: a microphone recording is audio/webm, and .webm is also a video extension
  for (const k of ['image', 'video', 'audio']) if (t.startsWith(`${k}/`)) return k;
  if (/\.(png|jpe?g|webp|heic|gif|bmp)$/.test(n)) return 'image';
  if (/\.(mp4|mov|webm|mkv|3gp)$/.test(n)) return 'video';
  if (/\.(wav|mp3|m4a|ogg|opus|flac|aac)$/.test(n)) return 'audio';
  return null;
}

/** Presets that take a file of this kind (usable ones only). */
export function presetsFor(kind, workflows, usable = (w) => w.ok) {
  return workflows.filter((w) => usable(w) && (kind === 'image' ? !!w.controls?.images?.length : (w.ai?.inputs || []).some((s) => s.kind === kind)));
}

export class ImportSheet {
  /** @param o.upload(file) -> ref   @param o.onImported({ kind, ref, file }) */
  constructor({ button, upload, onImported }) {
    Object.assign(this, { button, upload, onImported });
    button.addEventListener('click', () => this.open());
    const input = (accept, capture) => h('input', { type: 'file', accept, ...(capture ? { capture } : {}), hidden: true, onchange: (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) this.take(f); } });
    this.inputs = { photo: input('image/*', 'environment'), video: input('video/*', 'environment'), device: input('image/*,video/*'), audioFile: input('audio/*') };
    document.body.append(...Object.values(this.inputs));
  }

  open() {
    if (this.el) return;
    const row = (act, icon, label, sub, fn) => h('button.sheet-row', { type: 'button', dataset: { act }, onclick: () => { this.close(); fn(); } }, h(`i.i.${icon}`), h('span', {}, label, h('small.muted', {}, sub)));
    this.scrim = h('div.sheet-scrim', { onclick: () => this.close() });
    this.el = h('div.sheet.import-sheet', { role: 'dialog', 'aria-label': 'Import' }, h('div.sheet-title', {}, 'Import'),
      row('photo', 'i-image-plus', 'Take a photo', 'Camera', () => this.inputs.photo.click()),
      row('video', 'i-video', 'Record a video', 'Camera', () => this.inputs.video.click()),
      row('record', 'i-audio-lines', 'Record audio', 'Microphone, e.g. a voice line', () => this.record()),
      row('device', 'i-folder', 'Photo or video from this device', 'Gallery or files', () => this.inputs.device.click()),
      row('audio-file', 'i-music', 'Audio file from this device', 'WAV, MP3, M4A …', () => this.inputs.audioFile.click()));
    document.body.append(this.scrim, this.el);
  }

  close() { this.scrim?.remove(); this.el?.remove(); this.scrim = this.el = null; }

  /** Upload, then hand over to "What next?". */
  async take(file) {
    const kind = kindOf(file);
    if (!kind) return toast('That file type cannot be used here');
    this.button.classList.add('busy');
    try {
      const ref = await this.upload(file);
      await this.onImported({ kind, ref, file });
    } catch (e) { toast(e.message, 6000); } finally { this.button.classList.remove('busy'); }
  }

  /** In-app microphone recording with a level meter and a timer. */
  async record() {
    let rec;
    try { rec = await startRecording(); } catch (e) { return toast(e.message, 7000); }
    const meter = h('span.rec-meter', {}, h('span.rec-level'));
    const time = h('span.rec-time', {}, '0:00');
    const stop = h('button.btn.primary', { type: 'button', dataset: { act: 'stop' } }, h('i.i.i-pause'), 'Stop');
    const cancel = h('button.btn', { type: 'button', dataset: { act: 'cancel' } }, 'Cancel');
    const scrim = h('div.sheet-scrim');
    const box = h('div.sheet.rec-sheet', { role: 'dialog', 'aria-label': 'Recording' },
      h('div.sheet-title', {}, h('span.rec-dot'), 'Recording'), h('div.rec-row', {}, meter, time),
      h('p.muted', {}, 'Quiet room, phone a few inches from your mouth, slightly to the side.'),
      h('div.sp-actions', {}, cancel, stop));
    document.body.append(scrim, box);
    const tick = setInterval(() => {
      const s = Math.floor((Date.now() - rec.started) / 1000);
      time.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      meter.firstChild.style.width = `${Math.round(rec.level() * 100)}%`;
    }, 100);
    const end = () => { clearInterval(tick); scrim.remove(); box.remove(); };
    cancel.onclick = () => { rec.cancel(); end(); };
    stop.onclick = async () => { end(); try { await this.take(await rec.stop()); } catch (e) { toast(e.message, 6000); } };
  }
}
