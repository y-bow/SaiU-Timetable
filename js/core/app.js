import { CONFIG } from './config.js?v=2026-08-30-008';
import { parseCSV, parseRoomOccupancy, offeringKey } from '../data/parser.js?v=2026-08-30-008';
import { compareTimetables, classIdentity, setChangeDetectorDebug } from '../data/change-detector.js?v=2026-08-30-008';
import { getSection as getStoredSection, setSection as setStoredSection, hasSeenSectionModal, markSectionModalSeen } from '../services/storage.js?v=2026-08-30-008';
import * as nav from '../ui/navigation.js?v=2026-08-30-008';
import * as ui from '../ui/ui.js?v=2026-08-30-008';
import { checkArjunSinghTransition, resetArjunSinghTransition } from '../ui/easter-eggs.js?v=2026-08-30-008';
import * as labSection from '../ui/lab-section.js?v=2026-08-30-008';
import { loadMergedYear1Timetable, loadMergedYear2Timetable } from '../services/lab-fetch.js?v=2026-08-30-008';
import { matchesEmergingToolsSection } from '../data/lab-parser.js?v=2026-08-30-008';
import { todayName, nowMinutes, nextSchoolDay, isSchoolDay } from './utils.js?v=2026-08-30-008';
import { init as initAnalytics, trackEvent } from '../services/analytics.js?v=2026-08-30-008';
import { dispatchTimetableChanges, setN8nDebug } from '../services/n8n.js?v=2026-08-30-008';
// Localhost-only dev console harness for timetable change notifications
// (window.testRoomChangeNotification / testTimeChangeNotification /
// testInvalidRoomChange). This side-effect import executes the module, which
// attaches the functions itself; the module self-gates on localhost, so the
// production build is never affected.
import '../services/timetable-test-harness.js?v=2026-08-30-008';
import { initAiAssistant } from '../ui/ai-assistant.js?v=2026-08-30-008';
import { initFreeRooms } from '../ui/free-rooms.js?v=2026-08-30-008';

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
let roomOccupancy = [];

// Live-clock state (see liveClockTick below).
//
//   hasRendered   true once render() has run at least once, so the live clock
//                 only starts after the timetable is on screen.
//   loadedFor     the year id whose data currently fills `classes`. The clock
//                 loop is paused while a different year is loading, so it can
//                 never re-render a stale timetable over a fresh one.
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
    const sectionCourses = yearConfig.sectionCourses || null;

    return classes.flatMap((c) => {
        // Electives are individual choices — show only the ones selected,
        // resolving the student's chosen offering into a single normal class.
        if (c.elective) {
            if (!selectedElectives.has(c.elective)) return [];
            const resolved = resolveOffering(c);
            return resolved ? [resolved] : [];
        }
        // Mandatory labs (DAA/FDE/CS121/CS128) depend on the resolved LAB
        // section. Year 2 has a lab-group selector ("Same section as above" or
        // "Section 8 — Combined Lab"); Year 1 has no section structure, so
        // labs pass through unconditionally.
        if (c.lab) {
            if (!hasSections) return [c];
            return c.section === labSection.getResolvedLabSection(selectedSection) ? [c] : [];
        }
        // Mandatory sectioned classes depend on the selected section.
        if (hasSections) {
            if (selectedSection == null) return [];
            // Section courses: filter by course list (e.g. SOB BBA/B.Com).
            if (sectionCourses) {
                const courses = sectionCourses[selectedSection];
                if (!courses) return [];
                const subjLower = (c.subject || '').trim().toLowerCase();
                const match = courses.some(t => {
                    const tLower = t.trim().toLowerCase();
                    return subjLower === tLower || subjLower.startsWith(tLower) || tLower.startsWith(subjLower);
                });
                return match ? [c] : [];
            }
            // Numeric sections: filter by section number (e.g. SCDS).
            return c.section === selectedSection ? [c] : [];
        }
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

// Resolve an offering of the Emerging Tools elective to the offering section
// chosen in the sidebar dropdown. Completely independent of the SCDS section.
//
// Two record shapes flow through here that MUST stay independent:
//
//   - MAIN-COURSE offering events (multi-offering or flat) from the main sheet.
//     Matched primarily by the explicit section on the sheet cell, falling back
//     to the configured offering faculty when the cell has no section marker.
//   - EMERGING TOOLS LAB flat classes from the lab tab. The lab section IS the
//     identity of the lab offering: the class is shown iff its section equals
//     the chosen section (`lab.section === selectedSection`). The lab teacher
//     is never used to select the offering — it is read off the matched lab
//     record and can change independently of the section.
//
// Returns null when no section is chosen yet or the event has no class from
// the chosen offering — in both cases no class of this event is scheduled.
function resolveDropdownOffering(c, cfg) {
    const option = cfg.sections.find((s) => s.id === nav.getEmergingToolsSection());
    if (!option) return null;
    // The numeric section the chosen offering represents ("Section 3" → 3).
    const section = option.section != null ? Number(option.section) : null;

    // Emerging Tools Lab: identity by section only.
    if (c.lab) {
        if (section == null || !matchesEmergingToolsSection(c, section)) return null;
        return { ...c, dropdownScoped: true };
    }

    // Main Emerging Tools course offering. Faculty equivalence is a strict
    // deterministic fallback only — it never identifies a lab.
    const matchFaculty = (faculty) => {
        const f = String(faculty || '').toLowerCase().replace(/\s+/g, ' ').trim();
        const tok = String(option.faculty || '').toLowerCase().replace(/\s+/g, ' ').trim();
        return !!tok && (f === tok || f.includes(tok) || tok.includes(f));
    };

    if (c.offerings && c.offerings.length > 1) {
        let idx = section != null ? c.offerings.findIndex((o) => Number(o.section) === section) : -1;
        if (idx < 0) idx = c.offerings.findIndex((o) => matchFaculty(o.faculty));
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

    const sectionMatches = section != null && c.section != null && Number(c.section) === section;
    if (!sectionMatches && !matchFaculty(c.faculty)) return null;
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

    labSection.renderLabGroups(year);

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

// The current navigation context, as n8n events need it. Records parsed from
// the sheet usually carry day/subject/faculty/room/time but NOT school/year —
// those come from the app's live navigation state, so event context is built
// here rather than at parse time.
function n8nContext() {
    const year = nav.getYear();
    const school = nav.getSchool();
    return {
        year: year?.id ?? null,
        yearLevel: year?.level ?? null,
        school: school?.id ?? null,
        section: selectedSection,
        labGroup: labSection.getLabGroup(),
    };
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
    const year = nav.getYear();
    const sheetUrl = nav.getSheetUrl();

    if (!background) {
        console.log('[Timetable] load()', {
            school: nav.getSchool()?.id,
            year: year?.id,
            section: selectedSection,
            online: navigator.onLine,
            url: sheetUrl,
            background,
            silent,
        });
    }

    if (!sheetUrl) {
        console.warn('[Timetable] No sheet URL — navigation state not resolved');
        classes = [];
        roomOccupancy = [];
        loadedFor = null;
        ui.renderError();
        return;
    }

    const cacheKey = getCacheKey();
    const cached = readCache(cacheKey);

    if (!background) {
        console.log('[Timetable] Cache:', cached
            ? `hit (${cached.classes.length} classes, saved ${new Date(cached.savedAt).toLocaleString()})`
            : 'miss');
    }

    if (cached && cached.classes) {
        classes = cached.classes;
        roomOccupancy = cached.roomOccupancy || [];
        loadedFor = year?.id ?? null;
        if (cached.savedAt) lastUpdated = new Date(cached.savedAt);
        syncSections();
        render();
    } else {
        ui.showLoading();
    }

    if (background) return;

    ui.setRefreshSpinning(!silent);
    try {
        if (!background) console.log('[Timetable] Fetching:', sheetUrl);

        // Retry transient failures (5xx, 429, network errors) up to 2 times.
        // Mobile networks and Google Sheets rate-limiting make single-shot
        // fetches unreliable; a short retry loop covers most transient errors
        // without adding noticeable latency for the common fast path.
        let res = null;
        const MAX_FETCH_RETRIES = 2;
        const RETRY_BASE_MS = 500;
        for (let attempt = 0; attempt <= MAX_FETCH_RETRIES; attempt++) {
            try {
                res = await fetch(sheetUrl);
                if (!background) console.log('[Timetable] Response:', res.status, res.statusText, `attempt ${attempt + 1}`);
                if (res.ok || (res.status < 500 && res.status !== 429)) break;
            } catch (fetchErr) {
                if (attempt === MAX_FETCH_RETRIES) throw fetchErr;
                if (!background) console.warn(`[Timetable] Fetch attempt ${attempt + 1} failed, retrying…`);
            }
            if (attempt < MAX_FETCH_RETRIES) {
                await new Promise(r => setTimeout(r, RETRY_BASE_MS * Math.pow(2, attempt)));
            }
        }

        if (!res || !res.ok) throw new Error(`HTTP ${res?.status ?? 'no response'}`);
        const text = await res.text();
        const parsed = parseCSV(text, nav.getParserType(), nav.getMandatoryCourses(), nav.getElectives(), nav.getRooms());
        if (!parsed.length) {
            console.error('[Timetable] Parse returned 0 classes');
            throw new Error('No classes parsed');
        }

        if (!background) console.log('[Timetable] Parsed:', parsed.length, 'classes');

        // Room occupancy: scans the ENTIRE CSV without school/year
        // filtering, so Free Rooms knows about every occupied room.
        const occ = parseRoomOccupancy(text);

        // SCDS Year 1 + Year 2: merge separate lab timetables under the main
        // sheet classes so labs appear on the same timeline.
        if (year && year.id === 'scds-2') {
            classes = (await loadMergedYear2Timetable(parsed)).classes;
        } else if (year && year.id === 'scds-1') {
            classes = (await loadMergedYear1Timetable(parsed)).classes;
        } else {
            classes = parsed;
        }
        roomOccupancy = occ;

        loadedFor = year?.id ?? null;
        lastUpdated = new Date();
        writeCache(cacheKey, { classes, roomOccupancy });
        // Smart change detection: compare the previous fetch against this one.
        // Classes are compared, not spreadsheet cells — a class that moved to
        // another cell/room/time/day keeps its identity and is reported as
        // moved/room-changed, never as removed + unrelated added.
        const changes = applyChanges(cached && cached.classes ? cached.classes : [], classes);
        // Optional n8n notifications. Fire-and-forget and fully isolated: an
        // empty webhook URL (the default) disables it entirely; the sender
        // never throws, so a broken n8n can never break this load.
        dispatchTimetableChanges(changes, n8nContext());
        syncSections();
        render();
        trackEvent('timetable_refreshed', { source: background ? 'background' : silent ? 'manual' : 'initial' });
        if (!silent) ui.showToast('Timetable refreshed');
    } catch (err) {
        const isOffline = !navigator.onLine;

        console.error('[Timetable] Load failed:', err?.message || err);
        console.error('[Timetable] Online:', isOffline ? 'offline' : 'online');
        console.error('[Timetable] Cached data:', cached ? `${cached.classes.length} classes available` : 'none');

        if (cached && cached.classes) {
            // Cached data is already displayed (set before the fetch started).
            // Show a non-blocking toast — the timetable remains visible.
            if (!silent) {
                ui.showToast(isOffline
                    ? 'Offline — showing cached schedule'
                    : "Couldn't refresh timetable. Showing cached schedule.");
            }
        } else {
            // No cached data — show error card with an appropriate message.
            if (isOffline) {
                ui.renderError({
                    title: "You're offline",
                    message: 'Check your connection and try again. Your timetable will be cached once loaded.',
                });
            } else {
                ui.renderError({
                    message: "Couldn't load this timetable. Please try again.",
                });
            }
        }
    } finally {
        ui.setRefreshSpinning(false);
    }
}

function readCache(key) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; }
    catch { return null; }
}

function writeCache(key, data) {
    try {
        const payload = {
            savedAt: Date.now(),
            classes: Array.isArray(data) ? data : data.classes,
            roomOccupancy: Array.isArray(data) ? [] : (data.roomOccupancy || []),
        };
        localStorage.setItem(key, JSON.stringify(payload));
    }
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
    // Guard: if the timetable for the currently-selected year hasn't arrived
    // yet, keep the loading skeleton visible instead of briefly flashing the
    // error card.  This fires when render() is called (e.g. from navigation
    // events) while load() is still in-flight for the new year.
    if (loadedFor !== (nav.getYear()?.id ?? null)) {
        return;
    }
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

    // Re-baseline the Arjun frog on every structural re-render — first load,
    // data refresh, day/section/elective/offering change. Clearing the frog's
    // per-occurrence state means it only fires on an *observed*
    // starts-in-1-minute → in-progress transition while the user watches the
    // page, never because the app loaded, refreshed, or re-rendered with his
    // class already running or about to start.
    resetArjunSinghTransition();
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

    // The Arjun frog fires only on an observed starts-in-1-minute →
    // in-progress transition. render() clears the frog's tracked state on
    // every structural change, and a visibility catch-up (suppressFrog) does
    // the same, so (re)loading the app, refreshing, or switching day/section
    // during his class can never trigger it.
    if (suppressFrog) {
        resetArjunSinghTransition();
    } else {
        checkArjunSinghTransition({ classes: sc, nowMin, day });
    }

    if (key !== lastFeatureKey) {
        // The spotlight moved (a class started or ended) — refresh the whole
        // timeline so statuses, countdown and highlight stay consistent.
        lastFeatureKey = key;
        render();
        return; // render() re-baselines the frog state for the new highlight
    }

    // No structural change — update only the live, time-dependent bits.
    if (day === todayName()) ui.updateLiveClock(now, ctx.current, ctx.next);
    // The game hint follows live state too: it appears the moment a class
    // ends, hides when the next class draws close, never needs a refresh.
    ui.renderGameSuggestion(ctx, nowMin, day);
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

    $('#feedback-btn')?.addEventListener('click', () => {
        trackEvent('feedback_click');
    });

    const handleInstall = async () => {
        if (deferredPrompt) {
            deferredPrompt.prompt();
            const { outcome } = await deferredPrompt.userChoice;
            if (outcome === 'accepted') {
                hideInstallButton();
            }
            deferredPrompt = null;
        } else if (isStandalone()) {
            ui.showToast('Already installed');
        } else {
            const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
            const isAndroid = /Android/i.test(navigator.userAgent);
            if (isIOS) {
                ui.showToast('Tap Share \u2192 Add to Home Screen');
            } else if (isAndroid) {
                ui.showToast('Tap browser menu \u2192 Install app');
            } else {
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
    $('#drawer-overlay')?.addEventListener('click', (e) => {
        if (e.target === $('#drawer-overlay')) ui.closeDrawer();
    });
    $('#sidebar-close-btn')?.addEventListener('click', () => ui.closeDrawer());
    $('.section-modal-backdrop')?.addEventListener('click', (e) => {
        if (e.target === $('.section-modal-backdrop')) ui.hideSectionModal();
    });
}

// ============================================================
// Navigation event handlers
// ============================================================

function initNavigationListeners() {
    window.addEventListener('schoolchange', (e) => {
        nav.navigateToSchool(e.detail.schoolId);
        selectedSection = nav.getState().section;
        trackEvent('school_changed', { school: e.detail.schoolId });
        load();
    });
    window.addEventListener('programchange', (e) => {
        nav.navigateToProgram(e.detail.programId);
        selectedSection = nav.getState().section;
        trackEvent('program_changed', { program: e.detail.programId });
        load();
    });
    window.addEventListener('yearchange', (e) => {
        nav.navigateToYear(e.detail.yearId);
        selectedSection = nav.getState().section;
        trackEvent('year_changed', { year: e.detail.yearId });
        load();
    });
    window.addEventListener('sectionchange', (e) => {
        const s = e.detail.section;
        if (s === selectedSection) return;
        selectedSection = s;
        nav.navigateToSection(s);
        trackEvent('section_changed', { section: s });
        render();
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
    window.addEventListener('labgroupchange', (e) => {
        labSection.setLabGroup(e.detail.group);
        trackEvent('lab_group_changed', { group: e.detail.group });
        render();
    });
    window.addEventListener('daychange', (e) => {
        selectedDay = e.detail.day;
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
        // Attach the controllerchange listener BEFORE registering. If the new
        // service worker activates during the await register() call, the event
        // would otherwise be lost — causing the page to never reload.
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (!hadController) return; // first install — no reload needed
            const version = controllerBuildId() || CONFIG.BUILD_ID;
            reloadOnce(version);
        });

        const reg = await navigator.serviceWorker.register('./sw.js?v=' + encodeURIComponent(CONFIG.BUILD_ID));

        const askToActivate = (worker) => {
            if (worker && worker.state === 'installed') {
                worker.postMessage({ type: 'SKIP_WAITING' });
            }
        };

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
        setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) reg.update().catch(() => {});
        });

        // When the device comes back online, probe for a new service worker
        // immediately — useful on mobile where the tab may be suspended.
        window.addEventListener('online', () => reg.update().catch(() => {}));

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
        hideInstallButton();
        return;
    }

    // Listen for the browser's install prompt
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;
        showInstallButton();
    });

    // App was just installed
    window.addEventListener('appinstalled', () => {
        deferredPrompt = null;
        hideInstallButton();
        trackEvent('pwa_installed');
    });

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
    setN8nDebug(!!CONFIG.N8N_DEBUG);
    setChangeDetectorDebug(!!CONFIG.N8N_DEBUG);
    nav.initNavigation();
    migrateLegacySection();
    selectedSection = nav.getState().section;
    // Migrate any legacy numeric lab-section preference (1-8) to the new
    // two-value lab group before the first render touches the selector.
    labSection.migrateStoredLabGroup();

    initHamburger();
    ui.initInteractions?.();
    initPullToRefresh();
    initActions();
    initNavigationListeners();
    initAutoRefresh();
    initAiAssistant({ getClasses: () => classes, getContext: n8nContext });
    initFreeRooms({
        getClasses: () => classes,
        getSelectedDay: () => selectedDay || contextDay(),
        getRoomOccupancy: () => roomOccupancy,
        getYearConfig: () => nav.getYear(),
    });

    load();
    startLiveClock();
}

// Detect BFCache restoration: when a mobile browser restores the page from
// its back-forward cache (or standalone PWA page cache), no network requests
// fire and the SW is bypassed entirely. The user sees stale CSS/JS. Force a
// reload so the latest assets are served.
window.addEventListener('pageshow', (e) => {
    if (e.persisted) window.location.reload();
});

document.addEventListener('DOMContentLoaded', init);
