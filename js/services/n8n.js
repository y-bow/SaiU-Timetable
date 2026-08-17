import { CONFIG } from '../core/config.js?v=2026-08-17-001';

/**
 * n8n timetable-change notifications (optional, fully isolated).
 *
 * THE TIMETABLE NEVER DEPENDS ON n8n. This module is a fire-and-forget event
 * producer: the app detects a meaningful timetable change, builds a structured
 * event, and POSTs it to the configured n8n webhook. The webhook URL is
 * centralized in CONFIG.N8N_WEBHOOK_URL (js/core/config.js).
 *
 * Pipeline:
 *
 *     Timetable parser → change detection → N8N event builder
 *         → N8N event sender → webhook → n8n workflow → email
 *
 * Guarantees:
 *   - Empty N8N_WEBHOOK_URL → integration disabled; no network requests and
 *     no errors. The timetable keeps working normally.
 *   - Events are produced ONLY for meaningful changes. The n8n contract
 *     supports EXACTLY three event types: room_changed, time_changed and
 *     class_cancelled — nothing else is ever sent (no class_added,
 *     class_modified, class_moved or other custom types). Room changes always
 *     arrive as room_changed, day/time moves as time_changed (never a generic
 *     "class_moved"), and a removed class as class_cancelled. An unchanged
 *     timetable never sends anything and repeated polls of an unchanged
 *     timetable never send anything either.
 *   - The webhook is called ONLY as a consequence of a genuine detected
 *     timetable change: not on app start, not on a cache load, not on a
 *     refresh of an unchanged timetable, not when the user opens the page or
 *     changes year/section. Detection happens exactly where the app compares
 *     the previous cached timetable against the freshly fetched one
 *     (js/core/app.js → compareTimetables → dispatchTimetableChanges).
 *   - Every change gets a deterministic change id derived from the event type
 *     plus the course/day/section/school and old/new values (NOT the
 *     timestamp). Recently dispatched ids are persisted in localStorage, so
 *     the same change is never POSTed twice, even if the sheet still shows it
 *     on the next sync.
 *   - Sending is non-blocking, uses a short timeout, and is fully wrapped in
 *     try/catch — an offline / slow / broken n8n can never break timetable
 *     rendering or synchronization.
 *   - No personally identifying information is ever included (no name, email,
 *     phone, IP, fingerprint). Events carry timetable data only; the n8n
 *     workflow maps affected students from section / year / school / course.
 */

// The webhook URL is read lazily so tests can toggle it and so a future
// runtime configuration change works without reloading the module.
const webhookUrl = () => String(CONFIG.N8N_WEBHOOK_URL || '').trim();

const TIMEOUT_MS = CONFIG.N8N_TIMEOUT_MS || 4000;
const SENT_KEY = CONFIG.N8N_EVENTS_KEY || 'tt-n8n-sent-v1';
const MAX_SENT = 200;

// Development-only debug logging (see CONFIG.N8N_DEBUG and setN8nDebug).
let DEBUG = !!CONFIG.N8N_DEBUG;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// --- Small helpers -----------------------------------------------------------

/**
 * The date (YYYY-MM-DD) of the next occurrence of the timetable weekday,
 * starting from today. The timetable is a weekly schedule of day names, so the
 * most useful concrete date for an event is the next time that class actually
 * happens.
 */
export function dateForWeekday(dayName) {
    const raw = String(dayName ?? '').trim();
    if (!raw) return null;
    const idx = DAY_NAMES.findIndex((d) => d.toLowerCase() === raw.toLowerCase());
    if (idx === -1) return null;
    const now = new Date();
    const diff = (idx - now.getDay() + 7) % 7;
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diff);
    const pad = (n) => String(n).padStart(2, '0');
    return `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}`;
}

// FNV-1a 32-bit — deterministic across browsers and devices.
function hashString(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = (h >>> 0) * 0x01000193 >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}

/**
 * Deterministic change id for an event. Built from stable identity fields
 * only — the event timestamp is deliberately excluded so re-detecting the same
 * change on a later sync produces the same id and is skipped as a duplicate.
 * The weekday name (not the rolling calendar date) anchors the id, so the
 * identical change detected again on any later day hashes to the same id.
 */
export function buildChangeId(event) {
    const parts = [
        event.changeType,
        event.courseId,
        event.course,
        event.section,
        event.school,
        event.day,
        event.oldStartTime, event.oldEndTime, event.newStartTime, event.newEndTime,
        event.startTime, event.endTime,
        event.oldRoom, event.newRoom, event.room,
        event.oldFaculty, event.faculty,
    ];
    const canonical = parts
        .map((p) => String(p ?? '').trim().toLowerCase().replace(/\s+/g, ' '))
        .join('|');
    return hashString(canonical);
}

// --- Dispatched-change persistence (localStorage, defensive) -----------------

// Per-session dedupe set. It backs the localStorage store so a change is never
// re-sent twice within one page lifetime, even if storage becomes unavailable
// or is cleared mid-session (storage writes silently fail, reads return []).
const sessionSent = new Set();

function readSent() {
    try {
        const raw = localStorage.getItem(SENT_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr : [];
    } catch {
        return [];
    }
}

function hasSent(id) {
    if (sessionSent.has(id)) return true;
    return readSent().includes(id);
}

function markSent(id) {
    sessionSent.add(id);
    try {
        const arr = readSent();
        if (!arr.includes(id)) arr.push(id);
        if (arr.length > MAX_SENT) arr.splice(0, arr.length - MAX_SENT);
        localStorage.setItem(SENT_KEY, JSON.stringify(arr));
    } catch {
        // Storage full / unavailable — the session set still dedupes for the
        // rest of this page lifetime.
    }
}

// --- Debug logging -----------------------------------------------------------

function debugLog(event, status) {
    if (!DEBUG) return;
    try {
        const line = (k, v) => {
            if (v !== undefined && v !== null && v !== '') console.log(`${k}:\n${v}`);
        };
        console.log('N8N EVENT');
        line('changeType', event.changeType);
        line('changeId', event.changeId);
        line('course', event.course);
        line('section', event.section);
        line('oldStartTime', event.oldStartTime);
        line('newStartTime', event.newStartTime);
        line('oldRoom', event.oldRoom);
        line('newRoom', event.newRoom);
        console.log(`status:\n${status}`);
    } catch {
        // Logging must never throw.
    }
}

// --- Event builder -----------------------------------------------------------

/**
 * Fields common to every timetable event. `c` is the class record the event
 * describes; `ctx` carries the app's current navigation context (school,
 * year, section, lab group) for records that do not carry it themselves.
 *
 * The event type field is `changeType` and the dispatch timestamp is
 * `detectedAt`, so the webhook contract stays exactly:
 *   { changeId, changeType, course, school, section, date, day, startTime,
 *     endTime, oldRoom, newRoom, oldStartTime, oldEndTime, newStartTime,
 *     newEndTime, detectedAt, ... }
 */
function coreFields(c, ctx, changeType) {
    ctx = ctx || {};
    const out = {
        changeType,
        detectedAt: new Date().toISOString(),
        date: dateForWeekday(c.day),
        day: c.day ?? null,
        course: c.subject ?? null,
        courseId: c.courseId ?? null,
        faculty: c.faculty ?? undefined,
        year: c.year != null ? c.year : (ctx.year != null ? ctx.year : null),
        school: ctx.school || (c.school ? String(c.school).toUpperCase() : null),
        section: c.section != null ? c.section : (ctx.section != null ? ctx.section : null),
        source: 'timetable',
    };
    if (c.elective) out.elective = c.elective;
    if ((c.lab === true || c.source) && ctx.labGroup) out.labGroup = ctx.labGroup;
    return out;
}

function buildRoomChanged(change, ctx) {
    const c = change.class;
    return {
        ...coreFields(c, ctx, 'room_changed'),
        startTime: c.startTime ?? null,
        endTime: c.endTime ?? null,
        oldRoom: change.oldRoom ?? null,
        newRoom: change.newRoom ?? null,
        oldStartTime: null,
        oldEndTime: null,
        newStartTime: null,
        newEndTime: null,
    };
}

function buildMoved(change, ctx) {
    const oldC = change.oldClass;
    const newC = change.class;
    const m = change.moved || {};

    // Any day/time move is a time_changed event. The change detector reports a
    // room change as its own separate 'room-changed' record (with oldRoom /
    // newRoom), so a moved record must NEVER be flattened into a generic
    // class_moved — the supported n8n types are room_changed, time_changed and
    // class_cancelled only. A moved record never carries the room fields.
    const ev = {
        ...coreFields(newC, ctx, 'time_changed'),
        startTime: newC.startTime ?? null,
        endTime: newC.endTime ?? null,
        oldRoom: null,
        newRoom: null,
        oldStartTime: m.oldStartTime ?? oldC.startTime ?? null,
        oldEndTime: m.oldEndTime ?? oldC.endTime ?? null,
        newStartTime: m.newStartTime ?? newC.startTime ?? null,
        newEndTime: m.newEndTime ?? newC.endTime ?? null,
        room: newC.room ?? null,
    };
    // When the class also moved to a different weekday, surface that too.
    if (m.oldDay !== m.newDay) {
        ev.oldDay = m.oldDay ?? oldC.day ?? null;
        ev.newDay = m.newDay ?? newC.day ?? null;
    }
    return ev;
}

function buildRemoved(change, ctx) {
    // The new timetable no longer contains this class — the OLD record is the
    // only information we still have, so the event is built from it.
    const c = change.oldClass;
    return {
        ...coreFields(c, ctx, 'class_cancelled'),
        startTime: c.startTime ?? null,
        endTime: c.endTime ?? null,
        oldRoom: null,
        newRoom: null,
        oldStartTime: null,
        oldEndTime: null,
        newStartTime: null,
        newEndTime: null,
        room: c.room ?? null,
    };
}

/**
 * Map a smart change-detector record to a structured n8n event.
 * Returns null for changes that are not meaningful (nothing to notify).
 *
 * ONLY three event types are ever produced — room_changed, time_changed and
 * class_cancelled. 'added' classes and 'modified' classes are NOT meaningful
 * to the notification workflow and never become events.
 */
export function buildN8nEvent(change, ctx) {
    if (!change || !change.changeType) return null;
    switch (change.changeType) {
        case 'room-changed': return buildRoomChanged(change, ctx);
        case 'moved': return buildMoved(change, ctx);
        case 'removed': return buildRemoved(change, ctx);
        default: return null;
    }
}

// --- Event sender ------------------------------------------------------------

/**
 * POST one event to the n8n webhook. Fire-and-forget: never throws, bounded
 * by a short timeout. Returns { status } where status is one of:
 *   'disabled' (no webhook configured), 'sent', 'failed', 'http_<code>'.
 */
export async function sendN8nEvent(event) {
    if (CONFIG.N8N_ENABLED === false) {
        debugLog(event, 'disabled');
        return { status: 'disabled' };
    }
    const url = webhookUrl();
    if (!url) {
        debugLog(event, 'disabled');
        return { status: 'disabled' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(event),
            signal: controller.signal,
        });
        const status = res.ok ? 'sent' : `http_${res.status}`;
        debugLog(event, status);
        return { status };
    } catch {
        debugLog(event, 'failed');
        return { status: 'failed' };
    } finally {
        clearTimeout(timer);
    }
}

// --- Orchestration -----------------------------------------------------------

/**
 * Convert a list of smart change-detector records into events and dispatch
 * them to n8n. Non-blocking: the caller must NOT await this.
 *
 * Only meaningful changes produce events; dedupe ensures each distinct change
 * is sent at most once per browser; the sender never throws.
 *
 * ctx = { year, school, section, labGroup } from the app's current navigation
 * state (see app.js n8nContext).
 */
export function dispatchTimetableChanges(changes, ctx) {
    if (!webhookUrl() || !changes || !changes.length) return;
    // The dispatch runs inside load()'s try/catch — a single malformed change
    // record must never throw here, or the timetable would misreport a
    // successful fetch as "offline". Each record is isolated so one bad event
    // can never block the rest.
    for (const change of changes) {
        try {
            const event = buildN8nEvent(change, ctx);
            if (!event) continue;
            const changeId = buildChangeId(event);
            if (hasSent(changeId)) continue;
            // Mark BEFORE the network call: even if n8n is down, the same change is
            // never re-sent on the next sync (guarantees a single request per
            // distinct change).
            markSent(changeId);
            event.changeId = changeId;
            sendN8nEvent(event); // fire-and-forget
        } catch {
            // A broken event must never break the timetable load.
        }
    }
}

// --- Development helpers -----------------------------------------------------

/**
 * Test-only: clear the per-session dedupe set (the persistent localStorage
 * store is untouched). The dispatch test harness calls this before each case
 * so a change id dispatched by an earlier case can never suppress a later one.
 */
export function resetN8nDedupe() {
    sessionSent.clear();
}

// Event types a manual test event may carry. The helper exists to exercise the
// REAL sender path with realistic data, so only the meaningful change types are
// accepted — anything else is rejected before a request is made.
const TEST_EVENT_TYPES = new Set(['room_changed', 'time_changed', 'class_cancelled']);

/**
 * Dev-only toggle for N8N debug logging. When enabled it also exposes
 * window.testN8nWebhook(event) so a timetable-change event can be triggered
 * manually without waiting for the real timetable to change. Disable for
 * production (CONFIG.N8N_DEBUG).
 */
export function setN8nDebug(enabled) {
    DEBUG = !!enabled;
    try {
        if (typeof window === 'undefined') return;
        if (DEBUG) window.testN8nWebhook = sendTestEvent;
        else delete window.testN8nWebhook;
    } catch {
        // Debug wiring must never throw.
    }
}

/**
 * Dev-only manual test: send ONE timetable-change event through the real
 * sendN8nEvent() pipeline. The event object is passed through as-is (a
 * `detectedAt` timestamp is added when missing). Only `room_changed`,
 * `time_changed` and `class_cancelled` are allowed — any other type is
 * rejected without a request, so the helper can never fabricate a payload
 * shape the production pipeline would not produce. Returns the same
 * { status } as sendN8nEvent().
 */
export function sendTestEvent(event) {
    const changeType = event && event.changeType;
    if (!TEST_EVENT_TYPES.has(changeType)) {
        return Promise.resolve({
            status: 'rejected',
            reason: `testN8nWebhook expects an event object with changeType one of: ${Array.from(TEST_EVENT_TYPES).join(', ')}`,
        });
    }
    return sendN8nEvent({
        ...event,
        detectedAt: event.detectedAt || new Date().toISOString(),
    });
}
