/**
 * Lab timetable sources (SCDS + SOAI Year 1, SCDS Year 2).
 *
 * The main timetable for every year is one Google Sheet (gid 0). Years 1 and 2
 * also have separate lab schedules, each as its own TAB inside the same
 * spreadsheet. Each tab is fetched/parsed independently, then merged with the
 * main timetable in JavaScript (see js/services/lab-fetch.js and the
 * mergeTimelines helper in js/data/lab-parser.js).
 *
 * This module is the single place that knows *which* lab tabs exist. The
 * parser and fetcher are data-driven off this config, so adding another lab
 * later = adding one entry here.
 *
 * The tabs use a simple LIST layout (Day | Time | Section) — unlike the main
 * grid sheet — so `parseLabList` in js/data/lab-parser.js reads them.
 *
 * Year 2: DAA / FDE labs are mandatory and keyed to a lab-section number
 * (1-8); the Emerging Tools Lab is tied to the Emerging Tools course
 * offerings instead (see electiveId in js/data/schools.js).
 *
 * Year 1: CS121 (Programming in C Lab) and CS128 (Engineering Foundations
 * and Application Lab) are mandatory labs without section selectors. Year 1
 * has no section structure, so labs use `sectionLess: true`.
 *
 * Year 1 labs are per SCHOOL, not per spreadsheet: SCDS Year 1 and SOAI Year 1
 * each own a source entry, and both of those entries read the SAME 'C Lab' tab
 * (different from the default gid-0 grid both years parse their main timetable
 * from). Because one tab can back several years, `getYear1LabSources(yearId)`
 * must be narrowed to the year being loaded — otherwise SCDS would show SOAI's
 * lab records and vice versa.
 */

// The lecture/elective that the Emerging Tools Lab belongs to. Selecting the
// "Emerging Tools and Applications" elective in the sidebar is what makes the
// lab appear. Kept separate from the lecture record itself — see
// js/data/lab-parser.js notes on elective handling. If the lab should become
// its own independently toggleable elective instead, replace this id with a new
// one AND add it to the scds-2 year config's `electives` list in schools.js.
// All Year 2 labs run in this one fixed room. The lab sheets do not declare a
// room per slot, so every lab class is stamped with this value instead of
// showing "Room TBA".
const LAB_FIXED_ROOM = 'AB1 - Computer Lab';

const EMERGING_TOOLS_ELECTIVE_ID = 'emerging-tools-and-applications';

// The shared spreadsheet that holds the main SCDS timetable AND the lab tabs.
const SPREADSHEET_ID = '1Jk3KCLqHHzi-jxigIcPpcXZestcxb8Y0BeQLjhiezb8';

export const YEAR_2_LAB_SOURCES = {
    DAA_LAB: {
        source: 'daa-lab',
        yearId: 'scds-2',
        year: 2,
        school: 'scds',
        sheetId: SPREADSHEET_ID,
        sheet: 'DAA Lab',
        course: 'Design and Analysis of Algorithms Lab',
        // Cell subjects are matched against these before being kept. The
        // canonical `course` name is emitted when any alias matches.
        subjectAliases: [
            /^daa(?:\s+lab)?\b/i,
            /design[-\s]*and[-\s]*analysis/i,
        ],
        isElective: false,
        electiveId: null,
        rooms: null,
        fixedRoom: LAB_FIXED_ROOM,
    },

    FDE_LAB: {
        source: 'fde-lab',
        yearId: 'scds-2',
        year: 2,
        school: 'scds',
        sheetId: SPREADSHEET_ID,
        sheet: 'FDE Lab',
        course: 'Foundations of Data Engineering Lab',
        subjectAliases: [
            /^fde(?:\s+lab)?\b/i,
            /foundations[-\s]*of[-\s]*data/i,
        ],
        isElective: false,
        electiveId: null,
        rooms: null,
        fixedRoom: LAB_FIXED_ROOM,
    },

    EMERGING_TOOLS_LAB: {
        source: 'emerging-tools-lab',
        yearId: 'scds-2',
        year: 2,
        school: 'scds',
        sheetId: SPREADSHEET_ID,
        sheet: 'Emg Lab',
        course: 'Emerging Tools and Applications Lab',
        subjectAliases: [
            /^etl?\s*lab\b/i,
            /^et\s+lab\b/i,
            /^emerging tools\b/i,
            /^et\b/i,
        ],
        // The Emerging Tools Lab is shown only for the offering section the
        // student chose (Emerging Tools elective section, 1-3). The lab's
        // explicit section is the identity of the offering; the lab teacher is
        // an independent property that never selects the offering.
        isElective: true,
        electiveId: EMERGING_TOOLS_ELECTIVE_ID,
        rooms: null,
        fixedRoom: LAB_FIXED_ROOM,
    },
};

/**
 * Flat, ordered list of all Year 2 lab sources. Deterministic (object key order).
 */
export function getYear2LabSources() {
    return Object.values(YEAR_2_LAB_SOURCES).filter((s) => s.enabled !== false);
}

// ---------------------------------------------------------------------------
// Year 1 SCDS lab sources
// ---------------------------------------------------------------------------

export const YEAR_1_LAB_SOURCES = {
    CS121_LAB: {
        source: 'cs121-lab',
        yearId: 'scds-1',
        year: 1,
        school: 'scds',
        sheetId: SPREADSHEET_ID,
        sheet: 'C Lab',
        course: 'Programming in C Lab',
        subjectAliases: [
            /^cs121\b/i,
            /programming\s+in\s+c\s+lab\b/i,
            /programming\s+in\s+c\b/i,
            /^c\s+lab\b/i,
        ],
        isElective: false,
        electiveId: null,
        rooms: null,
        fixedRoom: '',
        sectionLess: true,
    },

    CS121_LAB_SOAI: {
        source: 'cs121-lab-soai',
        yearId: 'soai-1',
        year: 1,
        school: 'soai',
        // Deliberately the SAME 'C Lab' tab SCDS Year 1 reads (same spreadsheet,
        // a non-default tab — the main SOAI timetable comes from gid 0). The tab
        // is shared; the school/year stamped onto the records is what keeps the
        // two years' lab lists apart.
        sheetId: SPREADSHEET_ID,
        sheet: 'C Lab',
        course: 'Programming in C Lab',
        subjectAliases: [
            /^cs121\b/i,
            /programming\s+in\s+c\s+lab\b/i,
            /programming\s+in\s+c\b/i,
            /^c\s+lab\b/i,
        ],
        isElective: false,
        electiveId: null,
        rooms: null,
        fixedRoom: '',
        sectionLess: true,
    },

    CS128_LAB: {
        source: 'cs128-lab',
        yearId: 'scds-1',
        year: 1,
        school: 'scds',
        sheetId: SPREADSHEET_ID,
        sheet: 'EFA Lab',
        course: 'Engineering Foundations and Application Lab',
        subjectAliases: [
            /^cs128\b/i,
            /engineering\s+foundations?\b/i,
            /^ef\s+lab\b/i,
            /^efa\s+lab\b/i,
            /^efa\b/i,
            /foundations?\s+and\s+applications?\s+lab\b/i,
            /foundations?\s+and\s+applications?\b/i,
        ],
        isElective: false,
        electiveId: null,
        rooms: null,
        fixedRoom: '',
        sectionLess: true,
    },
};

/**
 * Flat, ordered list of all Year 1 lab sources.
 *
 * Year 1 spans several schools (SCDS, SOAI), so pass the year id being loaded
 * ('scds-1', 'soai-1') to get only that year's sources — several entries read
 * the SAME lab tab and must never leak into another year's merge. Calling it
 * without a year id returns every Year 1 source (diagnostics / tests only).
 *
 * @param {string} [yearId] the year config id to scope the list to
 * @returns {Array<object>}
 */
export function getYear1LabSources(yearId) {
    const all = Object.values(YEAR_1_LAB_SOURCES).filter((s) => s.enabled !== false);
    if (!yearId) return all;
    return all.filter((s) => s.yearId === yearId);
}

/**
 * Build the fetch URL for a lab source. Labs are tabs inside the shared
 * spreadsheet, so this uses the anonymous Google Visualization data endpoint
 * with the tab name (public sheets allow it without a gid). Falls back to the
 * classic CSV export (gid) for any source that has no `sheet` tab name.
 */
export function labSheetUrl(source) {
    if (!source || !source.sheetId) return null;
    const base = `https://docs.google.com/spreadsheets/d/${source.sheetId}`;
    if (source.sheet) return `${base}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(source.sheet)}`;
    return `${base}/export?format=csv&gid=${source.gid || '0'}`;
}

/**
 * localStorage cache key for ONE lab source. Mirrors the app's per-year cache
 * scheme (`tt-cache-<yearId>`) extended with the source so each lab sheet is
 * cached independently and a single source never pollutes another.
 */
export function labCacheKey(source) {
    const yearId = source && source.yearId ? source.yearId : 'scds-2';
    return `tt-cache-v2-${yearId}-${source.source}`;
}

/**
 * True when a source holds the clearly-marked placeholder id (real id not yet
 * provided). The fetcher skips these rather than hitting Google with garbage.
 */
export function isMissingSheetId(source) {
    return !source || !source.sheetId || /^PLACEHOLDER_/.test(source.sheetId);
}

/**
 * Whether the active year config is Year 2 SCDS — the only year the Year 2 lab
 * sources apply to. Used to decide when to fetch/merge the Year 2 lab sheets.
 */
export function isYear2SCDS(yearConfig) {
    return !!yearConfig && yearConfig.id === 'scds-2';
}

/**
 * Whether the active year config is Year 1 SCDS.
 */
export function isYear1SCDS(yearConfig) {
    return !!yearConfig && yearConfig.id === 'scds-1';
}

/**
 * Whether the active year config owns Year 1 lab sources — i.e. its main
 * timetable must be merged with the separate Year 1 lab tabs. True for
 * SCDS Year 1 and SOAI Year 1 (and any year added to YEAR_1_LAB_SOURCES),
 * so callers never hardcode a year id again.
 *
 * @param {object|null} yearConfig the active year config (nav.getYear())
 * @returns {boolean}
 */
export function isYear1LabYear(yearConfig) {
    if (!yearConfig || !yearConfig.id) return false;
    return getYear1LabSources().some((s) => s.yearId === yearConfig.id);
}