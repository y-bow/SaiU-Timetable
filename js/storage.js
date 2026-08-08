import { CONFIG } from './config.js?v=2026-08-08-027';

/**
 * localStorage persistence: timetable cache, room-change map,
 * and navigation state (school, program, year, section).
 */

function read(key) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}

function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* full */ }
}

// --- Timetable cache ---

export function getCachedTimetable() { return read(CONFIG.CACHE_KEY); }

export function setCachedTimetable(data) {
    write(CONFIG.CACHE_KEY, { savedAt: Date.now(), classes: data });
}

// --- Room-change detection ---

export function getRoomMap() { return read(CONFIG.ROOMS_KEY) || {}; }

const PLACEHOLDER_ROOMS = /^(tba|tbd|to be announced|to be decided|room tba|n\/?a)$/i;

export function normalizeRoom(room) {
    if (room == null) return '';
    const s = String(room).replace(/\s+/g, ' ').trim();
    if (!s || PLACEHOLDER_ROOMS.test(s)) return '';
    return s.toLowerCase();
}

export function updateRoomMap(classes) {
    const map = getRoomMap();
    let changed = false;
    for (const c of classes) {
        const key = `${c.subject}|${c.faculty}|${c.section ?? ''}|${c.day ?? ''}|${c.startTime ?? ''}`;
        const rawRoom = String(c.room ?? '').replace(/\s+/g, ' ').trim();
        const room = normalizeRoom(rawRoom);
        const prevRaw = String(map[key] ?? '').trim();
        const prev = normalizeRoom(prevRaw);
        if (room && prev && prev !== room) { c.roomChanged = true; c.originalRoom = prevRaw; changed = true; }
        if (room) map[key] = rawRoom;
    }
    write(CONFIG.ROOMS_KEY, map);
    return changed;
}

// --- Section selection (legacy) ---

export function getSection() {
    const raw = localStorage.getItem(CONFIG.SECTION_KEY);
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}

export function setSection(section) {
    localStorage.setItem(CONFIG.SECTION_KEY, String(section));
}

// --- Navigation state persistence ---

const NAV_KEYS = {
    school: 'tt-nav-school',
    program: 'tt-nav-program',
    year: 'tt-nav-year',
    section: 'tt-nav-section',
};

export function getNavState() {
    return {
        schoolId: localStorage.getItem(NAV_KEYS.school) || null,
        programId: localStorage.getItem(NAV_KEYS.program) || null,
        yearId: localStorage.getItem(NAV_KEYS.year) || null,
        section: (() => {
            const raw = localStorage.getItem(NAV_KEYS.section);
            const n = parseInt(raw, 10);
            return Number.isFinite(n) && n > 0 ? n : null;
        })(),
    };
}

export function setNavState({ schoolId, programId, yearId, section }) {
    if (schoolId !== undefined) {
        if (schoolId === null) localStorage.removeItem(NAV_KEYS.school);
        else localStorage.setItem(NAV_KEYS.school, schoolId);
    }
    if (programId !== undefined) {
        if (programId === null) localStorage.removeItem(NAV_KEYS.program);
        else localStorage.setItem(NAV_KEYS.program, programId);
    }
    if (yearId !== undefined) {
        if (yearId === null) localStorage.removeItem(NAV_KEYS.year);
        else localStorage.setItem(NAV_KEYS.year, yearId);
    }
    if (section !== undefined) {
        if (section === null) localStorage.removeItem(NAV_KEYS.section);
        else localStorage.setItem(NAV_KEYS.section, String(section));
    }
}

// --- Section modal seen flag ---

export function hasSeenSectionModal() {
    return localStorage.getItem('tt-section-modal-seen') === '1';
}

export function markSectionModalSeen() {
    localStorage.setItem('tt-section-modal-seen', '1');
}

// --- Elective selections (persisted per year) ---
//
// Stored under a per-year key so switching schools/programs/years restores
// each year's own elective choices instead of leaking them across classes.

export function getStoredElectives(yearId) {
    if (!yearId) return [];
    const raw = localStorage.getItem(`tt-nav-electives-${yearId}`);
    if (!raw) return [];
    try {
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
}

export function setStoredElectives(yearId, ids) {
    if (!yearId) return;
    const key = `tt-nav-electives-${yearId}`;
    const clean = (ids || []).filter(Boolean);
    if (!clean.length) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(clean));
}

// --- Elective offering selection (persisted per year) ---
//
// Maps electiveId → chosen offeringKey (see parser.offeringKey). Stored per
// year so each course keeps its own offering choice, and stale keys (from a
// removed offering) are silently ignored by the resolver.

export function getStoredOfferings(yearId) {
    if (!yearId) return {};
    const raw = localStorage.getItem(`tt-nav-offerings-${yearId}`);
    if (!raw) return {};
    try {
        const obj = JSON.parse(raw);
        return obj && typeof obj === 'object' ? obj : {};
    } catch { return {}; }
}

export function setStoredOffering(yearId, electiveId, offeringKey) {
    if (!yearId || !electiveId) return;
    const key = `tt-nav-offerings-${yearId}`;
    const map = getStoredOfferings(yearId);
    if (offeringKey == null) delete map[electiveId];
    else map[electiveId] = offeringKey;
    if (!Object.keys(map).length) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(map));
}

// --- Selected weekday (persisted across sessions/updates) ---

export function getSelectedDay() {
    const day = localStorage.getItem('tt-nav-day');
    return day && CONFIG.WEEKDAYS.includes(day) ? day : null;
}

export function setSelectedDay(day) {
    if (day && CONFIG.WEEKDAYS.includes(day)) {
        localStorage.setItem('tt-nav-day', day);
    } else {
        localStorage.removeItem('tt-nav-day');
    }
}
