// sw.js - service worker. Caches ONLY the app shell (HTML/CSS/JS/icons) so the
// app opens instantly and installs as a PWA. Images, /api, /comfy, /ollama and /share
// always go to the network (never cached) - they live on the PC.
// Bump VERSION when you change app files so phones pick up the new shell.
const VERSION = 'shell-v7';
const SHELL = [
  '/', '/index.html', '/styles.css', '/manifest.webmanifest',
  '/js/main.js', '/js/api.js', '/js/comfy-client.js', '/js/job-queue.js',
  '/js/lib/workflow-detect.js', '/js/lib/workflow-inject.js', '/js/lib/aspect.js', '/js/lib/seed.js',
  '/js/native.js', '/js/ollama-client.js',
  '/js/lib/chat-reply.js', '/js/lib/chat-context.js', '/js/lib/prompt-diff.js', '/js/lib/actions.js',
  '/js/ui/chat-panel.js', '/js/ui/memory-panel.js', '/js/ui/prompt-versions.js',
  '/js/ui/dom.js', '/js/ui/prompt-panel.js', '/js/ui/reference.js', '/js/ui/thumbs.js', '/js/ui/viewer.js', '/js/ui/history-view.js',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Not ours to cache: other origins, non-GET (incl. the POST /share from the
  // share sheet - the server handles it), API, ComfyUI proxy.
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  if (/^\/(api|comfy|share|ollama)(\/|$)/.test(url.pathname)) return;
  if (e.request.mode === 'navigate') {
    // Network first for the page itself, cached shell when offline.
    e.respondWith(fetch(e.request).catch(() => caches.match('/index.html')));
    return;
  }
  // Shell files: network first (fresh code while developing), cache fallback.
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok && SHELL.includes(url.pathname)) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request)));
});
