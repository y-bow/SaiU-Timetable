import { CONFIG } from './config.js?v=2026-08-08-018';
import { parseCSV, offeringKey } from './parser.js?v=2026-08-08-018';
import { getSection as getStoredSection, setSection as setStoredSection, hasSeenSectionModal, markSectionModalSeen, getSelectedDay, setSelectedDay } from './storage.js?v=2026-08-08-018';
import * as nav from './navigation.js?v=2026-08-08-018';
import * as ui from './ui.js?v=2026-08-08-018';
import { todayName, nowMinutes, nextSchoolDay, isSchoolDay } from './utils.js?v=2026-08-08-018';
import { init as initAnalytics, trackEvent } from './analytics.js?v=2026-08-08-018';

/**
 * App bootstrap, fetch, and interactivity.
 */

let classes = [];
let sections = [];
let selectedSection = null;
let lastUpdated = null;
let selectedDay = null;
let countdownTimer = null;
let lastFeatureKey = null;

const $ = (sel) => document.querySelector(sel);

function contextDay() {
    const t = todayName();
    return isSchoolDay(t) ? t : nextSchoolDay(t);
}

function sectionClasses() {
    const yearConfig = nav.getYear();
    if (!yearConfig) return classes;

    const hasSections = yearConfig.sections && yearConfig.sections.length > 1;
    const selectedElectives = new Set(nav.getSelectedElectives());

    return classes.flatMap((c) => {
        // Electives are individual choices — show only the ones selected,
        // resolving the student's chosen offering into a single normal class.
        if (c.elective) {
            if (!selectedElectives.has(c.elective)) return [];
            return [resolveOffering(c)];
        }
        // Mandatory sectioned classes depend on the selected section.
        if (hasSections) return selectedSection != null && c.section === selectedSection ? [c] : [];
        // Single-section / mandatory-course years show everything else.
        return [c];
    });
}

// Resolve a (possibly multi-offering) elective event down to the one offering
// the student attends. Falls back to the first offering when nothing is
// stored or the stored key no longer matches. Resulting classes carry the
// chosen offering's faculty/room/section, so every downstream consumer
// (timeline, countdown, search, room-change) sees one normal class.
function resolveOffering(c) {
    if (!c.offerings || c.offerings.length <= 1) return c;
    const stored = nav.getSelectedOffering(c.elective);
    const idx = stored ? c.offerings.findIndex(o => offeringKey(o) === stored) : -1;
    const chosen = c.offerings[idx >= 0 ? idx : 0];
    const resolved = {
        ...c,
        selectedOffering: idx >= 0 ? idx : 0,
        faculty: chosen.faculty,
        room: chosen.room,
        section: chosen.section,
    };
    applyRoomChange(resolved);
    return resolved;
}

// ============================================================
// Navigation state rendering
// ============================================================

function renderNavigation() {
    const school = nav.getSchool();
    const program = nav.getProgram();
    const year = nav.getYear();

    ui.renderSidebar({
        schools: nav.availableSchools(),
        schoolId: school?.id || null,
        programs: nav.availablePrograms(),
        programId: program?.id || null,
        years: nav.availableYears(),
        yearId: year?.id || null,
        sections: nav.availableSections(),
        sectionId: selectedSection,
        electives: nav.availableElectives(),
        selectedElectives: nav.getSelectedElectives(),
    });

    ui.renderDayFilter(selectedDay || contextDay());
}

function syncSections() {
    const yearConfig = nav.getYear();
    if (!yearConfig) return;

    const yearSections = yearConfig.sections || [];
    if (yearSections.length) {
        sections = yearSections;
        if (selectedSection == null) {
            if (!hasSeenSectionModal()) {
                markSectionModalSeen();
                ui.showSectionModal(sections, (s) => {
                    selectedSection = s;
                    nav.navigateToSection(s);
                    render();
                });
            }
        } else if (!sections.includes(selectedSection)) {
            selectedSection = sections[0];
            nav.navigateToSection(selectedSection);
        }
    } else {
        sections = [];
        selectedSection = null;
    }
}

// ============================================================
// Data loading
// ============================================================

function getCacheKey() {
    const year = nav.getYear();
    if (!year) return CONFIG.CACHE_KEY;
    return `tt-cache-${year.id}`;
}

function getRoomCacheKey() {
    const year = nav.getYear();
    if (!year) return CONFIG.ROOMS_KEY;
    return `tt-rooms-${year.id}`;
}

async function load({ silent = false, background = false } = {}) {
    const sheetUrl = nav.getSheetUrl();
    if (!sheetUrl) { ui.renderError(); return; }

    const cacheKey = getCacheKey();
    const cached = readCache(cacheKey);
    if (cached && cached.classes) {
        classes = cached.classes;
        if (cached.savedAt) lastUpdated = new Date(cached.savedAt);
        syncSections();
        render();
    } else {
        ui.showLoading();
    }

    if (background) return;

    ui.setRefreshSpinning(!silent);
    try {
        const res = await fetch(sheetUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        const parsed = parseCSV(text, nav.getParserType(), nav.getMandatoryCourses(), nav.getElectives());
        if (!parsed.length) throw new Error('No classes parsed');
        classes = parsed;
        lastUpdated = new Date();
        writeCache(cacheKey, classes);
        updateRoomMapWithKey(classes);
        syncSections();
        render();
        trackEvent('timetable_refreshed', { source: background ? 'background' : silent ? 'manual' : 'initial' });
        if (!silent) ui.showToast('Timetable refreshed');
    } catch {
        if (!cached) ui.renderError();
        if (!silent) ui.showToast('Offline — showing cached schedule');
    } finally {
        ui.setRefreshSpinning(false);
    }
}

function readCache(key) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; }
    catch { return null; }
}

function writeCache(key, data) {
    try { localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), classes: data })); }
    catch { /* full */ }
}

const PLACEHOLDER_ROOM = /^(tba|tbd|to be announced|to be decided|room tba|n\/?a)$/i;

// Compute the stable room-change key + normalized room for one class/offering
// and detect a change against the persisted map. The key must stay identical
// to what updateRoomMapWithKey stores.
function roomChangeFor(c, map) {
    const ck = `${c.subject}|${c.faculty}|${c.section ?? ''}|${c.day ?? ''}|${c.startTime ?? ''}`;
    const rawRoom = String(c.room ?? '').replace(/\s+/g, ' ').trim();
    const room = rawRoom && !PLACEHOLDER_ROOM.test(rawRoom) ? rawRoom.toLowerCase() : '';
    const prevRaw = String(map[ck] ?? '').trim();
    const prev = prevRaw && !PLACEHOLDER_ROOM.test(prevRaw) ? prevRaw.toLowerCase() : '';
    return { key: ck, room: rawRoom, changed: !!(room && prev && prev !== room), original: prevRaw };
}

function updateRoomMapWithKey(classes) {
    const key = getRoomCacheKey();
    let map = {};
    try { const raw = localStorage.getItem(key); map = raw ? JSON.parse(raw) : {}; } catch { map = {}; }
    for (const c of classes) {
        // Multi-offering events register a map entry per offering, keyed by
        // each offering's faculty/section, so the chosen offering's room
        // change is detected after resolution.
        const entries = (c.offerings && c.offerings.length > 1)
            ? c.offerings.map(o => ({ subject: c.subject, faculty: o.faculty, section: o.section, day: c.day, startTime: c.startTime, room: o.room }))
            : [c];
        for (const e of entries) {
            const r = roomChangeFor(e, map);
            if (e === c && r.changed) { c.roomChanged = true; c.originalRoom = r.original; }
            if (r.room) map[r.key] = r.room;
        }
    }
    try { localStorage.setItem(key, JSON.stringify(map)); } catch { /* full */ }
}

// Recompute the room-change badge for an already-resolved class (used for the
// offering chosen after a multi-offering event is resolved).
function applyRoomChange(c) {
    let map = {};
    try { const raw = localStorage.getItem(getRoomCacheKey()); map = raw ? JSON.parse(raw) : {}; } catch { map = {}; }
    const r = roomChangeFor(c, map);
    if (r.changed) { c.roomChanged = true; c.originalRoom = r.original; }
}

// ============================================================
// Render
// ============================================================

function render() {
    ui.hideLoading();
    renderNavigation();
    const day = selectedDay || contextDay();
    ui.renderSuccess();
    const now = nowMinutes();
    const sc = sectionClasses();
    const ctx = ui.computeHighlight(sc, now, day);
    ui.renderTimeline(now, day, ctx, '');

    lastFeatureKey = (ctx.current || ctx.next)
        ? `${(ctx.current || ctx.next).subject}|${(ctx.current || ctx.next).startTime}|${ctx.current ? 1 : 0}`
        : 'none';

    ui.setLastUpdated(lastUpdated || new Date());
}

// ============================================================
// Countdown
// ============================================================

function startCountdown() {
    stopCountdown();
    countdownTimer = setInterval(() => {
        const now = nowMinutes();
        const day = selectedDay || contextDay();
        const sc = sectionClasses();
        const ctx = ui.computeHighlight(sc, now, day);
        const key = ctx.current || ctx.next
            ? `${(ctx.current || ctx.next).subject}|${(ctx.current || ctx.next).startTime}|${ctx.current ? 1 : 0}`
            : 'none';
        if (key !== lastFeatureKey) { lastFeatureKey = key; render(); return; }
        if (day === todayName()) ui.updateLiveClock(now, ctx.current, ctx.next);
    }, 60 * 1000);
}

function stopCountdown() {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
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
        if (ui.isDrawerOpen()) return;
        if (window.scrollY <= 0) { pullStart = e.touches[0].clientY; pulling = true; }
    }, { passive: true });
    window.addEventListener('touchmove', (e) => {
        if (!pulling || pullStart <= 0) return;
        const dy = e.touches[0].clientY - pullStart;
        if (dy > 0) { indicator.classList.add('visible'); if (dy >= threshold) indicator.classList.add('active'); }
    }, { passive: true });
    window.addEventListener('touchend', () => {
        if (indicator.classList.contains('active')) load({ silent: true });
        indicator.classList.remove('visible', 'active');
        pulling = false; pullStart = 0;
    }, { passive: true });
}

// ============================================================
// Actions
// ============================================================

function initActions() {
    const refresh = () => load({ silent: true });
    $('#refresh-btn-mobile')?.addEventListener('click', refresh);
    $('.retry-btn')?.addEventListener('click', () => load());

    const handleInstall = async () => {
        if (deferredPrompt) {
            console.log('[PWA] Triggering native install prompt');
            deferredPrompt.prompt();
            const { outcome } = await deferredPrompt.userChoice;
            console.log('[PWA] User choice:', outcome);
            if (outcome === 'accepted') {
                hideInstallButton();
            }
            deferredPrompt = null;
        } else if (isStandalone()) {
            console.log('[PWA] Already installed');
            ui.showToast('Already installed');
        } else {
            const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
            const isAndroid = /Android/i.test(navigator.userAgent);
            if (isIOS) {
                console.log('[PWA] iOS — no programmatic install, showing share sheet instructions');
                ui.showToast('Tap Share \u2192 Add to Home Screen');
            } else if (isAndroid) {
                console.log('[PWA] Android but no deferredPrompt — showing menu instructions');
                ui.showToast('Tap browser menu \u2192 Install app');
            } else {
                console.log('[PWA] Desktop but no deferredPrompt — showing address bar instructions');
                ui.showToast('Click the install icon in your address bar');
            }
        }
    };
    $('#install-btn')?.addEventListener('click', handleInstall);
    $('#install-btn-mobile')?.addEventListener('click', handleInstall);
}

// ============================================================
// Hamburger / drawer
// ============================================================

function initHamburger() {
    $('#hamburger-btn')?.addEventListener('click', () => {
        if (ui.isDrawerOpen()) ui.closeDrawer(); else ui.openDrawer();
    });
    $('#drawer-overlay')?.addEventListener('click', () => ui.closeDrawer());
    $('#sidebar-close-btn')?.addEventListener('click', () => ui.closeDrawer());
    $('.section-modal-backdrop')?.addEventListener('click', () => ui.hideSectionModal());
}

// ============================================================
// Navigation event handlers
// ============================================================

function initNavigationListeners() {
    window.addEventListener('schoolchange', (e) => {
        nav.navigateToSchool(e.detail.schoolId);
        selectedSection = nav.getState().section;
        trackEvent('school_changed', { school: e.detail.schoolId });
        load(); ui.closeDrawer();
    });
    window.addEventListener('programchange', (e) => {
        nav.navigateToProgram(e.detail.programId);
        selectedSection = nav.getState().section;
        trackEvent('program_changed', { program: e.detail.programId });
        load(); ui.closeDrawer();
    });
    window.addEventListener('yearchange', (e) => {
        nav.navigateToYear(e.detail.yearId);
        selectedSection = nav.getState().section;
        trackEvent('year_changed', { year: e.detail.yearId });
        load(); ui.closeDrawer();
    });
    window.addEventListener('sectionchange', (e) => {
        const s = e.detail.section;
        if (s === selectedSection) return;
        selectedSection = s;
        nav.navigateToSection(s);
        trackEvent('section_changed', { section: s });
        render(); ui.closeDrawer();
    });
    window.addEventListener('electivetoggle', (e) => {
        const ids = new Set(nav.getSelectedElectives());
        if (e.detail.checked) ids.add(e.detail.electiveId);
        else ids.delete(e.detail.electiveId);
        nav.setSelectedElectives([...ids]);
        trackEvent('elective_toggled', { elective: e.detail.electiveId, checked: e.detail.checked });
        render();
    });
    window.addEventListener('offeringchange', (e) => {
        nav.setSelectedOffering(e.detail.electiveId, e.detail.offeringKey);
        trackEvent('offering_changed', { elective: e.detail.electiveId });
        render();
    });
    window.addEventListener('daychange', (e) => {
        selectedDay = e.detail.day;
        setSelectedDay(selectedDay);
        trackEvent('weekday_changed', { weekday: e.detail.day });
        render();
    });
    window.addEventListener('navchange', () => renderNavigation());
}

function initAutoRefresh() {
    setInterval(() => load({ background: true }), CONFIG.REFRESH_INTERVAL);
}

// ============================================================
// PWA
// ============================================================

let deferredPrompt = null;

function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches ||
        window.matchMedia('(display-mode: fullscreen)').matches ||
        window.matchMedia('(display-mode: minimal-ui)').matches ||
        window.matchMedia('(display-mode: window-controls-overlay)').matches ||
        navigator.standalone === true;
}

function showInstallButton() {
    $('#install-btn')?.classList.remove('hidden');
    $('#install-btn-mobile')?.classList.remove('hidden');
}

function hideInstallButton() {
    $('#install-btn')?.classList.add('hidden');
    $('#install-btn-mobile')?.classList.add('hidden');
}

// ============================================================
// PWA update flow
// ============================================================

const UPDATE_RELOAD_KEY = 'tt-update-reload';

function isDevHost() {
    return ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(location.hostname);
}

/**
 * Reload the page at most once per target version. The sessionStorage key
 * holds the version we already reloaded to, so reload loops are impossible.
 */
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

/**
 * Register the Service Worker and drive the update lifecycle:
 *
 *   - Every build registers a versioned script URL (sw.js?v=BUILD_ID) so
 *     browsers always check for an update on startup.
 *   - When a new worker installs or is waiting, it is asked to
 *     skipWaiting() immediately (no manual reload, no closing the app).
 *   - When the new worker takes control (controllerchange) the page
 *     reloads exactly once, then runs a fully consistent version.
 *   - The deployed BUILD_ID (build.json) is compared against the running
 *     BUILD_ID as a safety net for browsers not using the SW; a newer
 *     version triggers the same single reload.
 */
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

        // A new worker takes control → reload once to run the new version.
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (!hadController) return; // first install — no reload needed
            const version = controllerBuildId() || CONFIG.BUILD_ID;
            reloadOnce(version);
        });

        // Worker already waiting from a previous session → activate now.
        askToActivate(reg.waiting);

        // New worker installing → activate as soon as it finishes installing.
        const watchInstalling = () => {
            const worker = reg.installing;
            if (!worker) return;
            worker.addEventListener('statechange', () => {
                if (worker.state === 'installed') askToActivate(worker);
            });
        };
        watchInstalling();
        reg.addEventListener('updatefound', watchInstalling);

        // Re-check for updates while the app stays open, so a deployment
        // is picked up even in a long-running session.
        setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) reg.update().catch(() => {});
        });

        console.log('[PWA] Service Worker registered, scope:', reg.scope);
    } catch (err) {
        console.warn('[PWA] Service Worker registration/update failed:', err);
    }
}

/**
 * Compare the deployed BUILD_ID against the running one. A difference
 * means the served HTML predates the deployment, so reload once.
 * Network-first HTML makes this rare, but it is a cheap guarantee.
 */
async function checkForRemoteUpdate() {
    if (!navigator.onLine || isDevHost()) return;
    try {
        const res = await fetch('build.json?v=' + Date.now(), { cache: 'no-store' });
        if (!res.ok) return;
        const meta = await res.json();
        if (meta && meta.id && meta.id !== CONFIG.BUILD_ID) reloadOnce(meta.id);
    } catch { /* offline / transient — ignore */ }
}

function initPWA() {
    initServiceWorkerUpdate();
    checkForRemoteUpdate();

    // Already installed — hide button
    if (isStandalone()) {
        console.log('[PWA] Running in standalone mode — already installed');
        hideInstallButton();
        return;
    }

    // Listen for the browser's install prompt
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;
        console.log('[PWA] beforeinstallprompt captured — install available');
        showInstallButton();
    });

    // App was just installed
    window.addEventListener('appinstalled', () => {
        console.log('[PWA] App installed successfully');
        deferredPrompt = null;
        hideInstallButton();
        trackEvent('pwa_installed');
    });

    // Debug: log if beforeinstallprompt never fires after 5s
    setTimeout(() => {
        if (!deferredPrompt && !isStandalone()) {
            console.warn('[PWA] beforeinstallprompt did not fire within 5s');
            console.warn('[PWA] Possible reasons:');
            console.warn('  - Browser does not support programmatic install');
            console.warn('  - App does not meet installability criteria (HTTPS, manifest, SW)');
            console.warn('  - User already dismissed the install infobar');
            console.warn('  - App is already installed');
        }
    }, 5000);
}

// ============================================================
// Legacy section migration
// ============================================================

function migrateLegacySection() {
    const legacySection = getStoredSection();
    if (legacySection != null) {
        setStoredSection(null);
        const year = nav.getYear();
        if (year && year.sections && year.sections.includes(legacySection)) {
            selectedSection = legacySection;
            nav.navigateToSection(legacySection);
        }
    }
}

// ============================================================
// Bootstrap
// ============================================================

function init() {
    initAnalytics();
    initPWA();
    nav.initNavigation();
    migrateLegacySection();
    selectedSection = nav.getState().section;
    selectedDay = getSelectedDay();

    initHamburger();
    initPullToRefresh();
    initActions();
    initNavigationListeners();
    initAutoRefresh();

    load();
    startCountdown();
}

document.addEventListener('DOMContentLoaded', init);
