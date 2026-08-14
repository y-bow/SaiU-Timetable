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
 *     - ONE ENTRY PER MEETING: two weekly meetings of the same course/section/
 *       teacher ("FDE Sec 2 – Mon 12:15" and "FDE Sec 2 – Mon 16:00") BOTH
 *       survive — classIdentity alone (day/time/room-agnostic) must not be
 *       used to dedupe;
 *     - the SAME meeting surfaced by two parses dedupes into ONE entry and
 *       merges school/year contexts; a moved meeting (new day/time/room) stays
 *       a separate entry. `stats` reports total/meetings/duplicates/classes,
 *       and `excluded` lists the collapsed duplicate with a machine reason.
 *
 *   parseTeacherGrid (raw teacher-centric parse)
 *     - THE TEACHER TIMETABLE IS BUILT FROM THE RAW SHEET BY TEACHER, NOT FROM
 *       THE STUDENT COURSE LIST: every cell that names a teacher is a class,
 *       whether or not its course exists in any student config;
 *     - a course absent from every student list still lands in the teacher's
 *       timetable (MOST IMPORTANT); course-number cells ("Economics - 1"),
 *       glued numbers ("Psychology-1"), multi-space padding inside course
 *       names ("... Organization  & Management  Subramaniam") and empty paren
 *       placeholders never create phantom teachers; title-boundary handling
 *       folds "Sanjay Bang" / "Mridula" instead of producing "Mr.idula".
 *
 *   gatherAllTimetables (real per-year configs)
 *     - ONE raw teacher-centric parse, stamped with school/year context by
 *       each year config (a tag, never a filter — unmatched classes stay);
 *     - the DL class picks up BOTH the SCDS-2 room-scan and the SCDS-3
 *       contexts while SOAI/SOB stay silent, and lab classes merge with a lab
 *       context label.
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
    const parser = await import(pathToFileURL(join(dir, 'js/data/parser.js')).href);

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
        const { index, order, all, stats, excluded } = teacherIndex.buildTeacherIndex([cls()]);
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
        assert.equal(stats.total, 1);
        assert.equal(stats.meetings, 1);
        assert.equal(stats.duplicates, 0);
        assert.equal(stats.classes, 1);
        assert.equal(stats.entries, 1);
        assert.equal(stats.teachers, 1);
        assert.equal(stats.unassigned, 0);
        assert.equal(all.length, 1);
        assert.deepEqual(excluded, []);
    });
    await check('classes with no teacher are never indexed', () => {
        const { index, all, stats, excluded } = teacherIndex.buildTeacherIndex([
            cls({ faculty: '', section: 1 }),
            cls({ faculty: '   ', section: 2 }),
        ]);
        assert.equal(index.size, 0);
        assert.equal(stats.classes, 0);
        assert.equal(stats.unassigned, 2);
        assert.equal(all.length, 2, 'teacherless meetings still surface in `all`');
        assert.deepEqual(
            excluded.map((e) => e.reason),
            ['no teacher parsed', 'no teacher parsed'],
        );
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
            cls({ subject: 'DL', faculty: 'Dr. Tamil mam', section: 5, source: 'main', day: 'Monday', startTime: '09:15', endTime: '10:10' }),
            cls({ subject: 'DL', faculty: 'Dr.Tamilarasi', section: 5, source: 'main', day: 'Tuesday', startTime: '09:15', endTime: '10:10' }),
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
    await check('two weekly meetings of one course survive; identical meetings merge contexts', () => {
        const year2 = cls({ _ctxLabel: 'SCDS · Year 2' });
        const year3 = cls({ _ctxLabel: 'SCDS · Year 3' });
        const moved = cls({ day: 'Tuesday', startTime: '11:15', endTime: '12:10', room: 'AB2-101' });
        const { index, order, all, stats, excluded } = teacherIndex.buildTeacherIndex([year2, year3, moved]);
        assert.equal(index.size, 1);
        assert.deepEqual(order, ['prof. david']);
        const rec = index.get('prof. david');
        assert.equal(rec.classes.length, 2, 'moved meeting is a SEPARATE weekly class, not collapsed');
        assert.equal(rec.classes[0].day, 'Monday');
        assert.deepEqual(rec.classes[0].contexts, ['SCDS · Year 2', 'SCDS · Year 3']);
        assert.equal(rec.classes[1].day, 'Tuesday');
        assert.deepEqual(rec.classes[1].contexts, []);
        assert.equal(all.length, 2);
        assert.equal(stats.total, 3);
        assert.equal(stats.meetings, 2);
        assert.equal(stats.duplicates, 1);
        assert.equal(stats.classes, 2);
        assert.equal(stats.entries, 2);
        assert.equal(stats.teachers, 1);
        assert.equal(excluded.length, 1);
        assert.equal(excluded[0].reason, 'duplicate meeting');
        assert.equal(excluded[0].day, 'Monday');
    });
    await check('same course+section+teacher in two weekly meetings → both indexed', () => {
        const a = cls({ subject: 'FDE', faculty: 'Prof. Ram', section: 2, source: 'main', day: 'Monday', startTime: '12:15', endTime: '13:10', room: 'AB1-101' });
        const b = cls({ subject: 'FDE', faculty: 'Prof. Ram', section: 2, source: 'main', day: 'Monday', startTime: '16:00', endTime: '16:55', room: 'AB1-101' });
        const { index, stats } = teacherIndex.buildTeacherIndex([a, b]);
        assert.equal(index.size, 1);
        assert.equal(index.get('prof. ram').classes.length, 2, 'both weekly meetings survive (FDE Sec 2 regression)');
        assert.equal(stats.total, 2);
        assert.equal(stats.meetings, 2);
        assert.equal(stats.duplicates, 0);
        assert.equal(stats.classes, 2);
        assert.equal(stats.entries, 2);
    });

    console.log('--- parseTeacherGrid (raw teacher-centric parse) ---');
    const grid = (rows) => rows.map((r) => r.join(',')).join('\n');
    const indexFrom = (text) => teacherIndex.buildTeacherIndex(parser.parseTeacherGrid(text));

    await check('MOST IMPORTANT: a course absent from every student list still lands in the teacher index', () => {
        const text = grid([
            ['MONDAY', '09:15 AM - 10:10 AM', 'Contitutional Law 2    Dr. Sanjay Bang'],
            ['', 'AB2 - 210', 'AB2 - 210'],
        ]);
        const { index } = indexFrom(text);
        assert.ok(index.has('prof. dr.sanjay bang'), 'class indexed under the teacher even though no year config knows the course');
        const entry = index.get('prof. dr.sanjay bang').classes[0];
        assert.equal(entry.subject, 'Contitutional Law 2');
        assert.equal(entry.room, 'AB2 - 210');
        assert.deepEqual(entry.contexts, [], 'no year config matches → no context tag, but the class is NOT dropped');
    });
    await check('course-number cells ("Economics - 1") never create a teacher "1"', () => {
        const text = grid([['MONDAY', '09:15 AM - 10:10 AM', 'Economics - 1']]);
        const { all, index } = indexFrom(text);
        assert.equal(all.length, 0, 'no teacher parsed → no record');
        assert.ok(!index.has('prof. 1'));
    });
    await check('glued dash numbers ("Psychology-1") never create a teacher "1"', () => {
        const text = grid([['MONDAY', '09:15 AM - 10:10 AM', 'Psychology-1']]);
        const { all, index } = indexFrom(text);
        assert.equal(all.length, 0);
        assert.ok(!index.has('prof. 1'));
    });
    await check('multi-space padding inside a course name keeps the full subject, one teacher', () => {
        const text = grid([['MONDAY', '09:15 AM - 10:10 AM', 'Fundamentals of Business Organization  & Management  Subramaniam']]);
        const { index, order } = indexFrom(text);
        assert.ok(index.has('prof. subramaniam'), 'only the real teacher is indexed');
        assert.ok(!index.has('prof. management subramaniam'), 'no phantom "Management Subramaniam"');
        assert.ok(!index.has('prof. prof.'), 'no "Prof. Prof." artifact');
        assert.ok(!index.has('prof. & management subramaniam'), 'no split-on-& artifact');
        assert.equal(order.length, 1);
        const entry = index.get('prof. subramaniam').classes[0];
        assert.equal(entry.subject, 'Fundamentals of Business Organization & Management');
    });
    await check('course suffix kept with the subject; spaced teacher isolated ("Psychopathology II")', () => {
        const text = grid([['MONDAY', '09:15 AM - 10:10 AM', 'Psychopathology  II       Dr. Jemima']]);
        const { index } = indexFrom(text);
        assert.ok(index.has('prof. dr.jemima'));
        assert.ok(!index.has('prof. ii dr. jemima'), 'course suffix "II" must not leak into the teacher');
        const entry = index.get('prof. dr.jemima').classes[0];
        assert.equal(entry.subject, 'Psychopathology II');
    });
    await check('title-boundary: "Mridula" folds to Dr.Mridula, never "Mr.idula"', () => {
        const text = grid([['MONDAY', '09:15 AM - 10:10 AM', 'Community Psychology  Mridula']]);
        const { index } = indexFrom(text);
        assert.ok(index.has('prof. dr.mridula'));
        assert.ok(!index.has('prof. mr.idula'), 'a plain name starting with the letters of a title must not be mangled');
        assert.equal(index.get('prof. dr.mridula').classes[0].faculty, 'Prof. Dr.Mridula');
    });
    await check('parenthesized teacher ("Law of Contracts 2 ( Sanjay Bang )") parses', () => {
        const text = grid([['MONDAY', '09:15 AM - 10:10 AM', 'Law of Contracts 2 ( Sanjay Bang )']]);
        const { index } = indexFrom(text);
        const entry = index.get('prof. dr.sanjay bang').classes[0];
        assert.equal(entry.subject, 'Law of Contracts 2');
        assert.equal(entry.faculty, 'Prof. Dr.Sanjay Bang');
    });
    await check('trailing dash before the teacher ("Law of Insurance -  Sanjay Bang") is trimmed from the subject', () => {
        const text = grid([['MONDAY', '09:15 AM - 10:10 AM', 'Law of Insurance -     Sanjay Bang']]);
        const { index } = indexFrom(text);
        const entry = index.get('prof. dr.sanjay bang').classes[0];
        assert.equal(entry.subject, 'Law of Insurance');
    });
    await check('combined cells parse and index under EACH teacher', () => {
        const text = grid([
            ['MONDAY', '09:15 AM - 10:10 AM', '"ET - Sec 1 - Arjun, Sonar"'],
        ]);
        const { index } = indexFrom(text);
        assert.ok(index.has('prof. arjun'));
        assert.ok(index.has('prof. sonar'));
        assert.equal(index.get('prof. arjun').classes[0].subject, 'Emerging Tools and Applications');
        assert.deepEqual(index.get('prof. arjun').classes[0].teachers, ['Prof. Arjun', 'Prof. Sonar']);
    });
    await check('empty paren placeholder ("Labour Law 2 (    )") yields no teacher', () => {
        const text = grid([['MONDAY', '09:15 AM - 10:10 AM', 'Labour Law 2 (    )']]);
        const { all, index } = indexFrom(text);
        assert.equal(all.length, 0);
        assert.equal(index.size, 0);
    });
    await check('no room row → room empty, class still indexed', () => {
        const text = grid([['MONDAY', '09:15 AM - 10:10 AM', 'Microbiology  Dr. Grace']]);
        const { index } = indexFrom(text);
        const entry = index.get('prof. dr.grace').classes[0];
        assert.equal(entry.subject, 'Microbiology');
        assert.equal(entry.room, '');
    });

    console.log('--- gatherAllTimetables (real per-year configs) ---');
    const MAIN_TEXT = [
        'MONDAY,09:15 AM - 10:10 AM,ET - Sec 5 - Salim',
        ',AB2 - 207,AB2 - 207',
        ',10:15 AM - 11:10 AM,DL - Sec 1 - Dr. KK',
        ',AB2 - 207,AB2 - 207',
    ].join('\n');
    await check('one raw teacher-centric parse; SCDS-2 + SCDS-3 contexts stamped, SOAI/SOB silent', () => {
        const all = teacherFetch.gatherAllTimetables(MAIN_TEXT, []);
        assert.equal(all.length, 2, 'one record per teacher-named cell — ET and DL, no per-year re-parse');
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
    await check('a course absent from every student list still lands in the teacher index', () => {
        const text = [
            'MONDAY,09:15 AM - 10:10 AM,Deep Learning - Sem 5 - Dr. KK',
            ',10:15 AM - 11:10 AM,Forensic Psychology         Meera',
        ].join('\n');
        const all = teacherFetch.gatherAllTimetables(text, []);
        const fp = all.find((c) => c.subject === 'Forensic Psychology');
        assert.ok(fp, 'Forensic Psychology parsed as a class even though it is only a student elective config');
        assert.equal(fp.courseId, 'forensic-psychology', 'courseId still resolved from the knowledge base');
        assert.equal(fp.elective, undefined, 'raw teacher parse carries no student-only elective tag');
        assert.equal(fp.school, 'scds', 'context stamping still identifies the owning school');
        assert.equal(fp.year, 3);
        const { index, stats } = teacherIndex.buildTeacherIndex(all);
        assert.equal(stats.classes, 2, 'DL + Forensic Psychology both indexed');
        assert.ok(index.has('prof. meera'), 'the added course teacher appears automatically, no config change');
        const entry = index.get('prof. meera').classes[0];
        assert.equal(entry.subject, 'Forensic Psychology');
        assert.deepEqual(entry.contexts, ['SCDS · Year 3'], 'a configured elective still gets its year context');
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
