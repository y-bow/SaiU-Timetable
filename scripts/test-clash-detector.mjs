/**
 * Timetable clash detector test harness (Node).
 *
 * Tests js/data/clash-detector.js against all 27 scenarios from the spec:
 *
 *  1.  Identical time overlap (student clash)
 *  2.  Partial time overlap
 *  3.  One class completely containing another
 *  4.  Adjacent classes with no overlap
 *  5.  Same room + overlapping time → room clash
 *  6.  Same room + non-overlapping time → no clash
 *  7.  Same teacher + overlapping time → teacher clash
 *  8.  Same teacher + non-overlapping time → no clash
 *  9.  Mandatory + elective overlap
 * 10.  Elective + elective overlap
 * 11.  Different schools at same time → no student clash
 * 12.  Different years at same time → no student clash
 * 13.  Different sections at same time → no student clash
 * 14.  Same course, legitimate multiple sessions (no self-clash)
 * 15.  Lab + theory overlap
 * 16.  Lab + lab overlap
 * 17.  Missing room → no room clash
 * 18.  Missing teacher → no teacher clash
 * 19.  Missing start/end time → no clash
 * 20.  Different time formats (already normalised by parser — verify NaN safety)
 * 21.  Duplicate timetable record (same identity) → no self-clash
 * 22.  Self-comparison guard
 * 23.  Multiple simultaneous clashes (room + teacher + student)
 * 24.  Newly added timetable entry automatically detected
 * 25.  Removing a conflicting entry removes the CLASH
 * 26.  Changing time removes/adds CLASH correctly
 * 27.  Switching student context recalculates correctly
 *
 * Run:  node scripts/test-clash-detector.mjs
 */

import assert from 'node:assert/strict';

const MODULE = new URL('../js/data/clash-detector.js', import.meta.url);
const {
    detectClashes,
    detectClashes: detect,
    timeToMinutes,
    timesOverlap,
    clashEntryIdentity,
    clashTypeLabels,
} = await import(MODULE);

let passed = 0;
let failed = 0;

const check = (name, fn) => {
    try { fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`FAIL  ${name}\n      ${err.message}`); }
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Factory for a minimal class record.
const cls = (o = {}) => ({
    day: 'Monday',
    subject: 'Mathematics',
    faculty: 'Prof. Alpha',
    room: 'AB1-101',
    section: 1,
    startTime: '09:00',
    endTime: '09:55',
    ...o,
});

// Factory for a mandatory class record.
const mandatory = (o = {}) => cls({ subject: 'Deep Learning', faculty: 'Prof. DL', ...o });

// Factory for an elective class record.
const elective = (o = {}) => cls({
    subject: 'Quantum Machine Learning',
    elective: 'quantum-machine-learning',
    faculty: 'Prof. QML',
    room: 'AB2-201',
    ...o,
});

// Extract clash types for a class in the result.
const clashTypes = (result, subject) => {
    const c = result.find(r => r.subject === subject);
    if (!c) return null;
    return clashTypeLabels(c.clashes);
};

// Whether the named class has ANY clash.
const hasClash = (result, subject) => {
    const c = result.find(r => r.subject === subject);
    return !!(c && c.clashes && c.clashes.length > 0);
};

// Whether the result list contains NO clashes at all.
const allClean = (result) => result.every(c => !c.clashes || c.clashes.length === 0);

// ─── Unit tests: timeToMinutes ────────────────────────────────────────────────

console.log('--- timeToMinutes ---');
check('09:00 → 540', () => assert.equal(timeToMinutes('09:00'), 540));
check('15:30 → 930', () => assert.equal(timeToMinutes('15:30'), 930));
check('00:00 → 0',   () => assert.equal(timeToMinutes('00:00'), 0));
check('null → NaN',  () => assert.ok(Number.isNaN(timeToMinutes(null))));
check('empty → NaN', () => assert.ok(Number.isNaN(timeToMinutes(''))));
check('garbage → NaN', () => assert.ok(Number.isNaN(timeToMinutes('not-a-time'))));

// ─── Unit tests: timesOverlap ─────────────────────────────────────────────────

console.log('--- timesOverlap ---');
check('identical slots overlap', () => assert.ok(timesOverlap(540, 595, 540, 595)));
check('partial overlap (B starts inside A)', () => assert.ok(timesOverlap(540, 595, 570, 650)));
check('A contains B', () => assert.ok(timesOverlap(540, 650, 560, 610)));
check('touching endpoints → NO overlap', () => assert.ok(!timesOverlap(540, 595, 595, 650)));
check('non-overlapping (A before B)', () => assert.ok(!timesOverlap(540, 595, 600, 655)));
check('NaN start → no overlap', () => assert.ok(!timesOverlap(NaN, 595, 540, 595)));
check('NaN end → no overlap',   () => assert.ok(!timesOverlap(540, NaN, 540, 595)));
check('zero-duration A → no overlap', () => assert.ok(!timesOverlap(540, 540, 540, 595)));

// ─── Integration tests: detectClashes ────────────────────────────────────────

console.log('--- Test 1: Identical time overlap (student clash) ---');
check('two classes at exactly the same time → student clash', () => {
    const a = cls({ subject: 'CourseA', startTime: '09:00', endTime: '09:55' });
    const b = cls({ subject: 'CourseB', faculty: 'Prof. Beta', room: 'AB2-101', startTime: '09:00', endTime: '09:55' });
    const result = detect([a, b], [], null);
    assert.ok(hasClash(result, 'CourseA'), 'CourseA should clash');
    assert.ok(hasClash(result, 'CourseB'), 'CourseB should clash');
    assert.ok(clashTypes(result, 'CourseA').includes('student'), 'type should be student');
});

console.log('--- Test 2: Partial time overlap ---');
check('3:00-3:55 vs 3:30-4:25 → student clash', () => {
    const a = cls({ subject: 'CourseA', startTime: '15:00', endTime: '15:55' });
    const b = cls({ subject: 'CourseB', faculty: 'Prof. Beta', room: 'AB2-101', startTime: '15:30', endTime: '16:25' });
    const result = detect([a, b], [], null);
    assert.ok(hasClash(result, 'CourseA'));
    assert.ok(hasClash(result, 'CourseB'));
});

console.log('--- Test 3: One class completely containing another ---');
check('3:00-5:00 contains 3:30-4:30 → student clash', () => {
    const a = cls({ subject: 'LongClass',  startTime: '09:00', endTime: '11:00' });
    const b = cls({ subject: 'ShortClass', faculty: 'Prof. Beta', room: 'AB2-101', startTime: '09:30', endTime: '10:30' });
    const result = detect([a, b], [], null);
    assert.ok(hasClash(result, 'LongClass'));
    assert.ok(hasClash(result, 'ShortClass'));
});

console.log('--- Test 4: Adjacent classes with no overlap ---');
check('9:00-9:55 followed by 9:55-10:50 → NO clash', () => {
    const a = cls({ subject: 'CourseA', startTime: '09:00', endTime: '09:55' });
    const b = cls({ subject: 'CourseB', faculty: 'Prof. Beta', startTime: '09:55', endTime: '10:50' });
    const result = detect([a, b], [], null);
    assert.ok(!hasClash(result, 'CourseA'), 'CourseA should not clash');
    assert.ok(!hasClash(result, 'CourseB'), 'CourseB should not clash');
});

console.log('--- Test 5: Same room + overlapping time → room clash ---');
check('AB1-101, Monday 9:00-9:55 vs 9:30-10:25 → room clash', () => {
    const a = cls({ subject: 'CourseA', room: 'AB1-101', faculty: 'Prof. A',   startTime: '09:00', endTime: '09:55', section: 1 });
    const b = cls({ subject: 'CourseB', room: 'AB1-101', faculty: 'Prof. Beta', startTime: '09:30', endTime: '10:25', section: 2 });
    // allClasses contains both; studentClasses only contains CourseA
    const result = detect([a], [a, b], null);
    assert.ok(hasClash(result, 'CourseA'), 'CourseA should have a room clash');
    assert.ok(clashTypes(result, 'CourseA').includes('room'));
});

console.log('--- Test 6: Same room + non-overlapping time → no clash ---');
check('AB1-101, Monday 9:00-9:55 vs 10:00-10:55 → no room clash', () => {
    const a = cls({ subject: 'CourseA', room: 'AB1-101', faculty: 'Prof. A',   startTime: '09:00', endTime: '09:55', section: 1 });
    const b = cls({ subject: 'CourseB', room: 'AB1-101', faculty: 'Prof. Beta', startTime: '10:00', endTime: '10:55', section: 2 });
    const result = detect([a], [a, b], null);
    assert.ok(!hasClash(result, 'CourseA'), 'CourseA should not clash');
});

console.log('--- Test 7: Same teacher + overlapping time → teacher clash ---');
check('Prof. Alpha teaches two classes at 9:00-9:55 on Monday → teacher clash', () => {
    const a = cls({ subject: 'CourseA', faculty: 'Prof. Alpha', room: 'AB1-101', section: 1, startTime: '09:00', endTime: '09:55' });
    const b = cls({ subject: 'CourseB', faculty: 'Prof. Alpha', room: 'AB1-102', section: 2, startTime: '09:00', endTime: '09:55' });
    const result = detect([a], [a, b], null);
    assert.ok(hasClash(result, 'CourseA'));
    assert.ok(clashTypes(result, 'CourseA').includes('teacher'));
});

console.log('--- Test 8: Same teacher + non-overlapping time → no clash ---');
check('Prof. Alpha 9:00-9:55 then 10:00-10:55 → no teacher clash', () => {
    const a = cls({ subject: 'CourseA', faculty: 'Prof. Alpha', room: 'AB1-101', section: 1, startTime: '09:00', endTime: '09:55' });
    const b = cls({ subject: 'CourseB', faculty: 'Prof. Alpha', room: 'AB1-102', section: 2, startTime: '10:00', endTime: '10:55' });
    const result = detect([a], [a, b], null);
    assert.ok(!hasClash(result, 'CourseA'));
});

console.log('--- Test 9: Mandatory + elective overlap ---');
check('mandatory Deep Learning overlaps selected QML elective → student clash', () => {
    const m = mandatory({ startTime: '09:00', endTime: '09:55', room: 'AB1-101' });
    const e = elective({ startTime: '09:30', endTime: '10:25', room: 'AB2-201' });
    // Both in studentClasses because sectionClasses() already merged them.
    const result = detect([m, e], [m, e], null);
    assert.ok(hasClash(result, 'Deep Learning'));
    assert.ok(hasClash(result, 'Quantum Machine Learning'));
    assert.ok(clashTypes(result, 'Deep Learning').includes('student'));
});

console.log('--- Test 10: Elective + elective overlap ---');
check('two selected electives at 9:00-9:55 → student clash', () => {
    const e1 = elective({ subject: 'QML', elective: 'qml', faculty: 'Prof. QML', room: 'AB1-101', startTime: '09:00', endTime: '09:55' });
    const e2 = elective({ subject: 'CyberSec', elective: 'cybersecurity', faculty: 'Prof. CS', room: 'AB2-101', startTime: '09:00', endTime: '09:55' });
    const result = detect([e1, e2], [e1, e2], null);
    assert.ok(hasClash(result, 'QML'));
    assert.ok(hasClash(result, 'CyberSec'));
});

console.log('--- Test 11: Different schools at same time → no student clash ---');
check('SCDS CourseA and SOB CourseB at 9:00-9:55 are DIFFERENT students → clean', () => {
    // The student-context filter (sectionClasses()) would only pass ONE school's
    // classes to detectClashes. Here we simulate what happens when the student
    // only attends SCDS — SOB class never enters studentClasses.
    const scds = cls({ subject: 'SCDS Course', startTime: '09:00', endTime: '09:55', room: 'AB1-101' });
    const sob  = cls({ subject: 'SOB Course',  startTime: '09:00', endTime: '09:55', room: 'AB2-101', faculty: 'Prof. SOB' });
    // Only scds is the student's class.
    const result = detect([scds], [scds, sob], null);
    // No student clash because SOB class isn't in studentClasses.
    assert.ok(!clashTypes(result, 'SCDS Course')?.includes('student'), 'no student clash across schools');
    // But could be a room clash if same room — they have different rooms so clean.
    assert.ok(allClean(result), 'different rooms so no room clash either');
});

console.log('--- Test 12: Different years at same time → no student clash ---');
check('Year 2 and Year 3 same time — student only attends Year 2 → clean', () => {
    const y2 = cls({ subject: 'Year2 Course', startTime: '09:00', endTime: '09:55', room: 'AB1-101' });
    const y3 = cls({ subject: 'Year3 Course', startTime: '09:00', endTime: '09:55', room: 'AB1-102', faculty: 'Prof. Y3' });
    // Student is only in Year 2 — Year 3 class is not in studentClasses.
    const result = detect([y2], [y2, y3], null);
    assert.ok(!clashTypes(result, 'Year2 Course')?.includes('student'));
    assert.ok(allClean(result));
});

console.log('--- Test 13: Different sections at same time → no student clash ---');
check('Section 1 and Section 2 same course same time — only Sec 1 in studentClasses → clean', () => {
    const sec1 = cls({ subject: 'DAA', section: 1, faculty: 'Prof. Sec1', startTime: '09:00', endTime: '09:55' });
    const sec2 = cls({ subject: 'DAA', section: 2, faculty: 'Prof. Sec2', startTime: '09:00', endTime: '09:55' });
    // sectionClasses() would only pass Sec 1 to detectClashes.
    const result = detect([sec1], [sec1, sec2], null);
    // Sec 1 is in studentClasses alone, so no student clash.
    // But if sec2 is in allClasses and DIFFERENT subject it could be a room clash.
    // Here same room → check room: same room AB1-101, same teacher, different section —
    // but room clash: two different classes (DAA sec1 vs DAA sec2) in same room at same time.
    // The parallel-session exclusion only applies when SAME subject+elective+section+faculty,
    // here section differs, so it IS a room clash for Sec 1.
    // But from a STUDENT perspective, only sec1 is there. Let's verify no STUDENT clash.
    const types = clashTypes(result, 'DAA') || [];
    assert.ok(!types.includes('student'), 'no student clash between sections');
});

console.log('--- Test 14: Same course, legitimate multiple sessions (no self-clash) ---');
check('CourseA at 9:00-9:55 Monday AND 9:00-9:55 Wednesday → no self-clash', () => {
    const mon = cls({ subject: 'CourseA', day: 'Monday',    startTime: '09:00', endTime: '09:55' });
    const wed = cls({ subject: 'CourseA', day: 'Wednesday', startTime: '09:00', endTime: '09:55' });
    const result = detect([mon, wed], [mon, wed], null);
    assert.ok(!hasClash(result, 'CourseA'), 'different days → no clash');
});

check('Same course same day different times → no self-clash', () => {
    const a = cls({ subject: 'CourseA', startTime: '09:00', endTime: '09:55' });
    const b = cls({ subject: 'CourseA', startTime: '11:00', endTime: '11:55' });
    const result = detect([a, b], [a, b], null);
    assert.ok(allClean(result));
});

console.log('--- Test 15: Lab + theory overlap ---');
check('theory CourseA 9:00-9:55 vs lab CourseA Lab 9:30-10:25 → student clash', () => {
    const theory = cls({ subject: 'Emerging Tools and Applications',      startTime: '09:00', endTime: '09:55', section: 1 });
    const lab    = cls({ subject: 'Emerging Tools and Applications Lab',  startTime: '09:30', endTime: '10:25', section: 1, lab: true, faculty: 'Prof. Beta', room: 'AB1 Computer Lab' });
    const result = detect([theory, lab], [theory, lab], null);
    assert.ok(hasClash(result, 'Emerging Tools and Applications'));
    assert.ok(hasClash(result, 'Emerging Tools and Applications Lab'));
});

console.log('--- Test 16: Lab + lab overlap ---');
check('two lab classes at the same time in the same slot → student clash', () => {
    const lab1 = cls({ subject: 'Lab A', startTime: '09:00', endTime: '11:00', lab: true, section: 1 });
    const lab2 = cls({ subject: 'Lab B', startTime: '09:00', endTime: '11:00', lab: true, faculty: 'Prof. Beta', room: 'AB2-101', section: 1 });
    const result = detect([lab1, lab2], [lab1, lab2], null);
    assert.ok(hasClash(result, 'Lab A'));
    assert.ok(hasClash(result, 'Lab B'));
});

console.log('--- Test 17: Missing room → no room clash ---');
check('two classes with empty room at same time → no room clash', () => {
    const a = cls({ subject: 'CourseA', room: '', startTime: '09:00', endTime: '09:55', section: 1 });
    const b = cls({ subject: 'CourseB', room: '', startTime: '09:00', endTime: '09:55', section: 2, faculty: 'Prof. Beta' });
    const result = detect([a], [a, b], null);
    const types = clashTypes(result, 'CourseA') || [];
    assert.ok(!types.includes('room'), 'missing room must not produce room clash');
});

console.log('--- Test 18: Missing teacher → no teacher clash ---');
check('two classes with empty faculty at same time → no teacher clash', () => {
    const a = cls({ subject: 'CourseA', faculty: '', room: 'AB1-101', section: 1, startTime: '09:00', endTime: '09:55' });
    const b = cls({ subject: 'CourseB', faculty: '', room: 'AB1-102', section: 2, startTime: '09:00', endTime: '09:55' });
    const result = detect([a], [a, b], null);
    const types = clashTypes(result, 'CourseA') || [];
    assert.ok(!types.includes('teacher'), 'missing faculty must not produce teacher clash');
});

console.log('--- Test 19: Missing start/end time → no clash ---');
check('class with null startTime → no clash for that entry', () => {
    const a = cls({ subject: 'GoodClass', startTime: '09:00', endTime: '09:55' });
    const b = cls({ subject: 'BadTime',   startTime: null,    endTime: null, section: 2, faculty: 'Prof. Beta' });
    const result = detect([a, b], [a, b], null);
    // BadTime has unparseable times → cannot clash
    assert.ok(!hasClash(result, 'GoodClass'), 'GoodClass vs BadTime should not clash');
    assert.ok(!hasClash(result, 'BadTime'));
});

console.log('--- Test 20: Time format safety (NaN guard) ---');
check('garbage time string → NaN → no crash and no clash', () => {
    const a = cls({ subject: 'CourseA', startTime: '9am-10am', endTime: undefined });
    const b = cls({ subject: 'CourseB', faculty: 'Prof. Beta', startTime: '09:00', endTime: '09:55', section: 2 });
    // Should not throw.
    let result;
    assert.doesNotThrow(() => { result = detect([a, b], [a, b], null); });
    // CourseA has invalid time → NaN, cannot overlap.
    assert.ok(!hasClash(result, 'CourseB'), 'no clash when one side has bad time');
});

console.log('--- Test 21: Duplicate timetable record → no self-clash ---');
check('exact same record object appearing twice → never a clash with itself', () => {
    const a = cls({ subject: 'CourseA' });
    // Same record pushed twice (simulates a parsing artifact).
    const result = detect([a, a], [a, a], null);
    assert.ok(!hasClash(result, 'CourseA'), 'duplicate record must not self-clash');
});

console.log('--- Test 22: Self-comparison guard ---');
check('single class → no clashes ever', () => {
    const a = cls({ subject: 'Lonely' });
    const result = detect([a], [a], null);
    assert.ok(!hasClash(result, 'Lonely'));
});

console.log('--- Test 23: Multiple simultaneous clashes ---');
check('CourseA has student + room + teacher clash simultaneously', () => {
    // CourseA (student's class): Monday 9:00-9:55, AB1-101, Prof. Shared
    const a = cls({ subject: 'CourseA', room: 'AB1-101', faculty: 'Prof. Shared', section: 1, startTime: '09:00', endTime: '09:55' });
    // CourseB (also student's class): same time → student clash
    const b = cls({ subject: 'CourseB', room: 'AB2-101', faculty: 'Prof. Beta',   section: 1, startTime: '09:00', endTime: '09:55' });
    // CourseC (different student group): same room → room clash
    const c = cls({ subject: 'CourseC', room: 'AB1-101', faculty: 'Prof. Gamma', section: 2, startTime: '09:00', endTime: '09:55' });
    // CourseD (different student group): same teacher → teacher clash
    const d = cls({ subject: 'CourseD', room: 'AB2-201', faculty: 'Prof. Shared', section: 3, startTime: '09:00', endTime: '09:55' });

    const result = detect([a, b], [a, b, c, d], null);
    const typesA = clashTypes(result, 'CourseA');
    assert.ok(typesA.includes('student'), 'student clash expected');
    assert.ok(typesA.includes('room'),    'room clash expected');
    assert.ok(typesA.includes('teacher'), 'teacher clash expected');
});

console.log('--- Test 24: Newly added entry automatically detected ---');
check('adding CourseB to timetable creates clash with CourseA without code change', () => {
    const a = cls({ subject: 'CourseA', startTime: '09:00', endTime: '09:55' });
    // Before: no clash
    let result = detect([a], [a], null);
    assert.ok(!hasClash(result, 'CourseA'), 'no clash before adding CourseB');

    // After: CourseB added to the student's timetable — detector finds it automatically.
    const b = cls({ subject: 'CourseB', faculty: 'Prof. Beta', startTime: '09:30', endTime: '10:25', room: 'AB2-101' });
    result = detect([a, b], [a, b], null);
    assert.ok(hasClash(result, 'CourseA'), 'clash auto-detected after adding CourseB');
    assert.ok(hasClash(result, 'CourseB'));
});

console.log('--- Test 25: Removing a conflicting entry removes the CLASH ---');
check('after removing CourseB, CourseA is clash-free', () => {
    const a = cls({ subject: 'CourseA', startTime: '09:00', endTime: '09:55' });
    const b = cls({ subject: 'CourseB', faculty: 'Prof. Beta', startTime: '09:30', endTime: '10:25', room: 'AB2-101' });

    // Both present → clash.
    let result = detect([a, b], [a, b], null);
    assert.ok(hasClash(result, 'CourseA'), 'clash while CourseB is present');

    // CourseB removed → clean.
    result = detect([a], [a], null);
    assert.ok(!hasClash(result, 'CourseA'), 'no clash after removing CourseB');
});

console.log('--- Test 26: Changing time removes/adds CLASH correctly ---');
check('moving CourseB to a non-overlapping time removes the clash', () => {
    const a = cls({ subject: 'CourseA', startTime: '09:00', endTime: '09:55' });
    const b = cls({ subject: 'CourseB', faculty: 'Prof. Beta', room: 'AB2-101', startTime: '09:30', endTime: '10:25' });

    // Overlapping → clash.
    let result = detect([a, b], [a, b], null);
    assert.ok(hasClash(result, 'CourseA'));

    // Move CourseB to 10:00 → no overlap.
    const bMoved = { ...b, startTime: '10:00', endTime: '10:55' };
    result = detect([a, bMoved], [a, bMoved], null);
    assert.ok(!hasClash(result, 'CourseA'), 'no clash after rescheduling');
});

check('moving CourseB into overlap re-creates the clash', () => {
    const a = cls({ subject: 'CourseA', startTime: '09:00', endTime: '09:55' });
    const bClean = cls({ subject: 'CourseB', faculty: 'Prof. Beta', room: 'AB2-101', startTime: '10:00', endTime: '10:55' });

    let result = detect([a, bClean], [a, bClean], null);
    assert.ok(!hasClash(result, 'CourseA'), 'clean initially');

    const bClash = { ...bClean, startTime: '09:30', endTime: '10:25' };
    result = detect([a, bClash], [a, bClash], null);
    assert.ok(hasClash(result, 'CourseA'), 'clash after rescheduling into overlap');
});

console.log('--- Test 27: Switching student context recalculates correctly ---');
check('switching section clears stale clash when new section has no overlap', () => {
    // Section 1 student: CourseA (9:00-9:55) + CourseB (9:30-10:25) → clash
    const sec1a = cls({ subject: 'CourseA', section: 1, startTime: '09:00', endTime: '09:55' });
    const sec1b = cls({ subject: 'CourseB', section: 1, faculty: 'Prof. Beta', room: 'AB2-101', startTime: '09:30', endTime: '10:25' });
    let result = detect([sec1a, sec1b], [sec1a, sec1b], null);
    assert.ok(hasClash(result, 'CourseA'), 'Section 1 has clash');

    // Section 2 student: different schedule, no overlap.
    const sec2a = cls({ subject: 'CourseA', section: 2, startTime: '09:00', endTime: '09:55' });
    const sec2b = cls({ subject: 'CourseB', section: 2, faculty: 'Prof. Beta', room: 'AB2-101', startTime: '10:00', endTime: '10:55' });
    result = detect([sec2a, sec2b], [sec2a, sec2b], null);
    assert.ok(!hasClash(result, 'CourseA'), 'Section 2 has no clash — stale clash gone');
});

check('switching school clears stale clash', () => {
    // Old school context: clash existed.
    const old1 = cls({ subject: 'OldA', startTime: '09:00', endTime: '09:55' });
    const old2 = cls({ subject: 'OldB', faculty: 'Prof. Beta', room: 'AB2-101', startTime: '09:30', endTime: '10:25' });
    let result = detect([old1, old2], [old1, old2], null);
    assert.ok(hasClash(result, 'OldA'), 'old school had clash');

    // New school context: only one class, no clash.
    const newA = cls({ subject: 'NewA', faculty: 'Prof. New', room: 'CR-101', startTime: '09:00', endTime: '09:55' });
    result = detect([newA], [newA], null);
    assert.ok(!hasClash(result, 'NewA'), 'new school context is clash-free');
});

// ─── Additional edge cases ────────────────────────────────────────────────────

console.log('--- Additional edge cases ---');

check('empty studentClasses → returns empty array', () => {
    const result = detect([], [], null);
    assert.deepEqual(result, []);
});

check('all entries on different days → no student clashes', () => {
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
    const classes = days.map((d, i) => cls({ subject: `Course${i}`, day: d, faculty: `Prof.${i}` }));
    const result = detect(classes, classes, null);
    assert.ok(allClean(result));
});

check('room clash: hyphen-vs-space room normalization', () => {
    // "AB1-101" and "AB1 101" should normalize to the same key.
    const a = cls({ subject: 'CourseA', room: 'AB1-101', section: 1, startTime: '09:00', endTime: '09:55' });
    const b = cls({ subject: 'CourseB', room: 'AB1 101', faculty: 'Prof. Beta', section: 2, startTime: '09:00', endTime: '09:55' });
    const result = detect([a], [a, b], null);
    assert.ok(hasClash(result, 'CourseA'), 'hyphen/space normalized room clash detected');
});

check('parallel legitimate offerings (same subject/section/faculty/elective) in same room → no room clash', () => {
    // The same single-section mandatory class parsed from two different columns
    // (edge case in grid parser) should not be a room clash.
    const a = cls({ subject: 'Deep Learning', room: 'AB1-101', section: 1, faculty: 'Prof. DL', startTime: '09:00', endTime: '09:55' });
    const b = cls({ subject: 'Deep Learning', room: 'AB1-101', section: 1, faculty: 'Prof. DL', startTime: '09:00', endTime: '09:55' });
    const result = detect([a], [a, b], null);
    const types = clashTypes(result, 'Deep Learning') || [];
    assert.ok(!types.includes('room'), 'same subject/section/faculty in same room is NOT a room clash');
});

check('clashTypeLabels returns deterministic order: student, room, teacher', () => {
    const clashes = [
        { type: 'teacher', with: {} },
        { type: 'student', with: {} },
        { type: 'room',    with: {} },
    ];
    const labels = clashTypeLabels(clashes);
    assert.deepEqual(labels, ['student', 'room', 'teacher']);
});

check('clashTypeLabels deduplicates types', () => {
    const clashes = [
        { type: 'student', with: {} },
        { type: 'student', with: {} },
        { type: 'room',    with: {} },
    ];
    const labels = clashTypeLabels(clashes);
    assert.equal(labels.filter(l => l === 'student').length, 1);
});

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
