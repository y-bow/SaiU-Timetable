import { CONFIG } from '../core/config.js?v=2026-08-17-001';
import { parseCSV, parseRoomOccupancy } from '../data/parser.js?v=2026-08-17-001';
import * as nav from '../ui/navigation.js?v=2026-08-17-001';
import { toMinutes, minutesToClock, todayName, WEEKDAYS } from '../core/utils.js?v=2026-08-17-001';
import { loadMergedYear2Timetable } from './lab-fetch.js?v=2026-08-17-001';

/**
 * Background timetable sync for the Breakout game page (game.html).
 *
 * The game never depends on the timetable. This module only:
 *   1. Refreshes the shared timetable cache (same localStorage keys the main
 *      app uses) whenever the network is available, so the game page also
 *      keeps the schedule fresh while the user plays.
 *   2. Shows an optional, subtle "next class" hint from whatever timetable
 *      data is available — pure context, never blocking.
 *
 * If the page opens offline, the game runs normally; nothing here throws.
 * When connectivity returns, the `online` event triggers a re-sync without
 * reloading the page or interrupting gameplay.
 */

const CONTEXT_EL = () => document.getElementById('game-context');

function cacheKeyFor(year) {
    return year && year.id ? `tt-cache-${year.id}` : CONFIG.CACHE_KEY;
}

async function syncTimetable() {
    if (!navigator.onLine) return;
    try {
        // Resolve the current selection exactly like the main app does.
        nav.initNavigation();
        const sheetUrl = nav.getSheetUrl();
        if (!sheetUrl) return;

        const res = await fetch(sheetUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        const parsed = parseCSV(text, nav.getParserType(), nav.getMandatoryCourses(), nav.getElectives(), nav.getRooms());
        if (!parsed.length) throw new Error('No classes parsed');

        // Room occupancy for Free Rooms: ALL classes in ALL rooms.
        const roomClasses = parseRoomOccupancy(text);

        // Produce the SAME snapshot the main app writes (js/core/app.js): for
        // SCDS Year 2 the separate lab timetables are merged under the main
        // sheet classes. The shared tt-cache-<year> key is the change-detector's
        // previous-state baseline, so writing anything but the app's exact
        // snapshot here would reset the baseline and let the detector re-derive
        // already-notified changes. No notification is ever dispatched from this
        // module — the single notification path stays in app.js.
        const year = nav.getYear();
        const classes = year && year.id === 'scds-2'
            ? (await loadMergedYear2Timetable(parsed)).classes
            : parsed;
        if (!classes.length) throw new Error('No classes parsed');

        try {
            localStorage.setItem(cacheKeyFor(year), JSON.stringify({ savedAt: Date.now(), classes, roomClasses }));
        } catch { /* storage full — ignore */ }

        renderContext(classes);
    } catch {
        // Offline or transient failure — the game is unaffected.
    }
}

// Optional contextual hint: the next class on today's schedule, if any.
function renderContext(classes) {
    const el = CONTEXT_EL();
    if (!el) return;
    try {
        const day = todayName();
        if (!WEEKDAYS.includes(day)) { el.classList.add('hidden'); return; }
        const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
        const next = classes
            .filter((c) => c.day === day && toMinutes(c.startTime) > nowMin)
            .sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime))[0];
        if (next) {
            el.textContent = `Next class: ${next.subject} · ${minutesToClock(toMinutes(next.startTime))}`;
            el.classList.remove('hidden');
        } else {
            el.classList.add('hidden');
        }
    } catch {
        el.classList.add('hidden');
    }
}

function boot() {
    // The game has already started by the time this module runs; a short
    // delay keeps any network work well out of the game's first frames.
    setTimeout(() => syncTimetable(), 1000);

    // Connectivity returned while the page is open → refresh the cache only.
    // No reload, no restart, gameplay is never interrupted.
    window.addEventListener('online', () => syncTimetable());
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}
