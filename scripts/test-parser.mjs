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

const MODULES = ['js/data/parser.js', 'js/data/course-normalizer.js', 'js/data/schools.js'];

const dir = mkdtempSync(join(tmpdir(), 'tt-parser-'));
for (const rel of MODULES) {
    const dest = join(dir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, stripQuery(readFileSync(join(ROOT, rel), 'utf8')));
}

const { splitSubjectFaculty, parseCSV } = await import(pathToFileURL(join(dir, 'js/data/parser.js')).href);
const { buildYearCourseContext } = await import(pathToFileURL(join(dir, 'js/data/course-normalizer.js')).href);
const { SCHOOLS } = await import(pathToFileURL(join(dir, 'js/data/schools.js')).href);

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
    assert.equal(faculty, 'Prof. Dr.Sanjay Bang');
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

console.log('--- parseCSV (grid): SCDS room-scoped — rooms NOT in configured list ---');
const UNCONFIGURED_ROOMS_GRID = [
    'MONDAY,09:15 AM - 10:10 AM,ET - Sec 5 - Salim,FP - Sec 2 - Dr. Mridula',
    ',,B62-B201,B62-B206',
    'TUESDAY,11:15 AM - 12:10 PM,Forensic Psychology - Sec 3 - Dr. Mridula,CN - Sec 1 - Arjun',
    ',,AB2-101,B62-B201',
].join('\n');
const UNCONFIGURED_ELECTIVES = [
    { id: 'emerging-tools-and-applications', label: 'Emerging Tools and Applications' },
    { id: 'forensic-psychology', label: 'Forensic Psychology' },
    { id: 'computer-networks', label: 'Computer Networks' },
];
const UNCONFIGURED_KNOWN_ROOMS = ['AB2-101'];

await check('class in unconfigured room B62-B201 is parsed', () => {
    const out = parseCSV(UNCONFIGURED_ROOMS_GRID, 'grid', null, UNCONFIGURED_ELECTIVES, UNCONFIGURED_KNOWN_ROOMS);
    const c = out.find(x => x.subject === 'Emerging Tools and Applications' && x.day === 'Monday');
    assert.ok(c, 'ET class in B62-B201 parsed despite room not being in configured list');
    assert.equal(c.room, 'B62-B201');
    assert.equal(c.section, 5);
    assert.equal(c.faculty, 'Prof. Salim');
});

await check('class in unconfigured room B62-B206 is parsed', () => {
    const out = parseCSV(UNCONFIGURED_ROOMS_GRID, 'grid', null, UNCONFIGURED_ELECTIVES, UNCONFIGURED_KNOWN_ROOMS);
    const c = out.find(x => x.subject === 'Forensic Psychology' && x.day === 'Monday');
    assert.ok(c, 'FP class in B62-B206 parsed');
    assert.equal(c.room, 'B62-B206');
    assert.equal(c.section, 2);
});

await check('Forensic Psychology in unconfigured room is parsed', () => {
    const out = parseCSV(UNCONFIGURED_ROOMS_GRID, 'grid', null, UNCONFIGURED_ELECTIVES, UNCONFIGURED_KNOWN_ROOMS);
    const c = out.find(x => x.elective === 'forensic-psychology' && x.day === 'Tuesday');
    assert.ok(c, 'Forensic Psychology in AB2-101 parsed');
    assert.equal(c.room, 'AB2-101');
    assert.equal(c.section, 3);
    assert.equal(c.faculty, 'Prof. Dr.Mridula');
});

await check('class in configured room is still parsed', () => {
    const out = parseCSV(UNCONFIGURED_ROOMS_GRID, 'grid', null, UNCONFIGURED_ELECTIVES, UNCONFIGURED_KNOWN_ROOMS);
    const c = out.find(x => x.elective === 'computer-networks');
    assert.ok(c, 'CN class in B62-B201 (unconfigured room) parsed');
    assert.equal(c.room, 'B62-B201');
});

await check('no duplicate classes when same room/class in multiple columns', () => {
    const DUP_GRID = [
        'MONDAY,09:15 AM - 10:10 AM,ET - Sec 5 - Salim,ET - Sec 5 - Salim',
        ',,AB2-101,AB2-101',
    ].join('\n');
    const out = parseCSV(DUP_GRID, 'grid', null, UNCONFIGURED_ELECTIVES, ['AB2-101']);
    const etClasses = out.filter(x => x.elective === 'emerging-tools-and-applications');
    assert.equal(etClasses.length, 1, 'same class in same room should not be duplicated');
});

await check('total class count includes all rooms (configured + unconfigured)', () => {
    const out = parseCSV(UNCONFIGURED_ROOMS_GRID, 'grid', null, UNCONFIGURED_ELECTIVES, UNCONFIGURED_KNOWN_ROOMS);
    const monday = out.filter(x => x.day === 'Monday');
    assert.equal(monday.length, 2, 'Monday has 2 classes across configured and unconfigured rooms');
    const tuesday = out.filter(x => x.day === 'Tuesday');
    assert.equal(tuesday.length, 2, 'Tuesday has 2 classes across configured and unconfigured rooms');
});

console.log('--- parseCSV (grid): single-space-separated teacher (no dash) ---');
const SINGLE_SPACE_GRID = [
    'MONDAY,09:15 AM - 10:10 AM,Forensic Psychology Dr. Mridula',
    ',,AB2-101',
].join('\n');
const SINGLE_SPACE_ELECTIVES = [
    { id: 'forensic-psychology', label: 'Forensic Psychology' },
];
await check('single-space-glued teacher is extracted via course name detection', () => {
    const out = parseCSV(SINGLE_SPACE_GRID, 'grid', null, SINGLE_SPACE_ELECTIVES, ['AB2-101']);
    const c = out.find(x => x.elective === 'forensic-psychology');
    assert.ok(c, 'Forensic Psychology parsed from single-space cell');
    assert.equal(c.subject, 'Forensic Psychology');
    assert.equal(c.faculty, 'Prof. Dr.Mridula');
});

console.log('--- parseCSV (grid): SCDS-3 non-room path (Sem markers) ---');
const SCDS3_GRID = [
    'MONDAY,09:15 AM - 10:10 AM,DL - Sem 5 - Dr. KK',
    ',10:15 AM - 11:10 AM,Financial Reporting and Analysis         Surya C',
    ',11:15 AM - 12:10 PM,Computer Networks',
    ',12:15 PM - 1:10 PM,Forensic Psychology - Dr. Mridula',
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
    assert.equal(c.faculty, 'Prof. Dr.Mridula');
    assert.equal(c.section, 1);
});

console.log('--- SOB Year 2 config: BBA / B.Com split ---');

await check('SOB Year 2 has BBA and B.Com sections', () => {
    const sob = SCHOOLS.find(s => s.id === 'sob');
    assert.ok(sob, 'SOB school exists');
    const year2 = sob.years[0];
    assert.deepStrictEqual(year2.sections, ['BBA', 'B.Com']);
});

await check('SOB Year 2 BBA courses are correct', () => {
    const sob = SCHOOLS.find(s => s.id === 'sob');
    const year2 = sob.years[0];
    const bba = year2.sectionCourses['BBA'];
    assert.ok(bba.includes('Corporate and Business Law'), 'BBA has Corporate and Business Law');
    assert.ok(bba.includes('Operations Research'), 'BBA has Operations Research');
    assert.ok(bba.includes('Human Resource Management'), 'BBA has Human Resource Management');
    assert.ok(bba.includes('Principles in Financial Management'), 'BBA has Principles in Financial Management');
    assert.ok(bba.includes('Principles of Financial Management'), 'BBA has Principles of Financial Management');
    assert.ok(!bba.includes('Financial Reporting and Analysis'), 'BBA does NOT have Financial Reporting and Analysis');
});

await check('SOB Year 2 B.Com courses are correct', () => {
    const sob = SCHOOLS.find(s => s.id === 'sob');
    const year2 = sob.years[0];
    const bcom = year2.sectionCourses['B.Com'];
    assert.ok(bcom.includes('Corporate and Business Law'), 'B.Com has Corporate and Business Law');
    assert.ok(bcom.includes('Human Resource Management'), 'B.Com has Human Resource Management');
    assert.ok(bcom.includes('Principles in Financial Management'), 'B.Com has Principles in Financial Management');
    assert.ok(bcom.includes('Principles of Financial Management'), 'B.Com has Principles of Financial Management');
    assert.ok(bcom.includes('Financial Reporting and Analysis'), 'B.Com has Financial Reporting and Analysis');
    assert.ok(!bcom.includes('Operations Research'), 'B.Com does NOT have Operations Research');
});

await check('shared courses appear in both BBA and B.Com', () => {
    const sob = SCHOOLS.find(s => s.id === 'sob');
    const year2 = sob.years[0];
    const bba = year2.sectionCourses['BBA'];
    const bcom = year2.sectionCourses['B.Com'];
    const shared = ['Corporate and Business Law', 'Human Resource Management', 'Principles in Financial Management'];
    for (const c of shared) {
        assert.ok(bba.includes(c), `BBA has shared course: ${c}`);
        assert.ok(bcom.includes(c), `B.Com has shared course: ${c}`);
    }
});

console.log('--- parseCSV (grid): SCDS-3 ALL electives parsing ---');
const SCDS3_ALL_ELECTIVES = [
    { id: 'quantum-machine-learning', label: 'Quantum Machine Learning' },
    { id: 'cyber-security', label: 'Cybersecurity: Fundamental Concepts and Management' },
    { id: 'computer-networks', label: 'Computer Networks' },
    { id: 'financial-reporting-and-analysis', label: 'Financial Reporting and Analysis' },
    { id: 'organizational-psychology', label: 'Organizational Psychology' },
    { id: 'computer-organization-and-architecture', label: 'Computer Organization and Architecture' },
    { id: 'human-ai-interaction', label: 'Human AI Interaction' },
    { id: 'introduction-to-financial-accounting', label: 'Introduction to Financial Accounting' },
    { id: 'critical-thinking', label: 'Critical Thinking' },
    { id: 'forensic-psychology', label: 'Forensic Psychology' },
    { id: 'community-psychology', label: 'Community Psychology' },
    { id: 'fundamentals-of-business-organization-and-management', label: 'Fundamentals of Business Organization & Management' },
    { id: 'principles-in-financial-management', label: 'Principles in Financial Management' },
];
const SCDS3_MANDATORY_COURSES = ['Deep Learning', 'Theory of Computation'];

const SCDS3_ALL_GRID = [
    'MONDAY,09:15 AM - 10:10 AM,DL - Sem 5 - Dr. KK,QML - Sem 5 - Dr. Sharma',
    ',10:15 AM - 11:10 AM,CN - Sec 3 - Arjun,Financial Reporting and Analysis         Surya C',
    ',11:15 AM - 12:10 PM,COA - Sec 5 - Ashok,CYBER - Sec 2 - Salim',
    ',12:15 PM - 1:10 PM,Organizational Psychology - Micro Perspective         Dr. Maya,Human AI Interaction',
    ',1:30 PM - 2:25 PM,PFM - Sec 6 - Dr. Mehta,FBO         Dr. Reddy',
    'TUESDAY,09:15 AM - 10:10 AM,TOC - Sem 5 - Sonar,IFA - Sec 1 - Dr. Priya',
    ',10:15 AM - 11:10 AM,CT - Sec 4 - Nasma,Forensic Psychology - Dr. Mridula',
    ',11:15 AM - 12:10 PM,Community Psychology         Dr. Arun,Principles of Financial Management - Dr. Singh',
    ',12:15 PM - 1:10 PM,Fundamentals of Business Organization and Management         Dr. Reddy,QML - Sem 5 - Dr. Sharma',
].join('\n');

await check('SCDS-3: Quantum Machine Learning is parsed as elective', () => {
    const out = parseCSV(SCDS3_ALL_GRID, 'grid', SCDS3_MANDATORY_COURSES, SCDS3_ALL_ELECTIVES, null);
    const c = out.find(x => x.elective === 'quantum-machine-learning');
    assert.ok(c, 'QML parsed');
    assert.equal(c.subject, 'Quantum Machine Learning');
    assert.equal(c.faculty, 'Prof. Dr.Sharma');
});

await check('SCDS-3: Computer Networks is parsed as elective', () => {
    const out = parseCSV(SCDS3_ALL_GRID, 'grid', SCDS3_MANDATORY_COURSES, SCDS3_ALL_ELECTIVES, null);
    const c = out.find(x => x.elective === 'computer-networks');
    assert.ok(c, 'CN parsed');
    assert.equal(c.faculty, 'Prof. Arjun');
});

await check('SCDS-3: Financial Reporting and Analysis is parsed as elective', () => {
    const out = parseCSV(SCDS3_ALL_GRID, 'grid', SCDS3_MANDATORY_COURSES, SCDS3_ALL_ELECTIVES, null);
    const c = out.find(x => x.elective === 'financial-reporting-and-analysis');
    assert.ok(c, 'FRA parsed');
    assert.equal(c.faculty, 'Prof. Surya C');
});

await check('SCDS-3: COA is parsed via alias', () => {
    const out = parseCSV(SCDS3_ALL_GRID, 'grid', SCDS3_MANDATORY_COURSES, SCDS3_ALL_ELECTIVES, null);
    const c = out.find(x => x.elective === 'computer-organization-and-architecture');
    assert.ok(c, 'COA parsed');
    assert.equal(c.subject, 'Computer Organization and Architecture');
});

await check('SCDS-3: CYBER is parsed via alias', () => {
    const out = parseCSV(SCDS3_ALL_GRID, 'grid', SCDS3_MANDATORY_COURSES, SCDS3_ALL_ELECTIVES, null);
    const c = out.find(x => x.elective === 'cyber-security');
    assert.ok(c, 'CYBER parsed');
    assert.equal(c.subject, 'Cybersecurity: Fundamental Concepts and Management');
});

await check('SCDS-3: Organizational Psychology with suffix is parsed', () => {
    const out = parseCSV(SCDS3_ALL_GRID, 'grid', SCDS3_MANDATORY_COURSES, SCDS3_ALL_ELECTIVES, null);
    const c = out.find(x => x.elective === 'organizational-psychology');
    assert.ok(c, 'OP parsed');
    assert.equal(c.faculty, 'Prof. Dr.Maya');
});

await check('SCDS-3: Human AI Interaction is parsed as unsectioned elective', () => {
    const out = parseCSV(SCDS3_ALL_GRID, 'grid', SCDS3_MANDATORY_COURSES, SCDS3_ALL_ELECTIVES, null);
    const c = out.find(x => x.elective === 'human-ai-interaction');
    assert.ok(c, 'HAI parsed');
});

await check('SCDS-3: IFA is parsed via alias', () => {
    const out = parseCSV(SCDS3_ALL_GRID, 'grid', SCDS3_MANDATORY_COURSES, SCDS3_ALL_ELECTIVES, null);
    const c = out.find(x => x.elective === 'introduction-to-financial-accounting');
    assert.ok(c, 'IFA parsed');
    assert.equal(c.subject, 'Introduction to Financial Accounting');
});

await check('SCDS-3: CT is parsed via alias', () => {
    const out = parseCSV(SCDS3_ALL_GRID, 'grid', SCDS3_MANDATORY_COURSES, SCDS3_ALL_ELECTIVES, null);
    const c = out.find(x => x.elective === 'critical-thinking');
    assert.ok(c, 'CT parsed');
    assert.equal(c.subject, 'Critical Thinking');
});

await check('SCDS-3: Forensic Psychology is parsed as elective', () => {
    const out = parseCSV(SCDS3_ALL_GRID, 'grid', SCDS3_MANDATORY_COURSES, SCDS3_ALL_ELECTIVES, null);
    const c = out.find(x => x.elective === 'forensic-psychology');
    assert.ok(c, 'FP parsed');
    assert.equal(c.faculty, 'Prof. Dr.Mridula');
});

await check('SCDS-3: Community Psychology is parsed as unsectioned elective', () => {
    const out = parseCSV(SCDS3_ALL_GRID, 'grid', SCDS3_MANDATORY_COURSES, SCDS3_ALL_ELECTIVES, null);
    const c = out.find(x => x.elective === 'community-psychology');
    assert.ok(c, 'CommP parsed');
});

await check('SCDS-3: PFM abbreviation is expanded and matched', () => {
    const out = parseCSV(SCDS3_ALL_GRID, 'grid', SCDS3_MANDATORY_COURSES, SCDS3_ALL_ELECTIVES, null);
    const c = out.find(x => x.elective === 'principles-in-financial-management' && x.day === 'Monday');
    assert.ok(c, 'PFM parsed');
    assert.equal(c.subject, 'Principles in Financial Management');
    assert.equal(c.faculty, 'Prof. Dr.Mehta');
});

await check('SCDS-3: FBO abbreviation is expanded and matched', () => {
    const out = parseCSV(SCDS3_ALL_GRID, 'grid', SCDS3_MANDATORY_COURSES, SCDS3_ALL_ELECTIVES, null);
    const c = out.find(x => x.elective === 'fundamentals-of-business-organization-and-management' && x.day === 'Monday');
    assert.ok(c, 'FBO parsed');
    assert.equal(c.subject, 'Fundamentals of Business Organization & Management');
});

await check('SCDS-3: "Principles of Financial Management" (with "of") is matched via alias', () => {
    const out = parseCSV(SCDS3_ALL_GRID, 'grid', SCDS3_MANDATORY_COURSES, SCDS3_ALL_ELECTIVES, null);
    const c = out.find(x => x.elective === 'principles-in-financial-management' && x.day === 'Tuesday');
    assert.ok(c, '"Principles of Financial Management" matched');
    assert.equal(c.subject, 'Principles in Financial Management');
    assert.equal(c.faculty, 'Prof. Dr.Singh');
});

await check('SCDS-3: "Fundamentals of Business Organization and Management" (with "and") is matched via alias', () => {
    const out = parseCSV(SCDS3_ALL_GRID, 'grid', SCDS3_MANDATORY_COURSES, SCDS3_ALL_ELECTIVES, null);
    const c = out.find(x => x.elective === 'fundamentals-of-business-organization-and-management' && x.day === 'Tuesday');
    assert.ok(c, '"Fundamentals...and Management" matched');
    assert.equal(c.subject, 'Fundamentals of Business Organization & Management');
});

await check('SCDS-3: word-prefix fallback matches when expanded subject has trailing words', () => {
    // Year 3's matchElective now has the same word-prefix fallback as Year 2.
    // This tests the scenario where expandSubjectAlias returns the full canonical
    // name, but there are trailing words left in the subject string.
    const testGrid = [
        'MONDAY,09:15 AM - 10:10 AM,DL - Sem 5 - Dr. KK,Fundamentals of Business Organization & Management extra words         Dr. Reddy',
    ].join('\n');
    const out = parseCSV(testGrid, 'grid', SCDS3_MANDATORY_COURSES, SCDS3_ALL_ELECTIVES, null);
    const c = out.find(x => x.elective === 'fundamentals-of-business-organization-and-management');
    assert.ok(c, 'FBO matched via word-prefix fallback');
    assert.equal(c.faculty, 'Prof. Dr.Reddy');
});

await check('SCDS-3: mandatory courses are still parsed alongside electives', () => {
    const out = parseCSV(SCDS3_ALL_GRID, 'grid', SCDS3_MANDATORY_COURSES, SCDS3_ALL_ELECTIVES, null);
    const dl = out.find(x => x.subject === 'Deep Learning');
    assert.ok(dl, 'Deep Learning parsed');
    assert.equal(dl.elective, undefined, 'mandatory is not tagged as elective');
    const toc = out.find(x => x.subject === 'Theory of Computation');
    assert.ok(toc, 'TOC parsed');
});

await check('SCDS-3: 18 total classes (2 mandatory + 16 elective slots for 13 unique electives)', () => {
    const out = parseCSV(SCDS3_ALL_GRID, 'grid', SCDS3_MANDATORY_COURSES, SCDS3_ALL_ELECTIVES, null);
    assert.equal(out.length, 18, `expected 18 classes, got ${out.length}`);
});

await check('SCDS-3: 16 elective classes all have elective id set', () => {
    const out = parseCSV(SCDS3_ALL_GRID, 'grid', SCDS3_MANDATORY_COURSES, SCDS3_ALL_ELECTIVES, null);
    const electives = out.filter(x => x.elective);
    assert.equal(electives.length, 16, `expected 16 elective classes, got ${electives.length}`);
    for (const c of electives) {
        assert.ok(c.elective, `${c.subject} has elective id`);
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
rmSync(dir, { recursive: true, force: true });
if (failed) process.exit(1);
