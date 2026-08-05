import { SCHOOLS, buildYearMap, resolveYears, resolveSections, shouldShowProgram, shouldShowSection } from './schools.js?v=2026-08-06-001';
import { getNavState, setNavState } from './storage.js?v=2026-08-06-001';

/**
 * Navigation state management.
 *
 * Tracks the current position in the school → program → year → section
 * hierarchy. On every change the module persists the selection and emits
 * a `navchange` CustomEvent so the UI and data layers can react.
 */

let state = {
    school: null,
    program: null,
    year: null,
    section: null,
    yearConfig: null,
};

const yearMap = buildYearMap();

// --- Accessors ---

export function getSchool() { return state.school; }
export function getProgram() { return state.program; }
export function getYear() { return state.year; }
export function getSection() { return state.section; }
export function getYearConfig() { return state.yearConfig; }
export function getState() { return { ...state }; }

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

    state = { school, program, year: yearConfig, section, yearConfig };
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

    state = { school, program, year: yearConfig, section, yearConfig };
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

    state = { ...state, program, year: yearConfig, section, yearConfig };
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

    state = { ...state, year: yearConfig, section, yearConfig };
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

export function getTrackedCourses() {
    return state.year?.trackedCourses || null;
}

export function getParserType() {
    return state.year?.parser || 'grid';
}
