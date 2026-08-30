import { CONFIG } from './config.js?v=2026-08-30-010';

/**
 * Time and day helpers — all times are handled as "HH:MM" (24h) strings.
 * Weekday navigation only works over CONFIG.WEEKDAYS (Monday–Friday by
 * default), so weekend days never appear in the selector or navigation.
 */

export const WEEKDAYS = CONFIG.WEEKDAYS;

// getDay(): 0 = Sunday … 6 = Saturday — DAY_ORDER is indexed to match.
const DAY_ORDER = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_INDEX = Object.fromEntries(DAY_ORDER.map((d, i) => [d, i]));

export function nowMinutes() {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
}

export function toMinutes(timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + m;
}

export function minutesToLabel(totalMinutes) {
    const m = Math.max(0, totalMinutes);
    const h = Math.floor(m / 60);
    const min = m % 60;
    if (h && min) return `${h}h ${min}m`;
    if (h) return `${h}h`;
    return `${min}m`;
}

export function minutesToClock(totalMinutes) {
    const t = totalMinutes % (24 * 60);
    const h = Math.floor(t / 60);
    const min = t % 60;
    const meridiem = h >= 12 ? 'PM' : 'AM';
    const hour12 = h % 12 === 0 ? 12 : h % 12;
    return `${hour12}:${String(min).padStart(2, '0')} ${meridiem}`;
}

export function todayName() {
    return DAY_ORDER[new Date().getDay()];
}

export function isSchoolDay(name) {
    return WEEKDAYS.includes(name);
}

// Whether `day` comes strictly before today in the school week. On weekends
// (today not in WEEKDAYS) nothing counts as "before", since the app shows the
// next school day as its context.
export function isBeforeToday(day) {
    const tIdx = WEEKDAYS.indexOf(todayName());
    if (tIdx === -1) return false;
    const dIdx = WEEKDAYS.indexOf(day);
    return dIdx !== -1 && dIdx < tIdx;
}

// The next active weekday strictly after `name` (skips weekends).
export function nextSchoolDay(name) {
    const start = DAY_INDEX[name];
    if (start == null) return null;
    for (let step = 1; step <= 7; step++) {
        const next = DAY_ORDER[(start + step) % 7];
        if (WEEKDAYS.includes(next)) return next;
    }
    return null;
}

export function formatTodayLine() {
    const d = new Date();
    const opts = { weekday: 'long', day: 'numeric', month: 'short' };
    return d.toLocaleDateString(undefined, opts);
}

export function formatLastUpdated(date) {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// Display label for a laboratory class card. The underlying course keeps its
// original name ("Design and Analysis of Algorithms Lab") — only the rendered
// title drops the trailing "Lab" / "Lab.", because the yellow Lab badge right
// beside it already says the class is a laboratory. Never applied to non-lab
// courses (callers gate on `c.lab`), so a real course named "... Lab" that is
// not flagged as a lab is unaffected.
export function labSubjectLabel(subject) {
    const trimmed = String(subject ?? '').trim();
    return trimmed.replace(/\s+Lab\.?$/i, '') || trimmed;
}
