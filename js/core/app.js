import { CONFIG } from './config.js?v=2026-08-10-002';
import { parseCSV, offeringKey } from '../data/parser.js?v=2026-08-10-002';
import { compareTimetables, classIdentity } from '../data/change-detector.js?v=2026-08-10-002';
import { getSection as getStoredSection, setSection as setStoredSection, hasSeenSectionModal, markSectionModalSeen, getSelectedDay, setSelectedDay } from '../services/storage.js?v=2026-08-10-002';
import * as nav from '../ui/navigation.js?v=2026-08-10-002';
import * as ui from '../ui/ui.js?v=2026-08-10-002';
import { checkArjunSinghTransition } from '../ui/easter-eggs.js?v=2026-08-10-002';
import * as labSection from '../ui/lab-section.js?v=2026-08-10-002';
import { loadMergedYear2Timetable } from '../services/lab-fetch.js?v=2026-08-10-002';
import { todayName, nowMinutes, nextSchoolDay, isSchoolDay } from './utils.js?v=2026-08-10-002';
import { init as initAnalytics, trackEvent } from '../services/analytics.js?v=2026-08-10-002';

/**
 * App bootstrap, fetch, and interactivity.
 */

let classes = [];
let sections = [];
let selectedSection = null;
let lastUpdated = null;
let selectedDay = null;
let clockTimer = null;
let lastFeatureKey = null;

// Live-clock state (see liveClockTick below).
//
//   prevCurrent   the class that was in progress on the previous tick, used
//                 by the Arjun frog to detect a genuine upcoming → in-progress
//                 transition rather than a load/refresh/navigation artifact.
//   hasRendered   true once render() has run at least once, so the frog is
//                 only ever considered after the baseline is seeded.
//   loadedFor     the year id whose data currently fills `classes`. The clock
//                 loop is paused while a different year is loading, so it can
//                 never re-render a stale timetable over a fresh one.
let prevCurrent = null;
let hasRendered = false;
let loadedFor = null;

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
            const resolved = resolveOffering(c);
            return resolved ? [resolved] : [];
        }
        // Mandatory labs (DAA/FDE) depend on the chosen LAB section, which is
        // independent of the classroom section — filter them separately.
        if (c.lab) return c.section === labSection.getLabSection() ? [c] : [];
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
    const offeringCfg = nav.getEmergingToolsConfig();
    if (c.elective && offeringCfg && c.elective === offeringCfg.id) {
        return resolveDropdownOffering(c, offeringCfg);
    }

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

// Resolve an offering of the Emerging Tools elective to the instructor group
// chosen in the sidebar dropdown. Completely independent of the SCDS section.
// Returns null when no offering is chosen yet or the event has no class from
// the chosen instructor — in both cases no class of this event is scheduled.
function resolveDropdownOffering(c, cfg) {
    const option = cfg.sections.find(s => s.id === nav.getEmergingToolsSection());
    if (!option) return null;

    const match = (faculty) => {
        const f = String(faculty || '').toLowerCase().replace(/\s+/g, ' ').trim();
        const tok = String(option.faculty || '').toLowerCase().replace(/\s+/g, ' ').trim();
        return !!tok && (f === tok || f.includes(tok) || tok.includes(f));
    };

    if (c.offerings && c.offerings.length > 1) {
        const idx = c.offerings.findIndex(o => match(o.faculty));
        if (idx < 0) return null;
        const chosen = c.offerings[idx];
        const resolved = {
            ...c,
            dropdownScoped: true,
            selectedOffering: idx,
            faculty: chosen.faculty,
            room: chosen.room,
            section: chosen.section,
        };
        applyRoomChange(resolved);
        return resolved;
    }

    if (!match(c.faculty)) return null;
    return { ...c, dropdownScoped: true };
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
        yearId: year?.level ?? null,
        sections: nav.availableSections(),
        sectionId: selectedSection,
        electives: nav.availableElectives(),
        selectedElectives: nav.getSelectedElectives(),
        emergingToolsSection: nav.getEmergingToolsSection(),
    });

    labSection.renderLabSections(year);

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
        loadedFor = nav.getYear()?.id ?? null;
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
        const parsed = parseCSV(text, nav.getParserType(), nav.getMandatoryCourses(), nav.getElectives(), nav.getRooms());
        if (!parsed.length) throw new Error('No classes parsed');

        // SCDS Year 2: merge the separate lab timetables (DAA/FDE/Emg Lab)
        // under the main sheet classes so labs appear on the same timeline.
        const year = nav.getYear();
        classes = year && year.id === 'scds-2'
            ? (await loadMergedYear2Timetable(parsed)).classes
            : parsed;

        loadedFor = year?.id ?? null;
        lastUpdated = new Date();
        writeCache(cacheKey, classes);
        // Smart change detection: compare the previous fetch against this one.
        // Classes are compared, not spreadsheet cells — a class that moved to
        // another cell/room/time/day keeps its identity and is reported as
        // moved/room-changed, never as removed + unrelated added.
        applyChanges(cached && cached.classes ? cached.classes : [], classes);
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

// Read the persisted identity → { room, originalRoom } map.
function readRoomMap() {
    try {
        const raw = localStorage.getItem(getRoomCacheKey());
        const map = raw ? JSON.parse(raw) : {};
        return map && typeof map === 'object' ? map : {};
    } catch { return {}; }
}

function writeRoomMap(map) {
    try { localStorage.setItem(getRoomCacheKey(), JSON.stringify(map)); } catch { /* full */ }
}

/**
 * Smart change detection over the freshly fetched timetable.
 *
 * Compares the previous successful fetch against the new one via the generic
 * change detector (compareTimetables). Classes keep their identity across
 * cell/room/time/day moves, so the room-change badge follows a class wherever
 * it goes and is never reset by a timetable sync.
 *
 * For each flat class whose room changed, the badge metadata is attached
 * directly. The persisted room map (identity → latest room + original room)
 * lets the app badge an elective offering AFTER the user resolves it.
 */
function applyChanges(prevClasses, newClasses) {
    const { changes, roomMap } = compareTimetables(prevClasses, newClasses);

    for (const c of newClasses) {
        if (c.offerings && c.offerings.length > 1) continue; // badge on resolution
        const rec = roomMap[classIdentity(c)];
        if (rec && rec.originalRoom && rec.originalRoom !== rec.room) {
            c.roomChanged = true;
            c.originalRoom = rec.originalRoom;
        }
    }

    // The room map is the persisted source of truth for resolved offerings.
    const map = readRoomMap();
    for (const [id, rec] of Object.entries(roomMap)) map[id] = rec;
    writeRoomMap(map);

    return changes;
}

// Recompute the room-change badge for an already-resolved class (used for the
// offering chosen after a multi-offering event is resolved).
function applyRoomChange(c) {
    const map = readRoomMap();
    const rec = map[classIdentity(c)];
    if (rec && rec.originalRoom && rec.originalRoom !== rec.room) {
        c.roomChanged = true;
        c.originalRoom = rec.originalRoom;
    }
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
    ui.renderGameSuggestion(ctx, now, day);

    lastFeatureKey = featureKey(ctx);

    // Seed/re-baseline the live clock's "previous current class". Every
    // structural re-render — first load, day/section/elective/offering change,
    // data refresh — seals the current state as "already seen", so the Arjun
    // frog only fires on an *observed* upcoming → in-progress transition while
    // the user watches the page, never because the app loaded, refreshed, or
    // re-rendered with his class already running.
    prevCurrent = ctx.current;
    hasRendered = true;

    ui.setLastUpdated(lastUpdated || new Date());
}

// ============================================================
// Real-time clock — device-clock-driven live state updates
// ============================================================
//
// Two independent systems keep the timetable fresh:
//
//   A. TIMETABLE DATA SYNC   — `load()` / `initAutoRefresh()` fetch the
//      Google Sheet on demand and render when the schedule changes.
//   B. REAL-TIME CLOCK       — this loop reads the device clock every second
//      and updates only the time-dependent UI (countdown, progress bar, class
//      state transitions, frog). It never fetches anything.
//
// A sheet fetch is never required for a class to move from
// "Starts in 1 min" to "In progress" — the device clock alone drives that.
// The loop only re-renders structurally when the highlighted class
// (current/next) actually changes; between those moments it touches only the
// live bits of the DOM. State boundaries are therefore second-accurate
// (2:00:00 → in progress, 2:55:00 → completed) even though the timetable only
// displays minutes.

function featureKey(ctx) {
    const f = ctx.current || ctx.next;
    return f
        ? `${f.subject}|${f.startTime}|${ctx.current ? 1 : 0}`
        : 'none';
}

/**
 * One-second device-clock tick. `now` is the local device/browser time.
 *
 * {@suppressFrog} is set when catching up right after the tab becomes visible
 * again, so a class that began while the tab was hidden never pops the frog.
 */
function liveClockTick(now, { suppressFrog = false } = {}) {
    // Only run once the timetable for the current selection is rendered.
    if (!hasRendered || loadedFor !== (nav.getYear()?.id ?? null)) return;

    const nowMin = now.getHours() * 60 + now.getMinutes();
    const day = selectedDay || contextDay();
    const sc = sectionClasses();
    const ctx = ui.computeHighlight(sc, nowMin, day);
    const key = featureKey(ctx);

    // The Arjun frog fires only on an observed upcoming → in-progress
    // transition. prevCurrent is seeded by render(), so (re)loading the app,
    // refreshing, or switching day/section during his class can never trigger it.
    if (!suppressFrog) {
        checkArjunSinghTransition({
            classes: sc,
            nowMin,
            day,
            current: ctx.current,
            next: ctx.next,
            prevCurrent,
        });
    }

    if (key !== lastFeatureKey) {
        // The spotlight moved (a class started or ended) — refresh the whole
        // timeline so statuses, countdown and highlight stay consistent.
        lastFeatureKey = key;
        render();
        return; // render() re-seeds prevCurrent for the new highlighted class
    }

    // No structural change — update only the live, time-dependent bits.
    if (day === todayName()) ui.updateLiveClock(now, ctx.current, ctx.next);
    // The game hint follows live state too: it appears the moment a class
    // ends, hides when the next class draws close, never needs a refresh.
    ui.renderGameSuggestion(ctx, nowMin, day);

    prevCurrent = ctx.current;
}

function onVisibilityChanged() {
    if (document.hidden) return;
    // Mobile browsers throttle background timers. Recompute immediately on
    // return using the device clock (suppressing the frog — the user may not
    // have seen a class begin) and resume normal second-by-second ticks.
    liveClockTick(new Date(), { suppressFrog: true });
}

function startLiveClock() {
    stopLiveClock();
    clockTimer = setInterval(() => liveClockTick(new Date()), 1000);
    document.addEventListener('visibilitychange', onVisibilityChanged);
}

function stopLiveClock() {
    if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
    document.removeEventListener('visibilitychange', onVisibilityChanged);
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
    window.addEventListener('emergingtoolschange', (e) => {
        nav.setEmergingToolsSection(e.detail.section);
        trackEvent('emerging_tools_section_changed', { section: e.detail.section });
        render();
    });
    window.addEventListener('labchange', (e) => {
        labSection.setLabSection(e.detail.section);
        trackEvent('lab_section_changed', { section: e.detail.section });
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
    ui.initInteractions?.();
    initPullToRefresh();
    initActions();
    initNavigationListeners();
    initAutoRefresh();

    load();
    startLiveClock();
}

document.addEventListener('DOMContentLoaded', init);
