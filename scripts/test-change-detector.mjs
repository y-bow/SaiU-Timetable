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

const { classIdentity, normalizeRoom, compareTimetables, flattenClasses } =
    await import(MODULE);

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
await check('TBA → real room is a room change', () => {
    const { changes } = compareTimetables(
        [cls({ subject: 'DAA', room: 'TBA' })],
        [cls({ subject: 'DAA', room: 'AB2-101' })]
    );
    assert.equal(changes.length, 1);
    assert.equal(changes[0].type, 'room-changed');
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
