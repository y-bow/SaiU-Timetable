/**
 * Real-time clock logic test harness (Node).
 *
 * Exercises the device-clock state machine and the Arjun frog transition
 * rules without a browser:
 *
 *   computeHighlight (js/ui/ui.js)
 *     - UPCOMING → IN PROGRESS → COMPLETED flips land on the exact minute
 *       boundary (2:00:00 → in progress, 2:55:00 → completed) because the
 *       display is minute-granular and whole-minute schedule times truncate
 *       second-exactly.
 *     - highlight follows the "next" class before start and the current class
 *       during it.
 *
 *   checkArjunSinghTransition (js/ui/easter-eggs.js)
 *     - fires exactly once per class occurrence, and only on an observed
 *       not-in-progress → in-progress transition;
 *     - never fires on page-load/refresh while the class is already running;
 *     - never fires for a different day;
 *     - per-occurrence keys (course + faculty + local date + start time) mean
 *       a fresh page session can still fire the frog for a new occurrence
 *       while the already-consumed one stays silent.
 *
 * Run:  node scripts/test-clock.mjs
 *
 * Like scripts/test-labs.mjs, this copies the browser modules (stripping the
 * `?v=BUILD_ID` suffixes the build injects) into a temp dir first. config.js
 * touches `window`, so a minimal window/Date/document/localStorage shim is
 * installed before importing. easter-eggs.js is imported from two differently
 * named copies to simulate two page sessions sharing localStorage.
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
    'js/core/utils.js',
    'js/core/spring.js',
    'js/data/parser.js',
    'js/ui/ui.js',
    'js/ui/display.js',
    'js/ui/easter-eggs.js',
];

// ---------------------------------------------------------------------------
// Browser shims (must exist before the modules are imported).
// ---------------------------------------------------------------------------

const RealDate = globalThis.Date;

// A fake "today": Monday, 27 July 2026, 13:00 local time. All `new Date()`
// calls inside the modules resolve to this instant, so todayName() is a
// stable Monday for the whole run.
const FAKE_NOW_MS = new RealDate(2026, 6, 27, 13, 0, 0).getTime();

function FakeDate(...args) {
    if (args.length === 0) return new RealDate(FAKE_NOW_MS);
    return new RealDate(...args);
}
FakeDate.now = () => FAKE_NOW_MS;
FakeDate.parse = RealDate.parse;
FakeDate.UTC = RealDate.UTC;

const makeEl = () => ({
    className: '',
    style: {},
    textContent: '',
    innerHTML: '',
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild() {},
    remove() {},
});

globalThis.window = globalThis;
globalThis.Date = FakeDate;
globalThis.requestAnimationFrame = (cb) => { cb(); return 0; };
globalThis.document = {
    createElement: () => makeEl(),
    body: { appendChild() {} },
    addEventListener() {},
    removeEventListener() {},
    hidden: true,
};
window.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
window.__TT_BUILD_ID__ = 'test';
window.__TT_GA = { id: 'TEST-GA' };

// Minimal in-memory localStorage for the egg persistence tests.
const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
};

// ---------------------------------------------------------------------------
// Import the copied source modules.
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'tt-clock-tests-'));
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
        // Fresh module instance for "session two" (identical source, so it
        // shares localStorage but not the in-memory triggeredThisSession set).
        if (rel === 'js/ui/easter-eggs.js') {
            writeFileSync(join(dir, 'js/ui/easter-eggs-session2.js'), src);
        }
    }

    const ui = await import(pathToFileURL(join(dir, 'js/ui/ui.js')).href);
    const { todayName } = await import(pathToFileURL(join(dir, 'js/core/utils.js')).href);
    const eggSession1 = await import(pathToFileURL(join(dir, 'js/ui/easter-eggs.js')).href);
    const eggSession2 = await import(pathToFileURL(join(dir, 'js/ui/easter-eggs-session2.js')).href);

    // A timetable for Monday with two Arjun Singh classes (14:00 and 16:00).
    const MONDAY = 'Monday';
    const arjunTwo = {
        day: MONDAY, subject: 'Algorithms', faculty: 'Prof. Arjun Singh',
        startTime: '14:00', endTime: '14:55', room: 'AB1-101',
    };
    const arjunFour = {
        day: MONDAY, subject: 'Algorithms', faculty: 'Prof. Arjun Singh',
        startTime: '16:00', endTime: '16:55', room: 'AB1-101',
    };
    const others = [
        { day: MONDAY, subject: 'DAA', faculty: 'Prof. A', startTime: '09:00', endTime: '09:55', room: 'AB2-101' },
        { day: MONDAY, subject: 'DAA Lab', faculty: 'Prof. B', startTime: '10:15', endTime: '11:05', room: 'AB2-205' },
        { day: MONDAY, subject: 'FDE', faculty: 'Prof. C', startTime: '16:30', endTime: '17:25', room: 'AB2-102' },
    ];
    const allClasses = [arjunTwo, arjunFour, ...others];

    assert.equal(todayName(), MONDAY, 'shim must pin today to Monday');

    console.log('--- computeHighlight state boundaries ---');
    await check('1:59 PM (839) → not in progress; Arjun is next', () => {
        const ctx = ui.computeHighlight(allClasses, 839, MONDAY);
        assert.equal(ctx.current, null);
        assert.equal(ctx.next.subject, 'Algorithms');
        assert.equal(ctx.next.startTime, '14:00');
    });
    await check('2:00 PM (840) → in progress exactly on the start boundary', () => {
        const ctx = ui.computeHighlight(allClasses, 840, MONDAY);
        assert.equal(ctx.current.subject, 'Algorithms');
        assert.equal(ctx.current.startTime, '14:00');
    });
    await check('2:05 PM (845) → still in progress', () => {
        const ctx = ui.computeHighlight(allClasses, 845, MONDAY);
        assert.equal(ctx.current.subject, 'Algorithms');
    });
    await check('2:54 PM (894) → still in progress at the last valid second', () => {
        const ctx = ui.computeHighlight(allClasses, 894, MONDAY);
        assert.equal(ctx.current.subject, 'Algorithms');
    });
    await check('2:55 PM (895) → completed exactly on the end boundary', () => {
        const ctx = ui.computeHighlight(allClasses, 895, MONDAY);
        assert.equal(ctx.current, null);
        assert.notEqual(ctx.next.startTime, '14:00');
    });
    await check('3:00 PM (900) → completed, next uninvolved', () => {
        const ctx = ui.computeHighlight(allClasses, 900, MONDAY);
        assert.equal(ctx.current, null);
    });
    await check('classes are sorted by start time', () => {
        const ctx = ui.computeHighlight(allClasses, 60, MONDAY);
        const starts = ctx.dayClasses.map((c) => c.startTime);
        assert.deepEqual(starts, [...starts].sort());
    });

    console.log('--- Arjun frog: observed transition (session 1) ---');
    await check('frog does not fire while the class is still upcoming', () => {
        const r = eggSession1.checkArjunSinghTransition({ classes: allClasses, nowMin: 839, day: MONDAY, current: null, next: arjunTwo, prevCurrent: null });
        assert.equal(r, null);
    });
    await check('frog fires on the exact not-in-progress → in-progress transition', () => {
        const r = eggSession1.checkArjunSinghTransition({ classes: allClasses, nowMin: 840, day: MONDAY, current: arjunTwo, next: null, prevCurrent: null });
        assert.equal(r, arjunTwo);
    });
    await check('frog does not repeat a second later (once-only + wasCurrent)', () => {
        const r = eggSession1.checkArjunSinghTransition({ classes: allClasses, nowMin: 841, day: MONDAY, current: arjunTwo, next: null, prevCurrent: arjunTwo });
        assert.equal(r, null);
    });
    await check('frog still does not repeat even if prevCurrent is lost', () => {
        const r = eggSession1.checkArjunSinghTransition({ classes: allClasses, nowMin: 841, day: MONDAY, current: arjunTwo, next: null, prevCurrent: null });
        assert.equal(r, null);
    });
    await check('a different day never fires the frog', () => {
        const r = eggSession1.checkArjunSinghTransition({ classes: allClasses, nowMin: 840, day: 'Tuesday', current: null, next: null, prevCurrent: null });
        assert.equal(r, null);
    });
    await check('load mid-class (prevCurrent already the running class) → no frog', () => {
        // The 16:00 occurrence has never fired; prevCurrent being the class
        // itself means there was no observed transition — must not fire.
        const r = eggSession1.checkArjunSinghTransition({ classes: allClasses, nowMin: 960, day: MONDAY, current: arjunFour, next: null, prevCurrent: arjunFour });
        assert.equal(r, null);
    });
    await check('no Arjun classes → no frog', () => {
        const r = eggSession1.checkArjunSinghTransition({ classes: others, nowMin: 120, day: MONDAY, current: null, next: null, prevCurrent: null });
        assert.equal(r, null);
    });

    console.log('--- Arjun frog: faculty-name variants (real parsed data) ---');
    await check('"Prof. Arjun" (Emerging Tools cell "Arjun" parses to this) fires on transition', () => {
        const cls = { day: MONDAY, subject: 'Emerging Tools and Applications', faculty: 'Prof. Arjun', startTime: '15:00', endTime: '15:55', room: 'AB1-101' };
        const r = eggSession1.checkArjunSinghTransition({ classes: [cls], nowMin: 900, day: MONDAY, current: cls, next: null, prevCurrent: null });
        assert.equal(r, cls);
    });
    await check('raw "Arjun" (un-normalized sheet form) fires too', () => {
        const cls = { day: MONDAY, subject: 'Emerging Tools and Applications', faculty: 'Arjun', startTime: '15:05', endTime: '16:00', room: 'AB1-101' };
        const r = eggSession1.checkArjunSinghTransition({ classes: [cls], nowMin: 905, day: MONDAY, current: cls, next: null, prevCurrent: null });
        assert.equal(r, cls);
    });
    await check('"Prof. Arjun Singh" (full parser-normalized name) fires on transition', () => {
        const cls = { day: MONDAY, subject: 'Algorithms', faculty: 'Prof. Arjun Singh', startTime: '18:00', endTime: '18:55', room: 'AB1-101' };
        const r = eggSession1.checkArjunSinghTransition({ classes: [cls], nowMin: 1080, day: MONDAY, current: cls, next: null, prevCurrent: null });
        assert.equal(r, cls);
    });
    await check('similar but different name ("Prof. Arjun Kumar") never fires', () => {
        const cls = { day: MONDAY, subject: 'Algorithms', faculty: 'Prof. Arjun Kumar', startTime: '17:00', endTime: '17:55', room: 'AB1-101' };
        const r = eggSession1.checkArjunSinghTransition({ classes: [cls], nowMin: 1020, day: MONDAY, current: cls, next: null, prevCurrent: null });
        assert.equal(r, null);
    });
    await check('surname-only ("Prof. Singh") never fires', () => {
        const cls = { day: MONDAY, subject: 'FDE', faculty: 'Prof. Singh', startTime: '17:00', endTime: '17:55', room: 'AB2-102' };
        const r = eggSession1.checkArjunSinghTransition({ classes: [cls], nowMin: 1020, day: MONDAY, current: cls, next: null, prevCurrent: null });
        assert.equal(r, null);
    });

    console.log('--- Arjun frog: fresh page session (shared localStorage) ---');
    await check('already-consumed occurrence stays silent in a new session', () => {
        const r = eggSession2.checkArjunSinghTransition({ classes: allClasses, nowMin: 840, day: MONDAY, current: arjunTwo, next: null, prevCurrent: null });
        assert.equal(r, null);
    });
    await check('a brand-new occurrence fires once in the new session', () => {
        const r = eggSession2.checkArjunSinghTransition({ classes: allClasses, nowMin: 960, day: MONDAY, current: arjunFour, next: null, prevCurrent: null });
        assert.equal(r, arjunFour);
    });
    await check('…and then stays silent too', () => {
        const r = eggSession2.checkArjunSinghTransition({ classes: allClasses, nowMin: 962, day: MONDAY, current: arjunFour, next: null, prevCurrent: arjunFour });
        assert.equal(r, null);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
} finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* cleanup */ }
}