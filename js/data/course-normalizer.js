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

// ---------------------------------------------------------------------------
// Course registry.
//
// Each entry: canonical slug · display name · observed aliases.
// The aliases are the real representations found in the timetable data.
// ---------------------------------------------------------------------------

const COURSE_DEFINITIONS = [
    // SCDS Year 2 lectures + electives (sheet: AB2-101/202/203/205/207, AB1-MOOT COURT HALL)
    { canonical: 'web-technology', display: 'Web Technology' },
    { canonical: 'linear-algebra', display: 'Linear Algebra' },
    { canonical: 'design-and-analysis-of-algorithms', display: 'Design and Analysis of Algorithms', aliases: ['DAA', 'Design and analysis of algorithms'] },
    { canonical: 'foundation-of-data-engineering', display: 'Foundation of Data Engineering', aliases: ['FDE'] },
    { canonical: 'intelligent-embedded-systems', display: 'Intelligent Embedded Systems', aliases: ['INT EMB', 'INTT EMB'] },
    { canonical: 'emerging-tools-and-applications', display: 'Emerging Tools and Applications', aliases: ['ET', 'Emerging Tools'] },

    // SCDS Year 3 (sheet: Sem 5 / Sem 7 marker columns)
    { canonical: 'deep-learning', display: 'Deep Learning', aliases: ['DL'] },
    { canonical: 'theory-of-computation', display: 'Theory of Computation', aliases: ['TOC'] },
    { canonical: 'quantum-machine-learning', display: 'Quantum Machine Learning', aliases: ['QML'] },
    { canonical: 'computer-organization-and-architecture', display: 'Computer Organization and Architecture', aliases: ['COA'] },
    { canonical: 'computer-networks', display: 'Computer Networks', aliases: ['CN'] },
    { canonical: 'cyber-security', display: 'Cybersecurity: Fundamental Concepts and Management', aliases: ['CYBER', 'Cyber'] },
    { canonical: 'introduction-to-financial-accounting', display: 'Introduction to Financial Accounting', aliases: ['IFA'] },
    { canonical: 'critical-thinking', display: 'Critical Thinking', aliases: ['CT'] },
    { canonical: 'financial-reporting-and-analysis', display: 'Financial Reporting and Analysis' },
    { canonical: 'organizational-psychology', display: 'Organizational Psychology', aliases: ['Organizational Psychology - Micro Perspective'] },
    { canonical: 'human-ai-interaction', display: 'Human AI Interaction' },
    { canonical: 'forensic-psychology', display: 'Forensic Psychology' },
    { canonical: 'fundamentals-of-business-organization-and-management', display: 'Fundamentals of Business Organization & Management', aliases: ['FBO', 'FOB'] },
    { canonical: 'community-psychology', display: 'Community Psychology' },

    // SOAI Year 2 (sheet: AB1-101 / AB1-104 columns)
    { canonical: 'differential-equations', display: 'Differential Equations' },
    { canonical: 'frontiers-of-machine-learning', display: 'Frontiers of Machine Learning' },
    { canonical: 'discrete-mathematics', display: 'Discrete Mathematics', aliases: ['Discrete Mathematics & Set Theory'] },
    { canonical: 'image-processing', display: 'Image Processing' },

    // SOB BBA Year 2 (sheet: AB2-211 / AB1-103 columns)
    { canonical: 'corporate-and-business-law', display: 'Corporate and Business Law' },
    { canonical: 'operations-research', display: 'Operations Research' },
    { canonical: 'human-resource-management', display: 'Human Resource Management' },
    { canonical: 'principles-in-financial-management', display: 'Principles in Financial Management' },
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
