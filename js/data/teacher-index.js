/**
 * Teacher timetable index.
 *
 * Every parser already attaches a normalized `faculty` name to each class
 * (see normalizeFacultyName in js/data/parser.js — the canonical "Prof. X"
 * display form plus the Dr.K.K.Singh / Dr.Tamilarasi aliases). This module is
 * the single place that turns class records into a teacher-indexed view:
 *
 *     class records → flatten offerings → dedupe → extract teacher(s)
 *                    → resolve identity (js/data/teacher-identity.js) → index
 *
 * Design rules honored here:
 *   - Identity is resolved by js/data/teacher-identity.js: HIGH-confidence
 *     variants ("Prof. Mariya" / "Prof. Dr. Mariya", "Dr. Jemima" / "Jemima",
 *     "Vigneshwaran" / "Vigneswaran") merge into ONE canonical teacher;
 *     MEDIUM-confidence pairs (first-name-only vs full name, phonetic first
 *     name variants) stay separate and surface as confirmation candidates;
 *     LOW pairs stay separate. A teacher's canonical id is the stable key.
 *   - A class may carry MULTIPLE teachers. Combined cells
 *     ("ET - Sec 1 - Arjun, Sonar") split on `,`, `&`, `;`, `/` and " and "
 *     into a `teachers` array; the first name is the primary `teacher`. The
 *     original combined string is preserved as `originalFaculty` — the
 *     class's `faculty` field is never mutated, so change-detection identity
 *     and n8n events are unaffected.
 *   - Classes with no teacher are never indexed (counted as `unassigned` for
 *     debugging). Free periods are never invented.
 *   - Multi-offering elective events are flattened per offering (mirroring
 *     change-detector.js) so each offering's teacher is indexed with that
 *     offering's own section/room.
 *   - ONE ENTRY PER MEETING. A course repeats across the week, so the change
 *     detector's classIdentity (deliberately time/room-agnostic) can NOT be
 *     used to dedupe: "FDE Sec 2 – Mon 12:15" and "FDE Sec 2 – Mon 16:00"
 *     are two different classes on the teacher's week. Records are deduped on
 *     a meeting-level identity (identity + day + time + normalized room), so
 *     the same meeting surfaced by two year configs (e.g. a class the SCDS-2
 *     room scan and the SCDS-3 parse both emit) collapses to ONE entry whose
 *     school/year contexts are merged — while every real meeting survives.
 *
 * Pure module — no window or fetch at import time — so it runs identically
 * in the browser and in the Node test harness. (localStorage reads for the
 * per-browser confirmations are safely no-ops where storage is unavailable.)
 */

import { normalizeFacultyName } from './parser.js?v=2026-09-01-002';
import { classIdentity, flattenClasses } from './change-detector.js?v=2026-09-01-002';
import {
    buildIdentityResolution,
    loadTeacherConfirmations,
    teacherSearchText,
} from './teacher-identity.js?v=2026-09-01-002';

const TEACHER_SPLIT_RE = /\s*(?:[,;/]|\band\b|&)\s*/gi;

// Compare rooms like the parsers do: uppercase, hyphens ≈ spaces.
function normRoom(room) {
    return String(room ?? '')
        .toUpperCase()
        .replace(/-/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Identity of ONE meeting. classIdentity ignores day/time/room on purpose
// (change detection tracks a class across moves); here those fields are what
// keep repeated weekly meetings distinct.
function meetingIdentity(c) {
    return [
        classIdentity(c),
        String(c.day ?? '').trim().toLowerCase(),
        String(c.startTime ?? '').trim().toLowerCase(),
        String(c.endTime ?? '').trim().toLowerCase(),
        normRoom(c.room),
    ].join('|');
}

/**
 * Split a (possibly combined) faculty cell into individual teacher names.
 * Each segment is normalized independently so per-name aliases ("Dr. Tamil
 * mam" inside a combined cell) still resolve. Empty/garbage segments are
 * dropped. A single teacher returns a single-element array.
 */
export function splitTeachers(rawFaculty) {
    const raw = String(rawFaculty ?? '');
    if (!raw.trim()) return [];
    return raw
        .split(TEACHER_SPLIT_RE)
        .map((part) => part.trim().replace(/^Prof\.\s+/i, ''))
        .filter(Boolean)
        .map(normalizeFacultyName)
        .filter(Boolean);
}

/**
 * Backward-compatible identity key for a display name. The canonical index
 * key is now the identity id from teacher-identity.js ("mariya", "rupam-shah");
 * this helper folds any display name the same way for callers that only have
 * a name.
 */
export function teacherKey(name) {
    return String(name ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

/**
 * Build the teacher index from a list of class records.
 *
 * @param {Array<object>} classes normalized class records (parser / lab
 *   parser output). Each may carry an optional `_ctxLabel` school/year tag
 *   (see gatherAllTimetables) that is merged into the entry's `contexts`.
 * @returns {{
 *   index: Map<string, {name: string, aliases: string[], searchText: string,
 *           classes: Array<object>}>,
 *   order: Array<string>,
 *   all: Array<object>,
 *   stats: {total: number, meetings: number, duplicates: number, classes: number,
 *           unassigned: number, teachers: number, entries: number},
 *   excluded: Array<object>,
 *   candidates: Array<{idA, displayNameA, idB, displayNameB, reason}>
 * }}
 *   index  id → { name (preferred display), aliases (every folded spelling),
 *          searchText (id + name + aliases), classes: entries }. Entries carry
 *          `teacher`, `teachers`, `originalFaculty`, `contexts`, `aliases`,
 *          `canonicalId` plus the full class record.
 *   order  sorted ids (search-friendly).
 *   all    every deduped MEETING (indexed or not) — the full normalized
 *          timetable, useful for AI prompts that must search the whole week.
 *   stats  total = normalized records in, meetings = deduped meetings,
 *          duplicates = collapsed repeats, classes = indexed unique meetings,
 *          unassigned = unique meetings with no teacher, teachers = distinct
 *          canonical identities, entries = total entries.
 *   excluded  one record per normalized input that did NOT become an indexed
 *          entry, with a machine `reason` ('duplicate meeting' | 'no teacher
 *          parsed') — for the teacher page's ?debug panel.
 *   candidates  MEDIUM-confidence duplicate-teacher pairs that need a human
 *          to confirm ("Prof. Mariya" ↔ "Prof. Mariya Shah"). Never merged
 *          automatically; confirmed pairs are applied on the next build via
 *          the stored confirmations / TEACHER_ALIASES config. "Prof. Roopam"
 *          ↔ "Prof. Rupam Shah" is a confirmed alias, so it merges and never
 *          appears here.
 */
export function buildTeacherIndex(classes) {
    const stats = { total: 0, meetings: 0, duplicates: 0, classes: 0, unassigned: 0, teachers: 0, entries: 0 };
    const excluded = [];

    // Dedupe the same MEETING surfaced by several year configs or the Year 2
    // room-scoped scan. classIdentity alone is deliberately time/room-agnostic
    // (change detection tracks a class across moves), so using it here would
    // collapse "FDE Sec 2 – Mon 12:15" and "FDE Sec 2 – Mon 16:00" into one
    // entry and silently drop classes from the teacher's week. meetingIdentity
    // (identity + day + time + room) merges only genuinely identical meetings;
    // context labels from later parses are merged onto the surviving record.
    const flattened = flattenClasses(classes || []);
    stats.total = flattened.length;
    const unique = new Map();
    for (const c of flattened) {
        const id = meetingIdentity(c);
        const first = unique.get(id);
        if (first) {
            for (const l of c._ctxLabels || []) {
                if (!first._ctxLabels.has(l)) first._ctxLabels.add(l);
            }
            if (c._ctxLabel && !first._ctxLabels.has(c._ctxLabel)) first._ctxLabels.add(c._ctxLabel);
            stats.duplicates++;
            excluded.push(diagnoseRecord(c, 'duplicate meeting'));
            continue;
        }
        unique.set(id, {
            ...c,
            _ctxLabels: new Set([
                ...(c._ctxLabels || []),
                ...(c._ctxLabel ? [c._ctxLabel] : []),
            ]),
        });
    }
    stats.meetings = unique.size;

    // Resolve teacher identity across ALL observed names in one pass: titles,
    // punctuation, case and minor spelling variants collapse to one canonical
    // identity; ambiguous pairs become confirmation candidates.
    const observed = [];
    for (const c of unique.values()) {
        observed.push(...splitTeachers(c.faculty));
    }
    const confirmed = loadTeacherConfirmations().merge || [];
    const resolution = buildIdentityResolution(observed, confirmed);

    const index = new Map();
    for (const c of unique.values()) {
        const teachers = splitTeachers(c.faculty);
        if (!teachers.length) {
            stats.unassigned++;
            excluded.push(diagnoseRecord(c, 'no teacher parsed'));
            continue;
        }
        stats.classes++;
        const { _ctxLabel, _ctxLabels, ...rest } = c;
        for (const teacher of teachers) {
            const ident = resolution.byName.get(teacher) || {
                id: teacherKey(teacher),
                displayName: teacher,
                aliases: [teacher],
            };
            const entry = {
                ...rest,
                teacher: ident.displayName,
                teachers: teachers.map((t) => (resolution.byName.get(t) || { displayName: t }).displayName),
                originalFaculty: c.faculty,
                aliases: ident.aliases,
                canonicalId: ident.id,
                contexts: [..._ctxLabels],
            };
            const key = ident.id;
            let rec = index.get(key);
            if (!rec) {
                rec = {
                    name: ident.displayName,
                    aliases: ident.aliases,
                    searchText: teacherSearchText(ident.id, ident.displayName, ident.aliases),
                    classes: [],
                };
                index.set(key, rec);
            }
            rec.classes.push(entry);
            stats.entries++;
        }
    }

    stats.teachers = index.size;
    const order = [...index.keys()].sort((a, b) => {
        const na = index.get(a).name.toLowerCase();
        const nb = index.get(b).name.toLowerCase();
        return na < nb ? -1 : na > nb ? 1 : a < b ? -1 : a > b ? 1 : 0;
    });
    return { index, order, all: [...unique.values()], stats, excluded, candidates: resolution.candidates };
}

// Compact, JSON-safe view of a normalized record that did not make it into
// the index, plus the machine-readable reason.
function diagnoseRecord(c, reason) {
    return {
        subject: c.subject ?? c.course ?? null,
        courseId: c.courseId ?? null,
        day: c.day ?? null,
        startTime: c.startTime ?? null,
        endTime: c.endTime ?? null,
        school: c.school ?? null,
        year: c.year ?? null,
        section: c.section ?? null,
        faculty: c.faculty ?? null,
        reason,
    };
}
