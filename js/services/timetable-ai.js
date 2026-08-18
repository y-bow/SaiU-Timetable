import { CONFIG } from '../core/config.js?v=2026-08-18-001';
import { offeringKey } from '../data/parser.js?v=2026-08-18-001';
import { dateForWeekday } from './n8n.js?v=2026-08-18-001';

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
 *       context: { school, year, section, labGroup }
 *     }
 *
 * The timetable sent is the app's ACTUAL parsed records — never invented, and
 * never hard-coded. Each record is stamped with the app's live navigation
 * context so n8n can reason per group. Group identity is school + section
 * (never section alone), so e.g. SCDS|3, SOAI|2 and SOB|1 are three distinct
 * groups.
 *
 * No free-time / conflict calculation happens in the frontend — n8n owns that
 * and returns the answer. The frontend only sends the timetable and renders
 * the response.
 *
 * Security: the browser talks ONLY to the n8n webhook. No AI-provider keys
 * ever live in the frontend; they stay inside n8n.
 *
 * Enablement (production-safe):
 *   - isAiEnabled() returns false whenever CONFIG.AI_UI_ENABLED is false (the
 *     master UI kill-switch), hiding every AI entry point site-wide — even on
 *     localhost. To restore the AI UI, set AI_UI_ENABLED back to true.
 *   - With AI_UI_ENABLED true, the feature is on whenever N8N_AI_WEBHOOK_URL
 *     is set AND either the page runs on a localhost host (dev/testing) or
 *     CONFIG.AI_FEATURE_ENABLED is true (the later switch for going live). On
 *     GitHub Pages with the feature still flagged off, the panel never renders
 *     and no request is ever made — the production build stays untouched.
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
 * the app's live navigation context. `date` is the next occurrence of the
 * record's weekday. Change information already detected by the app
 * (roomChanged / originalRoom) is forwarded as-is.
 */
export function buildTimetablePayload(classes, ctx = {}) {
    ctx = ctx || {};
    return flattenOfferings(classes).map((c) => ({
        school: c.school || ctx.school || null,
        year: c.year != null ? c.year : (ctx.year ?? null),
        section: c.section != null ? c.section : (ctx.section ?? null),
        labGroup: ctx.labGroup ?? null,
        course: c.subject ?? c.course ?? null,
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

/**
 * Ask SaiU AI a natural-language question.
 *
 * POSTs the live parsed timetable + current navigation context to the n8n
 * webhook. Never throws: network failures, timeouts and non-JSON responses all
 * resolve to `{ success: false }` so the UI can show a friendly error without
 * exposing raw errors, keys, stack traces or webhook internals.
 *
 * @returns {Promise<object>} the n8n JSON response (success / message / day /
 *   groups / commonFreePeriods / hasCommonFreeTime) or { success: false }.
 */
export async function askTimetableAI(question, classes, ctx = {}) {
    const url = String(CONFIG.N8N_AI_WEBHOOK_URL || '').trim();
    if (!url) {
        return { success: false };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.N8N_AI_TIMEOUT_MS || 45000);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                question: String(question || '').trim(),
                timetable: buildTimetablePayload(classes, ctx),
                context: {
                    school: ctx.school ?? null,
                    year: ctx.year ?? null,
                    section: ctx.section ?? null,
                    labGroup: ctx.labGroup ?? null,
                },
            }),
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
