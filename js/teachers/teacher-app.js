/**
 * Teacher timetable page controller (teachers.html).
 *
 * Standalone page — deliberately independent of the student app shell. It
 * loads the full teacher index once (see js/services/teacher-fetch.js), then
 * offers a fast, searchable teacher list and renders the selected teacher's
 * weekly schedule using the same timeline markup/CSS as the student app.
 *
 * Only real classes from the source sheets are ever shown. Days without any
 * of the teacher's classes are not offered as filters, and free periods are
 * never invented — the timeline simply shows the classes that exist.
 */

import { loadTeacherIndex } from '../services/teacher-fetch.js?v=2026-08-21-011';
import { CONFIG } from '../core/config.js?v=2026-08-21-011';
import { initAiAssistant } from '../ui/ai-assistant.js?v=2026-08-21-011';
import { toMinutes, minutesToLabel, minutesToClock, todayName, WEEKDAYS, labSubjectLabel } from '../core/utils.js?v=2026-08-21-011';
import { confirmTeacherMerge, dismissTeacherMerge } from '../data/teacher-identity.js?v=2026-08-21-011';

const $ = (sel) => document.querySelector(sel);

const DEBUG = typeof location !== 'undefined'
    && new URLSearchParams(location.search).has('debug');

const BREAK_THRESHOLD_MIN = 40;

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

const ICONS = {
    pin: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>',
    coffee: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 8h1a4 4 0 1 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"/><path d="M6 2v2M10 2v2M14 2v2"/></svg>',
};

const state = {
    index: null,
    order: [],
    classes: [],
    candidates: [],
    selectedKey: null,
    selectedDay: null,
};

const byStart = (a, b) => toMinutes(a.startTime) - toMinutes(b.startTime);

function dayClasses(key, day) {
    const rec = state.index && state.index.get(key);
    if (!rec) return [];
    return rec.classes.filter((c) => c.day === day).sort(byStart);
}

// ============================================================
// Teacher picker (searchable list)
// ============================================================

function renderTeacherList() {
    const list = $('#teacher-list');
    list.innerHTML = '';
    for (const key of state.order) {
        const rec = state.index.get(key);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'teacher-list-item' + (key === state.selectedKey ? ' active' : '');
        btn.dataset.key = key;
        btn.dataset.search = rec.searchText || String(rec.name || '').toLowerCase();
        btn.setAttribute('role', 'option');
        btn.setAttribute('aria-selected', key === state.selectedKey ? 'true' : 'false');
        btn.innerHTML = `<span class="teacher-list-name">${escapeHtml(rec.name)}</span><span class="teacher-list-count">${rec.classes.length}</span>`;
        btn.addEventListener('click', () => select(key));
        list.appendChild(btn);
    }
    applySearch('');
}

function applySearch(query) {
    const needle = query.trim().toLowerCase();
    const list = $('#teacher-list');
    let visible = 0;
    for (const btn of list.children) {
        // Search matches the canonical id, display name, folded name AND every
        // alias — "Roopam" finds "Prof. Rupam Shah" via its alias; "Mariya"
        // finds "Prof. Dr. Mariya" via the folded display name.
        const show = !needle || (btn.dataset.search || '').includes(needle);
        btn.classList.toggle('hidden', !show);
        if (show) visible++;
    }
    const count = $('#teacher-count');
    if (count) {
        count.textContent = needle
            ? `${visible} of ${state.order.length} teachers`
            : `${state.order.length} teacher${state.order.length === 1 ? '' : 's'}`;
    }
}

function select(key) {
    if (!state.index.has(key)) return;
    state.selectedKey = key;
    for (const btn of $('#teacher-list').children) {
        const active = btn.dataset.key === key;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
    }

    const rec = state.index.get(key);
    const days = WEEKDAYS.filter((d) => rec.classes.some((c) => c.day === d));
    let day = state.selectedDay && days.includes(state.selectedDay) ? state.selectedDay : null;
    if (!day) {
        const t = todayName();
        day = days.includes(t) ? t : (days[0] || null);
    }
    state.selectedDay = day;

    $('#teacher-name').textContent = rec.name;
    $('#teacher-summary').textContent =
        `${rec.classes.length} weekly class${rec.classes.length === 1 ? '' : 'es'} on ${days.length} day${days.length === 1 ? '' : 's'}`;
    renderTeacherDebug(rec);
    renderDayFilter(days);
    renderTimeline(day);
}

// ============================================================
// Development diagnostics (?debug) — per-teacher source trace.
//
// For the selected teacher, show every indexed class with its source cell
// location, course, extracted day/time, room and school/section context, so a
// developer can verify "teacher found → source location → class → day/time →
// room → school/section" end to end. Rendered only in DEBUG mode.
// ============================================================

function renderTeacherDebug(rec) {
    const el = $('#teacher-debug');
    if (!el || !DEBUG || !rec) return;
    el.querySelector('.teacher-debug-detail')?.remove();
    const rows = rec.classes
        .slice()
        .sort((a, b) => {
            const d = WEEKDAYS.indexOf(a.day) - WEEKDAYS.indexOf(b.day);
            return d || toMinutes(a.startTime) - toMinutes(b.startTime);
        })
        .map((c) => `
            <li>
                <b>${escapeHtml(c.subject)}</b> · ${escapeHtml(c.day)} ${minutesToClock(toMinutes(c.startTime))}–${minutesToClock(toMinutes(c.endTime))}
                · room ${escapeHtml(c.room || 'TBA')}
                · sec ${c.section ?? '-'}${c.lab ? ' · Lab' : ''}
                ${(c.contexts || []).length ? ` · <i>${c.contexts.map((x) => escapeHtml(x)).join(', ')}</i>` : ''}
                · <span class="debug-src">src ${c._line ?? '?'}:${c._col ?? '?'}</span>
            </li>`).join('');
    el.insertAdjacentHTML('beforeend', `
        <details open class="teacher-debug-detail">
            <summary>${rec.classes.length} class(es) indexed under this teacher</summary>
            <ul class="debug-excluded">${rows}</ul>
        </details>`);
}

function renderDayFilter(days) {
    const container = $('#days-filter');
    container.innerHTML = '';
    const rows = [document.createElement('div'), document.createElement('div')];
    rows.forEach((row) => { row.className = 'days-row'; });
    days.forEach((day, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'day-filter-btn' + (day === state.selectedDay ? ' active' : '');
        btn.dataset.day = day;
        btn.textContent = day;
        btn.setAttribute('role', 'radio');
        btn.setAttribute('aria-checked', day === state.selectedDay ? 'true' : 'false');
        btn.setAttribute('aria-label', day);
        btn.addEventListener('click', () => {
            state.selectedDay = day;
            renderDayFilter(days);
            renderTimeline(day);
        });
        rows[i < 3 ? 0 : 1].appendChild(btn);
    });
    container.replaceChildren(...rows);
}

// ============================================================
// Timeline
// ============================================================

function renderTimeline(day) {
    const timeline = $('#timeline');
    timeline.innerHTML = '';
    $('#timeline-title').textContent = day
        ? `${state.index.get(state.selectedKey).name} — ${day}`
        : state.index.get(state.selectedKey).name;

    const list = day ? dayClasses(state.selectedKey, day) : [];
    if (!list.length) {
        $('#timeline-stats').textContent = '';
        timeline.innerHTML = `
            <li class="tl-done empty">
                <strong>No classes</strong>
                <span>${day ? `No classes scheduled on ${day}.` : 'No classes found for this teacher.'}</span>
            </li>`;
        return;
    }

    $('#timeline-stats').textContent = `${list.length} class${list.length > 1 ? 'es' : ''}`;
    let prevEnd = null;
    for (const c of list) {
        const startMin = toMinutes(c.startTime);
        const endMin = toMinutes(c.endTime);
        if (prevEnd !== null && startMin - prevEnd >= BREAK_THRESHOLD_MIN) {
            timeline.insertAdjacentHTML('beforeend', `
                <li class="tl-break">
                    <span class="tl-break-line"></span>
                    <span class="tl-break-label">${ICONS.coffee}Break · ${minutesToLabel(startMin - prevEnd)}</span>
                    <span class="tl-break-line"></span>
                </li>`);
        }
        timeline.appendChild(buildItem(c, startMin, endMin));
        prevEnd = endMin;
    }
}

function buildItem(c, startMin, endMin) {
    const li = document.createElement('li');
    li.className = 'tl-item upcoming';

    const badges = [];
    if (c._hasSection) {
        badges.push(`<span class="badge">${escapeHtml(`Section ${c.section}`)}</span>`);
    }
    if (c.year) badges.push(`<span class="badge badge-year">Year ${c.year}</span>`);
    if (c.lab) badges.push('<span class="badge badge-lab">Lab</span>');
    if (c.course && c.course !== c.subject) {
        badges.push(`<span class="badge badge-course">${escapeHtml(c.course)}</span>`);
    }
    for (const ctx of c.contexts || []) {
        badges.push(`<span class="badge badge-context">${escapeHtml(ctx)}</span>`);
    }

    const coTaught = c.teachers && c.teachers.length > 1
        ? `<div class="tl-co-taught">Co-taught with ${c.teachers.slice(1).map((t) => escapeHtml(t)).join(', ')}</div>`
        : '';

    li.innerHTML = `
        <div class="tl-marker"></div>
        <div class="tl-card">
            <div class="tl-card-top">
                <div>
                    <div class="tl-subject">${escapeHtml(c.lab ? labSubjectLabel(c.subject) : c.subject)}</div>
                    <div class="tl-meta">
                        <span class="tl-faculty">${escapeHtml(c.teacher)}</span>
                        <span class="tl-room">${ICONS.pin}<span>${escapeHtml(c.room || 'Room TBA')}</span></span>
                    </div>
                </div>
            </div>
            ${coTaught}
            ${badges.length ? `<div class="teacher-badges">${badges.join('')}</div>` : ''}
            <div class="tl-time-row">
                <span>${minutesToClock(startMin)} – ${minutesToClock(endMin)}</span>
                <span class="tl-duration">${minutesToLabel(endMin - startMin)}</span>
            </div>
        </div>`;
    return li;
}

// ============================================================
// Loading / states
// ============================================================

function showLoading() {
    $('#loading-state')?.classList.add('visible');
}

function hideLoading() {
    $('#loading-state')?.classList.remove('visible');
}

function showToast(message) {
    const toast = $('.toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.classList.remove('show'); toast.textContent = ''; }, 3000);
}

function showEmpty(title, message, withRetry) {
    hideLoading();
    const card = $('#teacher-empty');
    if (!card) return;
    $('#state-title').textContent = title;
    $('#state-message').textContent = message;
    $('#teacher-retry').classList.toggle('hidden', !withRetry);
    card.classList.remove('hidden');
    $('#timeline-title').textContent = '';
    $('#timeline-stats').textContent = '';
}

function renderDebug(res) {
    const el = $('#teacher-debug');
    if (!el) return;
    if (!DEBUG) { el.classList.add('hidden'); return; }
    const s = res.stats || {};
    const statuses = res.statuses || {};
    const labLine = Object.entries(statuses.labs || {})
        .map(([k, v]) => `${k}=${v}`).join(', ');
    const excluded = res.excluded || [];
    el.innerHTML = `
        <div>normalized: <b>${s.total}</b> → meetings: <b>${s.meetings}</b> (duplicates dropped: <b>${s.duplicates}</b>) · indexed classes: <b>${s.classes}</b> · teachers: <b>${s.teachers}</b> · entries: <b>${s.entries}</b> · unassigned (no teacher): <b>${s.unassigned}</b></div>
        <div>sources: main=${statuses.main || '-'}${labLine ? ` · labs: ${escapeHtml(labLine)}` : ''} · cache=${res.source || '-'}</div>
        ${excluded.length ? `
            <details>
                <summary>${excluded.length} class(es) not indexed</summary>
                <ul class="debug-excluded">${excluded.map((e) => `<li>${escapeHtml([
                    e.day, e.startTime, e.subject, `Sec ${e.section ?? '-'}`, e.school ?? '', e.faculty || 'no teacher', e.reason,
                ].filter(Boolean).join(' · '))}</li>`).join('')}</ul>
            </details>` : ''}`;
    el.classList.remove('hidden');
}

// ============================================================
// Ambiguous identity confirmation (?debug).
//
// MEDIUM-confidence candidate pairs from the identity resolver ("Prof. Mariya"
// ↔ "Prof. Mariya Shah") are never auto-merged. In debug mode they are listed
// with [Yes, merge] / [No, keep separate] actions so an admin can resolve them
// once; the decision is stored per-browser and re-applied on every future parse
// (never asked again). The exported snippet is the permanent TEACHER_ALIASES
// config entry to paste into js/data/teacher-identity.js.
// ============================================================

function renderConfirmCandidates() {
    const el = $('#teacher-debug');
    if (!el || !DEBUG) return;
    el.querySelector('.teacher-confirm-detail')?.remove();
    const candidates = state.candidates || [];
    const items = candidates.map((c) => `
        <li data-confirm="${escapeHtml(c.idA)}|${escapeHtml(c.idB)}">
            <span class="confirm-names">“${escapeHtml(c.displayNameA)}” ↔ “${escapeHtml(c.displayNameB)}”</span>
            <span class="confirm-reason">${escapeHtml(c.reason)}</span>
            <button class="btn confirm-merge" type="button">Yes, merge</button>
            <button class="btn confirm-dismiss" type="button">No, keep separate</button>
        </li>`).join('');
    el.insertAdjacentHTML('beforeend', `
        <details class="teacher-confirm-detail"${candidates.length ? ' open' : ''}>
            <summary>${candidates.length} possible duplicate teacher${candidates.length === 1 ? '' : 's'} (need confirmation)</summary>
            ${candidates.length ? `<ul class="debug-excluded">${items}</ul>` : '<p>No ambiguous teacher identities detected.</p>'}
            <details class="confirm-export">
                <summary>Export confirmed aliases → TEACHER_ALIASES config</summary>
                <p>Paste the confirmed entries below into the TEACHER_ALIASES array in js/data/teacher-identity.js to make them permanent for every user:</p>
                <pre class="confirm-export-code">${exportAliasSnippet()}</pre>
            </details>
        </details>`);
    el.querySelectorAll('.teacher-confirm-detail .confirm-merge').forEach((btn) => {
        btn.addEventListener('click', () => {
            const [idA, idB] = btn.closest('[data-confirm]').dataset.confirm.split('|');
            const pair = candidates.find((c) => c.idA === idA && c.idB === idB);
            if (pair) confirmTeacherMerge(pair.displayNameA, pair.displayNameB);
            showToast('Merged — rebuilding teacher index');
            load({ silent: true });
        });
    });
    el.querySelectorAll('.teacher-confirm-detail .confirm-dismiss').forEach((btn) => {
        btn.addEventListener('click', () => {
            const [idA, idB] = btn.closest('[data-confirm]').dataset.confirm.split('|');
            const pair = candidates.find((c) => c.idA === idA && c.idB === idB);
            if (pair) dismissTeacherMerge(pair.displayNameA, pair.displayNameB);
            showToast('Kept separate — rebuilding teacher index');
            load({ silent: true });
        });
    });
}

function exportAliasSnippet() {
    const rec = loadTeacherConfirmationsRaw();
    const lines = (rec.merge || []).map((m) => {
        const { a, b } = m;
        // Fold both sides to a stable id; the more complete name wins as the
        // canonical display name.
        const fa = String(a).toLowerCase().replace(/\b(?:prof\.?\s*|dr\.?\s*|ms\.?\s*|mr\.?\s*|mrs\.?\s*|miss\s*)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
        const fb = String(b).toLowerCase().replace(/\b(?:prof\.?\s*|dr\.?\s*|ms\.?\s*|mr\.?\s*|mrs\.?\s*|miss\s*)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
        const id = (fa.length >= fb.length ? fa : fb).replace(/\s+/g, '-');
        const display = String(a).replace(/^Prof\.\s+/i, '');
        return `    { match: /^${escapeRegExp(fa)}$/i, id: '${id}', displayName: '${display}' },`;
    });
    return lines.length ? lines.join('\n') : '// no confirmed merges yet';
}

function loadTeacherConfirmationsRaw() {
    try {
        if (typeof localStorage === 'undefined' || !localStorage) return { merge: [] };
        const raw = localStorage.getItem('tt-teacher-aliases-v1');
        return raw ? JSON.parse(raw) : { merge: [] };
    } catch {
        return { merge: [] };
    }
}

const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function load({ silent = false } = {}) {
    if (!silent) showLoading();
    const res = await loadTeacherIndex();
    if (!res) {
        showEmpty("Couldn't load the teacher timetable", 'Check your connection and try again. Your last known teacher index is still cached offline.', true);
        return;
    }

    state.index = res.index;
    state.order = res.order;
    state.classes = res.all || [];
    state.candidates = res.candidates || [];
    renderDebug(res);
    renderConfirmCandidates();

    const updated = $('#teacher-updated');
    if (updated) {
        updated.textContent = res.savedAt
            ? `Updated ${new Date(res.savedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
            : '';
    }

    if (!state.order.length) {
        showEmpty('No teachers found', 'No teacher timetable could be built from the source sheets.', false);
        return;
    }

    hideLoading();
    $('#teacher-empty').classList.add('hidden');
    renderTeacherList();

    if (state.selectedKey && state.index.has(state.selectedKey)) {
        select(state.selectedKey);
    } else {
        select(state.order[0]);
    }
}

// ============================================================
// Pull to refresh
// ============================================================

let pullStart = 0, pulling = false;

function initPullToRefresh() {
    const indicator = $('.pull-indicator');
    if (!indicator) return;
    const threshold = 90;
    window.addEventListener('touchstart', (e) => {
        if (window.scrollY <= 0) { pullStart = e.touches[0].clientY; pulling = true; }
    }, { passive: true });
    window.addEventListener('touchmove', (e) => {
        if (!pulling || pullStart <= 0) return;
        const dy = e.touches[0].clientY - pullStart;
        if (dy > 0) { indicator.classList.add('visible'); if (dy >= threshold) indicator.classList.add('active'); }
    }, { passive: true });
    window.addEventListener('touchend', () => {
        if (indicator.classList.contains('active')) {
            load({ silent: true });
            showToast('Teacher timetable refreshed');
        }
        indicator.classList.remove('visible', 'active');
        pulling = false; pullStart = 0;
    }, { passive: true });
}

// ============================================================
// PWA update flow
// ============================================================

const UPDATE_RELOAD_KEY = 'tt-update-reload-teacher';

function isDevHost() {
    return ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(location.hostname);
}

function reloadOnce(version) {
    try {
        if (sessionStorage.getItem(UPDATE_RELOAD_KEY) === version) return false;
        sessionStorage.setItem(UPDATE_RELOAD_KEY, version);
    } catch { /* private mode — reload freely */ }
    if (document.hidden) {
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) window.location.reload();
        }, { once: true });
    } else {
        window.location.reload();
    }
    return true;
}

function controllerBuildId() {
    const scriptURL = navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL;
    if (!scriptURL) return null;
    try { return new URL(scriptURL).searchParams.get('v'); } catch { return null; }
}

async function initServiceWorkerUpdate() {
    if (!('serviceWorker' in navigator) || isDevHost() || !location.protocol.startsWith('https')) return;

    const hadController = !!navigator.serviceWorker.controller;

    try {
        const reg = await navigator.serviceWorker.register('./sw.js?v=' + encodeURIComponent(CONFIG.BUILD_ID));

        const askToActivate = (worker) => {
            if (worker && worker.state === 'installed') {
                worker.postMessage({ type: 'SKIP_WAITING' });
            }
        };

        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (!hadController) return;
            const version = controllerBuildId() || CONFIG.BUILD_ID;
            reloadOnce(version);
        });

        askToActivate(reg.waiting);

        const watchInstalling = () => {
            const worker = reg.installing;
            if (!worker) return;
            worker.addEventListener('statechange', () => {
                if (worker.state === 'installed') askToActivate(worker);
            });
        };
        watchInstalling();
        reg.addEventListener('updatefound', watchInstalling);

        setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) reg.update().catch(() => {});
        });
    } catch { /* registration failed — page works without SW */ }
}

async function checkForRemoteUpdate() {
    if (!navigator.onLine || isDevHost()) return;
    try {
        const res = await fetch('build.json?v=' + Date.now(), { cache: 'no-store' });
        if (!res.ok) return;
        const meta = await res.json();
        if (meta && meta.id && meta.id !== CONFIG.BUILD_ID) reloadOnce(meta.id);
    } catch { /* offline / transient — ignore */ }
}

// ============================================================
// Bootstrap
// ============================================================

function init() {
    const search = $('#teacher-search');
    if (search) {
        search.addEventListener('input', () => applySearch(search.value));
        search.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const first = [...$('#teacher-list').children].find((btn) => !btn.classList.contains('hidden'));
            if (first) select(first.dataset.key);
        });
    }
    $('#teacher-refresh')?.addEventListener('click', () => {
        load({ silent: true });
        showToast('Teacher timetable refreshed');
    });
    $('#teacher-retry')?.addEventListener('click', () => load());

    initPullToRefresh();
    initServiceWorkerUpdate();
    checkForRemoteUpdate();

    initAiAssistant({
        getClasses: () => state.classes,
        getContext: () => ({ school: null, year: null, section: null, labGroup: null }),
    });

    // Courses added to the sheets/config show up automatically: every load
    // rebuilds the index from the live sheet, and a silent periodic refresh
    // keeps an open page current (same cadence as the student app).
    setInterval(() => load({ silent: true }), CONFIG.REFRESH_INTERVAL || 5 * 60 * 1000);

    load();
}

document.addEventListener('DOMContentLoaded', init);

window.addEventListener('pageshow', (e) => {
    if (e.persisted) window.location.reload();
});
