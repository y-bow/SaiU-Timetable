import { toMinutes, minutesToClock } from '../core/utils.js?v=2026-08-30-012';
import { trackEvent } from '../services/analytics.js?v=2026-08-30-012';

/**
 * Free Rooms — shows which rooms are available during each period
 * on the currently selected timetable day.
 *
 * Room discovery uses the authoritative room list from schools.js
 * (the full inventory of physical rooms) plus any additional rooms
 * discovered in the room-occupancy data.  Room availability comes
 * from parseRoomOccupancy() — which scans the ENTIRE timetable CSV
 * without school/year/section filtering — so a room occupied by ANY
 * class (SCDS, SOAI, SOB, etc.) is correctly marked occupied.
 */

const $ = (sel) => document.querySelector(sel);

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

const svg = (inner, size = 16) =>
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

const CLOSE_ICON = svg('<path d="M18 6 6 18M6 6l12 12"/>', 18);
const MAP_PIN_ICON = svg('<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>', 14);
const CHECK_ICON = svg('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/>', 14);
const DOOR_ICON = svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><circle cx="14.5" cy="12" r="1"/>', 14);
const EMPTY_ICON = svg('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="m15 14-6 6m0-6 6 6"/>', 36);

let panel = null;
let contentEl = null;
let focusTrapCleanup = null;
let lastFocused = null;

let getClasses = () => [];
let getRoomClasses = () => [];
let getSelectedDay = () => null;
let getRoomOccupancy = () => [];
let getYearConfig = () => null;

// ============================================================
// Room normalization
// ============================================================

/**
 * Normalize room names for comparison: uppercase, hyphens → spaces,
 * collapse whitespace.  Ensures "AB2 - 101", "AB2  -  101" and
 * "AB2 101" all map to the same canonical key.
 */
function normalizeRoom(name) {
    return String(name ?? '')
        .toUpperCase()
        .replace(/-/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Canonical display name for a room.  Prefers the authoritative list
 * from schools.js; falls back to a cleaned-up version of the raw name.
 */
const CANONICAL_DISPLAY = new Map();
function buildCanonicalMap(knownRooms) {
    CANONICAL_DISPLAY.clear();
    for (const r of knownRooms) {
        CANONICAL_DISPLAY.set(normalizeRoom(r), r);
    }
}

function displayRoom(raw) {
    const key = normalizeRoom(raw);
    if (CANONICAL_DISPLAY.has(key)) return CANONICAL_DISPLAY.get(key);
    return String(raw ?? '').replace(/\s+/g, ' ').trim();
}

// ============================================================
// Room discovery — authoritative inventory
// ============================================================

/**
 * Rooms to exclude from the free-rooms list: labs and the Moot Court Hall
 * are special-purpose spaces, not bookable classrooms.
 */
const EXCLUDED_ROOM_PATTERNS = /\b(moot\s*court|lab|faculty\s*conference)\b/i;
const EXCLUDED_ROOMS = new Set(['AB2-208']);

/**
 * Build the complete room inventory from:
 *   1. The authoritative room list in the year config (schools.js).
 *   2. Any extra rooms found in the occupancy data that are not in
 *      the authoritative list.
 *
 * Labs and Moot Court Hall are excluded.
 */
function discoverRooms(occupancy, yearConfig) {
    const roomMap = new Map();

    // 1. Authoritative list — always present even if no classes exist.
    const knownRooms = (yearConfig && yearConfig.rooms) || [];
    buildCanonicalMap(knownRooms);
    for (const raw of knownRooms) {
        const key = normalizeRoom(raw);
        if (EXCLUDED_ROOM_PATTERNS.test(key) || EXCLUDED_ROOMS.has(key)) continue;
        if (!roomMap.has(key)) roomMap.set(key, displayRoom(raw));
    }

    // 2. Additional rooms found in the occupancy data.
    for (const rec of occupancy) {
        const room = String(rec.room ?? '').trim();
        if (!room) continue;
        const key = normalizeRoom(room);
        if (EXCLUDED_ROOM_PATTERNS.test(key) || EXCLUDED_ROOMS.has(key)) continue;
        if (!roomMap.has(key)) roomMap.set(key, displayRoom(room));
    }

    return roomMap;
}

// ============================================================
// Time slots & occupancy
// ============================================================

/**
 * Get unique time slots (periods) for a given day from the occupancy
 * data, sorted by start time.
 */
function getDayTimeSlots(occupancy, day) {
    const seen = new Set();
    const slots = [];
    for (const rec of occupancy) {
        if (rec.day !== day) continue;
        const key = `${rec.startTime}|${rec.endTime}`;
        if (seen.has(key)) continue;
        seen.add(key);
        slots.push({
            startTime: rec.startTime,
            endTime: rec.endTime,
            startMin: toMinutes(rec.startTime),
            endMin: toMinutes(rec.endTime),
        });
    }
    return slots.sort((a, b) => a.startMin - b.startMin);
}

/**
 * Determine which rooms are occupied during a specific time slot
 * on a given day, using proper interval overlap logic:
 *
 *   existingStart < requestedEnd AND existingEnd > requestedStart
 *
 * Uses the room-occupancy data (all schools/years), not the
 * filtered class list.
 */
function getOccupiedRooms(occupancy, day, slot) {
    const occupied = new Set();
    for (const rec of occupancy) {
        if (rec.day !== day) continue;
        const cStart = toMinutes(rec.startTime);
        const cEnd = toMinutes(rec.endTime);
        if (cStart < slot.endMin && cEnd > slot.startMin) {
            const room = String(rec.room ?? '').trim();
            if (room) occupied.add(normalizeRoom(room));
        }
    }
    return occupied;
}

// ============================================================
// Free room calculation
// ============================================================

/**
 * Calculate free rooms for the entire selected day.
 *
 * @param {Array} occupancy  room-occupancy records (all schools)
 * @param {string} day       selected day name
 * @param {object|null} yearConfig  current year config (rooms list)
 * @returns {Array<{startTime, endTime, startMin, endMin, freeRooms: string[], totalDiscovered: number}>}
 */
function calculateFreeRooms(occupancy, day, yearConfig) {
    const allRooms = discoverRooms(occupancy, yearConfig);
    const timeSlots = getDayTimeSlots(occupancy, day);

    if (!allRooms.size || !timeSlots.length) return [];

    return timeSlots.map((slot) => {
        const occupied = getOccupiedRooms(occupancy, day, slot);
        const freeRooms = [];
        for (const [normalized, display] of allRooms) {
            if (!occupied.has(normalized)) {
                freeRooms.push(display);
            }
        }
        return {
            startTime: slot.startTime,
            endTime: slot.endTime,
            startMin: slot.startMin,
            endMin: slot.endMin,
            freeRooms,
            totalDiscovered: allRooms.size,
        };
    });
}

// ============================================================
// DOM construction — reuses AI panel design language
// ============================================================

function ensureDom() {
    if (panel) return;
    document.body.insertAdjacentHTML('beforeend', `
        <div id="free-rooms-panel" class="ai-panel free-rooms-panel" role="dialog" aria-modal="true" aria-labelledby="fr-title" aria-hidden="true">
            <div class="ai-backdrop" data-fr-close></div>
            <div class="ai-sheet free-rooms-sheet">
                <header class="ai-header">
                    <div class="ai-heading">
                        <h2 id="fr-title" class="ai-title"><span class="ai-spark">${DOOR_ICON}</span>Free Rooms</h2>
                        <p id="fr-day-label" class="ai-subtitle"></p>
                    </div>
                    <button type="button" id="fr-close-btn" class="icon-btn" aria-label="Close free rooms">${CLOSE_ICON}</button>
                </header>
                <div id="fr-content" class="free-rooms-content" role="log" aria-live="polite"></div>
            </div>
        </div>`);

    panel = $('#free-rooms-panel');
    contentEl = $('#fr-content');
    const closeBtn = $('#fr-close-btn');
    const backdrop = panel.querySelector('.ai-backdrop');

    closeBtn.addEventListener('click', closePanel);
    backdrop.addEventListener('click', closePanel);
}

// ============================================================
// Open / close — mirrors AI panel behavior exactly
// ============================================================

export function openPanel() {
    if (!panel || panel.classList.contains('open')) return;
    lastFocused = document.activeElement;
    renderContent();
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    focusTrapCleanup = trapFocus(panel, closePanel);
    trackEvent('free_rooms_click', {
        selected_day: getSelectedDay() || '',
        source: 'timetable',
    });
}

function closePanel() {
    if (!panel || !panel.classList.contains('open')) return;
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    if (focusTrapCleanup) {
        focusTrapCleanup();
        focusTrapCleanup = null;
    }
    if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
}

function trapFocus(container, onEscape) {
    function handler(e) {
        if (e.key === 'Escape') { e.preventDefault(); onEscape(); return; }
        if (e.key !== 'Tab') return;
        const focusable = container.querySelectorAll('button:not([disabled])');
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
            if (document.activeElement === first) { e.preventDefault(); last.focus(); }
        } else {
            if (document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
    }
    container.addEventListener('keydown', handler);
    return () => container.removeEventListener('keydown', handler);
}

// ============================================================
// Content rendering
// ============================================================

function renderContent() {
    if (!contentEl) return;
    const day = getSelectedDay();
    const occupancy = getRoomOccupancy();
    const yearConfig = getYearConfig();

    // Update day label
    const dayLabel = $('#fr-day-label');
    if (dayLabel) {
        dayLabel.textContent = day ? `${day}'s Schedule` : 'No day selected';
    }

    if (!day) {
        contentEl.innerHTML = `
            <div class="free-rooms-empty">
                <div class="free-rooms-empty-icon">${EMPTY_ICON}</div>
                <strong>No day selected</strong>
                <span>Select a day in the timetable first.</span>
            </div>`;
        return;
    }

    const allRooms = discoverRooms(occupancy, yearConfig);
    if (!allRooms.size) {
        contentEl.innerHTML = `
            <div class="free-rooms-empty">
                <div class="free-rooms-empty-icon">${EMPTY_ICON}</div>
                <strong>No room data</strong>
                <span>No room availability data is available for this day.</span>
            </div>`;
        return;
    }

    const results = calculateFreeRooms(occupancy, day, yearConfig);
    if (!results.length) {
        contentEl.innerHTML = `
            <div class="free-rooms-empty">
                <div class="free-rooms-empty-icon">${EMPTY_ICON}</div>
                <strong>No periods found</strong>
                <span>There are no scheduled periods on ${escapeHtml(day)}.</span>
            </div>`;
        return;
    }

    let html = '';
    for (const period of results) {
        const slotLabel = `${minutesToClock(period.startMin)} – ${minutesToClock(period.endMin)}`;
        const freeCount = period.freeRooms.length;

        html += `<div class="fr-period">`;
        html += `<div class="fr-period-header">`;
        html += `<span class="fr-period-time">${escapeHtml(slotLabel)}</span>`;
        html += `</div>`;

        if (freeCount === 0) {
            html += `<div class="fr-period-count fr-period-count-none">All detected rooms are occupied</div>`;
        } else {
            html += `<div class="fr-period-count">${freeCount} room${freeCount !== 1 ? 's' : ''} available</div>`;
            html += `<div class="fr-rooms-list">`;
            for (const room of period.freeRooms) {
                html += `<div class="fr-room">${CHECK_ICON}<span>${escapeHtml(room)}</span></div>`;
            }
            html += `</div>`;
        }
        html += `</div>`;
    }

    contentEl.innerHTML = html;
}

// ============================================================
// Init — wired in by app.js
// ============================================================

/**
 * Wire Free Rooms into the app. Creates the panel DOM and launch buttons.
 *
 * @param {{getClasses?: () => Array<object>, getSelectedDay?: () => string,
 *          getRoomOccupancy?: () => Array<object>,
 *          getYearConfig?: () => object|null}} opts
 *   Live accessors for the currently parsed timetable, selected day,
 *   room-occupancy data (from parseRoomOccupancy), and active year config.
 */
export function initFreeRooms(opts = {}) {
    getClasses = opts.getClasses || getClasses;
    getRoomClasses = opts.getRoomClasses || getRoomClasses;
    getSelectedDay = opts.getSelectedDay || getSelectedDay;
    getRoomOccupancy = opts.getRoomOccupancy || getRoomOccupancy;
    getYearConfig = opts.getYearConfig || getYearConfig;
    ensureDom();
    ensureLaunchButtons();
}

function ensureLaunchButtons() {
    const topbar = document.querySelector('.mobile-topbar');
    if (topbar && !document.querySelector('#fr-launch-topbar')) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'fr-launch-topbar';
        btn.className = 'icon-btn fr-topbar-btn';
        btn.setAttribute('aria-label', 'Free Rooms');
        btn.setAttribute('aria-haspopup', 'dialog');
        btn.innerHTML = DOOR_ICON;
        btn.addEventListener('click', openPanel);
        topbar.insertBefore(btn, document.querySelector('#refresh-btn-mobile') || null);
    }

    const footer = document.querySelector('.sidebar-actions-card') || document.querySelector('.sidebar-footer');
    if (footer && !document.querySelector('#fr-launch-sidebar')) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'fr-launch-sidebar';
        btn.className = 'fr-launch-btn';
        btn.setAttribute('aria-haspopup', 'dialog');
        btn.innerHTML = `${DOOR_ICON}<span>Free Rooms</span>`;
        btn.addEventListener('click', openPanel);
        // Insert after any AI launch button, before install button
        const installBtn = footer.querySelector('.sidebar-install-btn');
        if (installBtn) {
            footer.insertBefore(btn, installBtn);
        } else {
            footer.insertBefore(btn, footer.firstChild);
        }
    }
}
