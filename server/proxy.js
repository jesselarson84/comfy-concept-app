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
// WEBSOCKET: a ws connection starts as an HTTP GET with "Upgrade: websocket".
// We forward that request, and when ComfyUI answers "101 Switching Protocols"
// we just splice the two raw TCP sockets together. Frames pass through
// untouched, so no websocket library is needed.
// -----------------------------------------------------------------------------
import http from 'node:http';
import https from 'node:https';

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

// opts.label names the upstream in the 502 error ("ComfyUI" or "Ollama").
export function createComfyProxy(getTarget, prefix = '/comfy', { label = 'ComfyUI' } = {}) {
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
    const up = lib.request(options, (upRes) => {
      const headers = {};
      for (const [k, v] of Object.entries(upRes.headers)) if (!HOP.has(k)) headers[k] = v;
      // A redirect to "/x" from ComfyUI must become "/comfy/x" for the browser.
      if (headers.location && headers.location.startsWith('/')) headers.location = prefix + headers.location;
      res.writeHead(upRes.statusCode, headers);
      upRes.pipe(res);
    });
    up.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
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
