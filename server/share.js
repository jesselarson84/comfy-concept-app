// share.js - Android "Share -> Comfy Concept" lands here.
// -----------------------------------------------------------------------------
// The manifest's share_target tells Chrome to POST the shared file as
// multipart/form-data to /share (field "image"; also "title"/"text"/"url").
// We forward the picture to ComfyUI's POST /upload/image (it saves into
// ComfyUI/input/ and returns { name, subfolder, type }), then redirect (303)
// the browser into the app with ?ref=<that name> so the reference preset is
// selected with the image already in its slot.
// -----------------------------------------------------------------------------
import { readBody, parseMultipart } from './multipart.js';

export async function uploadToComfy(comfyUrl, { data, filename, contentType }) {
  const form = new FormData();
  form.append('image', new Blob([data], { type: contentType || 'image/png' }), filename || 'shared.png');
  form.append('type', 'input');
  form.append('overwrite', 'false'); // ComfyUI renames on clash ("x (1).png")
  const r = await fetch(comfyUrl + '/upload/image', { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`ComfyUI /upload/image answered ${r.status}`);
  return r.json();
}

export async function handleShare(req, res, cfg) {
  const go = (params) => { res.writeHead(303, { Location: '/?' + new URLSearchParams(params).toString() }); res.end(); };
  try {
    const body = await readBody(req);
    const parts = parseMultipart(body, req.headers['content-type']);
    const field = (n) => parts.find((p) => p.name === n && !p.filename)?.data.toString('utf8') || '';
    const file = parts.find((p) => p.filename && p.data.length && /^image\//.test(p.contentType || 'image/'));
    const text = [field('title'), field('text'), field('url')].filter(Boolean).join(' ').trim();
    const params = { from: 'share' };
    if (text) params.text = text.slice(0, 2000);
    if (file) {
      const up = await uploadToComfy(cfg.comfyUrl, file);
      params.ref = up.subfolder ? `${up.subfolder}/${up.name}` : up.name;
    }
    go(params);
  } catch (e) {
    go({ from: 'share', shareError: e.message || 'Share failed' });
  }
}
