// proxy.js - reverse proxy: /comfy/* on this server -> COMFY_URL/*.
// -----------------------------------------------------------------------------
// WHY a proxy:
//  * ComfyUI stays bound to 127.0.0.1 and is never exposed. The phone only
//    ever talks to this app (through Tailscale HTTPS), and this app talks to
//    ComfyUI over localhost on the same PC. So no --listen flag is needed.
//  * Same origin: the PWA, the API and ComfyUI all live under one https
//    origin, so no CORS and the websocket works through `tailscale serve`.
//
// ORIGIN REWRITE: recent ComfyUI versions reject (403) requests whose Origin
// header does not match their Host (protection against random web pages
// poking a localhost ComfyUI). Through a proxy the browser's Origin is
// "https://pc.tailnet.ts.net" while ComfyUI's host is 127.0.0.1:8188, so we
// rewrite Host and Origin to ComfyUI's own address. That is safe here because
// only requests that already reached this app (inside your tailnet) are sent.
//
// THE COMFYUI PAGE (batch 4): with opts.injectHtml, the one HTML page ComfyUI
// serves at /comfy/ gets that snippet (a <link> + <script> of this app) added
// before </head>: it hides the Agent button and Agent error toasts and lets the
// page know it runs inside the app's node view (app/js/comfy-tweaks.js). Only
// that response is buffered: it is asked for uncompressed, any gzip / br /
// deflate answer is decoded anyway, Content-Length is recomputed. Every other
// response streams through untouched. If anything about it is unexpected
// (not HTML, no </head>, decoding fails, too big) the page goes out unmodified.
// opts.frameable: X-Frame-Options / CSP frame-ancestors from ComfyUI are
// relaxed to same-origin, so the app can show ComfyUI in an iframe.
//
// WEBSOCKET: a ws connection starts as an HTTP GET with "Upgrade: websocket".
// We forward that request, and when ComfyUI answers "101 Switching Protocols"
// we just splice the two raw TCP sockets together. Frames pass through
// untouched, so no websocket library is needed.
// -----------------------------------------------------------------------------
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

// opts.label names the upstream in the 502 error ("ComfyUI" or "Ollama").
// opts.idleMs: an upstream request that sends nothing for this long is dropped
// (0 = never; long enough for ComfyUI-Manager installs that answer only at the end).
export function createComfyProxy(getTarget, prefix = '/comfy', { label = 'ComfyUI', idleMs = 10 * 60e3, injectHtml = null, frameable = false } = {}) {
  function buildOptions(req, keepUpgrade) {
    const target = new URL(getTarget());
    const path = req.url.slice(prefix.length) || '/';
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!keepUpgrade && HOP.has(k)) continue;
      headers[k] = v;
    }
    headers.host = target.host;
    if (headers.origin) headers.origin = target.origin;
    if (headers.referer) {
      try { const r = new URL(headers.referer); headers.referer = target.origin + (r.pathname.startsWith(prefix) ? r.pathname.slice(prefix.length) : r.pathname) + r.search; } catch { delete headers.referer; }
    }
    // Cookies for this app are not ComfyUI's business.
    delete headers.cookie;
    return { target, options: { protocol: target.protocol, hostname: target.hostname, port: target.port, method: req.method, path: path.startsWith('/') ? path : '/' + path, headers } };
  }

  function web(req, res) {
    const { target, options } = buildOptions(req, false);
    const lib = target.protocol === 'https:' ? https : http;
    let upRes = null;
    const page = !!injectHtml && (req.method === 'GET' || req.method === 'HEAD') && isPagePath(options.path);
    if (page) options.headers['accept-encoding'] = 'identity';
    const up = lib.request(options, (r) => {
      upRes = r;
      const headers = {};
      for (const [k, v] of Object.entries(upRes.headers)) if (!HOP.has(k)) headers[k] = v;
      // A redirect to "/x" from ComfyUI must become "/comfy/x" for the browser.
      if (headers.location && headers.location.startsWith('/')) headers.location = prefix + headers.location;
      if (frameable) allowSameOriginFrame(headers);
      if (page && req.method === 'GET' && upRes.statusCode === 200 && /text\/html/i.test(headers['content-type'] || '')) return sendInjected(upRes, res, headers, injectHtml);
      res.writeHead(upRes.statusCode, headers);
      upRes.pipe(res);
    });
    // The phone went away (app switched, screen off, tab closed, viewer closed
    // half way through a big .glb): drop the upstream request too. Without this
    // ComfyUI keeps streaming the file into a dead pipe and keeps it open, and
    // on Windows an open file cannot be deleted (EBUSY) until that ends.
    res.on('close', () => {
      if (res.writableFinished) return;
      upRes?.destroy();
      up.destroy();
    });
    // Nothing from ComfyUI for idleMs: give up instead of holding the socket forever.
    if (idleMs > 0) up.setTimeout(idleMs, () => up.destroy(Object.assign(new Error(`no answer for ${Math.round(idleMs / 1000)} s`), { code: 'ETIMEDOUT' })));
    up.on('error', (err) => {
      if (res.destroyed) return;
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
      else return res.destroy(); // half-sent body: cut it so the browser sees an error, not a short file
      res.end(JSON.stringify({ error: `${label} unreachable`, detail: err.message, [label === 'ComfyUI' ? 'comfyUrl' : 'url']: getTarget() }));
    });
    req.pipe(up);
  }

  function upgrade(req, socket, head) {
    const { target, options } = buildOptions(req, true);
    const lib = target.protocol === 'https:' ? https : http;
    const up = lib.request(options);
    up.on('upgrade', (upRes, upSocket, upHead) => {
      // Relay ComfyUI's 101 response line + headers verbatim to the browser.
      let head101 = `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}\r\n`;
      for (let i = 0; i < upRes.rawHeaders.length; i += 2) head101 += `${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}\r\n`;
      socket.write(head101 + '\r\n');
      if (upHead?.length) socket.write(upHead);
      if (head?.length) upSocket.write(head);
      upSocket.pipe(socket).pipe(upSocket);
      const done = () => { socket.destroy(); upSocket.destroy(); };
      upSocket.on('error', done); socket.on('error', done);
      upSocket.on('close', done); socket.on('close', done);
    });
    up.on('response', (upRes) => {
      // ComfyUI refused the upgrade (e.g. 403). Pass the status on and close.
      socket.end(`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}\r\nConnection: close\r\n\r\n`);
    });
    up.on('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'));
    up.end();
  }

  return { web, upgrade };
}

/** "/", "/index.html" (with or without a query): ComfyUI's one HTML page. */
export function isPagePath(p) { return /^\/(index\.html)?(\?.*)?$/.test(p); }

/** X-Frame-Options DENY -> SAMEORIGIN; CSP frame-ancestors -> 'self'. */
export function allowSameOriginFrame(headers) {
  if (headers['x-frame-options']) headers['x-frame-options'] = 'SAMEORIGIN';
  const csp = headers['content-security-policy'];
  if (typeof csp === 'string' && /frame-ancestors/i.test(csp)) headers['content-security-policy'] = csp.replace(/frame-ancestors[^;]*/i, "frame-ancestors 'self'");
  return headers;
}

const MAX_PAGE = 8 * 1024 * 1024;

/** Insert the snippet before </head> (else after <body...>); null when there is no place for it. */
export function injectIntoHtml(html, snippet) {
  if (html.includes('data-concept-tweaks')) return html; // already there
  const i = html.search(/<\/head\s*>/i);
  if (i >= 0) return html.slice(0, i) + snippet + html.slice(i);
  const b = /<body[^>]*>/i.exec(html);
  if (b) return html.slice(0, b.index + b[0].length) + snippet + html.slice(b.index + b[0].length);
  return null;
}

function decode(buf, enc) {
  const e = String(enc || 'identity').trim().toLowerCase();
  if (e === 'identity' || e === '') return buf;
  if (e === 'gzip' || e === 'x-gzip') return zlib.gunzipSync(buf);
  if (e === 'br') return zlib.brotliDecompressSync(buf);
  if (e === 'deflate') { try { return zlib.inflateSync(buf); } catch { return zlib.inflateRawSync(buf); } }
  throw new Error(`unknown content-encoding ${e}`);
}

function sendInjected(upRes, res, headers, snippet) {
  const chunks = [];
  let size = 0, passthrough = false;
  upRes.on('data', (c) => {
    if (passthrough) { res.write(c); return; }
    chunks.push(c); size += c.length;
    if (size > MAX_PAGE) { // not the small page we expect: stream it on unmodified
      passthrough = true;
      res.writeHead(upRes.statusCode, headers);
      for (const x of chunks.splice(0)) res.write(x);
    }
  });
  upRes.on('error', () => res.destroy());
  upRes.on('end', () => {
    if (res.destroyed) return;
    if (passthrough) return res.end();
    const raw = Buffer.concat(chunks);
    let out = null;
    try {
      const html = injectIntoHtml(decode(raw, headers['content-encoding']).toString('utf8'), snippet);
      if (html !== null) out = Buffer.from(html, 'utf8');
    } catch { out = null; }
    if (!out) { res.writeHead(upRes.statusCode, headers); return res.end(raw); } // fail open: exactly as ComfyUI sent it
    const h = { ...headers };
    delete h['content-encoding']; delete h.etag; delete h['last-modified'];
    h['content-length'] = out.length;
    h['cache-control'] = 'no-cache';
    res.writeHead(upRes.statusCode, h);
    res.end(out);
  });
}
