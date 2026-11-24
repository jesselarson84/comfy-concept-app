// model-viewer.js - in-app 3D viewer for GLB results (Hunyuan3D, Pixal3D,
// the Chat's 3D action).
// -----------------------------------------------------------------------------
//   one finger drag  -> orbit          pinch -> zoom          two fingers -> pan
//   (mouse: left drag orbit, wheel zoom, right drag pan) - three.js OrbitControls
//   Shaded / Wireframe / Shaded+wireframe, Reset view, vertex + triangle count,
//   ⋮ = Save… (Google Drive or this phone) and Share (batch 10).
// three.js (r187, MIT) is vendored under /vendor/three/ and served by the app
// server, so this works over the tailnet, offline and in the Android WebView.
// It is only loaded when a 3D result is opened. Untextured meshes (Hunyuan3D
// output) get a neutral gray clay material; textured ones keep their own.
// -----------------------------------------------------------------------------
import { h } from './dom.js';
import { viewUrl } from '../comfy-client.js';
import { Overlay, overlayTop } from './overlay.js';
import { fileMoreButton } from './action-menu.js';

const VENDOR = '/vendor/three';
let libs = null;
export function loadThree() {
  libs ||= Promise.all([
    import(`${VENDOR}/three.module.js`),
    import(`${VENDOR}/addons/loaders/GLTFLoader.js`),
    import(`${VENDOR}/addons/controls/OrbitControls.js`),
  ]).then(([THREE, { GLTFLoader }, { OrbitControls }]) => ({ THREE, GLTFLoader, OrbitControls }))
    .catch((e) => { libs = null; throw e; });
  return libs;
}

export const MODES = [
  { id: 'shaded', label: 'Shaded' },
  { id: 'wireframe', label: 'Wireframe' },
  { id: 'both', label: 'Shaded+wireframe' },
];

/** Vertex and triangle totals of every mesh under root. */
export function meshStats(root) {
  let vertices = 0, triangles = 0;
  root.traverse((o) => {
    const g = o.isMesh ? o.geometry : null;
    const pos = g?.attributes?.position;
    if (!pos) return;
    vertices += pos.count;
    triangles += Math.floor((g.index ? g.index.count : pos.count) / 3);
  });
  return { vertices, triangles };
}

const fmt = (n) => Number(n).toLocaleString('en-US');

export class ModelViewer {
  /** hooks: { onSave(file) (Drive or this phone), onShare(file) } - the ⋮ menu (batch 10) */
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.ov = new Overlay('model-viewer', '3D viewer');
    this.ov.onClose = () => { this.#teardown(); this.state = 'closed'; };
    this.state = 'closed';
    this.mode = 'shaded';
    this.stats = null;
    this.stage = h('div.mv-stage');
    this.status = h('div.mv-status');
    this.statsEl = h('span.mv-stats');
    this.modeBtns = MODES.map((m) => h('button', { type: 'button', role: 'radio', dataset: { mode: m.id }, onclick: () => this.setMode(m.id) }, m.label));
    this.top = overlayTop('', () => this.close(),
      h('button.icon-btn', { type: 'button', title: 'Reset view', 'aria-label': 'Reset view', dataset: { act: 'reset' }, onclick: () => this.resetView() }, h('i.i.i-rotate-ccw')),
      fileMoreButton(() => this.file, this.hooks));
    this.ov.root.append(this.stage, this.status, this.top,
      h('div.ov-bottom', {},
        h('div.seg.mv-modes', { role: 'radiogroup', 'aria-label': 'Display' }, this.modeBtns),
        this.statsEl));
    this.#paintModes();
  }

  get root() { return this.ov.root; }

  close() { this.ov.close(); }

  async open(file, meta = {}) {
    this.#teardown();
    this.file = file; this.meta = meta;
    this.top.setTitle(file.filename);
    this.statsEl.textContent = '';
    this.status.textContent = 'Loading…'; this.status.hidden = false;
    this.state = 'loading';
    this.ov.show();
    const token = (this.token = {});
    try {
      const { THREE, GLTFLoader, OrbitControls } = await loadThree();
      if (token !== this.token) return;
      this.THREE = THREE;
      const canvas = h('canvas.mv-canvas');
      this.stage.replaceChildren(canvas);
      let renderer;
      try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true }); } catch (e) { throw new Error('3D view needs WebGL, which is not available here'); }
      this.renderer = renderer;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      const scene = (this.scene = new THREE.Scene());
      scene.background = new THREE.Color(0x141414);
      const camera = (this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000));
      scene.add(camera);
      scene.add(new THREE.HemisphereLight(0xffffff, 0x2a2a2a, 1.4));
      const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(1.5, 2, 3); camera.add(key); // key light follows the view
      const rim = new THREE.DirectionalLight(0xffffff, 0.6); rim.position.set(-3, 1, -2); scene.add(rim);
      const controls = (this.controls = new OrbitControls(camera, canvas));
      controls.enableDamping = true; controls.dampingFactor = 0.12; controls.screenSpacePanning = true;
      controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
      this.#resize();
      this.ro = new ResizeObserver(() => this.#resize()); this.ro.observe(this.stage);
      const gltf = await new GLTFLoader().loadAsync(viewUrl(file));
      if (token !== this.token) return;
      const model = (this.model = gltf.scene);
      this.stats = meshStats(model); // before the wireframe overlays are added
      this.#prepare(model);
      scene.add(model);
      this.statsEl.textContent = `${fmt(this.stats.vertices)} vertices · ${fmt(this.stats.triangles)} triangles`;
      this.#frame();
      this.setMode(this.mode);
      this.status.hidden = true;
      this.state = 'ready';
      const loop = () => { if (token !== this.token) return; this.raf = requestAnimationFrame(loop); controls.update(); renderer.render(scene, camera); };
      loop();
    } catch (e) {
      if (token !== this.token) return;
      this.state = 'error';
      this.status.textContent = `Could not open the 3D model: ${e.message}`;
      this.status.hidden = false;
    }
  }

  /** Clay material for untextured meshes, plus a wireframe overlay per mesh. */
  #prepare(model) {
    const T = this.THREE;
    this.clay = new T.MeshStandardMaterial({ color: 0xb9b9b9, roughness: 0.85, metalness: 0, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    this.wireMat = new T.MeshBasicMaterial({ color: 0xd0d0d0, wireframe: true, transparent: true, opacity: 0.35, depthWrite: false });
    this.meshes = [];
    // Collect first: the wireframe overlays added below are meshes too.
    const found = [];
    model.traverse((o) => { if (o.isMesh) found.push(o); });
    for (const o of found) {
      if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const textured = !!o.geometry.attributes.color || mats.some((m) => m && (m.map || m.vertexColors));
      if (!textured) o.material = this.clay;
      else for (const m of mats) if (m) { m.polygonOffset = true; m.polygonOffsetFactor = 1; m.polygonOffsetUnits = 1; }
      const wire = new T.Mesh(o.geometry, this.wireMat);
      wire.visible = false; wire.renderOrder = 1;
      o.add(wire);
      this.meshes.push({ mesh: o, wire });
    }
  }

  setMode(mode) {
    if (!MODES.some((m) => m.id === mode)) return;
    this.mode = mode;
    for (const { mesh, wire } of this.meshes || []) {
      // Wireframe: the surface still writes depth (no color), so only the front edges show.
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) if (m) { m.colorWrite = mode !== 'wireframe'; m.needsUpdate = true; }
      wire.visible = mode !== 'shaded';
    }
    if (this.wireMat) {
      // Dense scans (Hunyuan: ~100k triangles) would turn solid white; fade the lines with density.
      const k = Math.sqrt(20000 / Math.max(1, this.stats?.triangles || 1));
      if (mode === 'wireframe') { this.wireMat.color.set(0xffffff); this.wireMat.opacity = Math.min(0.9, Math.max(0.25, 0.9 * k)); }
      else { this.wireMat.color.set(0x1a1a1a); this.wireMat.opacity = Math.min(0.6, Math.max(0.2, 0.6 * k)); }
      this.wireMat.needsUpdate = true;
    }
    this.#paintModes();
  }

  #paintModes() {
    for (const b of this.modeBtns) { const on = b.dataset.mode === this.mode; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); }
  }

  /** Camera framing the whole model; becomes the Reset view state. */
  #frame() {
    const T = this.THREE;
    const box = new T.Box3().setFromObject(this.model);
    const size = box.getSize(new T.Vector3()), center = box.getCenter(new T.Vector3());
    const radius = Math.max(size.length() / 2, 1e-3);
    // Fit the bounding sphere in the narrower of the two view angles (a phone held upright is narrow).
    const vHalf = (this.camera.fov * Math.PI) / 360, hHalf = Math.atan(Math.tan(vHalf) * this.camera.aspect);
    const dist = radius / Math.sin(Math.min(vHalf, hHalf)) * 1.1;
    this.camera.near = dist / 100; this.camera.far = dist * 100; this.camera.updateProjectionMatrix();
    this.camera.position.copy(center).add(new T.Vector3(0.6, 0.45, 1).normalize().multiplyScalar(dist));
    this.controls.target.copy(center);
    this.controls.minDistance = radius * 0.05; this.controls.maxDistance = dist * 20;
    this.controls.update();
    this.controls.saveState();
  }

  /** Back to the first framing. Damping is switched off for a moment so the
   *  leftover drag momentum is dropped instead of drifting the reset view. */
  resetView() {
    const c = this.controls;
    if (!c) return;
    const damping = c.enableDamping;
    c.enableDamping = false;
    c.update();
    c.reset();
    c.enableDamping = damping;
  }

  #resize() {
    if (!this.renderer) return;
    const w = this.stage.clientWidth || window.innerWidth, hh = this.stage.clientHeight || window.innerHeight;
    this.renderer.setSize(w, hh, false);
    this.camera.aspect = w / Math.max(1, hh); this.camera.updateProjectionMatrix();
  }

  #teardown() {
    this.token = null;
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect(); this.ro = null;
    this.controls?.dispose(); this.controls = null;
    this.model?.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry?.dispose?.();
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) { if (!m) continue; for (const v of Object.values(m)) if (v?.isTexture) v.dispose(); m.dispose?.(); }
    });
    this.clay?.dispose(); this.wireMat?.dispose();
    if (this.renderer) { this.renderer.dispose(); this.renderer.forceContextLoss?.(); this.renderer = null; }
    this.model = null; this.scene = null; this.meshes = []; this.stats = null;
    this.stage.replaceChildren();
  }
}
