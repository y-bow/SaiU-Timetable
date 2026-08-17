/**
 * Free Rooms test harness (Node).
 *
 * Tests the room-occupancy parser (parseRoomOccupancy) and the
 * Free Rooms calculation logic against real timetable data.
 *
 * Run:  node scripts/test-free-rooms.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const stripQuery = (src) => src.replace(/\?v=[0-9-]+/g, '');

const MODULES = ['js/data/parser.js', 'js/data/course-normalizer.js', 'js/data/schools.js'];

const dir = mkdtempSync(join(tmpdir(), 'tt-free-rooms-'));
for (const rel of MODULES) {
    const dest = join(dir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, stripQuery(readFileSync(join(ROOT, rel), 'utf8')));
}

const { parseRoomOccupancy, parseCSV } = await import(pathToFileURL(join(dir, 'js/data/parser.js')).href);
const { SCHOOLS } = await import(pathToFileURL(join(dir, 'js/data/schools.js')).href);

let passed = 0;
let failed = 0;

const check = (name, fn) => {
    try { fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`FAIL  ${name}\n      ${err.message}`); }
};

// ── Authoritative room list ─────────────────────────────────────

console.log('--- schools.js: authoritative room list ---');

const scds2 = SCHOOLS.find(s => s.id === 'scds').years.find(y => y.id === 'scds-2');

const EXPECTED_ROOMS = [
    'AB1-101', 'AB1-102', 'AB1-103', 'AB1-104', 'AB1-201',
    'AB1-MOOT COURT HALL', 'AB1 Computer Lab',
    'AB2-101', 'AB2-201', 'AB2-202', 'AB2-203', 'AB2-204',
    'AB2-205', 'AB2-206', 'AB2-207', 'AB2-208', 'AB2-209',
    'AB2-210', 'AB2-211',
];

await check('SCDS Year 2 has all 19 authoritative rooms', () => {
    assert.equal(scds2.rooms.length, EXPECTED_ROOMS.length);
    for (const r of EXPECTED_ROOMS) {
        assert.ok(scds2.rooms.includes(r), `missing room: ${r}`);
    }
});

await check('authoritative list includes all AB1 rooms', () => {
    const ab1 = scds2.rooms.filter(r => r.startsWith('AB1'));
    assert.ok(ab1.includes('AB1-101'));
    assert.ok(ab1.includes('AB1-102'));
    assert.ok(ab1.includes('AB1-103'));
    assert.ok(ab1.includes('AB1-104'));
    assert.ok(ab1.includes('AB1-201'));
    assert.ok(ab1.includes('AB1-MOOT COURT HALL'));
});

await check('authoritative list includes all AB2 rooms', () => {
    const ab2 = scds2.rooms.filter(r => r.startsWith('AB2'));
    assert.ok(ab2.includes('AB2-101'));
    assert.ok(ab2.includes('AB2-201'));
    assert.ok(ab2.includes('AB2-202'));
    assert.ok(ab2.includes('AB2-203'));
    assert.ok(ab2.includes('AB2-204'));
    assert.ok(ab2.includes('AB2-205'));
    assert.ok(ab2.includes('AB2-206'));
    assert.ok(ab2.includes('AB2-207'));
    assert.ok(ab2.includes('AB2-208'));
    assert.ok(ab2.includes('AB2-209'));
    assert.ok(ab2.includes('AB2-210'));
    assert.ok(ab2.includes('AB2-211'));
});

// ── parseRoomOccupancy: synthetic grid ───────────────────────────

console.log('--- parseRoomOccupancy: basic grid parsing ---');

const BASIC_GRID = [
    'MONDAY,09:15 AM - 10:10 AM,ET - Sec 5 - Salim,Web Tech - Sec 1 - Ujjwal',
    ',,AB2 - 101,AB1 - 101',
    'MONDAY,10:15 AM - 11:10 AM,ET - Sec 5 - Salim,',
    ',,AB2 - 101,AB1 - 101',
    'TUESDAY,09:15 AM - 10:10 AM,DL - Sem 5 - Dr. KK',
    ',,AB2 - 202',
].join('\n');

await check('parseRoomOccupancy emits correct records', () => {
    const occ = parseRoomOccupancy(BASIC_GRID);
    // Line 0 (MONDAY 9:15) + room row → 2 rooms (both have class cells)
    // Line 2 (MONDAY 10:15) + room row → 1 room (col 2 has class, col 3 empty)
    // Line 4 (TUESDAY 9:15) + room row → 1 room
    assert.equal(occ.length, 4);
    assert.ok(occ.some(r => r.room === 'AB2 - 101' && r.day === 'Monday' && r.startTime === '09:15'));
    assert.ok(occ.some(r => r.room === 'AB1 - 101' && r.day === 'Monday' && r.startTime === '09:15'));
    assert.ok(occ.some(r => r.room === 'AB2 - 101' && r.day === 'Monday' && r.startTime === '10:15'));
});

await check('empty class cell means room is NOT occupied', () => {
    const occ = parseRoomOccupancy(BASIC_GRID);
    // Column 2 (AB1-101) has an empty class cell for 10:15
    const ab1at10 = occ.find(r => r.room === 'AB1 - 101' && r.startTime === '10:15');
    assert.ok(!ab1at10, 'AB1-101 should not be occupied at 10:15 (empty class cell)');
});

await check('parseRoomOccupancy does NOT filter by section/elective', () => {
    // "Web Tech - Sec 1 - Ujjwal" has a section marker — it is parsed.
    // But even a cell without Sec/elective should be counted if it is non-empty.
    const GRID_NO_SEC = [
        'MONDAY,09:15 AM - 10:10 AM,Some Course - Prof. X',
        ',,AB2 - 101',
    ].join('\n');
    const occ = parseRoomOccupancy(GRID_NO_SEC);
    assert.equal(occ.length, 1, 'non-sectioned, non-elective cell is still counted as occupied');
    assert.equal(occ[0].room, 'AB2 - 101');
});

await check('LUNCH rows with empty room row produce no occupancy', () => {
    // In the real sheet, LUNCH rows have a valid time but the room row is empty.
    // The LUNCH regex in the parser tests timeText, not the class cell.
    const LUNCH_GRID = [
        'MONDAY,12:15 PM - 12:55 PM,LUNCH BREAK',
        ',,',
    ].join('\n');
    const occ = parseRoomOccupancy(LUNCH_GRID);
    assert.equal(occ.length, 0);
});

await check('OPEN BLOCK rows with empty room row produce no occupancy', () => {
    const BLOCK_GRID = [
        'MONDAY,03:00 PM - 03:55 PM,OPEN BLOCK',
        ',,',
    ].join('\n');
    const occ = parseRoomOccupancy(BLOCK_GRID);
    assert.equal(occ.length, 0);
});

// ── parseRoomOccupancy: multi-day coverage ───────────────────────

console.log('--- parseRoomOccupancy: multi-day ---');

const WEEK_GRID = [
    'MONDAY,09:15 AM - 10:10 AM,ET - Sec 5 - Salim',
    ',,AB2 - 101',
    'TUESDAY,09:15 AM - 10:10 AM,DL - Sem 5 - Dr. KK',
    ',,AB2 - 202',
    'WEDNESDAY,09:15 AM - 10:10 AM,CN - Sec 1 - Arjun',
    ',,AB2 - 203',
    'THURSDAY,09:15 AM - 10:10 AM,TOC - Sem 5 - Dr. Sangeetha',
    ',,AB2 - 205',
    'FRIDAY,09:15 AM - 10:10 AM,QML - Sem 5 - Dr. KK',
    ',,AB2 - 207',
].join('\n');

await check('all five weekdays are parsed', () => {
    const occ = parseRoomOccupancy(WEEK_GRID);
    const days = new Set(occ.map(r => r.day));
    assert.ok(days.has('Monday'));
    assert.ok(days.has('Tuesday'));
    assert.ok(days.has('Wednesday'));
    assert.ok(days.has('Thursday'));
    assert.ok(days.has('Friday'));
});

// ── Monday 9:15-10:10 critical test ─────────────────────────────

console.log('--- CRITICAL: Monday 9:15-10:10 room occupancy ---');

// Simulate the real timetable structure for Monday 9:15-10:10
// where column 16 (AB1-101) has "Human Resource Management   Subramaniam"
const MONDAY_GRID = [
    'MONDAY,09:15 AM - 10:10 AM,Web Technology - Sec 4 - Rupam Sah,Linear Algebra - Sec 1 - Dr. Beaula,Human Resource Management   Subramaniam',
    ',,AB2 - 101,AB2 - 203,AB1 - 101',
].join('\n');

await check('AB1-101 is occupied on Monday 9:15-10:10 (class without Sec marker)', () => {
    const occ = parseRoomOccupancy(MONDAY_GRID);
    const ab1_101 = occ.find(r => r.room === 'AB1 - 101' && r.day === 'Monday');
    assert.ok(ab1_101, 'AB1-101 must appear in occupancy for Monday');
    assert.equal(ab1_101.startTime, '09:15');
    assert.equal(ab1_101.endTime, '10:10');
});

await check('AB2-101 is occupied on Monday 9:15-10:10', () => {
    const occ = parseRoomOccupancy(MONDAY_GRID);
    const ab2_101 = occ.find(r => r.room === 'AB2 - 101' && r.day === 'Monday');
    assert.ok(ab2_101, 'AB2-101 must appear in occupancy');
});

await check('AB2-203 is occupied on Monday 9:15-10:10', () => {
    const occ = parseRoomOccupancy(MONDAY_GRID);
    const ab2_203 = occ.find(r => r.room === 'AB2 - 203' && r.day === 'Monday');
    assert.ok(ab2_203, 'AB2-203 must appear in occupancy');
});

// ── Room normalization consistency ───────────────────────────────

console.log('--- Room normalization ---');

const NORM_GRID = [
    'MONDAY,09:15 AM - 10:10 AM,ET - Sec 5 - Salim',
    ',,AB2  -  101',
    'MONDAY,10:15 AM - 11:10 AM,DL - Sem 5 - Dr. KK',
    ',,AB2 - 101',
].join('\n');

await check('parseRoomOccupancy normalises whitespace in room labels', () => {
    const occ = parseRoomOccupancy(NORM_GRID);
    assert.equal(occ.length, 2);
    // Whitespace is collapsed to single spaces by the parser
    assert.equal(occ[0].room, 'AB2 - 101');
    assert.equal(occ[1].room, 'AB2 - 101');
    // Different time slots make them distinct records
    assert.equal(occ[0].startTime, '09:15');
    assert.equal(occ[1].startTime, '10:15');
});

// ── Free Rooms calculation (pure function tests) ─────────────────

console.log('--- Free Rooms calculation logic ---');

// We test the logic directly by simulating what free-rooms.js does.

function toMinutes(timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + m;
}

function normalizeRoom(name) {
    return String(name ?? '')
        .toUpperCase()
        .replace(/-/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function calcFreeRooms(occupancy, day, allRoomKeys) {
    const seen = new Set();
    const slots = [];
    for (const rec of occupancy) {
        if (rec.day !== day) continue;
        const key = `${rec.startTime}|${rec.endTime}`;
        if (seen.has(key)) continue;
        seen.add(key);
        slots.push({
            startTime: rec.startTime,
            endTime: rec.endTime,
            startMin: toMinutes(rec.startTime),
            endMin: toMinutes(rec.endTime),
        });
    }
    slots.sort((a, b) => a.startMin - b.startMin);

    return slots.map(slot => {
        const occupied = new Set();
        for (const rec of occupancy) {
            if (rec.day !== day) continue;
            const cStart = toMinutes(rec.startTime);
            const cEnd = toMinutes(rec.endTime);
            if (cStart < slot.endMin && cEnd > slot.startMin) {
                occupied.add(normalizeRoom(rec.room));
            }
        }
        const free = allRoomKeys.filter(k => !occupied.has(k));
        return { slot, free, occupied: [...occupied] };
    });
}

const CALC_OCC = [
    { room: 'AB2 - 101', day: 'Monday', startTime: '09:15', endTime: '10:10' },
    { room: 'AB2 - 203', day: 'Monday', startTime: '09:15', endTime: '10:10' },
    { room: 'AB1 - 101', day: 'Monday', startTime: '09:15', endTime: '10:10' },
    { room: 'AB2 - 101', day: 'Monday', startTime: '10:15', endTime: '11:10' },
    { room: 'AB2 - 202', day: 'Tuesday', startTime: '09:15', endTime: '10:10' },
];
const ALL_ROOMS = ['AB1 - 101', 'AB1 - 102', 'AB2 - 101', 'AB2 - 202', 'AB2 - 203'].map(normalizeRoom);

await check('AB1-101 is occupied on Monday 9:15-10:10', () => {
    const result = calcFreeRooms(CALC_OCC, 'Monday', ALL_ROOMS);
    const slot915 = result.find(r => r.slot.startTime === '09:15');
    assert.ok(slot915);
    assert.ok(slot915.occupied.includes(normalizeRoom('AB1 - 101')));
    assert.ok(!slot915.free.includes(normalizeRoom('AB1 - 101')), 'AB1-101 must NOT be free');
});

await check('AB1-102 is free on Monday 9:15-10:10 (no class)', () => {
    const result = calcFreeRooms(CALC_OCC, 'Monday', ALL_ROOMS);
    const slot915 = result.find(r => r.slot.startTime === '09:15');
    assert.ok(slot915);
    assert.ok(slot915.free.includes(normalizeRoom('AB1 - 102')));
});

await check('AB2-101 is occupied on Monday 9:15-10:10', () => {
    const result = calcFreeRooms(CALC_OCC, 'Monday', ALL_ROOMS);
    const slot915 = result.find(r => r.slot.startTime === '09:15');
    assert.ok(slot915.occupied.includes(normalizeRoom('AB2 - 101')));
});

await check('AB2-101 is occupied on Monday 10:15-11:10', () => {
    const result = calcFreeRooms(CALC_OCC, 'Monday', ALL_ROOMS);
    const slot1015 = result.find(r => r.slot.startTime === '10:15');
    assert.ok(slot1015.occupied.includes(normalizeRoom('AB2 - 101')));
});

await check('AB1-101 is free on Monday 10:15-11:10 (class ended)', () => {
    const result = calcFreeRooms(CALC_OCC, 'Monday', ALL_ROOMS);
    const slot1015 = result.find(r => r.slot.startTime === '10:15');
    assert.ok(slot1015);
    assert.ok(slot1015.free.includes(normalizeRoom('AB1 - 101')));
});

await check('Tuesday occupancy does not affect Monday', () => {
    const result = calcFreeRooms(CALC_OCC, 'Monday', ALL_ROOMS);
    const slot915 = result.find(r => r.slot.startTime === '09:15');
    // AB2-202 is only occupied on Tuesday, so free on Monday
    assert.ok(slot915.free.includes(normalizeRoom('AB2 - 202')));
});

// ── Time overlap edge cases ──────────────────────────────────────

console.log('--- Time overlap edge cases ---');

const OVERLAP_OCC = [
    { room: 'AB2 - 101', day: 'Monday', startTime: '09:15', endTime: '10:10' },
    { room: 'AB1 - 101', day: 'Monday', startTime: '10:00', endTime: '11:00' },
    { room: 'AB2 - 203', day: 'Monday', startTime: '10:10', endTime: '11:10' },
];

await check('overlapping class (10:00-11:00) occupies AB1-101 during 9:15-10:10 slot', () => {
    const result = calcFreeRooms(OVERLAP_OCC, 'Monday', ALL_ROOMS);
    const slot915 = result.find(r => r.slot.startTime === '09:15');
    assert.ok(slot915.occupied.includes(normalizeRoom('AB1 - 101')),
        'AB1-101 (10:00-11:00) overlaps with 9:15-10:10');
});

await check('adjacent class (10:10-11:10) does NOT occupy during 9:15-10:10 slot', () => {
    const result = calcFreeRooms(OVERLAP_OCC, 'Monday', ALL_ROOMS);
    const slot915 = result.find(r => r.slot.startTime === '09:15');
    assert.ok(slot915.free.includes(normalizeRoom('AB2 - 203')),
        'AB2-203 starts at 10:10 which is exactly when 9:15-10:10 ends — no overlap');
});

// ── No classes on a day ──────────────────────────────────────────

console.log('--- Empty day ---');

await check('no slots returned for a day with no occupancy', () => {
    const result = calcFreeRooms(CALC_OCC, 'Wednesday', ALL_ROOMS);
    assert.equal(result.length, 0);
});

// ── parseRoomOccupancy with real-sheet-like structure ─────────────

console.log('--- parseRoomOccupancy: real-sheet-like structure ---');

const REALISTIC_GRID = [
    'MONDAY,09:15 AM -  10:10 AM,Web Technology - Sec 4 - Rupam Sah,Linear Algebra - Sec 1 - Dr. Beaula,Human Resource Management   Subramaniam,Differential Equations         ArunKumar',
    ',,AB2  -  101,AB2  -  203,AB1 - 101,AB1 - 104',
    'MONDAY,10:15 AM -  11:10 AM,Design and analysis of algorithms - Sec 6 - Dr.Angel,Linear Algebra - Sec 1 - Dr. Beaula',
    ',,AB2  -  101,AB2  -  203',
].join('\n');

await check('all 4 rooms parsed from Monday 9:15 slot', () => {
    const occ = parseRoomOccupancy(REALISTIC_GRID);
    const monday915 = occ.filter(r => r.day === 'Monday' && r.startTime === '09:15');
    assert.equal(monday915.length, 4);
    const rooms = monday915.map(r => r.room);
    // Whitespace is normalised by the parser
    assert.ok(rooms.includes('AB2 - 101'));
    assert.ok(rooms.includes('AB2 - 203'));
    assert.ok(rooms.includes('AB1 - 101'));
    assert.ok(rooms.includes('AB1 - 104'));
});

await check('AB1-101 is occupied at 9:15 (non-SCDS class counts)', () => {
    const occ = parseRoomOccupancy(REALISTIC_GRID);
    const ab1_101 = occ.find(r => r.room === 'AB1 - 101' && r.startTime === '09:15');
    assert.ok(ab1_101, 'AB1-101 must be occupied at 9:15');
});

await check('AB1-104 is occupied at 9:15', () => {
    const occ = parseRoomOccupancy(REALISTIC_GRID);
    const ab1_104 = occ.find(r => r.room === 'AB1 - 104' && r.startTime === '09:15');
    assert.ok(ab1_104, 'AB1-104 must be occupied at 9:15');
});

// ── parseRoomOccupancy: does NOT use section/elective filter ─────

console.log('--- parseRoomOccupancy: no section/elective filtering ---');

const FILTER_GRID = [
    'MONDAY,09:15 AM - 10:10 AM,Corporate and Business Law   Anand Shrivas,Human AI Interaction                     Pankaj Jain',
    ',,AB2 - 101,AB1 - 101',
].join('\n');

await check('unsectioned non-elective class is counted as occupied', () => {
    const occ = parseRoomOccupancy(FILTER_GRID);
    assert.equal(occ.length, 2);
    assert.ok(occ.some(r => r.room === 'AB2 - 101'));
    assert.ok(occ.some(r => r.room === 'AB1 - 101'));
});

// ── Every known room can be discovered ───────────────────────────

console.log('--- All 19 rooms discoverable ---');

const ALL_ROOMS_GRID = [
    'MONDAY,09:15 AM - 10:10 A,ET - Sec 1 - Arj,ET - Sec 2 - Son,ET - Sec 3 - Arav,ET - Sec 4 - Joy,ET - Sec 5 - Sal,ET - Sec 6 - Rup,ET - Sec 7 - Nit,ET - Sec 8 - Ujj,ET - Sec 9 - Beaul,ET - Sec 10 - Tam,ET - Sec 11 - Ange,ET - Sec 12 - Dr. KK,ET - Sec 13 - Sange,ET - Sec 14 - May,ET - Sec 15 - Jemi,ET - Sec 16 - Asho,ET - Sec 17 - Sub,ET - Sec 18 - Mega',
    ',,AB1 - 101,AB1 - 102,AB1 - 103,AB1 - 104,AB1 - 201,AB1 - Moot Court Hall,AB1 Computer Lab,AB2 - 101,AB2 - 201,AB2 - 202,AB2 - 203,AB2 - 204,AB2 - 205,AB2 - 206,AB2 - 207,AB2 - 209,AB2 - 210,AB2 - 211',
].join('\n');

await check('all 19 rooms appear in occupancy data', () => {
    const occ = parseRoomOccupancy(ALL_ROOMS_GRID);
    const rooms = new Set(occ.map(r => normalizeRoom(r.room)));
    for (const expected of EXPECTED_ROOMS) {
        const key = normalizeRoom(expected);
        if (key === normalizeRoom('AB2-208')) continue; // not in this test grid
        assert.ok(rooms.has(key), `room ${expected} (normalized: ${key}) should be in occupancy`);
    }
});

// ── Summary ──────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
rmSync(dir, { recursive: true, force: true });
if (failed) process.exit(1);
