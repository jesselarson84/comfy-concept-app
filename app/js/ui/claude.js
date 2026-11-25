// claude.js - batch 16: the Claude pieces of the phone UI (mockups: Main,
// Listening, Applied, Variations, Viewer, FilesSelect, FilesResult).
//   - claudeLogo(): the Claude burst in Claude's clay colour (#D97757);
//   - TalkInput: the rounded input bar (text, small mic, orange send arrow) and
//     the "Listening…" panel; speech sends by itself when you stop talking;
//   - ClaudeSheet (batch 17): Write prompt (the prompt's ⋮) and Ask Claude (the
//     floating button: answers only). One-shot: no chat memory, no Undo;
//   - AskSheet: "Fix this result" (viewer) and "Ask Claude about N pictures"
//     (Files), always Opus;
//   - VariationsSheet: "Added N jobs to the batch — not started".
// Nothing here talks to the API key: requests go to this app's server (/api/claude/ask).
import { h, toast } from './dom.js';
import { speechSupport, listen } from '../lib/speech.js';
import { viewUrl } from '../comfy-client.js';

const SVG = 'http://www.w3.org/2000/svg';
export const CLAY = '#D97757';
export const MODEL_NAMES = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' };

/** The official Claude mark (path from claude.ai/favicon.svg), in Claude's clay colour. */
const CLAUDE_MARK = 'M52.4285 162.873L98.7844 136.879L99.5485 134.602L98.7844 133.334H96.4921L88.7237 132.862L62.2346 132.153L39.3113 131.207L17.0249 130.026L11.4214 128.844L6.2 121.873L6.7094 118.447L11.4214 115.257L18.171 115.847L33.0711 116.911L55.485 118.447L71.6586 119.392L95.728 121.873H99.5485L100.058 120.337L98.7844 119.392L97.7656 118.447L74.5877 102.732L49.4995 86.1905L36.3823 76.62L29.3779 71.7757L25.8121 67.2858L24.2839 57.3608L30.6515 50.2716L39.3113 50.8623L41.4763 51.4531L50.2636 58.1879L68.9842 72.7209L93.4357 90.6804L97.0015 93.6343L98.4374 92.6652L98.6571 91.9801L97.0015 89.2625L83.757 65.2772L69.621 40.8192L63.2534 30.6579L61.5978 24.632C60.9565 22.1032 60.579 20.0111 60.579 17.4246L67.8381 7.49965L71.9133 6.19995L81.7193 7.49965L85.7946 11.0443L91.9074 24.9865L101.714 46.8451L116.996 76.62L121.453 85.4816L123.873 93.6343L124.764 96.1155H126.292V94.6976L127.566 77.9197L129.858 57.3608L132.15 30.8942L132.915 23.4505L136.608 14.4708L143.994 9.62643L149.725 12.344L154.437 19.0788L153.8 23.4505L150.998 41.6463L145.522 70.1215L141.957 89.2625H143.994L146.414 86.7813L156.093 74.0206L172.266 53.698L179.398 45.6635L187.803 36.802L193.152 32.5484H203.34L210.726 43.6549L207.415 55.1159L196.972 68.3492L188.312 79.5739L175.896 96.2095L168.191 109.585L168.882 110.689L170.738 110.53L198.755 104.504L213.91 101.787L231.994 98.7149L240.144 102.496L241.036 106.395L237.852 114.311L218.495 119.037L195.826 123.645L162.07 131.592L161.696 131.893L162.137 132.547L177.36 133.925L183.855 134.279H199.774L229.447 136.524L237.215 141.605L241.8 147.867L241.036 152.711L229.065 158.737L213.019 154.956L175.45 145.977L162.587 142.787H160.805V143.85L171.502 154.366L191.242 172.089L215.82 195.011L217.094 200.682L213.91 205.172L210.599 204.699L188.949 188.394L180.544 181.069L161.696 165.118H160.422V166.772L164.752 173.152L187.803 207.771L188.949 218.405L187.294 221.832L181.308 223.959L174.813 222.777L161.187 203.754L147.305 182.486L136.098 163.345L134.745 164.2L128.075 235.42L125.019 239.082L117.887 241.8L111.902 237.31L108.718 229.984L111.902 215.452L115.722 196.547L118.779 181.541L121.58 162.873L123.291 156.636L123.14 156.219L121.773 156.449L107.699 175.752L86.304 204.699L69.3663 222.777L65.291 224.431L58.2867 220.768L58.9235 214.27L62.8713 208.48L86.304 178.705L100.44 160.155L109.551 149.507L109.462 147.967L108.959 147.924L46.6977 188.512L35.6182 189.93L30.7788 185.44L31.4156 178.115L33.7079 175.752L52.4285 162.873Z';
export function claudeLogo(size = 16) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 248 248'); svg.setAttribute('width', size); svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('claude-logo');
  const p = document.createElementNS(SVG, 'path');
  p.setAttribute('d', CLAUDE_MARK); p.setAttribute('fill', CLAY);
  svg.append(p);
  return svg;
}

/** "about $0.001", "about $0.04", "under $0.001". */
export function fmtCost(usd) {
  const n = Number(usd) || 0;
  if (n < 0.001) return 'under $0.001';
  if (n < 0.01) return `about $${n.toFixed(3)}`;
  if (n < 1) return `about $${n.toFixed(2)}`;
  return `about $${n.toFixed(2)}`;
}

/** "6 takes", "4 variations", "a few versions" in the prompt box -> variations (Opus). */
export const wantsVariations = (text) => /\b(\d+|two|three|four|five|six|seven|eight|nine|ten|twelve|several|a few)\s+(takes|variations|versions|variants|options)\b/i.test(String(text || ''));

/** A picture for Claude: long side about 1024 px, JPEG. -> { media, data (base64) } */
export async function downscale(img, longSide = 1024) {
  const r = await fetch(viewUrl(img));
  if (!r.ok) throw new Error(`Could not load ${img.filename} (${r.status})`);
  const bmp = await createImageBitmap(await r.blob());
  const k = Math.min(1, longSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/jpeg', 0.85);
  return { media: 'image/jpeg', data: url.slice(url.indexOf(',') + 1) };
}

/**
 * The rounded input bar (batch 17): text, a small mic inside the bar and the
 * orange send arrow (lit when there is text). The mic listens and sends by
 * itself when you stop talking; while listening the bar becomes the
 * "Listening…" panel (live words, stop-and-send, Cancel). onSend(text).
 */
export class TalkInput {
  constructor({ placeholder, onSend }) {
    this.onSend = onSend;
    this.speech = speechSupport();
    this.ta = h('textarea.cl-input', { rows: 1, placeholder, 'aria-label': placeholder, enterkeyhint: 'send' });
    this.mic = h('button.cl-mic', { type: 'button', 'aria-label': 'Talk to Claude', title: 'Talk', dataset: { act: 'talk' }, hidden: !this.speech, onclick: () => this.startListening() }, h('i.i.i-mic'));
    this.sendBtn = h('button.cl-send', { type: 'button', 'aria-label': 'Send to Claude', title: 'Send', dataset: { act: 'send' }, onclick: () => this.send() }, h('i.i.i-arrow-up'));
    this.row = h('div.cl-pill', {}, h('label.cl-field', {}, this.ta), this.mic, this.sendBtn);
    this.listenEl = h('div.cl-listen', { hidden: true });
    this.root = h('div.cl-talk', {}, this.row, this.listenEl);
    this.ta.addEventListener('input', () => this.paint());
    this.ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); } });
    this.paint();
  }

  paint() {
    const typed = !!this.ta.value.trim();
    this.sendBtn.disabled = !typed || !!this.isBusy;
    this.sendBtn.classList.toggle('on', typed);
    // grows with the text up to about 5 lines, then scrolls
    this.ta.style.height = 'auto';
    if (this.ta.scrollHeight) this.ta.style.height = `${Math.min(this.ta.scrollHeight, 120)}px`;
  }

  set busy(on) { this.isBusy = !!on; this.ta.disabled = !!on; this.mic.disabled = !!on; this.root.classList.toggle('busy', !!on); this.paint(); }

  send() {
    const t = this.ta.value.trim();
    if (!t || this.isBusy) return;
    this.ta.value = ''; this.paint();
    this.onSend(t);
  }

  startListening() {
    if (!this.speech) return null;
    const words = h('p.cl-words', {}, h('span.muted', {}, 'Listening…'));
    const bars = h('div.cl-bars', { 'aria-hidden': 'true' }, ...Array.from({ length: 11 }, (_, i) => h('i', { style: { animationDelay: `${(i % 5) * 0.12}s` } })));
    const session = listen({
      onPartial: (t) => { words.replaceChildren(`“${t}`, h('span.muted', {}, '…”')); },
      onFinal: (t) => { this.ta.value = t; this.send(); },
      onError: (m) => toast(m, 5000),
      onEnd: () => { this.listenEl.hidden = true; this.row.hidden = false; this.root.classList.remove('listening'); this.session = null; },
    });
    this.session = session;
    this.listenEl.replaceChildren(
      h('div.cl-listen-head', {}, claudeLogo(16), h('b', {}, 'Listening…')),
      bars, words,
      h('div.cl-listen-btns', {},
        h('button.btn.cl-cancel', { type: 'button', dataset: { act: 'cancel-listen' }, onclick: () => session.cancel() }, 'Cancel'),
        h('button.cl-stop', { type: 'button', 'aria-label': 'Stop and send', dataset: { act: 'stop-listen' }, onclick: () => session.stop() }, h('i.cl-square')),
        h('span.cl-flex')),
      h('span.cl-hint', {}, 'Sends by itself when you stop talking. The square sends now; Cancel throws it away.'));
    this.row.hidden = true; this.listenEl.hidden = false;
    this.root.classList.add('listening');
    return session;
  }
}

/** A bottom sheet with a scrim; Escape and a tap on the scrim close it. */
class Sheet {
  show(el) {
    this.close();
    this.scrim = h('div.sheet-scrim', { onclick: () => this.close() });
    this.el = el;
    this.el.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') this.close(); });
    document.body.append(this.scrim, this.el);
  }
  get isOpen() { return !!this.el?.isConnected; }
  close() { this.talk?.session?.cancel?.(); this.scrim?.remove(); this.el?.remove(); this.scrim = this.el = null; }
}

function modelSwitch(get, set) {
  const seg = h('div.cl-seg', { role: 'radiogroup', 'aria-label': 'Model' });
  const paint = () => { for (const b of seg.children) { const on = b.dataset.model === get(); b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); } };
  seg.append(...Object.entries(MODEL_NAMES).map(([k, label]) => h('button', { type: 'button', role: 'radio', dataset: { model: k }, onclick: () => { set(k); paint(); } }, label)));
  paint();
  return seg;
}

/**
 * Batch 17: one sheet for the two quick Claude jobs, one-shot (no chat memory):
 *   prompt   - from the prompt's ⋮ (Write prompt… / Talk prompt): Claude fills in
 *              the form and the sheet closes; the changes are marked orange.
 *   question - from the floating Claude button: answers only, never changes the form.
 * open({ mode, listen, onAsk(text, model) -> reply, onApplied(reply) })
 */
export class ClaudeSheet extends Sheet {
  constructor({ defaultModel = () => 'haiku' } = {}) { super(); this.defaultModel = defaultModel; this.model = null; }

  open({ mode = 'prompt', listen: talkNow = false, onAsk, onApplied }) {
    this.model ||= this.defaultModel();
    const question = mode === 'question';
    const out = h('div.cl-out', { hidden: true });
    const talk = new TalkInput({ placeholder: question ? 'Ask about Comfy…' : 'Tell Claude what you want…', onSend: async (text) => {
      talk.busy = true;
      out.hidden = false;
      out.replaceChildren(h('div.cl-you', {}, text), h('div.cl-wait', {}, claudeLogo(14), h('span', {}, question ? 'Claude is thinking…' : 'Claude is filling in the form…')));
      try {
        const r = await onAsk(text, this.model);
        if (!question && r.actions?.length) { this.close(); await onApplied(r); return; }
        out.replaceChildren(h('div.cl-you', {}, text), h('div.cl-text', {}, r.reply),
          h('span.cl-cost', {}, `${r.modelName || MODEL_NAMES[r.model] || ''} · ${fmtCost(r.costUsd)}${question ? ' · answers only, never changes the form' : ''}`));
      } catch (e) { out.replaceChildren(h('div.cl-you', {}, text), h('div.cl-error', { role: 'alert' }, e.message)); }
      talk.busy = false;
    } });
    const el = h('div.sheet.claude-sheet', { role: 'dialog', 'aria-label': question ? 'Ask Claude' : 'Write prompt', dataset: { mode } },
      h('div.cl-grab', { 'aria-hidden': 'true' }),
      h('div.cl-sheet-head', {}, h('span.cl-title', {}, claudeLogo(18), question ? 'Ask Claude' : 'Write prompt'), modelSwitch(() => this.model, (k) => { this.model = k; })),
      out, talk.root,
      question ? null : h('span.cl-hint', {}, 'Claude fills in the prompt and settings, then stops. You press Run.'));
    this.show(el);
    this.talk = talk;
    if (talkNow && talk.speech) talk.startListening(); else setTimeout(() => talk.ta.focus(), 50);
  }
}

/**
 * "Fix this result" (one picture, from the viewer) or "Ask Claude about N
 * pictures" (Files). Always Opus, one-shot. onAsk(text) -> reply; when Claude
 * changed the form the sheet closes (onDone); a question's answer stays here.
 */
export class AskSheet extends Sheet {
  open({ title, items, mode, onAsk, onDone }) {
    const thumbs = mode === 'fix'
      ? h('div.cl-attach', {}, h('img', { src: viewUrl(items[0].image, { thumb: true }), alt: '' }),
        h('span.cl-attach-t', {}, h('b', {}, 'This picture is attached'), h('small.muted', {}, items[0].line || '')))
      : h('div.cl-picked', {}, ...items.map((it, i) => h('span.cl-pick', {}, h('img', { src: viewUrl(it.image, { thumb: true }), alt: `Picture ${i + 1}` }), h('b', {}, String(i + 1)))));
    const out = h('div.cl-out', { hidden: true });
    const talk = new TalkInput({ placeholder: mode === 'fix' ? 'What’s wrong with it?' : 'What to take from each picture', onSend: async (text) => {
      talk.busy = true;
      out.hidden = false; out.replaceChildren(h('div.cl-wait', {}, claudeLogo(14), h('span', {}, 'Claude is looking…')));
      try {
        const r = await onAsk(text);
        if (r.actions?.length) { this.close(); await onDone(text, r); return; }
        out.replaceChildren(h('div.cl-text', {}, r.reply), h('span.cl-cost', {}, `${r.modelName} · ${fmtCost(r.costUsd)}`));
      } catch (e) { out.replaceChildren(h('div.cl-error', { role: 'alert' }, e.message)); }
      talk.busy = false;
    } });
    const el = h('div.sheet.claude-sheet', { role: 'dialog', 'aria-label': title, dataset: { mode } },
      h('div.cl-grab', { 'aria-hidden': 'true' }),
      h('div.cl-sheet-head', {}, h('span.cl-title', {}, claudeLogo(18), title), h('span.cl-badge', {}, 'Opus · always')),
      thumbs, out, talk.root,
      h('span.cl-hint', {}, mode === 'fix'
        ? 'Claude looks at the picture and its settings and changes the form to fix it. You press Run.'
        : 'Numbers follow the order you tapped them: merge looks, make variations, or ask about them.'));
    this.show(el);
    this.talk = talk;
    setTimeout(() => talk.ta.focus(), 50);
  }
}

/** "Added N jobs to the batch — not started" with Edit per job, Remove all, Open batch. */
export class VariationsSheet {
  open({ rows, cost, onEdit, onRemoveAll, onOpenBatch }) {
    this.close();
    this.scrim = h('div.sheet-scrim', { onclick: () => this.close() });
    this.el = h('div.sheet.claude-sheet.cl-variations', { role: 'dialog', 'aria-label': 'Variations' },
      h('div.cl-sheet-head', {}, h('span.cl-title', {}, claudeLogo(14), `Added ${rows.length} ${rows.length === 1 ? 'job' : 'jobs'} to the batch — not started`)),
      h('span.cl-hint', {}, 'Only what\'s listed changes between jobs. Edit or delete any of them, then start the batch yourself.'),
      h('div.cl-jobs', {}, ...rows.map((r, i) => h('div.cl-job', { dataset: { job: r.ids[0] } },
        h('span.cl-n', {}, String(i + 1)),
        h('span.cl-job-t', {}, h('b', {}, r.label), r.sub ? h('small.muted', {}, r.sub) : null),
        h('button.icon-btn', { type: 'button', 'aria-label': 'Edit job', dataset: { act: 'edit-job' }, onclick: () => { this.close(); onEdit(r, i); } }, h('i.i.i-pencil'))))),
      h('div.cl-sheet-btns', {},
        h('button.btn', { type: 'button', dataset: { act: 'remove-all' }, onclick: async () => { await onRemoveAll(); this.close(); } }, `Remove all ${rows.length}`),
        h('button.btn.cl-strong', { type: 'button', dataset: { act: 'open-batch' }, onclick: () => { this.close(); onOpenBatch(); } }, 'Open batch')),
      h('span.cl-cost.right', {}, `Opus · ${fmtCost(cost)}`));
    document.body.append(this.scrim, this.el);
  }
  close() { this.scrim?.remove(); this.el?.remove(); this.scrim = this.el = null; }
}
