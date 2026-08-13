/**
 * Teacher timetable index.
 *
 * Every parser already attaches a normalized `faculty` name to each class
 * (see normalizeFacultyName in js/data/parser.js — the canonical "Prof. X"
 * display form plus the Dr.K.K.Singh / Dr.Tamilarasi aliases). This module is
 * the single place that turns class records into a teacher-indexed view:
 *
 *     class records → flatten offerings → dedupe → extract teacher(s) → index
 *
 * Design rules honored here:
 *   - NO fuzzy merging. A teacher's key is their normalized display name,
 *     compared EXACTLY (case/whitespace-insensitive). "Prof. Arjun" and
 *     "Prof. Arjun Singh" are two different teachers; the sheets' own alias
 *     table is the only sanctioned merge.
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
 * Pure module — no window, localStorage, or fetch — so it runs identically
 * in the browser and in the Node test harness.
 */

import { normalizeFacultyName } from './parser.js?v=2026-08-13-004';
import { classIdentity, flattenClasses } from './change-detector.js?v=2026-08-13-004';

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
 * Conservative teacher identity key: the normalized display name, compared
 * exactly (case/whitespace-insensitive). Deliberately NOT fuzzy — "Prof.
 * Arjun" and "Prof. Arjun Singh" stay distinct.
 */
export function teacherKey(name) {
    return String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Build the teacher index from a list of class records.
 *
 * @param {Array<object>} classes normalized class records (parser / lab
 *   parser output). Each may carry an optional `_ctxLabel` school/year tag
 *   (see gatherAllTimetables) that is merged into the entry's `contexts`.
 * @returns {{
 *   index: Map<string, {name: string, classes: Array<object>}>,
 *   order: Array<string>,
 *   all: Array<object>,
 *   stats: {total: number, meetings: number, duplicates: number, classes: number,
 *           unassigned: number, teachers: number, entries: number},
 *   excluded: Array<object>
 * }}
 *   index  key → { name (display), classes: entries }; entries carry
 *          `teacher`, `teachers`, `originalFaculty`, `contexts` plus the full
 *          class record.
 *   order  sorted keys (search-friendly).
 *   all    every deduped MEETING (indexed or not) — the full normalized
 *          timetable, useful for AI prompts that must search the whole week.
 *   stats  total = normalized records in, meetings = deduped meetings,
 *          duplicates = collapsed repeats, classes = indexed unique meetings,
 *          unassigned = unique meetings with no teacher, teachers = distinct
 *          keys, entries = total entries.
 *   excluded  one record per normalized input that did NOT become an indexed
 *          entry, with a machine `reason` ('duplicate meeting' | 'no teacher
 *          parsed') — for the teacher page's ?debug panel.
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
            if (c._ctxLabel && !first._ctxLabels.has(c._ctxLabel)) first._ctxLabels.add(c._ctxLabel);
            stats.duplicates++;
            excluded.push(diagnoseRecord(c, 'duplicate meeting'));
            continue;
        }
        unique.set(id, { ...c, _ctxLabels: new Set(c._ctxLabel ? [c._ctxLabel] : []) });
    }
    stats.meetings = unique.size;

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
            const entry = {
                ...rest,
                teacher,
                teachers,
                originalFaculty: c.faculty,
                contexts: [..._ctxLabels],
            };
            const key = teacherKey(teacher);
            let rec = index.get(key);
            if (!rec) {
                rec = { name: teacher, classes: [] };
                index.set(key, rec);
            }
            rec.classes.push(entry);
            stats.entries++;
        }
    }

    stats.teachers = index.size;
    const order = [...index.keys()].sort();
    return { index, order, all: [...unique.values()], stats, excluded };
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
