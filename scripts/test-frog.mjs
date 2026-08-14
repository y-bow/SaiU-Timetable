/**
 * Arjun Singh frog trigger test harness (Node).
 *
 * Exercises js/ui/easter-eggs.js — the development-only frog easter egg —
 * without a browser:
 *
 *   checkArjunSinghTransition
 *     - fires ONLY on a strictly observed per-occurrence transition from
 *       "starts in 1 minute" to "in progress";
 *     - never fires twice for the same occurrence (session + persisted guards);
 *     - never fires on page load while the class is already in progress;
 *     - never fires when the page re-renders / refreshes / navigates between
 *       the starts-in-1-minute tick and the in-progress tick
 *       (resetArjunSinghTransition clears the tracked state);
 *     - never fires for a different day;
 *     - never fires while stuck on repeated starts-in-1-minute ticks;
 *     - never fires for other professors (including similar-sounding names).
 *
 *   setFrogDebug / dev-host gating
 *     - the feature and its [FROG] logging are off by default (no localhost
 *       host, no debug flag) and can be force-enabled with setFrogDebug(true);
 *     - on a localhost host the feature runs even without the debug flag.
 *
 *   resetArjunSinghTransition
 *     - the app calls it on every structural re-render (load, refresh,
 *       day/section/elective/offering change) and on visibility catch-up.
 *
 * Run:  node scripts/test-frog.mjs
 *
 * Like the other harnesses, this copies the browser module (stripping the
 * `?v=BUILD_ID` suffix the build injects) into a temp dir first. The module
 * touches window/document/localStorage only at call time, but minimal shims
 * are installed before importing anyway.
 */

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const stripQuery = (src) => src.replace(/\?v=[0-9-]+/g, '');

// ---------------------------------------------------------------------------
// Browser shims (must exist before the module is imported).
// ---------------------------------------------------------------------------

const RealDate = globalThis.Date;

// A fake "today": Monday, 27 July 2026, 13:00 local time. All `new Date()`
// calls inside the module resolve to this instant.
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

// Minimal in-memory localStorage for the egg persistence tests.
const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
};

// ---------------------------------------------------------------------------
// Import the copied source module.
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), 'tt-frog-tests-'));
let passed = 0;
let failed = 0;

const check = async (name, fn) => {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`FAIL  ${name}\n      ${err.message}`); }
};

try {
    const src = stripQuery(readFileSync(join(ROOT, 'js/ui/easter-eggs.js'), 'utf8'));
    writeFileSync(join(dir, 'easter-eggs.js'), src);

    const egg = await import(pathToFileURL(join(dir, 'easter-eggs.js')).href);

    const MONDAY = 'Monday';
    const pad = (n) => String(n).padStart(2, '0');
    const addMinutes = (time, add) => {
        const [h, m] = time.split(':').map(Number);
        const total = h * 60 + m + add;
        return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
    };
    const toMin = (time) => {
        const [h, m] = time.split(':').map(Number);
        return h * 60 + m;
    };

    // A 55-minute class for Prof. Arjun Singh on the fake Monday.
    const arjunClass = (subject, startTime) => ({
        day: MONDAY, subject, faculty: 'Prof. Arjun Singh',
        startTime, endTime: addMinutes(startTime, 55), room: 'AB1-101',
    });
    const plain = (subject, startTime, faculty) => ({ ...arjunClass(subject, startTime), faculty });

    // Reset localStorage + the module's tracked state between scenarios.
    const reset = () => { store.clear(); egg.resetArjunSinghTransition(); };

    // Observe one live-clock tick for a single occurrence and return the result.
    const tick = (cls, nowMin, day = MONDAY) =>
        egg.checkArjunSinghTransition({ classes: [cls], nowMin, day });

    console.log('--- dev gating ---');
    await check('off by default (no dev host, no debug flag) → never fires', () => {
        reset();
        egg.setFrogDebug(false);
        const c = arjunClass('Alg-8', '14:00');
        tick(c, 839);
        assert.equal(tick(c, 840), null);
    });
    await check('setFrogDebug(true) enables the feature anywhere', () => {
        egg.setFrogDebug(true);
        reset();
        const c = arjunClass('Alg-9', '15:00');
        tick(c, 899);
        assert.equal(tick(c, 900), c);
    });
    await check('a localhost host enables the feature without the flag', () => {
        egg.setFrogDebug(false);
        globalThis.location = { hostname: 'localhost' };
        reset();
        const c = arjunClass('Alg-10', '16:00');
        tick(c, 959);
        assert.equal(tick(c, 960), c);
        delete globalThis.location;
        egg.setFrogDebug(true);
    });

    console.log('--- trigger semantics ---');
    await check('1. fires exactly on starts-in-1-minute → in-progress', () => {
        reset();
        const c = arjunClass('Alg-1', '14:00');
        assert.equal(tick(c, 838), null, 'upcoming');
        assert.equal(tick(c, 839), null, 'starts-in-1-minute is tracked, not fired');
        assert.equal(tick(c, 840), c, 'in-progress on the start minute fires');
    });
    await check('2. never fires twice for the same occurrence', () => {
        reset();
        const c = arjunClass('Alg-2', '14:00');
        tick(c, 839);
        assert.equal(tick(c, 840), c);
        assert.equal(tick(c, 841), null, 'repeated in-progress ticks stay silent');
        assert.equal(tick(c, 842), null);
        // Even a mid-class re-render (map wiped) cannot re-fire — the session
        // guard already consumed the occurrence.
        egg.resetArjunSinghTransition();
        assert.equal(tick(c, 850), null, 'session guard blocks re-fire after reset');
    });
    await check('3. page load while the class is already running → never fires', () => {
        reset();
        const c = arjunClass('Alg-3', '14:00');
        assert.equal(tick(c, 845), null, 'first observation is in-progress');
        assert.equal(tick(c, 846), null);
    });
    await check('4. re-render/refresh/navigation between observation and start → never fires', () => {
        reset();
        const c = arjunClass('Alg-4', '14:00');
        tick(c, 839); // starts-in-1-minute observed...
        egg.resetArjunSinghTransition(); // ...then the page re-rendered
        assert.equal(tick(c, 840), null, 'the transition was not observed continuously');
    });
    await check('5. a different day never fires', () => {
        reset();
        const c = arjunClass('Alg-5', '14:00');
        tick(c, 839, 'Tuesday');
        assert.equal(tick(c, 840, 'Tuesday'), null);
        assert.equal(tick(c, 840), null, 'today, but the class was never observed approaching');
    });
    await check('6. repeated starts-in-1-minute ticks never fire', () => {
        reset();
        const c = arjunClass('Alg-6', '14:00');
        for (let m = 830; m <= 839; m++) {
            assert.equal(tick(c, m), null, `minute ${m}`);
        }
    });
    await check('7. other professors (incl. similar names) never fire', () => {
        reset();
        const others = [
            plain('Alg-7a', '14:00', 'Prof. Sharma'),
            plain('Alg-7b', '14:05', 'Prof. Arjun Kumar'),
            plain('Alg-7c', '14:10', 'Prof. Singh'),
        ];
        for (const c of others) {
            const start = toMin(c.startTime);
            assert.equal(tick(c, start - 1), null);
            assert.equal(tick(c, start), null, `${c.faculty} must never fire`);
        }
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
} finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* cleanup */ }
}
