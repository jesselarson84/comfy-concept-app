// claude.js - batch 16: the Claude pieces of the phone UI (mockups: Main,
// Listening, Applied, Variations, Viewer, FilesSelect, FilesResult).
//   - claudeLogo(): the Claude burst in Claude's clay colour (#D97757);
//   - TalkInput: a text box + one round button (mic when empty, send arrow
//     when there is text) and the "Listening…" panel (live words, stop-and-send,
//     Cancel); speech sends by itself when you stop talking;
//   - ClaudeBox: the box under Negative prompt (model switch, the chat's last
//     exchange with "Changed N things", one Undo, cost · model, Start over);
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

/** The Claude burst (hand-drawn, as in the approved mockups; no official asset is bundled offline). */
export function claudeLogo(size = 16) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', size); svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', CLAY); svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('claude-logo');
  const p = document.createElementNS(SVG, 'path');
  p.setAttribute('stroke-width', '2.6'); p.setAttribute('stroke-linecap', 'round');
  p.setAttribute('d', 'M12 12V2.6M12 12v9.4M12 12H2.6M12 12h9.4M12 12L5.4 5.4M12 12l6.6 6.6M12 12l6.6-6.6M12 12l-6.6 6.6M12 12L8.4 3.3M12 12l3.6 8.7M12 12l8.7-3.6M12 12l-8.7 3.6');
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

/** Mic / send button + the listening panel, for a text box. onSend(text). */
export class TalkInput {
  constructor({ placeholder, rows = 2, onSend, big = true }) {
    this.onSend = onSend;
    this.speech = speechSupport();
    this.ta = h('textarea.cl-input', { rows, placeholder, 'aria-label': placeholder, enterkeyhint: 'send' });
    this.btn = h(`button.cl-mic${big ? '' : '.small'}`, { type: 'button', dataset: { act: 'talk' } });
    this.row = h('div.cl-row', {}, h('label.cl-field', {}, this.ta), this.btn);
    this.listenEl = h('div.cl-listen', { hidden: true });
    this.root = h('div.cl-talk', {}, this.row, this.listenEl);
    this.ta.addEventListener('input', () => this.paint());
    this.ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); } });
    this.btn.addEventListener('click', () => (this.ta.value.trim() || !this.speech ? this.send() : this.startListening()));
    this.paint();
  }

  paint() {
    const typed = !!this.ta.value.trim();
    // no recognizer: no mic (keyboard dictation still works); the button only sends
    this.btn.hidden = !typed && !this.speech;
    this.btn.replaceChildren(h(`i.i.${typed || !this.speech ? 'i-arrow-up' : 'i-mic'}`));
    this.btn.setAttribute('aria-label', typed || !this.speech ? 'Send to Claude' : 'Talk to Claude');
    this.btn.classList.toggle('send', typed);
  }

  set busy(on) { this.ta.disabled = !!on; this.btn.disabled = !!on; this.root.classList.toggle('busy', !!on); }

  send() {
    const t = this.ta.value.trim();
    if (!t) return;
    this.ta.value = ''; this.paint();
    this.onSend(t);
  }

  startListening() {
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
      h('div.cl-listen-head', {}, claudeLogo(16), h('b', {}, 'Listening…'), h('span.spacer'), this.badge ? h('span.cl-badge', {}, this.badge()) : null),
      bars, words,
      h('div.cl-listen-btns', {},
        h('button.btn.cl-cancel', { type: 'button', dataset: { act: 'cancel-listen' }, onclick: () => session.cancel() }, 'Cancel'),
        h('button.cl-stop', { type: 'button', 'aria-label': 'Stop and send', dataset: { act: 'stop-listen' }, onclick: () => session.stop() }, h('i.cl-square')),
        h('span.cl-flex')),
      h('span.cl-hint', {}, 'Sends by itself when you stop talking (about a second of quiet). The square sends now; Cancel throws it away.'));
    this.row.hidden = true; this.listenEl.hidden = false;
    this.root.classList.add('listening');
  }
}

/** Human list of what a reply changed (the app fills `changed` while applying). */
export function changeLine(changed) { return changed.join(' · '); }

/**
 * The Claude box on the form. hooks:
 *   ask({ text, model, memory }) -> server reply   (main decides mode / pictures)
 *   apply(reply) -> { changed: [..labels], undo: fn | null }
 */
export class ClaudeBox {
  constructor(host, { ask, apply, defaultModel = () => 'haiku' }) {
    Object.assign(this, { host, askFn: ask, apply, defaultModel });
    this.memory = [];      // this app session only (never saved)
    this.model = defaultModel();
    this.seg = h('div.cl-seg', { role: 'radiogroup', 'aria-label': 'Model' }, ...Object.entries(MODEL_NAMES).map(([k, label]) => h('button', { type: 'button', role: 'radio', dataset: { model: k }, onclick: () => this.setModel(k) }, label)));
    this.log = h('div.cl-log');
    this.talk = new TalkInput({ placeholder: 'Tell Claude what you want…', onSend: (t) => this.send(t) });
    this.talk.badge = () => MODEL_NAMES[this.model];
    this.hint = h('span.cl-hint', {}, this.talk.speech ? 'Tap the mic and say it — it sends when you stop. Fills the prompt and settings; you press Run.' : 'Fills the prompt and settings; you press Run.');
    this.foot = h('span.cl-hint.cl-mem', { hidden: true }, 'Remembers this chat until you close the app. ', h('button.link', { type: 'button', dataset: { act: 'start-over' }, onclick: () => this.startOver() }, 'Start over'));
    this.root = h('div.claude-box', { id: 'claude-box', role: 'group', 'aria-label': 'Claude' },
      h('div.cl-head', {}, h('span.cl-title', {}, claudeLogo(16), 'Claude'), this.seg),
      this.log, this.talk.root, this.hint, this.foot);
    host.replaceChildren(this.root);
    this.setModel(this.model);
  }

  setModel(k) { this.model = k; for (const b of this.seg.children) { const on = b.dataset.model === k; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); } }

  startOver() { this.memory = []; this.log.replaceChildren(); this.foot.hidden = true; this.talk.ta.placeholder = 'Tell Claude what you want…'; }

  async send(text) {
    const bubble = h('div.cl-you', {}, text);
    const wait = h('div.cl-wait', {}, claudeLogo(14), h('span', {}, 'Claude is working…'));
    this.log.replaceChildren(bubble, wait);
    this.talk.busy = true;
    let r;
    try { r = await this.askFn({ text, model: this.model, memory: this.memory.slice() }); } catch (e) {
      this.talk.busy = false;
      wait.replaceWith(h('div.cl-error', { role: 'alert' }, e.message));
      return null;
    }
    this.talk.busy = false;
    this.show(text, r);
    return r;
  }

  /** Show a reply (also used when Fix / Files answers land on the form). */
  async show(text, r, { applied } = {}) {
    const res = applied || await this.apply(r);
    const changed = res?.changed || [];
    this.memory.push({ role: 'user', text }, { role: 'assistant', text: `${r.reply}${changed.length ? ` [Changed: ${changed.join('; ')}]` : ''}` });
    const head = changed.length ? h('span.cl-reply-head', {}, claudeLogo(14), `Changed ${changed.length} ${changed.length === 1 ? 'thing' : 'things'}`) : h('span.cl-reply-head', {}, claudeLogo(14), 'Claude');
    const undo = res?.undo ? h('button.btn.cl-undo', { type: 'button', dataset: { act: 'undo' }, onclick: async () => { undo.disabled = true; await res.undo(); undo.replaceChildren(h('i.i.i-check'), 'Undone'); } }, h('i.i.i-rotate-ccw'), 'Undo') : null;
    this.log.replaceChildren(
      h('div.cl-you', {}, text),
      h('div.cl-reply', {}, head,
        changed.length ? h('span.cl-changes', {}, changeLine(changed)) : null,
        h('span.cl-text', {}, r.reply),
        ...(res?.extra || []),
        h('div.cl-reply-foot', {}, undo, h('span.cl-cost', {}, `${r.modelName || MODEL_NAMES[r.model] || ''} · ${fmtCost(r.costUsd)}`))));
    this.foot.hidden = false;
    this.talk.ta.placeholder = 'Now make it…';
    return res;
  }
}

/**
 * "Fix this result" (one picture, from the viewer) or "Ask Claude about N
 * pictures" (Files). Always Opus. onAsk(text) -> reply; the sheet closes when
 * Claude changed the form, and stays open with the answer for a question.
 */
export class AskSheet {
  open({ title, items, mode, onAsk, onDone }) {
    this.close();
    const thumbs = mode === 'fix'
      ? h('div.cl-attach', {}, h('img', { src: viewUrl(items[0].image, { thumb: true }), alt: '' }),
        h('span.cl-attach-t', {}, h('b', {}, 'This picture is attached'), h('small.muted', {}, items[0].line || '')))
      : h('div.cl-picked', {}, ...items.map((it, i) => h('span.cl-pick', {}, h('img', { src: viewUrl(it.image, { thumb: true }), alt: `Picture ${i + 1}` }), h('b', {}, String(i + 1)))));
    const answer = h('div.cl-answer', { hidden: true });
    const talk = new TalkInput({ placeholder: mode === 'fix' ? 'What\'s wrong with it?' : 'What to take from each picture', rows: mode === 'fix' ? 2 : 3, onSend: async (text) => {
      talk.busy = true;
      answer.hidden = false; answer.replaceChildren(h('div.cl-wait', {}, claudeLogo(14), h('span', {}, 'Claude is looking…')));
      try {
        const r = await onAsk(text);
        if (r.actions?.length) { this.close(); await onDone(text, r); return; }
        answer.replaceChildren(h('span.cl-text', {}, r.reply), h('span.cl-cost', {}, `${r.modelName} · ${fmtCost(r.costUsd)}`));
      } catch (e) { answer.replaceChildren(h('div.cl-error', { role: 'alert' }, e.message)); }
      talk.busy = false;
    } });
    talk.badge = () => 'Opus';
    this.scrim = h('div.sheet-scrim', { onclick: () => this.close() });
    this.el = h('div.sheet.claude-sheet', { role: 'dialog', 'aria-label': title, dataset: { mode } },
      h('div.cl-sheet-head', {}, h('span.cl-title', {}, claudeLogo(16), title), h('span.cl-badge', {}, 'Opus · always')),
      thumbs, talk.root, answer,
      h('span.cl-hint', {}, mode === 'fix'
        ? 'Claude looks at the picture and its settings, changes the form to fix it (same seed unless it says otherwise), and takes you back to the form. Or just ask a question: it answers without changing anything.'
        : 'Numbers follow the order you tapped them. Works for merging looks, variations of one picture, or a question about all of them.'));
    this.el.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') this.close(); });
    document.body.append(this.scrim, this.el);
    setTimeout(() => talk.ta.focus(), 50);
  }
  get isOpen() { return !!this.el?.isConnected; }
  close() { this.scrim?.remove(); this.el?.remove(); this.scrim = this.el = null; }
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
