/**
 * Query Parser — detects explicit timetable group references in natural language.
 *
 * When a user asks "When is SOAI free?" while viewing SCDS, the parser
 * extracts SOAI as the target group. This allows the AI backend to fetch
 * and use the correct timetable data instead of defaulting to the UI selection.
 *
 * Priority logic:
 *   1. EXPLICIT USER REQUEST (query context) — highest
 *   2. CURRENT UI SELECTION (fallback context)
 *   3. Ask for clarification — only if neither exists
 */

import { SCHOOLS } from './schools.js?v=2026-08-30-001';

// School short names → config ids. Order matters: longer names first to avoid
// partial matches (e.g. "SCDS" before "SCD").
const SCHOOL_ALIASES = buildSchoolAliasMap();

function buildSchoolAliasMap() {
    const map = new Map();
    for (const school of SCHOOLS) {
        // Exact shortName match (e.g. "SCDS", "SOAI", "SOB", "SOT", "SAS")
        map.set(school.shortName.toUpperCase(), school.id);
        // Full name match (e.g. "School of Computing and Data Sciences")
        if (school.id === 'scds') {
            map.set('SCHOOL OF COMPUTING AND DATA SCIENCES', 'scds');
            map.set('COMPUTING', 'scds');
            map.set('DATA SCIENCES', 'scds');
        } else if (school.id === 'soai') {
            map.set('SCHOOL OF ARTIFICIAL INTELLIGENCE', 'soai');
            map.set('ARTIFICIAL INTELLIGENCE', 'soai');
        } else if (school.id === 'sob') {
            map.set('SCHOOL OF BUSINESS', 'sob');
            map.set('BUSINESS', 'sob');
        } else if (school.id === 'sot') {
            map.set('SCHOOL OF TECHNOLOGY', 'sot');
            map.set('TECHNOLOGY', 'sot');
            map.set('BIOTECHNOLOGY', 'sot');
        } else if (school.id === 'sas') {
            map.set('SCHOOL OF SCIENCES', 'sas');
            map.set('SCIENCES', 'sas');
            map.set('NEUROSCIENCE', 'sas');
            map.set('PSYCHOLOGY', 'sas');
        }
    }
    return map;
}

// "Section 3", "Sec 2", "section-5", etc.
const SECTION_RE = /\b(?:sec(?:tion)?)[\s\-]*(\d+|bba|b\.com|bcom)\b/i;

// "Year 2", "Year 3", "yr 2", etc.
const YEAR_RE = /\b(?:year|yr)[\s\-]*(\d+)\b/i;

// "both X and Y", "X and Y", "X & Y" — for multi-group queries
const BOTH_RE = /\bboth\b/i;
const AND_RE = /\s+and\s+|\s*&\s*/i;

/**
 * Extract explicit school/section/year mentions from a question.
 *
 * Returns:
 *   {
 *     groups: Array<{ school: string|null, section: string|number|null, year: number|null }>,
 *     hasExplicitGroup: boolean,
 *     rawMentions: string[]
 *   }
 *
 * Each group represents one timetable the user is asking about. When no
 * explicit group is found, `groups` is empty and `hasExplicitGroup` is false
 * — the caller should fall back to the UI context.
 */
export function detectQueryGroups(question) {
    const q = String(question || '').trim();
    if (!q) return { groups: [], hasExplicitGroup: false, rawMentions: [] };

    const upper = q.toUpperCase();
    const rawMentions = [];

    // --- Detect schools ---
    // Deduplicate by schoolId to avoid counting the same school twice
    // (e.g. "SOAI" + "ARTIFICIAL INTELLIGENCE" should be one group).
    const detectedSchoolMap = new Map();
    for (const [alias, schoolId] of SCHOOL_ALIASES) {
        if (upper.includes(alias)) {
            if (!detectedSchoolMap.has(schoolId)) {
                detectedSchoolMap.set(schoolId, alias);
                rawMentions.push(alias);
            }
        }
    }
    const detectedSchools = [...detectedSchoolMap.entries()].map(([schoolId, alias]) => ({ schoolId, alias }));

    // --- Detect sections ---
    const sectionMatches = [];
    let m;
    const sectionRe = new RegExp(SECTION_RE.source, 'gi');
    while ((m = sectionRe.exec(q)) !== null) {
        const raw = m[1].toLowerCase();
        let section;
        if (raw === 'bba') section = 'BBA';
        else if (raw === 'b.com' || raw === 'bcom') section = 'B.Com';
        else section = parseInt(raw, 10);
        sectionMatches.push(section);
        rawMentions.push(m[0]);
    }

    // --- Detect years ---
    const yearMatches = [];
    const yearRe = new RegExp(YEAR_RE.source, 'gi');
    while ((m = yearRe.exec(q)) !== null) {
        yearMatches.push(parseInt(m[1], 10));
        rawMentions.push(m[0]);
    }

    // --- Build groups ---
    // If we detected multiple schools (e.g. "SCDS and SOAI"), create one
    // group per school. If we detected one school + multiple sections, create
    // one group per section. If no school is detected, sections apply to the
    // current UI school.
    const groups = [];

    if (detectedSchools.length > 1) {
        // Multiple schools: one group per school
        for (const { schoolId } of detectedSchools) {
            groups.push({
                school: schoolId,
                section: sectionMatches.length === 1 ? sectionMatches[0] : null,
                year: yearMatches.length === 1 ? yearMatches[0] : null,
            });
        }
    } else if (detectedSchools.length === 1) {
        const schoolId = detectedSchools[0].schoolId;
        if (sectionMatches.length > 1) {
            // One school, multiple sections: one group per section
            for (const sec of sectionMatches) {
                groups.push({ school: schoolId, section: sec, year: yearMatches.length === 1 ? yearMatches[0] : null });
            }
        } else if (sectionMatches.length === 1) {
            groups.push({ school: schoolId, section: sectionMatches[0], year: yearMatches.length === 1 ? yearMatches[0] : null });
        } else {
            // School mentioned but no section
            groups.push({ school: schoolId, section: null, year: yearMatches.length === 1 ? yearMatches[0] : null });
        }
    } else if (sectionMatches.length > 0) {
        // Sections mentioned but no school — apply to current UI school
        for (const sec of sectionMatches) {
            groups.push({ school: null, section: sec, year: yearMatches.length === 1 ? yearMatches[0] : null });
        }
    } else if (yearMatches.length > 0) {
        // Year mentioned but no school/section
        groups.push({ school: null, section: null, year: yearMatches[0] });
    }

    const hasExplicitGroup = groups.length > 0 && (detectedSchools.length > 0 || sectionMatches.length > 0 || yearMatches.length > 0);

    return { groups, hasExplicitGroup, rawMentions: [...new Set(rawMentions)] };
}

/**
 * Resolve detected query groups against the SCHOOLS config to find the
 * matching year configs. Returns an array of resolved group descriptors:
 *
 *   { school, yearConfig, section, label }
 *
 * Unresolved groups (e.g. school not found) are silently dropped. If a
 * section is specified but the year has no sections, the section is ignored
 * and the whole year is used.
 */
export function resolveQueryGroups(detectedGroups, uiContext = {}) {
    const resolved = [];

    for (const g of detectedGroups) {
        const schoolId = g.school || uiContext.school;
        if (!schoolId) continue;

        const school = SCHOOLS.find(s => s.id === schoolId);
        if (!school) continue;

        // Find matching year config
        let yearConfig = null;
        if (g.year != null) {
            // Find year by level
            const allYears = getAllYears(school);
            yearConfig = allYears.find(y => y.level === g.year) || null;
        } else {
            // Use UI year level as default
            const uiYearLevel = uiContext.yearLevel || null;
            if (uiYearLevel != null) {
                const allYears = getAllYears(school);
                yearConfig = allYears.find(y => y.level === uiYearLevel) || null;
            }
            // Fall back to first year
            if (!yearConfig) {
                const allYears = getAllYears(school);
                yearConfig = allYears[0] || null;
            }
        }

        if (!yearConfig) continue;

        // Resolve section
        let section = g.section || uiContext.section || null;
        const sections = yearConfig.sections || [];
        if (sections.length > 0 && section != null) {
            // Normalize: numeric sections should match
            if (!sections.includes(section)) {
                // Try string comparison
                const strSec = String(section);
                if (!sections.some(s => String(s) === strSec)) {
                    section = sections[0]; // Fall back to first section
                }
            }
        } else if (sections.length > 0 && section == null) {
            section = uiContext.section || sections[0];
        }

        resolved.push({
            school: school,
            yearConfig: yearConfig,
            section: section,
            label: buildGroupLabel(school, yearConfig, section),
        });
    }

    return resolved;
}

function getAllYears(school) {
    const years = [];
    if (school.programs) {
        for (const program of school.programs) {
            for (const year of program.years) years.push(year);
        }
    }
    if (school.years) {
        for (const year of school.years) years.push(year);
    }
    return years;
}

function buildGroupLabel(school, yearConfig, section) {
    const parts = [school.shortName];
    if (yearConfig.label) parts.push(yearConfig.label);
    if (section != null && yearConfig.sections && yearConfig.sections.length > 1) {
        parts.push(`Section ${section}`);
    }
    return parts.join(' ');
}
