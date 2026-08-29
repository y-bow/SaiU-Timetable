/**
 * Deterministic course canonicalization.
 *
 * Every class record the app produces carries a stable canonical course id.
 * The same course can appear in the sheets under different abbreviations,
 * casing, spacing, punctuation or naming conventions; this module folds any
 * raw course string to a canonical slug so the parser and the smart change
 * detector always agree on "which course is this".
 *
 * The alias table is DATA-DRIVEN: the entries below were read out of the live
 * SCDS / SOAI / SOB timetable sheets (see js/data/schools.js) and the Year 2
 * lab tabs (see js/data/lab-config.js) at development time. No AI runs at
 * runtime — this is pure deterministic mapping. scripts/audit-courses.mjs
 * reproduces the alias table from the real sheets for verification.
 *
 * Pipeline:
 *
 *     RAW COURSE NAME   ("DL", "Emerging Tools", "Discrete Mathematics & Set Theory")
 *         │
 *         ▼ foldCourseText()   lowercase · "&"→"and" · camel-case split ·
 *                              punctuation→space · collapse whitespace
 *         ▼ alias lookup       exact folded-key match against COURSE_DEFINITIONS
 *         ▼ canonical slug     ("deep-learning", "discrete-mathematics", ...)
 *
 * Matching is deliberately STRICT:
 *   - an exact folded match (display name OR explicit alias) wins,
 *   - an input that folds to no known key is UNMATCHED — never fuzzy-matched,
 *   - an input that folds to more than one known course is AMBIGUOUS and is
 *     reported via getCourseAuditReport(), never guessed.
 * This keeps "Computer Networks" and "Computer Organization and Architecture"
 * distinct even though both contain the word "Computer", and it never lets
 * "Data Structures" collide with "Advanced Data Structures".
 *
 * Labs keep their own identity: lab parsers slug the lab course names
 * ("... Lab"), so a lecture and its lab never collapse into one record.
 */

// ---------------------------------------------------------------------------
// Generic, deterministic text folding.
// ---------------------------------------------------------------------------

/**
 * Fold a raw course string into a canonical comparison key.
 * Handles casing, leading/trailing/repeated whitespace, "&" vs "and",
 * hyphens/underscores/punctuation, and camel-case runs like "DeepLearning".
 */
export function foldCourseText(raw) {
    return String(raw ?? '')
        .replace(/([a-z])([A-Z])/g, '$1 $2') // camel-case split BEFORE lowercasing ("DeepLearning")
        .toLowerCase()
        .replace(/&/g, ' and ')              // "R&D" / "R & D" → "r and d"
        .replace(/[^a-z0-9]+/g, ' ')         // punctuation/hyphens/underscores → space
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Canonical slug for a course string. Unmatched courses fall back to this
 * generic slug so change detection still has a stable identity for them.
 */
export function slugifyCourse(raw) {
    return foldCourseText(raw).replace(/\s+/g, '-');
}

/**
 * Classify a raw course name as a lab variant.
 *
 * Only a name that itself ends with a " Lab" / "Lab." suffix is a lab. The
 * suffix is a DISPLAY/CLASSIFICATION property, never part of the course's base
 * identity — so "Some Course Lab" is the lab of "Some Course". Matching is
 * exact (the whole name must end with the suffix), never partial/prefix, so a
 * normal course is never flagged because another course shares its prefix
 * ("Emering Tools" never becomes a lab because "Emering Tools Lab" exists).
 *
 * @param {string} raw a raw course name
 * @returns {{ base: string, isLab: boolean }} base name and lab flag
 */
export function splitLabSuffix(raw) {
    const text = String(raw ?? '').trim();
    const m = text.match(/^(.*\S)\s+Lab\.?$/i);
    return m ? { base: m[1].trim(), isLab: true } : { base: text, isLab: false };
}

// ---------------------------------------------------------------------------
// Course registry.
//
// Each entry: canonical slug · display name · observed aliases.
// The aliases are the real representations found in the timetable data.
// ---------------------------------------------------------------------------

const COURSE_DEFINITIONS = [
    // SCDS Year 1 mandatory courses (no sections)
    { canonical: 'programming-in-c', display: 'Programming in C', aliases: ['PIC', 'Programming in C'] },
    { canonical: 'engineering-foundation-and-application', display: 'Engineering Foundation and Application', aliases: ['EFA', 'Engineering Foundation and Application'] },
    { canonical: 'applied-mathematics', display: 'Applied Mathematics', aliases: ['AM', 'Applied Mathematics'] },
    // "Critical Thinking" and "Frontiers of AI" are already registered below
    // (shared across SCDS Year 3 / SOT / SOB / SOAI).

    // SCDS Year 2 lectures + electives (sheet: AB2-101/202/203/205/207, AB1-MOOT COURT HALL)
    { canonical: 'web-technology', display: 'Web Technology' },
    { canonical: 'linear-algebra', display: 'Linear Algebra' },
    { canonical: 'design-and-analysis-of-algorithms', display: 'Design and Analysis of Algorithms', aliases: ['DAA', 'Design and analysis of algorithms'] },
    { canonical: 'foundation-of-data-engineering', display: 'Foundation of Data Engineering', aliases: ['FDE'] },
    { canonical: 'intelligent-embedded-systems', display: 'Intelligent Embedded Systems', aliases: ['INT EMB', 'INTT EMB'] },
    { canonical: 'emerging-tools-and-applications', display: 'Emering Tools and Applications', aliases: ['ET', 'Emerging Tools', 'Emerging Tools and Applications', 'Emering Tools and Applications'] },
    // The Year 2 "Emg Lab" tab is the lab of the Emerging Tools course. Its own
    // canonical id keeps it distinct from the lecture (lecture + lab never
    // collapse into one record); "… Lab" is a classification/display property.
    { canonical: 'emerging-tools-lab', display: 'Emering Tools and Applications Lab', aliases: ['Emerging Tools Lab', 'Emering Tools Lab', 'ET Lab'] },

    // SCDS Year 3 (sheet: Sem 5 / Sem 7 marker columns)
    { canonical: 'deep-learning', display: 'Deep Learning', aliases: ['DL'] },
    { canonical: 'theory-of-computation', display: 'Theory of Computation', aliases: ['TOC'] },
    { canonical: 'quantum-machine-learning', display: 'Quantum Machine Learning', aliases: ['QML'] },
    { canonical: 'computer-organization-and-architecture', display: 'Computer Organization and Architecture', aliases: ['COA'] },
    { canonical: 'computer-networks', display: 'Computer Networks', aliases: ['CN'] },
    { canonical: 'cyber-security', display: 'Cybersecurity: Fundamental Concepts and Management', aliases: ['CYBER', 'Cyber'] },
    { canonical: 'introduction-to-financial-accounting', display: 'Introduction to Financial Accounting', aliases: ['IFA'] },
    { canonical: 'critical-thinking', display: 'Critical Thinking', aliases: ['CT', 'Critical Thinking (SAS/SoAI/SoB/SoT/SCDS)'] },
    { canonical: 'financial-reporting-and-analysis', display: 'Financial Reporting and Analysis' },
    { canonical: 'organizational-psychology', display: 'Organizational Psychology', aliases: ['Organizational Psychology - Micro Perspective'] },
    { canonical: 'human-ai-interaction', display: 'Human AI Interaction' },
    { canonical: 'forensic-psychology', display: 'Forensic Psychology' },
    { canonical: 'fundamentals-of-business-organization-and-management', display: 'Fundamentals of Business Organization & Management', aliases: ['FBO', 'FOB'] },
    { canonical: 'community-psychology', display: 'Community Psychology' },
    { canonical: 'conflict-in-contemporary-international-relations', display: 'Conflicts in Contemporary International Relations', aliases: ['CCIR', 'Conflict in Contemporary International Relations', 'Conflicts in Contemporary International Relations'] },

    // SOAI Year 2 (sheet: AB1-101 / AB1-104 columns)
    { canonical: 'differential-equations', display: 'Differential Equations' },
    { canonical: 'frontiers-of-machine-learning', display: 'Frontiers of Machine Learning' },
    { canonical: 'discrete-mathematics', display: 'Discrete Mathematics', aliases: ['Discrete Mathematics & Set Theory'] },
    { canonical: 'image-processing', display: 'Image Processing' },
    { canonical: 'digital-healthcare', display: 'Digital Healthcare' },

    // SOB BBA Year 1 (sheet: AB2-211 / AB1-103 columns)
    { canonical: 'fundamentals-of-business', display: 'Fundamentals of Business' },
    { canonical: 'financial-management', display: 'Financial Management' },
    { canonical: 'business-mathematics-and-stats', display: 'Business Mathematics and Stats' },

    // SOB BBA Year 2 (sheet: AB2-211 / AB1-103 columns)
    { canonical: 'corporate-and-business-law', display: 'Corporate and Business Law' },
    { canonical: 'operations-research', display: 'Operations Research' },
    { canonical: 'human-resource-management', display: 'Human Resource Management' },
    { canonical: 'principles-in-financial-management', display: 'Principles of Financial Management', aliases: ['PFM', 'PIFM', 'Principles in Financial Management', 'Principles of Financial Management', 'Introduction to BFSI & Financial Technology', 'Principles of Financial Management / Introduction to BFSI & Financial Technology'] },

    // SOT Biotechnology (shared grid sheet). "Critical Thinking" is
    // already registered above (SCDS Year 3); "Frontiers of AI" and
    // "Operations Research" are shared courses registered above (SOT Year 1 /
    // SOB Year 2). The sheet may spell the Year 1 semester-tagged courses with
    // a " - Sem1" / "Sem1" / "Sem 1" suffix; the aliases fold those spellings
    // onto the clean course names (the semester tag is dropped from the course
    // identity).
    { canonical: 'chemistry', display: 'Chemistry' },
    { canonical: 'general-mathematics', display: 'General Mathematics' },
    { canonical: 'fundamentals-of-biotechnology', display: 'Fundamentals of Biotechnology' },
    { canonical: 'indian-constitution-and-democracy', display: 'Indian Constitution & Democracy', aliases: ['Indian Constitution & Democracy - Sem1', 'ICD'] },
    { canonical: 'frontiers-of-ai', display: 'Frontiers of AI', aliases: ['Frontiers of AI Sem1'] },
    { canonical: 'chemical-engineering', display: 'Chemical Engineering' },
    { canonical: 'basic-chemical-engineering', display: 'Basic Chemical Engineering', aliases: ['Basic Chemical Engg', 'Basic Chem Engg'] },
    { canonical: 'environmental-biotechnology', display: 'Environmental Biotechnology' },
    { canonical: 'microbiology', display: 'Microbiology' },

    // SAS Year 2 Biological Sciences
    { canonical: 'applied-biological-sciences', display: 'Applied Biological Sciences' },

    // SAS Year 3 Neuroscience (shared grid sheet)
    { canonical: 'biostatistics', display: 'Biostatistics' },
    // The earlier sheet spelling "Cell Physiology - Elective" (dash + suffix)
    // is kept as an alias so it still resolves to this course instead of being
    // mis-split into a subject + a teacher named "Elective".
    { canonical: 'cell-physiology', display: 'Cell Physiology', aliases: ['Cell Physiology - Elective'] },
    { canonical: 'clinical-neuroscience', display: 'Clinical Neuroscience' },
    { canonical: 'molecular-neuroscience', display: 'Molecular Neuroscience' },
    // The live sheet spells this course "Analytical Methods & Instrumentation";
    // the alias folds it onto the configured "Analytical Methods" identity so
    // the courseId stays stable and change detection never sees a rename.
    { canonical: 'analytical-methods', display: 'Analytical Methods', aliases: ['Analytical Methods & Instrumentation'] },
    { canonical: 'psychiatry-and-mood-disorders', display: 'Psychiatry & Mood disorders' },

    // SAS Year 2 Psychology
    { canonical: 'psychopathology', display: 'Psychopathology', aliases: ['Psychopathology I', 'Psychopathology II'] },
    // 'community-psychology' is already registered above (SCDS Year 3 elective).
    { canonical: 'psychology-behind-social-media', display: 'Psychology Behind Social Media', aliases: ['Psych Behind Social Media', 'Psychology of Social Media'] },
    { canonical: 'introduction-to-cognitive-neuroscience', display: 'Introduction to Cognitive Neuroscience', aliases: ['Intro to Cognitive Neuroscience', 'Cognitive Neuroscience'] },
    { canonical: 'research-methodology', display: 'Research Methodology', aliases: ['Research Methods'] },
];

// ---------------------------------------------------------------------------
// Per-school alias overrides.
//
// The registry above is school-agnostic — no abbreviation currently means
// different things in different schools. If a school ever uses an alias that
// could collide with another school's course, register it here:
//     'my-school': { 'intt emb': 'intelligent-embedded-systems' }
// School-scoped hits win over the global index.
// ---------------------------------------------------------------------------

const SCHOOL_ALIAS_OVERRIDES = {
    // 'scds': { 'et': 'emerging-tools-and-applications' },
};

const defByCanonical = new Map(COURSE_DEFINITIONS.map((d) => [d.canonical, d]));

function buildIndex(defs) {
    const index = new Map(); // foldedKey -> [{ canonical, display }]
    const push = (key, entry) => {
        if (!key) return;
        if (!index.has(key)) index.set(key, []);
        const arr = index.get(key);
        if (!arr.some((e) => e.canonical === entry.canonical)) arr.push(entry);
    };
    for (const def of defs) {
        const entry = { canonical: def.canonical, display: def.display };
        push(foldCourseText(def.display), entry);
        for (const alias of def.aliases || []) push(foldCourseText(alias), entry);
    }
    return index;
}

const COURSE_INDEX = buildIndex(COURSE_DEFINITIONS);

/**
 * Resolve a raw course string to its canonical identity.
 *
 * @param {string} raw       raw course text as found in the timetable
 * @param {string} [schoolId] optional school id; school-scoped aliases win
 * @returns {{
 *   canonical: string|null, display: string, matched: boolean,
 *   ambiguous: boolean, candidates: Array<{canonical, display}>
 * }|null}
 *   null only for empty/whitespace-only input. `canonical` is null when the
 *   input is ambiguous (never guessed). `display` is the human-readable name
 *   of the resolved course, or the trimmed raw text when unmatched.
 */
export function resolveCourse(raw, schoolId = null) {
    const key = foldCourseText(raw);
    if (!key) return null;

    let hits = [];
    if (schoolId && SCHOOL_ALIAS_OVERRIDES[schoolId]) {
        const scopedCanonical = SCHOOL_ALIAS_OVERRIDES[schoolId].get(key);
        if (scopedCanonical) {
            const def = defByCanonical.get(scopedCanonical);
            hits = def ? [{ canonical: def.canonical, display: def.display }] : [];
        }
    }
    if (!hits.length) hits = COURSE_INDEX.get(key) || [];

    if (hits.length === 0) {
        return {
            canonical: slugifyCourse(key),
            display: String(raw ?? '').trim(),
            matched: false,
            ambiguous: false,
            candidates: [],
        };
    }

    const distinct = [];
    for (const h of hits) {
        if (!distinct.some((d) => d.canonical === h.canonical)) distinct.push(h);
    }

    if (distinct.length > 1) {
        return {
            canonical: null,
            display: String(raw ?? '').trim(),
            matched: false,
            ambiguous: true,
            candidates: distinct.map((d) => ({ canonical: d.canonical, display: d.display })),
        };
    }

    return {
        canonical: distinct[0].canonical,
        display: distinct[0].display,
        matched: true,
        ambiguous: false,
        candidates: [],
    };
}

/**
 * Build the per-parse course context from a year config's course lists.
 *
 * @param {string[]} [mandatoryCourses] full course names every student attends
 * @param {Array<{id, label}>} [electives] elective configs (id + label)
 * @returns {{
 *   known: Set<string>,            every canonical id this year offers
 *   mandatory: Set<string>,        canonical ids of the mandatory courses
 *   electiveByCanonical: Map<string, object>, canonical -> elective config
 *   hasFilter: boolean             whether a course filter applies at all
 * }}
 */
export function buildYearCourseContext(mandatoryCourses = null, electives = null) {
    const ctx = {
        known: new Set(),
        mandatory: new Set(),
        electiveByCanonical: new Map(),
        hasFilter: !!((mandatoryCourses && mandatoryCourses.length) || (electives && electives.length)),
    };
    for (const m of mandatoryCourses || []) {
        const res = resolveCourse(m);
        if (res && !res.ambiguous && res.canonical) {
            ctx.known.add(res.canonical);
            ctx.mandatory.add(res.canonical);
        }
    }
    for (const e of electives || []) {
        const res = resolveCourse(e.label);
        if (res && !res.ambiguous && res.canonical) {
            ctx.known.add(res.canonical);
            ctx.electiveByCanonical.set(res.canonical, e);
        }
    }
    return ctx;
}

// ---------------------------------------------------------------------------
// Development-time audit: canonical course → observed representations.
//
// Off by default (no production logging). Enable with `?audit=1` in the app
// or from the audit script; observations are then recorded while parsing and
// can be dumped with getCourseAuditReport() / printCourseAuditReport().
// ---------------------------------------------------------------------------

let auditEnabled = false;
const audit = new Map(); // canonical -> { display, forms: Map(raw -> {count, schools}) }

export function enableCourseAudit(enabled = true) {
    auditEnabled = !!enabled;
    if (!auditEnabled) audit.clear();
}

export function isCourseAuditEnabled() {
    return auditEnabled;
}

/**
 * Record that a raw subject string was observed resolving to a course.
 * `resolved` is the object returned by resolveCourse (or a compatible
 * { canonical, display } for lab records).
 */
export function recordCourseObservation(raw, resolved, schoolId = null) {
    if (!auditEnabled) return;
    const rawKey = String(raw ?? '').trim();
    if (!rawKey) return;
    const ok = resolved && !resolved.ambiguous && resolved.canonical;
    const canonical = ok ? resolved.canonical : '(unmatched / ambiguous)';
    const display = ok ? resolved.display : rawKey;

    let entry = audit.get(canonical);
    if (!entry) {
        entry = { display, forms: new Map() };
        audit.set(canonical, entry);
    }
    let form = entry.forms.get(rawKey);
    if (!form) {
        form = { count: 0, schools: new Set() };
        entry.forms.set(rawKey, form);
    }
    form.count += 1;
    if (schoolId) form.schools.add(schoolId);
}

/** Ordered list of canonical → observed forms (development/debug tooling). */
export function getCourseAuditReport() {
    const rows = [];
    for (const [canonical, entry] of audit) {
        const forms = [...entry.forms.entries()]
            .sort((a, b) => b[1].count - a[1].count)
            .map(([text, f]) => ({ text, count: f.count, schools: [...f.schools].sort() }));
        rows.push({ canonical, display: entry.display, forms });
    }
    return rows.sort((a, b) => (a.canonical < b.canonical ? -1 : a.canonical > b.canonical ? 1 : 0));
}

/** Print the audit report to the console (dev only — never call in prod). */
export function printCourseAuditReport() {
    const report = getCourseAuditReport();
    if (typeof console === 'undefined' || !console) return report;
    if (typeof console.groupCollapsed === 'function') console.groupCollapsed(`[course-audit] ${report.length} canonical course(s)`);
    for (const r of report) {
        console.log(`${r.canonical}  (${r.display})`);
        for (const f of r.forms) {
            console.log(`    - "${f.text}"  ×${f.count}${f.schools.length ? `  [${f.schools.join(', ')}]` : ''}`);
        }
    }
    if (typeof console.groupEnd === 'function') console.groupEnd();
    return report;
}
