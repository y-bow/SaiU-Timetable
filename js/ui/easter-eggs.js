/**
 * Easter eggs module — isolated, tiny, no dependencies on app logic.
 *
 * Exports the Arjun Singh frog: a development-only easter egg that shows a
 * single 🐸 overlay when a class taught by Prof. Arjun Singh is observed
 * transitioning from "starts in 1 minute" to "in progress" while the user
 * watches the page.
 *
 * The trigger is a strict per-occurrence state transition. The module tracks
 * the last observed state of every Arjun Singh occurrence internally, so the
 * frog fires only when the SAME occurrence was seen as "starts in 1 minute"
 * on an earlier live-clock tick and is now "in progress". Loading, refreshing,
 * re-rendering, navigating, or returning to a visible tab all clear the
 * tracked state (via resetArjunSinghTransition()), so those can never look
 * like a transition. Each occurrence can fire at most once, enforced both in
 * memory (session) and in localStorage (across sessions).
 */

const STORAGE_KEY = 'tt-easter-arjun-singh-v2';

// In-memory guard so the frog can never fire twice for the same occurrence in
// one session, even if localStorage is unavailable or cleared mid-session.
const triggeredThisSession = new Set();

// Last observed state per occurrence id ('upcoming' | 'starts_in_1_minute' |
// 'in_progress' | 'completed'). Cleared by resetArjunSinghTransition() on
// every structural re-render, data refresh, and visibility catch-up, so a
// transition is only ever recognized when it was genuinely observed across
// consecutive live-clock ticks while the user watched the page.
const previousStates = new Map();

// Development-only override. The frog and its [FROG] logs run on localhost /
// 127.* hosts automatically; setFrogDebug(true) enables them anywhere else
// (used by the test harness and handy from the dev console).
let frogDebug = false;

/**
 * Development-only feature gate. The frog only runs on a localhost dev host
 * or when explicitly enabled via setFrogDebug(true) — never in production.
 */
function featureEnabled() {
    if (frogDebug) return true;
    try {
        return ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(window.location.hostname);
    } catch {
        return false;
    }
}

/**
 * Enable or disable the frog and its [FROG] logging explicitly. Used by the
 * test harness and the dev console.
 */
export function setFrogDebug(flag) {
    frogDebug = !!flag;
}

/**
 * Clear the tracked per-occurrence state. Called by the app on every
 * structural re-render (first load, refresh, day/section/elective/offering
 * change) and whenever the tab becomes visible again, so the frog only ever
 * fires on an *observed* starts-in-1-minute → in-progress transition.
 */
export function resetArjunSinghTransition() {
    previousStates.clear();
}

/**
 * Check if the user prefers reduced motion.
 */
function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Local date (yyyy-mm-dd) of the given instant. Uses the calendar date, not
 * UTC, so a class near midnight stays on the right day in every timezone.
 */
function toLocalDateString(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/**
 * Unique id for a class occurrence on a given date. Date + start time +
 * subject identify the weekly occurrence; school (present only on lab
 * records) and section disambiguate parallel labs sharing a time slot.
 */
function getClassOccurrenceId(cls, dateStr) {
    return [dateStr, cls.startTime, cls.subject, cls.school ?? '', cls.section ?? 1].join('|');
}

/**
 * Check if this class occurrence has already triggered the Easter egg.
 */
function hasTriggered(id) {
    if (triggeredThisSession.has(id)) return true;
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return false;
        const data = JSON.parse(raw);
        return data.triggered?.includes(id) ?? false;
    } catch {
        return false;
    }
}

/**
 * Mark this class occurrence as having triggered the Easter egg.
 */
function markTriggered(id) {
    // The session guard always applies; persistence is best-effort.
    triggeredThisSession.add(id);
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const data = raw ? JSON.parse(raw) : { triggered: [] };
        if (!data.triggered.includes(id)) {
            data.triggered.push(id);
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        }
    } catch {
        // storage full or unavailable — the session guard still holds
    }
}

// Deterministic Professor Arjun Singh match. The parser stamps "Prof. " on
// every faculty name, so the raw sheet forms ("Arjun", "Arjun Singh",
// "Prof. Arjun", "Prof. Arjun Singh") all reduce to the same normalized
// token string. Leading titles are stripped, then the name is compared
// exactly — never a substring or fuzzy match — so similarly-spelled
// professors ("Arjun Kumar", "Singh") can never trigger the frog.
function isArjunSingh(faculty) {
    const name = String(faculty ?? '')
        .toLowerCase()
        .replace(/^(?:prof\.?\s*|dr\.?\s*|mr\.?\s*|mrs\.?\s*|ms\.?\s*|miss\.?\s*)+/, '')
        .replace(/[^a-z\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return name === 'arjun' || name === 'arjun singh';
}

/**
 * The displayed state of a class at a given minute. Minute-granular, matching
 * the timetable display: the minute BEFORE a class start reads
 * "starts_in_1_minute", and the whole start minute onward reads "in_progress".
 */
function classState(cls, nowMin) {
    const startMin = toMinutes(cls.startTime);
    const endMin = toMinutes(cls.endTime);
    if (nowMin < startMin - 1) return 'upcoming';
    if (nowMin === startMin - 1) return 'starts_in_1_minute';
    if (nowMin < endMin) return 'in_progress';
    return 'completed';
}

/**
 * Development-only [FROG] logging, shown on state changes and triggers.
 */
function logFrog(...args) {
    if (featureEnabled()) console.log('[FROG]', ...args);
}

/**
 * Create and show the frog overlay.
 * Returns a promise that resolves when the animation completes.
 */
function showFrogOverlay() {
    return new Promise((resolve) => {
        const reduced = prefersReducedMotion();

        // Create overlay element
        const overlay = document.createElement('div');
        overlay.className = 'easter-egg-overlay';
        overlay.style.cssText = `
            position: fixed;
            inset: 0;
            z-index: 9999;
            background: rgba(0, 0, 0, 0.3);
            backdrop-filter: blur(0px);
            -webkit-backdrop-filter: blur(0px);
            display: flex;
            align-items: center;
            justify-content: center;
            pointer-events: none;
            opacity: 0;
            transition: opacity ${reduced ? '200ms' : '300ms'} cubic-bezier(0.25, 0.1, 0.25, 1),
                        backdrop-filter ${reduced ? '200ms' : '400ms'} cubic-bezier(0.15, 0.5, 0.3, 1.05);
        `;

        // Create frog element
        const frog = document.createElement('div');
        frog.className = 'easter-egg-frog';
        frog.textContent = '🐸';
        frog.style.cssText = `
            font-size: clamp(80px, 20vw, 160px);
            line-height: 1;
            transform: scale(${reduced ? '1' : '0.7'});
            transition: transform ${reduced ? '0ms' : '500ms'} cubic-bezier(0.1, 0.6, 0.2, 1.15);
            filter: drop-shadow(0 20px 40px rgba(0, 0, 0, 0.4));
            will-change: transform;
        `;

        overlay.appendChild(frog);
        document.body.appendChild(overlay);

        // Force reflow then animate in
        requestAnimationFrame(() => {
            overlay.style.opacity = '1';
            overlay.style.backdropFilter = 'blur(12px) saturate(150%)';
            overlay.style.webkitBackdropFilter = 'blur(12px) saturate(150%)';

            if (!reduced) {
                requestAnimationFrame(() => {
                    frog.style.transform = 'scale(1)';
                });
            }
        });

        // Hold then animate out
        const holdDuration = reduced ? 800 : 1800;
        setTimeout(() => {
            overlay.style.opacity = '0';
            overlay.style.backdropFilter = 'blur(0px)';
            overlay.style.webkitBackdropFilter = 'blur(0px)';
            if (!reduced) {
                frog.style.transform = 'scale(0.7)';
            }

            setTimeout(() => {
                overlay.remove();
                resolve();
            }, reduced ? 150 : 400);
        }, holdDuration);
    });
}

/**
 * Main export: check for an observed Arjun Singh transition and trigger the
 * Easter egg.
 *
 * The frog fires ONLY when the same occurrence was observed as
 * "starts_in_1_minute" on an earlier live-clock tick and is "in_progress"
 * now — a strict transition the user actually watched. It never fires for a
 * class that was already running when first observed (page load, refresh,
 * re-render, navigation), for repeated starts-in-1-minute or in-progress
 * ticks, for a different day, for another professor, or twice for the same
 * occurrence.
 *
 * @param {Object} params
 * @param {Array} params.classes - The classes visible for the current day
 * @param {number} params.nowMin - Current time in minutes since midnight
 * @param {string} params.day - The day being viewed
 * @returns {Object|null} The class that triggered the Easter egg, or null
 */
export function checkArjunSinghTransition({ classes, nowMin, day }) {
    if (!featureEnabled()) return null;
    if (!classes || !classes.length) return null;

    const today = new Date();
    const todayStr = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][today.getDay()];
    // Only the actual current day can transition — a class viewed on any other
    // day (or a weekend rendering next Monday) is never "starting now".
    if (day !== todayStr) return null;

    const dateStr = toLocalDateString(today);

    for (const cls of classes) {
        if (cls.day !== day) continue;
        if (!isArjunSingh(cls.faculty)) continue;

        const state = classState(cls, nowMin);
        const id = getClassOccurrenceId(cls, dateStr);
        const prevState = previousStates.get(id);
        previousStates.set(id, state);

        // Log only on an actual state change or trigger decision — never every
        // second, so a long-running class does not spam the console.
        if (state !== prevState) {
            logFrog('candidate', { id, subject: cls.subject, teacher: cls.faculty, prevState, state, nowMin });
        }

        // The only triggerable transition: the SAME occurrence was observed
        // "starts in 1 minute" on an earlier tick and is now "in progress".
        if (state !== 'in_progress' || prevState !== 'starts_in_1_minute') continue;

        // Already consumed for this occurrence — session or persisted guard.
        if (hasTriggered(id)) {
            logFrog('ignored (already triggered)', id);
            continue;
        }

        markTriggered(id);
        logFrog('TRIGGER', id);
        showFrogOverlay();
        return cls;
    }

    return null;
}

/**
 * Convert HH:MM time string to minutes since midnight.
 */
function toMinutes(timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + m;
}
