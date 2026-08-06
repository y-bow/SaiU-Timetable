import { SCHOOLS, buildYearMap, resolveYears, resolveSections, shouldShowProgram, shouldShowSection } from './schools.js?v=2026-08-06-012';
import { getNavState, setNavState, getStoredElectives, setStoredElectives, getStoredOfferings, setStoredOffering } from './storage.js?v=2026-08-06-012';

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

    state = { school, program, year: yearConfig, section, yearConfig, electives: loadElectivesForYear(yearConfig), offeringSelections: loadOfferingsForYear(yearConfig) };
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

    state = { school, program, year: yearConfig, section, yearConfig, electives: loadElectivesForYear(yearConfig), offeringSelections: loadOfferingsForYear(yearConfig) };
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

    state = { ...state, program, year: yearConfig, section, yearConfig, electives: loadElectivesForYear(yearConfig), offeringSelections: loadOfferingsForYear(yearConfig) };
    persist();
    emit();
}

/**
 * Navigate to a new year within the current school/program.
 * Restores the saved section for the target year if available.
 */
export function navigateToYear(yearId) {
    const school = state.school;
    const program = state.program;
    if (!school) return;

    const yearConfig = resolveYearConfig(school, program, yearId);
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

    state = { ...state, year: yearConfig, section, yearConfig, electives: loadElectivesForYear(yearConfig), offeringSelections: loadOfferingsForYear(yearConfig) };
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
    return SCHOOLS;
}

export function availablePrograms() {
    return state.school?.programs || [];
}

export function availableYears() {
    if (!state.school) return [];
    return state.program
        ? (state.program.years || [])
        : (state.school.years || []);
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

export function getElectives() {
    return state.year?.electives || null;
}

export function getParserType() {
    return state.year?.parser || 'grid';
}
