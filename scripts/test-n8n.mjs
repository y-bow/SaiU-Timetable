/**
 * n8n timetable-change notification test harness (Node).
 *
 * Exercises js/services/n8n.js end-to-end without a browser:
 *
 *   buildN8nEvent (event builder)
 *     - EXACTLY three event types are ever produced: room_changed,
 *       time_changed, class_cancelled. 'added' and 'modified' records map to
 *       null (never class_added / class_modified / class_moved / any other
 *       custom type);
 *     - a room change is its own room_changed event with oldRoom / newRoom and
 *       null time fields; any day/time move is a time_changed event with the
 *       four old/new time fields and null room fields;
 *     - a removed class is class_cancelled built from the OLD record;
 *     - section / year / school / labGroup come from the app context when the
 *       record does not carry them;
 *     - the payload contains timetable data only — no PII keys (name, email,
 *       phone, IP, fingerprint);
 *     - date is the next real occurrence of the timetable weekday.
 *
 *   buildChangeId
 *     - deterministic and independent of the event timestamp AND of the
 *       rolling calendar date, so the same change detected on a later sync
 *       hashes to the same id (dedupe);
 *     - distinct changes produce distinct ids.
 *
 *   sendN8nEvent
 *     - 'disabled' when no webhook is configured;
 *     - 'sent' on a 2xx, 'http_<code>' on other statuses, 'failed' on a
 *       network error; never throws.
 *
 *   dispatchTimetableChanges
 *     - no-op when no webhook is configured (the default) — no requests;
 *     - marks a change as sent BEFORE the network call, so a dead n8n never
 *       re-sends the same change on the next sync;
 *     - dedupes across dispatches via localStorage — the same change is never
 *       POSTed twice (identical changeId);
 *     - an unchanged timetable produces no events at all.
 *
 *   window.testN8nWebhook (dev helper)
 *     - only exposed when setN8nDebug(true) / CONFIG.N8N_DEBUG is on;
 *     - accepts an event object and posts it through the real sendN8nEvent;
 *     - room_changed / time_changed / class_cancelled pass through, any other
 *       type is rejected without a request.
 *
 * Run:  node scripts/test-n8n.mjs
 *
 * Like the other harnesses, this copies the browser modules (stripping the
 * `?v=BUILD_ID` suffixes the build injects) into a temp dir first. config.js
 * touches `window`, so a minimal window/Date/document/localStorage/fetch shim
 * is installed before importing.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const stripQuery = (src) => src.replace(/\?v=[0-9-]+/g, '');

const MODULES = [
    'js/core/config.js',
    'js/data/change-detector.js',
    'js/services/n8n.js',
];

// ---------------------------------------------------------------------------
// Browser shims (must exist before the modules are imported).
// ---------------------------------------------------------------------------

const RealDate = globalThis.Date;

// A fake "today": Monday, 27 July 2026, 13:00 local time. All `new Date()`
// calls inside the modules resolve to this instant, so dateForWeekday()
// computes stable next-occurrence dates for the whole run.
const FAKE_NOW_MS = new RealDate(2026, 6, 27, 13, 0, 0).getTime();

function FakeDate(...args) {
    if (args.length === 0) return new RealDate(FAKE_NOW_MS);
    return new RealDate(...args);
}
FakeDate.now = () => FAKE_NOW_MS;
FakeDate.parse = RealDate.parse;
FakeDate.UTC = RealDate.UTC;

globalThis.window = globalThis;
globalThis.Date = FakeDate;
globalThis.document = { addEventListener() {}, removeEventListener() {} };
window.__TT_BUILD_ID__ = 'test';
window.__TT_GA = { id: 'TEST-GA' };

// Minimal in-memory localStorage (the dedupe store).
const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
};

// Fetch shim: records every request so tests can assert on what was sent.
let requests = [];
let FETCH_ERROR = false;
const failNextFetch = () => { FETCH_ERROR = true; };
globalThis.fetch = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    requests.push({ url, body });
    if (FETCH_ERROR) { const e = new Error('network down'); FETCH_ERROR = false; throw e; }
    return { ok: true, status: 200 };
};

const reset = () => { store.clear(); requests = []; };

// ---------------------------------------------------------------------------
// Import the copied source modules.
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'tt-n8n-tests-'));
let passed = 0;
let failed = 0;

const check = async (name, fn) => {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`FAIL  ${name}\n      ${err.message}`); }
};

try {
    for (const rel of MODULES) {
        const dest = join(dir, rel);
        mkdirSync(dirname(dest), { recursive: true });
        const src = stripQuery(readFileSync(join(ROOT, rel), 'utf8'));
        writeFileSync(dest, src);
    }

    const { buildN8nEvent, buildChangeId, sendN8nEvent, dispatchTimetableChanges, setN8nDebug, sendTestEvent } =
        await import(pathToFileURL(join(dir, 'js/services/n8n.js')).href);
    const { CONFIG } = await import(pathToFileURL(join(dir, 'js/core/config.js')).href);
    const { compareTimetables } = await import(pathToFileURL(join(dir, 'js/data/change-detector.js')).href);

    setN8nDebug(false);
    reset();

    // Helpers mirroring the shape of change-detector records. Defaults to a
    // room-changed record (a meaningful event); each test overrides as needed.
    const baseClass = {
        day: 'Monday', subject: 'DAA', courseId: 'DAA', faculty: 'Prof A',
        room: 'AB2-101', section: 3, startTime: '09:00', endTime: '09:55',
    };
    const rec = (o = {}) => ({
        type: 'room-changed',
        oldRoom: 'AB2-101',
        newRoom: 'AB2-205',
        identity: 'x',
        class: { ...baseClass },
        ...o,
    });
    const ctx = { year: 'scds-2', school: 'scds', section: 3, labGroup: 'same' };

    const PII_KEYS = ['name', 'email', 'phone', 'ip', 'fingerprint', 'userId', 'studentId'];
    const containsPII = (obj) => JSON.stringify(obj).toLowerCase().split(/["'\s:]+/)
        .some((t) => PII_KEYS.includes(t));

    console.log('--- event builder: exactly three event types ---');
    await check('room-changed → room_changed with old/new room + null time fields', () => {
        const ev = buildN8nEvent(rec(), ctx);
        assert.equal(ev.type, 'room_changed');
        assert.equal(ev.oldRoom, 'AB2-101');
        assert.equal(ev.newRoom, 'AB2-205');
        assert.equal(ev.startTime, '09:00');
        assert.equal(ev.endTime, '09:55');
        assert.equal(ev.oldStartTime, null, 'a room change never touches the time fields');
        assert.equal(ev.oldEndTime, null);
        assert.equal(ev.newStartTime, null);
        assert.equal(ev.newEndTime, null);
    });
    await check('moved (same weekday, time only) → time_changed with null room fields', () => {
        const change = rec({
            type: 'moved',
            class: { ...baseClass, startTime: '10:15', endTime: '11:05' },
            oldClass: { ...baseClass },
            moved: { oldDay: 'Monday', newDay: 'Monday', oldStartTime: '09:00', newStartTime: '10:15' },
        });
        const ev = buildN8nEvent(change, ctx);
        assert.equal(ev.type, 'time_changed');
        assert.equal(ev.oldStartTime, '09:00');
        assert.equal(ev.newStartTime, '10:15');
        assert.equal(ev.oldRoom, null, 'a time change never carries the room fields');
        assert.equal(ev.newRoom, null);
        assert.equal(ev.oldDay, undefined);
    });
    await check('moved (day change) → time_changed with old/new day and times (never class_moved)', () => {
        const change = rec({
            type: 'moved',
            class: { ...baseClass, day: 'Wednesday', startTime: '14:00', endTime: '14:55' },
            oldClass: { ...baseClass },
            moved: { oldDay: 'Monday', newDay: 'Wednesday', oldStartTime: '09:00', oldEndTime: '09:55', newStartTime: '14:00', newEndTime: '14:55' },
        });
        const ev = buildN8nEvent(change, ctx);
        assert.equal(ev.type, 'time_changed');
        assert.equal(ev.oldStartTime, '09:00');
        assert.equal(ev.oldEndTime, '09:55');
        assert.equal(ev.newStartTime, '14:00');
        assert.equal(ev.newEndTime, '14:55');
        assert.equal(ev.oldDay, 'Monday');
        assert.equal(ev.newDay, 'Wednesday');
        assert.equal(ev.day, 'Wednesday');
    });
    await check('a moved record is NEVER class_moved, even when it carries roomChanged', () => {
        const change = rec({
            type: 'moved',
            roomChanged: true,
            oldRoom: 'AB2-101',
            newRoom: 'AB2-205',
            class: { ...baseClass, day: 'Tuesday', room: 'AB2-205', startTime: '11:15', endTime: '12:10' },
            oldClass: { ...baseClass },
            moved: { oldDay: 'Monday', newDay: 'Tuesday', oldStartTime: '09:00', oldEndTime: '09:55', newStartTime: '11:15', newEndTime: '12:10' },
        });
        const ev = buildN8nEvent(change, ctx);
        assert.equal(ev.type, 'time_changed');
        assert.equal(ev.oldRoom, null, 'room fields live on the room-changed record');
        assert.equal(ev.newRoom, null);

        const roomEv = buildN8nEvent(rec({ oldRoom: 'AB2-101', newRoom: 'AB2-205' }), ctx);
        assert.equal(roomEv.type, 'room_changed');
        assert.equal(roomEv.oldRoom, 'AB2-101');
        assert.equal(roomEv.newRoom, 'AB2-205');
    });
    await check('added → null (no class_added is ever sent)', () => {
        assert.equal(buildN8nEvent({ ...rec(), type: 'added' }), null);
    });
    await check('removed → class_cancelled built from the OLD record', () => {
        const change = rec({ type: 'removed', class: undefined, oldClass: { ...baseClass } });
        const ev = buildN8nEvent(change, ctx);
        assert.equal(ev.type, 'class_cancelled');
        assert.equal(ev.course, 'DAA');
        assert.equal(ev.room, 'AB2-101');
        assert.equal(ev.startTime, '09:00');
        assert.equal(ev.endTime, '09:55');
        assert.equal(ev.oldRoom, null);
        assert.equal(ev.newRoom, null);
        assert.equal(ev.oldStartTime, null);
        assert.equal(ev.newStartTime, null);
    });
    await check('modified → null (no class_modified is ever sent)', () => {
        assert.equal(buildN8nEvent({
            ...rec(),
            type: 'modified',
            class: { ...baseClass, faculty: 'Prof. New' },
            oldClass: { ...baseClass, faculty: 'Prof. Old' },
        }), null);
    });
    await check('unknown change type → null', () => {
        assert.equal(buildN8nEvent(rec({ type: 'no-change' }), ctx), null);
        assert.equal(buildN8nEvent(null, ctx), null);
        assert.equal(buildN8nEvent({}, ctx), null);
    });

    console.log('--- event builder: context & safety ---');
    await check('section/year/school come from ctx when the record lacks them', () => {
        const ev = buildN8nEvent(rec({ class: { ...baseClass, section: undefined } }), ctx);
        assert.equal(ev.section, 3);
        assert.equal(ev.year, 'scds-2');
        assert.equal(ev.school, 'scds');
        assert.equal(ev.source, 'timetable');
    });
    await check('record-carried section wins over ctx', () => {
        const ev = buildN8nEvent(rec({ class: { ...baseClass, section: 7 } }), ctx);
        assert.equal(ev.section, 7);
    });
    await check('elective flag is preserved, labGroup only for lab records', () => {
        const plain = buildN8nEvent(rec(), ctx);
        assert.equal(plain.labGroup, undefined);
        const lab = buildN8nEvent(rec({ class: { ...baseClass, subject: 'DAA Lab', courseId: 'DAAL', faculty: 'Prof B', room: 'AB2-205', lab: true } }), ctx);
        assert.equal(lab.labGroup, 'same');
        const elec = buildN8nEvent(rec({ class: { ...baseClass, subject: 'Emerging Tools', courseId: 'ET', faculty: 'Prof C', room: 'AB1-101', section: null, elective: 'emerging-tools' } }), ctx);
        assert.equal(elec.elective, 'emerging-tools');
    });
    await check('payload contains timetable data only — no PII keys', () => {
        const ev = buildN8nEvent(rec(), ctx);
        assert.equal(containsPII(ev), false, 'payload must not include PII');
    });
    await check('date is the next real occurrence of the timetable weekday', () => {
        const monday = buildN8nEvent(rec({ class: { ...baseClass } }), ctx);
        assert.equal(monday.date, '2026-07-27'); // fake today IS Monday
        const wed = buildN8nEvent(rec({ class: { ...baseClass, day: 'Wednesday' } }), ctx);
        assert.equal(wed.date, '2026-07-29');
    });

    console.log('--- change ids ---');
    await check('same change → same id (timestamp excluded)', () => {
        const a = buildN8nEvent(rec(), ctx);
        const b = buildN8nEvent(rec(), ctx);
        assert.notEqual(a.detectedAt, undefined);
        assert.equal(buildChangeId(a), buildChangeId(b));
    });
    await check('same change → same id even across different calendar dates (rolling date excluded)', () => {
        const a = buildN8nEvent(rec(), ctx);
        const b = { ...buildN8nEvent(rec(), ctx), date: '2026-09-14' };
        assert.equal(buildChangeId(a), buildChangeId(b), 'the weekday name anchors the id, not the derived date');
    });
    await check('different changes → different ids', () => {
        const a = buildN8nEvent(rec(), ctx);
        const b = buildN8nEvent(rec({ oldRoom: 'AB2-101', newRoom: 'AB2-999' }), ctx);
        assert.notEqual(buildChangeId(a), buildChangeId(b));
        const c = buildN8nEvent(rec({ type: 'moved', class: { ...baseClass, startTime: '10:15', endTime: '11:05' }, oldClass: { ...baseClass }, moved: { oldDay: 'Monday', newDay: 'Monday', oldStartTime: '09:00', newStartTime: '10:15' } }), ctx);
        assert.notEqual(buildChangeId(a), buildChangeId(c));
    });

    console.log('--- sender ---');
    await check('no webhook configured → disabled, no network request', async () => {
        CONFIG.N8N_WEBHOOK_URL = '';
        reset();
        const { status } = await sendN8nEvent({ type: 'test' });
        assert.equal(status, 'disabled');
        assert.equal(requests.length, 0);
    });
    await check('2xx response → sent', async () => {
        CONFIG.N8N_WEBHOOK_URL = 'https://n8n.example.test/webhook/tt';
        reset();
        const { status } = await sendN8nEvent({ type: 'test', source: 'saiu-timetable' });
        assert.equal(status, 'sent');
        assert.equal(requests.length, 1);
        assert.equal(requests[0].url, 'https://n8n.example.test/webhook/tt');
        assert.equal(requests[0].body.type, 'test');
    });
    await check('non-2xx response → http_<code>, never throws', async () => {
        globalThis.fetch = async () => ({ ok: false, status: 404 });
        const { status } = await sendN8nEvent({ type: 'test' });
        assert.equal(status, 'http_404');
    });
    await check('network error → failed, never throws', async () => {
        globalThis.fetch = async () => { throw new Error('boom'); };
        const { status } = await sendN8nEvent({ type: 'test' });
        assert.equal(status, 'failed');
    });

    console.log('--- dev helper: window.testN8nWebhook ---');
    await check('helper is only exposed when N8N_DEBUG is enabled', () => {
        setN8nDebug(false);
        assert.equal('testN8nWebhook' in window, false, 'hidden when debug is off');
        setN8nDebug(true);
        assert.equal(typeof window.testN8nWebhook, 'function', 'exposed when debug is on');
    });
    await check('accepts an event object and reuses sendN8nEvent', async () => {
        CONFIG.N8N_WEBHOOK_URL = 'https://n8n.example.test/webhook/tt';
        globalThis.fetch = async (url, init) => {
            requests.push({ url, body: JSON.parse(init.body) });
            return { ok: true, status: 200 };
        };
        reset();
        setN8nDebug(true);
        const res = await window.testN8nWebhook({
            type: 'room_changed', course: 'DAA', courseId: 'daa', section: 3,
            day: 'Monday', startTime: '09:00', endTime: '09:55',
            oldRoom: 'AB2-101', newRoom: 'AB2-205',
        });
        assert.equal(res.status, 'sent');
        assert.equal(requests.length, 1);
        assert.equal(requests[0].body.type, 'room_changed');
        assert.equal(requests[0].body.oldRoom, 'AB2-101');
        assert.ok(requests[0].body.detectedAt, 'a missing detectedAt is filled in');
    });
    await check('unsupported event type is rejected with no request', async () => {
        reset();
        const res = await window.testN8nWebhook({ type: 'class_added' });
        assert.equal(res.status, 'rejected');
        assert.equal(requests.length, 0);
        setN8nDebug(false); // keep DEBUG off for the dispatch tests below
    });

    console.log('--- dispatch ---');
    await check('no webhook → dispatch is a no-op (no events, no requests)', async () => {
        CONFIG.N8N_WEBHOOK_URL = '';
        reset();
        const changes = [rec(), rec({ oldRoom: 'AB2-101', newRoom: 'AB2-999' })];
        dispatchTimetableChanges(changes, ctx);
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(requests.length, 0);
    });
    await check('meaningful changes are POSTed once each (only the three types)', async () => {
        CONFIG.N8N_WEBHOOK_URL = 'https://n8n.example.test/webhook/tt';
        globalThis.fetch = async (url, init) => {
            const body = JSON.parse(init.body);
            requests.push({ url, body });
            return { ok: true, status: 200 };
        };
        reset();
        const changes = [
            rec(),
            rec({ type: 'moved', class: { ...baseClass, startTime: '10:15', endTime: '11:05' }, oldClass: { ...baseClass }, moved: { oldDay: 'Monday', newDay: 'Monday', oldStartTime: '09:00', newStartTime: '10:15' } }),
            rec({ type: 'added' }),      // must produce NO event
            rec({ type: 'modified' }),   // must produce NO event
        ];
        dispatchTimetableChanges(changes, ctx);
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(requests.length, 2);
        assert.deepEqual(requests.map((r) => r.body.type).sort(), ['room_changed', 'time_changed']);
    });
    await check('A: AB2 → AB1 Computer Lab POSTs ONE room_changed with old/new room + metadata', async () => {
        const oldC = { ...baseClass, room: 'AB2' };
        const { changes } = compareTimetables([oldC], [{ ...oldC, room: 'AB1 Computer Lab' }]);
        reset();
        dispatchTimetableChanges(changes, ctx);
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(requests.length, 1);
        const body = requests[0].body;
        assert.equal(body.type, 'room_changed');
        assert.equal(body.oldRoom, 'AB2');
        assert.equal(body.newRoom, 'AB1 Computer Lab');
        assert.equal(body.course, 'DAA');
        assert.equal(body.section, 3);
        assert.equal(body.startTime, '09:00');
        assert.equal(body.endTime, '09:55');
        assert.ok(body.changeId, 'a deterministic changeId is attached before sending');
    });
    await check('A2: the SAME room change detected again → identical changeId, no duplicate POST', async () => {
        const oldC = { ...baseClass, room: 'AB2' };
        const newC = { ...oldC, room: 'AB1 Computer Lab' };
        const { changes } = compareTimetables([oldC], [newC]);
        const event = buildN8nEvent(changes[0], ctx);
        const firstId = buildChangeId(event);
        reset();
        dispatchTimetableChanges(changes, ctx);
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(requests.length, 1);
        assert.equal(requests[0].body.changeId, firstId);
        // The exact same change appears on the next sync — must not re-send.
        const { changes: again } = compareTimetables([oldC], [newC]);
        dispatchTimetableChanges(again, ctx);
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(requests.length, 1, 'the identical change must not be POSTed twice');
    });
    await check('B: 14:00–14:55 → 15:00–15:55 POSTs ONE time_changed with all four times', async () => {
        const oldC = { ...baseClass, startTime: '14:00', endTime: '14:55' };
        const { changes } = compareTimetables([oldC], [{ ...oldC, startTime: '15:00', endTime: '15:55' }]);
        reset();
        dispatchTimetableChanges(changes, ctx);
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(requests.length, 1);
        const body = requests[0].body;
        assert.equal(body.type, 'time_changed');
        assert.equal(body.oldStartTime, '14:00');
        assert.equal(body.oldEndTime, '14:55');
        assert.equal(body.newStartTime, '15:00');
        assert.equal(body.newEndTime, '15:55');
        assert.equal(body.oldRoom, null);
        assert.equal(body.newRoom, null);
    });
    await check('C: a removed class POSTs ONE class_cancelled with the old class info', async () => {
        const oldC = { ...baseClass };
        const { changes } = compareTimetables([oldC], []);
        reset();
        dispatchTimetableChanges(changes, ctx);
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(requests.length, 1);
        const body = requests[0].body;
        assert.equal(body.type, 'class_cancelled');
        assert.equal(body.course, 'DAA');
        assert.equal(body.room, 'AB2-101');
        assert.equal(body.startTime, '09:00');
        assert.equal(body.endTime, '09:55');
    });
    await check('no timetable change at all → zero requests', async () => {
        const c = { ...baseClass };
        const { changes } = compareTimetables([c], [c]);
        assert.equal(changes.length, 0);
        reset();
        dispatchTimetableChanges(changes, ctx);
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(requests.length, 0);
    });
    await check('a combined room+time change emits room_changed AND time_changed (never class_moved)', async () => {
        reset();
        dispatchTimetableChanges([
            rec({ oldRoom: 'AB2', newRoom: 'AB1 Computer Lab' }),
            rec({
                type: 'moved',
                class: { ...baseClass, room: 'AB1 Computer Lab', startTime: '15:00', endTime: '15:55' },
                oldClass: { ...baseClass, room: 'AB2', startTime: '14:00', endTime: '14:55' },
                moved: { oldDay: 'Monday', newDay: 'Monday', oldStartTime: '14:00', oldEndTime: '14:55', newStartTime: '15:00', newEndTime: '15:55' },
            }),
        ], ctx);
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(requests.length, 2, 'one event per independent change');
        const types = requests.map((r) => r.body.type).sort();
        assert.deepEqual(types, ['room_changed', 'time_changed']);
        assert.ok(!types.includes('class_moved'));
        const room = requests.find((r) => r.body.type === 'room_changed').body;
        assert.equal(room.oldRoom, 'AB2');
        assert.equal(room.newRoom, 'AB1 Computer Lab');
        const time = requests.find((r) => r.body.type === 'time_changed').body;
        assert.equal(time.oldStartTime, '14:00');
        assert.equal(time.oldEndTime, '14:55');
        assert.equal(time.newStartTime, '15:00');
        assert.equal(time.newEndTime, '15:55');
    });
    await check('same change detected again later is NOT re-sent (dedupe)', async () => {
        reset();
        dispatchTimetableChanges([rec()], ctx);
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(requests.length, 1);
        dispatchTimetableChanges([rec()], ctx);
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(requests.length, 1, 'the identical change must not be sent twice');
    });
    await check('mark-before-send: a dead webhook still dedupes the change', async () => {
        reset();
        failNextFetch(); // first dispatch: network fails
        dispatchTimetableChanges([rec()], ctx);
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(requests.length, 1);
        // Next sync detects the same change again — the fetch must NOT be retried.
        dispatchTimetableChanges([rec()], ctx);
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(requests.length, 1, 'failed send must still mark the change as dispatched');
    });
    await check('an unchanged timetable produces no events at all', async () => {
        reset();
        dispatchTimetableChanges([], ctx);
        dispatchTimetableChanges(null, ctx);
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(requests.length, 0);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
} finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* cleanup */ }
}