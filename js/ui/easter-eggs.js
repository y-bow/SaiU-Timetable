/**
 * Easter eggs module — isolated, tiny, no dependencies on app logic.
 * Only exports a single function to check and trigger the Arjun Singh frog.
 */

const STORAGE_KEY = 'tt-easter-arjun-singh';

// In-memory guard so the frog can never fire twice for the same occurrence in
// one session, even if localStorage is unavailable or cleared mid-session.
const triggeredThisSession = new Set();

/**
 * Check if the user prefers reduced motion.
 */
function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Generate a unique key for a class occurrence.
 * Uses course + professor + local date + start time to uniquely identify.
 * The local calendar date (not UTC) keeps the key on the right day in every
 * timezone, so a class near midnight never falls on yesterday's key.
 */
function getClassOccurrenceKey(cls, date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${cls.subject}|${cls.faculty}|${y}-${m}-${d}|${cls.startTime}`;
}

/**
 * Check if this class occurrence has already triggered the Easter egg.
 */
function hasTriggered(key) {
    if (triggeredThisSession.has(key)) return true;
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return false;
        const data = JSON.parse(raw);
        return data.triggered?.includes(key) ?? false;
    } catch {
        return false;
    }
}

/**
 * Mark this class occurrence as having triggered the Easter egg.
 */
function markTriggered(key) {
    // The session guard always applies; persistence is best-effort.
    triggeredThisSession.add(key);
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const data = raw ? JSON.parse(raw) : { triggered: [] };
        if (!data.triggered.includes(key)) {
            data.triggered.push(key);
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        }
    } catch {
        // storage full or unavailable — the session guard still holds
    }
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
 * Main export: check for Arjun Singh class transition and trigger Easter egg.
 * 
 * @param {Object} params
 * @param {Array} params.classes - All classes for the current section/day
 * @param {number} params.nowMin - Current time in minutes
 * @param {string} params.day - Current day name
 * @param {Object|null} params.current - Currently in-progress class (from computeHighlight)
 * @param {Object|null} params.next - Next upcoming class (from computeHighlight)
 * @param {Object|null} params.prevCurrent - Previous in-progress class (from last tick)
 * @returns {Object|null} The class that triggered the Easter egg, or null
 */
export function checkArjunSinghTransition({ classes, nowMin, day, current, next, prevCurrent }) {
    // Only run on the actual current day
    const today = new Date();
    const todayStr = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][today.getDay()];
    if (day !== todayStr) return null;

    // Find Arjun Singh classes happening today
    const arjunClasses = classes.filter(c => 
        c.day === day && 
        c.faculty && 
        c.faculty.includes('Arjun Singh')
    );

    if (!arjunClasses.length) return null;

    // Check each Arjun Singh class for the transition.
    for (const cls of arjunClasses) {
        const startMin = toMinutes(cls.startTime);
        const endMin = toMinutes(cls.endTime);

        // Only a class inside its live window can transition to in-progress.
        const isNowCurrent = nowMin >= startMin && nowMin < endMin;
        if (!isNowCurrent) continue;

        const key = getClassOccurrenceKey(cls, today);

        // Already triggered for this occurrence — never fire again (the next
        // tick, any timer tick, and any later refresh are all ignored).
        if (hasTriggered(key)) continue;

        // wasCurrent == the previous in-progress class was already this one,
        // which happens when the page loaded/refreshed/re-rendered while the
        // class was already running — that is not an observed transition.
        const wasCurrent = prevCurrent && prevCurrent.subject === cls.subject && prevCurrent.startTime === cls.startTime;

        if (!wasCurrent) {
            // This is the exact observed transition: not in-progress → in-progress.
            markTriggered(key);
            showFrogOverlay();
            return cls;
        }
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