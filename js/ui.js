import { CONFIG } from './config.js?v=2026-08-06-001';
import { toMinutes, minutesToLabel, minutesToClock, todayName, isBeforeToday, WEEKDAYS } from './utils.js?v=2026-08-06-001';

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
        const show = state.programs && state.programs.length > 1;
        programSection.classList.toggle('hidden', !show);
    }

    const yearSection = $('#sidebar-years')?.closest('.sidebar-section');
    if (yearSection) {
        const singleYear = state.years && state.years.length <= 1;
        yearSection.classList.toggle('hidden', singleYear);
        if (!singleYear) {
            renderSidebarList('sidebar-years', state.years, state.yearId, 'yearId', 'yearchange', 'yearId');
        }
    }

    const sectionWrapper = $('#sidebar-section-wrapper');
    if (sectionWrapper) {
        const show = state.sections && state.sections.length > 1;
        sectionWrapper.classList.toggle('hidden', !show);
        if (show) {
            renderSidebarSectionList('sidebar-sections', state.sections, state.sectionId);
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

    const sorted = [...new Set(sections)].sort((a, b) => a - b);
    const sig = sorted.join(',');
    if (container.dataset.sig === sig) {
        for (const btn of container.children) {
            const s = Number(btn.dataset.section);
            btn.classList.toggle('active', s === selectedId);
            btn.setAttribute('aria-checked', s === selectedId ? 'true' : 'false');
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
        btn.setAttribute('aria-label', `Section ${s}`);
        btn.innerHTML = `<span class="sidebar-item-radio"></span><span class="sidebar-item-label">Section ${s}</span>`;
        btn.addEventListener('click', () => {
            window.dispatchEvent(new CustomEvent('sectionchange', { detail: { section: s } }));
        });
        container.appendChild(btn);
    }
}

export function renderDayFilter(selectedDay) {
    const container = $('#sidebar-days');
    if (!container) return;
    if (!container.children.length) {
        for (const day of WEEKDAYS) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'sidebar-day-btn';
            btn.dataset.day = day;
            btn.textContent = day;
            btn.setAttribute('role', 'radio');
            btn.setAttribute('aria-checked', 'false');
            btn.setAttribute('aria-label', day);
            btn.addEventListener('click', () => {
                window.dispatchEvent(new CustomEvent('daychange', { detail: { day } }));
            });
            container.appendChild(btn);
        }
    }
    for (const btn of container.children) {
        const active = btn.dataset.day === selectedDay;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-checked', active ? 'true' : 'false');
    }
}

// ============================================================
// Mobile drawer
// ============================================================

let drawerFocusTrapCleanup = null;

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

export function updateLiveClock(nowMin, current, next) {
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
        countdown.innerHTML = text ? `${ICONS.clock}<span>${text}</span>` : '';
    }
    const fill = $('#timeline .tl-item.highlight .progress-fill');
    if (fill) {
        const pct = Math.min(100, Math.max(0, ((nowMin - start) / (end - start)) * 100));
        fill.style.width = pct + '%';
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

    const today = ctx.dayClasses;
    const q = query.trim().toLowerCase();
    const isToday = day === todayName();
    const dayStatus = isToday ? 'today' : (isBeforeToday(day) ? 'past' : 'future');
    const highlight = isToday ? (ctx.current || ctx.next) : (dayStatus === 'future' ? ctx.next : null);

    $('#timeline-title').textContent = isToday ? "Today's Schedule" : `${day}'s Schedule`;
    section.classList.remove('hidden');
    timeline.innerHTML = '';

    if (q) {
        const matches = today.filter((c) => [c.subject, c.faculty, c.room].join(' ').toLowerCase().includes(q));
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
        const progress = dayStatus === 'today' && hl && status === 'current' ? `
            <div class="progress-wrap">
                <div class="progress-track"><div class="progress-fill" style="width:${Math.min(100, Math.max(0, ((nowMin - startMin) / (endMin - startMin)) * 100))}%"></div></div>
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
                        <div class="tl-subject">${escapeHtml(c.subject)}</div>
                        <div class="tl-meta">
                            ${c.faculty ? `<span class="tl-faculty">${escapeHtml(c.faculty)}</span>` : ''}
                            <span class="tl-room">${ICONS.mapPin}<span>${escapeHtml(c.room || 'Room TBA')}</span></span>
                        </div>
                    </div>
                    <span class="status-badge ${badge.cls}">${badge.label}</span>
                </div>
                ${c.roomChanged ? `<span class="room-change-badge">${ICONS.alertTriangle}<span>${c.originalRoom ? `Room changed · ${escapeHtml(c.originalRoom)} → ${escapeHtml(c.room)}` : 'Room changed'}</span></span>` : ''}
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

export function renderError() {
    hideLoading(); hideAll();
    $('.state-card')?.classList.remove('hidden');
    $('#empty-icon').innerHTML = ICONS.circleAlert;
    $('#state-title').textContent = "Couldn't load the timetable";
    $('#state-message').textContent = 'Check your connection and try again. Your last known schedule is still cached offline.';
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
    if (!el) return;
    clearTimeout(el._timer);
    el.classList.remove('visible');
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
    const sorted = [...new Set(sections)].sort((a, b) => a - b);
    for (const s of sorted) {
        const btn = document.createElement('button');
        btn.className = 'section-option';
        btn.textContent = `Section ${s}`;
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
