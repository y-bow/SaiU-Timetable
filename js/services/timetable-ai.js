import { CONFIG } from '../core/config.js?v=2026-08-30-006';
import { offeringKey, parseCSV } from '../data/parser.js?v=2026-08-30-006';
import { dateForWeekday } from './n8n.js?v=2026-08-30-006';
import { SCHOOLS } from '../data/schools.js?v=2026-08-30-006';
import { detectQueryGroups, resolveQueryGroups } from '../data/query-parser.js?v=2026-08-30-006';

/**
 * Generative-AI timetable assistant ("Ask SaiU AI").
 *
 * The chat UI (js/ui/ai-assistant.js) turns natural-language questions into a
 * POST to a dedicated n8n "SaiU AI" webhook. This module is the ONLY
 * place that knows the request shape and the webhook URL:
 *
 *     {
 *       question: string,
 *       timetable: Array<parsed records>,
 *       context: { school, year, section, labGroup },
 *       queryGroups: Array<{ school, section, year }>,
 *       allTimetables: { [groupKey]: Array<parsed records> }
 *     }
 *
 * QUERY ROUTING LOGIC:
 *   - The frontend parses the question to detect explicit group mentions
 *     (school, section, year).
 *   - If explicit groups are detected, the frontend fetches timetable data
 *     for those groups AND includes them in the payload.
 *   - The `context` field remains as the UI fallback — it is ONLY used when
 *     the user's question does NOT mention a specific group.
 *   - The n8n backend must check `queryGroups` first; if non-empty, use those.
 *     Otherwise fall back to `context`.
 *
 * Security: the browser talks ONLY to the n8n webhook. No AI-provider keys
 * ever live in the frontend; they stay inside n8n.
 */

const DEV_HOSTS = ['localhost', '127.0.0.1', '::1', '0.0.0.0'];

function isDevHost() {
    if (typeof window === 'undefined' || !window.location) return false;
    return DEV_HOSTS.includes(window.location.hostname);
}

export function isAiEnabled() {
    if (!CONFIG.AI_UI_ENABLED) return false;
    const url = String(CONFIG.N8N_AI_WEBHOOK_URL || '').trim();
    if (!url) return false;
    return !!CONFIG.AI_FEATURE_ENABLED || isDevHost();
}

/**
 * Expand multi-offering elective events into one record per offering, so every
 * record in the payload carries a concrete section/faculty/room (the offering
 * the student actually attends). Flat classes pass through unchanged.
 */
function flattenOfferings(classes) {
    const out = [];
    for (const c of classes || []) {
        if (!c) continue;
        if (c.offerings && c.offerings.length > 1) {
            for (const o of c.offerings) {
                out.push({
                    ...c,
                    faculty: o.faculty,
                    room: o.room,
                    section: o.section,
                    offeringKey: offeringKey(o),
                });
            }
        } else {
            out.push(c);
        }
    }
    return out;
}

/**
 * Map the app's parsed records to the n8n payload shape. School / year /
 * labGroup are not always present on parsed records, so they are stamped from
 * the group context. `date` is the next occurrence of the record's weekday.
 */
function buildTimetablePayload(classes, ctx = {}) {
    ctx = ctx || {};
    return flattenOfferings(classes).map((c) => ({
        school: c.school || ctx.school || null,
        year: c.year != null ? c.year : (ctx.year ?? null),
        section: c.section != null ? c.section : (ctx.section ?? null),
        labGroup: ctx.labGroup ?? null,
        course: c.displayName ?? c.subject ?? c.course ?? null,
        courseId: c.courseId ?? null,
        day: c.day ?? null,
        date: dateForWeekday(c.day),
        startTime: c.startTime ?? null,
        endTime: c.endTime ?? null,
        room: c.room ?? null,
        teacher: c.faculty ?? null,
        faculty: c.faculty ?? null,
        elective: c.elective ?? undefined,
        lab: c.lab ?? undefined,
        source: c.source ?? undefined,
        offeringKey: c.offeringKey ?? undefined,
        roomChanged: c.roomChanged || undefined,
        originalRoom: c.originalRoom || undefined,
    }));
}

// ============================================================
// Cross-group timetable fetching
// ============================================================

// In-memory cache of fetched timetables keyed by "schoolId|yearId".
// Avoids re-fetching the same sheet when multiple questions target one group.
const fetchCache = new Map();

/**
 * Get the Google Sheets CSV export URL for a given year config.
 */
function getSheetUrlForYear(yearConfig) {
    if (!yearConfig || !yearConfig.sheetId) return null;
    return `https://docs.google.com/spreadsheets/d/${yearConfig.sheetId}/export?format=csv&gid=${yearConfig.gid || '0'}`;
}

/**
 * Fetch and parse the timetable for a specific school + year config.
 * Returns parsed class records (array), or [] on failure.
 * Results are cached in memory for the session.
 */
async function fetchGroupTimetable(school, yearConfig, section) {
    const cacheKey = `${school.id}|${yearConfig.id}`;
    if (fetchCache.has(cacheKey)) return fetchCache.get(cacheKey);

    const url = getSheetUrlForYear(yearConfig);
    if (!url) return [];

    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        const parsed = parseCSV(
            text,
            yearConfig.parser || 'grid',
            yearConfig.mandatoryCourses || null,
            yearConfig.electives || null,
            yearConfig.rooms || null,
        );
        // Stamp school/year on every record for downstream grouping.
        const stamped = parsed.map((c) => ({
            ...c,
            school: c.school || school.shortName || school.id,
            year: c.year != null ? c.year : yearConfig.level,
        }));
        fetchCache.set(cacheKey, stamped);
        return stamped;
    } catch {
        return [];
    }
}

/**
 * Given resolved query groups, fetch timetable data for each group.
 * Returns an object keyed by group label → array of parsed records.
 */
async function fetchTimetablesForGroups(resolvedGroups) {
    const result = {};
    const fetches = resolvedGroups.map(async (g) => {
        const records = await fetchGroupTimetable(g.school, g.yearConfig, g.section);
        result[g.label] = records;
    });
    await Promise.all(fetches);
    return result;
}

/**
 * Filter parsed records to a specific section (when sections exist).
 */
function filterBySection(records, section) {
    if (section == null) return records;
    return records.filter((c) => {
        if (c.section != null) return c.section === section;
        // Records without a section field: keep if the group has no sections.
        return true;
    });
}

// ============================================================
// Main API
// ============================================================

/**
 * Ask SaiU AI a natural-language question.
 *
 * POSTs the live parsed timetable + current navigation context to the n8n
 * webhook. When the question mentions explicit groups (school, section, year),
 * the frontend fetches those groups' timetable data and includes it in the
 * payload so n8n can answer cross-group queries.
 *
 * Never throws: network failures, timeouts and non-JSON responses all
 * resolve to `{ success: false }` so the UI can show a friendly error without
 * exposing raw errors, keys, stack traces or webhook internals.
 *
 * @returns {Promise<object>} the n8n JSON response or { success: false }.
 */
export async function askTimetableAI(question, classes, ctx = {}) {
    const url = String(CONFIG.N8N_AI_WEBHOOK_URL || '').trim();
    if (!url) {
        return { success: false };
    }

    // --- Detect explicit group mentions in the question ---
    const { groups: detectedGroups, hasExplicitGroup } = detectQueryGroups(question);

    // Build UI context (fallback)
    const uiContext = {
        school: ctx.school ?? null,
        year: ctx.year ?? null,
        yearLevel: ctx.yearLevel ?? null,
        section: ctx.section ?? null,
        labGroup: ctx.labGroup ?? null,
    };

    // --- Resolve and fetch explicit groups ---
    let queryGroups = [];
    let allTimetables = {};
    let primaryTimetable = buildTimetablePayload(classes, ctx); // default: current UI

    if (hasExplicitGroup && detectedGroups.length > 0) {
        const resolved = resolveQueryGroups(detectedGroups, uiContext);
        queryGroups = resolved.map((g) => ({
            school: g.school.shortName || g.school.id,
            section: g.section,
            year: g.yearConfig.level,
            label: g.label,
        }));

        // Fetch timetable data for each detected group
        allTimetables = await fetchTimetablesForGroups(resolved);

        // Build the primary timetable: if the detected group differs from the
        // UI context, use the detected group's data. For multi-group queries
        // (common free time), allTimetables carries every group's data.
        if (resolved.length === 1) {
            const g = resolved[0];
            const records = allTimetables[g.label] || [];
            const filtered = filterBySection(records, g.section);
            primaryTimetable = buildTimetablePayload(filtered, {
                school: g.school.shortName || g.school.id,
                year: g.yearConfig.level,
                section: g.section,
            });
        }
        // For multi-group queries, primaryTimetable stays as the current UI
        // data (n8n uses allTimetables for cross-group operations).
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.N8N_AI_TIMEOUT_MS || 45000);
    try {
        const payload = {
            question: String(question || '').trim(),
            timetable: primaryTimetable,
            context: uiContext,
            // NEW: explicit query context for routing
            queryGroups,
            allTimetables: hasExplicitGroup ? allTimetables : undefined,
        };
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return data && typeof data === 'object' ? data : { success: false };
    } catch {
        return { success: false };
    } finally {
        clearTimeout(timer);
    }
}
