/**
 * Timetable Clash Detector.
 *
 * Detects five categories of genuine scheduling conflict from the timetable
 * data currently loaded by the application. The detection is entirely
 * DATA-DRIVEN — no course names, rooms or teachers are hardcoded. A newly
 * added timetable entry participates in clash detection automatically.
 *
 * ─── Clash categories ────────────────────────────────────────────────────────
 *
 *   A. STUDENT     Two classes in the student's own resolved timetable
 *                  overlap in time on the same day.
 *
 *   B. MANDATORY ↔ ELECTIVE  (subset of A)
 *                  A mandatory class and a selected elective overlap.
 *                  Already detected by A because sectionClasses() merges
 *                  mandatory + selected electives before this module runs.
 *
 *   C. ELECTIVE ↔ ELECTIVE  (subset of A)
 *                  Two selected electives overlap. Same reasoning as B.
 *
 *   D. ROOM        Same room + same day + overlapping time in the FULL
 *                  (unfiltered) class list. Indicates a timetable data error.
 *
 *   E. TEACHER     Same teacher + same day + overlapping time in the FULL
 *                  class list. Only when teacher info is reliably present.
 *
 * ─── Time overlap rule ───────────────────────────────────────────────────────
 *
 *   Two slots [sA, eA) and [sB, eB) overlap when:
 *       sA < eB  &&  sB < eA
 *   Touching endpoints (sA === eB or sB === eA) are NOT a clash, matching
 *   back-to-back class conventions in the existing timetable.
 *
 * ─── Safety / bad-data rules ─────────────────────────────────────────────────
 *
 *   - Missing room  → entry never participates in room clash checks.
 *   - Missing teacher → entry never participates in teacher clash checks.
 *   - Missing / unparseable time → entry is skipped for all time comparisons.
 *   - Self-comparison is never performed.
 *   - Legitimate parallel lab sessions (separate sections in the same room)
 *     are NOT room clashes: the same section/elective/subject running in
 *     parallel is excluded from the room-clash bucket.
 *
 * ─── Output ──────────────────────────────────────────────────────────────────
 *
 *   detectClashes() returns shallow copies of every item in studentClasses,
 *   each extended with a `clashes` array:
 *
 *   clashes: [
 *     { type: 'student' | 'room' | 'teacher', with: <other class record> }
 *   ]
 *
 *   Records with no clashes carry an empty `clashes` array (never absent),
 *   so the UI can unconditionally check `c.clashes.length > 0`.
 *
 *   The input arrays are NOT mutated.
 *
 * ─── Architecture ────────────────────────────────────────────────────────────
 *
 *   Raw timetable data (all classes for the year)
 *           ↓
 *   sectionClasses() in app.js  (resolves student context)
 *           ↓
 *   detectClashes(studentClasses, allClasses, yearConfig)  ← this module
 *           ↓
 *   Student classes carry .clashes[] metadata
 *           ↓
 *   buildTimeline() in ui.js renders clash badge when .clashes.length > 0
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse an "HH:MM" time string into total minutes since midnight.
 * Returns NaN for any invalid/missing input.
 */
export function timeToMinutes(timeStr) {
    if (!timeStr || typeof timeStr !== 'string') return NaN;
    const parts = timeStr.split(':');
    if (parts.length !== 2) return NaN;
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;
    return h * 60 + m;
}

/**
 * True when two time intervals overlap (strict interior overlap only).
 * Touching endpoints — e.g. 3:55 and 3:55 — are NOT an overlap.
 *
 * @param {number} sA - start of interval A in minutes
 * @param {number} eA - end   of interval A in minutes
 * @param {number} sB - start of interval B in minutes
 * @param {number} eB - end   of interval B in minutes
 * @returns {boolean}
 */
export function timesOverlap(sA, eA, sB, eB) {
    // Any NaN short-circuits to false — missing times never clash.
    if (!Number.isFinite(sA) || !Number.isFinite(eA) ||
        !Number.isFinite(sB) || !Number.isFinite(eB)) return false;
    // Degenerate (zero-duration) slots are ignored.
    if (eA <= sA || eB <= sB) return false;
    return sA < eB && sB < eA;
}

/**
 * Normalize a string value for grouping: lowercase, collapse internal
 * whitespace, treat hyphens and en-dashes as spaces, trim.
 * Empty / unknown values return '' so they are never grouped together.
 */
function normalizeKey(s) {
    if (s === null || s === undefined) return '';
    const str = String(s).trim();
    if (!str || str.toLowerCase() === 'null' || str.toLowerCase() === 'undefined') return '';
    return str.toLowerCase().replace(/[-–]/g, ' ').replace(/\s+/g, ' ');
}

/**
 * Stable identity for a timetable entry.
 *
 * Two records with the same identity represent the same logical class
 * (even when parsed from different rows/columns), so they should NEVER
 * be reported as clashing with each other.
 *
 * Mirrors the approach in change-detector.js: identity is based on
 * stable properties (subject, elective, section, faculty, source) and
 * NOT on day/time/room, which are mutable.
 *
 * For entries that are legitimate multiple sessions of the same course
 * at different times (e.g. two labs per week), the day+startTime is
 * included in the identity to distinguish the sessions — otherwise
 * Student clash detection would flag a recurring class against itself.
 *
 * NOTE: student-clash comparisons use the FULL identity including time
 * so that two different sessions of the same course are treated as
 * separate entries (they are). The self-comparison guard then prevents
 * false positives within the same session.
 */
export function clashEntryIdentity(c) {
    const subj = normalizeKey(c.subject);
    const elec = normalizeKey(c.elective || '');
    const sec  = String(c.section ?? '');
    const fac  = normalizeKey(c.faculty || '');
    const src  = normalizeKey(c.source || '');
    const day  = normalizeKey(c.day || '');
    const st   = normalizeKey(c.startTime || '');
    return `${subj}|${elec}|${sec}|${fac}|${src}|${day}|${st}`;
}

/** True when the room field carries a real, known room name. */
function hasKnownRoom(c) {
    return !!normalizeKey(c.room);
}

/** True when the faculty field carries a real, known teacher name. */
function hasKnownFaculty(c) {
    return !!normalizeKey(c.faculty);
}

/**
 * True when two class records represent the same underlying timetable entry.
 * Used to prevent self-comparisons and suppress duplicate-parse false positives.
 */
function isSameEntry(a, b) {
    return clashEntryIdentity(a) === clashEntryIdentity(b);
}

// ─── Core detection ──────────────────────────────────────────────────────────

/**
 * Detect student-context clashes within the resolved class list.
 *
 * @param {Array<object>} studentClasses - already-filtered list (from sectionClasses())
 * @returns {Map<string, Array<{type: string, with: object}>>}
 *   identity → list of clashes for that entry
 */
function detectStudentClashes(studentClasses) {
    const result = new Map();
    const n = studentClasses.length;

    for (let i = 0; i < n; i++) {
        const a = studentClasses[i];
        const idA = clashEntryIdentity(a);
        const sA = timeToMinutes(a.startTime);
        const eA = timeToMinutes(a.endTime);
        const dayA = normalizeKey(a.day);

        for (let j = i + 1; j < n; j++) {
            const b = studentClasses[j];

            // Never compare an entry to itself.
            if (isSameEntry(a, b)) continue;

            // Must be same day.
            if (normalizeKey(b.day) !== dayA) continue;

            const sB = timeToMinutes(b.startTime);
            const eB = timeToMinutes(b.endTime);

            if (!timesOverlap(sA, eA, sB, eB)) continue;

            // Record clash for both A and B.
            const idB = clashEntryIdentity(b);
            if (!result.has(idA)) result.set(idA, []);
            if (!result.has(idB)) result.set(idB, []);
            result.get(idA).push({ type: 'student', with: b });
            result.get(idB).push({ type: 'student', with: a });
        }
    }

    return result;
}

/**
 * Detect room clashes across ALL classes (not just one student's view).
 *
 * Two entries constitute a room clash when they share the same normalized
 * room name, the same day, and their times overlap.
 *
 * Parallel legitimate offerings of the SAME subject/elective/section in the
 * same room (e.g. a shared lecture hall for two sections) are excluded:
 * if two entries share the same normalised subject AND the same elective tag
 * AND the same section number AND the same faculty, they are the same class
 * and not a clash.
 *
 * @param {Array<object>} allClasses
 * @returns {Map<string, Array<{type: string, with: object}>>}
 *   identity → list of room clashes
 */
function detectRoomClashes(allClasses) {
    const result = new Map();

    // Group by (normalizedRoom, normalizedDay).
    const groups = new Map();
    for (const c of allClasses) {
        if (!hasKnownRoom(c)) continue;
        const room = normalizeKey(c.room);
        const day  = normalizeKey(c.day);
        const key  = `${room}||${day}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(c);
    }

    for (const bucket of groups.values()) {
        const n = bucket.length;
        for (let i = 0; i < n; i++) {
            const a = bucket[i];
            const sA = timeToMinutes(a.startTime);
            const eA = timeToMinutes(a.endTime);

            for (let j = i + 1; j < n; j++) {
                const b = bucket[j];

                // Self-comparison guard.
                if (isSameEntry(a, b)) continue;

                // Parallel legitimate sessions: same subject + same elective +
                // same section + same faculty → this is the same class taught
                // to the same audience, not a conflict.
                const sameSubject  = normalizeKey(a.subject)  === normalizeKey(b.subject);
                const sameElective = (a.elective || null)     === (b.elective || null);
                const sameSection  = (a.section  ?? '')       === (b.section  ?? '');
                const sameFaculty  = normalizeKey(a.faculty || '') === normalizeKey(b.faculty || '');
                if (sameSubject && sameElective && sameSection && sameFaculty) continue;

                const sB = timeToMinutes(b.startTime);
                const eB = timeToMinutes(b.endTime);

                if (!timesOverlap(sA, eA, sB, eB)) continue;

                const idA = clashEntryIdentity(a);
                const idB = clashEntryIdentity(b);
                if (!result.has(idA)) result.set(idA, []);
                if (!result.has(idB)) result.set(idB, []);
                result.get(idA).push({ type: 'room', with: b });
                result.get(idB).push({ type: 'room', with: a });
            }
        }
    }

    return result;
}

/**
 * Detect teacher clashes across ALL classes.
 *
 * Two entries constitute a teacher clash when they share the same normalized
 * faculty name, the same day, and their times overlap — and they are not
 * the same underlying entry.
 *
 * Entries with missing/unknown faculty are silently skipped: we never assume
 * two classes share a teacher just because both lack faculty info.
 *
 * @param {Array<object>} allClasses
 * @returns {Map<string, Array<{type: string, with: object}>>}
 */
function detectTeacherClashes(allClasses) {
    const result = new Map();

    // Group by (normalizedFaculty, normalizedDay).
    const groups = new Map();
    for (const c of allClasses) {
        if (!hasKnownFaculty(c)) continue;
        const fac = normalizeKey(c.faculty);
        const day = normalizeKey(c.day);
        const key = `${fac}||${day}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(c);
    }

    for (const bucket of groups.values()) {
        const n = bucket.length;
        for (let i = 0; i < n; i++) {
            const a = bucket[i];
            const sA = timeToMinutes(a.startTime);
            const eA = timeToMinutes(a.endTime);

            for (let j = i + 1; j < n; j++) {
                const b = bucket[j];

                // Self-comparison guard.
                if (isSameEntry(a, b)) continue;

                const sB = timeToMinutes(b.startTime);
                const eB = timeToMinutes(b.endTime);

                if (!timesOverlap(sA, eA, sB, eB)) continue;

                const idA = clashEntryIdentity(a);
                const idB = clashEntryIdentity(b);
                if (!result.has(idA)) result.set(idA, []);
                if (!result.has(idB)) result.set(idB, []);
                result.get(idA).push({ type: 'teacher', with: b });
                result.get(idB).push({ type: 'teacher', with: a });
            }
        }
    }

    return result;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Run full clash detection and return the student's class list with clash
 * metadata attached.
 *
 * Called once per render from app.js → the result drives the UI badge.
 * Never mutates the input arrays; returns shallow copies extended with
 * a `clashes` array.
 *
 * @param {Array<object>} studentClasses
 *   Resolved classes the current student attends (output of sectionClasses()).
 *   These already account for school, program, year, section, elective
 *   selections, lab group, and offering choices.
 *
 * @param {Array<object>} allClasses
 *   The full unfiltered class list for the active year/sheet. Used for
 *   room and teacher clash detection across all student groups.
 *
 * @param {object|null} _yearConfig
 *   The active year config from schools.js. Reserved for future use (e.g.
 *   cross-year elective clash detection). Currently unused — student-context
 *   clash detection is already fully handled by the sectionClasses() filter.
 *
 * @returns {Array<object>}
 *   Shallow copies of studentClasses items, each with:
 *     clashes: Array<{ type: 'student'|'room'|'teacher', with: object }>
 *   An empty array means no clashes (never absent).
 */
export function detectClashes(studentClasses, allClasses, _yearConfig) {
    if (!studentClasses || !studentClasses.length) return [];

    const safeAll = Array.isArray(allClasses) ? allClasses : [];

    // Run all three detectors.
    const studentMap = detectStudentClashes(studentClasses);
    const roomMap    = detectRoomClashes(safeAll);
    const teacherMap = detectTeacherClashes(safeAll);

    // Build output: shallow copy each student class, attach merged clashes.
    return studentClasses.map((c) => {
        const id = clashEntryIdentity(c);

        const clashes = [];

        // Student clashes (already filtered to this student's context).
        for (const clash of (studentMap.get(id) || [])) {
            clashes.push(clash);
        }

        // Room clashes: only attach when the conflicting class is NOT the
        // same record already captured as a student clash (avoids double
        // reporting the same conflict under two labels).
        const studentClashIds = new Set(
            clashes.filter(x => x.type === 'student').map(x => clashEntryIdentity(x.with))
        );
        for (const clash of (roomMap.get(id) || [])) {
            const otherId = clashEntryIdentity(clash.with);
            if (studentClashIds.has(otherId)) continue; // already reported
            clashes.push(clash);
        }

        // Teacher clashes: same dedup strategy.
        const reportedIds = new Set(clashes.map(x => clashEntryIdentity(x.with)));
        for (const clash of (teacherMap.get(id) || [])) {
            const otherId = clashEntryIdentity(clash.with);
            if (reportedIds.has(otherId)) continue;
            clashes.push(clash);
        }

        // Return shallow copy so original records are never mutated.
        return { ...c, clashes };
    });
}

/**
 * Convenience: return only the unique clash types found in a clashes array.
 * Useful for the UI label (e.g. "Room conflict · Time conflict").
 *
 * @param {Array<{type: string, with: object}>} clashes
 * @returns {string[]} unique type strings in deterministic order
 */
export function clashTypeLabels(clashes) {
    if (!clashes || !clashes.length) return [];
    const ORDER = ['student', 'room', 'teacher'];
    const seen = new Set(clashes.map(c => c.type));
    return ORDER.filter(t => seen.has(t));
}
