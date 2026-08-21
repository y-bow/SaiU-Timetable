/**
 * Teacher timetable data loading.
 *
 * The teacher page needs EVERY class the app can show, not just one year's
 * slice: all schools (SCDS / SOAI / SOB), all years, plus the Year 2 lab
 * tabs. Every year config points at the SAME shared spreadsheet (gid 0), so
 * the main sheet is fetched ONCE.
 *
 * THE TEACHER TIMETABLE IS BUILT FROM THE RAW SHEET BY TEACHER, NOT FROM THE
 * STUDENT COURSE LIST.
 *
 *     main sheet (once) → parseTeacherGrid (every teacher-named cell) → index
 *                            │
 *     context stamping (school/year tags, never a filter)
 *                            │
 *     + lab tabs (existing lab pipeline, merged)
 *                            ↓
 *                        teacherIndex
 *
 * parseTeacherGrid (js/data/parser.js) keeps EVERY cell that names a teacher,
 * whether or not its course is recognized by any student course config, so a
 * class such as "Contitutional Law 2 … Dr. Sanjay Bang" still lands in the
 * teacher's timetable even though that course exists nowhere in the student
 * timetables. The year configs are used ONLY to stamp school/year context on a
 * matching class (the same matching rules each year parser applies) — a class
 * that matches no year config is NOT dropped, it simply carries no context.
 *
 * Mirrors js/services/lab-fetch.js: network-first with a localStorage cache
 * fallback so the page works offline and one broken source can never take
 * the whole page down.
 */

import { buildYearMap } from '../data/schools.js?v=2026-08-21-005';
import { parseTeacherGrid } from '../data/parser.js?v=2026-08-21-005';
import { buildTeacherIndex } from '../data/teacher-index.js?v=2026-08-21-005';
import { syncYear2Labs } from './lab-fetch.js?v=2026-08-21-005';

export const TEACHER_CACHE_KEY = 'tt-teachers-v3';
export const MAIN_SHEET_CACHE_KEY = 'tt-teachers-main-sheet-v1';

const SCHOOL_LABELS = { scds: 'SCDS', soai: 'SOAI', sob: 'SOB' };
const LAB_CONTEXT = 'SCDS · Year 2 Lab';

function read(key) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; }
    catch { return null; }
}

function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* full */ }
}

function schoolLabel(school) {
    return SCHOOL_LABELS[school?.id] || String(school?.shortName || school?.id || 'UNKNOWN').toUpperCase();
}

function contextLabel(school, program, year) {
    const schoolPart = schoolLabel(school);
    const yearPart = program ? `${program.label} ${year.label}` : year.label;
    return `${schoolPart} · ${yearPart}`;
}

// Compare rooms like the parsers do: uppercase, hyphens ≈ spaces.
function normRoom(room) {
    return String(room ?? '')
        .toUpperCase()
        .replace(/-/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Strict elective label match, mirroring the grid parser's matchElective.
function matchesElectiveLabel(subject, label) {
    const s = String(subject ?? '').trim().toLowerCase();
    const n = String(label ?? '').trim().toLowerCase();
    return !!s && (s === n || s.startsWith(n));
}

// Mandatory-course prefix match, mirroring the grid parser's matchesName.
function matchesMandatory(subject, name) {
    const s = String(subject ?? '').trim().toLowerCase();
    const n = String(name ?? '').trim().toLowerCase();
    return !!s && (s === n || s.startsWith(n) || n.startsWith(s));
}

/**
 * Whether a raw teacher class belongs to a year config, using the SAME rules
 * that year's student parser applies — purely so the class can be tagged with
 * a school/year context label. This is a tag, never a filter: a class that
 * matches no year config still stays in the teacher timetable.
 */
function belongsToYear(c, year) {
    const mandatory = (year.mandatoryCourses || []).map((m) => m.trim());
    const electives = year.electives || [];

    // Electives match regardless of room — a course like Forensic Psychology
    // offered by SCDS Year 2 should tag the class even when it sits in a room
    // outside the configured list (e.g. a shared classroom).
    if (electives.some((e) => matchesElectiveLabel(c.subject, e.label))) return true;

    // Room-scoped year (SCDS-2): a sectioned class sitting in one of the
    // configured classrooms. Unsectioned non-elective cells in those rooms
    // (e.g. "EFA - Sem1" from another program) are NOT this year — same
    // exclusion as the room-scoped student parser.
    if (year.rooms && year.rooms.length) {
        const inRoom = year.rooms.some((r) => normRoom(c.room) === normRoom(r));
        if (!inRoom) return false;
        if (c._hasSection) return true;
        return false;
    }

    return mandatory.some((m) => matchesMandatory(c.subject, m));
}

/**
 * Stamp school/year context onto every raw teacher class. `_ctxLabels` is a
 * Set of "SCHOOL · Year N" labels (a class can belong to several year configs,
 * e.g. Deep Learning appears in both the SCDS-2 rooms and SCDS-3 mandatory
 * list). `_hasSection` is consumed here and removed.
 */
function stampYearContexts(classes, yearMap) {
    for (const c of classes || []) {
        if (!c) continue;
        for (const { school, program, year } of yearMap.values()) {
            if (!belongsToYear(c, year)) continue;
            if (c.school === undefined) c.school = school.id;
            if (c.year === undefined) c.year = year.level;
            if (!c._ctxLabels) c._ctxLabels = new Set();
            c._ctxLabels.add(contextLabel(school, program, year));
        }
        delete c._hasSection;
    }
    return classes;
}

/**
 * Build the teacher timetable from the raw main sheet + lab classes. Pure (no
 * network): the caller supplies the main sheet text and lab classes.
 *
 * The main sheet is parsed ONCE in teacher-centric mode (parseTeacherGrid) and
 * the year configs stamp context only. Lab classes are merged unchanged, each
 * tagged with its own context label.
 */
export function gatherAllTimetables(mainText, labClasses = [], yearMap = buildYearMap()) {
    const all = [];
    try {
        all.push(...stampYearContexts(parseTeacherGrid(mainText), yearMap));
    } catch {
        // One year must never break the whole index.
    }
    for (const c of labClasses || []) {
        const label = c.school
            ? `${String(c.school).toUpperCase()} · Year ${c.year} Lab`
            : LAB_CONTEXT;
        all.push({ ...c, _ctxLabel: label });
    }
    return all;
}

// Every year config shares the same spreadsheet, so the URL is built from the
// first year config rather than importing config.js (which touches `window`).
function mainSheetUrl(yearMap = buildYearMap()) {
    const year = yearMap.values().next().value?.year || null;
    const sheetId = year?.sheetId || null;
    if (!sheetId) return null;
    const gid = year?.gid || '0';
    return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
}

/**
 * Fetch the shared main sheet once. Network-first with a localStorage cache
 * fallback. Never throws; always returns a { status, text, savedAt } record.
 */
export async function fetchMainSheetText({ useCache = true } = {}) {
    const url = mainSheetUrl();
    if (!url) return { status: 'error', text: '', savedAt: null };
    const cached = useCache ? read(MAIN_SHEET_CACHE_KEY) : null;
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (!text.trim()) throw new Error('Empty sheet');
        write(MAIN_SHEET_CACHE_KEY, text);
        return { status: 'ok', text, savedAt: Date.now() };
    } catch {
        if (cached && typeof cached.text === 'string' && cached.text.trim()) {
            return { status: 'cached', text: cached.text, savedAt: cached.savedAt || null };
        }
        return { status: 'error', text: '', savedAt: null };
    }
}

function rebuildIndex(cached) {
    const index = new Map();
    for (const t of cached.teachers || []) {
        index.set(t.key, {
            name: t.name,
            aliases: t.aliases || [],
            searchText: t.searchText || String(t.name || '').toLowerCase(),
            classes: t.classes,
        });
    }
    return index;
}

/**
 * Load the full teacher timetable. Network-first, cache fallback, never
 * throws. Returns null only when there is nothing to show at all.
 *
 * @returns {Promise<{
 *   index: Map<string, {name: string, aliases: string[], searchText: string,
 *           classes: Array<object>}>,
 *   order: Array<string>,
 *   all: Array<object>,
 *   stats: object,
 *   candidates: Array<{idA, displayNameA, idB, displayNameB, reason}>,
 *   statuses: {main: string, labs: Record<string,string>},
 *   savedAt: number|null,
 *   source: 'live'|'cached'
 * }|null>}
 */
export async function loadTeacherIndex({ useCache = true } = {}) {
    const sheet = await fetchMainSheetText({ useCache });
    if (sheet.status === 'error') {
        if (useCache) {
            const cached = read(TEACHER_CACHE_KEY);
            if (cached && cached.teachers && cached.order) {
                return {
                    index: rebuildIndex(cached),
                    order: cached.order,
                    all: cached.all || [],
                    stats: cached.stats || {},
                    excluded: cached.excluded || [],
                    candidates: cached.candidates || [],
                    statuses: cached.statuses || {},
                    savedAt: cached.savedAt || null,
                    source: 'cached',
                };
            }
        }
        return null;
    }

    const { classes: labClasses, statuses: labStatuses } = await syncYear2Labs();
    const all = gatherAllTimetables(sheet.text, labClasses);
    const built = buildTeacherIndex(all);

    const payload = {
        order: built.order,
        stats: built.stats,
        all: built.all,
        excluded: built.excluded,
        candidates: built.candidates,
        teachers: built.order.map((key) => ({
            key,
            name: built.index.get(key).name,
            aliases: built.index.get(key).aliases,
            searchText: built.index.get(key).searchText,
            classes: built.index.get(key).classes,
        })),
        statuses: { main: sheet.status, labs: labStatuses },
        savedAt: sheet.savedAt || Date.now(),
    };
    try { localStorage.setItem(TEACHER_CACHE_KEY, JSON.stringify(payload)); } catch { /* full */ }

    return {
        index: built.index,
        order: built.order,
        all: built.all,
        stats: built.stats,
        excluded: built.excluded,
        candidates: built.candidates,
        statuses: payload.statuses,
        savedAt: payload.savedAt,
        source: 'live',
    };
}
