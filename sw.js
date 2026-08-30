// ============================================================
// SaiU Timetable Service Worker
// ============================================================
//
// Update strategy (production):
//   - The build id below is injected by scripts/build.mjs on every build. That
//     changes this file's bytes each deployment, so browsers always detect
//     a new Service Worker and install it.
//   - A unique cache version is created per build (saiu-timetable-v{ID}).
//     Old caches are deleted on activate, so stale assets never survive.
//   - HTML (navigations) is NETWORK-FIRST: the latest page is always
//     fetched when online; the cached copy is only an offline fallback.
//   - Static assets (CSS/JS/icons/fonts) use versioned URLs (?v=BUILD_ID),
//     so Cache-First is safe: a new build references new URLs and the old
//     ones are purged with the old cache. A consistent version is served.
//   - Timetable data (Google Sheets) is NETWORK-FIRST with cache fallback.
//
// Application Cache vs User Preferences:
//   - This worker only ever manages the Cache Storage API (the application
//     cache). On activation it deletes every cache except the current
//     versioned build cache and the timetable-sheet cache.
//   - User preferences (selected school/program/year/section/electives/day)
//     live in localStorage under `tt-*` keys. Service workers cannot even
//     access localStorage, so cache purging can never touch them — updates
//     replace cached assets while every user selection survives.
//
// Local / dev hosts must NEVER be controlled by a service worker. A stale
// worker serves the cached app shell (cache-first), so edits made while
// developing with Live Server (or any local static server) never appear.
const DEV_HOSTS = ['localhost', '127.0.0.1', '::1', '0.0.0.0'];
const isDevHost = DEV_HOSTS.includes(self.location.hostname);

// Replaced by scripts/build.mjs on every build — the file's bytes change every
// deployment so the Service Worker update is always detected.
const BUILD_ID = '2026-08-30-001';

const CACHE_NAME = 'saiu-timetable-v' + BUILD_ID;
const SHEET_CACHE = 'timetable-sheet-v1';

const versioned = (url) => `${url}?v=${BUILD_ID}`;

// Precached on install. URLs are versioned so a new build always fetches
// the newest files and the old cache is removed on activation.
const ASSETS = [
  'index.html',
  '404.html',
  'teachers.html',
  versioned('style.css'),
  versioned('manifest.json'),
  versioned('js/generated/build.js'),
  versioned('js/core/config.js'),
  versioned('js/data/parser.js'),
  versioned('js/data/course-normalizer.js'),
  versioned('js/data/change-detector.js'),
  versioned('js/data/schools.js'),
  versioned('js/data/lab-config.js'),
  versioned('js/data/lab-parser.js'),
  versioned('js/data/teacher-index.js'),
  versioned('js/core/utils.js'),
  versioned('js/services/storage.js'),
  versioned('js/services/analytics.js'),
  versioned('js/services/timetable-sync.js'),
  versioned('js/services/lab-fetch.js'),
  versioned('js/services/teacher-fetch.js'),
  versioned('js/services/n8n.js'),
  versioned('js/services/timetable-ai.js'),
  versioned('js/services/timetable-test-harness.js'),
  versioned('js/ui/navigation.js'),
  versioned('js/ui/ui.js'),
  versioned('js/ui/display.js'),
  versioned('js/ui/lab-section.js'),
  versioned('js/ui/ai-assistant.js'),
  versioned('js/core/spring.js'),
  versioned('js/core/app.js'),
  versioned('js/ui/easter-eggs.js'),
  versioned('js/game/breakout.js'),
  versioned('js/teachers/teacher-app.js'),
  versioned('icons/favicon/favicon-32.png'),
  versioned('icons/favicon/favicon-48.png'),
  versioned('icons/favicon/favicon-192.png'),
  versioned('icons/app/white-icon-512.png'),
  versioned('icons/app/white-icon-maskable-192.png'),
  versioned('icons/app/white-icon-maskable-512.png'),
  versioned('icons/app/black-icon-192.png'),
  versioned('icons/app/black-icon-512.png'),
  versioned('icons/app/black-icon-maskable-192.png'),
  versioned('icons/app/black-icon-maskable-512.png'),
  versioned('icons/app/apple-touch-icon.png'),
  versioned('manifest-light.json'),
];

const FONT_CSS = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap';

// --- Helpers ---------------------------------------------------------------

async function precache() {
  const cache = await caches.open(CACHE_NAME);
  // addAll would abort the whole install if a single asset fails
  // (e.g. a transient network error). One bad asset must not block
  // the update, so each URL is cached independently.
  await Promise.allSettled(
    ASSETS.map((url) => cache.add(url).catch(() => {}))
  );
  // Precache the Google Fonts stylesheet as an opaque (no-cors) response.
  try {
    const font = await fetch(FONT_CSS, { mode: 'no-cors' });
    if (font && (font.ok || font.type === 'opaque')) await cache.put(FONT_CSS, font);
  } catch { /* fonts are optional */ }
}

const cacheable = (response) => response && (response.ok || response.type === 'opaque');

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (cacheable(response)) {
    const copy = response.clone();
    const cache = await caches.open(cacheName);
    await cache.put(request, copy);
  }
  return response;
}

async function networkFirst(request, cacheName, fallback, fetchOptions) {
  try {
    const response = await fetch(request, fetchOptions);
    if (cacheable(response)) {
      const copy = response.clone();
      const cache = await caches.open(cacheName);
      await cache.put(request, copy);
      return response;
    }
    // Non-ok upstream response (404/429/5xx — Google Sheets rate limiting or
    // an outage). Serve the last good cached copy instead of surfacing the
    // error as a broken timetable load (the app would show a false "offline"
    // toast). Only fall through when there is no cached copy at all.
    const cached = await caches.match(request);
    if (cached) return cached;
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (fallback) return caches.match(fallback);
    throw new Error('Network request failed and no cached copy exists');
  }
}

// --- Install ---------------------------------------------------------------

self.addEventListener('install', (event) => {
  if (isDevHost) {
    // On dev hosts the service worker destroys itself instead of caching.
    self.registration.unregister();
    self.skipWaiting();
    return;
  }
  event.waitUntil(precache());
  self.skipWaiting();
});

// --- Activate --------------------------------------------------------------

self.addEventListener('activate', (event) => {
  if (isDevHost) {
    // Remove any leftover caches on dev hosts.
    event.waitUntil(
      caches.keys().then((names) => Promise.all(names.map((name) => caches.delete(name))))
    );
    return;
  }
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.map((name) => (name !== CACHE_NAME && name !== SHEET_CACHE ? caches.delete(name) : null))
      ))
      // Take control of all open clients immediately so the freshly
      // installed version applies without closing/reopening the app.
      .then(() => self.clients.claim())
  );
});

// The page asks the waiting worker to activate right away.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// --- Fetch ----------------------------------------------------------------

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (isDevHost) return; // never intercept on dev hosts

  const url = new URL(request.url);

  // Never intercept analytics or the Service Worker script itself.
  if (url.hostname.endsWith('googletagmanager.com') || url.hostname.endsWith('google-analytics.com')) return;
  if (url.pathname.endsWith('/sw.js')) return;

  // Timetable data (Google Sheets): network-first, offline falls back to
  // the last successfully fetched copy.
  if (url.hostname.endsWith('docs.google.com') && url.pathname.includes('/spreadsheets')) {
    event.respondWith(networkFirst(request, SHEET_CACHE));
    return;
  }

  // HTML navigations: network-first so a deployed update is never hidden
  // behind a stale cached page. The cache copy is only an offline fallback.
  // cache: 'no-store' ensures the browser's own HTTP cache cannot serve a
  // stale HTML page with outdated ?v= asset references on mobile devices.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, CACHE_NAME, 'index.html', { cache: 'no-store' }));
    return;
  }

  // Google Fonts: cache-first (they change infrequently).
  if (url.hostname.endsWith('fonts.googleapis.com') || url.hostname.endsWith('fonts.gstatic.com')) {
    event.respondWith(cacheFirst(request, CACHE_NAME));
    return;
  }

  // Same-origin static assets: cache-first. Safe because every referenced
  // URL is versioned (?v=BUILD_ID), so a new build never reuses old files.
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request, CACHE_NAME));
    return;
  }

  // Anything else: network-first with cache fallback.
  event.respondWith(networkFirst(request, CACHE_NAME));
});
