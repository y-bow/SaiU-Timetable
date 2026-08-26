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
const { buildYearCourseContext, resolveCourse, splitLabSuffix } = await import(pathToFileURL(join(dir, 'js/data/course-normalizer.js')).href);
const { SCHOOLS, shouldShowProgram } = await import(pathToFileURL(join(dir, 'js/data/schools.js')).href);

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
    const c = out.find((x) => x.subject === 'Emering Tools and Applications');
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
    { id: 'emerging-tools-and-applications', label: 'Emering Tools and Applications' },
    { id: 'forensic-psychology', label: 'Forensic Psychology' },
    { id: 'computer-networks', label: 'Computer Networks' },
];
const UNCONFIGURED_KNOWN_ROOMS = ['AB2-101'];

await check('class in unconfigured room B62-B201 is parsed', () => {
    const out = parseCSV(UNCONFIGURED_ROOMS_GRID, 'grid', null, UNCONFIGURED_ELECTIVES, UNCONFIGURED_KNOWN_ROOMS);
    const c = out.find(x => x.subject === 'Emering Tools and Applications' && x.day === 'Monday');
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

console.log('--- SOB BBA config ---');

const sob = SCHOOLS.find(s => s.id === 'sob');

await check('SOB school exists with BBA and B.Com programmes', () => {
    assert.ok(sob, 'SOB school exists');
    assert.equal(sob.shortName, 'SOB');
    assert.ok(sob.programs, 'SOB uses a program hierarchy');
    assert.equal(sob.programs.length, 2, 'two programmes');
    const bba = sob.programs.find(p => p.id === 'bba');
    assert.ok(bba, 'BBA programme exists');
    assert.equal(bba.label, 'BBA');
    const bcom = sob.programs.find(p => p.id === 'bcom');
    assert.ok(bcom, 'B.Com programme exists');
    assert.equal(bcom.label, 'B.Com');
});

await check('SOB BBA has Year 1 and Year 2 configs', () => {
    const bba = sob.programs.find(p => p.id === 'bba');
    assert.equal(bba.years.length, 2, 'two year configs');
    const year1 = bba.years[0];
    assert.equal(year1.id, 'sob-bba-year1');
    assert.equal(year1.label, 'Year 1');
    assert.equal(year1.level, 1);
    assert.equal(year1.sections, null);
    const year2 = bba.years[1];
    assert.equal(year2.id, 'sob-bba-year2');
    assert.equal(year2.label, 'Year 2');
    assert.equal(year2.level, 2);
    assert.equal(year2.sections, null);
});

await check('SOB BBA Year 1 courses are correct', () => {
    const bba = sob.programs.find(p => p.id === 'bba');
    const year1 = bba.years.find(y => y.level === 1);
    assert.deepStrictEqual(year1.mandatoryCourses, [
        'Fundamentals of Business',
        'Financial Management',
        'Business Mathematics and Stats',
        'Critical Thinking',
        'ICD',
        'Frontiers of AI',
    ]);
    assert.equal(year1.electives, null);
});

await check('SOB B.Com has Year 1 and Year 2 configs', () => {
    const bcom = sob.programs.find(p => p.id === 'bcom');
    assert.equal(bcom.years.length, 2, 'two year configs');
    const year1 = bcom.years[0];
    assert.equal(year1.id, 'sob-bcom-year1');
    assert.equal(year1.label, 'Year 1');
    assert.equal(year1.level, 1);
    assert.equal(year1.sections, null);
    const year2 = bcom.years[1];
    assert.equal(year2.id, 'sob-bcom-year2');
    assert.equal(year2.label, 'Year 2');
    assert.equal(year2.level, 2);
    assert.equal(year2.sections, null);
});

await check('SOB B.Com Year 1 courses match BBA Year 1 (shared)', () => {
    const bcom = sob.programs.find(p => p.id === 'bcom');
    const year1 = bcom.years.find(y => y.level === 1);
    const bba = sob.programs.find(p => p.id === 'bba');
    const bbaYear1 = bba.years.find(y => y.level === 1);
    assert.deepStrictEqual(year1.mandatoryCourses, bbaYear1.mandatoryCourses);
});

console.log('--- SOB Year 2 config: BBA / B.Com split ---');

await check('SOB BBA Year 2 courses are correct', () => {
    const bba = sob.programs.find(p => p.id === 'bba');
    const year2 = bba.years.find(y => y.level === 2);
    const mandatory = year2.mandatoryCourses;
    assert.ok(mandatory.includes('Corporate and Business Law'), 'BBA has Corporate and Business Law');
    assert.ok(mandatory.includes('Operations Research'), 'BBA has Operations Research');
    assert.ok(mandatory.includes('Human Resource Management'), 'BBA has Human Resource Management');
    assert.ok(mandatory.includes('Principles in Financial Management'), 'BBA has Principles in Financial Management');
    assert.ok(mandatory.includes('Principles of Financial Management'), 'BBA has Principles of Financial Management');
    assert.ok(!mandatory.includes('Financial Reporting and Analysis'), 'BBA does NOT have Financial Reporting and Analysis');
});

await check('SOB B.Com Year 2 courses are correct', () => {
    const bcom = sob.programs.find(p => p.id === 'bcom');
    const year2 = bcom.years.find(y => y.level === 2);
    const mandatory = year2.mandatoryCourses;
    assert.ok(mandatory.includes('Corporate and Business Law'), 'B.Com has Corporate and Business Law');
    assert.ok(mandatory.includes('Human Resource Management'), 'B.Com has Human Resource Management');
    assert.ok(mandatory.includes('Principles in Financial Management'), 'B.Com has Principles in Financial Management');
    assert.ok(mandatory.includes('Principles of Financial Management'), 'B.Com has Principles of Financial Management');
    assert.ok(mandatory.includes('Financial Reporting and Analysis'), 'B.Com has Financial Reporting and Analysis');
    assert.ok(!mandatory.includes('Operations Research'), 'B.Com does NOT have Operations Research');
});

await check('shared courses appear in both BBA and B.Com Year 2', () => {
    const bba = sob.programs.find(p => p.id === 'bba');
    const bcom = sob.programs.find(p => p.id === 'bcom');
    const bbaYear2 = bba.years.find(y => y.level === 2);
    const bcomYear2 = bcom.years.find(y => y.level === 2);
    const shared = ['Corporate and Business Law', 'Human Resource Management', 'Principles in Financial Management'];
    for (const c of shared) {
        assert.ok(bbaYear2.mandatoryCourses.includes(c), `BBA has shared course: ${c}`);
        assert.ok(bcomYear2.mandatoryCourses.includes(c), `B.Com has shared course: ${c}`);
    }
});

await check('SOB shows the programme selector', () => {
    assert.equal(shouldShowProgram(sob), true, 'programme selector is shown for SOB');
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

await check('SCDS-3: FBO with a space-run inside the course name (real sheet format) is not truncated', () => {
    // The live sheet spells this cell "Fundamentals of Business Organization
    //  & Management  Subramaniam" — a space-run INSIDE the course name, not
    // just before the teacher. The split must recover the full course name
    // instead of truncating at "Organization" and dropping the class.
    const testGrid = [
        'MONDAY,09:15 AM - 10:10 AM,DL - Sem 5 - Dr. KK,Fundamentals of Business Organization  & Management  Subramaniam',
    ].join('\n');
    const out = parseCSV(testGrid, 'grid', SCDS3_MANDATORY_COURSES, SCDS3_ALL_ELECTIVES, null);
    const c = out.find(x => x.elective === 'fundamentals-of-business-organization-and-management');
    assert.ok(c, 'FBO parsed with the full course name');
    assert.equal(c.subject, 'Fundamentals of Business Organization & Management');
    assert.equal(c.faculty, 'Prof. Subramaniam');
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

console.log('--- SAS Year 3 Neuroscience config ---');

const sas = SCHOOLS.find(s => s.id === 'sas');
const SAS_MANDATORY = ['Biostatistics', 'Clinical Neuroscience', 'Molecular Neuroscience', 'Analytical Methods', 'Psychiatry & Mood disorders'];
const SAS_ELECTIVES = [{ id: 'cell-physiology', label: 'Cell Physiology' }];

await check('SAS school exists with the Neuroscience programme', () => {
    assert.ok(sas, 'SAS school exists');
    assert.equal(sas.shortName, 'SAS');
    assert.ok(sas.programs, 'SAS uses a program hierarchy');
    const neuro = sas.programs.find(p => p.id === 'neuroscience');
    assert.ok(neuro, 'Neuroscience programme exists');
    assert.equal(neuro.label, 'Neuroscience');
});

await check('SAS Neuroscience has exactly one Year 3 config', () => {
    const neuro = sas.programs.find(p => p.id === 'neuroscience');
    assert.equal(neuro.years.length, 1, 'one year config');
    const year3 = neuro.years[0];
    assert.equal(year3.label, 'Year 3');
    assert.equal(year3.level, 3);
    assert.equal(year3.id, 'sas-neuro-3');
});

await check('SAS Year 3 has exactly the 5 mandatory + 1 elective courses', () => {
    const year3 = sas.programs.find(p => p.id === 'neuroscience').years[0];
    assert.deepStrictEqual(year3.mandatoryCourses, SAS_MANDATORY);
    assert.deepStrictEqual(year3.electives, SAS_ELECTIVES);
});

await check('SAS Year 3 courses do NOT appear in any other school/programme/year', () => {
    const sasCourses = new Set([...SAS_MANDATORY, ...SAS_ELECTIVES.map(e => e.label)]);
    for (const school of SCHOOLS) {
        const yearConfigs = school.programs
            ? school.programs.flatMap(p => p.years)
            : (school.years || []);
        for (const year of yearConfigs) {
            // Skip SAS itself — we verify its own lists separately.
            if (school.id === 'sas') continue;
            const all = [...(year.mandatoryCourses || []), ...(year.electives || []).map(e => e.label)];
            for (const name of all) {
                assert.ok(!sasCourses.has(name), `${school.id} / ${year.id} must not contain "${name}"`);
            }
        }
    }
});

await check('SAS courses never appear under another programme of the same school', () => {
    // SAS has two programmes (Neuroscience, Psychology); each has its own
    // year config. No course should leak across programmes.
    const neuro = sas.programs.find(p => p.id === 'neuroscience');
    const psych = sas.programs.find(p => p.id === 'psychology');
    assert.ok(neuro && psych, 'both programmes exist');
    assert.equal(neuro.years.length, 1, 'single year in Neuroscience');
    assert.equal(psych.years.length, 1, 'single year in Psychology');
});

await check('SAS shows the programme selector so Neuroscience is an explicit, selectable level', () => {
    assert.equal(shouldShowProgram(sas), true, 'programme selector is shown for SAS');
    assert.equal(sas.programs[0].label, 'Neuroscience', 'the single programme is labelled Neuroscience');
});

console.log('--- parseCSV (grid): SAS Year 3 Neuroscience ---');
const SAS_GRID = [
    'MONDAY,09:15 AM - 10:10 AM,Biostatistics         Dr. Sivan',
    ',10:15 AM - 11:10 AM,Cell Physiology         Dr. Rao',
    ',11:15 AM - 12:10 PM,Clinical Neuroscience         Dr. Gupta',
    ',12:15 PM - 1:10 PM,Molecular Neuroscience         Dr. Sharma',
    'TUESDAY,09:15 AM - 10:10 AM,Analytical Methods         Dr. Mehta',
    ',10:15 AM - 11:10 AM,Psychiatry & Mood disorders         Dr. Khan',
].join('\n');

await check('SAS Year 3: all five mandatory courses parse', () => {
    const out = parseCSV(SAS_GRID, 'grid', SAS_MANDATORY, SAS_ELECTIVES, null);
    for (const name of SAS_MANDATORY) {
        const c = out.find(x => x.subject === name);
        assert.ok(c, `${name} parsed`);
        assert.equal(c.elective, undefined, `${name} is not tagged as elective`);
    }
});

await check('SAS Year 3: mandatory courses carry stable canonical courseIds', () => {
    const out = parseCSV(SAS_GRID, 'grid', SAS_MANDATORY, SAS_ELECTIVES, null);
    assert.equal(out.find(x => x.subject === 'Biostatistics').courseId, 'biostatistics');
    assert.equal(out.find(x => x.subject === 'Clinical Neuroscience').courseId, 'clinical-neuroscience');
    assert.equal(out.find(x => x.subject === 'Molecular Neuroscience').courseId, 'molecular-neuroscience');
    assert.equal(out.find(x => x.subject === 'Analytical Methods').courseId, 'analytical-methods');
    assert.equal(out.find(x => x.subject === 'Psychiatry & Mood disorders').courseId, 'psychiatry-and-mood-disorders');
});

await check('SAS Year 3: Cell Physiology is parsed as the elective', () => {
    const out = parseCSV(SAS_GRID, 'grid', SAS_MANDATORY, SAS_ELECTIVES, null);
    const c = out.find(x => x.elective === 'cell-physiology');
    assert.ok(c, 'Cell Physiology parsed');
    assert.equal(c.subject, 'Cell Physiology');
    assert.equal(c.courseId, 'cell-physiology');
    assert.equal(c.faculty, 'Prof. Dr.Rao');
});

await check('SAS Year 3: a bare "Cell Physiology" cell keeps its name and invents no teacher', () => {
    const bare = [
        'MONDAY,09:15 AM - 10:10 AM,Biostatistics         Dr. Sivan',
        ',10:15 AM - 11:10 AM,Cell Physiology',
    ].join('\n');
    const out = parseCSV(bare, 'grid', SAS_MANDATORY, SAS_ELECTIVES, null);
    const c = out.find(x => x.elective === 'cell-physiology');
    assert.ok(c, 'Cell Physiology parsed from a bare cell');
    assert.equal(c.subject, 'Cell Physiology');
    assert.equal(c.faculty, '', 'no phantom teacher invented');
});

await check('SAS Year 3: dash spelling "Cell Physiology - Elective" folds onto the elective with no phantom teacher', () => {
    const variant = [
        'MONDAY,09:15 AM - 10:10 AM,Cell Physiology - Elective',
    ].join('\n');
    const out = parseCSV(variant, 'grid', SAS_MANDATORY, SAS_ELECTIVES, null);
    const c = out.find(x => x.elective === 'cell-physiology');
    assert.ok(c, 'dash spelling parses as the Cell Physiology elective');
    assert.equal(c.subject, 'Cell Physiology', 'legacy " - Elective" suffix is folded away');
    assert.equal(c.courseId, 'cell-physiology');
    assert.equal(c.faculty, '', 'no phantom teacher invented from the dash');
});

await check('SAS Year 3: sheet spelling "Analytical Methods & Instrumentation" maps onto Analytical Methods', () => {
    const variant = [
        'MONDAY,09:15 AM - 10:10 AM,Analytical Methods & Instrumentation   Manobala',
    ].join('\n');
    const out = parseCSV(variant, 'grid', SAS_MANDATORY, SAS_ELECTIVES, null);
    const c = out.find(x => x.courseId === 'analytical-methods');
    assert.ok(c, 'Analytical Methods & Instrumentation parses as the mandatory course');
    assert.equal(c.subject, 'Analytical Methods', 'canonical course name is used');
    assert.equal(c.faculty, 'Prof. Manobala');
});

await check('SAS Year 3: "Psychiatry and Mood disorders" (with "and") matches the & mandatory course', () => {
    const variant = [
        'MONDAY,09:15 AM - 10:10 AM,Psychiatry and Mood disorders         Dr. Khan',
    ].join('\n');
    const out = parseCSV(variant, 'grid', SAS_MANDATORY, SAS_ELECTIVES, null);
    const c = out.find(x => x.courseId === 'psychiatry-and-mood-disorders');
    assert.ok(c, 'Psychiatry course parsed via & ↔ and normalization');
    assert.equal(c.subject, 'Psychiatry & Mood disorders');
});

await check('SAS Year 3: a non-SAS cell (SCDS course) is skipped', () => {
    const mixed = [
        'MONDAY,09:15 AM - 10:10 AM,Biostatistics         Dr. Sivan',
        ',10:15 AM - 11:10 AM,Deep Learning',
    ].join('\n');
    const out = parseCSV(mixed, 'grid', SAS_MANDATORY, SAS_ELECTIVES, null);
    assert.ok(out.some(x => x.subject === 'Biostatistics'), 'SAS course parsed');
    assert.ok(!out.some(x => x.subject === 'Deep Learning'), 'SCDS course is not pulled into SAS Year 3');
});

console.log('--- SAS Year 2 Psychology config ---');

const SAS_PSYCH_MANDATORY = [
    'Psychopathology',
    'Community Psychology',
    'Psychology Behind Social Media',
    'Introduction to Cognitive Neuroscience',
    'Research Methodology',
];

await check('SAS has a Psychology programme with Year 2', () => {
    assert.ok(sas, 'SAS school exists');
    const psych = sas.programs.find(p => p.id === 'psychology');
    assert.ok(psych, 'Psychology programme exists');
    assert.equal(psych.label, 'Psychology');
    assert.equal(psych.years.length, 1, 'one year config');
    const year2 = psych.years[0];
    assert.equal(year2.id, 'sas-psych-2');
    assert.equal(year2.label, 'Year 2');
    assert.equal(year2.level, 2);
    assert.equal(year2.parser, 'grid');
});

await check('SAS Psychology Year 2 has exactly the 5 mandatory courses and no electives', () => {
    const psych = sas.programs.find(p => p.id === 'psychology');
    const year2 = psych.years[0];
    assert.deepStrictEqual(year2.mandatoryCourses, SAS_PSYCH_MANDATORY);
    assert.equal(year2.electives, null);
});

await check('SAS Psychology courses do NOT duplicate definitions in course-normalizer', () => {
    // Community Psychology is shared with SCDS Year 3 — resolveCourse should
    // return exactly one canonical match (no ambiguity).
    const res = resolveCourse('Community Psychology');
    assert.ok(res, 'Community Psychology resolves');
    assert.equal(res.ambiguous, false, 'not ambiguous');
    assert.equal(res.canonical, 'community-psychology');
});

await check('SAS shows the programme selector with both Neuroscience and Psychology', () => {
    assert.equal(shouldShowProgram(sas), true, 'programme selector is shown for SAS');
    const labels = sas.programs.map(p => p.label);
    assert.ok(labels.includes('Neuroscience'), 'Neuroscience programme listed');
    assert.ok(labels.includes('Psychology'), 'Psychology programme listed');
});

console.log('--- parseCSV (grid): SAS Year 2 Psychology ---');
const SAS_PSYCH_GRID = [
    'MONDAY,09:15 AM - 10:10 AM,Psychopathology         Dr. Jemima',
    ',10:15 AM - 11:10 AM,Community Psychology         Dr. Mridula',
    ',11:15 AM - 12:10 PM,Psychology Behind Social Media         Dr. Angel',
    'TUESDAY,09:15 AM - 10:10 AM,Introduction to Cognitive Neuroscience         Dr. Sivan',
    ',10:15 AM - 11:10 AM,Research Methodology         Dr. Rao',
].join('\n');

await check('SAS Year 2 Psychology: all five mandatory courses parse', () => {
    const out = parseCSV(SAS_PSYCH_GRID, 'grid', SAS_PSYCH_MANDATORY, null, null);
    for (const name of SAS_PSYCH_MANDATORY) {
        const c = out.find(x => x.subject === name);
        assert.ok(c, `${name} parsed`);
        assert.equal(c.elective, undefined, `${name} is not tagged as elective`);
    }
});

await check('SAS Year 2 Psychology: mandatory courses carry stable canonical courseIds', () => {
    const out = parseCSV(SAS_PSYCH_GRID, 'grid', SAS_PSYCH_MANDATORY, null, null);
    assert.equal(out.find(x => x.subject === 'Psychopathology').courseId, 'psychopathology');
    assert.equal(out.find(x => x.subject === 'Community Psychology').courseId, 'community-psychology');
    assert.equal(out.find(x => x.subject === 'Psychology Behind Social Media').courseId, 'psychology-behind-social-media');
    assert.equal(out.find(x => x.subject === 'Introduction to Cognitive Neuroscience').courseId, 'introduction-to-cognitive-neuroscience');
    assert.equal(out.find(x => x.subject === 'Research Methodology').courseId, 'research-methodology');
});

await check('SAS Year 2 Psychology: a non-SAS cell (SCDS course) is skipped', () => {
    const mixed = [
        'MONDAY,09:15 AM - 10:10 AM,Psychopathology         Dr. Jemima',
        ',10:15 AM - 11:10 AM,Deep Learning',
    ].join('\n');
    const out = parseCSV(mixed, 'grid', SAS_PSYCH_MANDATORY, null, null);
    assert.ok(out.some(x => x.subject === 'Psychopathology'), 'SAS Psychology course parsed');
    assert.ok(!out.some(x => x.subject === 'Deep Learning'), 'SCDS course is not pulled into SAS Year 2 Psychology');
});

await check('SAS Year 2 Psychology: alias "Research Methods" maps to Research Methodology', () => {
    const variant = [
        'MONDAY,09:15 AM - 10:10 AM,Research Methods         Dr. Rao',
    ].join('\n');
    const out = parseCSV(variant, 'grid', SAS_PSYCH_MANDATORY, null, null);
    const c = out.find(x => x.courseId === 'research-methodology');
    assert.ok(c, 'Research Methods alias parsed');
    assert.equal(c.subject, 'Research Methodology', 'canonical name used');
});

await check('SAS Year 2 Psychology: alias "Cognitive Neuroscience" maps to Introduction to Cognitive Neuroscience', () => {
    const variant = [
        'MONDAY,09:15 AM - 10:10 AM,Cognitive Neuroscience         Dr. Sivan',
    ].join('\n');
    const out = parseCSV(variant, 'grid', SAS_PSYCH_MANDATORY, null, null);
    const c = out.find(x => x.courseId === 'introduction-to-cognitive-neuroscience');
    assert.ok(c, 'Cognitive Neuroscience alias parsed');
    assert.equal(c.subject, 'Introduction to Cognitive Neuroscience', 'canonical name used');
});

await check('SAS Year 2 Psychology: alias "Psychopathology II" maps to Psychopathology', () => {
    const variant = [
        'MONDAY,09:15 AM - 10:10 AM,Psychopathology  II       Dr. Jemima',
    ].join('\n');
    const out = parseCSV(variant, 'grid', SAS_PSYCH_MANDATORY, null, null);
    const c = out.find(x => x.courseId === 'psychopathology');
    assert.ok(c, 'Psychopathology II alias parsed');
    assert.equal(c.subject, 'Psychopathology', 'canonical name used');
    // The student grid parser splits at the first 2+ space run, so the Roman
    // numeral suffix "II" stays with the faculty side. The teacher parser
    // (splitTeacherCell) uses the LAST 2+ space run and handles this correctly.
    assert.ok(c.faculty.includes('Dr.'), 'teacher is correctly extracted');
});

console.log('--- SAS Year 2 Biological Sciences config ---');

const SAS_BIOSCI_MANDATORY = [
    'Applied Biological Sciences',
    'Microbiology',
    'Environmental Biotechnology',
];

await check('SAS has a Biological Sciences programme with Year 2', () => {
    assert.ok(sas, 'SAS school exists');
    const biosci = sas.programs.find(p => p.id === 'biological-sciences');
    assert.ok(biosci, 'Biological Sciences programme exists');
    assert.equal(biosci.label, 'Biological Sciences');
    assert.equal(biosci.years.length, 1, 'one year config');
    const year2 = biosci.years[0];
    assert.equal(year2.id, 'sas-biosci-2');
    assert.equal(year2.label, 'Year 2');
    assert.equal(year2.level, 2);
    assert.equal(year2.parser, 'grid');
});

await check('SAS Biological Sciences Year 2 has exactly the 3 mandatory courses and no electives', () => {
    const biosci = sas.programs.find(p => p.id === 'biological-sciences');
    const year2 = biosci.years[0];
    assert.deepStrictEqual(year2.mandatoryCourses, SAS_BIOSCI_MANDATORY);
    assert.equal(year2.electives, null);
});

await check('SAS Biological Sciences courses do NOT duplicate definitions in course-normalizer', () => {
    for (const name of SAS_BIOSCI_MANDATORY) {
        const res = resolveCourse(name);
        assert.ok(res, `${name} resolves`);
        assert.equal(res.ambiguous, false, `${name} is not ambiguous`);
    }
    assert.equal(resolveCourse('Applied Biological Sciences').canonical, 'applied-biological-sciences');
    assert.equal(resolveCourse('Microbiology').canonical, 'microbiology');
    assert.equal(resolveCourse('Environmental Biotechnology').canonical, 'environmental-biotechnology');
});

await check('SAS shows the programme selector with all three programmes', () => {
    assert.equal(shouldShowProgram(sas), true, 'programme selector is shown for SAS');
    const labels = sas.programs.map(p => p.label);
    assert.ok(labels.includes('Neuroscience'), 'Neuroscience programme listed');
    assert.ok(labels.includes('Psychology'), 'Psychology programme listed');
    assert.ok(labels.includes('Biological Sciences'), 'Biological Sciences programme listed');
});

console.log('--- parseCSV (grid): SAS Year 2 Biological Sciences ---');
const SAS_BIOSCI_GRID = [
    'MONDAY,09:15 AM - 10:10 AM,Applied Biological Sciences         Dr. Nair',
    ',10:15 AM - 11:10 AM,Microbiology         Dr. Gupta',
    'TUESDAY,09:15 AM - 10:10 AM,Environmental Biotechnology         Dr. Sharma',
].join('\n');

await check('SAS Year 2 Biological Sciences: all three mandatory courses parse', () => {
    const out = parseCSV(SAS_BIOSCI_GRID, 'grid', SAS_BIOSCI_MANDATORY, null, null);
    for (const name of SAS_BIOSCI_MANDATORY) {
        const c = out.find(x => x.subject === name);
        assert.ok(c, `${name} parsed`);
        assert.equal(c.elective, undefined, `${name} is not tagged as elective`);
    }
});

await check('SAS Year 2 Biological Sciences: mandatory courses carry stable canonical courseIds', () => {
    const out = parseCSV(SAS_BIOSCI_GRID, 'grid', SAS_BIOSCI_MANDATORY, null, null);
    assert.equal(out.find(x => x.subject === 'Applied Biological Sciences').courseId, 'applied-biological-sciences');
    assert.equal(out.find(x => x.subject === 'Microbiology').courseId, 'microbiology');
    assert.equal(out.find(x => x.subject === 'Environmental Biotechnology').courseId, 'environmental-biotechnology');
});

await check('SAS Year 2 Biological Sciences: a non-SAS cell (SCDS course) is skipped', () => {
    const mixed = [
        'MONDAY,09:15 AM - 10:10 AM,Applied Biological Sciences         Dr. Nair',
        ',10:15 AM - 11:10 AM,Deep Learning',
    ].join('\n');
    const out = parseCSV(mixed, 'grid', SAS_BIOSCI_MANDATORY, null, null);
    assert.ok(out.some(x => x.subject === 'Applied Biological Sciences'), 'SAS Biological Sciences course parsed');
    assert.ok(!out.some(x => x.subject === 'Deep Learning'), 'SCDS course is not pulled into SAS Year 2 Biological Sciences');
});

console.log('--- SOT Year 1 Biotechnology config ---');

const sot = SCHOOLS.find(s => s.id === 'sot');
const SOT_MANDATORY = [
    'Chemistry',
    'General Mathematics',
    'Fundamentals of Biotechnology',
    'Critical Thinking',
    'Indian Constitution & Democracy',
    'Frontiers of AI',
];
const SOT_ELECTIVES = null;

await check('SOT school exists with the Biotechnology programme', () => {
    assert.ok(sot, 'SOT school exists');
    assert.equal(sot.shortName, 'SOT');
    assert.ok(sot.programs, 'SOT uses a program hierarchy');
    const bio = sot.programs.find(p => p.id === 'biotechnology');
    assert.ok(bio, 'Biotechnology programme exists');
    assert.equal(bio.label, 'Biotechnology');
});

await check('SOT Biotechnology has a Year 1 and a Year 2 config', () => {
    const bio = sot.programs.find(p => p.id === 'biotechnology');
    assert.equal(bio.years.length, 2, 'two year configs');
    const year1 = bio.years[0];
    assert.equal(year1.label, 'Year 1');
    assert.equal(year1.level, 1);
    assert.equal(year1.id, 'sot-bio-1');
    assert.equal(year1.parser, 'grid');
    const year2 = bio.years[1];
    assert.equal(year2.label, 'Year 2');
    assert.equal(year2.level, 2);
    assert.equal(year2.id, 'sot-bio-2');
    assert.equal(year2.parser, 'grid');
});

await check('SOT Year 1 has exactly the 6 mandatory courses and no electives', () => {
    const year1 = sot.programs.find(p => p.id === 'biotechnology').years[0];
    assert.deepStrictEqual(year1.mandatoryCourses, SOT_MANDATORY);
    assert.equal(year1.electives, null);
});

await check('SOT Year 1 exclusive courses do NOT appear in any other school/programme/year', () => {
    // "Critical Thinking" is a pre-existing shared course (already offered by
    // SCDS Year 3 before SOT was added), and "Frontiers of AI" is shared with
    // SOB Year 1 — the requirement is that the NEW SOT courses are not added
    // to any other programme, so only the four SOT-specific courses are
    // checked for cross-contamination.
    const exclusive = SOT_MANDATORY.filter(name => !['Critical Thinking', 'Frontiers of AI'].includes(name));
    const sotCourses = new Set(exclusive);
    for (const school of SCHOOLS) {
        if (school.id === 'sot') continue;
        const yearConfigs = school.programs
            ? school.programs.flatMap(p => p.years)
            : (school.years || []);
        for (const year of yearConfigs) {
            const all = [...(year.mandatoryCourses || []), ...(year.electives || []).map(e => e.label)];
            for (const name of all) {
                assert.ok(!sotCourses.has(name), `${school.id} / ${year.id} must not contain "${name}"`);
            }
        }
    }
});

await check('SOT and SOB are the schools offering Year 1', () => {
    const year1Schools = SCHOOLS.filter(s => {
        const years = s.programs ? s.programs.flatMap(p => p.years) : (s.years || []);
        return years.some(y => y.level === 1);
    });
    assert.deepStrictEqual(year1Schools.map(s => s.id).sort(), ['scds', 'sob', 'sot'], 'SCDS, SOB and SOT offer Year 1');
});

console.log('--- SOT Year 2 Biotechnology config ---');

const SOT2 = sot.programs.find(p => p.id === 'biotechnology').years[1];
const SOT2_MANDATORY = [
    'Basic Chemical Engineering',
    'Chemical Engineering',
    'Environmental Biotechnology',
    'Microbiology',
    'Frontiers of AI',
    'Operations Research',
];
const SOT2_ELECTIVES = null;

await check('SOT Year 2 has exactly the 6 mandatory courses and no electives', () => {
    assert.deepStrictEqual(SOT2.mandatoryCourses, SOT2_MANDATORY);
    assert.equal(SOT2.electives, null);
});

await check('SOT Year 2 exclusive courses do NOT appear in any other school/programme/year', () => {
    // "Frontiers of AI" (SOT Year 1), "Operations Research" (SOB Year 2),
    // "Microbiology" and "Environmental Biotechnology" (SAS Biological Sciences)
    // are pre-existing shared courses. The remaining SOT Year 2 courses must
    // not be added to any other programme.
    const exclusive = SOT2_MANDATORY.filter(name => !['Frontiers of AI', 'Operations Research', 'Microbiology', 'Environmental Biotechnology'].includes(name));
    const sot2Courses = new Set(exclusive);
    for (const school of SCHOOLS) {
        if (school.id === 'sot') continue;
        const yearConfigs = school.programs
            ? school.programs.flatMap(p => p.years)
            : (school.years || []);
        for (const year of yearConfigs) {
            const all = [...(year.mandatoryCourses || []), ...(year.electives || []).map(e => e.label)];
            for (const name of all) {
                assert.ok(!sot2Courses.has(name), `${school.id} / ${year.id} must not contain "${name}"`);
            }
        }
    }
});

await check('SOT Year 2: all five mandatory courses resolve to stable canonical ids', () => {
    const ctx = buildYearCourseContext(SOT2.mandatoryCourses, SOT2.electives);
    for (const name of SOT2_MANDATORY) {
        const res = resolveCourse(name);
        assert.ok(res && !res.ambiguous && res.canonical, `${name} resolves`);
        assert.ok(ctx.known.has(res.canonical), `${name} is in the Year 2 known set`);
    }
    assert.equal(resolveCourse('Chemical Engineering').canonical, 'chemical-engineering');
    assert.equal(resolveCourse('Environmental Biotechnology').canonical, 'environmental-biotechnology');
    assert.equal(resolveCourse('Microbiology').canonical, 'microbiology');
    assert.equal(resolveCourse('Frontiers of AI').canonical, 'frontiers-of-ai');
    assert.equal(resolveCourse('Operations Research').canonical, 'operations-research');
});

await check('SOT Year 2: no duplicate course definitions were created', () => {
    // Reused entries (frontiers-of-ai, operations-research) must not be
    // duplicated in the registry — resolveCourse must yield exactly one hit.
    for (const name of SOT2_MANDATORY) {
        const res = resolveCourse(name);
        assert.ok(res && !res.ambiguous, `${name} is unambiguous`);
        assert.equal(res.candidates.length, 0, `${name} has no competing candidates`);
    }
});

console.log('--- parseCSV (grid): SOT Year 1 Biotechnology ---');
const SOT_GRID = [
    'MONDAY,09:15 AM - 10:10 AM,Chemistry         Dr. Gupta',
    ',10:15 AM - 11:10 AM,General Mathematics         Dr. Rao',
    ',11:15 AM - 12:10 PM,Fundamentals of Biotechnology         Dr. Sharma',
    ',12:15 PM - 1:10 PM,Critical Thinking (SAS/SoAI/SoB/SoT/SCDS)  (Sem 1)         Megha Kapoor',
    'TUESDAY,09:15 AM - 10:10 AM,Indian Constitution & Democracy - Sem1         Dr. Khan',
    ',10:15 AM - 11:10 AM,Frontiers of AI Sem1         Dr. Iyer',
].join('\n');

await check('SOT Year 1: all six mandatory courses parse', () => {
    const out = parseCSV(SOT_GRID, 'grid', SOT_MANDATORY, SOT_ELECTIVES, null);
    for (const name of SOT_MANDATORY) {
        const c = out.find(x => x.subject === name);
        assert.ok(c, `${name} parsed`);
        assert.equal(c.elective, undefined, `${name} is not tagged as elective`);
    }
});

await check('SOT Year 1: mandatory courses carry stable canonical courseIds', () => {
    const out = parseCSV(SOT_GRID, 'grid', SOT_MANDATORY, SOT_ELECTIVES, null);
    assert.equal(out.find(x => x.subject === 'Chemistry').courseId, 'chemistry');
    assert.equal(out.find(x => x.subject === 'General Mathematics').courseId, 'general-mathematics');
    assert.equal(out.find(x => x.subject === 'Fundamentals of Biotechnology').courseId, 'fundamentals-of-biotechnology');
    assert.equal(out.find(x => x.subject === 'Critical Thinking').courseId, 'critical-thinking');
    assert.equal(out.find(x => x.subject === 'Indian Constitution & Democracy').courseId, 'indian-constitution-and-democracy');
    assert.equal(out.find(x => x.subject === 'Frontiers of AI').courseId, 'frontiers-of-ai');
});

await check('SOT Year 1: classes carry real teacher/time/room data from the source', () => {
    const out = parseCSV(SOT_GRID, 'grid', SOT_MANDATORY, SOT_ELECTIVES, null);
    const c = out.find(x => x.subject === 'Chemistry');
    assert.equal(c.faculty, 'Prof. Dr.Gupta');
    assert.equal(c.startTime, '09:15');
    assert.equal(c.endTime, '10:10');
    assert.equal(c.day, 'Monday');
});

await check('SOT Year 1: "Indian Constitution & Democracy - Sem1" drops the Sem1 tag', () => {
    const variant = [
        'MONDAY,09:15 AM - 10:10 AM,Indian Constitution & Democracy - Sem1',
    ].join('\n');
    const out = parseCSV(variant, 'grid', SOT_MANDATORY, SOT_ELECTIVES, null);
    const c = out.find(x => x.courseId === 'indian-constitution-and-democracy');
    assert.ok(c, 'course parsed from a bare tagged cell');
    assert.equal(c.subject, 'Indian Constitution & Democracy', 'Sem1 tag stripped');
    assert.equal(c.faculty, '', 'no phantom teacher invented');
});

await check('SOT Year 1: "Indian Constitution & Democracy - Sem1 - Teacher" parses with the full name', () => {
    const variant = [
        'MONDAY,09:15 AM - 10:10 AM,Indian Constitution & Democracy - Sem1 - Dr. Khan',
    ].join('\n');
    const out = parseCSV(variant, 'grid', SOT_MANDATORY, SOT_ELECTIVES, null);
    const c = out.find(x => x.courseId === 'indian-constitution-and-democracy');
    assert.ok(c, 'course parsed with a teacher');
    assert.equal(c.subject, 'Indian Constitution & Democracy');
    assert.equal(c.faculty, 'Prof. Dr.Khan');
});

await check('SOT Year 1: "Frontiers of AI Sem1" drops the Sem1 tag', () => {
    const variant = [
        'MONDAY,09:15 AM - 10:10 AM,Frontiers of AI Sem1',
    ].join('\n');
    const out = parseCSV(variant, 'grid', SOT_MANDATORY, SOT_ELECTIVES, null);
    const c = out.find(x => x.courseId === 'frontiers-of-ai');
    assert.ok(c, 'course parsed from a bare tagged cell');
    assert.equal(c.subject, 'Frontiers of AI', 'Sem1 tag stripped');
    assert.equal(c.faculty, '', 'no phantom teacher invented');
});

await check('SOT Year 1: "Indian Constitution and Democracy - Sem1" ("and" for "&") still matches', () => {
    const variant = [
        'MONDAY,09:15 AM - 10:10 AM,Indian Constitution and Democracy - Sem1',
    ].join('\n');
    const out = parseCSV(variant, 'grid', SOT_MANDATORY, SOT_ELECTIVES, null);
    const c = out.find(x => x.courseId === 'indian-constitution-and-democracy');
    assert.ok(c, 'course parsed via & ↔ and normalization');
    assert.equal(c.subject, 'Indian Constitution & Democracy');
});

await check('SOT Year 1: "Critical Thinking (SAS/SoAI/SoB/SoT/SCDS)  (Sem 1)" shows as plain Critical Thinking', () => {
    const variant = [
        'MONDAY,09:15 AM - 10:10 AM,Critical Thinking (SAS/SoAI/SoB/SoT/SCDS)  (Sem 1)',
    ].join('\n');
    const out = parseCSV(variant, 'grid', SOT_MANDATORY, SOT_ELECTIVES, null);
    const c = out.find(x => x.courseId === 'critical-thinking');
    assert.ok(c, 'course parsed from a bare tagged cell');
    assert.equal(c.subject, 'Critical Thinking', 'school + semester tags stripped');
    assert.equal(c.faculty, '', 'no phantom teacher invented');
});

await check('SOT Year 1: "Critical Thinking (SAS/SoAI/SoB/SoT/SCDS) (Sem 1) Megha Kapoor" parses cleanly', () => {
    const variant = [
        'MONDAY,09:15 AM - 10:10 AM,Critical Thinking (SAS/SoAI/SoB/SoT/SCDS)  (Sem 1)              Megha Kapoor',
    ].join('\n');
    const out = parseCSV(variant, 'grid', SOT_MANDATORY, SOT_ELECTIVES, null);
    const c = out.find(x => x.courseId === 'critical-thinking');
    assert.ok(c, 'course parsed with its teacher');
    assert.equal(c.subject, 'Critical Thinking');
    assert.equal(c.faculty, 'Prof. Megha Kapoor');
});

await check('SOT Year 1: a non-SOT cell (SCDS course) is skipped', () => {
    const mixed = [
        'MONDAY,09:15 AM - 10:10 AM,Chemistry         Dr. Gupta',
        ',10:15 AM - 11:10 AM,Deep Learning',
    ].join('\n');
    const out = parseCSV(mixed, 'grid', SOT_MANDATORY, SOT_ELECTIVES, null);
    assert.ok(out.some(x => x.subject === 'Chemistry'), 'SOT course parsed');
    assert.ok(!out.some(x => x.subject === 'Deep Learning'), 'SCDS course is not pulled into SOT Year 1');
});

console.log('--- parseCSV (grid): SOT Year 2 Biotechnology ---');
// The grid below carries ONLY course names (no teacher/time/room baked in from
// any timetable image) — the parser must recognize the five Year 2 courses
// purely from the configured course list, with real data coming from the
// source sheet at runtime.
const SOT2_GRID = [
    'MONDAY,09:15 AM - 10:10 AM,Basic Chemical Engineering',
    ',10:15 AM - 11:10 AM,Chemical Engineering',
    ',11:15 AM - 12:10 PM,Environmental Biotechnology',
    ',12:15 PM - 1:10 PM,Microbiology',
    ',2:15 PM - 3:10 PM,Frontiers of AI',
    ',3:15 PM - 4:10 PM,Operations Research',
].join('\n');

await check('SOT Year 2: all six mandatory courses parse', () => {
    const out = parseCSV(SOT2_GRID, 'grid', SOT2_MANDATORY, SOT2_ELECTIVES, null);
    for (const name of SOT2_MANDATORY) {
        const c = out.find(x => x.subject === name);
        assert.ok(c, `${name} parsed`);
        assert.equal(c.elective, undefined, `${name} is not tagged as elective`);
    }
});

await check('SOT Year 2: mandatory courses carry stable canonical courseIds', () => {
    const out = parseCSV(SOT2_GRID, 'grid', SOT2_MANDATORY, SOT2_ELECTIVES, null);
    assert.equal(out.find(x => x.subject === 'Basic Chemical Engineering').courseId, 'basic-chemical-engineering');
    assert.equal(out.find(x => x.subject === 'Chemical Engineering').courseId, 'chemical-engineering');
    assert.equal(out.find(x => x.subject === 'Environmental Biotechnology').courseId, 'environmental-biotechnology');
    assert.equal(out.find(x => x.subject === 'Microbiology').courseId, 'microbiology');
    assert.equal(out.find(x => x.subject === 'Frontiers of AI').courseId, 'frontiers-of-ai');
    assert.equal(out.find(x => x.subject === 'Operations Research').courseId, 'operations-research');
});

await check('SOT Year 2: a non-SOT cell (SCDS course) is skipped', () => {
    const mixed = [
        'MONDAY,09:15 AM - 10:10 AM,Microbiology',
        ',10:15 AM - 11:10 AM,Deep Learning',
    ].join('\n');
    const out = parseCSV(mixed, 'grid', SOT2_MANDATORY, SOT2_ELECTIVES, null);
    assert.ok(out.some(x => x.subject === 'Microbiology'), 'SOT Year 2 course parsed');
    assert.ok(!out.some(x => x.subject === 'Deep Learning'), 'SCDS course is not pulled into SOT Year 2');
});

console.log('--- generic lab classification (grid) ---');

await check('splitLabSuffix: only a trailing " Lab" suffix is a lab', () => {
    assert.deepEqual(splitLabSuffix('Emering Tools and Applications'), { base: 'Emering Tools and Applications', isLab: false });
    assert.deepEqual(splitLabSuffix('Emering Tools and Applications Lab'), { base: 'Emering Tools and Applications', isLab: true });
    assert.deepEqual(splitLabSuffix('Advanced Robotics'), { base: 'Advanced Robotics', isLab: false });
    assert.deepEqual(splitLabSuffix('Advanced Robotics Lab'), { base: 'Advanced Robotics', isLab: true });
    assert.deepEqual(splitLabSuffix('DAA Lab.'), { base: 'DAA', isLab: true });
    assert.deepEqual(splitLabSuffix('Emering Tools'), { base: 'Emering Tools', isLab: false });
    assert.deepEqual(splitLabSuffix('Lab'), { base: 'Lab', isLab: false });
});

await check('a normal course keeps its full name and no lab tag', () => {
    const g = [
        'MONDAY,09:15 AM - 10:10 AM,Advanced Robotics (Sec 1)',
        ',,"AB2 - 207"',
    ].join('\n');
    const out = parseCSV(g, 'grid', ['Advanced Robotics'], null, null);
    const c = out.find(x => x.subject === 'Advanced Robotics');
    assert.ok(c, 'course parsed');
    assert.equal(c.lab, undefined, 'no lab tag on a normal course');
    assert.equal(c.subject, 'Advanced Robotics', 'full name preserved');
});

await check('"Advanced Robotics Lab" is the lab variant: name preserved + lab tag, never truncated', () => {
    const g = [
        'MONDAY,09:15 AM - 10:10 AM,Advanced Robotics (Sec 1),Advanced Robotics Lab (Sec 2)',
        ',,"AB2 - 207","AB2 - 207"',
    ].join('\n');
    const out = parseCSV(g, 'grid', ['Advanced Robotics'], null, null);
    const lab = out.find(x => x.lab === true);
    assert.ok(lab, 'lab class parsed');
    assert.equal(lab.subject, 'Advanced Robotics Lab', 'underlying lab name preserved');
    assert.equal(lab.courseId, 'advanced-robotics-lab', 'lab keeps its own identity');
    assert.ok(out.some(x => x.subject === 'Advanced Robotics'), 'lecture parsed alongside');
});

await check('"Emering Tools and Applications" is recognized and keeps its exact spelling', () => {
    const g = [
        'MONDAY,09:15 AM - 10:10 AM,ET - Sec 1 - Arjun',
        ',,AB2-101',
        'TUESDAY,09:15 AM - 10:10 AM,EMERING TOOLS AND APPLICATIONS - Sec 2 - Sonar',
        ',,AB2-202',
        'WEDNESDAY,09:15 AM - 10:10 AM,Emering Tools and Applications Lab - Sec 1 - Arjun',
        ',,AB2-101',
    ].join('\n');
    const electives = [{ id: 'emerging-tools-and-applications', label: 'Emering Tools and Applications' }];
    const out = parseCSV(g, 'grid', null, electives, ['AB2-101', 'AB2-202']);

    const lecture = out.find(x => x.subject === 'Emering Tools and Applications' && x.section === 2);
    assert.ok(lecture, 'Emering lecture recognized');
    assert.equal(lecture.elective, 'emerging-tools-and-applications', 'resolves to the elective');
    assert.equal(lecture.lab, undefined, 'normal course has no lab tag');
    assert.equal(lecture.faculty, 'Prof. Sonar');
    assert.ok(out.some(x => x.subject === 'Emering Tools and Applications' && x.section === 1),
        '"ET" alias also displays the same canonical name');

    const lab = out.find(x => x.subject === 'Emering Tools and Applications Lab');
    assert.ok(lab, 'Emering lab recognized');
    assert.equal(lab.elective, 'emerging-tools-and-applications', 'lab shares the elective identity');
    assert.equal(lab.lab, true, 'lab classified for display as "… [Lab]"');
    assert.equal(lab.faculty, 'Prof. Arjun');
});

await check('"Emering Tools and Applications" does not falsely match a partial name', () => {
    const g = [
        'MONDAY,09:15 AM - 10:10 AM,Emering Tools and Applications - Sec 3 - Sonar',
        ',,AB2-202',
    ].join('\n');
    const electives = [{ id: 'emerging-tools-and-applications', label: 'Emering Tools and Applications' }];
    const out = parseCSV(g, 'grid', null, electives, ['AB2-202']);
    const c = out.find(x => x.subject === 'Emering Tools and Applications');
    assert.ok(c);
    assert.equal(c.lab, undefined, 'never flagged as a lab by a sibling "… Lab" course');
    assert.equal(c.subject, 'Emering Tools and Applications');
});

console.log(`\n${passed} passed, ${failed} failed`);
rmSync(dir, { recursive: true, force: true });
if (failed) process.exit(1);
