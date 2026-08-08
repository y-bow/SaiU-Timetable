import { CONFIG } from './config.js?v=2026-08-08-027';
import * as nav from './navigation.js?v=2026-08-08-027';

/**
 * Silent background timetable change-detection.
 *
 * Google Sheets offers no lightweight "version" value for the anonymous CSV
 * export the app uses, so we build the cheapest reliable fingerprint we can:
 *
 *   - A tiny (~500 byte) gviz query probe every CHECK_INTERVAL. Its `sig`
 *     field is a server-computed content hash of the probed response, so it
 *     changes the moment rows are added/removed. The response itself is a
 *     single number — never the whole sheet.
 *   - A full-sheet hash reconciliation every FULL_INTERVAL. The CSV export is
 *     hashed with FNV-1a and compared against the stored hash, catching
 *     in-place edits (room/faculty/time changes) that the row-count probe
 *     cannot see. This is the only path that downloads the whole sheet, and
 *     it only happens on a cadence, not every second.
 *
 * A full fetch + parse + diff + UI patch runs ONLY when a fingerprint
 * actually changes. Everything else is designed to stay out of the user's way:
 *
 *   - `busy` guard: never two checks or two syncs at once.
 *   - The page is never reloaded, navigated or re-rendered here — the app
 *     decides how to apply a change (targeted DOM patch).
 *   - Checking pauses while the tab is hidden and while offline, and backs
 *     off exponentially (capped) after repeated failures.
 *   - Fingerprints are stored per-year, so switching school/program/year
 *     never compares apples to oranges.
 */

// --- Fingerprint store -----------------------------------------------------

function fpKey() {
    const year = nav.getYear();
    return year ? `tt-sync-fp-${year.id}` : null;
}

function readFp() {
    const key = fpKey();
    if (!key) return {};
    try {
        const raw = localStorage.getItem(key);
        const obj = raw ? JSON.parse(raw) : {};
        return obj && typeof obj === 'object' ? obj : {};
    } catch { return {}; }
}

function writeFp(fp) {
    const key = fpKey();
    if (!key) return;
    try { localStorage.setItem(key, JSON.stringify(fp)); } catch { /* full */ }
}

// --- Hashing ---------------------------------------------------------------

// FNV-1a 32-bit over the UTF-8 bytes, base-36 encoded. Fast, stable and
// order-sensitive, so two identical sheets hash identically regardless of
// response framing or byte quirks.
function fnv1a(text) {
    let h = 0x811c9dc5;
    const bytes = new TextEncoder().encode(text);
    for (let i = 0; i < bytes.length; i++) {
        h ^= bytes[i];
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
}

// --- URLs ------------------------------------------------------------------

function probeUrl() {
    const year = nav.getYear();
    if (!year || !year.sheetId) return null;
    return `https://docs.google.com/spreadsheets/d/${year.sheetId}/gviz/tq?gid=${year.gid || '0'}&tq=${encodeURIComponent('select count(A)')}`;
}

function sheetUrl() {
    return nav.getSheetUrl();
}

// --- Parsing ---------------------------------------------------------------

// gviz responses look like:
//   /*O_o*/
//   google.visualization.Query.setResponse({...json...});
function parseSig(text) {
    try {
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start < 0 || end <= start) return null;
        const payload = JSON.parse(text.slice(start, end + 1));
        if (!payload || payload.status !== 'ok') return null;
        return typeof payload.sig === 'string' ? payload.sig : null;
    } catch { return null; }
}

// --- Fetching --------------------------------------------------------------

async function fetchText(url) {
    if (!url) return null;
    try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) return null;
        return await res.text();
    } catch { return null; }
}

// --- Watcher state ---------------------------------------------------------

let onChange = null;       // set by app.js via setHandler()
let running = false;
let busy = false;
let timer = null;
let firstTick = true;
let currentYearId = null;
let lastCheckAt = 0;
let lastFullCheckAt = 0;
let lastChangeAt = 0;
let failures = 0;

const CHECK_INTERVAL = CONFIG.SYNC_CHECK_INTERVAL;
const FULL_INTERVAL = CONFIG.SYNC_FULL_INTERVAL;
const FAST_FULL_INTERVAL = CONFIG.SYNC_FAST_FULL_INTERVAL;
const CHANGE_WINDOW = CONFIG.SYNC_CHANGE_WINDOW;
const MAX_BACKOFF = CONFIG.SYNC_MAX_BACKOFF;

function fullInterval() {
    return (Date.now() - lastChangeAt) < CHANGE_WINDOW ? FAST_FULL_INTERVAL : FULL_INTERVAL;
}

function nextDelay() {
    if (firstTick) {
        // Give the initial load() fetch (which establishes the baseline
        // fingerprint) a head start so the watcher never double-fetches.
        firstTick = false;
        return Math.max(CHECK_INTERVAL, 5000);
    }
    if (failures > 0) {
        return Math.min(MAX_BACKOFF, CHECK_INTERVAL * Math.pow(2, Math.min(failures, 6)));
    }
    return CHECK_INTERVAL;
}

function scheduleNext() {
    if (!running) return;
    clearTimeout(timer);
    timer = setTimeout(() => { tick(); }, nextDelay());
}

function pause() {
    if (timer) { clearTimeout(timer); timer = null; }
}

function resume() {
    if (!running) return;
    if (timer) clearTimeout(timer);
    failures = 0;
    tick();
}

// --- Checks ----------------------------------------------------------------

async function tick() {
    if (!running || busy) return;

    // The tab is hidden or the network is gone — do nothing, just wait.
    // nextDelay() keeps the timer cheap, so no requests fire while paused.
    if (document.hidden || navigator.onLine === false) { scheduleNext(); return; }

    const year = nav.getYear();
    if (!year) { scheduleNext(); return; }

    // Switching years resets the comparison window; the new year's
    // fingerprint is re-established before any sync can trigger.
    if (year.id !== currentYearId) {
        currentYearId = year.id;
        lastFullCheckAt = 0;
        lastCheckAt = 0;
    }

    busy = true;
    try {
        const now = Date.now();
        if (now - lastFullCheckAt >= fullInterval()) {
            await fullCheck();
        } else {
            await probeCheck();
        }
    } finally {
        busy = false;
        scheduleNext();
    }
}

// Cheap probe: single gviz request returning only a signature + row count.
async function probeCheck() {
    const sig = await probeSig();
    if (sig == null) { failures++; return; }
    const fp = readFp();
    if (fp.sig == null) {
        // First probe for this sheet — record the baseline, don't act.
        fp.sig = sig;
        writeFp(fp);
        return;
    }
    if (fp.sig !== sig) {
        // Rows added/removed (or the probed digest changed) — full sync.
        await sync(null);
        fp.sig = sig;
        fp.hash = null; // full sync re-establishes the hash baseline
        writeFp(fp);
        lastChangeAt = Date.now();
    }
    failures = 0;
    lastCheckAt = Date.now();
}

// Full reconciliation: hash the whole sheet and compare against the stored
// hash. Catches in-place edits the probe cannot see.
async function fullCheck() {
    const text = await fetchText(sheetUrl());
    if (text == null) { failures++; return; }
    const hash = fnv1a(text);
    const fp = readFp();
    if (fp.hash != null && fp.hash !== hash) {
        await sync(text); // reuse the text we already downloaded
        lastChangeAt = Date.now();
    }
    fp.hash = hash;
    // Refresh the probe baseline while we're here (cheap, best-effort).
    const sig = await probeSig();
    if (sig != null) fp.sig = sig;
    writeFp(fp);
    failures = 0;
    lastFullCheckAt = Date.now();
}

async function probeSig() {
    const url = probeUrl();
    if (!url) return null;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const text = await res.text();
    return parseSig(text);
}

// Full fetch + hand-off to the app's apply handler. Only ever runs once a
// fingerprint change is detected. `prefetchedText` avoids a second download
// when the full-hash reconciliation already fetched the sheet.
async function sync(prefetchedText) {
    const text = prefetchedText ?? await fetchText(sheetUrl());
    if (text == null) { failures++; return; }
    const fp = readFp();
    fp.hash = fnv1a(text);
    writeFp(fp);
    if (typeof onChange === 'function') {
        onChange(text);
    }
}

// --- Public API ------------------------------------------------------------

/**
 * Establish/refresh the fingerprint baseline right after the app has fetched
 * the full sheet itself (initial load or manual refresh). Prevents the
 * watcher from re-detecting data we already have.
 */
export function noteFetched(text) {
    if (!text) return;
    const fp = readFp();
    fp.hash = fnv1a(text);
    writeFp(fp);
    failures = 0;
    lastFullCheckAt = Date.now();
    const year = nav.getYear();
    if (year) currentYearId = year.id;
    // Refresh the probe baseline best-effort.
    probeSig().then((sig) => {
        if (sig == null) return;
        const f = readFp();
        f.sig = sig;
        writeFp(f);
    }).catch(() => {});
}

export function setHandler(handler) {
    onChange = typeof handler === 'function' ? handler : null;
}

export function start(handler) {
    if (typeof handler === 'function') onChange = handler;
    if (running) return;
    running = true;
    busy = false;
    currentYearId = nav.getYear()?.id ?? null;
    lastCheckAt = 0;
    lastFullCheckAt = 0;
    lastChangeAt = 0;
    failures = 0;
    scheduleNext();
}

export function stop() {
    running = false;
    pause();
}

// Pause while hidden, resume (and check immediately) when visible/back online.
document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause();
    else resume();
});

window.addEventListener('online', () => {
    failures = 0;
    if (running) resume();
});

window.addEventListener('offline', () => {
    // Stop hammering the network; resume() on 'online' restarts checking.
    failures = failures || 1;
    pause();
});
