import { SCHOOLS, buildYearMap, resolveYears, resolveSections, shouldShowProgram, shouldShowSection, schoolHasLevel } from '../data/schools.js?v=2026-08-11-002';
import { getNavState, setNavState, getStoredElectives, setStoredElectives, getStoredOfferings, setStoredOffering, getStoredEmergingToolsSection, setStoredEmergingToolsSection } from '../services/storage.js?v=2026-08-11-002';

/**
 * Navigation state management.
 *
 * Tracks the current position in the school → program → year → section
 * hierarchy plus the student's elective selections (which electives are
 * taken, and which offering of each elective is chosen) for the active year.
 * On every change the module persists the selection and emits a `navchange`
 * CustomEvent so the UI and data layers can react.
 */

let state = {
    school: null,
    program: null,
    year: null,
    section: null,
    yearConfig: null,
    electives: [],
    offeringSelections: {},
    emergingToolsSection: null,
};

const yearMap = buildYearMap();

// --- Accessors ---

export function getSchool() { return state.school; }
export function getProgram() { return state.program; }
export function getYear() { return state.year; }
export function getSection() { return state.section; }
export function getYearConfig() { return state.yearConfig; }
export function getState() { return { ...state }; }
export function getSelectedElectives() { return state.electives; }
export function getSelectedOffering(electiveId) {
    return (state.offeringSelections && state.offeringSelections[electiveId]) || null;
}

// The elective that carries an independent offering selector (a dropdown in
// the sidebar). Currently the Emerging Tools elective. `null` means the
// active year has no such elective.
export function getEmergingToolsConfig() {
    const electives = (state.year && state.year.electives) || [];
    return electives.find(e => e.sections && e.sections.length) || null;
}

export function getEmergingToolsSection() {
    return state.emergingToolsSection || null;
}

// --- Helpers ---

function findSchool(id) {
    return SCHOOLS.find(s => s.id === id) || null;
}

function findProgram(school, id) {
    if (!school || !school.programs) return null;
    return school.programs.find(p => p.id === id) || null;
}

function findYear(school, programId, yearId) {
    const years = programId
        ? (school.programs?.find(p => p.id === programId)?.years || [])
        : (school.years || []);
    return years.find(y => y.id === yearId) || null;
}

// Find a year config at the given level within a school (optionally scoped
// to a program). Used for the global Year selector, which is shared by all
// schools even when the current school doesn't offer every level.
function findYearByLevel(school, program, level) {
    if (!school) return null;
    const years = program ? (program.years || []) : (school.years || []);
    return years.find(y => y.level === level) || null;
}

// Coerce a Year selector id back to a numeric level. Accepts the level number
// itself, "year-3"-style ids, and legacy per-year config ids like "scds-3".
function yearLevelToNumber(yearId) {
    if (typeof yearId === 'number') return yearId;
    const m = String(yearId).match(/^year-(\d+)$/);
    if (m) return parseInt(m[1], 10);
    const entry = yearMap.get(String(yearId));
    return entry ? entry.year.level : null;
}

function resolveYearConfig(school, program, yearId) {
    if (!school || !yearId) return null;
    const years = program ? (program.years || []) : (school.years || []);
    return years.find(y => y.id === yearId) || null;
}

// Restore the student's saved electives for a year, dropping ids that are no
// longer offered by the config (e.g. electives removed from the timetable).
function loadElectivesForYear(yearConfig) {
    const available = (yearConfig && yearConfig.electives) || [];
    if (!available.length) return [];
    const saved = yearConfig ? getStoredElectives(yearConfig.id) : [];
    return saved.filter(id => available.some(e => e.id === id));
}

// Restore the saved offering choice per elective for a year. Keys for
// offerings that no longer exist are ignored by the resolver at render time.
function loadOfferingsForYear(yearConfig) {
    return yearConfig ? getStoredOfferings(yearConfig.id) : {};
}

// Restore the saved Emerging Tools offering for a year. Values that no longer
// exist in the elective's section config are dropped.
function loadEmergingToolsForYear(yearConfig) {
    if (!yearConfig) return null;
    const sections = (getEmergingToolsConfigRaw(yearConfig) || {}).sections || [];
    if (!sections.length) return null;
    const saved = getStoredEmergingToolsSection(yearConfig.id);
    return sections.some(s => s.id === saved) ? saved : null;
}

// Find the elective with an offering selector within a given year config,
// independent of the currently active year state.
function getEmergingToolsConfigRaw(yearConfig) {
    const electives = (yearConfig && yearConfig.electives) || [];
    return electives.find(e => e.sections && e.sections.length) || null;
}

// --- Navigation ---

function emit() {
    window.dispatchEvent(new CustomEvent('navchange', { detail: { ...state } }));
}

/**
 * Initialise navigation from persisted state.
 * Falls back to the first available school/year when the stored values
 * are stale (e.g. school removed from config).
 */
export function initNavigation() {
    const saved = getNavState();

    // School
    let school = saved.schoolId ? findSchool(saved.schoolId) : null;
    if (!school && SCHOOLS.length) school = SCHOOLS[0];

    // Program
    let program = null;
    if (school && saved.programId) {
        program = findProgram(school, saved.programId);
    }
    // If the school requires a program and none was saved, pick the first.
    if (school && school.programs && !program) {
        program = school.programs[0];
    }

    // Year
    let year = null;
    let yearConfig = null;
    if (school && saved.yearId) {
        yearConfig = resolveYearConfig(school, program, saved.yearId);
        if (yearConfig) year = yearConfig;
    }
    // If no valid year, pick the first available.
    if (!yearConfig && school) {
        const years = program ? (program.years || []) : (school.years || []);
        if (years.length) {
            yearConfig = years[0];
            year = yearConfig;
        }
    }

    // Section
    let section = null;
    if (yearConfig) {
        const sections = resolveSections(yearConfig);
        if (sections.length) {
            if (saved.section && sections.includes(saved.section)) {
                section = saved.section;
            } else {
                section = sections[0];
            }
        }
    }

    state = { school, program, year: yearConfig, section, yearConfig, electives: loadElectivesForYear(yearConfig), offeringSelections: loadOfferingsForYear(yearConfig), emergingToolsSection: loadEmergingToolsForYear(yearConfig) };
    persist();
    emit();
    return state;
}

/**
 * Navigate to a new school. Resets program and year to defaults.
 * Restores the saved section for the target year if available.
 */
export function navigateToSchool(schoolId) {
    const school = findSchool(schoolId);
    if (!school) return;

    let program = null;
    if (school.programs) program = school.programs[0];

    const years = program ? (program.years || []) : (school.years || []);
    const yearConfig = years[0] || null;

    let section = null;
    if (yearConfig) {
        const sections = resolveSections(yearConfig);
        if (sections.length) {
            const saved = getNavState();
            if (saved.section && sections.includes(saved.section)) {
                section = saved.section;
            } else {
                section = sections[0];
            }
        }
    }

    state = { school, program, year: yearConfig, section, yearConfig, electives: loadElectivesForYear(yearConfig), offeringSelections: loadOfferingsForYear(yearConfig), emergingToolsSection: loadEmergingToolsForYear(yearConfig) };
    persist();
    emit();
}

/**
 * Navigate to a new program within the current school. Resets year.
 * Restores the saved section for the target year if available.
 */
export function navigateToProgram(programId) {
    const school = state.school;
    if (!school) return;

    const program = findProgram(school, programId);
    if (!program) return;

    const yearConfig = program.years?.[0] || null;
    let section = null;
    if (yearConfig) {
        const sections = resolveSections(yearConfig);
        if (sections.length) {
            const saved = getNavState();
            if (saved.section && sections.includes(saved.section)) {
                section = saved.section;
            } else {
                section = sections[0];
            }
        }
    }

    state = { ...state, program, year: yearConfig, section, yearConfig, electives: loadElectivesForYear(yearConfig), offeringSelections: loadOfferingsForYear(yearConfig), emergingToolsSection: loadEmergingToolsForYear(yearConfig) };
    persist();
    emit();
}

/**
 * Navigate to a new year within the current school/program.
 * Restores the saved section for the target year if available.
 *
 * The Year selector is shared across schools (always shows Year 2, Year 3,
 * …). If the active school doesn't offer the chosen level, the app switches
 * to the first school that does — e.g. clicking Year 3 while in SOAI (which
 * only has Year 2) jumps to SCDS Year 3.
 */
export function navigateToYear(yearId) {
    const level = yearLevelToNumber(yearId);
    if (level == null) return;

    let school = state.school;
    let program = state.program;
    let yearConfig = findYearByLevel(school, program, level);

    if (!yearConfig) {
        const target = SCHOOLS.find(s => schoolHasLevel(s, level));
        if (!target) return;
        school = target;
        program = target.programs ? target.programs[0] : null;
        yearConfig = findYearByLevel(school, program, level);
    }
    if (!yearConfig) return;

    let section = null;
    const sections = resolveSections(yearConfig);
    if (sections.length) {
        const saved = getNavState();
        if (saved.section && sections.includes(saved.section)) {
            section = saved.section;
        } else {
            section = sections[0];
        }
    }

    state = { ...state, school, program, year: yearConfig, section, yearConfig, electives: loadElectivesForYear(yearConfig), offeringSelections: loadOfferingsForYear(yearConfig), emergingToolsSection: loadEmergingToolsForYear(yearConfig) };
    persist();
    emit();
}

/**
 * Navigate to a new section within the current year.
 */
export function navigateToSection(section) {
    state = { ...state, section };
    persist();
    emit();
}

/**
 * Set the student's selected electives for the active year.
 * Only ids offered by the current year config are kept, so a stale or
 * forged selection never leaks into the timetable.
 */
export function setSelectedElectives(ids) {
    const available = availableElectives();
    const valid = (ids || []).filter(id => available.some(e => e.id === id));
    state = { ...state, electives: valid };
    if (state.year) setStoredElectives(state.year.id, valid);
    emit();
}

/**
 * Set which offering of an elective the student attends. Persisted per year;
 * the chosen key is matched against each course event's offerings at render
 * time, so it only applies where the offering actually exists.
 */
export function setSelectedOffering(electiveId, offeringKey) {
    if (!electiveId) return;
    const next = { ...state.offeringSelections };
    if (offeringKey == null) delete next[electiveId];
    else next[electiveId] = offeringKey;
    state = { ...state, offeringSelections: next };
    if (state.year) setStoredOffering(state.year.id, electiveId, offeringKey);
}

/**
 * Set which offering section of the Emerging Tools elective the student
 * attends. Completely independent from the SCDS section selection. The value is
 * matched to the timetable by the section NUMBER on the config entry — both the
 * main-course offering and the Emerging Tools Lab records are selected by that
 * section. Only ids that exist in the elective's section config are kept;
 * anything else clears the choice (which hides that elective's classes). The
 * lab teacher is never part of this choice.
 */
export function setEmergingToolsSection(value) {
    const cfg = getEmergingToolsConfig();
    const valid = cfg ? cfg.sections.some(s => s.id === value) : false;
    const next = valid ? value : null;
    state = { ...state, emergingToolsSection: next };
    if (state.year) setStoredEmergingToolsSection(state.year.id, next || null);
    emit();
}

function persist() {
    setNavState({
        schoolId: state.school?.id || null,
        programId: state.program?.id || null,
        yearId: state.year?.id || null,
        section: state.section,
    });
}

// --- Derived state helpers ---

export function availableSchools() {
    // Only show schools that offer the currently selected year level, so a
    // year (e.g. Year 3) hides schools that don't have that level yet.
    const level = state.year?.level;
    return level == null ? SCHOOLS : SCHOOLS.filter(s => schoolHasLevel(s, level));
}

export function availablePrograms() {
    return state.school?.programs || [];
}

export function availableYears() {
    // Every distinct year level across the whole config, so the Year selector
    // is always visible (Year 2, Year 3, …) no matter which school is active.
    const levels = new Map();
    for (const school of SCHOOLS) {
        if (school.programs) {
            for (const program of school.programs) {
                for (const year of program.years) {
                    if (year.level != null && !levels.has(year.level)) levels.set(year.level, year);
                }
            }
        }
        if (school.years) {
            for (const year of school.years) {
                if (year.level != null && !levels.has(year.level)) levels.set(year.level, year);
            }
        }
    }
    return [...levels.keys()]
        .sort((a, b) => a - b)
        .map(level => ({ id: level, label: `Year ${level}`, level }));
}

export function availableSections() {
    if (!state.year) return [];
    return resolveSections(state.year);
}

export function availableElectives() {
    return (state.year && state.year.electives) || [];
}

export function showProgramSelector() {
    return state.school ? shouldShowProgram(state.school) : false;
}

export function showSectionSelector() {
    return state.year ? shouldShowSection(state.year) : false;
}

export function getSheetUrl() {
    if (!state.year) return null;
    const { sheetId, gid } = state.year;
    if (!sheetId) return null;
    return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid || '0'}`;
}

export function getMandatoryCourses() {
    return state.year?.mandatoryCourses || null;
}

// The list of classroom columns the grid parser should scan for this year
// (Year 2 SCDS). `null` means "scan the sheet as before" (other schools).
export function getRooms() {
    return state.year?.rooms || null;
}

export function getElectives() {
    return state.year?.electives || null;
}

export function getParserType() {
    return state.year?.parser || 'grid';
}
