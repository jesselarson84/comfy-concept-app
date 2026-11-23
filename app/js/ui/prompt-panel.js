// prompt-panel.js - the left/top form. Shows only the controls the selected
// preset actually has (from detectControls on the server) and remembers what
// you typed in localStorage, so reopening the app keeps your prompt.
// Layout (batch 3, the owner Nov 22 10:17): the open row holds Aspect (+orientation
// and the size readout), Batch and Seed (full row). Every other setting sits in
// one "Settings" twirl-down (collapsed by default, open state remembered), in a
// 2-column grid: steppers for small integer ranges, gray-fill sliders for
// floats, compact dropdowns for lists, segmented Off/On for switches; group
// titles for long sets; settings that don't apply are dimmed (manifest hints in
// lib/presets.js). Lyrics (manifest "open") stay a visible text box.
import { h, $ } from './dom.js';
import { randomSeed } from '../lib/seed.js';
import { parseAspect, aspectKey, sizeFor, RATIOS } from '../lib/aspect.js';
import { resolutionApplies, renderSize, finalSize, normRes } from '../lib/resolution.js';
import { controlFor, formatParam, paramRange, paramActive } from '../lib/presets.js';
import { infoFor } from '../lib/setting-info.js';
import { infoButton } from './info-tip.js';

const STORE = 'conceptPanel.v1';
const OPEN_KEY = 'conceptSettingsOpen';
const pct = (v, min, max) => `${max > min ? Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100)) : 0}%`;
const decimals = (st) => (st >= 1 ? 0 : String(st).split('.')[1]?.length || 2);

export class PromptPanel {
  constructor() {
    this.el = {
      prompt: $('#prompt'), negToggle: $('#neg-toggle'), negRow: $('#neg-row'), negative: $('#negative'),
      msg: $('#preset-msg'), strengthField: $('#strength-field'), strength: $('#strength'), strengthOut: $('#strength-out'),
      aspectField: $('#aspect-field'), aspectSize: $('#aspect-size'), ratio: $('#aspect-ratio'), orientSeg: $('#orient-seg'), resSelect: $('#res-select'), res: $('#aspect-res'), batch: $('#batch'), batchMinus: $('#batch-minus'), batchPlus: $('#batch-plus'),
      seedField: $('#seed-field'), seedLock: $('#seed-lock'), seed: $('#seed'), seedDice: $('#seed-dice'),
      params: $('#params'), paramsOpen: $('#params-open'), settings: $('#settings'), batchField: $('#batch-field'),
    };
    this.state = { prompt: '', negative: '', negOn: false, batch: 4, aspect: '1:1', res: '1k', seedMode: 'random', seed: 0, strength: null, steps: {}, expose: {}, params: {}, ...this.#load() };
    // Saved state from before the ratio chips: square/portrait/landscape -> chips.
    this.state.aspect = aspectKey(parseAspect(this.state.aspect));
    this.state.res = normRes(this.state.res);
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
    // Orientation only swaps the ratio's numbers (16:9 <-> 9:16); it never picks
    // another ratio. On 1:1 there is nothing to swap, so the buttons are hidden.
    document.querySelectorAll('[data-orient]').forEach((b) => b.addEventListener('click', () => {
      const a = parseAspect(s.aspect);
      if (a.ratio === '1:1') return;
      this.setAspect(aspectKey({ ratio: a.ratio, orient: b.dataset.orient }));
    }));
    e.res.addEventListener('change', () => { s.res = normRes(e.res.value); this.#paintAspect(); this.save(); });
    const setBatch = (n) => { s.batch = Math.max(1, Math.min(this.maxBatch(), n || 1)); e.batch.value = s.batch; this.save(); };
    this.setBatch = setBatch;
    e.batch.addEventListener('change', () => setBatch(Number(e.batch.value)));
    e.batchMinus.addEventListener('click', () => setBatch(s.batch - 1));
    e.batchPlus.addEventListener('click', () => setBatch(s.batch + 1));
    e.seedLock.addEventListener('change', () => { s.seedMode = e.seedLock.checked ? 'locked' : 'random'; this.#paintSeed(); this.save(); });
    e.seed.addEventListener('input', () => { s.seed = Number(e.seed.value) || 0; this.save(); });
    e.seedDice.addEventListener('click', () => { s.seed = randomSeed(); s.seedMode = 'locked'; this.#paint(); this.save(); });
    // The Settings twirl-down: collapsed by default, open state remembered on this device.
    e.settings.open = localStorage.getItem(OPEN_KEY) === '1';
    e.settings.addEventListener('toggle', () => localStorage.setItem(OPEN_KEY, e.settings.open ? '1' : '0'));
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
    const a = parseAspect(this.state.aspect), e = this.el;
    e.ratio.value = a.ratio;
    // The dropdown shows the ratio the way it will come out: 9:16 in portrait.
    for (const o of e.ratio.options) {
      const [x, y] = RATIOS[o.value] || [1, 1];
      o.textContent = a.orient === 'portrait' && x !== y ? `${Math.min(x, y)}:${Math.max(x, y)}` : `${Math.max(x, y)}:${Math.min(x, y)}`;
    }
    e.orientSeg.hidden = a.ratio === '1:1';
    document.querySelectorAll('[data-orient]').forEach((b) => { const on = a.ratio !== '1:1' && b.dataset.orient === a.orient; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
    const res = this.usesResolution();
    e.resSelect.hidden = !res;
    e.res.value = this.state.res;
    const sz = this.renderSize();
    const shown = res ? finalSize(this.state.aspect, this.state.res, this.wf?.ai?.size?.multiple || 16) : sz;
    e.aspectSize.textContent = `${shown.width} × ${shown.height}`;
  }

  /** The 1K / 2K / 4K picker is shown (text-to-image presets with a size block). */
  usesResolution() { return resolutionApplies(this.wf); }

  /** The size the sampler renders at (before a 4K upscale). */
  renderSize() {
    const m = this.wf?.ai?.size?.multiple || 16;
    if (this.usesResolution()) return this.clampSize(renderSize(this.state.aspect, this.state.res, m));
    const [bw, bh] = this.baseSize();
    return this.clampSize(sizeFor(this.state.aspect, bw, bh, m));
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
      if (c && !wf.ai && !wf.user && !wf.graph) msgs.push(...c.warnings);
    }
    e.msg.textContent = msgs.join(' ');
    e.msg.hidden = !msgs.length;
    e.msg.classList.toggle('warn', !!msgs.length);
    this.#staticInfo();
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
    if (s.batch > this.maxBatch()) { s.batch = this.maxBatch(); e.batch.value = s.batch; }
    e.batch.max = this.maxBatch();
    // Batch stays visible but grayed for presets that make one result per run.
    const one = this.maxBatch() <= 1;
    e.batchField.classList.toggle('is-off', one);
    e.batchField.querySelector('.stepper').classList.toggle('is-off', one);
    for (const el of [e.batch, e.batchMinus, e.batchPlus]) el.disabled = one;
    this.renderSettings();
  }

  /** (i) buttons of the fixed controls; texts can differ per preset (manifest info). */
  #staticInfo() {
    const e = this.el, m = this.wf?.ok ? this.wf.ai : null;
    const spots = [
      ['prompt', e.prompt.closest('.field').querySelector('.label'), 'Prompt'],
      ['negative', e.negRow, 'Negative prompt'],
      ['aspect', e.aspectField.querySelector('.label'), 'Aspect'],
      ['batch', e.batchField.querySelector('.label'), 'Batch'],
      ['seed', e.seedField.querySelector('.label'), 'Seed'],
      ['strength', e.strengthField.querySelector('.label'), 'Strength'],
    ];
    for (const [key, spot, label] of spots) {
      spot.querySelector(':scope > .info-btn')?.remove();
      const b = infoButton(label, infoFor(key, { manifest: m }));
      if (!b) continue;
      const first = spot.firstElementChild;
      if (first) first.after(b); else spot.append(b);
      b.dataset.key = key;
    }
  }

  /** Current value of every manifest param of the preset (stored or default). */
  paramValues() {
    const wf = this.wf, s = this.state;
    const ps = wf?.ok ? wf.ai?.params || {} : {};
    const stored = s.params[wf?.id] || {};
    const out = {};
    for (const [k, p] of Object.entries(ps)) if (!p.modes) out[k] = stored[k] ?? p.default;
    for (const [k, p] of Object.entries(ps)) if (p.modes) { const r = paramRange(p, out); out[k] = Math.min(r.max, Math.max(r.min, stored[k] ?? r.default)); }
    return out;
  }

  setParam(key, v) {
    const wf = this.wf, s = this.state;
    const ps = wf.ai.params;
    const bag = (s.params[wf.id] ||= {});
    bag[key] = v;
    // Settings whose range follows this one go back to that mode's default.
    let rerender = false;
    for (const [k, p] of Object.entries(ps)) {
      if (p.modes?.param === key) { delete bag[k]; rerender = true; }
      if (p.when?.param === key) rerender = true;
    }
    this.save();
    if (rerender) this.renderSettings();
  }

  /** Builds the Settings grid (and the open text boxes, e.g. Lyrics). */
  renderSettings() {
    const e = this.el, s = this.state, wf = this.wf;
    const c = wf?.ok ? wf.controls : null;
    const ps = wf?.ok ? wf.ai?.params || {} : {};
    const vals = this.paramValues();
    e.params.replaceChildren(); e.paramsOpen.replaceChildren();
    let group = null;
    const add = (el, p) => {
      if (p?.group && p.group !== group) { group = p.group; e.params.append(h('div.sg-h', {}, p.group)); }
      e.params.append(el);
    };
    // Steps of an imported workflow (detected sampler steps).
    if (c?.steps.length && !ps.steps) {
      const v = s.steps[wf.id] ?? c.defaults.steps ?? 4;
      add(this.#stepper({ label: 'Steps', info: infoFor('steps'), min: 1, max: 200, step: 1, value: v, id: 'steps', onChange: (n) => { s.steps[wf.id] = n; this.save(); } }));
    }
    for (const [key, p] of Object.entries(ps)) {
      const active = paramActive(p, vals, ps);
      const el = this.#paramControl(key, p, vals);
      el.classList.toggle('is-off', !active);
      el.querySelectorAll('input, select, textarea, button:not(.info-btn)').forEach((x) => { x.disabled = !active; }); // (i) stays: it explains why it is off
      if (p.open) { e.paramsOpen.append(el); continue; }
      add(el, p);
    }
    // Generic "#expose" controls of imported workflows.
    for (const x of c?.expose || []) {
      const key = `${x.node}.${x.input}`;
      const val = s.expose[wf.id]?.[key] ?? x.value;
      const set = (v) => { (s.expose[wf.id] ||= {})[key] = v; this.save(); };
      let el;
      const info = infoFor('expose', { input: x.input, label: x.label });
      if (x.type === 'boolean') el = this.#seg({ label: x.label, info, options: [false, true], labels: { false: 'Off', true: 'On' }, value: !!val, onChange: set });
      else if (x.type === 'number') el = this.#stepper({ label: x.label, info, min: -1e9, max: 1e9, step: Number.isInteger(val) ? 1 : 0.01, value: val, onChange: set });
      else el = h('label.ctl.span2', {}, this.#label(x.label, undefined, info), h('input', { type: 'text', value: val, 'aria-label': x.label, oninput: (ev) => set(ev.target.value) }));
      add(el);
    }
    e.settings.hidden = !e.params.children.length;
    e.paramsOpen.hidden = !e.paramsOpen.children.length;
  }

  #label(text, readout, info) {
    return h('span.label', {}, h('span', {}, text), infoButton(text, info), readout === undefined ? null : h('span.val', {}, readout));
  }

  #paramControl(key, p, vals) {
    const v = vals[key];
    const onChange = (nv) => this.setParam(key, nv);
    const kind = controlFor(p);
    const info = infoFor(key, { param: p, manifest: this.wf?.ai });
    let el;
    if (kind === 'text') {
      const ta = h('textarea', { rows: 3, dataset: { param: key }, oninput: (ev) => onChange(ev.target.value) }, String(v ?? ''));
      el = h('label.ctl.span2', {}, this.#label(p.label, undefined, info), ta);
      if (p.open) el.classList.add('field');
    } else if (kind === 'seg' && p.type === 'enum') {
      el = this.#seg({ label: p.label, info, options: p.options, labels: p.labels, value: v, onChange, param: key });
    } else if (kind === 'select' && p.type === 'enum') {
      el = this.#select({ label: p.label, info, options: p.options, labels: p.labels, value: v, onChange, param: key });
    } else if (kind === 'stepper') {
      const r = paramRange(p, vals);
      el = this.#stepper({ label: p.label, info, min: r.min, max: r.max, step: p.step || 1, value: v, onChange, param: key, id: key === 'steps' ? 'steps' : undefined, int: p.type === 'int' });
    } else {
      const r = paramRange(p, vals);
      el = this.#slider({ label: p.label, info, min: r.min, max: r.max, step: p.step || (p.type === 'int' ? 1 : 0.05), value: v, onChange, param: key, fmt: (x) => formatParam(p, x, this.paramValues()) });
    }
    if (p.span2) el.classList.add('span2');
    el.dataset.key = key;
    return el;
  }

  #stepper({ label, info, min, max, step = 1, value, onChange, param, id, int = true }) {
    const dec = decimals(step);
    const clamp = (n) => {
      let x = Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
      x = Math.round((x - min) / step) * step + min;
      return Number(x.toFixed(int ? 0 : dec));
    };
    const input = h('input.num', { type: 'number', min, max, step, value: Number(value).toFixed(int ? 0 : dec), inputmode: int ? 'numeric' : 'decimal', 'aria-label': label });
    if (id) input.id = id;
    if (param) input.dataset.param = param;
    const set = (n) => { const x = clamp(n); input.value = x.toFixed(int ? 0 : dec); onChange(x); };
    input.addEventListener('change', () => set(Number(input.value)));
    input.addEventListener('input', () => { const n = Number(input.value); if (Number.isFinite(n) && n >= min && n <= max) onChange(n); });
    const btn = (icon, d, aria) => h('button.btn.icon', { type: 'button', 'aria-label': aria, onclick: () => set(Number(input.value) + d) }, h(`i.i.${icon}`));
    return h('div.ctl', {}, this.#label(label, undefined, info), h('div.stepper.fill', {}, btn('i-minus', -step, 'Less'), input, btn('i-plus', step, 'More')));
  }

  #slider({ label, info, min, max, step, value, onChange, param, fmt }) {
    const out = h('span.val', {}, fmt(value));
    const input = h('input.sl', { type: 'range', min, max, step, value, 'aria-label': label });
    if (param) input.dataset.param = param;
    const paint = () => { input.style.setProperty('--p', pct(Number(input.value), min, max)); out.textContent = fmt(Number(input.value)); };
    input.addEventListener('input', () => { paint(); onChange(Number(input.value)); });
    paint();
    return h('div.ctl', {}, h('span.label', {}, h('span', {}, label), infoButton(label, info), out), h('div.slider-box', {}, input));
  }

  #select({ label, info, options, labels = {}, value, onChange, param }) {
    const sel = h('select', { 'aria-label': label }, options.map((o) => new Option(labels[String(o)] ?? String(o).replace(/\.(safetensors|pth|gguf)$/, ''), String(o))));
    sel.value = String(value);
    if (param) sel.dataset.param = param;
    sel.addEventListener('change', () => onChange(options.find((o) => String(o) === sel.value) ?? sel.value));
    return h('div.ctl', {}, this.#label(label, undefined, info), h('label.cselect', {}, sel, h('i.i.i-chevron-down', { 'aria-hidden': 'true' })));
  }

  #seg({ label, info, options, labels = {}, value, onChange, param }) {
    const seg = h('div.seg.text', { role: 'radiogroup', 'aria-label': label });
    if (param) seg.dataset.param = param;
    const paint = (v) => { for (const b of seg.children) { const on = b.dataset.value === String(v); b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); } };
    for (const o of options) {
      seg.append(h('button', { type: 'button', role: 'radio', dataset: { value: String(o) }, onclick: () => { paint(o); onChange(o); } }, labels[String(o)] ?? String(o)));
    }
    paint(value);
    return h('div.ctl', {}, this.#label(label, undefined, info), seg);
  }

  /** Values the user chose, for this preset. */
  values() {
    const s = this.state, c = this.wf?.controls;
    return {
      prompt: s.prompt, negative: c?.negative.length && s.negOn ? s.negative : (c?.negative.length ? '' : undefined),
      batch: Math.min(s.batch, this.maxBatch()), aspect: s.aspect, res: this.usesResolution() ? s.res : undefined, seedMode: s.seedMode, seed: s.seed,
      strength: c?.strength.length ? Number(this.el.strength.value) : undefined,
      steps: c?.steps.length && !this.wf?.ai?.params?.steps ? Number(this.state.steps[this.wf.id] ?? c.defaults.steps ?? 4) : undefined,
      expose: s.expose[this.wf?.id] || {},
      params: this.wf?.ai ? this.paramValues() : {},
    };
  }

  /** "Reuse" from the viewer: same prompt, locked to the same seed. */
  reuse(meta) {
    const s = this.state;
    if (meta.prompt !== undefined) s.prompt = meta.prompt;
    if (meta.negative) { s.negative = meta.negative; s.negOn = true; }
    if (meta.seed !== undefined && meta.seed !== null) { s.seed = meta.seed; s.seedMode = 'locked'; }
    if (meta.aspect) s.aspect = aspectKey(parseAspect(meta.aspect));
    if (meta.res) s.res = normRes(meta.res);
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
