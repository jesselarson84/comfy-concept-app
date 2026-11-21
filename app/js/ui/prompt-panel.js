// prompt-panel.js - the left/top form. Shows only the controls the selected
// preset actually has (from detectControls on the server) and remembers what
// you typed in localStorage, so reopening the app keeps your prompt.
import { h, $ } from './dom.js';
import { randomSeed } from '../lib/seed.js';

const STORE = 'conceptPanel.v1';

export class PromptPanel {
  constructor() {
    this.el = {
      prompt: $('#prompt'), negToggle: $('#neg-toggle'), negRow: $('#neg-row'), negative: $('#negative'),
      msg: $('#preset-msg'), strengthField: $('#strength-field'), strength: $('#strength'), strengthOut: $('#strength-out'),
      aspectField: $('#aspect-field'), batch: $('#batch'), batchMinus: $('#batch-minus'), batchPlus: $('#batch-plus'),
      seedField: $('#seed-field'), seedLock: $('#seed-lock'), seed: $('#seed'), seedDice: $('#seed-dice'),
      stepsField: $('#steps-field'), steps: $('#steps'), expose: $('#expose'), more: $('#more'),
    };
    this.state = { prompt: '', negative: '', negOn: false, batch: 4, aspect: 'square', seedMode: 'random', seed: 0, strength: null, steps: {}, expose: {}, ...this.#load() };
    this.#wire();
    this.#paint();
  }

  #load() { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; } }
  save() { localStorage.setItem(STORE, JSON.stringify(this.state)); }

  #wire() {
    const e = this.el, s = this.state;
    e.prompt.addEventListener('input', () => { s.prompt = e.prompt.value; this.save(); });
    e.negative.addEventListener('input', () => { s.negative = e.negative.value; this.save(); });
    e.negToggle.addEventListener('change', () => { s.negOn = e.negToggle.checked; e.negative.hidden = !s.negOn; this.save(); });
    e.strength.addEventListener('input', () => { s.strength = Number(e.strength.value); e.strengthOut.textContent = s.strength.toFixed(2); this.save(); });
    document.querySelectorAll('input[name=aspect]').forEach((r) => r.addEventListener('change', () => { s.aspect = r.value; this.save(); }));
    const setBatch = (n) => { s.batch = Math.max(1, Math.min(20, n || 1)); e.batch.value = s.batch; this.save(); };
    e.batch.addEventListener('change', () => setBatch(Number(e.batch.value)));
    e.batchMinus.addEventListener('click', () => setBatch(s.batch - 1));
    e.batchPlus.addEventListener('click', () => setBatch(s.batch + 1));
    e.seedLock.addEventListener('change', () => { s.seedMode = e.seedLock.checked ? 'locked' : 'random'; this.#paintSeed(); this.save(); });
    e.seed.addEventListener('input', () => { s.seed = Number(e.seed.value) || 0; this.save(); });
    e.seedDice.addEventListener('click', () => { s.seed = randomSeed(); s.seedMode = 'locked'; this.#paint(); this.save(); });
    e.steps.addEventListener('input', () => { if (this.wf) { s.steps[this.wf.id] = Number(e.steps.value); this.save(); } });
  }

  #paintSeed() {
    const e = this.el, s = this.state;
    e.seedLock.checked = s.seedMode === 'locked';
    e.seed.disabled = s.seedMode !== 'locked';
    e.seed.value = s.seed;
  }

  #paint() {
    const e = this.el, s = this.state;
    e.prompt.value = s.prompt; e.negative.value = s.negative;
    e.negToggle.checked = s.negOn;
    e.batch.value = s.batch;
    document.querySelectorAll('input[name=aspect]').forEach((r) => { r.checked = r.value === s.aspect; });
    this.#paintSeed();
  }

  /** Show/hide controls for a preset ({ id, label, controls, ok, error }). */
  setWorkflow(wf) {
    this.wf = wf;
    const e = this.el, s = this.state, c = wf?.ok ? wf.controls : null;
    const show = (el, on) => { el.hidden = !on; };
    const msgs = [];
    if (!wf) msgs.push('No presets found. Put API-format .json files in the workflows folder.');
    else if (!wf.ok) msgs.push(`This file can't be used: ${wf.error}`);
    else { if (c.message) msgs.push(c.message); msgs.push(...c.warnings); }
    e.msg.textContent = msgs.join(' ');
    e.msg.hidden = !msgs.length;
    show(e.prompt.closest('.field'), !!c?.prompt.length || !c);
    show(e.negRow, !!c?.negative.length);
    e.negative.hidden = !(c?.negative.length && s.negOn);
    show(e.strengthField, !!c?.strength.length);
    if (c?.strength.length) {
      const v = s.strength ?? c.defaults.strength ?? 0.75;
      e.strength.value = v; e.strengthOut.textContent = Number(v).toFixed(2);
    }
    show(e.aspectField, !!(c?.width.length && c?.height.length));
    show(e.seedField, !!c?.seed.length);
    show(e.stepsField, !!c?.steps.length);
    if (c?.steps.length) e.steps.value = s.steps[wf.id] ?? c.defaults.steps ?? 4;
    // Generic "#expose" controls.
    e.expose.replaceChildren();
    for (const x of c?.expose || []) {
      const key = `${x.node}.${x.input}`;
      const val = s.expose[wf.id]?.[key] ?? x.value;
      const input = x.type === 'boolean' ? h('input', { type: 'checkbox', checked: !!val })
        : x.type === 'number' ? h('input', { type: 'number', step: 'any', value: val })
          : h('input', { type: 'text', value: val });
      input.addEventListener('input', () => {
        (s.expose[wf.id] ||= {})[key] = x.type === 'boolean' ? input.checked : x.type === 'number' ? Number(input.value) : input.value;
        this.save();
      });
      e.expose.append(h('label.field', {}, h('span.label', {}, x.label), input));
    }
    show(e.more, !!(c?.steps.length || c?.expose.length));
  }

  /** Values the user chose, for this preset. */
  values() {
    const s = this.state, c = this.wf?.controls;
    return {
      prompt: s.prompt, negative: c?.negative.length && s.negOn ? s.negative : (c?.negative.length ? '' : undefined),
      batch: s.batch, aspect: s.aspect, seedMode: s.seedMode, seed: s.seed,
      strength: c?.strength.length ? Number(this.el.strength.value) : undefined,
      steps: c?.steps.length ? Number(this.el.steps.value) : undefined,
      expose: s.expose[this.wf?.id] || {},
    };
  }

  /** "Reuse" from the viewer: same prompt, locked to the same seed. */
  reuse(meta) {
    const s = this.state;
    if (meta.prompt !== undefined) s.prompt = meta.prompt;
    if (meta.negative) { s.negative = meta.negative; s.negOn = true; }
    if (meta.seed !== undefined && meta.seed !== null) { s.seed = meta.seed; s.seedMode = 'locked'; }
    if (meta.aspect) s.aspect = meta.aspect;
    if (meta.strength !== undefined && meta.strength !== null) s.strength = meta.strength;
    this.#paint(); this.save();
    if (this.wf) this.setWorkflow(this.wf);
  }

  setPrompt(text) { this.state.prompt = text; this.#paint(); this.save(); }

  /** Chat / Versions: set the negative text (shown only if the preset has one). */
  setNegative(text) { this.state.negative = text ?? ''; this.#paint(); this.save(); }

  /** Chat "Apply + Generate": seed = number locks it, undefined = random. */
  setSeed(seed) {
    if (seed === undefined || seed === null) this.state.seedMode = 'random';
    else { this.state.seed = Number(seed); this.state.seedMode = 'locked'; }
    this.#paint(); this.save();
  }
}
