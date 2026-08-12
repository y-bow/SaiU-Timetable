/**
 * Teacher timetable test harness (Node).
 *
 * Exercises the teacher-indexing feature end to end:
 *
 *   splitTeachers
 *     - a single teacher cell normalizes to the canonical "Prof. X" form
 *       ("Dr.K.K.Singh" → "Prof. Dr.K.K.Singh"), including per-name aliases
 *       inside combined cells ("Dr. Tamil mam" → "Prof. Dr.Tamilarasi");
 *     - combined cells split on comma / semicolon / slash / "and" / "&"
 *       into one teacher per segment, each normalized independently;
 *     - empty/garbage cells yield [] — teachers are never invented.
 *
 *   buildTeacherIndex
 *     - basic indexing keeps teacher/teachers/originalFaculty/contexts;
 *     - classes with no teacher are never indexed (counted as unassigned);
 *     - NO fuzzy merging: "Prof. Arjun" and "Prof. Arjun Singh" stay distinct;
 *     - the sheets' own alias table merges "Dr. Tamil mam" → "Prof.
 *       Dr.Tamilarasi" under one key;
 *     - a co-taught class ("Prof. Arjun, Prof. Sonar") is indexed under EACH
 *       teacher, each entry carrying the full teachers array;
 *     - the same physical class seen by two parses dedupes into ONE entry and
 *       merges school/year contexts; day/time/room are NOT part of identity,
 *       so a moved class still dedupes.
 *
 *   gatherAllTimetables (real per-year configs)
 *     - one main-sheet text parsed once per year config (SCDS-2 room-scoped
 *       scan, SCDS-3 mandatory/electives, SOAI-2, SOB-BBA-2) with context
 *       labels, plus merged lab classes;
 *     - the DL class surfaces from BOTH the SCDS-2 room scan and the SCDS-3
 *       parse and must collapse to one entry whose contexts name both years.
 *
 *   loadTeacherIndex (full chain, mocked fetch/localStorage)
 *     - live run: network-first fetch of the shared sheet + lab tabs → index;
 *     - offline run: fetch fails but the localStorage cache still serves.
 *
 * Like the other harnesses, the browser modules are copied to a temp dir with
 * the `?v=BUILD_ID` suffixes stripped before importing.
 *
 * Run:  node scripts/test-teachers.mjs
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
    'js/data/course-normalizer.js',
    'js/data/change-detector.js',
    'js/data/schools.js',
    'js/data/lab-config.js',
    'js/data/lab-parser.js',
    'js/data/teacher-index.js',
    'js/services/lab-fetch.js',
    'js/services/teacher-fetch.js',
];

const dir = mkdtempSync(join(tmpdir(), 'tt-teacher-tests-'));
try {
    for (const rel of MODULES) {
        const dest = join(dir, rel);
        mkdirSync(dirname(dest), { recursive: true });
        const src = stripQuery(readFileSync(join(ROOT, rel), 'utf8'));
        writeFileSync(dest, src);
    }

    const teacherIndex = await import(pathToFileURL(join(dir, 'js/data/teacher-index.js')).href);
    const teacherFetch = await import(pathToFileURL(join(dir, 'js/services/teacher-fetch.js')).href);

    let passed = 0;
    let failed = 0;

    const check = async (name, fn) => {
        try { await fn(); passed++; console.log(`  ok  ${name}`); }
        catch (err) { failed++; console.error(`FAIL  ${name}\n      ${err.message}`); }
    };

    const cls = (overrides = {}) => ({
        subject: 'Design and Analysis of Algorithms Lab',
        faculty: 'Prof. David',
        section: 1,
        day: 'Monday',
        startTime: '10:15',
        endTime: '11:05',
        room: 'AB1 Computer Lab',
        source: 'daa-lab',
        ...overrides,
    });

    console.log('--- splitTeachers ---');
    await check('single teacher normalizes to the canonical "Prof. X" form', () => {
        assert.deepEqual(teacherIndex.splitTeachers('Dr.K.K.Singh'), ['Prof. Dr.K.K.Singh']);
        assert.deepEqual(teacherIndex.splitTeachers('Arjun'), ['Prof. Arjun']);
    });
    await check('per-name aliases resolve inside a cell ("Dr. Tamil mam")', () => {
        assert.deepEqual(teacherIndex.splitTeachers('Dr. Tamil mam'), ['Prof. Dr.Tamilarasi']);
    });
    await check('combined cells split on , ; / "and" & into one teacher each', () => {
        assert.deepEqual(
            teacherIndex.splitTeachers('Prof. Arjun, Prof. Sonar'),
            ['Prof. Arjun', 'Prof. Sonar'],
        );
        assert.deepEqual(
            teacherIndex.splitTeachers('Prof. Arjun; Prof. Sonar'),
            ['Prof. Arjun', 'Prof. Sonar'],
        );
        assert.deepEqual(
            teacherIndex.splitTeachers('Prof. Arjun / Prof. Sonar'),
            ['Prof. Arjun', 'Prof. Sonar'],
        );
        assert.deepEqual(
            teacherIndex.splitTeachers('Prof. Arjun and Prof. Sonar'),
            ['Prof. Arjun', 'Prof. Sonar'],
        );
        assert.deepEqual(
            teacherIndex.splitTeachers('Prof. Arjun & Prof. Sonar'),
            ['Prof. Arjun', 'Prof. Sonar'],
        );
    });
    await check('empty/garbage cells yield no teachers', () => {
        assert.deepEqual(teacherIndex.splitTeachers(''), []);
        assert.deepEqual(teacherIndex.splitTeachers('   '), []);
        assert.deepEqual(teacherIndex.splitTeachers(null), []);
        assert.deepEqual(teacherIndex.splitTeachers(undefined), []);
    });

    console.log('--- buildTeacherIndex ---');
    await check('basic indexing keeps teacher/teachers/originalFaculty/contexts', () => {
        const { index, order, stats } = teacherIndex.buildTeacherIndex([cls()]);
        assert.equal(index.size, 1);
        assert.ok(index.has('prof. david'));
        assert.deepEqual(order, ['prof. david']);
        const entry = index.get('prof. david').classes[0];
        assert.equal(entry.teacher, 'Prof. David');
        assert.deepEqual(entry.teachers, ['Prof. David']);
        assert.equal(entry.originalFaculty, 'Prof. David');
        assert.deepEqual(entry.contexts, []);
        assert.equal(entry.section, 1);
        assert.equal(entry.source, 'daa-lab');
        assert.equal(stats.classes, 1);
        assert.equal(stats.entries, 1);
        assert.equal(stats.teachers, 1);
        assert.equal(stats.unassigned, 0);
    });
    await check('classes with no teacher are never indexed', () => {
        const { index, stats } = teacherIndex.buildTeacherIndex([
            cls({ faculty: '', section: 1 }),
            cls({ faculty: '   ', section: 2 }),
        ]);
        assert.equal(index.size, 0);
        assert.equal(stats.classes, 0);
        assert.equal(stats.unassigned, 2);
    });
    await check('NO fuzzy merging: distinct names stay distinct teachers', () => {
        const { index } = teacherIndex.buildTeacherIndex([
            cls({ subject: 'ET', faculty: 'Prof. Arjun', section: 1, source: 'main' }),
            cls({ subject: 'ET', faculty: 'Prof. Arjun Singh', section: 1, source: 'main' }),
        ]);
        assert.equal(index.size, 2);
        assert.ok(index.has('prof. arjun'));
        assert.ok(index.has('prof. arjun singh'));
    });
    await check('alias spellings merge under the canonical key', () => {
        const { index } = teacherIndex.buildTeacherIndex([
            cls({ subject: 'DL', faculty: 'Dr. Tamil mam', section: 5, source: 'main' }),
            cls({ subject: 'DL', faculty: 'Dr.Tamilarasi', section: 5, source: 'main' }),
        ]);
        assert.equal(index.size, 1);
        assert.ok(index.has('prof. dr.tamilarasi'));
        assert.equal(index.get('prof. dr.tamilarasi').classes.length, 2);
    });
    await check('a co-taught class is indexed under EACH teacher', () => {
        const { index, stats } = teacherIndex.buildTeacherIndex([
            cls({ subject: 'ET', faculty: 'Prof. Arjun, Prof. Sonar', section: 1, source: 'main' }),
        ]);
        assert.ok(index.has('prof. arjun'));
        assert.ok(index.has('prof. sonar'));
        const underArjun = index.get('prof. arjun').classes[0];
        assert.equal(underArjun.teacher, 'Prof. Arjun');
        assert.deepEqual(underArjun.teachers, ['Prof. Arjun', 'Prof. Sonar']);
        assert.equal(underArjun.originalFaculty, 'Prof. Arjun, Prof. Sonar');
        const underSonar = index.get('prof. sonar').classes[0];
        assert.equal(underSonar.teacher, 'Prof. Sonar');
        assert.deepEqual(underSonar.teachers, ['Prof. Arjun', 'Prof. Sonar']);
        assert.equal(stats.classes, 1);
        assert.equal(stats.entries, 2);
    });
    await check('same class from two parses dedupes; moved class still dedupes', () => {
        const year2 = cls({ _ctxLabel: 'SCDS · Year 2' });
        const year3 = cls({ _ctxLabel: 'SCDS · Year 3' });
        const moved = cls({ day: 'Tuesday', startTime: '11:15', endTime: '12:10', room: 'AB2-101' });
        const { index, stats } = teacherIndex.buildTeacherIndex([year2, year3, moved]);
        assert.equal(index.size, 1);
        const entry = index.get('prof. david').classes[0];
        assert.equal(index.get('prof. david').classes.length, 1);
        assert.deepEqual(entry.contexts, ['SCDS · Year 2', 'SCDS · Year 3']);
        assert.equal(stats.classes, 1);
        assert.equal(stats.entries, 1);
    });

    console.log('--- gatherAllTimetables (real per-year configs) ---');
    const MAIN_TEXT = [
        'MONDAY,09:15 AM - 10:10 AM,ET - Sec 5 - Salim',
        ',AB2 - 207,AB2 - 207',
        ',10:15 AM - 11:10 AM,DL - Sec 1 - Dr. KK',
        ',AB2 - 207,AB2 - 207',
    ].join('\n');
    await check('one sheet parsed per year config; DL collapsed across years', () => {
        const all = teacherFetch.gatherAllTimetables(MAIN_TEXT, []);
        assert.equal(all.length, 3, 'SCDS-2 (2) + SCDS-3 (1); SOAI/SOB must stay silent');
        const { index, stats } = teacherIndex.buildTeacherIndex(all);
        assert.equal(stats.classes, 2);
        assert.equal(stats.entries, 2);
        assert.equal(stats.teachers, 2);
        assert.ok(index.has('prof. salim'));
        assert.ok(index.has('prof. dr.k.k.singh'));
        const et = index.get('prof. salim').classes[0];
        assert.equal(et.subject, 'Emerging Tools and Applications');
        assert.equal(et.section, 5);
        assert.deepEqual(et.contexts, ['SCDS · Year 2']);
        const dl = index.get('prof. dr.k.k.singh').classes[0];
        assert.equal(dl.subject, 'Deep Learning');
        assert.equal(dl.section, 1);
        assert.deepEqual(dl.contexts, ['SCDS · Year 2', 'SCDS · Year 3']);
    });
    await check('lab classes merge in with a lab context label', () => {
        const lab = cls({ school: 'SCDS', year: 2, lab: true });
        const all = teacherFetch.gatherAllTimetables('', [lab]);
        assert.equal(all.length, 1);
        const { index } = teacherIndex.buildTeacherIndex(all);
        const entry = index.get('prof. david').classes[0];
        assert.equal(entry.lab, true);
        assert.deepEqual(entry.contexts, ['SCDS · Year 2 Lab']);
    });

    console.log('--- loadTeacherIndex (mocked fetch + localStorage) ---');
    const store = new Map();
    globalThis.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, String(v)); },
        removeItem: (k) => { store.delete(k); },
        clear: () => store.clear(),
    };
    const LAB_CSV = [
        'Day,Time,Section',
        'Monday,10:15 AM - 11:05 AM,daa sec1 arain',
    ].join('\n');
    const liveFetch = async (url) => ({
        ok: true,
        status: 200,
        text: async () => (url.includes('export?format=csv') ? MAIN_TEXT : LAB_CSV),
    });
    await check('live run builds the full index from sheet + labs', async () => {
        globalThis.fetch = liveFetch;
        const res = await teacherFetch.loadTeacherIndex();
        assert.equal(res.source, 'live');
        assert.ok(res.index.has('prof. salim'));
        assert.ok(res.index.has('prof. dr.k.k.singh'));
        assert.ok(res.index.has('prof. arain'), 'lab teacher merged');
        assert.ok(res.index.get('prof. arain').classes[0].lab === true);
        assert.ok(res.index.get('prof. arain').classes[0].contexts.includes('SCDS · Year 2 Lab'));
        assert.ok(store.has(teacherFetch.TEACHER_CACHE_KEY), 'index cached');
        assert.ok(store.has(teacherFetch.MAIN_SHEET_CACHE_KEY), 'main sheet cached');
    });
    await check('offline run falls back to the cached index', async () => {
        globalThis.fetch = async () => { throw new Error('offline'); };
        const res = await teacherFetch.loadTeacherIndex();
        assert.equal(res.source, 'cached');
        assert.ok(res.index.has('prof. salim'));
        assert.ok(res.index.has('prof. dr.k.k.singh'));
    });
    await check('nothing cached + network down → null, never throws', async () => {
        store.clear();
        globalThis.fetch = async () => { throw new Error('offline'); };
        const res = await teacherFetch.loadTeacherIndex();
        assert.equal(res, null);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) process.exit(1);
} finally {
    rmSync(dir, { recursive: true, force: true });
}
