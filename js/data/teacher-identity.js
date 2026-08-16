/**
 * Teacher identity: normalization, matching and canonical aliases.
 *
 * The same teacher can appear in the source sheets under several spellings,
 * titles and name lengths:
 *
 *   "Prof. Mariya"  /  "Prof. Dr. Mariya"    title variant
 *   "Dr. Jemima"    /  "Jemima"              title variant
 *   "Dr. Vigneshwaran" / "Dr. Vigneswaran"   minor spelling variant
 *   "Prof. Roopam"  /  "Prof. Rupam Sah"     phonetic first name + surname
 *   "Ms. Karen"     /  "Ms. Karen P Sneha"   first-name vs full name
 *
 * This module decides which observed names are the SAME person and which are
 * merely similar. It is deliberately conservative — identity is never guessed:
 *
 *   - HIGH confidence pairs (identical after folding, or a one-character
 *     spelling drift with the same leading letter) merge automatically into ONE
 *     canonical identity.
 *   - MEDIUM confidence pairs (first-name-only vs full name, phonetic first
 *     name variants, same first name with a different surname) are NOT merged.
 *     They are surfaced as CONFIRMATION CANDIDATES for a developer/admin.
 *   - LOW pairs stay separate.
 *
 * A first name alone is never proof of identity: "Mariya" and "Mariya Shah"
 * stay separate until a human confirms they are the same person.
 *
 * Confirmed merges live in two places:
 *   1. TEACHER_ALIASES (below) — the permanent, centralized alias config.
 *      Once a merge is confirmed it is written here so every future parse
 *      resolves those names to one identity without asking again.
 *   2. localStorage "tt-teacher-aliases-v1" — per-browser confirmations made
 *      from the teacher page's ?debug panel. Both are applied at index build.
 *
 * Every identity exposes:
 *   canonicalId    stable slug used as the teacher index key / cache key
 *   displayName    the preferred name shown in the UI
 *   aliases        every observed spelling folded into this identity
 *
 * Pure module — no window or localStorage at import time (storage access is
 * wrapped and safely no-ops outside a browser), so it runs identically in the
 * browser and in the Node test harness.
 */

// ---------------------------------------------------------------------------
// Text folding
// ---------------------------------------------------------------------------

// Titles removed for identity comparison only (never from the display name).
// Each title may or may not carry a trailing dot ("Dr.", "Dr ", "Dr. "). A
// plain name that merely STARTS with the letters of a title ("Mridula",
// "Profane") is NOT affected because the trailing \b requires a word boundary
// ("Mridula" has no boundary after "ms" — "i" follows).
const TITLE_RE = /\b(?:prof(?:essor)?\.?|dr\.?|mr\.?|mrs\.?|ms\.?|miss)\b/gi;

/**
 * Fold a teacher name into its comparison key: titles removed, lowercased,
 * punctuation/whitespace collapsed. "Prof. Dr. Mariya" and "Prof. Mariya"
 * both fold to "mariya". Returns '' for empty input.
 */
export function foldTeacherName(raw) {
    return String(raw ?? '')
        .replace(TITLE_RE, ' ')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Space-separated tokens of a folded teacher name. */
export function teacherTokens(raw) {
    return foldTeacherName(raw).split(' ');
}

/** Leading token after folding ("first name" / single given name). */
export function teacherFirstName(raw) {
    return teacherTokens(raw)[0] || '';
}

/** Levenshtein edit distance — how close two folded keys are. */
export function editDistance(a, b) {
    a = String(a ?? '');
    b = String(b ?? '');
    if (a === b) return 0;
    const n = a.length;
    const m = b.length;
    if (!n) return m;
    if (!m) return n;
    let prev = new Array(m + 1);
    let cur = new Array(m + 1);
    for (let j = 0; j <= m; j++) prev[j] = j;
    for (let i = 1; i <= n; i++) {
        cur[0] = i;
        for (let j = 1; j <= m; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        }
        [prev, cur] = [cur, prev];
    }
    return prev[m];
}

/** Consonant skeleton of a word, for loose first-name comparison. */
export function phoneticSkeleton(word) {
    const s = String(word ?? '').toLowerCase().replace(/[^a-z]/g, '');
    let out = '';
    for (const ch of s) {
        if ('aeiou'.includes(ch)) continue;
        out += ch;
    }
    return out;
}

const isSubset = (a, b) => a.every((t) => b.includes(t));

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

/**
 * Decide how confidently two observed teacher names refer to the same person.
 *
 * @param {string} a observed display name (e.g. "Prof. Dr.Vigneshwaran")
 * @param {string} b observed display name
 * @returns {{level: 'high'|'medium'|'low', reason: string}}
 */
export function identityConfidence(a, b) {
    const fa = foldTeacherName(a);
    const fb = foldTeacherName(b);
    if (!fa || !fb) return { level: 'low', reason: 'empty name' };

    if (fa === fb) {
        return { level: 'high', reason: 'identical after folding (title / case / punctuation / whitespace)' };
    }

    // One-character spelling drift with the same leading letter — e.g.
    // "Vigneshwaran" / "Vigneswaran". Strongly the same person.
    if (fa[0] === fb[0] && Math.abs(fa.length - fb.length) <= 1 && editDistance(fa, fb) <= 1) {
        return { level: 'high', reason: 'minor spelling variant' };
    }

    const firstA = teacherFirstName(a);
    const firstB = teacherFirstName(b);

    // First name identical → possible same person. A first-name-only name
    // ("Mariya") against the full name ("Mariya Shah") is a candidate, never a
    // merge, per the no-auto-merge rule. Same first name with different
    // surnames is also only a candidate (e.g. "Surya C" / "Surya Krish").
    if (firstA && firstA === firstB) {
        if (isSubset(teacherTokens(a), teacherTokens(b)) || isSubset(teacherTokens(b), teacherTokens(a))) {
            return { level: 'medium', reason: 'first-name-only vs full name' };
        }
        return { level: 'medium', reason: 'same first name, different surname' };
    }

    // Phonetic first-name variants ("Roopam" / "Rupam") are candidates.
    const skA = phoneticSkeleton(firstA);
    const skB = phoneticSkeleton(firstB);
    if (skA && skA === skB) {
        return { level: 'medium', reason: 'similar first-name spelling' };
    }

    return { level: 'low', reason: 'no identity match' };
}

// ---------------------------------------------------------------------------
// Centralized alias configuration (confirmed merges)
// ---------------------------------------------------------------------------

/**
 * Confirmed teacher alias entries. Each maps any name whose FOLDED form
 * matches `match` (folded: titles removed, lowercased, punctuation collapsed)
 * to the canonical identity `id` with display name `displayName`. Entries here
 * are permanent: they are applied on every parse so a confirmed merge is never
 * asked about again. Add entries here (or via the teacher page's ?debug
 * confirmation export) when a duplicate identity is confirmed.
 *
 * Note: displayName should be the canonical display form the parsers produce
 * (e.g. "Prof. Dr.Vigneshwaran"), so the teacher page shows the same name the
 * rest of the app uses.
 */
export const TEACHER_ALIASES = [
    // High-confidence confirmed merges discovered in the shared sheet.
    // Vigneshwaran / Vigneswaran are caught automatically by the minor
    // spelling rule; kept here as documentation that they were verified as
    // the same person (Environmental / Fundamentals of Biotechnology,
    // Basic Chemical Engineering, Introduction to Ecology).
    { match: /^vigneswaran$/i, id: 'vigneshwaran', displayName: 'Prof. Dr.Vigneshwaran' },
    // Surya Krish is an older sheet spelling for Surya C (Financial Reporting
    // and Analysis, SOB Year 2). Both names resolve to the same canonical
    // teacher so the timetable shows ONE consistent identity.
    { match: /^surya\s+(?:krish|c)$/i, id: 'surya-c', displayName: 'Prof. Surya C' },
];

// ---------------------------------------------------------------------------
// Confirmation persistence (browser-only, no-op elsewhere)
// ---------------------------------------------------------------------------

const CONFIRM_KEY = 'tt-teacher-aliases-v1';

function readStorage() {
    try {
        if (typeof localStorage === 'undefined' || !localStorage) return null;
        const raw = localStorage.getItem(CONFIRM_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

function writeStorage(value) {
    try {
        if (typeof localStorage === 'undefined' || !localStorage) return;
        localStorage.setItem(CONFIRM_KEY, JSON.stringify(value));
    } catch { /* full / unavailable — ignore */ }
}

/**
 * Confirmed merges stored per-browser. Each entry is { a, b } — two observed
 * display names resolved to the same person. Shape:
 *   { merge: [{a, b}], dismiss: [{a, b}] }
 */
export function loadTeacherConfirmations() {
    const data = readStorage();
    return {
        merge: Array.isArray(data?.merge) ? data.merge : [],
        dismiss: Array.isArray(data?.dismiss) ? data.dismiss : [],
    };
}

/** Persist the full confirmation record (merge + dismiss). */
export function saveTeacherConfirmations(record) {
    writeStorage({
        merge: Array.isArray(record?.merge) ? record.merge : [],
        dismiss: Array.isArray(record?.dismiss) ? record.dismiss : [],
    });
}

/** Add one confirmed merge pair { a, b } (observed display names). */
export function confirmTeacherMerge(a, b) {
    const rec = loadTeacherConfirmations();
    if (!rec.merge.some((m) => pairKey(m.a, m.b) === pairKey(a, b))) {
        rec.merge.push({ a: String(a), b: String(b) });
        saveTeacherConfirmations(rec);
    }
}

/** Mark one candidate pair as deliberately kept separate. */
export function dismissTeacherMerge(a, b) {
    const rec = loadTeacherConfirmations();
    if (!rec.dismiss.some((m) => pairKey(m.a, m.b) === pairKey(a, b))) {
        rec.dismiss.push({ a: String(a), b: String(b) });
        saveTeacherConfirmations(rec);
    }
}

const pairKey = (a, b) => [String(a).toLowerCase(), String(b).toLowerCase()].sort().join('|');

// ---------------------------------------------------------------------------
// Identity resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a set of observed teacher names into canonical identities.
 *
 * @param {string[]} observedNames every teacher display name seen in the data
 *   (duplicates allowed; frequency is used for display-name preference).
 * @param {Array<{a: string, b: string}>} [confirmed] extra confirmed merges
 *   (observed display names), applied on top of TEACHER_ALIASES.
 * @param {Array<{match: RegExp, id: string, displayName: string}>} [aliases]
 * @returns {{
 *   byName: Map<string, {id: string, displayName: string, aliases: string[]}>,
 *   byId: Map<string, {id: string, displayName: string, aliases: string[]}>,
 *   candidates: Array<{idA, displayNameA, idB, displayNameB, reason}>,
 *   ids: string[]
 * }}
 *   byName   each observed name → its canonical identity.
 *   byId     canonical id → identity (displayName + every folded alias).
 *   candidates  MEDIUM-confidence pairs that are NOT merged and have not been
 *   dismissed — the ones a developer/admin should confirm or reject.
 *   ids      sorted canonical ids.
 */
export function buildIdentityResolution(observedNames, confirmed = [], aliases = TEACHER_ALIASES) {
    const list = (observedNames || [])
        .map(String)
        .filter((n) => foldTeacherName(n));
    const counts = new Map();
    for (const n of list) counts.set(n, (counts.get(n) || 0) + 1);
    const unique = [...counts.keys()];

    // Union-find over observed names + synthetic alias nodes.
    const parent = new Map();
    const find = (x) => {
        let root = x;
        while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root);
        while (parent.get(x) !== undefined && parent.get(x) !== root) {
            const next = parent.get(x);
            parent.set(x, root);
            x = next;
        }
        return root;
    };
    const union = (x, y) => {
        const rx = find(x);
        const ry = find(y);
        if (rx !== ry) parent.set(rx, ry);
    };

    // Alias nodes: one per alias id.
    const aliasNode = new Map();
    for (const alias of aliases || []) {
        const node = `__alias__:${alias.id}`;
        parent.set(node, node);
        aliasNode.set(alias.id, node);
    }

    for (const n of unique) parent.set(n, n);

    for (const n of unique) {
        const alias = (aliases || []).find((a) => a.match.test(foldTeacherName(n)));
        if (alias) union(n, aliasNode.get(alias.id));
    }

    // HIGH confidence merges (fold-identical + minor spelling variants).
    for (let i = 0; i < unique.length; i++) {
        for (let j = i + 1; j < unique.length; j++) {
            const conf = identityConfidence(unique[i], unique[j]);
            if (conf.level === 'high') union(unique[i], unique[j]);
        }
    }

    // Explicit confirmed merges (observed display-name pairs).
    for (const pair of confirmed || []) {
        if (!pair || !pair.a || !pair.b) continue;
        const nodeA = unique.find((n) => foldTeacherName(n) === foldTeacherName(pair.a));
        const nodeB = unique.find((n) => foldTeacherName(n) === foldTeacherName(pair.b));
        if (nodeA && nodeB) union(nodeA, nodeB);
    }

    // Collect clusters.
    const clusters = new Map(); // root -> { names: Set, aliases: Set }
    for (const n of unique) {
        const root = find(n);
        if (!clusters.has(root)) clusters.set(root, { names: new Set(), aliasIds: new Set() });
        clusters.get(root).names.add(n);
    }
    for (const [id, node] of aliasNode) {
        const root = find(node);
        if (!clusters.has(root)) continue; // alias matched no observed name → no identity
        clusters.get(root).aliasIds.add(id);
    }

    // Prefer the most complete observed name as the display name.
    const displayFor = (names, aliasIds) => {
        const aliasDisplay = [...aliasIds]
            .map((id) => (aliases || []).find((a) => a.id === id)?.displayName)
            .filter(Boolean);
        if (aliasDisplay.length) return aliasDisplay[0];
        return [...names].sort((a, b) => {
            const ta = teacherTokens(a).length;
            const tb = teacherTokens(b).length;
            if (ta !== tb) return tb - ta; // more tokens → more complete
            const ca = counts.get(a) || 0;
            const cb = counts.get(b) || 0;
            if (ca !== cb) return cb - ca; // more frequent
            return a.localeCompare(b); // deterministic tie-break
        })[0];
    };

    const byId = new Map();
    const byName = new Map();
    for (const [root, cluster] of clusters) {
        const displayName = displayFor(cluster.names, cluster.aliasIds);
        let id = cluster.aliasIds.values().next().value || null;
        if (!id) id = foldTeacherName(displayName).replace(/\s+/g, '-') || `teacher-${root}`;
        if (byId.has(id)) {
            // Two clusters collided on the same id — merge their aliases.
            const existing = byId.get(id);
            for (const n of cluster.names) existing.aliases.push(n);
            continue;
        }
        const aliasesList = [...cluster.names].sort((a, b) => a.localeCompare(b));
        const identity = { id, displayName, aliases: aliasesList };
        byId.set(id, identity);
        for (const n of cluster.names) byName.set(n, identity);
    }

    // MEDIUM candidates between distinct identities, minus dismissed pairs.
    const confirmations = loadTeacherConfirmations();
    const dismissed = new Set((confirmations.dismiss || []).map((m) => pairKey(m.a, m.b)));

    const candidates = [];
    const seen = new Set();
    const idOrder = [...byId.keys()].sort();
    for (let i = 0; i < idOrder.length; i++) {
        for (let j = i + 1; j < idOrder.length; j++) {
            const idA = idOrder[i];
            const idB = idOrder[j];
            const conf = identityConfidence(byId.get(idA).displayName, byId.get(idB).displayName);
            if (conf.level !== 'medium') continue;
            const key = pairKey(idA, idB);
            if (dismissed.has(key)) continue;
            if (seen.has(key)) continue;
            seen.add(key);
            candidates.push({
                idA,
                displayNameA: byId.get(idA).displayName,
                idB,
                displayNameB: byId.get(idB).displayName,
                reason: conf.reason,
            });
        }
    }

    return { byName, byId, candidates, ids: idOrder };
}

/**
 * Searchable text for a teacher: canonical id + display name + every alias,
 * lowercased, so "Roopam" finds "Prof. Rupam Sah" via its alias, and "Mariya"
 * finds "Prof. Dr. Mariya" via the folded display name.
 */
export function teacherSearchText(id, displayName, aliases = []) {
    return [
        id,
        foldTeacherName(displayName),
        displayName,
        ...(aliases || []).flatMap((a) => [a, foldTeacherName(a)]),
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
}