/**
 * Year 2 lab parser test harness (Node).
 *
 * Covers, per the current list-format tab design (Day | Time | Section):
 *   DAA / FDE  → mandatory lab row parsed with its lab section + faculty,
 *                day inheritance across repeated rows, LUNCH BREAK skipped,
 *                removal from the sheet produces no record.
 *   Emerging Tools Lab → elective lab rows become FLAT classes carrying the
 *                electine id (the app resolves the chosen course offering via
 *                the sidebar dropdown); different sections/faculties stay
 *                separate; consecutive sessions of one offering merge.
 *   Merge      → main SCDS timetable + labs → merged Year 2 timetable with no
 *                duplicate records and each record's source preserved.
 *
 * Run:  node scripts/test-labs.mjs
 *
 * The modules use browser-style `?v=BUILD_ID` import suffixes (added by
 * scripts/build.mjs). Node can't resolve those specifiers, so the harness
 * copies the modules to a temp dir with the query strings stripped first.
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

    const { YEAR_2_LAB_SOURCES, isMissingSheetId, labCacheKey, isYear2SCDS, labSheetUrl } =
        await import(pathToFileURL(join(dir, 'js/data/lab-config.js')).href);
    const { parseCSV } = await import(pathToFileURL(join(dir, 'js/data/parser.js')).href);
    const { parseLabCSV, recordsToAppClasses, mergeTimelines, stableIdentity } =
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

    // Raw records → app-shaped classes, mirroring the app's fetch pipeline.
    const parse = (csv, config, ctx) => recordsToAppClasses(parseLabCSV(csv, config), config, ctx);

    console.log('--- config ---');
    await check('config exposes all three Year 2 lab sources', () => {
        assert.equal(Object.keys(YEAR_2_LAB_SOURCES).length, 3);
        assert.ok(YEAR_2_LAB_SOURCES.DAA_LAB && YEAR_2_LAB_SOURCES.FDE_LAB && YEAR_2_LAB_SOURCES.EMERGING_TOOLS_LAB);
    });
    await check('all sources share the real spreadsheet id (not placeholders)', () => {
        assert.equal(DAA.sheetId, FDE.sheetId);
        assert.equal(FDE.sheetId, ET.sheetId);
        assert.equal(isMissingSheetId(DAA), false);
        assert.ok(labSheetUrl(DAA).includes('sheet='), 'uses the gviz tab endpoint');
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

    console.log('--- DAA Lab (limit list tab) ---');
    const daaV1 = [
        'Day,Time,Section',
        'Monday,10:15 AM - 11:05 AM,daa sec1 arain',
        'Monday,11:15 AM - 12:10 PM,daa sec2 burke',
    ].join('\n');
    const daaRemoved = [
        'Day,Time,Section',
        'Monday,10:15 AM - 11:05 AM,',
    ].join('\n');
    await check('DAA class found with lab section / faculty / source', () => {
        const c = parse(daaV1, DAA, {});
        assert.equal(c.length, 2);
        assert.ok(c.every((x) => x.subject === 'Design and Analysis of Algorithms Lab'));
        assert.ok(c.every((x) => x.lab === true));
        assert.ok(c.every((x) => x.source === 'daa-lab'));
        assert.equal(c[0].section, 1);
        assert.equal(c[0].faculty, 'Prof. Arain');
        assert.equal(c[0].startTime, '10:15');
        assert.equal(c[1].section, 2);
    });
    await check('DAA row removed from sheet produces no record', () => {
        assert.deepEqual(parse(daaRemoved, DAA, {}), []);
    });

    console.log('--- FDE Lab ---');
    const fdeV1 = [
        'Day,Time,Section',
        'Tuesday,9:00 AM - 9:50 AM,fde sec3 collard',
    ].join('\n');
    await check('FDE class found with lab section / faculty / source', () => {
        const c = parse(fdeV1, FDE, {});
        assert.equal(c.length, 1);
        assert.equal(c[0].subject, 'Foundations of Data Engineering Lab');
        assert.equal(c[0].section, 3);
        assert.equal(c[0].faculty, 'Prof. Collard');
        assert.equal(c[0].source, 'fde-lab');
        assert.equal(c[0].day, 'Tuesday');
    });

    console.log('--- Day inheritance + interruptions ---');
    const inheritedDay = [
        'Day,Time,Section',
        'Wednesday,10:15 AM - 11:05 AM,daa sec4 arora',
        ',11:15 AM - 12:10 PM,daa sec5 bose',
        ',LUNCH BREAK,',
        ',2:00 PM - 3:00 PM,daa sec6 chatterjee',
    ].join('\n');
    await check('blank day inherits + LUNCH BREAK rows are skipped', () => {
        const c = parse(inheritedDay, DAA, {});
        assert.equal(c.length, 3);
        assert.ok(c.every((x) => x.day === 'Wednesday'));
        assert.deepEqual(c.map((x) => x.section), [4, 5, 6]);
    });

    console.log('--- Emerging Tools Lab (elective, flat classes) ---');
    const etV1 = [
        'Day,Time,Section',
        'Monday,3:00 PM - 3:55 PM,et sec1 arjun',
        'Thursday,12:00 PM - 12:55 PM,et sec2 david',
        'Friday,3:00 PM - 3:55 PM,et sec3 sonar',
    ].join('\n');
    await check('elective lab rows become flat classes with the elective id', () => {
        const c = parse(etV1, ET, {});
        assert.equal(c.length, 3);
        for (const e of c) {
            assert.equal(e.subject, 'Emerging Tools Lab');
            assert.equal(e.elective, 'emerging-tools-and-applications');
            assert.equal(e.lab, true);
            assert.equal(e.source, 'emerging-tools-lab');
        }
        assert.deepEqual(c.map((x) => x.section), [1, 2, 3]);
        assert.deepEqual(c.map((x) => x.faculty), ['Prof. Arjun', 'Prof. David', 'Prof. Sonar']);
    });
    await check('different faculty/sections stay separate events', () => {
        const c = parse(etV1, ET, {});
        assert.equal(new Set(c.map((x) => x.faculty)).size, 3);
        assert.equal(new Set(c.map((x) => x.day)).size, 3);
    });
    await check('consecutive sessions of one offering merge into one class', () => {
        const csv = [
            'Day,Time,Section',
            'Monday,3:00 PM - 3:55 PM,et sec3 sonar',
            ',4:00 PM - 4:55 PM,et sec3 sonar',
        ].join('\n');
        const c = parse(csv, ET, {});
        assert.equal(c.length, 1, 'two consecutive sessions merge');
        assert.equal(c[0].startTime, '15:00');
        assert.equal(c[0].endTime, '16:55');
        assert.equal(c[0].faculty, 'Prof. Sonar');
    });

    console.log('--- Room-scoped scan (Year 2 SCDS) ---');
    const roomCsv = [
        'Day,Time,Column2,Column3',
        'MONDAY,9:00 AM - 9:55 AM,Theory (Sec 1)  Prof A,Theory (Sec 2)  Prof B',
        ',,AB1 Computer Lab,AB2-101',
        'TUESDAY,10:15 AM - 11:05 AM,Embedded Systems (Sec 1)  Prof C,',
        ',,AB1-COMPUTER LAB,',
    ].join('\n');
    await check('room-scoped scan finds classes only in configured rooms', () => {
        const c = parseCSV(roomCsv, 'grid', null, null, ['AB1 Computer Lab', 'AB2-101']);
        assert.equal(c.length, 3);
        assert.ok(c[0].subject.includes('Theory') && c[0].section === 1, 'lab-room class parsed with section');
        assert.ok(c[1].subject.includes('Theory') && c[1].section === 2, 'AB2-101 class parsed with section');
        assert.deepEqual(c.map((x) => x.room), ['AB1 Computer Lab', 'AB2-101', 'AB1-COMPUTER LAB']);
    });
    await check('hyphen and space spellings of the same room both match', () => {
        const c = parseCSV(roomCsv, 'grid', null, null, ['AB1 Computer Lab']);
        assert.equal(c.length, 2, 'both Monday and Tuesday rows resolve to the lab room');
        assert.ok(c.some((x) => x.subject.includes('Embedded Systems')), 'the AB1-COMPUTER LAB spelling is recognised');
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

        const daa = parse(daaV1, DAA, {});
        const fde = parse(fdeV1, FDE, {});
        const et = parse(etV1, ET, {});
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
    const placeholder = { ...DAA, sheetId: 'PLACEHOLDER_UNSET_SHEET_ID' };
    const daaSheetOneRow = [
        'Day,Time,Section',
        'WEDNESDAY,10:15 AM - 11:05 AM,daa sec1 arain',
    ].join('\n');
    await check('placeholder sheet id → unconfigured, no network request', async () => {
        let called = false;
        const prev = globalThis.fetch;
        globalThis.fetch = async () => { called = true; throw new Error('should not be fetched'); };
        try {
            const r = await fetchLabSource(placeholder);
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
        assert.equal(r.records[0].section, 1);
        assert.equal(r.records[0].faculty, 'Prof. Arain');
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