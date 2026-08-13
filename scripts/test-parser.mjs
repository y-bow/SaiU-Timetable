/**
 * Teacher extraction test harness (Node).
 *
 * Exercises the subject/faculty splitting in js/data/parser.js:
 *
 *   splitSubjectFaculty
 *     - SOAI/SOB cells separate subject from teacher with a run of spaces
 *       ("Differential Equations         ArunKumar") — the run must SURVIVE
 *       marker stripping so the teacher is not glued into the subject;
 *     - dash format "Subject - Teacher" (single or double spaces) works;
 *     - semester/section markers " - Sem N - " and " - Sec N - " are stripped
 *       and never leak into the faculty name;
 *     - a dash inside the subject itself ("Organizational Psychology -
 *       Micro Perspective") is preserved when a space run isolates the teacher;
 *     - a parenthesized faculty "(Aravind)" is unwrapped;
 *     - a cell with no teacher yields empty faculty (never invented);
 *     - the faculty name is normalized ("Prof. " prefix, known name aliases).
 *
 *   parseCSV (grid, SOAI/SOB unsectioned path)
 *     - SOAI / SOB classes parsed from a grid carry their real teacher;
 *     - a class with no teacher in the sheet keeps empty faculty.
 *
 *   parseCSV (grid, SCDS room-scoped path)
 *     - "Subject - Sem 5 - Teacher" and "Subject - Sec N - Teacher" cells
 *       keep subject/faculty/section intact;
 *     - a sectionless non-elective cell is skipped (belongs to another year).
 *
 * Like the other harnesses, the browser modules are copied to a temp dir with
 * the `?v=BUILD_ID` suffixes stripped before importing.
 *
 * Run:  node scripts/test-parser.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const stripQuery = (src) => src.replace(/\?v=[0-9-]+/g, '');

const MODULES = ['js/data/parser.js', 'js/data/course-normalizer.js'];

const dir = mkdtempSync(join(tmpdir(), 'tt-parser-'));
for (const rel of MODULES) {
    const dest = join(dir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, stripQuery(readFileSync(join(ROOT, rel), 'utf8')));
}

const { splitSubjectFaculty, parseCSV } = await import(pathToFileURL(join(dir, 'js/data/parser.js')).href);

let passed = 0;
let failed = 0;

const check = (name, fn) => {
    try { fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`FAIL  ${name}\n      ${err.message}`); }
};

console.log('--- splitSubjectFaculty: space-separated (SOAI/SOB) ---');
await check('multi-space run separates subject from teacher', () => {
    const { subject, faculty } = splitSubjectFaculty('Differential Equations         ArunKumar');
    assert.equal(subject, 'Differential Equations');
    assert.equal(faculty, 'Prof. ArunKumar');
});
await check('space run survives when the teacher has a title', () => {
    const { subject, faculty } = splitSubjectFaculty('Constitutional Law 2                     Dr. Sanjay Bang');
    assert.equal(subject, 'Constitutional Law 2');
    assert.equal(faculty, 'Prof. Dr.Sanjay Bang');
});
await check('space run with a known name alias resolves', () => {
    const { faculty } = splitSubjectFaculty('Biostatistics                      Dr. Sivan');
    assert.equal(faculty, 'Prof. Dr.Sivan');
});

console.log('--- splitSubjectFaculty: dash format ---');
await check('"Subject - Teacher" with single spaces', () => {
    const { subject, faculty } = splitSubjectFaculty('Image Processing - Dr Aasy');
    assert.equal(subject, 'Image Processing');
    assert.equal(faculty, 'Prof. Dr.Aasy');
});
await check('"Subject - Teacher" with double spaces around the dash', () => {
    const { subject, faculty } = splitSubjectFaculty('Law of Insurance -                      Sanjay Bang');
    assert.equal(subject, 'Law of Insurance');
    assert.equal(faculty, 'Prof. Sanjay Bang');
});
await check('plain "Subject - Teacher" (no extra spacing) still splits', () => {
    const { subject, faculty } = splitSubjectFaculty('Moot Court and Internship - Nasma Sultana');
    assert.equal(subject, 'Moot Court and Internship');
    assert.equal(faculty, 'Prof. Nasma Sultana');
});

console.log('--- splitSubjectFaculty: semester/section markers ---');
await check('" - Sem 5 - " marker is stripped, teacher isolated', () => {
    const { subject, faculty } = splitSubjectFaculty('DL - Sem 5 - Dr. KK');
    assert.equal(subject, 'DL');
    assert.equal(faculty, 'Prof. Dr.K.K.Singh');
});
await check('" - Sec 1 - " marker is stripped, teacher isolated', () => {
    const { subject, faculty } = splitSubjectFaculty('INTT EMB - Sec 1 - Dr. Ashok');
    assert.equal(subject, 'INTT EMB');
    assert.equal(faculty, 'Prof. Dr.Ashok');
});
await check('" - Sem N - " marker with a double space before the dash', () => {
    const { subject, faculty } = splitSubjectFaculty('Agentic AI  - Sem 7 - Sonar');
    assert.equal(subject, 'Agentic AI');
    assert.equal(faculty, 'Prof. Sonar');
});
await check('"(Sec 5)" marker does not leak into the faculty name', () => {
    const { subject, faculty } = splitSubjectFaculty('ET - (Sec 5) - Salim');
    assert.equal(subject, 'ET');
    assert.equal(faculty, 'Prof. Salim');
});

console.log('--- splitSubjectFaculty: dash inside the subject ---');
await check('space run preserves a dash inside the subject name', () => {
    const { subject, faculty } = splitSubjectFaculty('Organizational Psychology - Micro Perspective                 Dr. Maya');
    assert.equal(subject, 'Organizational Psychology - Micro Perspective');
    assert.equal(faculty, 'Prof. Dr.Maya');
});

console.log('--- splitSubjectFaculty: no-teacher cells ---');
await check('a bare subject stays bare with empty faculty', () => {
    const { subject, faculty } = splitSubjectFaculty('Deep Learning');
    assert.equal(subject, 'Deep Learning');
    assert.equal(faculty, '');
});
await check('a subject with a leading space-run cell still keeps empty faculty', () => {
    const { subject, faculty } = splitSubjectFaculty('Corporate and Business Law   ');
    assert.equal(subject, 'Corporate and Business Law');
    assert.equal(faculty, '');
});
await check('an empty "(    )" faculty cell yields empty faculty, not garbage', () => {
    const { subject, faculty } = splitSubjectFaculty('Labour Law 2 (    )');
    assert.equal(subject, 'Labour Law 2');
    assert.equal(faculty, '');
});

console.log('--- splitSubjectFaculty: parenthesized faculty ---');
await check('"(Faculty)" after a space run is unwrapped', () => {
    const { subject, faculty } = splitSubjectFaculty('DAA         (Aravind)');
    assert.equal(subject, 'DAA');
    assert.equal(faculty, 'Prof. Aravind');
});

console.log('--- parseCSV (grid): SOAI / SOB unsectioned path ---');
const SOAI_GRID = [
    'MONDAY,09:15 AM - 10:10 AM,Differential Equations         ArunKumar,Corporate and Business Law',
    ',10:15 AM - 11:10 AM,Image Processing - Dr Aasy,Operations Research',
    ',11:15 AM - 12:10 PM,Human AI Interaction,Human Resource Management',
].join('\n');
const SOAI_MANDATORY = ['Differential Equations', 'Image Processing', 'Human AI Interaction'];
const SOAI_ELECTIVES = null;

await check('SOAI space-separated class gets its real teacher', () => {
    const out = parseCSV(SOAI_GRID, 'grid', SOAI_MANDATORY, SOAI_ELECTIVES, null);
    const c = out.find((x) => x.subject === 'Differential Equations');
    assert.ok(c, 'class parsed');
    assert.equal(c.faculty, 'Prof. ArunKumar');
});
await check('SOAI dash class gets its real teacher', () => {
    const out = parseCSV(SOAI_GRID, 'grid', SOAI_MANDATORY, SOAI_ELECTIVES, null);
    const c = out.find((x) => x.subject === 'Image Processing');
    assert.ok(c, 'class parsed');
    assert.equal(c.faculty, 'Prof. Dr.Aasy');
});
await check('a class with no teacher in the sheet keeps empty faculty', () => {
    const out = parseCSV(SOAI_GRID, 'grid', SOAI_MANDATORY, SOAI_ELECTIVES, null);
    const c = out.find((x) => x.subject === 'Human AI Interaction');
    assert.ok(c, 'class parsed');
    assert.equal(c.faculty, '');
});
await check('a non-mandatory unsectioned cell is skipped', () => {
    const out = parseCSV(SOAI_GRID, 'grid', SOAI_MANDATORY, SOAI_ELECTIVES, null);
    assert.ok(!out.some((x) => x.subject === 'Corporate and Business Law'), 'other-year class not emitted');
    assert.ok(!out.some((x) => x.subject === 'Operations Research'), 'other-year class not emitted');
});

console.log('--- parseCSV (grid): SCDS room-scoped path ---');
const SCDS_GRID = [
    'MONDAY,09:15 AM - 10:10 AM,Computer Networks',
    ',10:15 AM - 11:10 AM,ET - Sec 5 - Salim',
    ',AB2 - 207,AB2 - 207',
].join('\n');

await check('SCDS "Sec N" cell carries its section and teacher', () => {
    const out = parseCSV(SCDS_GRID, 'grid', null, null, ['AB2-207']);
    const c = out.find((x) => x.subject === 'Emerging Tools and Applications');
    assert.ok(c, 'class parsed');
    assert.equal(c.faculty, 'Prof. Salim');
    assert.equal(c.section, 5);
});
await check('a sectionless non-elective cell is skipped', () => {
    const out = parseCSV(SCDS_GRID, 'grid', null, null, ['AB2-207']);
    assert.ok(!out.some((x) => x.subject === 'Computer Networks'), 'other-year class not emitted');
});

console.log('--- parseCSV (grid): SCDS-3 non-room path (Sem markers) ---');
const SCDS3_GRID = [
    'MONDAY,09:15 AM - 10:10 AM,DL - Sem 5 - Dr. KK',
    ',10:15 AM - 11:10 AM,Financial Reporting and Analysis         Surya C',
    ',11:15 AM - 12:10 PM,Computer Networks',
    ',12:15 PM - 1:10 PM,Forensic Psychology         Meera',
].join('\n');
const SCDS3_MANDATORY = ['Deep Learning', 'Theory of Computation'];
const SCDS3_ELECTIVES = [
    { id: 'financial-reporting-and-analysis', label: 'Financial Reporting and Analysis' },
    { id: 'computer-networks', label: 'Computer Networks' },
    { id: 'forensic-psychology', label: 'Forensic Psychology' },
];

await check('SCDS-3 mandatory Sem-marker class keeps subject/faculty', () => {
    const out = parseCSV(SCDS3_GRID, 'grid', SCDS3_MANDATORY, SCDS3_ELECTIVES, null);
    const c = out.find((x) => x.subject === 'Deep Learning');
    assert.ok(c, 'class parsed');
    assert.equal(c.faculty, 'Prof. Dr.K.K.Singh');
});
await check('SCDS-3 space-separated elective gets its teacher', () => {
    const out = parseCSV(SCDS3_GRID, 'grid', SCDS3_MANDATORY, SCDS3_ELECTIVES, null);
    const c = out.find((x) => x.subject === 'Financial Reporting and Analysis');
    assert.ok(c, 'class parsed');
    assert.equal(c.faculty, 'Prof. Surya C');
});
await check('SCDS-3 plain elective with no teacher keeps empty faculty', () => {
    const out = parseCSV(SCDS3_GRID, 'grid', SCDS3_MANDATORY, SCDS3_ELECTIVES, null);
    const c = out.find((x) => x.subject === 'Computer Networks');
    assert.ok(c, 'class parsed');
    assert.equal(c.faculty, '');
});
await check('SCDS-3 newly added elective (minor) is parsed with its teacher', () => {
    const out = parseCSV(SCDS3_GRID, 'grid', SCDS3_MANDATORY, SCDS3_ELECTIVES, null);
    const c = out.find((x) => x.subject === 'Forensic Psychology');
    assert.ok(c, 'class parsed');
    assert.equal(c.elective, 'forensic-psychology');
    assert.equal(c.courseId, 'forensic-psychology');
    assert.equal(c.faculty, 'Prof. Meera');
    assert.equal(c.section, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
rmSync(dir, { recursive: true, force: true });
if (failed) process.exit(1);
