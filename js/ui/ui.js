import { CONFIG } from '../core/config.js?v=2026-08-28-001';
import { toMinutes, minutesToLabel, minutesToClock, todayName, isBeforeToday, WEEKDAYS, labSubjectLabel } from '../core/utils.js?v=2026-08-28-001';
import { offeringKey } from '../data/parser.js?v=2026-08-28-001';
import { rubberband, projectMomentum } from '../core/spring.js?v=2026-08-28-001';
import { mergeAdjacentForDisplay, displayItemHighlighted } from './display.js?v=2026-08-28-001';

/**
 * DOM rendering — sidebar filters + timeline.
 */

const $ = (sel) => document.querySelector(sel);
function $$(sel) { return [...document.querySelectorAll(sel)]; }

function svg(inner, size = 20) {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

const ICONS = {
    mapPin: svg('<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>', 15),
    clock: svg('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>', 15),
    alertTriangle: svg('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>', 13),
    calendarX: svg('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="m15 14-6 6m0-6 6 6"/>', 40),
    circleAlert: svg('<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>', 40),
    checkCircle: svg('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/>', 40),
    coffee: svg('<path d="M17 8h1a4 4 0 1 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"/><path d="M6 2v2M10 2v2M14 2v2"/>', 14),
    users: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>', 14),
};

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

function byStart(a, b) {
    return toMinutes(a.startTime) - toMinutes(b.startTime);
}

// ============================================================
// Sidebar rendering
// ============================================================

export function renderSidebar(state) {
    renderSidebarList('sidebar-schools', state.schools, state.schoolId, 'schoolId', 'schoolchange', 'schoolId');
    renderSidebarList('sidebar-programs', state.programs, state.programId, 'programId', 'programchange', 'programId');

    const programSection = $('#sidebar-program-section');
    if (programSection) {
        const show = state.programs && state.programs.length > 0;
        programSection.classList.toggle('hidden', !show);
    }

    const yearSection = $('#sidebar-years')?.closest('.sidebar-section');
    if (yearSection) {
        yearSection.classList.toggle('hidden', !state.years || state.years.length === 0);
        renderSidebarList('sidebar-years', state.years || [], state.yearId, 'yearId', 'yearchange', 'yearId');
    }

    const sectionWrapper = $('#sidebar-section-wrapper');
    if (sectionWrapper) {
        const show = state.sections && state.sections.length > 1;
        sectionWrapper.classList.toggle('hidden', !show);
        if (show) {
            renderSidebarSectionList('sidebar-sections', state.sections, state.sectionId);
        }
    }

    const electiveSection = $('#sidebar-elective-section');
    if (electiveSection) {
        const show = state.electives && state.electives.length > 0;
        electiveSection.classList.toggle('hidden', !show);
        if (show) {
            renderSidebarElectives('sidebar-electives', state.electives, state.selectedElectives, state.emergingToolsSection);
        }
    }
}

function renderSidebarList(containerId, items, selectedId, dataKey, eventName, stateKey) {
    const container = $(`#${containerId}`);
    if (!container) return;

    const sig = items.map(i => i.id || i).join(',');
    if (container.dataset.sig === sig) {
        for (const btn of container.children) {
            const id = btn.dataset[stateKey] ?? btn.dataset.section;
            btn.classList.toggle('active', id == selectedId);
        }
        return;
    }

    container.innerHTML = '';
    container.dataset.sig = sig;
    for (const item of items) {
        const id = item.id ?? item;
        const label = item.shortName || item.label || item;
        const sub = item.name || null;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sidebar-item' + (id == selectedId ? ' active' : '');
        btn.dataset[dataKey] = id;
        btn.setAttribute('role', 'radio');
        btn.setAttribute('aria-checked', id == selectedId ? 'true' : 'false');
        btn.setAttribute('aria-label', sub || String(label));
        btn.innerHTML = `<span class="sidebar-item-radio"></span><span class="sidebar-item-label">${escapeHtml(String(label))}</span>${sub ? `<span class="sidebar-item-sub">${escapeHtml(sub)}</span>` : ''}`;
        btn.addEventListener('click', () => {
            window.dispatchEvent(new CustomEvent(eventName, { detail: { [dataKey]: id } }));
        });
        container.appendChild(btn);
    }
}

function renderSidebarSectionList(containerId, sections, selectedId) {
    const container = $(`#${containerId}`);
    if (!container) return;

    const sorted = [...new Set(sections)].sort((a, b) => {
        if (typeof a === 'number' && typeof b === 'number') return a - b;
        return String(a).localeCompare(String(b));
    });
    const sig = sorted.join(',');
    if (container.dataset.sig === sig) {
        for (const btn of container.children) {
            const s = btn.dataset.section;
            const val = isNaN(s) ? s : Number(s);
            btn.classList.toggle('active', val === selectedId);
            btn.setAttribute('aria-checked', val === selectedId ? 'true' : 'false');
        }
        return;
    }

    container.innerHTML = '';
    container.dataset.sig = sig;
    for (const s of sorted) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sidebar-item' + (s === selectedId ? ' active' : '');
        btn.dataset.section = s;
        btn.setAttribute('role', 'radio');
        btn.setAttribute('aria-checked', s === selectedId ? 'true' : 'false');
        // Show numeric sections as "Section N"; string sections as-is (e.g. "BBA").
        const label = typeof s === 'number' ? `Section ${s}` : String(s);
        btn.setAttribute('aria-label', label);
        btn.innerHTML = `<span class="sidebar-item-radio"></span><span class="sidebar-item-label">${label}</span>`;
        btn.addEventListener('click', () => {
            window.dispatchEvent(new CustomEvent('sectionchange', { detail: { section: s } }));
        });
        container.appendChild(btn);
    }
}

/**
 * Multi-select elective list. Unlike the radio-style selectors, each item is
 * an independent checkbox: a student may pick zero, one, or many electives.
 * An elective configured with `sections` additionally expands into an
 * offering dropdown (sidebar offering selector) directly under its checkbox.
 */
function renderSidebarElectives(containerId, electives, selectedIds, emergingToolsSection) {
    const container = $(`#${containerId}`);
    if (!container) return;

    const sig = electives.map(e => `${e.id}:${(e.sections || []).length}`).join(',');
    if (container.dataset.sig === sig) {
        const selected = new Set(selectedIds || []);
        for (const el of container.children) {
            if (el.dataset.electiveId) {
                const active = selected.has(el.dataset.electiveId);
                el.classList.toggle('active', active);
                el.setAttribute('aria-checked', active ? 'true' : 'false');
            }
            if (el.dataset.electiveDropdown) {
                const checked = selected.has(el.dataset.electiveDropdown);
                el.classList.toggle('hidden', !checked);
                if (checked) {
                    const sel = el.querySelector('select');
                    if (sel && sel.value !== (emergingToolsSection || '')) sel.value = emergingToolsSection || '';
                }
            }
        }
        return;
    }

    container.innerHTML = '';
    container.dataset.sig = sig;
    const selected = new Set(selectedIds || []);
    for (const e of electives) {
        const isSelected = selected.has(e.id);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sidebar-item sidebar-item-check' + (isSelected ? ' active' : '');
        btn.dataset.electiveId = e.id;
        btn.setAttribute('role', 'checkbox');
        btn.setAttribute('aria-checked', isSelected ? 'true' : 'false');
        btn.setAttribute('aria-label', e.label);
        btn.innerHTML = `<span class="sidebar-item-checkbox"></span><span class="sidebar-item-label">${escapeHtml(e.label)}</span>`;
        btn.addEventListener('click', () => {
            const checked = !btn.classList.contains('active');
            window.dispatchEvent(new CustomEvent('electivetoggle', { detail: { electiveId: e.id, checked } }));
        });
        container.appendChild(btn);

        if (e.sections && e.sections.length) {
            container.appendChild(buildEmergingToolsDropdown(e, isSelected, emergingToolsSection));
        }
    }
}

// Offering dropdown for an elective that keeps its offerings in the sidebar
// (Emerging Tools and Applications). The chosen offering filters the main
// timetable to that instructor's class only.
function buildEmergingToolsDropdown(elective, selected, currentValue) {
    const wrap = document.createElement('div');
    wrap.className = 'sidebar-elective-dropdown' + (selected ? '' : ' hidden');
    wrap.dataset.electiveDropdown = elective.id;

    const label = document.createElement('span');
    label.className = 'sidebar-elective-dropdown-label';
    label.textContent = elective.sectionsLabel || 'Section';

    const sel = document.createElement('select');
    sel.className = 'sidebar-elective-select';
    sel.setAttribute('aria-label', (elective.sectionsLabel || 'Section'));

    // Default "nothing chosen yet" state: its text shows when no section is
    // selected, but it never appears in the opened dropdown list.
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select Section';
    placeholder.hidden = true;
    sel.appendChild(placeholder);

    for (const s of elective.sections) {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = `${s.label} — ${s.name}`;
        sel.appendChild(opt);
    }
    sel.value = currentValue || '';
    sel.addEventListener('change', () => {
        window.dispatchEvent(new CustomEvent('emergingtoolschange', {
            detail: { electiveId: elective.id, section: sel.value || null },
        }));
    });

    wrap.appendChild(label);
    wrap.appendChild(sel);
    return wrap;
}

export function renderDayFilter(selectedDay) {
    const container = $('#days-filter');
    if (!container) return;
    if (!container.children.length) {
        // Buttons are grouped into two fixed rows (Mon-Wed / Thu-Fri) so the
        // layout stays stable on mobile regardless of which day is selected.
        const rows = [document.createElement('div'), document.createElement('div')];
        rows.forEach((row) => { row.className = 'days-row'; });
        WEEKDAYS.forEach((day, i) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'day-filter-btn';
            btn.dataset.day = day;
            btn.textContent = day;
            btn.setAttribute('role', 'radio');
            btn.setAttribute('aria-checked', 'false');
            btn.setAttribute('aria-label', day);
            btn.addEventListener('click', () => {
                window.dispatchEvent(new CustomEvent('daychange', { detail: { day } }));
            });
            rows[i < 3 ? 0 : 1].appendChild(btn);
        });
        rows.forEach((row) => container.appendChild(row));
    }
    for (const btn of container.querySelectorAll('.day-filter-btn')) {
        const active = btn.dataset.day === selectedDay;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-checked', active ? 'true' : 'false');
    }
}

// ============================================================
// Mobile drawer
// ============================================================

let drawerFocusTrapCleanup = null;

// ============================================================
// Mobile drawer — 1:1 drag tracking with momentum handoff
//
// The sidebar opens/closes via the `open` class (CSS transition for the
// resting spring). While the user drags the sidebar, pointermove tracks the
// finger 1:1 (rubber-banding past the edge). On release the gesture's
// velocity is projected (§6 momentum projection) to decide open/close, then
// the inline transform is cleared so the CSS spring carries it home.
// ============================================================

function startDrawerDragTracking() {
    const sidebar = $('#sidebar');
    if (!sidebar) return;
    if (!window.matchMedia('(max-width: 767px)').matches) return;

    let startX = null;
    let startY = null;
    let history = [];
    let isDragging = false;
    let verticalLock = false;

    sidebar.addEventListener('pointerdown', (e) => {
        if (!sidebar.classList.contains('open')) return;
        startX = e.clientX;
        startY = e.clientY;
        history = [{ x: e.clientX, t: performance.now() }];
        isDragging = false;
        verticalLock = false;
    });

    sidebar.addEventListener('pointermove', (e) => {
        if (startX == null) return;
        if (verticalLock) return;
        if (!sidebar.classList.contains('open')) { startX = null; startY = null; history = []; isDragging = false; return; }
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        // If vertical movement dominates the gesture, the user is scrolling
        // inside the sidebar — permanently lock out drag for this gesture.
        // This MUST run before the deadzone check so that any scroll gesture
        // is locked out even within the 8 px tap-vs-drag threshold.
        if (Math.abs(dy) >= Math.abs(dx)) {
            verticalLock = true;
            isDragging = false;
            sidebar.style.transform = '';
            startX = null;
            startY = null;
            history = [];
            return;
        }
        // Only start drag tracking if the user has moved enough horizontally
        // to distinguish a tap from a drag. This prevents interference with
        // overlay clicks.  The vertical-dominance check above already ruled
        // out scroll gestures, so reaching here means horizontal movement
        // dominates.
        if (!isDragging && Math.abs(dx) < 8) return;
        isDragging = true;
        history.push({ x: e.clientX, t: performance.now() });
        if (history.length > 8) history.shift();
        const overshoot = dx;
        const resisted = overshoot > 0
            ? rubberband(overshoot, sidebar.offsetWidth, 0.55)
            : overshoot;
        sidebar.style.transform = `translateX(${resisted}px)`;
    });

    function resetDragState() {
        startX = null;
        startY = null;
        history = [];
        isDragging = false;
    }

    // A pointerup closes the drawer only for a committed horizontal drag —
    // the intentional swipe-to-close gesture. A gesture whose vertical
    // movement ever dominated was a scroll inside the sidebar; it can never
    // close the drawer. (`verticalLock` is belt-and-suspenders: the vertical
    // lockout in pointermove already resets isDragging/startX, but this also
    // guards exotic browsers that end a scroll with pointerup instead of
    // pointercancel.)
    function onPointerUp(e) {
        if (startX == null) return;
        if (!sidebar.classList.contains('open')) { resetDragState(); return; }
        const dx = e.clientX - startX;
        if (isDragging && !verticalLock) {
            let velocity = 0;
            if (history.length > 1) {
                const last = history[history.length - 1];
                const prev = history[Math.max(0, history.length - 3)];
                const dt = (last.t - prev.t) / 1000;
                if (dt > 0) velocity = (last.x - prev.x) / dt;
            }
            const projected = dx + projectMomentum(velocity);
            const open = projected > -40;
            sidebar.style.transform = '';
            sidebar.classList.toggle('open', open);
            overlayVisible(open);
        } else {
            // A tap (or a scroll the browser didn't cancel) — never a drag.
            sidebar.style.transform = '';
        }
        resetDragState();
    }

    // The browser took over this gesture for native scrolling (the sidebar
    // uses touch-action: pan-y, so a vertical pan scrolls the sidebar body
    // natively). A cancel is NEVER a drag-to-close. Real phones fire
    // pointercancel the moment a vertical scroll begins — treating it like a
    // pointerup here is exactly what closed the drawer mid-scroll. Clear any
    // partial drag transform and reset the gesture state, nothing else.
    function onPointerCancel() {
        if (startX == null) return;
        sidebar.style.transform = '';
        resetDragState();
    }

    sidebar.addEventListener('pointerup', onPointerUp);
    sidebar.addEventListener('pointercancel', onPointerCancel);
    // Use document for pointerup so a drag that ends outside the sidebar
    // is still properly resolved. Without setPointerCapture, events fire
    // on the element actually under the pointer.
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerCancel);
}

function overlayVisible(show) {
    const overlay = $('#drawer-overlay');
    if (overlay) overlay.classList.toggle('visible', show);
}

export function openDrawer() {
    const sidebar = $('#sidebar');
    const overlay = $('#drawer-overlay');
    if (!sidebar || !overlay) return;
    sidebar.classList.add('open');
    overlay.classList.add('visible');
    document.body.style.overflow = 'hidden';
    const focusable = sidebar.querySelectorAll('button:not([hidden]):not([disabled])');
    if (focusable.length) focusable[0].focus();
    drawerFocusTrapCleanup = trapFocus(sidebar, () => closeDrawer());
}

export function closeDrawer() {
    const sidebar = $('#sidebar');
    const overlay = $('#drawer-overlay');
    if (!sidebar || !overlay) return;
    sidebar.classList.remove('open');
    overlay.classList.remove('visible');
    document.body.style.overflow = '';
    if (drawerFocusTrapCleanup) { drawerFocusTrapCleanup(); drawerFocusTrapCleanup = null; }
    const hamburger = $('#hamburger-btn');
    if (hamburger) hamburger.focus();
}

export function isDrawerOpen() {
    const sidebar = $('#sidebar');
    return sidebar ? sidebar.classList.contains('open') : false;
}

/** Bind the gesture-driven drawer drag (mobile only). Call once at startup. */
export function initInteractions() {
    startDrawerDragTracking();
}

function trapFocus(container, onEscape) {
    function handler(e) {
        if (e.key === 'Escape') { e.preventDefault(); onEscape(); return; }
        if (e.key !== 'Tab') return;
        const focusable = container.querySelectorAll('button:not([hidden]):not([disabled])');
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
// Timeline rendering
// ============================================================

export function computeHighlight(classes, nowMin, day) {
    const dayClasses = classes.filter((c) => c.day === day).sort(byStart);
    if (day === todayName()) {
        const current = dayClasses.find((c) => toMinutes(c.startTime) <= nowMin && nowMin < toMinutes(c.endTime));
        const next = dayClasses.find((c) => toMinutes(c.startTime) > nowMin);
        return { dayClasses, current: current ?? null, next: next ?? null };
    }
    const next = isBeforeToday(day) ? null : (dayClasses[0] || null);
    return { dayClasses, current: null, next };
}

/**
 * Update the live bits of the highlighted timeline item — countdown text and
 * progress fill — from a single device-clock `now`. Called by the 1-second
 * live clock every tick, but only touches the DOM when the rendered values
 * actually change (the countdown text is minute-granular; the progress bar
 * moves second-by-second while a class is in progress). Never rebuilds the
 * timeline.
 */
export function updateLiveClock(now, current, next) {
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const nowSec = nowMin * 60 + now.getSeconds();
    const featured = current || next;
    if (!featured) {
        $('#timeline .tl-item.highlight .tl-countdown')?.remove();
        return;
    }
    const start = toMinutes(featured.startTime);
    const end = toMinutes(featured.endTime);
    const countdown = $('#timeline .tl-item.highlight .tl-countdown');
    if (countdown) {
        const text = current
            ? `${naturalDur(end - nowMin)} remaining`
            : start > nowMin ? `Starts in ${naturalDur(start - nowMin)}` : '';
        const html = text ? `${ICONS.clock}<span>${text}</span>` : '';
        if (countdown._lastHtml !== html) {
            countdown._lastHtml = html;
            countdown.innerHTML = html;
        }
    }
    const fill = $('#timeline .tl-item.highlight .progress-fill');
    const track = $('#timeline .tl-item.highlight .progress-track');
    const glow = $('#timeline .tl-item.highlight .progress-glow');
    if (fill) {
        const span = (end - start) * 60;
        const pct = span > 0 ? Math.min(100, Math.max(0, ((nowSec - start * 60) / span) * 100)) : 0;
        const width = pct + '%';
        if (fill._lastWidth !== width) {
            fill._lastWidth = width;
            fill.style.width = width;
        }
        if (glow) {
            glow.style.left = width;
        }
        const phase = pct >= 100 ? 'done' : pct >= 90 ? '4' : pct >= 75 ? '3' : pct >= 50 ? '2' : '1';
        if (track && track.dataset.phase !== phase) {
            track.dataset.phase = phase;
        }
        if (fill.dataset.phase !== phase) {
            fill.dataset.phase = phase;
        }
    }
}

function naturalDur(totalMin) {
    const m = Math.max(0, Math.round(totalMin));
    if (m >= 60) {
        const h = Math.floor(m / 60);
        const mm = m % 60;
        return mm ? `${h} hr ${mm} min` : `${h} hr`;
    }
    return `${m} min`;
}

export function renderTimeline(nowMin, day, ctx, query = '') {
    const section = $('#schedule-section');
    const timeline = $('#timeline');
    if (!section || !timeline) return;

    if (!timeline.dataset.offeringsBound) {
        timeline.dataset.offeringsBound = '1';
        timeline.addEventListener('click', (e) => {
            const btn = e.target.closest('.tl-offering');
            if (!btn) return;
            window.dispatchEvent(new CustomEvent('offeringchange', {
                detail: { electiveId: btn.dataset.elective, offeringKey: btn.dataset.offering },
            }));
        });
    }

    const today = ctx.dayClasses;
    const q = query.trim().toLowerCase();
    const isToday = day === todayName();
    const dayStatus = isToday ? 'today' : (isBeforeToday(day) ? 'past' : 'future');
    const highlight = isToday ? (ctx.current || ctx.next) : (dayStatus === 'future' ? ctx.next : null);

    $('#timeline-title').textContent = isToday ? "Today's Schedule" : `${day}'s Schedule`;
    section.classList.remove('hidden');
    timeline.innerHTML = '';

    if (q) {
        const matches = today.filter((c) => [c.displayName, c.subject, c.faculty, c.room].join(' ').toLowerCase().includes(q));
        if (!matches.length) {
            $('#timeline-stats').textContent = '';
            timeline.innerHTML = `<li class="tl-search-empty">No classes match "${escapeHtml(query.trim())}".</li>`;
            return;
        }
        buildTimeline(timeline, matches, nowMin, true, dayStatus, null);
        $('#timeline-stats').textContent = `${matches.length} match${matches.length > 1 ? 'es' : ''}`;
        return;
    }

    if (!today.length) {
        $('#timeline-stats').textContent = '';
        timeline.innerHTML = `
            <li class="tl-done empty">
                <div class="tl-done-icon">${ICONS.calendarX}</div>
                <strong>No classes scheduled</strong>
                <span>There are no classes on ${day}.</span>
            </li>`;
        return;
    }

    buildTimeline(timeline, today, nowMin, false, dayStatus, highlight);

    if (isToday) {
        const remaining = today.filter((c) => toMinutes(c.endTime) > nowMin);
        if (!remaining.length) {
            $('#timeline-stats').textContent = 'All done';
            timeline.insertAdjacentHTML('afterbegin', `
                <li class="tl-done">
                    <div class="tl-done-icon">${ICONS.checkCircle}</div>
                    <strong>No more classes today</strong>
                    <span>See you tomorrow.</span>
                </li>`);
        } else {
            $('#timeline-stats').textContent = `${remaining.length} left`;
        }
    } else {
        $('#timeline-stats').textContent = `${today.length} class${today.length > 1 ? 'es' : ''}`;
    }
}

function buildTimeline(timeline, items, nowMin, skipBreaks, dayStatus = 'today', highlight = null) {
    let prevEnd = null;
    let lunchShown = false;
    for (const c of items) {
        const startMin = toMinutes(c.startTime);
        const endMin = toMinutes(c.endTime);
        const status = dayStatus === 'past' ? 'completed'
            : dayStatus === 'future' ? 'upcoming'
            : (endMin <= nowMin ? 'completed' : (startMin <= nowMin ? 'current' : 'upcoming'));
        const hl = c === highlight;

        if (!skipBreaks && prevEnd !== null && startMin - prevEnd >= CONFIG.BREAK_THRESHOLD_MIN) {
            const overlapsLunch = prevEnd < CONFIG.LUNCH_END && startMin > CONFIG.LUNCH_START;
            if (overlapsLunch && !lunchShown) {
                lunchShown = true;
                timeline.insertAdjacentHTML('beforeend', `
                    <li class="tl-break">
                        <span class="tl-break-line"></span>
                        <span class="tl-break-label">${ICONS.coffee}Lunch break · ${minutesToLabel(startMin - prevEnd)}</span>
                        <span class="tl-break-line"></span>
                    </li>`);
            }
        }

        const badge = hl
            ? { cls: 'status-next', label: dayStatus === 'future' ? 'First class' : (status === 'current' ? 'In progress' : 'Next') }
            : { cls: `status-${status}`, label: { completed: 'Done', current: 'In progress', upcoming: 'Upcoming' }[status] };

        const live = dayStatus === 'today' && hl ? `
            <div class="tl-countdown">${ICONS.clock}<span>${status === 'current'
                ? `${naturalDur(endMin - nowMin)} remaining`
                : `Starts in ${naturalDur(startMin - nowMin)}`}</span></div>` : '';
        const _initPct = Math.min(100, Math.max(0, ((nowMin - startMin) / (endMin - startMin)) * 100));
        const _initPhase = _initPct >= 100 ? 'done' : _initPct >= 90 ? '4' : _initPct >= 75 ? '3' : _initPct >= 50 ? '2' : '1';
        const progress = dayStatus === 'today' && hl && status === 'current' ? `
            <div class="progress-wrap">
                <div class="progress-track" data-phase="${_initPhase}"><div class="progress-fill" style="width:${_initPct}%"></div><div class="progress-glow" style="left:${_initPct}%"></div></div>
                <div class="progress-meta">
                    <span class="progress-elapsed">${minutesToClock(startMin)}</span>
                    <span class="progress-remaining">${minutesToClock(endMin)}</span>
                </div>
            </div>` : '';

        const item = document.createElement('li');
        item.className = `tl-item ${status}${hl ? ' highlight' : ''}`;
        item.innerHTML = `
            <div class="tl-marker"></div>
            <div class="tl-card">
                <div class="tl-card-top">
                    <div>
                        <div class="tl-subject">${escapeHtml(c.lab ? labSubjectLabel(c.displayName || c.subject) : (c.displayName || c.subject))}${c.lab ? '<span class="badge badge-lab tl-lab-tag">Lab</span>' : ''}</div>
                        <div class="tl-meta">
                            ${c.faculty && status !== 'completed' ? `<span class="tl-faculty">${escapeHtml(c.faculty)}</span>` : ''}
                            <span class="tl-room">${ICONS.mapPin}<span>${escapeHtml(c.room || 'Room TBA')}</span></span>
                        </div>
                    </div>
                    <span class="status-badge ${badge.cls}">${badge.label}</span>
                </div>
                ${c.roomChanged ? `<span class="room-change-badge">${ICONS.alertTriangle}<span>${c.originalRoom ? `Room changed · ${escapeHtml(c.originalRoom)} → ${escapeHtml(c.room)}` : 'Room changed'}</span></span>` : ''}
                ${renderOfferings(c, status)}
                ${live}${progress}
                <div class="tl-time-row">
                    <span>${minutesToClock(startMin)} – ${minutesToClock(endMin)}</span>
                    <span class="tl-duration">${minutesToLabel(endMin - startMin)}</span>
                </div>
            </div>`;
        timeline.appendChild(item);
        prevEnd = endMin;
    }
}

// Side-by-side single-select offering chips for a multi-offering elective
// event. The chosen offering is highlighted; picking another dispatches
// `offeringchange` so the app persists it and re-renders with that offering.
// The chips are a configuration control only — they never indicate live
// status. On completed classes every chip is rendered neutral (no highlight,
// no checkmark) so a finished course never reads as "this room is active",
// while `aria-pressed` keeps the persisted choice accessible.
// Faculty is omitted on completed classes so a finished course never reads
// as "completed by <faculty>" — only that it is done.
function renderOfferings(c, status) {
    // The sidebar offering dropdown is the sole selector for this elective;
    // the in-card chips would fight it, so they are not rendered.
    if (c.dropdownScoped) return '';
    if (!c.offerings || c.offerings.length <= 1) return '';
    const chips = c.offerings.map((o, i) => {
        const sel = i === c.selectedOffering;
        const active = status !== 'completed' && sel;
        const parts = [];
        if (o.section) parts.push(escapeHtml(o.section));
        if (o.faculty && status !== 'completed') parts.push(escapeHtml(o.faculty));
        if (o.room) parts.push(escapeHtml(o.room));
        return `<button type="button" class="tl-offering${active ? ' active' : ''}" data-elective="${escapeHtml(c.elective)}" data-offering="${escapeHtml(offeringKey(o))}" aria-pressed="${sel ? 'true' : 'false'}">${parts.join(' · ')}</button>`;
    }).join('');
    return `
        <div class="tl-offerings">
            <span class="tl-offerings-label">${ICONS.users}Offering</span>
            <div class="tl-offerings-list">${chips}</div>
        </div>`;
}

// ============================================================
// Breakout game CTA (sidebar footer)
// ============================================================

// Legacy sidebar Play Breakout CTA (kept as no-op for backward compat).
// The #game-cta HTML element was removed; the function silently returns.
export function renderGameSuggestion(ctx, nowMin, day) {
    const el = $('#game-cta');
    if (!el) return;

    const hide = () => el.classList.add('hidden');

    // Only invite a game once a timetable is actually on screen.
    const section = $('#schedule-section');
    if (!section || section.classList.contains('hidden')) { hide(); return; }

    // The only rule: never encourage a game while a class is in progress.
    if (ctx.current) { hide(); return; }

    // Today only: don't encourage a game when the next class is imminent.
    const next = ctx.next;
    if (next && day === todayName() && toMinutes(next.startTime) - nowMin <= CONFIG.GAME_SUGGEST_MIN) {
        hide();
        return;
    }

    el.classList.remove('hidden');
}

// ============================================================
// State cards
// ============================================================

function hideAll() { $('#schedule-section')?.classList.add('hidden'); }

export function renderEmpty() {
    hideLoading(); hideAll();
    $('.state-card')?.classList.remove('hidden');
    $('#empty-icon').innerHTML = ICONS.calendarX;
    $('#state-title').textContent = 'No classes found';
    $('#state-message').textContent = 'There are no classes scheduled for this day.';
    $('.retry-btn')?.classList.add('hidden');
}

export function renderError({ title, message } = {}) {
    hideLoading(); hideAll();
    $('.state-card')?.classList.remove('hidden');
    $('#empty-icon').innerHTML = ICONS.circleAlert;
    $('#state-title').textContent = title || "Couldn't load the timetable";
    $('#state-message').textContent = message || 'Check your connection and try again.';
    $('.retry-btn')?.classList.remove('hidden');
}

export function renderSuccess() {
    hideLoading();
    $('.state-card')?.classList.add('hidden');
    $('.retry-btn')?.classList.add('hidden');
}

// ============================================================
// Loading
// ============================================================

export function showLoading() {
    const el = $('#loading-state');
    if (!el) return;
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.add('visible'), 150);
}

export function hideLoading() {
    const el = $('#loading-state');
    if (el) {
        clearTimeout(el._timer);
        el.classList.remove('visible');
    }
}

export function renderDateLine() {}

export function setLastUpdated(date) {
    const el = $('#last-updated');
    if (el) el.textContent = `Updated ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
}

export function showToast(message) {
    const toast = $('.toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.classList.remove('show'); toast.textContent = ''; }, 3000);
}

export function setRefreshSpinning(on) {
    $('#refresh-btn-mobile')?.classList.toggle('spinning', on);
}

// ============================================================
// Section modal
// ============================================================

export function showSectionModal(sections, onSelect) {
    const modal = $('#section-modal');
    if (!modal) return;
    const options = $('#section-modal-options');
    options.innerHTML = '';
    const sorted = [...new Set(sections)].sort((a, b) => {
        // Numeric sections sort by number; string sections sort alphabetically.
        if (typeof a === 'number' && typeof b === 'number') return a - b;
        return String(a).localeCompare(String(b));
    });
    for (const s of sorted) {
        const btn = document.createElement('button');
        btn.className = 'section-option';
        // Show numeric sections as "Section N"; string sections as-is (e.g. "BBA").
        btn.textContent = typeof s === 'number' ? `Section ${s}` : String(s);
        btn.addEventListener('click', () => { hideSectionModal(); onSelect(s); });
        options.appendChild(btn);
    }
    modal.classList.remove('hidden');
    requestAnimationFrame(() => {
        modal.classList.add('show');
        options.querySelector('button')?.focus();
    });
}

export function hideSectionModal() {
    const modal = $('#section-modal');
    if (!modal) return;
    modal.classList.remove('show');
    modal.classList.add('hidden');
}
