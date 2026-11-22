// thumbs.js - the strip (phone) / grid (tablet) of this session's jobs.
// Pending jobs show a progress bar; finished ones show a thumbnail. Elements
// are reused by item key so progress updates don't flicker.
import { h } from './dom.js';
import { viewUrl } from '../comfy-client.js';
import { fileLabel } from '../lib/outputs.js';

/** modelThumbs (ui/model-thumbs.js): 3D tiles get a rendered preview still. */
export function renderThumbs(container, items, onOpen, modelThumbs) {
  const existing = new Map([...container.children].map((el) => [el.dataset.key, el]));
  const keep = new Set();
  items.forEach((it, i) => {
    keep.add(it.key);
    let el = existing.get(it.key);
    if (!el) {
      el = h('button.thumb', { dataset: { key: it.key }, onclick: () => onOpen(it) },
        h('img', { alt: '', loading: 'lazy' }), h('span.thumb-bar', {}, h('span.thumb-fill')), h('span.thumb-label'));
    }
    el.className = `thumb s-${it.status}${it.files?.length && !it.image ? ' is-file' : ''}`;
    el.title = it.error || it.meta?.prompt || '';
    const img = el.querySelector('img');
    if (it.image && !img.getAttribute('src')) img.src = viewUrl(it.image, { thumb: true });
    if (modelThumbs && it.status === 'done' && !it.image && it.files?.length && !el._thumb) modelThumbs.attach(el, img, it.files[0], it.meta?.parent?.image || refImage(it.meta?.reference));
    el.querySelector('.thumb-fill').style.width = `${Math.round((it.progress || 0) * 100)}%`;
    el.querySelector('.thumb-label').textContent = {
      submitting: '…', queued: 'queued', running: `${Math.round((it.progress || 0) * 100)}%`,
      error: 'failed', cancelled: 'cancelled', done: it.favorite ? '★' : (!it.image && it.files?.length ? fileLabel(it.files[0]) : ''),
    }[it.status] ?? '';
    if (container.children[i] !== el) container.insertBefore(el, container.children[i] || null);
  });
  for (const [k, el] of existing) if (!keep.has(k)) el.remove();
}

/** The job's source picture (first LoadImage reference) as a /view ref, if any. */
function refImage(reference) {
  const ref = reference && typeof reference === 'object' ? Object.values(reference).find((x) => typeof x === 'string' && x) : null;
  if (!ref) return null;
  const i = ref.lastIndexOf('/');
  return { filename: i >= 0 ? ref.slice(i + 1) : ref, subfolder: i >= 0 ? ref.slice(0, i) : '', type: 'input' };
}
