/**
 * Teacher Lookup — search a teacher's name and see their free/busy
 * schedule for the currently selected day.
 *
 * Mirrors the Free Rooms panel design language (slide-up sheet, backdrop,
 * focus trap). Data comes from the cached main-sheet CSV that the teacher
 * page already uses — parsed lazily on first panel open so the student
 * timetable load is never slowed down.
 */

import { toMinutes, minutesToClock, minutesToLabel, todayName } from '../core/utils.js?v=2026-09-11-001';
import { parseTeacherGrid, normalizeFacultyName } from '../data/parser.js?v=2026-09-11-001';
import { buildIdentityResolution, teacherSearchText } from '../data/teacher-identity.js?v=2026-09-11-001';
import { trackEvent } from '../services/analytics.js?v=2026-09-11-001';

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

const svg = (inner, size = 16) =>
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

const CLOSE_ICON = svg('<path d="M18 6 6 18M6 6l12 12"/>', 18);
const SEARCH_ICON = svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>', 15);
const USER_ICON = svg('<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>', 15);
const CHECK_ICON = svg('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/>', 12);
const CLOCK_ICON = svg('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>', 12);
const ARROW_ICON = svg('<path d="m15 18-6-6 6-6"/>', 14);
const EMPTY_ICON = svg('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="m15 14-6 6m0-6 6 6"/>', 36);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let panel = null;
let contentEl = null;
let searchInput = null;
let focusTrapCleanup = null;
let lastFocused = null;

let getSelectedDay = () => null;
let getCsvText = () => '';

// Built lazily on first open.
let teacherData = null; // { resolution, teachers, allSlots }

const MAIN_SHEET_CACHE_KEY = 'tt-teachers-main-sheet-v1';
const TEACHER_SPLIT_RE = /\s*(?:[,;/]|\band\b|&)\s*/gi;

// ---------------------------------------------------------------------------
// Faculty splitting (inlined to avoid heavy teacher-index imports)
// ---------------------------------------------------------------------------

function splitTeachers(rawFaculty) {
    const raw = String(rawFaculty ?? '');
    if (!raw.trim()) return [];
    return raw
        .split(TEACHER_SPLIT_RE)
        .map((part) => part.trim().replace(/^Prof\.\s+/i, ''))
        .filter(Boolean)
        .map(normalizeFacultyName)
        .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Data building (runs once on first panel open)
// ---------------------------------------------------------------------------

function buildTeacherData() {
    if (teacherData) return teacherData;

    const csv = getCsvText();
    if (!csv) return null;

    let rawClasses = [];
    try {
        rawClasses = parseTeacherGrid(csv);
    } catch {
        return null;
    }
    if (!rawClasses.length) return null;

    // Collect all observed teacher names for identity resolution.
    const observed = [];
    for (const c of rawClasses) {
        observed.push(...splitTeachers(c.faculty));
    }
    const resolution = buildIdentityResolution(observed);

    // Build per-teacher class lists.
    const teachers = new Map(); // canonicalId → {name, searchText, classes: []}
    for (const c of rawClasses) {
        const names = splitTeachers(c.faculty);
        if (!names.length) continue;
        for (const name of names) {
            const ident = resolution.byName.get(name) || {
                id: String(name).toLowerCase().replace(/\s+/g, '-'),
                displayName: name,
                aliases: [name],
            };
            let rec = teachers.get(ident.id);
            if (!rec) {
                rec = {
                    id: ident.id,
                    name: ident.displayName,
                    searchText: teacherSearchText(ident.id, ident.displayName, ident.aliases),
                    classes: [],
                };
                teachers.set(ident.id, rec);
            }
            rec.classes.push({
                day: c.day,
                startTime: c.startTime,
                endTime: c.endTime,
                subject: c.subject,
                room: c.room,
                section: c.section,
            });
        }
    }

    // Collect all unique time slots across all days (for free-slot rendering).
    const slotSet = new Set();
    for (const c of rawClasses) {
        slotSet.add(`${c.day}|${c.startTime}|${c.endTime}`);
    }
    const allSlots = new Map(); // day → [{startTime, endTime, startMin, endMin}]
    for (const key of slotSet) {
        const [day, start, end] = key.split('|');
        if (!allSlots.has(day)) allSlots.set(day, []);
        allSlots.get(day).push({
            startTime: start,
            endTime: end,
            startMin: toMinutes(start),
            endMin: toMinutes(end),
        });
    }
    for (const [, slots] of allSlots) {
        slots.sort((a, b) => a.startMin - b.startMin);
    }

    teacherData = { resolution, teachers, allSlots };
    return teacherData;
}

// ---------------------------------------------------------------------------
// DOM construction
// ---------------------------------------------------------------------------

function ensureDom() {
    if (panel) return;
    document.body.insertAdjacentHTML('beforeend', `
        <div id="teacher-lookup-panel" class="ai-panel teacher-lookup-panel" role="dialog" aria-modal="true" aria-labelledby="tl-title" aria-hidden="true">
            <div class="ai-backdrop" data-tl-close></div>
            <div class="ai-sheet teacher-lookup-sheet">
                <header class="ai-header">
                    <div class="ai-heading">
                        <h2 id="tl-title" class="ai-title"><span class="ai-spark">${USER_ICON}</span>Teacher Lookup</h2>
                        <p id="tl-day-label" class="ai-subtitle"></p>
                    </div>
                    <button type="button" id="tl-close-btn" class="icon-btn" aria-label="Close teacher lookup">${CLOSE_ICON}</button>
                </header>
                <div id="tl-content" class="teacher-lookup-content" role="log" aria-live="polite"></div>
            </div>
        </div>`);

    panel = $('#teacher-lookup-panel');
    contentEl = $('#tl-content');
    const closeBtn = $('#tl-close-btn');
    const backdrop = panel.querySelector('.ai-backdrop');

    closeBtn.addEventListener('click', closePanel);
    backdrop.addEventListener('click', closePanel);
}

// ---------------------------------------------------------------------------
// Open / close
// ---------------------------------------------------------------------------

export function openPanel() {
    if (!panel || panel.classList.contains('open')) return;
    lastFocused = document.activeElement;
    renderContent();
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    focusTrapCleanup = trapFocus(panel, closePanel);
    trackEvent('teacher_lookup_click', {
        selected_day: getSelectedDay() || '',
        source: 'timetable',
    });
    // Focus the search input after the transition starts.
    setTimeout(() => {
        const input = panel.querySelector('.tl-search-input');
        if (input) input.focus();
    }, 100);
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
        const focusable = container.querySelectorAll('button:not([disabled]), input:not([disabled])');
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

// ---------------------------------------------------------------------------
// Content rendering
// ---------------------------------------------------------------------------

function renderContent() {
    if (!contentEl) return;
    const day = getSelectedDay();

    // Update day label.
    const dayLabel = $('#tl-day-label');
    if (dayLabel) {
        dayLabel.textContent = day ? `${day}'s Schedule` : 'No day selected';
    }

    const data = buildTeacherData();
    if (!data) {
        contentEl.innerHTML = `
            <div class="tl-empty">
                <div class="tl-empty-icon">${EMPTY_ICON}</div>
                <strong>No teacher data</strong>
                <span>Could not load teacher timetable data.</span>
            </div>`;
        return;
    }

    // Default view: search + teacher list.
    const sorted = [...data.teachers.values()].sort((a, b) =>
        a.name.toLowerCase().localeCompare(b.name.toLowerCase())
    );

    contentEl.innerHTML = `
        <div class="tl-search-wrap">
            <span class="tl-search-icon">${SEARCH_ICON}</span>
            <input type="text" class="tl-search-input" placeholder="Search teacher name…" autocomplete="off" aria-label="Search teacher">
        </div>
        <div id="tl-teacher-list" class="tl-teacher-list" role="listbox" aria-label="Teachers"></div>
        <div id="tl-timeline" class="tl-timeline"></div>`;

    const listEl = $('#tl-teacher-list');
    const timelineEl = $('#tl-timeline');
    searchInput = contentEl.querySelector('.tl-search-input');

    // Render the full teacher list.
    for (const t of sorted) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tl-teacher-item';
        btn.dataset.id = t.id;
        btn.dataset.search = t.searchText;
        btn.setAttribute('role', 'option');
        btn.innerHTML = `
            <span class="tl-teacher-name">${escapeHtml(t.name)}</span>
            <span class="tl-teacher-count">${t.classes.length} class${t.classes.length !== 1 ? 'es' : ''}</span>`;
        btn.addEventListener('click', () => selectTeacher(t.id));
        listEl.appendChild(btn);
    }

    // Search filtering.
    searchInput.addEventListener('input', () => {
        const q = searchInput.value.trim().toLowerCase();
        let visible = 0;
        for (const btn of listEl.children) {
            const show = !q || (btn.dataset.search || '').includes(q);
            btn.classList.toggle('hidden', !show);
            if (show) visible++;
        }
        // Hide timeline when searching.
        if (q) {
            timelineEl.innerHTML = '';
            timelineEl.classList.add('hidden');
        }
    });
}

// ---------------------------------------------------------------------------
// Teacher selection → day timeline
// ---------------------------------------------------------------------------

function selectTeacher(id) {
    const data = buildTeacherData();
    if (!data || !data.teachers.has(id)) return;

    const teacher = data.teachers.get(id);
    const day = getSelectedDay();
    const timelineEl = $('#tl-timeline');
    const listEl = $('#tl-teacher-list');
    if (!timelineEl || !listEl) return;

    // Hide search and list, show timeline with back button.
    const searchWrap = contentEl.querySelector('.tl-search-wrap');
    if (searchWrap) searchWrap.classList.add('hidden');
    listEl.classList.add('hidden');
    timelineEl.classList.remove('hidden');

    // Update subtitle.
    const dayLabel = $('#tl-day-label');
    if (dayLabel) {
        dayLabel.textContent = day ? `${teacher.name} — ${day}` : teacher.name;
    }

    if (!day) {
        timelineEl.innerHTML = `
            <div class="tl-empty">
                <div class="tl-empty-icon">${EMPTY_ICON}</div>
                <strong>No day selected</strong>
                <span>Select a day in the timetable first.</span>
            </div>`;
        return;
    }

    // Get the teacher's classes for this day.
    const dayClasses = teacher.classes
        .filter((c) => c.day === day)
        .sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));

    // Get all time slots for this day.
    const allSlots = data.allSlots.get(day) || [];

    if (!allSlots.length) {
        timelineEl.innerHTML = `
            <div class="tl-empty">
                <div class="tl-empty-icon">${EMPTY_ICON}</div>
                <strong>No periods found</strong>
                <span>No scheduled periods on ${escapeHtml(day)}.</span>
            </div>`;
        return;
    }

    // Build the timeline: for each slot, determine if the teacher is busy or free.
    let html = `<button type="button" class="tl-back-btn" id="tl-back">${ARROW_ICON}<span>All teachers</span></button>`;
    html += `<div class="tl-day-label">${escapeHtml(day)}</div>`;

    // Mark busy slots via interval overlap check.
    const busySlots = new Set();
    for (const cls of dayClasses) {
        const cStart = toMinutes(cls.startTime);
        const cEnd = toMinutes(cls.endTime);
        for (let i = 0; i < allSlots.length; i++) {
            const s = allSlots[i];
            if (cStart < s.endMin && cEnd > s.startMin) {
                busySlots.add(i);
            }
        }
    }

    // Render each slot as occupied or free.
    let freeCount = 0;
    for (let i = 0; i < allSlots.length; i++) {
        const slot = allSlots[i];
        const isBusy = busySlots.has(i);
        const slotLabel = `${minutesToClock(slot.startMin)} – ${minutesToClock(slot.endMin)}`;

        if (isBusy) {
            // Find the class(es) for this slot.
            const cls = dayClasses.find((c) => {
                const cStart = toMinutes(c.startTime);
                const cEnd = toMinutes(c.endTime);
                return cStart < slot.endMin && cEnd > slot.startMin;
            });
            html += `<div class="tl-slot tl-slot-busy">
                <div class="tl-slot-header">
                    <span class="tl-slot-time">${escapeHtml(slotLabel)}</span>
                    <span class="tl-slot-badge tl-slot-badge-busy">${CLOCK_ICON} Teaching</span>
                </div>
                <div class="tl-slot-detail">
                    <span class="tl-slot-subject">${escapeHtml(cls?.subject || '')}</span>
                    ${cls?.room ? `<span class="tl-slot-room">${escapeHtml(cls.room)}</span>` : ''}
                </div>
            </div>`;
        } else {
            freeCount++;
            html += `<div class="tl-slot tl-slot-free">
                <div class="tl-slot-header">
                    <span class="tl-slot-time">${escapeHtml(slotLabel)}</span>
                    <span class="tl-slot-badge tl-slot-badge-free">${CHECK_ICON} Free</span>
                </div>
            </div>`;
        }
    }

    // Summary at the bottom.
    const totalSlots = allSlots.length;
    html += `<div class="tl-summary">${CHECK_ICON}<span>${freeCount} of ${totalSlots} period${totalSlots !== 1 ? 's' : ''} free</span></div>`;

    timelineEl.innerHTML = html;

    // Wire back button.
    $('#tl-back')?.addEventListener('click', () => {
        renderContent();
    });
}

// ---------------------------------------------------------------------------
// Init — wired in by app.js
// ---------------------------------------------------------------------------

/**
 * Wire Teacher Lookup into the app. Creates the panel DOM and launch button.
 *
 * @param {{getSelectedDay?: () => string, getCsvText?: () => string}} opts
 */
export function initTeacherLookup(opts = {}) {
    getSelectedDay = opts.getSelectedDay || getSelectedDay;
    getCsvText = opts.getCsvText || getCsvText;
    ensureDom();
    ensureLaunchButton();
}

function ensureLaunchButton() {
    const footer = document.querySelector('.sidebar-actions-card') || document.querySelector('.sidebar-footer');
    if (footer && !document.querySelector('#tl-launch-sidebar')) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'tl-launch-sidebar';
        btn.className = 'fr-launch-btn';
        btn.setAttribute('aria-haspopup', 'dialog');
        btn.innerHTML = `${USER_ICON}<span>Teacher Lookup</span>`;
        btn.addEventListener('click', openPanel);
        // Insert after the Free Rooms button, before install button.
        const installBtn = footer.querySelector('.sidebar-install-btn');
        const frBtn = footer.querySelector('#fr-launch-sidebar');
        if (frBtn && frBtn.nextSibling) {
            footer.insertBefore(btn, frBtn.nextSibling);
        } else if (installBtn) {
            footer.insertBefore(btn, installBtn);
        } else {
            footer.insertBefore(btn, footer.firstChild);
        }
    }
}
