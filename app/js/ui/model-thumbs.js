// model-thumbs.js - real preview stills for 3D (GLB) tiles in History and the
// session strip. A still is the model rendered once with the vendored three.js
// in the same clay look as the 3D viewer, then cached (lib/thumb-cache.js,
// IndexedDB on this device). Tiles render lazily: only tiles that scroll into
// view are queued (IntersectionObserver), one at a time, through ONE shared
// offscreen WebGL renderer, so offscreen tiles never create WebGL contexts.
// Until a still exists (or if rendering fails) the tile shows the source
// picture used for the 3D job, else a neutral 3D placeholder.
import { viewUrl } from '../comfy-client.js';
import { getThumb, putThumb, thumbKey } from '../lib/thumb-cache.js';

const SIZE = 256;
const VENDOR = '/vendor/three';
export const stats = { renders: 0, contexts: 0, cacheHits: 0, failures: 0 };

let threeP = null;
const loadThree = () => (threeP ||= Promise.all([
  import(`${VENDOR}/three.module.js`),
  import(`${VENDOR}/addons/loaders/GLTFLoader.js`),
]).then(([THREE, { GLTFLoader }]) => ({ THREE, GLTFLoader })));

let shared = null; // { THREE, renderer, scene, camera, clay, loader }
async function renderer() {
  if (shared) return shared;
  const { THREE, GLTFLoader } = await loadThree();
  const canvas = document.createElement('canvas'); // never attached to the page
  canvas.width = canvas.height = SIZE;
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: false });
  stats.contexts++;
  r.setPixelRatio(1); r.setSize(SIZE, SIZE, false);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x262729);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
  scene.add(camera);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x2a2a2a, 1.4));
  const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(1.5, 2, 3); camera.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 0.6); rim.position.set(-3, 1, -2); scene.add(rim);
  // Same clay as the 3D viewer (ui/model-viewer.js).
  const clay = new THREE.MeshStandardMaterial({ color: 0xb9b9b9, roughness: 0.85, metalness: 0 });
  shared = { THREE, renderer: r, scene, camera, clay, loader: new GLTFLoader(), canvas };
  return shared;
}

/** Renders one GLB to a PNG Blob with the shared renderer. */
export async function renderStill(file) {
  const s = await renderer();
  const { THREE } = s;
  const gltf = await s.loader.loadAsync(viewUrl(file));
  const model = gltf.scene;
  const owned = [];
  model.traverse((o) => {
    if (!o.isMesh) return;
    if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const textured = !!o.geometry.attributes.color || mats.some((m) => m && (m.map || m.vertexColors));
    owned.push(o.geometry, ...mats.filter(Boolean));
    if (!textured) o.material = s.clay;
  });
  s.scene.add(model);
  try {
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 1e-3);
    const dist = radius / Math.sin((s.camera.fov * Math.PI) / 360) * 1.05;
    s.camera.near = dist / 100; s.camera.far = dist * 100; s.camera.updateProjectionMatrix();
    s.camera.position.copy(center).add(new THREE.Vector3(0.6, 0.45, 1).normalize().multiplyScalar(dist));
    s.camera.lookAt(center);
    s.renderer.render(s.scene, s.camera);
    stats.renders++;
    return await new Promise((resolve, reject) => s.canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('no still'))), 'image/png'));
  } finally {
    s.scene.remove(model);
    for (const x of owned) { for (const v of Object.values(x)) if (v?.isTexture) v.dispose(); x.dispose?.(); }
  }
}

const SKIP = Symbol('offscreen');
const is3dModel = (f) => /\.(glb|gltf)$/i.test(f?.filename || '');

/** Lazy thumbnails for 3D tiles. One instance per page. */
export class ModelThumbs {
  constructor({ render = renderStill } = {}) {
    this.render = render;
    this.queue = [];
    this.busy = false;
    this.pending = new Map(); // key -> Promise<Blob|null>
    this.urls = new Map();    // key -> object URL
    this.io = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entries) => {
        for (const e of entries) if (e.isIntersecting) { this.io.unobserve(e.target); this.#load(e.target); }
      }, { rootMargin: '200px' })
      : null;
  }

  /** A 3D tile: img gets the still when the tile is first seen. */
  attach(tile, img, file, fallback) {
    if (!is3dModel(file)) return;
    tile.classList.add('is-3d');
    tile._thumb = { img, file, fallback };
    // The source picture may be gone from ComfyUI's input folder: then the placeholder.
    img.addEventListener('error', () => { if (!tile.classList.contains('has-still')) { img.removeAttribute('src'); tile.classList.add('ph-3d'); } });
    if (fallback && !img.getAttribute('src')) img.src = viewUrl(fallback, { thumb: true });
    if (!fallback && !img.getAttribute('src')) tile.classList.add('ph-3d');
    const url = this.urls.get(thumbKey(file));
    if (url) return this.#show(tile, url);
    if (this.io) this.io.observe(tile); else this.#load(tile);
  }

  /** After generation: render the still in the background (once). */
  prefetch(file) { if (is3dModel(file)) this.#still(file).catch(() => {}); }

  #show(tile, url) {
    const t = tile._thumb; if (!t) return;
    t.img.src = url; t.img.hidden = false;
    tile.classList.remove('ph-3d'); tile.classList.add('has-still');
  }

  async #load(tile) {
    const t = tile._thumb; if (!t) return;
    // A tile that left the screen (History closed, list re-rendered) before its
    // turn is skipped, so stale tiles never hold up the ones being looked at.
    const wanted = () => tile.isConnected && tile.offsetParent !== null;
    let skipped = false;
    const blob = await this.#still(t.file, wanted).catch((e) => { skipped = e === SKIP; return null; });
    if (skipped) { if (tile.isConnected && this.io) this.io.observe(tile); return; }
    if (blob) {
      const key = thumbKey(t.file);
      let url = this.urls.get(key);
      if (!url) { url = URL.createObjectURL(blob); this.urls.set(key, url); }
      this.#show(tile, url);
    }
  }

  #still(file, wanted = () => true) {
    const key = thumbKey(file);
    if (this.pending.has(key)) return this.pending.get(key);
    const p = (async () => {
      const hit = await getThumb(key);
      if (hit) { stats.cacheHits++; return hit; }
      const blob = await this.#enqueue(() => (wanted() ? this.render(file) : Promise.reject(SKIP)));
      if (blob) await putThumb(key, blob);
      return blob;
    })().catch((e) => { if (e !== SKIP) stats.failures++; this.pending.delete(key); throw e; });
    this.pending.set(key, p);
    return p;
  }

  /** One render at a time through the single shared renderer. */
  #enqueue(job) {
    return new Promise((resolve, reject) => { this.queue.push({ job, resolve, reject }); this.#pump(); });
  }

  async #pump() {
    if (this.busy) return;
    const next = this.queue.shift();
    if (!next) return;
    this.busy = true;
    try { next.resolve(await next.job()); } catch (e) { next.reject(e); } finally { this.busy = false; this.#pump(); }
  }
}
