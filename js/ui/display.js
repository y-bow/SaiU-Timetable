/**
 * Display-layer transforms.
 *
 * The parser emits ONE RAW record per class it finds — consecutive slots are
 * never merged at parse time, so the raw timetable (and therefore everything
 * cached and everything the smart change detector compares) is always a
 * faithful mirror of the sheet. A class that appears as two back-to-back slots
 * stays two raw records.
 *
 * This module owns the ONLY time-merge in the app: a purely VISUAL pass that
 * glues consecutive sessions of one continuous class into a single timeline
 * block, applied just before rendering. Raw records are never modified — each
 * merged block carries its member records (`_members`) so highlighting, the
 * live clock and the Arjun frog keep seeing the real per-slot start/end times
 * underneath the merged block.
 *
 * Because the merge is recomputed from the latest raw records on every render,
 * an update that splits or joins a class always regenerates the correct
 * display automatically.
 */

const MERGE_GAP_MIN = 10;

const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];

const norm = (s) => String(s ?? '').trim().toLowerCase();

const toMinutes = (t) => {
    const [h, m] = String(t ?? '0:00').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
};

/**
 * Merge compatible ADJACENT records into display blocks.
 *
 * Two classes merge ONLY when every identity property matches and the second
 * slot starts right after the first ends (gap <= MERGE_GAP_MIN):
 *
 *   respected startTime and   — a class 3:00-3:55 + 4:00-4:55 becomes one
 *   untouched on every member   display block 3:00-4:55, while the three
 *   raw records stay separate.
 *
 *   same section, elective     — different courses, sections, lab groups or
 *   offering, subject,          elective offerings never merge.
 *   faculty, room, lab flag
 *
 * Each returned display item is a shallow copy of its first member extended
 * to the merged end time, plus `_members` holding the ORIGINAL raw records
 * (including the first, referenced not copied).
 *
 * @param {Array<object>} classes raw resolved classes (one per occurrence)
 * @returns {Array<object>} display items, sorted, with `_members`
 */
export function mergeAdjacentForDisplay(classes) {
    if (!classes || classes.length < 2) {
        return (classes || []).map((c) => ({ ...c, _members: [c] }));
    }

    const dayOrder = Object.fromEntries(DAYS.map((d, i) => [norm(d), i]));
    const sorted = [...classes].sort((a, b) => {
        const da = dayOrder[norm(a.day)] ?? 0;
        const db = dayOrder[norm(b.day)] ?? 0;
        if (da !== db) return da - db;
        const t = toMinutes(a.startTime) - toMinutes(b.startTime);
        if (t !== 0) return t;
        return (a.section ?? 0) - (b.section ?? 0);
    });

    // A sheet may hold several sections interleaved, so adjacency in sorted
    // order says nothing about two slots belonging to one class. Track the
    // last display item per day+section and only merge a slot with the one
    // that immediately precedes it for the SAME section/day.
    const out = [];
    const lastByKey = new Map();
    for (const c of sorted) {
        const key = `${norm(c.day)}|${c.section ?? ''}`;
        const last = lastByKey.get(key);
        const gap = last ? toMinutes(c.startTime) - toMinutes(last.endTime) : NaN;
        const mergeable = last &&
            last.section === c.section &&
            (last.elective || null) === (c.elective || null) &&
            (last.lab || false) === (c.lab || false) &&
            norm(last.subject) === norm(c.subject) &&
            norm(last.faculty) === norm(c.faculty) &&
            norm(last.room) === norm(c.room) &&
            gap >= 0 && gap <= MERGE_GAP_MIN;
        if (mergeable) {
            last.endTime = c.endTime;
            last._members.push(c);
        } else {
            const item = { ...c, _members: [c] };
            out.push(item);
            lastByKey.set(key, item);
        }
    }
    return out;
}

/**
 * Render-time helper: is the highlighted raw class part of this display item?
 * A merged block is highlighted when any of its member records is the live
 * featured class, so the spotlight, countdown and progress track follow the
 * real per-slot occurrence while the block is shown as one continuous class.
 */
export function displayItemHighlighted(item, highlight) {
    if (!item || !highlight) return false;
    if (item === highlight) return true;
    return !!item._members && item._members.includes(highlight);
}