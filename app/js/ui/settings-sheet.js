// settings-sheet.js - batch 16: the app's Settings (gear in the top bar), mockup
// "Settings". Batch 17: General · Reset to defaults when the app closes (this
// device, off by default). Then Claude:
//   Use Claude (off by default; off = every Claude button hidden and nothing sent;
//   turning it on with no key asks for the key first) · this month's spend bar ·
//   Monthly limit ($) · Prompt box starts on Haiku / Sonnet / Opus · API key
//   (entered once, kept on the PC; the phone only ever sees "Saved on your PC").
import { h, toast } from './dom.js';
import * as api from '../api.js';
import { claudeLogo, MODEL_NAMES } from './claude.js';

/** Batch 17: "Reset to defaults when the app closes" (this device only). */
export const RESET_KEY = 'conceptResetOnClose';
export const resetOnClose = () => localStorage.getItem(RESET_KEY) === '1';

const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;
/** "2026-12-01" -> "Dec 1" */
export const shortDate = (iso) => { const d = new Date(`${iso}T12:00:00`); return Number.isNaN(d.getTime()) ? String(iso || '') : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };

export class SettingsSheet {
  /** onChange(status) after anything changed (main shows / hides the Claude buttons). */
  constructor({ button, onChange }) {
    this.onChange = onChange;
    button.addEventListener('click', () => this.open());
  }

  async open({ askKey = false } = {}) {
    this.close();
    try { this.st = await api.getClaude(); } catch (e) { toast(e.message, 6000); return; }
    this.pendingEnable = askKey && !this.st.hasKey;
    this.replacing = askKey && !this.st.hasKey;
    this.scrim = h('div.sheet-scrim', { onclick: () => this.close() });
    this.body = h('div.st-body');
    this.el = h('div.sheet.settings-sheet', { role: 'dialog', 'aria-label': 'Settings' },
      h('div.st-head', {}, h('span', {}, 'Settings'), h('button.btn.icon', { type: 'button', 'aria-label': 'Close', dataset: { act: 'close' }, onclick: () => this.close() }, h('i.i.i-x'))),
      this.body);
    this.el.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.close(); });
    document.body.append(this.scrim, this.el);
    this.paint();
  }

  get isOpen() { return !!this.el?.isConnected; }
  close() { this.scrim?.remove(); this.el?.remove(); this.scrim = this.el = null; }

  async save(patch) {
    try { this.st = await api.setClaude(patch); this.onChange?.(this.st); } catch (e) { toast(e.message, 6000); }
    this.paint();
  }

  paint() {
    const st = this.st;
    if (!this.body) return;
    const on = st.enabled || this.pendingEnable;
    const sw = h('input', { type: 'checkbox', role: 'switch', id: 'st-claude-on', checked: on, 'aria-label': 'Use Claude',
      onchange: () => {
        if (sw.checked && !st.hasKey) { this.pendingEnable = true; this.replacing = true; this.paint(); this.body.querySelector('#st-key')?.focus(); return; }
        this.pendingEnable = false;
        this.save({ enabled: sw.checked });
      } });
    const pct = st.limitUsd > 0 ? Math.min(100, (st.spentUsd / st.limitUsd) * 100) : 100;
    const limit = h('input.st-num', { id: 'st-limit', inputmode: 'decimal', value: String(st.limitUsd), 'aria-label': 'Monthly limit in dollars',
      onchange: () => { const n = Number(String(limit.value).replace(/[$,\s]/g, '')); if (!Number.isFinite(n) || n < 0) { toast('Type an amount in dollars'); limit.value = String(st.limitUsd); return; } this.save({ limitUsd: n }); } });
    const seg = h('div.cl-seg.wide', { role: 'radiogroup', 'aria-label': 'Default model' }, ...Object.entries(MODEL_NAMES).map(([k, label]) => h('button', { type: 'button', role: 'radio', dataset: { model: k }, class: st.defaultModel === k ? 'on' : '', 'aria-checked': String(st.defaultModel === k), onclick: () => this.save({ defaultModel: k }) }, label)));
    let keyRow;
    if (st.hasKey && !this.replacing) {
      keyRow = h('div.st-keyrow', {},
        h('span.st-saved', { dataset: { key: 'saved' } }, h('i.i.i-check'), st.source === 'env' ? 'From ANTHROPIC_API_KEY on your PC' : 'Saved on your PC'),
        h('button.btn', { type: 'button', dataset: { act: 'replace-key' }, onclick: () => { this.replacing = true; this.paint(); this.body.querySelector('#st-key')?.focus(); } }, 'Replace…'));
    } else {
      const input = h('input.st-key', { id: 'st-key', type: 'password', autocomplete: 'off', spellcheck: false, placeholder: 'sk-ant-…', 'aria-label': 'API key' });
      const go = async () => {
        const key = input.value.trim();
        if (!key) { toast('Paste your API key first'); return; }
        try { this.st = await api.setClaudeKey(key); } catch (e) { toast(e.message, 6000); return; }
        input.value = '';
        this.replacing = false;
        if (this.pendingEnable) { this.pendingEnable = false; await this.save({ enabled: true }); toast('Claude is on'); return; }
        this.onChange?.(this.st); this.paint(); toast('Key saved on your PC');
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      keyRow = h('div.st-keyrow', {}, input, h('button.btn.cl-strong', { type: 'button', dataset: { act: 'save-key' }, onclick: go }, 'Save'),
        st.hasKey ? h('button.btn', { type: 'button', onclick: () => { this.replacing = false; this.paint(); } }, 'Cancel') : null);
    }
    const reset = h('input', { type: 'checkbox', role: 'switch', id: 'st-reset', checked: resetOnClose(), 'aria-label': 'Reset to defaults when the app closes',
      onchange: () => { localStorage.setItem(RESET_KEY, reset.checked ? '1' : '0'); toast(reset.checked ? 'The form resets when you close the app' : 'The form is kept when you close the app'); } });
    this.body.replaceChildren(...[
      h('span.st-section', {}, h('i.i.i-settings'), 'General'),
      h('label.st-switch', {}, h('span.st-sw-t', {}, h('b', {}, 'Reset to defaults when the app closes'), h('small', {}, 'Opening the app fresh starts on Z-Image Turbo with an empty prompt and default settings. Switching apps and coming back keeps everything.')), reset),
      h('span.st-section', {}, claudeLogo(14), 'Claude'),
      h('label.st-switch', {}, h('span.st-sw-t', {}, h('b', {}, 'Use Claude'), h('small', {}, 'Off: every Claude button is hidden, and nothing is sent.')), sw),
      this.pendingEnable ? h('p.st-ask', { role: 'alert' }, 'Add your API key below to turn Claude on.') : null,
      h('div.st-row', {}, h('span.st-lbl', {}, 'This month'),
        h('div.st-bar', {}, h('i', { style: { width: `${pct}%` } })),
        h('span.st-spend', {}, h('span', { id: 'st-spent' }, `About ${money(st.spentUsd)} of ${money(st.limitUsd)} used this month`), h('span.muted', {}, `resets ${shortDate(st.resetsOn)}`)),
        st.limitReached ? h('p.st-ask', {}, 'The limit is reached: Claude is paused until then.') : null),
      h('div.st-row', {}, h('label.st-lbl', { for: 'st-limit' }, 'Monthly limit'),
        h('div.st-limit', {}, h('span.muted', {}, '$'), limit, h('small.muted', {}, 'Claude stops answering until next month once this is reached.'))),
      h('div.st-row', {}, h('span.st-lbl', {}, 'Claude starts on'), seg, h('small.muted', {}, 'Fixing a picture, merging, variations and building always use Opus.')),
      h('div.st-row', {}, h('span.st-lbl', {}, 'API key'), keyRow,
        h('small.muted', {}, 'Make it in its own Workspace at platform.claude.com and give that Workspace a limit too, as a backstop.')),
    ].filter(Boolean));
  }
}
