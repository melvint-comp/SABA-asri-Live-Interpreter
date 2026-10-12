/**
 * sw.js — service worker: makes the app open and run with no internet.
 *
 * 1. App files. On install, every file the app needs (listed in APP_FILES) is
 *    downloaded once and stored together under one version. Afterwards they
 *    are always served from the device — instantly, even offline or on a very
 *    slow connection. A new version is fetched in the background only when
 *    this file changes (bump VERSION on every release; a unit test checks it
 *    matches the ?v= tag in index.html). A new version waits until the app is
 *    closed before taking over, so an open page never mixes two versions.
 *
 * 2. Speed. Every page and script we serve gets two headers (COOP + COEP) that
 *    make the page "cross-origin isolated". That unlocks multi-threaded
 *    WebAssembly, so the AI models use several CPU cores instead of one.
 *    GitHub Pages can't send these headers itself; a service worker can.
 *
 * AI model files are NOT handled here: transformers.js stores those itself
 * (Cache Storage "transformers-cache"), so they're never stored twice.
 */
const VERSION = '2026-10-12d';
const APP_CACHE = `app-${VERSION}`;

const APP_FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'app/styles.css',
  'app/fonts/plus-jakarta-sans-latin-wght-normal.woff2',
  'app/fonts/plus-jakarta-sans-latin-ext-wght-normal.woff2',
  'app/images/saba-asri-logo.png',
  'app/images/saba-asri-logo.webp',
  'app/images/favicon.png',
  'app/images/touch-icon.png',
  'app/images/icon-192.png',
  'app/images/icon-512.png',
  'app/js/main.js',
  'app/js/config.js',
  'app/js/settings.js',
  'app/js/device.js',
  'app/js/interpreter.js',
  'app/js/audio/capture-processor.js',
  'app/js/audio/microphone.js',
  'app/js/audio/resample.js',
  'app/js/audio/segmenter.js',
  'app/js/offline/packs.js',
  'app/js/recognition/index.js',
  'app/js/recognition/webspeech.js',
  'app/js/recognition/whisper.js',
  'app/js/translation/index.js',
  'app/js/translation/chrome-builtin.js',
  'app/js/translation/mymemory.js',
  'app/js/translation/on-device.js',
  'app/js/workers/ml-client.js',
  'app/js/workers/ml.worker.js',
  'app/vendor/transformers/transformers-4.3.1.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_CACHE);
    // cache: 'reload' skips the browser's HTTP cache, so one version is stored consistently.
    await cache.addAll(APP_FILES.map((url) => new Request(url, { cache: 'reload' })));
    // No skipWaiting(): an update takes over only once every open copy of the app
    // is closed. (The very first install has nothing to wait for.)
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('app-') && key !== APP_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

/** Copy a response, adding the cross-origin isolation headers. */
function isolate(response) {
  if (!response || response.type === 'opaque' || response.status === 0) return response;
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // models, CDN, online translator: not ours to handle

  event.respondWith((async () => {
    const cache = await caches.open(APP_CACHE);
    // Pages always get the stored index.html; files ignore the ?v= version tag.
    const key = request.mode === 'navigate' ? 'index.html' : request;
    const cached = await cache.match(key, { ignoreSearch: true });
    if (cached) return isolate(cached);
    try {
      return isolate(await fetch(request));
    } catch (err) {
      if (request.mode === 'navigate') {
        const shell = await cache.match('index.html');
        if (shell) return isolate(shell);
      }
      throw err;
    }
  })());
});
