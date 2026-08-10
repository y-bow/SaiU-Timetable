/**
 * Generic smart change detection for normalized timetable records.
 *
 * COMPARE CLASSES, NOT SPREADSHEET CELLS.
 *
 * Every school's parser produces normalized class records
 * (day, subject, faculty, room, section, startTime, endTime, [elective],
 * [source]). This module compares two versions of those records — the
 * previously fetched timetable vs the latest successfully fetched timetable —
 * and reports how each class changed:
 *
 *   added         a class that did not exist before
 *   removed       a class that no longer exists (cancelled)
 *   moved         the same class at a new day and/or time
 *   room-changed  the same class in a new room
 *   modified      the same class with some other property changed
 *   no-change     the identical class with identical properties
 *
 * Class identity is built ONLY from stable properties: course (subject),
 * elective, section, faculty, source. Mutable properties — day, startTime,
 * endTime, room — never change a class's identity, so a class that moves to
 * another cell, room, time, or day is recognised as the SAME class (moved /
 * room-changed), never as removed + unrelated added.
 *
 * The detector is intentionally school-agnostic: it consumes the normalized
 * output of any school-specific parser (SCDS grid, SCDS room-scoped, lab
 * lists, SOAI/SOB list). No SCDS-specific room/column logic lives here.
 */

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

// True for flat Emerging Tools Lab records. Their identity is keyed by
// subject/elective/section/source ONLY — the lab teacher is a mutable property,
// so the university can swap instructors (or move the class in time/room)
// without the offering changing. The lab section is the stable identifier.
// All other classes keep faculty in their identity, as before.
function isEmergingToolsLab(c) {
    return norm(c.source) === 'emerging-tools-lab';
}

/**
 * Room comparison key. Hyphens and spaces are treated the same, so
 * "AB1 Computer Lab" and "AB1-COMPUTER LAB" compare equal, while "TBA" and
 * "AB1 Computer Lab" are DISTINCT room values.
 */
export function normalizeRoom(room) {
    const s = String(room ?? '').replace(/\s+/g, ' ').trim();
    return s.toUpperCase().replace(/-/g, ' ').replace(/\s+/g, ' ');
}

const toMinutes = (t) => {
    const [h, m] = String(t ?? '0:00').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
};

const DAY_ORDER = Object.fromEntries(
    ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY']
        .map((d, i) => [norm(d), i])
);

/**
 * Stable identity of one class. Mutable properties (day, time, room) are
 * deliberately excluded so a moved class keeps its identity. Multi-offering
 * events are flattened by the caller: each offering carries its own
 * section/faculty and therefore its own identity.
 *
 * Emerging Tools Lab records are the one exception: their faculty is excluded
 * too, because the lab teacher is an interchangeable property of the section
 * (see isEmergingToolsLab). A teacher swap must never fragment the section's
 * history into removed + added — it is the same class, reported as modified.
 */
export function classIdentity(c) {
    const parts = [c.subject, c.elective ?? '', c.section ?? ''];
    if (!isEmergingToolsLab(c)) parts.push(c.faculty);
    parts.push(c.source ?? '');
    return parts.map(norm).join('|');
}

/**
 * Flatten multi-offering elective events into per-offering records so change
 * detection sees one comparable class per offering. Flat classes pass through.
 */
export function flattenClasses(classes) {
    const out = [];
    for (const c of classes || []) {
        if (c.offerings && c.offerings.length > 1) {
            for (const o of c.offerings) {
                out.push({
                    ...c,
                    _offering: o,
                    faculty: o.faculty,
                    room: o.room,
                    section: o.section,
                });
            }
        } else {
            out.push(c);
        }
    }
    return out;
}

// Deterministic order for pairing repeated meetings of one identity: by day,
// then start time, then section. Never by room or cell.
function stableSort(list) {
    return [...list].sort((a, b) => {
        const da = DAY_ORDER[norm(a.day)] ?? 0;
        const db = DAY_ORDER[norm(b.day)] ?? 0;
        if (da !== db) return da - db;
        const t = toMinutes(a.startTime) - toMinutes(b.startTime);
        if (t !== 0) return t;
        return (a.section ?? 0) - (b.section ?? 0);
    });
}

/**
 * Compare two normalized class lists and report every change.
 *
 * @param {Array<object>} oldClasses previously parsed timetable
 * @param {Array<object>} newClasses latest successfully parsed timetable
 * @returns {{
 *   changes: Array<object>,
 *   roomMap: Record<string, {room: string, originalRoom: string|null}>
 * }}
 *   changes: one record per matched/pair/added/removed class with
 *     { type, identity, oldClass?, class?, oldRoom?, newRoom?, moved? }
 *   roomMap: identity → the latest room + the room it was changed from
 *     (originalRoom null when the room is unchanged or brand new).
 *     Consumed by the app to badge resolved elective offerings.
 */
export function compareTimetables(oldClasses, newClasses) {
    const oldFlat = flattenClasses(oldClasses || []);
    const newFlat = flattenClasses(newClasses || []);

    const group = (list) => {
        const m = new Map();
        for (const c of list) {
            const id = classIdentity(c);
            if (!m.has(id)) m.set(id, []);
            m.get(id).push(c);
        }
        for (const [id, arr] of m) m.set(id, stableSort(arr));
        return m;
    };

    const oldById = group(oldFlat);
    const newById = group(newFlat);

    const changes = [];
    const roomMap = {};
    const seenNew = new Set();

    const registerRoom = (identity, newC, oldC, roomChanged) => {
        if (!newC.room) return;
        roomMap[identity] = {
            room: newC.room,
            originalRoom: roomChanged ? (oldC && oldC.room) || '' : null,
        };
    };

    // Classes present in BOTH versions: pair in stable order and classify.
    for (const [identity, newList] of newById) {
        const oldList = oldById.get(identity);
        if (!oldList) continue;

        const pairs = Math.max(newList.length, oldList.length);
        for (let i = 0; i < pairs; i++) {
            const n = newList[i];
            const o = oldList[i];
            if (o && n) {
                const rec = classify(o, n);
                rec.identity = identity;
                rec.oldClass = o;
                rec.class = n;
                if (rec.type !== 'no-change') changes.push(rec);
                registerRoom(identity, n, o, rec.type === 'room-changed');
                seenNew.add(n);
            } else if (n) {
                changes.push({ type: 'added', identity, class: n });
                registerRoom(identity, n, null, false);
                seenNew.add(n);
            } else {
                changes.push({ type: 'removed', identity, oldClass: o });
            }
        }
    }

    // Classes only in the NEW version: added.
    for (const [identity, newList] of newById) {
        if (oldById.has(identity)) continue;
        for (const n of newList) {
            if (seenNew.has(n)) continue;
            changes.push({ type: 'added', identity, class: n });
            registerRoom(identity, n, null, false);
        }
    }

    // Classes only in the OLD version: removed.
    for (const [identity, oldList] of oldById) {
        if (newById.has(identity)) continue;
        for (const o of oldList) {
            changes.push({ type: 'removed', identity, oldClass: o });
        }
    }

    return { changes, roomMap };
}

function classify(oldC, newC) {
    const changedProps = [];
    let roomChanged = false;

    const oRoom = normalizeRoom(oldC.room);
    const nRoom = normalizeRoom(newC.room);
    // A room is a mutable property; a non-empty room that differs is a
    // change. Placeholder rooms like "TBA" are distinct values too, so
    // TBA → a real room is reported as a room change.
    if (oRoom && nRoom && oRoom !== nRoom) {
        roomChanged = true;
        changedProps.push('room');
    }

    const dayChanged = norm(oldC.day) !== norm(newC.day);
    const timeChanged =
        norm(oldC.startTime) !== norm(newC.startTime) ||
        norm(oldC.endTime) !== norm(newC.endTime);
    if (dayChanged || timeChanged) changedProps.push('day', 'time');

    // Emerging Tools Lab: the teacher is a mutable property — swapping the lab
    // instructor is a modified class, never a removed + added pair. Day, time
    // and room are already handled as mutable above.
    if (isEmergingToolsLab(oldC) || isEmergingToolsLab(newC)) {
        if (norm(oldC.faculty) !== norm(newC.faculty)) changedProps.push('faculty');
    }

    if (changedProps.length === 0) return { type: 'no-change', changedProps };
    if (roomChanged && changedProps.length === 1) {
        return { type: 'room-changed', changedProps, oldRoom: oldC.room, newRoom: newC.room };
    }
    if (dayChanged || timeChanged) {
        return {
            type: 'moved',
            changedProps,
            roomChanged,
            oldRoom: roomChanged ? oldC.room : null,
            newRoom: roomChanged ? newC.room : null,
            moved: { oldDay: oldC.day, newDay: newC.day, oldStartTime: oldC.startTime, newStartTime: newC.startTime },
        };
    }
    // Same slot, same room, same identity — defensive catch-all. With day,
    // time and room already covered above and the remaining identity props
    // (subject/elective/section/faculty/source) equal by definition, this is
    // currently unreachable; kept as a fallback classification.
    return { type: 'modified', changedProps };
}
