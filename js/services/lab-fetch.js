import {
    getYear2LabSources,
    labSheetUrl,
    labCacheKey,
    isMissingSheetId,
} from '../data/lab-config.js?v=2026-08-13-005';
import {
    parseLabCSV,
    recordsToAppClasses,
    mergeTimelines,
} from '../data/lab-parser.js?v=2026-08-13-005';

/**
 * Year 2 lab timetable fetching + merging.
 *
 * Each lab sheet is fetched INDEPENDENTLY — no Google API, no OAuth, no backend
 * — using the exact same public Google Sheets CSV export URL + fetch() that the
 * main app uses, and the service worker's network-first caching applies to all
 * docs.google.com/spreadsheets URLs automatically.
 *
 * Design rules honored here:
 *   - One lab sheet failing must never take down the main timetable. Each
 *     source is tried in its own try/catch (Promise.allSettled), falls back to
 *     its own per-source localStorage cache, and reports a status. The merge
 *     only appends sources that produced records.
 *   - The latest successful fetch of a source IS the source of truth: the
 *     entire per-source record list is replaced (never diffed by coordinates),
 *     so moved rooms/columns and removed classes always reflect the newest
 *     sheet.
 *   - Sources with placeholder sheet ids report `unconfigured` and are skipped
 *     without a network request.
 */

function readCache(key) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; }
    catch { return null; }
}

function writeCache(key, classes) {
    try { localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), classes })); }
    catch { /* storage full — ignore */ }
}

/**
 * Fetch + parse ONE lab source, with per-source cache fallback.
 * Never throws for network/parse/cache failures.
 *
 * @returns {{source: object, status: 'ok'|'cached'|'error'|'unconfigured',
 *            records: Array<object>, savedAt?: number}}
 */
export async function fetchLabSource(source, { useCache = true } = {}) {
    if (isMissingSheetId(source)) {
        return { source, status: 'unconfigured', records: [] };
    }
    const cacheKey = labCacheKey(source);
    const cached = useCache ? readCache(cacheKey) : null;

    try {
        const url = labSheetUrl(source);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        const records = parseLabCSV(text, source);
        // Latest successful sheet replaces the whole source cache. An empty
        // parse is valid: every class may have been removed.
        writeCache(cacheKey, records);
        return { source, status: 'ok', records, savedAt: Date.now() };
    } catch {
        if (cached && cached.classes) {
            return { source, status: 'cached', records: cached.classes, savedAt: cached.savedAt };
        }
        return { source, status: 'error', records: [] };
    }
}

/**
 * Fetch and parse every Year 2 lab source. Always resolves; every returned
 * entry carries a per-source status. Errors in one source never affect others.
 *
 * @param {{section?: number}} [ctx] merge context (e.g. nav.getSection()) for
 *   lab cells that carry no explicit section marker.
 * @returns {Promise<{classes: Array<object>, statuses: Record<string,string>,
 *                    sources: Array<object>}>}
 */
export async function syncYear2Labs(ctx = {}) {
    const sources = getYear2LabSources();
    const settled = await Promise.allSettled(sources.map((src) => fetchLabSource(src)));

    const classes = [];
    const statuses = {};
    const ok = [];

    for (const s of settled) {
        if (s.status !== 'fulfilled') continue; // fetchLabSource never rejects
        const { source, status, records } = s.value;
        statuses[source.source] = status;
        if (status === 'unconfigured' || status === 'error') continue;
        const appClasses = recordsToAppClasses(records, source, ctx);
        ok.push(source);
        classes.push(...appClasses);
    }
    return { classes, statuses, sources: ok };
}

/**
 * Convenience: fetch all labs and merge them under the given main timetable
 * classes. This is the one call the app/game sync can use to produce the full
 * Year 2 timetable.
 *
 * @param {Array<object>} mainClasses classes already parsed from the main SCDS
 *   sheet (e.g. output of parseCSV).
 * @param {{section?: number}} [ctx]
 * @returns {Promise<{classes: Array<object>, labClasses: Array<object>,
 *                    statuses: Record<string,string>}>}
 */
export async function loadMergedYear2Timetable(mainClasses, ctx = {}) {
    const { classes: labClasses, statuses } = await syncYear2Labs(ctx);
    return { classes: mergeTimelines(mainClasses, labClasses), labClasses, statuses };
}