// sw.js - service worker. Caches ONLY the app shell (HTML/CSS/JS/icons) so the
// app opens instantly and installs as a PWA. Images, /api, /comfy and /share
// always go to the network (never cached) - they live on the PC. The vendored
// three.js (/vendor/, only used by the 3D viewer) is cached the first time it
// is fetched, so the 3D viewer also opens without a network round trip later.
// Bump VERSION when you change app files so phones pick up the new shell.
const VERSION = 'shell-v38'; // batch 22 (in ComfyUI's sidebar)
const SHELL = [
  '/', '/index.html', '/styles.css', '/icons.css', '/fonts/inter-latin-normal.woff2', '/manifest.webmanifest',
  '/js/main.js', '/js/api.js', '/js/comfy-client.js', '/js/job-queue.js',
  '/js/lib/workflow-detect.js', '/js/lib/workflow-inject.js', '/js/lib/aspect.js', '/js/lib/resolution.js', '/js/lib/seed.js',
  '/js/native.js',
  '/js/lib/presets.js', '/js/lib/outputs.js', '/js/lib/legacy-presets.js', '/js/lib/preset-choice.js',
  '/js/lib/run-lock.js', '/js/ui/form-lock.js', '/js/lib/conn-banner.js', '/js/lib/setting-info.js', '/js/ui/info-tip.js', '/js/ui/node-view.js', '/js/lib/memory-options.js', '/js/lib/mask-paint.js', '/js/ui/mask-editor.js',
  '/js/lib/thumb-cache.js', '/js/ui/model-thumbs.js',
  '/js/ui/workflow-picker.js', '/js/ui/file-inputs.js', '/js/ui/drive-folder.js', '/js/lib/history-filter.js', '/js/ui/action-menu.js',
  '/js/ui/dropdown.js', '/js/ui/save-preset.js', '/js/ui/import-sheet.js', '/js/lib/recorder.js',
  '/js/ui/overlay.js', '/js/ui/model-viewer.js', '/js/ui/audio-player.js', '/js/ui/video-player.js', '/js/ui/file-sheet.js', '/js/ui/output-picker.js', '/js/ui/preset-chooser.js',
  '/js/ui/claude.js', '/js/ui/settings-sheet.js', '/js/lib/speech.js',
  '/js/ui/dom.js', '/js/ui/prompt-panel.js', '/js/ui/reference.js', '/js/ui/thumbs.js', '/js/ui/viewer.js', '/js/ui/history-view.js', '/js/ui/projects.js', '/js/ui/pc-card.js', '/js/ui/batch-sheet.js',
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
  // /download/ (the Android APK): Chrome on Android leaves a download that went
  // through the service worker hanging at 100%, so the browser fetches it itself.
  if (/^\/(api|comfy|share|download)(\/|$)/.test(url.pathname)) return;
  if (e.request.mode === 'navigate') {
    // Network first for the page itself, cached shell when offline.
    e.respondWith(fetch(e.request).catch(() => caches.match('/index.html')));
    return;
  }
  // Shell files: network first (fresh code while developing), cache fallback.
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok && (SHELL.includes(url.pathname) || url.pathname.startsWith('/vendor/'))) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request)));
});
