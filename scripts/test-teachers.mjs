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
 *   teacher identity (js/data/teacher-identity.js)
 *     - HIGH confidence: title variants merge ("Prof. Mariya" / "Prof. Dr.
 *       Mariya", "Dr. Jemima" / "Jemima") and one-character spelling drifts
 *       merge ("Vigneshwaran" / "Vigneswaran") into ONE canonical identity;
 *     - MEDIUM confidence: first-name-only vs full name ("Mariya" /
 *       "Mariya Shah") and phonetic first-name variants ("Prof. Roopam" /
 *       "Prof. Rupam Sah") stay SEPARATE and surface as confirmation
 *       candidates — never auto-merged;
 *     - confirmed merges apply on the next build (one identity, aliases kept);
 *     - search text covers canonical id + display name + every alias.
 *
 *   buildTeacherIndex
 *     - basic indexing keeps teacher/teachers/originalFaculty/contexts plus
 *       aliases/canonicalId; keys are canonical identity ids ("david");
 *     - classes with no teacher are never indexed (counted as unassigned);
 *     - first-name variants stay distinct until confirmed;
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
 *       folds "Sanjay Bang" / "Mridula" instead of producing "Mr.idula";
 *     - a two-teacher cell ("Dr. Anil / Ms. Shimantika") indexes under EACH.
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
 *     - offline run: fetch fails but the localStorage cache still serves;
 *     - a confirmed merge (localStorage) is applied on the next live build.
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
    'js/data/teacher-identity.js',
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
    const identity = await import(pathToFileURL(join(dir, 'js/data/teacher-identity.js')).href);

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

    console.log('--- teacher identity ---');
    await check('HIGH: title variants merge into ONE identity ("Prof. Mariya" / "Prof. Dr. Mariya")', () => {
        assert.equal(identity.identityConfidence('Prof. Dr.Mariya', 'Prof. Mariya').level, 'high');
        const res = identity.buildIdentityResolution(['Prof. Dr.Mariya', 'Prof. Mariya'], []);
        assert.equal(res.byId.size, 1);
        assert.ok(res.byId.has('mariya'));
        assert.equal(res.byId.get('mariya').displayName, 'Prof. Dr.Mariya');
        assert.deepEqual(res.byId.get('mariya').aliases, ['Prof. Dr.Mariya', 'Prof. Mariya']);
    });
    await check('HIGH: title-only variant merges ("Dr. Jemima" / "Jemima")', () => {
        assert.equal(identity.identityConfidence('Dr. Jemima', 'Jemima').level, 'high');
        const res = identity.buildIdentityResolution(['Prof. Dr.Jemima', 'Prof. Jemima'], []);
        assert.equal(res.byId.size, 1);
        assert.ok(res.byId.has('jemima'));
        assert.deepEqual(res.byId.get('jemima').aliases, ['Prof. Dr.Jemima', 'Prof. Jemima']);
    });
    await check('HIGH: minor spelling variant merges ("Vigneshwaran" / "Vigneswaran")', () => {
        assert.equal(identity.identityConfidence('Dr. Vigneshwaran', 'Dr. Vigneswaran').level, 'high');
        const res = identity.buildIdentityResolution(['Prof. Dr.Vigneshwaran', 'Prof. Dr.Vigneswaran'], []);
        assert.equal(res.byId.size, 1);
        assert.ok(res.byId.has('vigneshwaran'));
    });
    await check('MEDIUM: first-name-only vs full name stays SEPARATE + candidate ("Mariya" / "Mariya Shah")', () => {
        assert.equal(identity.identityConfidence('Mariya', 'Mariya Shah').level, 'medium');
        const res = identity.buildIdentityResolution(['Prof. Mariya', 'Prof. Mariya Shah'], []);
        assert.equal(res.byId.size, 2, 'must NOT auto-merge without confirmation');
        assert.ok(res.byId.has('mariya'));
        assert.ok(res.byId.has('mariya-shah'));
        assert.equal(res.candidates.length, 1);
        assert.equal(res.candidates[0].reason, 'first-name-only vs full name');
    });
    await check('MEDIUM: phonetic first-name variant is a candidate, not a merge ("Roopam" / "Rupam Sah")', () => {
        assert.equal(identity.identityConfidence('Prof. Roopam', 'Prof. Rupam Sah').level, 'medium');
        const res = identity.buildIdentityResolution(['Prof. Roopam', 'Prof. Rupam Sah'], []);
        assert.equal(res.byId.size, 2, 'Roopam/Rupam Sah stay separate until confirmed');
        assert.ok(res.byId.has('roopam'));
        assert.ok(res.byId.has('rupam-sah'));
        assert.equal(res.candidates.length, 1);
        assert.equal(res.candidates[0].reason, 'similar first-name spelling');
    });
    await check('LOW: unrelated similar names stay separate', () => {
        assert.equal(identity.identityConfidence('Dr. Anil', 'Ms. Shimantika').level, 'low');
        const res = identity.buildIdentityResolution(['Prof. Dr.Anil', 'Prof. Ms.Shimantika'], []);
        assert.equal(res.byId.size, 2);
        assert.equal(res.candidates.length, 0);
    });
    await check('confirmed merge applies: Roopam + Rupam Sah → one identity with aliases', () => {
        const res = identity.buildIdentityResolution(
            ['Prof. Roopam', 'Prof. Rupam Sah'],
            [{ a: 'Prof. Roopam', b: 'Prof. Rupam Sah' }],
        );
        assert.equal(res.byId.size, 1, 'confirmed pair merges on the next build');
        assert.ok(res.byId.has('rupam-sah'));
        assert.equal(res.byId.get('rupam-sah').displayName, 'Prof. Rupam Sah');
        assert.deepEqual(
            res.byId.get('rupam-sah').aliases.sort(),
            ['Prof. Roopam', 'Prof. Rupam Sah'].sort(),
        );
        assert.equal(res.candidates.length, 0, 'no longer a pending candidate once merged');
    });
    await check('search text covers id + display name + folded aliases', () => {
        const t = identity.teacherSearchText('rupam-sah', 'Prof. Rupam Sah', ['Prof. Roopam']);
        assert.ok(t.includes('rupam-sah'));
        assert.ok(t.includes('rupam sah'));
        assert.ok(t.includes('roopam'), '"Roopam" finds the teacher via its alias');
    });
    await check('alias: Surya Krish and Surya C resolve to the same canonical teacher', () => {
        const res = identity.buildIdentityResolution(['Prof. Surya Krish', 'Prof. Surya C'], []);
        assert.equal(res.byId.size, 1, 'both names must merge into ONE identity');
        assert.ok(res.byId.has('surya-c'), 'canonical id is surya-c');
        const aliases = res.byId.get('surya-c').aliases;
        assert.ok(aliases.includes('Prof. Surya Krish'), 'Surya Krish is an alias');
        assert.ok(aliases.includes('Prof. Surya C'), 'Surya C is an alias');
        // The normalizeFacultyName layer adds "Prof. " later; the identity
        // displayName is the raw name without title prefix.
        assert.ok(res.byId.get('surya-c').displayName.includes('Surya C'), 'display name contains Surya C');
    });
    await check('normalizeFacultyName: "Surya Krish" normalizes to "Prof. Surya C"', () => {
        const result = parser.normalizeFacultyName('Surya Krish');
        assert.equal(result, 'Prof. Surya C');
    });

    console.log('--- buildTeacherIndex ---');
    await check('basic indexing keeps teacher/teachers/originalFaculty/contexts/aliases', () => {
        const { index, order, all, stats, excluded } = teacherIndex.buildTeacherIndex([cls()]);
        assert.equal(index.size, 1);
        assert.ok(index.has('david'));
        assert.deepEqual(order, ['david']);
        const rec = index.get('david');
        const entry = rec.classes[0];
        assert.equal(rec.name, 'Prof. David');
        assert.deepEqual(rec.aliases, ['Prof. David']);
        assert.ok(rec.searchText.includes('david'));
        assert.equal(entry.teacher, 'Prof. David');
        assert.deepEqual(entry.teachers, ['Prof. David']);
        assert.equal(entry.originalFaculty, 'Prof. David');
        assert.equal(entry.canonicalId, 'david');
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
    await check('first-name-only vs full name stay distinct until confirmed', () => {
        const { index, candidates } = teacherIndex.buildTeacherIndex([
            cls({ subject: 'COA', faculty: 'Prof. Mariya', section: 1, source: 'main' }),
            cls({ subject: 'COA', faculty: 'Prof. Mariya Shah', section: 1, source: 'main' }),
        ]);
        assert.equal(index.size, 2, 'must not auto-merge ambiguous first-name variants');
        assert.ok(index.has('mariya'));
        assert.ok(index.has('mariya-shah'));
        assert.equal(candidates.length, 1);
    });
    await check('title variants merge under one canonical identity', () => {
        const { index } = teacherIndex.buildTeacherIndex([
            cls({ subject: 'Psychopathology I', faculty: 'Dr. Jemima', section: 1, source: 'main' }),
            cls({ subject: 'Theories of Personalities', faculty: 'Jemima', section: 1, source: 'main' }),
        ]);
        assert.equal(index.size, 1, 'title variants are the same person');
        assert.ok(index.has('jemima'));
        assert.equal(index.get('jemima').classes.length, 2);
    });
    await check('spelling variant merges under one canonical identity', () => {
        const { index } = teacherIndex.buildTeacherIndex([
            cls({ subject: 'BME', faculty: 'Dr. Vigneshwaran', section: 1, source: 'main' }),
            cls({ subject: 'BME', faculty: 'Dr. Vigneswaran', section: 1, source: 'main' }),
        ]);
        assert.equal(index.size, 1);
        assert.ok(index.has('vigneshwaran'));
        assert.equal(index.get('vigneshwaran').classes.length, 2);
    });
    await check('alias spellings merge under the canonical key', () => {
        const { index } = teacherIndex.buildTeacherIndex([
            cls({ subject: 'DL', faculty: 'Dr. Tamil mam', section: 5, source: 'main', day: 'Monday', startTime: '09:15', endTime: '10:10' }),
            cls({ subject: 'DL', faculty: 'Dr.Tamilarasi', section: 5, source: 'main', day: 'Tuesday', startTime: '09:15', endTime: '10:10' }),
        ]);
        assert.equal(index.size, 1);
        assert.ok(index.has('tamilarasi'));
        assert.equal(index.get('tamilarasi').classes.length, 2);
    });
    await check('a co-taught class is indexed under EACH teacher', () => {
        const { index, stats } = teacherIndex.buildTeacherIndex([
            cls({ subject: 'ET', faculty: 'Prof. Arjun, Prof. Sonar', section: 1, source: 'main' }),
        ]);
        assert.ok(index.has('arjun'));
        assert.ok(index.has('sonar'));
        const underArjun = index.get('arjun').classes[0];
        assert.equal(underArjun.teacher, 'Prof. Arjun');
        assert.deepEqual(underArjun.teachers, ['Prof. Arjun', 'Prof. Sonar']);
        assert.equal(underArjun.originalFaculty, 'Prof. Arjun, Prof. Sonar');
        const underSonar = index.get('sonar').classes[0];
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
        assert.deepEqual(order, ['david']);
        const rec = index.get('david');
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
        assert.equal(index.get('ram').classes.length, 2, 'both weekly meetings survive (FDE Sec 2 regression)');
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
        assert.ok(index.has('sanjay-bang'), 'class indexed under the teacher even though no year config knows the course');
        const entry = index.get('sanjay-bang').classes[0];
        assert.equal(entry.subject, 'Contitutional Law 2');
        assert.equal(entry.room, 'AB2 - 210');
        assert.deepEqual(entry.contexts, [], 'no year config matches → no context tag, but the class is NOT dropped');
    });
    await check('course-number cells ("Economics - 1") never create a teacher "1"', () => {
        const text = grid([['MONDAY', '09:15 AM - 10:10 AM', 'Economics - 1']]);
        const { all, index } = indexFrom(text);
        assert.equal(all.length, 0, 'no teacher parsed → no record');
        assert.ok(!index.has('1'));
    });
    await check('glued dash numbers ("Psychology-1") never create a teacher "1"', () => {
        const text = grid([['MONDAY', '09:15 AM - 10:10 AM', 'Psychology-1']]);
        const { all, index } = indexFrom(text);
        assert.equal(all.length, 0);
        assert.ok(!index.has('1'));
    });
    await check('multi-space padding inside a course name keeps the full subject, one teacher', () => {
        const text = grid([['MONDAY', '09:15 AM - 10:10 AM', 'Fundamentals of Business Organization  & Management  Subramaniam']]);
        const { index, order } = indexFrom(text);
        assert.ok(index.has('subramaniam'), 'only the real teacher is indexed');
        assert.ok(!index.has('management-subramaniam'), 'no phantom "Management Subramaniam"');
        assert.ok(!index.has('prof'), 'no "Prof. Prof." artifact');
        assert.ok(!index.has('management'), 'no split-on-& artifact');
        assert.equal(order.length, 1);
        const entry = index.get('subramaniam').classes[0];
        assert.equal(entry.subject, 'Fundamentals of Business Organization & Management');
    });
    await check('course suffix kept with the subject; spaced teacher isolated ("Psychopathology II")', () => {
        const text = grid([['MONDAY', '09:15 AM - 10:10 AM', 'Psychopathology  II       Dr. Jemima']]);
        const { index } = indexFrom(text);
        assert.ok(index.has('jemima'));
        assert.ok(!index.has('ii-dr-jemima'), 'course suffix "II" must not leak into the teacher');
        const entry = index.get('jemima').classes[0];
        assert.equal(entry.subject, 'Psychopathology II');
    });
    await check('title-boundary: "Mridula" folds to Dr.Mridula, never "Mr.idula"', () => {
        const text = grid([['MONDAY', '09:15 AM - 10:10 AM', 'Community Psychology  Mridula']]);
        const { index } = indexFrom(text);
        assert.ok(index.has('mridula'));
        assert.ok(!index.has('mr-idula'), 'a plain name starting with the letters of a title must not be mangled');
        assert.equal(index.get('mridula').classes[0].faculty, 'Prof. Dr.Mridula');
    });
    await check('parenthesized teacher ("Law of Contracts 2 ( Sanjay Bang )") parses', () => {
        const text = grid([['MONDAY', '09:15 AM - 10:10 AM', 'Law of Contracts 2 ( Sanjay Bang )']]);
        const { index } = indexFrom(text);
        const entry = index.get('sanjay-bang').classes[0];
        assert.equal(entry.subject, 'Law of Contracts 2');
        assert.equal(entry.faculty, 'Prof. Dr.Sanjay Bang');
    });
    await check('trailing dash before the teacher ("Law of Insurance -  Sanjay Bang") is trimmed from the subject', () => {
        const text = grid([['MONDAY', '09:15 AM - 10:10 AM', 'Law of Insurance -     Sanjay Bang']]);
        const { index } = indexFrom(text);
        const entry = index.get('sanjay-bang').classes[0];
        assert.equal(entry.subject, 'Law of Insurance');
    });
    await check('combined cells parse and index under EACH teacher', () => {
        const text = grid([
            ['MONDAY', '09:15 AM - 10:10 AM', '"ET - Sec 1 - Arjun, Sonar"'],
        ]);
        const { index } = indexFrom(text);
        assert.ok(index.has('arjun'));
        assert.ok(index.has('sonar'));
        assert.equal(index.get('arjun').classes[0].subject, 'Emerging Tools and Applications');
        assert.deepEqual(index.get('arjun').classes[0].teachers, ['Prof. Arjun', 'Prof. Sonar']);
    });
    await check('a two-teacher cell indexes under EACH teacher ("Dr. Anil / Ms. Shimantika")', () => {
        const text = grid([['MONDAY', '09:15 AM - 10:10 AM', 'Introduction to Zoology    Dr. Anil / Ms. Shimantika']]);
        const { index } = indexFrom(text);
        assert.ok(index.has('anil'));
        assert.ok(index.has('shimantika'));
        assert.equal(index.get('anil').classes[0].teachers.length, 2);
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
        const entry = index.get('grace').classes[0];
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
        assert.ok(index.has('salim'));
        assert.ok(index.has('k-k-singh'));
        const et = index.get('salim').classes[0];
        assert.equal(et.subject, 'Emerging Tools and Applications');
        assert.equal(et.section, 5);
        assert.deepEqual(et.contexts, ['SCDS · Year 2']);
        const dl = index.get('k-k-singh').classes[0];
        assert.equal(dl.subject, 'Deep Learning');
        assert.equal(dl.section, 1);
        assert.deepEqual(dl.contexts, ['SCDS · Year 2', 'SCDS · Year 3']);
    });
    await check('a course absent from every student list still lands in the teacher index', () => {
        const text = [
            'MONDAY,09:15 AM - 10:10 AM,Deep Learning - Sem 5 - Dr. KK',
            ',10:15 AM - 11:10 AM,Forensic Psychology - Dr. Mridula',
        ].join('\n');
        const all = teacherFetch.gatherAllTimetables(text, []);
        const fp = all.find((c) => c.subject === 'Forensic Psychology');
        assert.ok(fp, 'Forensic Psychology parsed as a class even though it is only a student elective config');
        assert.equal(fp.courseId, 'forensic-psychology', 'courseId still resolved from the knowledge base');
        assert.equal(fp.elective, undefined, 'raw teacher parse carries no student-only elective tag');
        assert.equal(fp.school, 'scds', 'context stamping still identifies the owning school');
        assert.ok(fp.year === 2 || fp.year === 3, 'year set from the first matching year config');
        const { index, stats } = teacherIndex.buildTeacherIndex(all);
        assert.equal(stats.classes, 2, 'DL + Forensic Psychology both indexed');
        assert.ok(index.has('mridula'), 'the added course teacher appears automatically, no config change');
        const entry = index.get('mridula').classes[0];
        assert.equal(entry.subject, 'Forensic Psychology');
        assert.deepEqual(entry.contexts, ['SCDS · Year 3', 'SOB · Year 2'], 'a configured elective gets contexts from every matching year');
    });
    await check('lab classes merge in with a lab context label', () => {
        const lab = cls({ school: 'SCDS', year: 2, lab: true });
        const all = teacherFetch.gatherAllTimetables('', [lab]);
        assert.equal(all.length, 1);
        const { index } = teacherIndex.buildTeacherIndex(all);
        const entry = index.get('david').classes[0];
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
        assert.ok(res.index.has('salim'));
        assert.ok(res.index.has('k-k-singh'));
        assert.ok(res.index.has('arain'), 'lab teacher merged');
        assert.ok(res.index.get('arain').classes[0].lab === true);
        assert.ok(res.index.get('arain').classes[0].contexts.includes('SCDS · Year 2 Lab'));
        assert.ok(store.has(teacherFetch.TEACHER_CACHE_KEY), 'index cached');
        assert.ok(store.has(teacherFetch.MAIN_SHEET_CACHE_KEY), 'main sheet cached');
    });
    await check('offline run falls back to the cached index', async () => {
        globalThis.fetch = async () => { throw new Error('offline'); };
        const res = await teacherFetch.loadTeacherIndex();
        assert.equal(res.source, 'cached');
        assert.ok(res.index.has('salim'));
        assert.ok(res.index.has('k-k-singh'));
    });
    await check('nothing cached + network down → null, never throws', async () => {
        store.clear();
        globalThis.fetch = async () => { throw new Error('offline'); };
        const res = await teacherFetch.loadTeacherIndex();
        assert.equal(res, null);
    });
    await check('a confirmed merge is applied on the next live build', async () => {
        // Re-seed a clean store with a sheet containing both spellings.
        store.clear();
        globalThis.fetch = async () => ({
            ok: true,
            status: 200,
            text: async () => [
                'MONDAY,09:15 AM - 10:10 AM,Web Technology - Sec 1 - Rupam Sah',
                ',02.00 PM - 2.55PM,Web Technology - Sec 3 - Roopam',
            ].join('\n'),
        });
        const before = await teacherFetch.loadTeacherIndex();
        assert.equal(before.index.size, 2, 'before confirmation: two separate identities');
        assert.ok(before.index.has('rupam-sah'));
        assert.ok(before.index.has('roopam'));
        assert.equal(before.candidates.length, 1, 'Roopam/Rupam Sah surface as a candidate');

        // Confirm the merge — must persist and take effect without editing the sheet.
        identity.confirmTeacherMerge('Prof. Rupam Sah', 'Prof. Roopam');
        const after = await teacherFetch.loadTeacherIndex();
        assert.equal(after.index.size, 1, 'after confirmation: one identity');
        assert.ok(after.index.has('rupam-sah'));
        assert.ok(!after.index.has('roopam'));
        assert.deepEqual(
            after.index.get('rupam-sah').aliases.sort(),
            ['Prof. Roopam', 'Prof. Rupam Sah'].sort(),
        );
        assert.equal(after.index.get('rupam-sah').classes.length, 2, 'both weekly classes under one teacher');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) process.exit(1);
} finally {
    rmSync(dir, { recursive: true, force: true });
}