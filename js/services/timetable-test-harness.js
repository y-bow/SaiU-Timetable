/**
 * LOCALHOST-ONLY development harness for timetable change notifications.
 *
 * Exercises the REAL production pipeline end to end — the same detector and
 * the same n8n sender the app uses on every timetable refresh:
 *
 *     Snapshot A (old)  ──►  compareTimetables()  ──►  changes
 *     Snapshot B (new)        (js/data/change-detector.js)
 *                                │
 *                                ▼
 *                          buildN8nEvent() + sendN8nEvent()
 *                          (js/services/n8n.js — event builder + sender)
 *
 * No separate webhook implementation, no fake sender, no production data.
 *
 * The console functions are attached to window automatically when this module
 * is imported — and ONLY on localhost / dev hosts. Production (GitHub Pages
 * and any non-local host) never sees them, and the gate needs no config flag:
 *
 *   window.testRoomChangeNotification()    AB2 → AB1 Computer Lab (room change)
 *   window.testTimeChangeNotification()    15:00–15:55 → 16:00–16:55 (time change)
 *   window.testCancellationNotification()  class removed from the timetable (cancelled)
 *   window.testInvalidRoomChange()        AB2 → undefined (ignored, no n8n event)
 *
 * Attachment happens at module evaluation (see installTimetableTestHarness
 * below), which is guaranteed to run AFTER this module's static imports — the
 * change detector and the n8n pipeline — have loaded. They never run
 * automatically; they are manual console tools.
 *
 * Every call generates a UNIQUE development-only changeId, so repeated calls
 * always reach the webhook and the real dedupe store (tt-n8n-sent-v1) is never
 * consulted or modified. Real timetable changes are completely unaffected:
 * they continue to use the stable deterministic changeId and the untouched
 * dedupe inside dispatchTimetableChanges().
 */

import { compareTimetables } from '../data/change-detector.js?v=2026-08-25-001';
import { buildN8nEvent, sendN8nEvent } from './n8n.js?v=2026-08-25-001';
import { CONFIG } from '../core/config.js?v=2026-08-25-001';

// Snapshot A — a fixed, self-contained Deep Learning class. Only the fields
// the change detector and the n8n event builder actually consume matter;
// `date` is carried for clarity (the event date is derived from `day` by
// dateForWeekday in js/services/n8n.js).
const SNAPSHOT_A = {
    school: 'SCDS',
    section: 3,
    subject: 'Deep Learning',
    courseId: 'deep-learning',
    day: 'Wednesday',
    date: '2026-08-12',
    startTime: '15:00',
    endTime: '15:55',
    room: 'AB2',
};

// Mirrors the app's n8nContext (js/core/app.js) but leaves year/school to the
// snapshot records themselves.
const CONTEXT = { year: null, school: null, section: 3, labGroup: null };

const LOCALHOST_HOSTS = ['localhost', '127.0.0.1', '::1', '0.0.0.0'];

function isLocalhost() {
    try {
        const host = String(window.location.hostname || '');
        return LOCALHOST_HOSTS.includes(host) || host.startsWith('127.');
    } catch { return false; }
}

function webhookConfigured() {
    try { return String(CONFIG.N8N_WEBHOOK_URL || '').trim().length > 0; }
    catch { return false; }
}

// --- Unique dev-only change ids ---------------------------------------------

let devCallCounter = 0;

/**
 * FNV-1a 32-bit hash → 8 lowercase hex chars, matching the shape of
 * buildChangeId() (js/services/n8n.js). The dev id is built from a monotonic
 * counter + wall clock + randomness, so every harness call gets a fresh id
 * that the real dedupe never sees. The stable deterministic ids of real
 * timetable changes are unaffected.
 */
function uniqueDevChangeId() {
    devCallCounter = (devCallCounter + 1) >>> 0;
    let h = 0x811c9dc5;
    const nonce = `${Date.now()}|${devCallCounter}|${Math.random()}`;
    for (let i = 0; i < nonce.length; i++) {
        h ^= nonce.charCodeAt(i);
        h = (h >>> 0) * 0x01000193 >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

// --- Console output (harness output only — never in normal operation) -------

function printResult(label, snapshotA, snapshotB, changes, event, changeId, dispatchAttempted, verdict) {
    const group = typeof console.group === 'function';
    try {
        if (group) console.group(`[timetable-test-harness] ${label}`);
        console.log('snapshot A (old):', snapshotA);
        console.log('snapshot B (new):', snapshotB);
        console.log('detected changes:', changes);
        console.log('event type:', event ? event.changeType : '(none — no n8n event)');
        console.log('event payload (EXACTLY what is POSTed to n8n):');
        console.log(event
            ? JSON.stringify(event, null, 2)
            : 'null — no POST was made (expected for the invalid comparison)');
        console.log('changeId:', changeId);
        console.log('n8n POST attempted:', dispatchAttempted);
        console.log('verdict:', verdict);
        if (group) console.groupEnd();
    } catch {
        // Console harness output must never throw.
    }
}

// --- Core runner ------------------------------------------------------------

function runComparison(label, verdict, snapshotA, snapshotB) {
    try {
        // 1. The existing change detector. Each snapshot may be a single class
        // record or an array of records (an empty array = cancelled class).
        const oldList = Array.isArray(snapshotA) ? snapshotA : [snapshotA];
        const newList = Array.isArray(snapshotB) ? snapshotB : [snapshotB];
        const { changes } = compareTimetables(oldList, newList);

        // 2. Build the event with the existing event builder. If there is no
        // detected change (e.g. AB2 → undefined), no event exists and nothing
        // below sends anything to n8n.
        const event = changes.length ? buildN8nEvent(changes[0], CONTEXT) : null;

        // True exactly when a send will be attempted: a change exists AND a
        // webhook is configured.
        const dispatchAttempted = changes.length > 0 && webhookConfigured();

        // 3. Send through the EXISTING n8n sender. dispatchTimetableChanges()
        // is deliberately NOT used here: it derives a deterministic changeId
        // from the event and dedupes on it, so repeated harness calls with the
        // same simulated change would be blocked by the real store. Instead the
        // harness assigns a fresh UNIQUE dev-only changeId per call and hands
        // the event to sendN8nEvent(). The real dedupe (hasSent/markSent and
        // tt-n8n-sent-v1) is never consulted or modified, so real timetable
        // changes keep their stable ids and exact dedupe behavior.
        let changeId = null;
        if (event) {
            changeId = uniqueDevChangeId();
            event.changeId = changeId;
            sendN8nEvent(event); // fire-and-forget, fully wrapped, never throws
        }

        printResult(label, snapshotA, snapshotB, changes, event, changeId, dispatchAttempted, verdict);
        return { changes, event, changeId, dispatchAttempted };
    } catch (err) {
        try { console.error(`[timetable-test-harness] ${label} failed:`, err); } catch { /* ignore */ }
        return null;
    }
}

// --- Dev-only tests ---------------------------------------------------------

/** Simulate one confirmed room change: AB2 → AB1 Computer Lab. */
export function testRoomChangeNotification() {
    return runComparison(
        'room change AB2 → AB1 Computer Lab',
        'confirmed room change',
        SNAPSHOT_A,
        { ...SNAPSHOT_A, room: 'AB1 Computer Lab' }
    );
}

/** Simulate one confirmed time change: 15:00–15:55 → 16:00–16:55. */
export function testTimeChangeNotification() {
    return runComparison(
        'time change 15:00–15:55 → 16:00–16:55',
        'confirmed time change',
        SNAPSHOT_A,
        { ...SNAPSHOT_A, startTime: '16:00', endTime: '16:55' }
    );
}

/**
 * Simulate a class cancellation: the class existed in the previous timetable
 * and is gone from the new one. Produces a class_cancelled event.
 */
export function testCancellationNotification() {
    return runComparison(
        'class cancelled (removed from the timetable)',
        'confirmed class cancellation',
        SNAPSHOT_A,
        [] // the new timetable no longer contains the class
    );
}

/**
 * Simulate an incomplete room comparison: AB2 → undefined. The change
 * detector ignores it (first safety layer), so NO n8n notification is
 * produced and nothing is dispatched.
 */
export function testInvalidRoomChange() {
    return runComparison(
        'invalid room change AB2 → undefined',
        'no change detected — no n8n notification produced',
        SNAPSHOT_A,
        { ...SNAPSHOT_A, room: undefined }
    );
}

// --- Installation -----------------------------------------------------------

/**
 * Wire the harness onto window. LOCALHOST-ONLY — this is the single gate:
 * production (GitHub Pages, any non-local host) is never affected. The
 * function is idempotent and safe to call at any time.
 */
export function installTimetableTestHarness() {
    try {
        if (typeof window === 'undefined') return;
        if (isLocalhost()) {
            window.testRoomChangeNotification = testRoomChangeNotification;
            window.testTimeChangeNotification = testTimeChangeNotification;
            window.testCancellationNotification = testCancellationNotification;
            window.testInvalidRoomChange = testInvalidRoomChange;
        } else {
            delete window.testRoomChangeNotification;
            delete window.testTimeChangeNotification;
            delete window.testCancellationNotification;
            delete window.testInvalidRoomChange;
        }
    } catch {
        // Dev wiring must never throw.
    }
}

// Self-install. The mere import of this module (js/core/app.js does this)
// attaches the console functions on localhost. This statement runs after the
// static imports above have fully evaluated, so compareTimetables /
// buildN8nEvent / dispatchTimetableChanges are guaranteed to exist before the
// functions are attached to window.
installTimetableTestHarness();
