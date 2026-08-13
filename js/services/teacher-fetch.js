/**
 * Teacher timetable data loading.
 *
 * The teacher page needs EVERY class the app can show, not just one year's
 * slice: all schools (SCDS / SOAI / SOB), all years, plus the Year 2 lab
 * tabs. Every year config points at the SAME shared spreadsheet (gid 0), so
 * the main sheet is fetched ONCE and parsed once per year config — reusing
 * each year's parser, mandatory/elective filters and room-scoped scan exactly
 * as the student app does. The lab tabs are fetched through the existing lab
 * pipeline and merged in. The result is deduplicated and indexed by teacher
 * (see js/data/teacher-index.js).
 *
 *     fetch main sheet (once) ─────────────┐
 *     per-year parse (SCDS-2/3, SOAI-2, ───┼→ gather → teacherIndex
 *     SOB-BBA-2) + lab tabs                 ┘
 *
 * Mirrors js/services/lab-fetch.js: network-first with a localStorage cache
 * fallback so the page works offline and one broken source can never take
 * the whole page down.
 */

import { buildYearMap } from '../data/schools.js?v=2026-08-13-004';
import { parseCSV } from '../data/parser.js?v=2026-08-13-004';
import { buildTeacherIndex } from '../data/teacher-index.js?v=2026-08-13-004';
import { syncYear2Labs } from './lab-fetch.js?v=2026-08-13-004';

export const TEACHER_CACHE_KEY = 'tt-teachers-v1';
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

/**
 * Parse the shared main sheet once per year config and merge the app-shaped
 * lab classes underneath. Pure (no network): the caller supplies the main
 * sheet text and lab classes.
 *
 * Each parsed class is tagged with a `_ctxLabel` ("SCDS · Year 2") so the
 * teacher index can say which school/year a class belongs to — the main sheet
 * records themselves carry no school/year, exactly as in the student app, so
 * they are stamped here with the owning `school` id and `year` level too
 * (mirroring the lab parser's records). Those stamps feed the AI payload and
 * the ?debug excluded-class panel.
 */
export function gatherAllTimetables(mainText, labClasses = [], yearMap = buildYearMap()) {
    const all = [];
    for (const { school, program, year } of yearMap.values()) {
        let parsed = [];
        try {
            parsed = parseCSV(
                mainText,
                year.parser || 'grid',
                year.mandatoryCourses || null,
                year.electives || null,
                year.rooms || null,
            );
        } catch {
            // One year must never break the whole index.
        }
        const label = contextLabel(school, program, year);
        for (const c of parsed) all.push({ ...c, school: school.id, year: year.level, _ctxLabel: label });
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
    for (const t of cached.teachers || []) index.set(t.key, { name: t.name, classes: t.classes });
    return index;
}

/**
 * Load the full teacher timetable. Network-first, cache fallback, never
 * throws. Returns null only when there is nothing to show at all.
 *
 * @returns {Promise<{
 *   index: Map<string, {name: string, classes: Array<object>}>,
 *   order: Array<string>,
 *   all: Array<object>,
 *   stats: object,
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
        teachers: built.order.map((key) => ({
            key,
            name: built.index.get(key).name,
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
        statuses: payload.statuses,
        savedAt: payload.savedAt,
        source: 'live',
    };
}
