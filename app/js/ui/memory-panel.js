// memory-panel.js - "GPU & memory" in the ⋮ menu: the detected GPU (name, total
// and free VRAM), system RAM, the active memory profile and a manual override
// (Auto / one of the profiles in config/memory-profiles.json), plus which chat
// model is loaded and whether it runs partly in RAM.
import { h, toast } from './dom.js';
import { memoryStatus } from '../ollama-client.js';

const gb = (mb) => (typeof mb === 'number' ? `${(mb / 1024).toFixed(1)} GB` : '?');

export class MemoryPanel {
  constructor(mount, { onChange } = {}) {
    this.onChange = onChange;
    this.line = h('div.memory-line');
    this.prof = h('div.memory-profile-line.muted');
    this.loaded = h('div.memory-loaded.muted');
    this.warn = h('div.memory-warn', { hidden: true });
    this.sel = h('select.memory-select', { 'aria-label': 'Memory profile', onchange: () => this.set(this.sel.value) });
    this.root = h('div.memory', {},
      h('div.label', {}, 'GPU & memory'), this.line, this.prof,
      h('label.memory-pick', {}, h('span.muted', {}, 'Profile '), this.sel),
      this.loaded, this.warn,
      h('button.link', { type: 'button', onclick: () => this.refresh(true) }, 'Refresh'));
    this.root.id = 'memory';
    mount.replaceChildren(this.root);
    this.refresh(true);
  }

  async refresh(fresh = false) {
    try { this.render(await memoryStatus(fresh)); } catch (e) { this.line.textContent = 'Could not read GPU/RAM: ' + e.message; }
    return this.status;
  }

  render(s) {
    this.status = s;
    const g = s.hardware.gpu, r = s.hardware.ram;
    this.line.textContent = g
      ? `${g.name} · ${gb(g.totalMB)} VRAM (${gb(g.freeMB)} free) · RAM ${gb(r.totalMB)} (${gb(r.freeMB)} free)`
      : `No GPU detected (${s.hardware.error || 'nvidia-smi and ComfyUI did not answer'}) · RAM ${gb(r.totalMB)} (${gb(r.freeMB)} free)`;
    const src = { auto: 'auto-detected', setting: 'chosen here', config: 'set in config/memory-profiles.json', env: 'set by MEMORY_PROFILE' }[s.profile.source] || s.profile.source;
    this.prof.textContent = `Active: ${s.profile.label} (${src})`;
    this.sel.replaceChildren(new Option('Auto (by VRAM)', 'auto'), ...s.profiles.map((p) => new Option(p.label, p.id)));
    this.sel.value = s.setting || 'auto';
    this.sel.disabled = !!s.env;
    this.loaded.textContent = s.ollama.loaded.length
      ? 'Chat model loaded: ' + s.ollama.loaded.map((m) => `${m.name}${m.badge ? ` - ${m.badge.text}` : ' (on GPU)'}`).join(', ')
      : (s.ollama.reachable ? 'No chat model loaded.' : 'Ollama is not running.');
    this.warn.hidden = !s.warnings?.length;
    this.warn.textContent = (s.warnings || []).join(' · ');
  }

  async set(profile) {
    try {
      const r = await fetch('/api/memory/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      this.render(d);
      toast(`Memory profile: ${d.profile.label}`);
      this.onChange?.(d);
    } catch (e) { toast(e.message, 6000); }
  }
}
