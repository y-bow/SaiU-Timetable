/**
 * Smart change detector test harness (Node).
 *
 * Covers the generic change detector (js/data/change-detector.js):
 *   identity   → built only from stable props (subject, elective, section,
 *                faculty, source); day/time/room are deliberately excluded so
 *                a moved class keeps its identity.
 *   normalizeRoom → "AB1 Computer Lab" ≡ "AB1-COMPUTER LAB", but a real room
 *                is DISTINCT from a TBA placeholder.
 *   compareTimetables →
 *     - identical classes produce no changes;
 *     - added / removed classes are reported once each;
 *     - a class that moves day/time is 'moved' (never removed + unrelated
 *       added);
 *     - a class in a new room is 'room-changed' (badge metadata);
 *     - a same-slot change in another property (faculty) is 'modified';
 *     - multi-offering elective events flatten per offering so each offering
 *       is compared on its own faculty/section;
 *     - repeated meetings of one identity pair in stable order (day, time,
 *       section) — never by room/cell;
 *     - roomMap records identity → latest room + originalRoom (null when the
 *       room is new or unchanged).
 *
 * Run:  node scripts/test-change-detector.mjs
 */

import assert from 'node:assert/strict';

const MODULE = new URL('../js/data/change-detector.js', import.meta.url);

const {
    classIdentity, normalizeRoom, compareTimetables, flattenClasses,
    setChangeDetectorDebug, isUnknownValue, isKnownValue, isKnownRoomValue, isKnownTimeRange,
} = await import(MODULE);

let passed = 0;
let failed = 0;

const check = (name, fn) => {
    try { fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`FAIL  ${name}\n      ${err.message}`); }
};

const cls = (o) => ({
    day: 'Monday', subject: 'DAA', faculty: 'Prof A', room: 'AB2-101',
    startTime: '09:00', endTime: '09:55', ...o,
});

// A flat Emerging Tools Lab class. The lab SECTION is the stable identity;
// the teacher/room/time/day are mutable properties.
const lab = (o = {}) => ({
    day: 'Monday', subject: 'Emerging Tools Lab', faculty: 'Prof. Sonar',
    room: 'AB1 - Computer Lab', section: 3, startTime: '15:00', endTime: '17:00',
    elective: 'emerging-tools-and-applications', lab: true, source: 'emerging-tools-lab',
    ...o,
});

console.log('--- identity ---');
await check('identity is stable across a room/time/day move', () => {
    const a = cls({ day: 'Monday', room: 'AB2-101', startTime: '09:00' });
    const b = cls({ day: 'Wednesday', room: 'AB2-205', startTime: '14:00' });
    assert.equal(classIdentity(a), classIdentity(b));
});
await check('identity distinguishes section', () => {
    assert.notEqual(classIdentity(cls({ section: 1 })), classIdentity(cls({ section: 2 })));
});
await check('identity distinguishes faculty', () => {
    assert.notEqual(classIdentity(cls({ faculty: 'Prof A' })), classIdentity(cls({ faculty: 'Prof B' })));
});
await check('identity distinguishes elective tag', () => {
    assert.notEqual(classIdentity(cls({ subject: 'Emerging Tools' })), classIdentity(cls({ subject: 'Emerging Tools', elective: 'emerging-tools-and-applications' })));
});
await check('identity distinguishes source', () => {
    assert.notEqual(classIdentity(cls({ source: 'daa-lab' })), classIdentity(cls()));
});
await check('identity is whitespace/case insensitive', () => {
    assert.equal(classIdentity(cls({ subject: 'DAA' })), classIdentity(cls({ subject: ' daa ' })));
});

console.log('--- normalizeRoom ---');
await check('hyphen-dash + case folding makes rooms equal', () => {
    assert.equal(normalizeRoom('AB1 Computer Lab'), normalizeRoom('AB1-COMPUTER LAB'));
});
await check('a placeholder TBA room is distinct from a real room', () => {
    assert.notEqual(normalizeRoom('TBA'), normalizeRoom('AB1 Computer Lab'));
});

console.log('--- unknown / invalid value helpers ---');
await check('isUnknownValue flags null, undefined, empty, whitespace, "null", "undefined"', () => {
    for (const bad of [null, undefined, '', '   ', 'null', 'NULL', 'undefined', '  undefined  ']) {
        assert.ok(isUnknownValue(bad), JSON.stringify(bad));
    }
    for (const good of ['AB1', 'AB1 Computer Lab', 'CR-201', '15:00', 0, false]) {
        assert.ok(isKnownValue(good), JSON.stringify(good));
    }
});
await check('isKnownRoomValue keeps real rooms valid', () => {
    for (const room of ['AB1', 'AB1 Computer Lab', 'CR-201']) {
        assert.ok(isKnownRoomValue(room), room);
    }
});
await check('isKnownRoomValue treats TBA-family placeholders as unknown unless confirmed', () => {
    for (const bad of ['TBA', 'TBA ', 'tba', 'TBD', 'To be announced', 'N/A', 'Room TBA']) {
        assert.equal(isKnownRoomValue(bad), false, bad);
    }
    assert.ok(isKnownRoomValue('TBA', true));
    assert.ok(isKnownRoomValue('TBA', false) === false);
});
await check('isKnownTimeRange requires both start and end', () => {
    assert.equal(isKnownTimeRange({ startTime: '14:00', endTime: '14:55' }), true);
    assert.equal(isKnownTimeRange({ startTime: undefined, endTime: '14:55' }), false);
    assert.equal(isKnownTimeRange({ startTime: '14:00', endTime: '' }), false);
    assert.equal(isKnownTimeRange({}), false);
});

console.log('--- compareTimetables: same classes ---');
await check('identical timetables produce no changes', () => {
    const a = [cls({ subject: 'DAA' }), cls({ subject: 'FDE', day: 'Tuesday' })];
    const { changes } = compareTimetables(a, a);
    assert.deepEqual(changes, []);
});
await check('repeated meetings of one identity are stable, no phantom changes', () => {
    const a = [
        cls({ subject: 'DAA', section: 1, day: 'Monday', startTime: '09:00', room: 'AB2-101' }),
        cls({ subject: 'DAA', section: 1, day: 'Wednesday', startTime: '11:15', room: 'AB2-102' }),
    ];
    const b = [
        cls({ subject: 'DAA', section: 1, day: 'Wednesday', startTime: '11:15', room: 'AB2-102' }),
        cls({ subject: 'DAA', section: 1, day: 'Monday', startTime: '09:00', room: 'AB2-101' }),
    ];
    const { changes } = compareTimetables(a, b);
    assert.deepEqual(changes, []);
});

console.log('--- compareTimetables: added / removed ---');
await check('a new class is reported as added', () => {
    const { changes } = compareTimetables([cls({ subject: 'DAA' })], [cls({ subject: 'DAA' }), cls({ subject: 'FDE' })]);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].type, 'added');
    assert.equal(changes[0].class.subject, 'FDE');
});
await check('a dropped class is reported as removed', () => {
    const { changes } = compareTimetables([cls({ subject: 'DAA' }), cls({ subject: 'FDE' })], [cls({ subject: 'DAA' })]);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].type, 'removed');
    assert.equal(changes[0].oldClass.subject, 'FDE');
});

console.log('--- compareTimetables: moved / room-changed / modified ---');
await check('a day/time move keeps identity and is reported as moved', () => {
    const { changes } = compareTimetables(
        [cls({ subject: 'DAA', day: 'Monday', startTime: '09:00' })],
        [cls({ subject: 'DAA', day: 'Wednesday', startTime: '14:00' })]
    );
    assert.equal(changes.length, 1);
    assert.equal(changes[0].type, 'moved');
    assert.equal(changes[0].moved.oldDay, 'Monday');
    assert.equal(changes[0].moved.newStartTime, '14:00');
    assert.ok(!changes.some((c) => c.type === 'removed' || c.type === 'added'));
});
await check('a room change is reported as room-changed with old/new rooms', () => {
    const { changes } = compareTimetables(
        [cls({ subject: 'DAA', room: 'AB2-101' })],
        [cls({ subject: 'DAA', room: 'AB2-205' })]
    );
    assert.equal(changes.length, 1);
    assert.equal(changes[0].type, 'room-changed');
    assert.equal(changes[0].oldRoom, 'AB2-101');
    assert.equal(changes[0].newRoom, 'AB2-205');
});
await check('a faculty change is a new identity (removed + added), not modified', () => {
    // Faculty is part of class identity, so a different professor is a
    // different class — never a silent mutation of the same one.
    const { changes } = compareTimetables(
        [cls({ subject: 'DAA', faculty: 'Prof A' })],
        [cls({ subject: 'DAA', faculty: 'Prof Arain' })]
    );
    assert.equal(changes.length, 2);
    const types = changes.map((c) => c.type).sort();
    assert.deepEqual(types, ['added', 'removed']);
});
await check('TBA → real room is NOT a room change (incomplete value)', () => {
    const { changes } = compareTimetables(
        [cls({ subject: 'DAA', room: 'TBA' })],
        [cls({ subject: 'DAA', room: 'AB2-101' })]
    );
    assert.equal(changes.length, 0);
});
await check('a parser-confirmed TBA room change is still reported', () => {
    const { changes } = compareTimetables(
        [cls({ subject: 'DAA', room: 'TBA', roomConfirmed: true })],
        [cls({ subject: 'DAA', room: 'AB2-101' })]
    );
    assert.equal(changes.length, 1);
    assert.equal(changes[0].type, 'room-changed');
    assert.equal(changes[0].oldRoom, 'TBA');
    assert.equal(changes[0].newRoom, 'AB2-101');
});

console.log('--- invalid/incomplete comparisons (first safety layer) ---');
await check('AB2 → AB1 is a real room change', () => {
    const { changes } = compareTimetables(
        [cls({ subject: 'DAA', room: 'AB2' })],
        [cls({ subject: 'DAA', room: 'AB1' })]
    );
    assert.equal(changes.length, 1);
    assert.equal(changes[0].type, 'room-changed');
    assert.equal(changes[0].oldRoom, 'AB2');
    assert.equal(changes[0].newRoom, 'AB1');
});
await check('AB2 → undefined is not a room change', () => {
    const { changes } = compareTimetables(
        [cls({ subject: 'DAA', room: 'AB2' })],
        [cls({ subject: 'DAA', room: undefined })]
    );
    assert.equal(changes.length, 0);
});
await check('undefined → AB1 is not a room change', () => {
    const { changes } = compareTimetables(
        [cls({ subject: 'DAA', room: undefined })],
        [cls({ subject: 'DAA', room: 'AB1' })]
    );
    assert.equal(changes.length, 0);
});
await check('AB2 → "" is not a room change', () => {
    const { changes } = compareTimetables(
        [cls({ subject: 'DAA', room: 'AB2' })],
        [cls({ subject: 'DAA', room: '' })]
    );
    assert.equal(changes.length, 0);
});
await check('TBA → AB1 is not a room change', () => {
    const { changes } = compareTimetables(
        [cls({ subject: 'DAA', room: 'TBA' })],
        [cls({ subject: 'DAA', room: 'AB1' })]
    );
    assert.equal(changes.length, 0);
});
await check('every unknown room form is ignored in both directions', () => {
    const bads = [null, undefined, '', '   ', 'null', 'undefined', 'NULL'];
    for (const bad of bads) {
        const toReal = compareTimetables(
            [cls({ subject: 'DAA', room: bad })],
            [cls({ subject: 'DAA', room: 'AB1' })]
        );
        assert.equal(toReal.changes.length, 0, `unknown → AB1 with room ${JSON.stringify(bad)}`);
        const fromReal = compareTimetables(
            [cls({ subject: 'DAA', room: 'AB2' })],
            [cls({ subject: 'DAA', room: bad })]
        );
        assert.equal(fromReal.changes.length, 0, `AB2 → unknown with room ${JSON.stringify(bad)}`);
    }
});
await check('valid room formats stay comparable ("AB1", "AB1 Computer Lab", "CR-201")', () => {
    const { changes } = compareTimetables(
        [cls({ subject: 'DAA', room: 'CR-201' })],
        [cls({ subject: 'DAA', room: 'AB1 Computer Lab' })]
    );
    assert.equal(changes.length, 1);
    assert.equal(changes[0].type, 'room-changed');
});
await check('a genuine room change preserves oldRoom and newRoom', () => {
    const { changes } = compareTimetables(
        [cls({ subject: 'DAA', room: 'AB2' })],
        [cls({ subject: 'DAA', room: 'AB1 Computer Lab' })]
    );
    assert.equal(changes.length, 1);
    assert.equal(changes[0].type, 'room-changed');
    assert.equal(changes[0].oldRoom, 'AB2');
    assert.equal(changes[0].newRoom, 'AB1 Computer Lab');
});
await check('14:00–14:55 → 15:00–15:55 is a time change (moved, same day)', () => {
    const { changes } = compareTimetables(
        [cls({ subject: 'DAA', startTime: '14:00', endTime: '14:55' })],
        [cls({ subject: 'DAA', startTime: '15:00', endTime: '15:55' })]
    );
    assert.equal(changes.length, 1);
    assert.equal(changes[0].type, 'moved');
    assert.equal(changes[0].moved.oldDay, 'Monday');
    assert.equal(changes[0].moved.newDay, 'Monday');
});
await check('14:00–14:55 → undefined/undefined is not a time change', () => {
    const { changes } = compareTimetables(
        [cls({ subject: 'DAA', startTime: '14:00', endTime: '14:55' })],
        [cls({ subject: 'DAA', startTime: undefined, endTime: undefined })]
    );
    assert.equal(changes.length, 0);
});
await check('undefined/undefined → 15:00–15:55 is not a time change', () => {
    const { changes } = compareTimetables(
        [cls({ subject: 'DAA', startTime: undefined, endTime: undefined })],
        [cls({ subject: 'DAA', startTime: '15:00', endTime: '15:55' })]
    );
    assert.equal(changes.length, 0);
});
await check('an incomplete side is ignored even when only one time field is missing', () => {
    const partial = compareTimetables(
        [cls({ subject: 'DAA', startTime: '14:00', endTime: '14:55' })],
        [cls({ subject: 'DAA', startTime: '15:00', endTime: undefined })]
    );
    assert.equal(partial.changes.length, 0);
    const empty = compareTimetables(
        [cls({ subject: 'DAA', startTime: '', endTime: '' })],
        [cls({ subject: 'DAA', startTime: '15:00', endTime: '15:55' })]
    );
    assert.equal(empty.changes.length, 0);
});
await check('AB2 → AB1 Computer Lab with a new time emits room-changed AND moved records', () => {
    const { changes } = compareTimetables(
        [cls({ subject: 'DAA', room: 'AB2', startTime: '14:00', endTime: '14:55' })],
        [cls({ subject: 'DAA', room: 'AB1 Computer Lab', startTime: '15:00', endTime: '15:55' })]
    );
    assert.equal(changes.length, 2, 'room and time are two independent changes');
    const room = changes.find((c) => c.type === 'room-changed');
    const moved = changes.find((c) => c.type === 'moved');
    assert.ok(room, 'a room change is never flattened into moved');
    assert.equal(room.oldRoom, 'AB2');
    assert.equal(room.newRoom, 'AB1 Computer Lab');
    assert.ok(moved);
    assert.equal(moved.moved.oldStartTime, '14:00');
    assert.equal(moved.moved.oldEndTime, '14:55');
    assert.equal(moved.moved.newStartTime, '15:00');
    assert.equal(moved.moved.newEndTime, '15:55');
});
await check('a lab room+faculty change emits room-changed AND modified (room change not swallowed)', () => {
    const { changes } = compareTimetables(
        [lab({ room: 'AB2-101', faculty: 'Prof. Old' })],
        [lab({ room: 'AB1-205', faculty: 'Prof. New' })]
    );
    assert.equal(changes.length, 2);
    const types = changes.map((c) => c.type).sort();
    assert.deepEqual(types, ['modified', 'room-changed']);
    const room = changes.find((c) => c.type === 'room-changed');
    assert.equal(room.oldRoom, 'AB2-101');
    assert.equal(room.newRoom, 'AB1-205');
});
await check('a genuine time change preserves all four time fields', () => {
    const { changes } = compareTimetables(
        [cls({ subject: 'DAA', startTime: '14:00', endTime: '14:55' })],
        [cls({ subject: 'DAA', startTime: '15:00', endTime: '15:55' })]
    );
    const m = changes[0].moved;
    assert.equal(m.oldStartTime, '14:00');
    assert.equal(m.oldEndTime, '14:55');
    assert.equal(m.newStartTime, '15:00');
    assert.equal(m.newEndTime, '15:55');
});
await check('a valid day move still reports moved (day/time change survives, becomes time_changed)', () => {
    const { changes } = compareTimetables(
        [cls({ subject: 'DAA', day: 'Monday', startTime: '09:00', endTime: '09:55' })],
        [cls({ subject: 'DAA', day: 'Wednesday', startTime: '09:00', endTime: '09:55' })]
    );
    assert.equal(changes.length, 1);
    assert.equal(changes[0].type, 'moved');
    assert.equal(changes[0].moved.oldDay, 'Monday');
    assert.equal(changes[0].moved.newDay, 'Wednesday');
});
await check('added / removed / modified are not suppressed by missing room/time', () => {
    const added = compareTimetables([], [cls({ subject: 'DAA', room: undefined, startTime: undefined, endTime: undefined })]);
    assert.equal(added.changes.length, 1);
    assert.equal(added.changes[0].type, 'added');

    const removed = compareTimetables([cls({ subject: 'DAA', room: undefined, startTime: undefined, endTime: undefined })], []);
    assert.equal(removed.changes.length, 1);
    assert.equal(removed.changes[0].type, 'removed');

    const modified = compareTimetables(
        [cls({ subject: 'Emerging Tools Lab', source: 'emerging-tools-lab', faculty: 'Prof. Old', room: undefined, startTime: undefined, endTime: undefined })],
        [cls({ subject: 'Emerging Tools Lab', source: 'emerging-tools-lab', faculty: 'Prof. New', room: undefined, startTime: undefined, endTime: undefined })]
    );
    assert.equal(modified.changes.length, 1);
    assert.equal(modified.changes[0].type, 'modified');
});
await check('ignored comparisons are silent unless debug mode is on', () => {
    const orig = console.log;
    const logs = [];
    console.log = (m) => logs.push(m);
    try {
        setChangeDetectorDebug(false);
        compareTimetables([cls({ room: 'AB2' })], [cls({ room: undefined })]);
        assert.equal(logs.length, 0, 'default operation must not log');

        setChangeDetectorDebug(true);
        compareTimetables([cls({ room: 'AB2' })], [cls({ room: undefined })]);
        assert.ok(logs.some((l) => String(l).includes('ignored incomplete room comparison: AB2 → undefined')),
            `expected debug line, got: ${logs.join(' | ')}`);

        logs.length = 0;
        compareTimetables(
            [cls({ startTime: '14:00', endTime: '14:55' })],
            [cls({ startTime: '15:00', endTime: undefined })]
        );
        assert.ok(logs.some((l) => String(l).includes('ignored incomplete time comparison')),
            `expected time debug line, got: ${logs.join(' | ')}`);
    } finally {
        console.log = orig;
        setChangeDetectorDebug(false);
    }
});

console.log('--- Emerging Tools Lab (section identity, mutable teacher) ---');
await check('lab identity is stable across a teacher change', () => {
    assert.equal(classIdentity(lab({ faculty: 'Prof. Sonar' })),
                 classIdentity(lab({ faculty: 'Prof. Aravind' })));
});
await check('lab identity distinguishes the lab section (a real offering change)', () => {
    assert.notEqual(classIdentity(lab({ section: 3 })), classIdentity(lab({ section: 2 })));
});
await check('lab identity stays stable across day/time/room moves', () => {
    assert.equal(classIdentity(lab({ day: 'Monday', room: 'AB2-101', startTime: '15:00' })),
                 classIdentity(lab({ day: 'Wednesday', room: 'AB1-205', startTime: '14:00' })));
});
await check('a lab teacher change is modified, never removed + added', () => {
    const { changes } = compareTimetables(
        [lab({ faculty: 'Prof. Sonar' })],
        [lab({ faculty: 'Prof. Aravind' })]
    );
    assert.equal(changes.length, 1);
    assert.equal(changes[0].type, 'modified');
    assert.deepEqual(changes[0].changedProps, ['faculty']);
});
await check('a lab section change is a genuine offering change (removed + added)', () => {
    const { changes } = compareTimetables(
        [lab({ section: 3 })],
        [lab({ section: 2 })]
    );
    assert.equal(changes.length, 2);
    const types = changes.map((c) => c.type).sort();
    assert.deepEqual(types, ['added', 'removed']);
});
await check('lab room/time changes stay the same offering', () => {
    const room = compareTimetables([lab({ room: 'AB2-101' })], [lab({ room: 'AB2-205' })]);
    assert.equal(room.changes.length, 1);
    assert.equal(room.changes[0].type, 'room-changed');
    assert.equal(room.changes[0].newRoom, 'AB2-205');

    const moved = compareTimetables([lab({ startTime: '15:00' })], [lab({ startTime: '16:00' })]);
    assert.equal(moved.changes.length, 1);
    assert.equal(moved.changes[0].type, 'moved');
    assert.equal(moved.changes[0].moved.newStartTime, '16:00');
});
await check('identical lab records produce no changes', () => {
    const { changes } = compareTimetables([lab()], [lab()]);
    assert.deepEqual(changes, []);
});

console.log('--- roomMap ---');
await check('roomMap keeps latest room + original room after a change', () => {
    const id = classIdentity(cls({ subject: 'DAA' }));
    const { roomMap } = compareTimetables(
        [cls({ subject: 'DAA', room: 'AB2-101' })],
        [cls({ subject: 'DAA', room: 'AB2-205' })]
    );
    assert.equal(roomMap[id].room, 'AB2-205');
    assert.equal(roomMap[id].originalRoom, 'AB2-101');
});
await check('roomMap originalRoom is null for an unchanged / new room', () => {
    const id = classIdentity(cls({ subject: 'DAA' }));
    const unchanged = compareTimetables(
        [cls({ subject: 'DAA', room: 'AB2-101' })],
        [cls({ subject: 'DAA', room: 'AB2-101' })]
    ).roomMap;
    const fresh = compareTimetables([], [cls({ subject: 'DAA', room: 'AB2-101' })]).roomMap;
    assert.equal(unchanged[id].originalRoom, null);
    assert.equal(fresh[id].originalRoom, null);
});

console.log('--- multi-offering flattening ---');
await check('flattenClasses turns one multi-offering event into per-offering records', () => {
    const event = cls({
        subject: 'Emerging Tools',
        offerings: [
            { faculty: 'Prof Arjun', section: 1, room: 'AB1-101' },
            { faculty: 'Prof David', section: 2, room: 'AB1-102' },
        ],
    });
    const flat = flattenClasses([event]);
    assert.equal(flat.length, 2);
    assert.ok(new Set(flat.map((f) => f.faculty)).size === 2);
});
await check('a resolved offering whose room changed is detected on its own identity', () => {
    const event = cls({
        subject: 'Emerging Tools',
        offerings: [
            { faculty: 'Prof Arjun', section: 1, room: 'AB1-101' },
            { faculty: 'Prof David', section: 2, room: 'AB1-102' },
        ],
    });
    const moved = cls({
        subject: 'Emerging Tools',
        offerings: [
            { faculty: 'Prof Arjun', section: 1, room: 'AB1-201' },
            { faculty: 'Prof David', section: 2, room: 'AB1-102' },
        ],
    });
    // Raw events (not pre-flattened): compareTimetables flattens internally.
    const { changes } = compareTimetables([event], [moved]);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].type, 'room-changed');
    assert.equal(changes[0].newRoom, 'AB1-201');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
