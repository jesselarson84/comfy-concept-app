// prompt-panel.js - the left/top form. Shows only the controls the selected
// preset actually has (from detectControls on the server) and remembers what
// you typed in localStorage, so reopening the app keeps your prompt.
// AI Workflow presets also bring their own clamped settings (manifest params:
// steps, scale, detail...). Steps sits next to Batch and Seed; the other
// settings follow directly on the main screen (no collapsible).
import { h, $ } from './dom.js';
import { randomSeed } from '../lib/seed.js';
import { parseAspect, aspectKey, sizeFor } from '../lib/aspect.js';

const STORE = 'conceptPanel.v1';

export class PromptPanel {
  constructor() {
    this.el = {
      prompt: $('#prompt'), negToggle: $('#neg-toggle'), negRow: $('#neg-row'), negative: $('#negative'),
      msg: $('#preset-msg'), strengthField: $('#strength-field'), strength: $('#strength'), strengthOut: $('#strength-out'),
      aspectField: $('#aspect-field'), aspectSize: $('#aspect-size'), ratio: $('#aspect-ratio'), batch: $('#batch'), batchMinus: $('#batch-minus'), batchPlus: $('#batch-plus'),
      seedField: $('#seed-field'), seedLock: $('#seed-lock'), seed: $('#seed'), seedDice: $('#seed-dice'),
      stepsField: $('#steps-field'), steps: $('#steps'), expose: $('#expose'), params: $('#params'),
    };
    this.state = { prompt: '', negative: '', negOn: false, batch: 4, aspect: '1:1', seedMode: 'random', seed: 0, strength: null, steps: {}, expose: {}, params: {}, ...this.#load() };
    // Saved state from before the ratio chips: square/portrait/landscape -> chips.
    this.state.aspect = aspectKey(parseAspect(this.state.aspect));
    this.state.params ||= {};
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
    // Ratio dropdown (1:1 / 4:3 / 3:2 / 16:9); the orientation toggle beside it is separate.
    e.ratio.addEventListener('change', () => { const a = parseAspect(s.aspect); this.setAspect(aspectKey({ ...a, ratio: e.ratio.value })); });
    document.querySelectorAll('[data-orient]').forEach((b) => b.addEventListener('click', () => {
      const a = parseAspect(s.aspect);
      // Flipping orientation on 1:1 picks the most common non-square ratio.
      this.setAspect(aspectKey({ ratio: a.ratio === '1:1' ? '3:2' : a.ratio, orient: b.dataset.orient }));
    }));
    const setBatch = (n) => { s.batch = Math.max(1, Math.min(this.maxBatch(), n || 1)); e.batch.value = s.batch; this.save(); };
    this.setBatch = setBatch;
    e.batch.addEventListener('change', () => setBatch(Number(e.batch.value)));
    e.batchMinus.addEventListener('click', () => setBatch(s.batch - 1));
    e.batchPlus.addEventListener('click', () => setBatch(s.batch + 1));
    e.seedLock.addEventListener('change', () => { s.seedMode = e.seedLock.checked ? 'locked' : 'random'; this.#paintSeed(); this.save(); });
    e.seed.addEventListener('input', () => { s.seed = Number(e.seed.value) || 0; this.save(); });
    e.seedDice.addEventListener('click', () => { s.seed = randomSeed(); s.seedMode = 'locked'; this.#paint(); this.save(); });
    // Steps is either the preset's "steps" param (AI Workflow presets) or the
    // detected sampler steps of an imported workflow.
    e.steps.addEventListener('input', () => {
      if (!this.wf) return;
      if (this.stepsParam) (s.params[this.wf.id] ||= {}).steps = Number(e.steps.value);
      else s.steps[this.wf.id] = Number(e.steps.value);
      this.save();
    });
  }

  maxBatch() { return Math.min(20, this.wf?.ai?.maxBatch || 20); }

  setAspect(key) { this.state.aspect = aspectKey(parseAspect(key)); this.#paintAspect(); this.save(); }

  #paintSeed() {
    const e = this.el, s = this.state;
    e.seedLock.checked = s.seedMode === 'locked';
    e.seedLock.closest('.toggle')?.classList.toggle('on', s.seedMode === 'locked');
    e.seed.disabled = s.seedMode !== 'locked';
    e.seed.value = s.seed;
  }

  /** Base size of the selected preset (its own latent size, or the manifest's). */
  baseSize() {
    const c = this.wf?.controls, sz = this.wf?.ai?.size;
    if (sz) return sz.base;
    return [c?.defaults?.width || 1024, c?.defaults?.height || 1024];
  }

  #paintAspect() {
    const a = parseAspect(this.state.aspect);
    this.el.ratio.value = a.ratio;
    document.querySelectorAll('[data-orient]').forEach((b) => { const on = a.ratio !== '1:1' && b.dataset.orient === a.orient; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
    const [bw, bh] = this.baseSize();
    const sz = this.clampSize(sizeFor(this.state.aspect, bw, bh, this.wf?.ai?.size?.multiple || 16));
    this.el.aspectSize.textContent = `${sz.width} × ${sz.height}`;
  }

  /** Keep a size inside the preset's allowed range (AI presets only). */
  clampSize({ width, height }) {
    const sz = this.wf?.ai?.size;
    if (!sz) return { width, height };
    const m = sz.multiple || 16;
    const f = (v) => Math.max(m, Math.round(Math.min(sz.max, Math.max(sz.min, v)) / m) * m);
    return { width: f(width), height: f(height) };
  }

  #paint() {
    const e = this.el, s = this.state;
    e.prompt.value = s.prompt; e.negative.value = s.negative;
    e.negToggle.checked = s.negOn;
    e.batch.value = s.batch;
    this.#paintAspect();
    this.#paintSeed();
  }

  /** Show/hide controls for a preset ({ id, label, controls, ok, error, ai?, availability? }). */
  setWorkflow(wf) {
    this.wf = wf;
    const e = this.el, s = this.state, c = wf?.ok ? wf.controls : null;
    const show = (el, on) => { el.hidden = !on; };
    // No description box: only real problems with the selected preset show here
    // (an unusable file, a missing model/node, an imported graph with no controls).
    const msgs = [];
    if (wf && !wf.ok) msgs.push(`This file can't be used: ${wf.error}`);
    else if (wf) {
      const av = wf.availability;
      if (av?.status === 'unavailable') msgs.push(`Unavailable: ${av.reason}`);
      if (c?.message && !wf.ai) msgs.push(c.message);
      if (c && !wf.ai && !wf.user) msgs.push(...c.warnings);
    }
    e.msg.textContent = msgs.join(' ');
    e.msg.hidden = !msgs.length;
    e.msg.classList.toggle('warn', !!msgs.length);
    show(e.prompt.closest('.field'), !!c?.prompt.length || !c);
    show(e.negRow, !!c?.negative.length);
    e.negative.hidden = !(c?.negative.length && s.negOn);
    show(e.strengthField, !!c?.strength.length);
    if (c?.strength.length) {
      const v = s.strength ?? c.defaults.strength ?? 0.75;
      e.strength.value = v; e.strengthOut.textContent = Number(v).toFixed(2);
    }
    show(e.aspectField, !!(c?.width.length && c?.height.length));
    this.#paintAspect();
    show(e.seedField, !!c?.seed.length);
    const sp = wf?.ok ? wf.ai?.params?.steps : null;
    this.stepsParam = sp && sp.type !== 'enum' && sp.type !== 'text' ? sp : null;
    show(e.stepsField, !!(this.stepsParam || c?.steps.length));
    if (this.stepsParam) {
      e.steps.min = this.stepsParam.min ?? 1; e.steps.max = this.stepsParam.max ?? 200;
      e.steps.value = s.params[wf.id]?.steps ?? this.stepsParam.default;
      e.steps.dataset.param = 'steps';
    } else {
      e.steps.min = 1; e.steps.max = 200; delete e.steps.dataset.param;
      if (c?.steps.length) e.steps.value = s.steps[wf.id] ?? c.defaults.steps ?? 4;
    }
    if (s.batch > this.maxBatch()) { s.batch = this.maxBatch(); e.batch.value = s.batch; }
    e.batch.max = this.maxBatch();
    // Preset settings with their allowed ranges.
    e.params.replaceChildren();
    for (const [key, p] of Object.entries(wf?.ai?.params || {})) {
      if (key === 'steps' && this.stepsParam) continue; // shown next to Batch and Seed
      const val = s.params[wf.id]?.[key] ?? p.default;
      let input;
      if (p.type === 'enum') {
        input = h('select', {}, p.options.map((o) => new Option(String(o).replace(/\.(safetensors|pth|gguf)$/, ''), String(o))));
        input.value = String(val);
      } else if (p.type === 'text') input = h('textarea', { rows: 3 }, String(val));
      else input = h('input', { type: 'number', min: p.min, max: p.max, step: p.type === 'int' ? 1 : 'any', value: val, inputmode: p.type === 'int' ? 'numeric' : 'decimal' });
      input.dataset.param = key;
      input.addEventListener(p.type === 'enum' ? 'change' : 'input', () => {
        const v = p.type === 'enum' ? (p.options.find((o) => String(o) === input.value) ?? input.value) : p.type === 'text' ? input.value : Number(input.value);
        (s.params[wf.id] ||= {})[key] = v; this.save();
      });
      e.params.append(h('label.field', {}, h('span.label', {}, p.label), input));
    }
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
    show(e.params, !!e.params.children.length);
    show(e.expose, !!e.expose.children.length);
  }

  /** Values the user chose, for this preset. */
  values() {
    const s = this.state, c = this.wf?.controls;
    return {
      prompt: s.prompt, negative: c?.negative.length && s.negOn ? s.negative : (c?.negative.length ? '' : undefined),
      batch: Math.min(s.batch, this.maxBatch()), aspect: s.aspect, seedMode: s.seedMode, seed: s.seed,
      strength: c?.strength.length ? Number(this.el.strength.value) : undefined,
      steps: c?.steps.length && !this.stepsParam ? Number(this.el.steps.value) : undefined,
      expose: s.expose[this.wf?.id] || {},
      params: { ...(s.params[this.wf?.id] || {}) },
    };
  }

  /** "Reuse" from the viewer: same prompt, locked to the same seed. */
  reuse(meta) {
    const s = this.state;
    if (meta.prompt !== undefined) s.prompt = meta.prompt;
    if (meta.negative) { s.negative = meta.negative; s.negOn = true; }
    if (meta.seed !== undefined && meta.seed !== null) { s.seed = meta.seed; s.seedMode = 'locked'; }
    if (meta.aspect) s.aspect = aspectKey(parseAspect(meta.aspect));
    if (meta.strength !== undefined && meta.strength !== null) s.strength = meta.strength;
    if (meta.params && this.wf && meta.workflow === this.wf.id) s.params[this.wf.id] = { ...meta.params };
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
