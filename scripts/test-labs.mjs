/**
 * Year 2 lab parser test harness (Node).
 *
 * Covers, per requirement:
 *   DAA / FDE  → class found, class moved (different column), class removed,
 *                room changed.
 *   Emerging Tools Lab → all 3 offerings found, offerings stay separate,
 *                different rooms preserved, different times preserved, one
 *                offering changing does not overwrite the others, offering
 *                removed.
 *   Merge      → main SCDS timetable + labs → merged Year 2 timetable with no
 *                duplicate records and each record's source preserved.
 *
 * Run:  node scripts/test-labs.mjs
 *
 * The modules use browser-style `?v=BUILD_ID` import suffixes (added by
 * scripts/build.mjs). Node can't resolve those specifiers, so the harness
 * copies the modules to a temp dir with the query strings stripped first.
 *
 * Fixture sheets mirror the main SCDS grid layout: class rows carry
 * "DAY,Time,<cells…>" and the next non-empty row declares the current room of
 * each column for that slot ("<empty>,<empty>,<room,…>"). Room rows therefore
 * keep the Day/Time columns blank so room[j] lines up with class column j.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const stripQuery = (src) => src.replace(/\?v=[0-9-]+/g, '');

const MODULES = [
    'js/data/parser.js',
    'js/data/lab-config.js',
    'js/data/lab-parser.js',
    'js/services/lab-fetch.js',
];

const dir = mkdtempSync(join(tmpdir(), 'tt-lab-tests-'));
try {
    for (const rel of MODULES) {
        const dest = join(dir, rel);
        mkdirSync(dirname(dest), { recursive: true });
        const src = stripQuery(readFileSync(join(ROOT, rel), 'utf8'));
        writeFileSync(dest, src);
    }

    const { YEAR_2_LAB_SOURCES, isMissingSheetId, labCacheKey, isYear2SCDS } =
        await import(pathToFileURL(join(dir, 'js/data/lab-config.js')).href);
    const { parseCSV } = await import(pathToFileURL(join(dir, 'js/data/parser.js')).href);
    const { parseLabSheet, recordsToAppClasses, mergeTimelines, stableIdentity } =
        await import(pathToFileURL(join(dir, 'js/data/lab-parser.js')).href);
    const labFetch = await import(pathToFileURL(join(dir, 'js/services/lab-fetch.js')).href);
    const { fetchLabSource, syncYear2Labs } = labFetch;

    const DAA = YEAR_2_LAB_SOURCES.DAA_LAB;
    const FDE = YEAR_2_LAB_SOURCES.FDE_LAB;
    const ET = YEAR_2_LAB_SOURCES.EMERGING_TOOLS_LAB;

    // Minimal in-memory localStorage for the fetch-layer tests.
    const store = new Map();
    const fakeStore = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, String(v)); },
        removeItem: (k) => { store.delete(k); },
    };
    globalThis.localStorage = fakeStore;

    let passed = 0;
    let failed = 0;

    const check = async (name, fn) => {
        try { await fn(); passed++; console.log(`  ok  ${name}`); }
        catch (err) { failed++; console.error(`FAIL  ${name}\n      ${err.message}`); }
    };

    const parse = (csv, config, ctx) => recordsToAppClasses(parseLabSheet(csv, config), config, ctx);

    console.log('--- config ---');
    await check('config exposes all three Year 2 lab sources', () => {
        assert.equal(Object.keys(YEAR_2_LAB_SOURCES).length, 3);
        assert.ok(YEAR_2_LAB_SOURCES.DAA_LAB && YEAR_2_LAB_SOURCES.FDE_LAB && YEAR_2_LAB_SOURCES.EMERGING_TOOLS_LAB);
    });
    await check('sheet ids are clearly-marked placeholders (not fabricated)', () => {
        for (const s of Object.values(YEAR_2_LAB_SOURCES)) {
            assert.ok(isMissingSheetId(s), `expected placeholder for ${s.source}`);
        }
    });
    await check('lab cache keys are per-source', () => {
        const keys = Object.values(YEAR_2_LAB_SOURCES).map(labCacheKey);
        assert.equal(new Set(keys).size, keys.length);
        assert.ok(keys.every((k) => k.startsWith('tt-cache-scds-2-')));
    });
    await check('isYear2SCDS recognises only the scds-2 year', () => {
        assert.ok(isYear2SCDS({ id: 'scds-2' }));
        assert.ok(!isYear2SCDS({ id: 'scds-3' }));
        assert.ok(!isYear2SCDS(null));
    });

    console.log('--- DAA Lab ---');
    const daaV1 = [
        'Day,Time,Slot A,Slot B,Slot C',
        'MONDAY,10:15 AM - 11:05 AM,DAA Lab - Sec 1 - Arain,,',
        ',,AB2-203,AB2-205,AB1-101',
        'MONDAY,2:00 PM - 3:00 PM,,DAA Lab - Sec 2 - Burke,',
        ',,AB2-203,AB2-205,AB1-101',
    ].join('\n');

    const daaMoved = [
        'Day,Time,Slot A,Slot B,Slot C',
        'MONDAY,10:15 AM - 11:05 AM,,,DAA Lab - Sec 1 - Arain',
        ',,AB2-203,AB2-205,AB2-111',
    ].join('\n');

    const daaRoomChanged = [
        'Day,Time,Slot A',
        'MONDAY,10:15 AM - 11:05 AM,DAA Lab - Sec 1 - Arain',
        ',,AB2-205',
    ].join('\n');

    const daaRemoved = [
        'Day,Time,Slot A,Slot B',
        'MONDAY,10:15 AM - 11:05 AM,,',
        ',,AB2-203,AB2-205',
    ].join('\n');
    await check('DAA class found with room/section/source', () => {
        const c = parse(daaV1, DAA, { section: 1 });
        assert.equal(c.length, 2);
        assert.ok(c.every((x) => x.subject === 'Design and Analysis of Algorithms Lab'));
        assert.ok(c.every((x) => x.source === 'daa-lab'));
        const sec1 = c.find((x) => x.section === 1);
        const sec2 = c.find((x) => x.section === 2);
        assert.equal(sec1.room, 'AB2-203');
        assert.equal(sec2.room, 'AB2-205');
    });
    await check('DAA class moved to a different column is still found (new room)', () => {
        const c = parse(daaMoved, DAA, { section: 1 });
        assert.equal(c.length, 1);
        assert.equal(c[0].section, 1);
        assert.equal(c[0].room, 'AB2-111');
        assert.ok(c[0].room !== 'AB2-203', 'stale pre-move room must not survive');
    });
    await check('DAA room change is honoured by the latest fetch', () => {
        const c = parse(daaRoomChanged, DAA, { section: 1 });
        assert.equal(c.length, 1);
        assert.equal(c[0].room, 'AB2-205');
    });
    await check('DAA class removed from sheet produces no record', () => {
        const c = parse(daaRemoved, DAA, { section: 1 });
        assert.deepEqual(c, []);
    });

    console.log('--- FDE Lab ---');
    const fdeV1 = [
        'Day,Time,Slot A,Slot B',
        'TUESDAY,9:00 AM - 9:50 AM,FDE Lab - Sec 3 - Collard,,',
        ',,AB2-102,AB1-104',
    ].join('\n');

    const fdeMoved = [
        'Day,Time,Slot A,Slot B',
        'TUESDAY,9:00 AM - 9:50 AM,,FDE Lab - Sec 3 - Collard',
        ',,AB1-104,AB2-207',
    ].join('\n');

    const fdeRoomChanged = [
        'Day,Time,Slot A',
        'TUESDAY,9:00 AM - 9:50 AM,FDE Lab - Sec 3 - Collard',
        ',,AB1-104',
    ].join('\n');

    const fdeRemoved = [
        'Day,Time,Slot A',
        'TUESDAY,9:00 AM - 9:50 AM,',
        ',,AB1-104',
    ].join('\n');
    await check('FDE class found with room/section/source', () => {
        const c = parse(fdeV1, FDE, { section: 1 });
        assert.equal(c.length, 1);
        assert.equal(c[0].subject, 'Foundations of Data Engineering Lab');
        assert.equal(c[0].room, 'AB2-102');
        assert.equal(c[0].section, 3);
        assert.equal(c[0].source, 'fde-lab');
    });
    await check('FDE class moved to another column is still found', () => {
        const c = parse(fdeMoved, FDE, { section: 1 });
        assert.equal(c.length, 1);
        assert.equal(c[0].room, 'AB2-207');
    });
    await check('FDE room change honoured', () => {
        const c = parse(fdeRoomChanged, FDE, { section: 1 });
        assert.equal(c[0].room, 'AB1-104');
    });
    await check('FDE class removed produces no record', () => {
        assert.deepEqual(parse(fdeRemoved, FDE, { section: 1 }), []);
    });

    console.log('--- Emerging Tools Lab (elective, 3 offerings) ---');
    const etV1 = [
        'Day,Time,Off A,Off B,Off C',
        'MONDAY,2:00 PM - 2:55 PM,Emerging Tools Lab - Offering A - Vance,Emerging Tools Lab - Offering B - Yates,Emerging Tools Lab - Offering C - Zulu',
        ',,AB1-101,AB2-203,AB2-202',
    ].join('\n');
    await check('all 3 offerings found and kept separate', () => {
        const c = parse(etV1, ET, {});
        assert.equal(c.length, 1);
        const e = c[0];
        assert.equal(e.elective, 'emerging-tools-and-applications');
        assert.equal(e.subject, 'Emerging Tools Lab');
        assert.ok(e.offerings && e.offerings.length === 3, `expected 3 offerings, got ${e.offerings?.length}`);
        const rooms = e.offerings.map((o) => o.room);
        assert.ok(rooms.includes('AB1-101') && rooms.includes('AB2-203') && rooms.includes('AB2-202'));
        const ids = e.offerings.map((o) => o.section);
        assert.deepEqual(ids.sort(), ['A', 'B', 'C']);
        assert.equal(e.source, 'emerging-tools-lab');
    });
    await check('offerings preserve distinct rooms and instructors', () => {
        const e = parse(etV1, ET, {})[0];
        const byRoom = Object.fromEntries(e.offerings.map((o) => [o.room, o.faculty]));
        assert.equal(byRoom['AB1-101'], 'Prof. Vance');
        assert.equal(byRoom['AB2-203'], 'Prof. Yates');
        assert.equal(byRoom['AB2-202'], 'Prof. Zulu');
    });
    await check('different times produce separate events', () => {
        const csv = etV1 + '\n' + [
            'MONDAY,4:00 PM - 4:55 PM,Emerging Tools Lab - Offering A - Vance,,',
            ',,AB1-101,,',
        ].join('\n');
        const c = parse(csv, ET, {});
        assert.equal(c.length, 2);
        const pm4 = c.find((x) => x.startTime === '16:00');
        assert.ok(pm4, 'second time slot must be its own record');
        assert.equal(pm4.faculty, 'Prof. Vance');
        assert.equal(pm4.room, 'AB1-101');
    });
    await check('one offering changing does not overwrite the others', () => {
        const csv = [
            'Day,Time,Off A,Off B,Off C',
            'MONDAY,2:00 PM - 2:55 PM,Emerging Tools Lab - Offering A - Vance,Emerging Tools Lab - Offering B - Yates,Emerging Tools Lab - Offering C - Zulu',
            ',,AB1-101,AB2-999,AB2-202',
        ].join('\n');
        const e = parse(csv, ET, {})[0];
        const byRoom = Object.fromEntries(e.offerings.map((o) => [o.room, o.section]));
        assert.equal(byRoom['AB2-999'], 'B', 'offering B room must update');
        assert.equal(byRoom['AB1-101'], 'A', 'offering A must be untouched');
        assert.equal(byRoom['AB2-202'], 'C', 'offering C must be untouched');
    });
    await check('an offering removed from the sheet disappears', () => {
        const csv = [
            'Day,Time,Off A,Off B',
            'MONDAY,2:00 PM - 2:55 PM,Emerging Tools Lab - Offering A - Vance,Emerging Tools Lab - Offering B - Yates',
            ',,AB1-101,AB2-999',
        ].join('\n');
        const e = parse(csv, ET, {})[0];
        assert.equal(e.offerings.length, 2);
        assert.ok(!e.offerings.some((o) => o.section === 'C'));
    });
    await check('numeric Sec labels from the sheet are preserved as offerings (no fabrication)', () => {
        const csv = [
            'Day,Time,Off A,Off B,Off C',
            'MONDAY,2:00 PM - 2:55 PM,Emerging Tools Lab - Sec 1 - Vance,Emerging Tools Lab - Sec 2 - Yates,Emerging Tools Lab - Sec 3 - Zulu',
            ',,AB1-101,AB2-203,AB2-202',
        ].join('\n');
        const e = parse(csv, ET, {})[0];
        assert.equal(e.offerings.length, 3);
        assert.deepEqual(e.offerings.map((o) => o.section), [1, 2, 3]);
    });

    console.log('--- Merge (main SCDS + labs) ---');
    const mainCsv = [
        'Day,Time,Column2,Column3',
        'MONDAY,9:00 AM - 9:55 AM,Theory (Sec 1)  Prof A,Theory (Sec 1)  Prof B',
        ',,AB2-101,AB2-102',
        'TUESDAY,9:00 AM - 9:55 AM,Theory (Sec 2)  Prof A,',
        ',,AB2-101,',
    ].join('\n');
    await check('merge produces one timetable with no duplicate records', () => {
        const main = parseCSV(mainCsv, 'grid');
        assert.equal(main.length, 3, 'main fixture should parse 3 sectioned classes');

        const daa = parse(daaV1, DAA, { section: 1 });
        const fde = parse(fdeV1, FDE, { section: 1 });
        const et = parse(etV1, ET, { section: 1 });
        const lab = [...daa, ...fde, ...et];

        const merged = mergeTimelines(main, lab);
        const ids = merged.map(stableIdentity);
        assert.equal(new Set(ids).size, merged.length, 'no duplicate stable identities');

        // Every source is preserved on the merged records.
        for (const c of lab) {
            assert.ok(c.source, 'lab records must carry a source tag');
            assert.ok(merged.some((m) => stableIdentity(m) === stableIdentity(c)));
        }
        // Main records keep their own identity (no source) and are not clobbered.
        for (const c of main) {
            assert.ok(merged.some((m) => stableIdentity(m) === stableIdentity(c)));
        }
        assert.equal(merged.length, main.length + lab.length);
    });
    await check('source-scoped identity keeps main and lab records distinct', () => {
        const main = parseCSV(mainCsv, 'grid');
        const sameClass = {
            day: 'Monday', subject: 'Theory', faculty: 'Prof A', room: 'AB2-101',
            section: 1, startTime: '09:00', endTime: '09:55', source: 'daa-lab',
        };
        const labKey = stableIdentity(sameClass);
        assert.ok(!main.map(stableIdentity).includes(labKey), 'main vs lab identity must differ');
        const merged = mergeTimelines(main, [sameClass]);
        assert.equal(merged.filter((m) => stableIdentity(m) === labKey).length, 1);
    });

    console.log('--- Fetch layer (independent sources, failure isolation) ---');
    const configured = { ...DAA, sheetId: 'FAKE_SHEET_ID_1', gid: '0' };
    const daaSheetOneRow = [
        'Day,Time,Slot A',
        'WEDNESDAY,10:15 AM - 11:05 AM,DAA Lab - Sec 1 - Arain',
        ',,AB2-203',
    ].join('\n');
    await check('placeholder sheet id → unconfigured, no network request', async () => {
        let called = false;
        const prev = globalThis.fetch;
        globalThis.fetch = async () => { called = true; throw new Error('should not be fetched'); };
        try {
            const r = await fetchLabSource(DAA);
            assert.equal(r.status, 'unconfigured');
            assert.deepEqual(r.records, []);
            assert.ok(!called, 'placeholder source must not hit the network');
        } finally { globalThis.fetch = prev; }
    });
    await check('successful fetch parses + replaces the per-source cache', async () => {
        globalThis.fetch = async () => ({ ok: true, text: async () => daaSheetOneRow });
        const r = await fetchLabSource(configured);
        assert.equal(r.status, 'ok');
        assert.equal(r.records.length, 1);
        assert.equal(r.records[0].room, 'AB2-203');
    });
    await check('failed fetch falls back to the cached copy for that source', async () => {
        globalThis.fetch = async () => { throw new Error('offline'); };
        const r = await fetchLabSource(configured);
        assert.equal(r.status, 'cached');
        assert.equal(r.records.length, 1);
    });
    await check('failed fetch with no cache reports error (does not throw)', async () => {
        store.delete('tt-cache-scds-2-daa-lab');
        globalThis.fetch = async () => { throw new Error('offline'); };
        const r = await fetchLabSource(configured);
        assert.equal(r.status, 'error');
        assert.deepEqual(r.records, []);
    });
    await check('one lab source failing never drops the others or the main timetable', async () => {
        // Seed DAA's per-source cache via a successful direct fetch.
        globalThis.fetch = async () => ({ ok: true, text: async () => daaSheetOneRow });
        const seed = await fetchLabSource(configured);
        assert.equal(seed.status, 'ok');
        assert.equal(store.get('tt-cache-scds-2-daa-lab') !== null, true);

        // Give the real config objects live (fake) sheet ids, mimicking the
        // post-configuration state, then make FDE fail hard.
        const prevIds = { DAA: DAA.sheetId, FDE: FDE.sheetId, ET: ET.sheetId };
        try {
            DAA.sheetId = 'DAA_SHEET_ID';
            FDE.sheetId = 'FDE_SHEET_ID';
            ET.sheetId = 'EMERGING_TOOLS_SHEET_ID';

            globalThis.fetch = async (url) => {
                const u = String(url);
                if (u.includes('FDE_SHEET_ID')) throw new Error('HTTP 500');
                if (u.includes('EMERGING_TOOLS_SHEET_ID')) return { ok: true, text: async () => etV1 };
                return { ok: true, text: async () => daaSheetOneRow };
            };

            const { classes, statuses } = await syncYear2Labs({ section: 1 });
            assert.equal(statuses['fde-lab'], 'error', 'FDE must report error');
            assert.equal(statuses['emerging-tools-lab'], 'ok', 'ET must succeed independently');
            assert.equal(statuses['daa-lab'], 'ok', 'DAA must succeed');
            assert.ok(classes.length >= 2, 'classes from healthy sources remain');
            assert.ok(!classes.some((c) => c.source === 'fde-lab'), 'failed source contributes nothing');
            assert.ok(classes.some((c) => c.source === 'daa-lab'));
            assert.ok(classes.some((c) => c.source === 'emerging-tools-lab'));

            // The main timetable parse is entirely separate from lab fetching.
            const main = parseCSV(mainCsv, 'grid');
            assert.equal(main.length, 3, 'main timetable unaffected by lab failures');
        } finally {
            DAA.sheetId = prevIds.DAA;
            FDE.sheetId = prevIds.FDE;
            ET.sheetId = prevIds.ET;
        }
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) process.exit(1);
} finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* cleanup */ }
}