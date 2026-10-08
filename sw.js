// ============================================================
// SaiU Timetable Service Worker
// ============================================================
//
// Update strategy (production):
//   - The build id below is injected by scripts/build.mjs on every build. That
//     changes this file's bytes each deployment, so browsers always detect
//     a new Service Worker and install it.
//   - Two separate versioned caches are maintained:
//       saiu-static-{BUILD_ID}  — precached app shell (HTML, JS, CSS, icons)
//       saiu-data-{BUILD_ID}    — timetable data (Google Sheets responses)
//   - On activation ALL old caches are deleted. Only the current version's
//     caches survive, so stale assets never persist across deployments.
//   - HTML (navigations) is CACHE-FIRST: the cached app shell is served
//     immediately (even offline). Online, the cache is refreshed in the
//     background so the next navigation gets the latest HTML.
//   - Static assets (CSS/JS/icons/fonts) use versioned URLs (?v=BUILD_ID),
//     so Cache-First is safe: a new build references new URLs and the old
//     ones are purged with the old cache.
//   - Timetable data (Google Sheets) is NETWORK-FIRST with cache fallback
//     and cache: 'no-store' to bypass the browser HTTP cache entirely.
//
// Application Cache vs User Preferences:
//   - This worker only manages the Cache Storage API. On activation it
//     deletes every cache except the current versioned static + data caches.
//   - User preferences live in localStorage under `tt-*` keys. Service
//     workers cannot access localStorage, so cache purging never touches them.
//
// Local / dev hosts must NEVER be controlled by a service worker.
const DEV_HOSTS = ['localhost', '127.0.0.1', '::1', '0.0.0.0'];
const isDevHost = DEV_HOSTS.includes(self.location.hostname);

// Replaced by scripts/build.mjs on every build — the file's bytes change every
// deployment so the Service Worker update is always detected.
const BUILD_ID = '2026-10-08-002';

// Versioned cache names. Old caches are deleted on activate so stale assets
// never survive a deployment. Both names change every build.
const STATIC_CACHE = 'saiu-static-' + BUILD_ID;
const DATA_CACHE   = 'saiu-data-'   + BUILD_ID;

const versioned = (url) => `${url}?v=${BUILD_ID}`;

// ---------------------------------------------------------------------------
// Precache tiers
// ---------------------------------------------------------------------------
// Measured on a cold load, the whole precache kept `install` open for ~5.4s
// (33 requests) and `activate` — and therefore the first paint of the next
// launch — gated behind it. Nothing in the first screen needs all of that.
//
// Split into two tiers:
//   CORE  — required to render the first screen and to work offline. Awaited
//           during install, so an offline launch after one visit is complete.
//   EXTRA — genuinely optional (teacher page, easter eggs, breakout game,
//           maskable icons, startup images). Fetched in the background *after*
//           the SW activates, so it never delays anything. Still lands in
//           STATIC_CACHE and is still versioned, so correctness is unchanged;
//           the only cost if a fetch is interrupted is that the file is
//           refetched on demand by the cache-first handler.
//
// URLs are versioned so a new build always fetches the newest files and the old
// cache is removed on activation.
const CORE_ASSETS = [
  // HTML pages (precached as offline fallbacks — fetched without ?v=)
  'index.html',
  '404.html',
  // Versioned static assets
  versioned('style.css'),
  versioned('manifest.json'),
  versioned('manifest-light.json'),
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
  versioned('js/core/theme.js'),
  versioned('js/services/storage.js'),
  versioned('js/services/analytics.js'),
  versioned('js/services/timetable-sync.js'),
  versioned('js/services/lab-fetch.js'),
  versioned('js/services/teacher-fetch.js'),
  versioned('js/ui/navigation.js'),
  versioned('js/ui/ui.js'),
  versioned('js/ui/display.js'),
  versioned('js/ui/lab-section.js'),
  versioned('js/ui/free-rooms.js'),
  versioned('js/core/spring.js'),
  versioned('js/core/app.js'),
  // Icons
  versioned('icons/favicon/favicon-32.png'),
  versioned('icons/favicon/favicon-48.png'),
  versioned('icons/favicon/favicon-192.png'),
  versioned('icons/app/white-icon-512.png'),
  versioned('icons/app/apple-touch-icon.png'),
  // Self-hosted Inter (was: a Google Fonts CSS request + a gstatic woff2).
  // Precaching these is what makes the app render correctly offline; before
  // this change the fonts were fetched from a third-party origin and the
  // `no-cors` opaque response could not be validated.
  versioned('fonts/inter-latin.woff2'),
  versioned('fonts/inter-latin-ext.woff2'),
];

// Optional: cached after activation, never on the critical path.
const EXTRA_ASSETS = [
  'teachers.html',
  versioned('js/teachers/teacher-app.js'),
  versioned('js/ui/easter-eggs.js'),
  versioned('js/game/breakout.js'),
  versioned('icons/app/white-icon-maskable-192.png'),
  versioned('icons/app/white-icon-maskable-512.png'),
  versioned('icons/app/black-icon-192.png'),
  versioned('icons/app/black-icon-512.png'),
  versioned('icons/app/black-icon-maskable-192.png'),
  versioned('icons/app/black-icon-maskable-512.png'),
  // iOS launch images. Only fetched by iOS, and only after the app is already
  // installed, so they are firmly in the optional tier.
  versioned('icons/startup/startup-640x1136.png'),
  versioned('icons/startup/startup-750x1334.png'),
  versioned('icons/startup/startup-1170x2532.png'),
  versioned('icons/startup/startup-1179x2556.png'),
  versioned('icons/startup/startup-828x1792.png'),
  versioned('icons/startup/startup-1284x2778.png'),
  versioned('icons/startup/startup-1290x2796.png'),
  versioned('icons/startup/startup-1334x750.png'),
  versioned('icons/startup/startup-2532x1170.png'),
  versioned('icons/startup/startup-2778x1284.png'),
];

// --- Helpers ---------------------------------------------------------------

function log(...args) {
  console.log('[SW ' + BUILD_ID + ']', ...args);
}

async function precache() {
  log('precache: storing', CORE_ASSETS.length, 'core assets in', STATIC_CACHE);
  await cacheAll(CORE_ASSETS);
}

/**
 * Best-effort background precache of the optional tier.
 *
 * Runs after activation, so it cannot delay install, activate, or the first
 * paint of the next launch. Individual failures are ignored — anything missing
 * here is still fetched on demand by the cache-first handler.
 */
async function precacheExtra() {
  const missing = await cacheAll(EXTRA_ASSETS);
  if (missing.length) log('precache: optional tier incomplete:', missing);
  else log('precache: optional tier complete');
  return missing;
}

async function cacheAll(urls) {
  const cache = await caches.open(STATIC_CACHE);
  const results = await Promise.allSettled(
    urls.map(async (url) => {
      try {
        const res = await cache.add(url);
        if (!res) throw new Error('not cached');
      } catch (err) {
        throw new Error(url + ' (' + (err && err.message ? err.message : 'failed') + ')');
      }
    })
  );
  return results
    .map((r) => (r.status === 'rejected' ? r.reason.message : null))
    .filter(Boolean);
}

const cacheable = (response) => response && (response.ok || response.type === 'opaque');

/**
 * Network-first fetch for Google Sheets with retry and content validation.
 *
 * Google Sheets can return transient errors (5xx, 429) or redirect to a
 * consent page (HTML 200) on some mobile networks. We:
 *   1. Retry up to 3 times on network failure or 5xx/429.
 *   2. Validate the Content-Type before caching — only cache responses that
 *      look like CSV/text data, never HTML consent pages.
 *   3. Fall back to the last good cached copy on total failure.
 */
async function sheetsNetworkFirst(request) {
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 400; // ms — doubles each retry

  let lastError = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(request, { cache: 'no-store' });

      if (response.ok) {
        const ct = (response.headers.get('content-type') || '').toLowerCase();
        // Google Sheets CSV export returns text/csv or text/plain.
        // An HTML consent page or AML error page returns text/html —
        // never cache those as timetable data.
        const isCSV = ct.includes('text/csv') || ct.includes('text/plain');
        if (isCSV) {
          const copy = response.clone();
          const cache = await caches.open(DATA_CACHE);
          await cache.put(request, copy);
          return response;
        }
        // Non-CSV 200 (likely consent page) — don't cache, serve as-is
        // so the app can handle the error.
        return response;
      }

      // Non-ok (429, 5xx) — retry on next iteration
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`HTTP ${response.status}`);
        if (attempt < MAX_RETRIES - 1) {
          await new Promise(r => setTimeout(r, RETRY_DELAY * Math.pow(2, attempt)));
          continue;
        }
      }
      // Other non-ok (4xx) — don't retry, serve as-is
      return response;
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES - 1) {
        await new Promise(r => setTimeout(r, RETRY_DELAY * Math.pow(2, attempt)));
      }
    }
  }

  // All retries exhausted — try the cache
  const cached = await caches.match(request);
  if (cached) return cached;
  throw lastError || new Error('Google Sheets request failed after retries');
}

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

/**
 * Cache-first for HTML navigations.
 *
 * Serves the cached app shell immediately (even offline) so the user never
 * waits for an unreachable network. Online, the cache is silently refreshed
 * in the background so the NEXT navigation gets the latest HTML.
 */
async function cacheFirstHTML(request, event) {
  const cached = await caches.match(request);
  if (cached) {
    // Background refresh — update cache for the next navigation.
    event.waitUntil(
      fetch(request)
        .then((res) => {
          if (cacheable(res)) {
            return caches.open(STATIC_CACHE).then((c) => c.put(request, res));
          }
        })
        .catch(() => {})
    );
    return cached;
  }
  // No cached copy yet (first visit) — fetch from network.
  const response = await fetch(request);
  if (cacheable(response)) {
    const copy = response.clone();
    const cache = await caches.open(STATIC_CACHE);
    await cache.put(request, copy);
  }
  return response;
}

// --- Install ---------------------------------------------------------------

self.addEventListener('install', (event) => {
  if (isDevHost) {
    // On dev hosts the service worker destroys itself instead of caching.
    self.registration.unregister();
    self.skipWaiting();
    return;
  }
  log('install');
  event.waitUntil(precache());
  self.skipWaiting();
});

// --- Activate --------------------------------------------------------------

self.addEventListener('activate', (event) => {
  if (isDevHost) {
    event.waitUntil(
      caches.keys().then((names) => Promise.all(names.map((name) => caches.delete(name))))
    );
    return;
  }
  event.waitUntil(
    caches.keys()
      .then((names) => {
        const keep = new Set([STATIC_CACHE, DATA_CACHE]);
        const toDelete = names.filter((name) => !keep.has(name));
        if (toDelete.length) log('activate: deleting old caches:', toDelete);
        return Promise.all(toDelete.map((name) => caches.delete(name)));
      })
      // Take control of all open clients immediately so the freshly
      // installed version applies without closing/reopening the app.
      .then(() => self.clients.claim())
      .then(() => log('activate: clients.claim() done'))
      // Optional tier runs last and is deliberately NOT awaited by anything
      // downstream — clients.claim() above is the point at which the new
      // build is live and usable.
      .then(() => precacheExtra())
  );
});

/**
 * Version handshake / stale-shell detection.
 *
 * HTML navigations are cache-first so the app shell boots instantly, which
 * means the first launch after a deploy runs the *previous* build. Combined
 * with `skipWaiting()` + `clients.claim()` (which swap the worker under the
 * already-loaded page), the user could end up looking at old HTML wired to a
 * new worker and never be told.
 *
 * The page sends GET_VERSION; we answer with this worker's BUILD_ID. The page
 * compares it against the build id baked into the document it was served from
 * and shows the update bar if they differ. See js/core/app.js.
 */
self.addEventListener('message', (event) => {
  const data = event.data || {};

  if (data.type === 'SKIP_WAITING') {
    log('skipWaiting received');
    self.skipWaiting();
    return;
  }

  if (data.type === 'SAIU_VERSION_CHECK') {
    const reply = { type: 'SAIU_VERSION', buildId: BUILD_ID };
    if (event.ports && event.ports[0]) event.ports[0].postMessage(reply);
    else if (event.source) event.source.postMessage(reply);
    return;
  }
});

// Tell every open client that a new build is now active, so a page already on
// screen can offer the reload even if it never asked.
self.addEventListener('activate', (event) => {
  if (isDevHost) return;
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      for (const client of clients) client.postMessage({ type: 'SAIU_UPDATE_READY', buildId: BUILD_ID });
    })
  );
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

  // Timetable data (Google Sheets): network-first with cache: 'no-store'
  // to bypass the browser HTTP cache. The old cached response in DATA_CACHE
  // serves as an offline fallback only.
  //
  // Google Sheets may return a 302 redirect to a consent/AML page or serve
  // HTML instead of CSV on certain networks / regions. We validate the
  // response Content-Type before caching so a non-CSV page never poisons
  // the DATA_CACHE (which would break the app on subsequent offline loads).
  if (url.hostname.endsWith('docs.google.com') && url.pathname.includes('/spreadsheets')) {
    event.respondWith(sheetsNetworkFirst(request));
    return;
  }

  // HTML navigations: cache-first so the app shell loads instantly, even
  // offline. Online, the cache is refreshed in the background so the next
  // navigation gets the latest HTML.
  if (request.mode === 'navigate') {
    event.respondWith(cacheFirstHTML(request, event));
    return;
  }

  // Same-origin static assets: cache-first. Safe because every referenced
  // URL is versioned (?v=BUILD_ID), so a new build never reuses old files.
  // This now also covers the self-hosted web fonts, which is why there is no
  // separate Google Fonts branch here any more.
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // Anything else: cache-first with network fallback.
  event.respondWith(cacheFirst(request, DATA_CACHE));
});
