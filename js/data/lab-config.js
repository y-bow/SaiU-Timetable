/**
 * Year 2 SCDS lab timetable sources.
 *
 * The main SCDS timetable is one Google Sheet. Year 2 also has separate lab
 * sheets (DAA Lab, FDE Lab, Emerging Tools Lab). Each lab lives in its own
 * sheet and is fetched/parsed independently, then merged with the main
 * timetable in JavaScript (see js/services/lab-fetch.js and the
 * mergeTimelines helper in js/data/lab-parser.js).
 *
 * This module is the single place that knows *which* lab sheets exist. The
 * parser and fetcher are data-driven off this config, so adding another lab
 * later = adding one entry here.
 *
 * ============================================================================
 * CONFIGURATION REQUIRED
 * ============================================================================
 * All three lab sheet ids below are PLACEHOLDERS. They must be replaced with
 * the real, publicly-viewable Google Sheet ids (the long id in the sheet's
 * share URL, same format as the main SCDS sheet id in js/data/schools.js).
 *
 *   DAA_LAB.sheetId            → Design and Analysis of Algorithms Lab sheet
 *   FDE_LAB.sheetId            → Foundations of Data Engineering Lab sheet
 *   EMERGING_TOOLS_LAB.sheetId → Emerging Tools Lab sheet (3 elective offerings)
 *
 * Until a real id is set the fetcher deliberately does NOT request that sheet
 * and reports the source as `unconfigured`, so no 404s or console spam happen
 * before the ids exist.
 *
 * gid default of '0' means the first tab. If a lab sheet's timetable is not on
 * the first tab, set gid to that tab's id.
 * ============================================================================
 */

// The lecture/elective that the Emerging Tools Lab belongs to. Selecting the
// "Emerging Tools and Applications" elective in the sidebar is what makes the
// lab appear. Kept separate from the lecture record itself — see
// js/data/lab-parser.js notes on elective handling. If the lab should become
// its own independently toggleable elective instead, replace this id with a new
// one AND add it to the scds-2 year config's `electives` list in schools.js.
const EMERGING_TOOLS_ELECTIVE_ID = 'emerging-tools-and-applications';

export const YEAR_2_LAB_SOURCES = {
    DAA_LAB: {
        source: 'daa-lab',
        yearId: 'scds-2',
        year: 2,
        school: 'scds',
        sheetId: 'PLACEHOLDER_DAA_LAB_SHEET_ID',
        gid: '0',
        course: 'Design and Analysis of Algorithms Lab',
        // Cell subjects are matched against these before being kept. The
        // canonical `course` name is emitted when any alias matches.
        subjectAliases: [
            /^daa(?:\s+lab)?\b/i,
            /design[-\s]*and[-\s]*analysis/i,
        ],
        isElective: false,
        electiveId: null,
        // Optional list of room names (search locations) to scan, normalized the
        // same way the main Year 2 parser normalizes rooms. null = auto-detect:
        // scan every non-empty timetable cell and rely on subject matching.
        rooms: null,
    },

    FDE_LAB: {
        source: 'fde-lab',
        yearId: 'scds-2',
        year: 2,
        school: 'scds',
        sheetId: 'PLACEHOLDER_FDE_LAB_SHEET_ID',
        gid: '0',
        course: 'Foundations of Data Engineering Lab',
        subjectAliases: [
            /^fde(?:\s+lab)?\b/i,
            /foundations[-\s]*of[-\s]*data/i,
        ],
        isElective: false,
        electiveId: null,
        rooms: null,
    },

    EMERGING_TOOLS_LAB: {
        source: 'emerging-tools-lab',
        yearId: 'scds-2',
        year: 2,
        school: 'scds',
        sheetId: 'PLACEHOLDER_EMERGING_TOOLS_LAB_SHEET_ID',
        gid: '0',
        course: 'Emerging Tools Lab',
        subjectAliases: [
            /^etl\b/i,
            /^et\s*lab\b/i,
            /^emerging tools\b/i,
        ],
        // Three separate elective offerings (rooms/times/instructors can all
        // differ). The parser preserves every offering — the app's existing
        // elective offering-chooser lets the student pick which one they attend.
        isElective: true,
        electiveId: EMERGING_TOOLS_ELECTIVE_ID,
        rooms: null,
    },
};

/**
 * Flat, ordered list of all lab sources. Deterministic (object key order).
 */
export function getYear2LabSources() {
    return Object.values(YEAR_2_LAB_SOURCES).filter((s) => s.enabled !== false);
}

/**
 * Build the public Google Sheets CSV export URL for a lab source — the exact
 * same mechanism the main app uses for the main timetable sheet.
 */
export function labSheetUrl(source) {
    if (!source || !source.sheetId) return null;
    return `https://docs.google.com/spreadsheets/d/${source.sheetId}/export?format=csv&gid=${source.gid || '0'}`;
}

/**
 * localStorage cache key for ONE lab source. Mirrors the app's per-year cache
 * scheme (`tt-cache-<yearId>`) extended with the source so each lab sheet is
 * cached independently and a single source never pollutes another.
 */
export function labCacheKey(source) {
    const yearId = source && source.yearId ? source.yearId : 'scds-2';
    return `tt-cache-${yearId}-${source.source}`;
}

/**
 * True when a source holds the clearly-marked placeholder id (real id not yet
 * provided). The fetcher skips these rather than hitting Google with garbage.
 */
export function isMissingSheetId(source) {
    return !source || !source.sheetId || /^PLACEHOLDER_/.test(source.sheetId);
}

/**
 * Whether the active year config is Year 2 SCDS — the only year the lab
 * sources apply to. Used to decide when to fetch/merge the lab sheets.
 */
export function isYear2SCDS(yearConfig) {
    return !!yearConfig && yearConfig.id === 'scds-2';
}