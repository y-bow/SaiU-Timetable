/**
 * Multi-school configuration.
 *
 * Each school defines its hierarchy:
 *
 *     school → program (optional) → year → section (optional)
 *              → mandatory courses → elective courses
 *
 * The UI reads this tree and automatically renders the correct selectors —
 * no hardcoded UI changes are needed when a new school is added.
 *
 * Course lists (per year):
 *   - mandatoryCourses: unsectioned courses that every student attends.
 *     Used for formats where the class has no `(Sec N)` label but still
 *     belongs to the year (e.g. SOAI / SOB). Optional.
 *   - electives: optional courses chosen individually by each student
 *     (zero, one, or many). Students pick them in the sidebar and the
 *     timetable merges the selected electives with the mandatory classes.
 *     Each elective needs a stable `id` and a `label` that matches the
 *     course name in the timetable data.
 *
 * Adding a school = editing this file. No UI code changes required.
 */

export const SCHOOLS = [
    {
        id: 'scds',
        shortName: 'SCDS',
        programs: null,
        years: [
            {
                id: 'scds-2',
                label: 'Year 2',
                level: 2,
                sections: [1, 2, 3, 4, 5, 6, 7],
                sheetId: '1Jk3KCLqHHzi-jxigIcPpcXZestcxb8Y0BeQLjhiezb8',
                gid: '0',
                parser: 'grid',
                mandatoryCourses: null,
                electives: [
                    { id: 'intelligent-embedded-systems', label: 'Intelligent Embedded Systems' },
                    { id: 'emerging-tools-and-applications', label: 'Emerging Tools and Applications' },
                ],
            },
            {
                id: 'scds-3',
                label: 'Year 3',
                level: 3,
                sections: null,
                sheetId: '1Jk3KCLqHHzi-jxigIcPpcXZestcxb8Y0BeQLjhiezb8',
                gid: '0',
                parser: 'grid',
                mandatoryCourses: [
                    'Deep Learning',
                    'Theory of Computation',
                ],
                electives: [
                    { id: 'quantum-machine-learning', label: 'Quantum Machine Learning' },
                    { id: 'cyber-security', label: 'Cybersecurity: Fundamental Concepts and Management' },
                    { id: 'computer-networks', label: 'Computer Networks' },
                    { id: 'financial-reporting-and-analysis', label: 'Financial Reporting and Analysis' },
                    { id: 'organizational-psychology', label: 'Organizational Psychology' },
                    { id: 'computer-organization-and-architecture', label: 'Computer Organization and Architecture' },
                    { id: 'human-ai-interaction', label: 'Human AI Interaction' },
                ],
            },
        ],
    },
    {
        id: 'soai',
        shortName: 'SOAI',
        programs: null,
        years: [
            {
                id: 'soai-2',
                label: 'Year 2',
                level: 2,
                sections: null,
                sheetId: '1Jk3KCLqHHzi-jxigIcPpcXZestcxb8Y0BeQLjhiezb8',
                gid: '0',
                parser: 'grid',
                mandatoryCourses: [
                    'Differential Equations',
                    'Frontiers of Machine Learning',
                    'Discrete Mathematics',
                    'Image Processing',
                    'Human AI Interaction',
                ],
                electives: [
                    { id: 'intelligent-embedded-systems', label: 'Intelligent Embedded Systems' },
                ],
            },
        ],
    },
    {
        id: 'sob',
        shortName: 'SOB',
        programs: [
            {
                id: 'bba',
                label: 'BBA',
                years: [
                    {
                        id: 'sob-bba-2',
                        label: 'Year 2',
                        level: 2,
                        sections: null,
                        sheetId: '1Jk3KCLqHHzi-jxigIcPpcXZestcxb8Y0BeQLjhiezb8',
                        gid: '0',
                        parser: 'grid',
                        mandatoryCourses: [
                            'Corporate and Business Law',
                            'Operations Research',
                            'Human Resource Management',
                            'Principles in Financial Management',
                        ],
                        electives: null,
                    },
                ],
            },
        ],
        years: null,
    },
];

/**
 * Flatten the school tree into a lookup map keyed by year config id.
 * Used by the app to resolve the active timetable source quickly.
 */
export function buildYearMap(schools = SCHOOLS) {
    const map = new Map();
    for (const school of schools) {
        if (school.programs) {
            for (const program of school.programs) {
                for (const year of program.years) {
                    map.set(year.id, { school, program, year });
                }
            }
        }
        if (school.years) {
            for (const year of school.years) {
                map.set(year.id, { school, program: null, year });
            }
        }
    }
    return map;
}

/**
 * Resolve the list of years for a given school and optional program.
 */
export function resolveYears(school, programId) {
    if (school.programs && programId) {
        const program = school.programs.find(p => p.id === programId);
        return program ? program.years : [];
    }
    return school.years || [];
}

/**
 * Resolve the list of sections for a given year config.
 * Returns [] if sections is null (no sections needed).
 */
export function resolveSections(yearConfig) {
    return yearConfig.sections || [];
}

/**
 * Determine whether the program selector should be shown.
 * Hidden when a school has only one program (or none).
 */
export function shouldShowProgram(school) {
    return school.programs && school.programs.length > 1;
}

/**
 * Determine whether the section selector should be shown.
 * Hidden when a year has no sections or exactly one section.
 */
export function shouldShowSection(yearConfig) {
    const sections = resolveSections(yearConfig);
    return sections.length > 1;
}

/**
 * Determine whether a school offers any year at the given level (Year 2,
 * Year 3, …). Used to hide schools that don't have the currently selected
 * year level yet — e.g. when Year 3 is selected, only schools with a Year 3
 * config remain in the school selector.
 */
export function schoolHasLevel(school, level) {
    if (level == null) return true;
    const years = [];
    if (school.programs) {
        for (const program of school.programs) {
            for (const year of program.years) years.push(year);
        }
    }
    if (school.years) {
        for (const year of school.years) years.push(year);
    }
    return years.some(y => y.level === level);
}
