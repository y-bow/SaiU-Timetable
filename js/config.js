/**
 * Central configuration.
 *
 * SHEET_ID and GID are now resolved dynamically per school/year via
 * navigation.js. The values here are used only as a fallback when no
 * navigation state is available (e.g. first paint before init completes).
 */
export const CONFIG = {
    // Build version injected by build.mjs (see js/build.js). Every
    // deployment produces a new BUILD_ID used to version assets and to
    // detect updates at startup.
    BUILD_ID: (window.__TT_BUILD_ID__ && String(window.__TT_BUILD_ID__)) || 'dev',

    // Fallback sheet (used only when navigation state is not yet resolved).
    SHEET_ID: '1Jk3KCLqHHzi-jxigIcPpcXZestcxb8Y0BeQLjhiezb8',
    GID: '0',

    GA_ID: (window.__TT_GA && window.__TT_GA.id) || '',

    REFRESH_INTERVAL: 5 * 60 * 1000,

    // Background timetable change-detection (js/sync.js). The watcher runs a
    // tiny ~300-byte gviz probe once per CHECK_INTERVAL (catches rows added/
    // removed) and reconciles a full-sheet hash (28 KB for this sheet) every
    // FULL_INTERVAL (catches in-place edits such as room/faculty/time
    // changes). A full fetch + diff only happens when the fingerprint
    // actually changes, so steady-state traffic is ~1 request per interval.
    SYNC_CHECK_INTERVAL: 15 * 1000,
    SYNC_FULL_INTERVAL: 60 * 1000,
    // After a detected change, full re-checks run more frequently for a short
    // window (a sheet is often edited in a burst), then settle back.
    SYNC_FAST_FULL_INTERVAL: 30 * 1000,
    SYNC_CHANGE_WINDOW: 10 * 60 * 1000,
    // Backoff ceiling for repeated network failures (doubling from
    // CHECK_INTERVAL); the probe pauses entirely while offline/hidden.
    SYNC_MAX_BACKOFF: 5 * 60 * 1000,

    WEEKDAYS: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],

    // Cache keys (localStorage)
    CACHE_KEY: 'tt-timetable-cache-v1',
    ROOMS_KEY: 'tt-room-map-v3',
    SECTION_KEY: 'tt-section',

    BREAK_THRESHOLD_MIN: 40,
    LUNCH_START: 12 * 60 + 15,  // 12:15 PM
    LUNCH_END: 15 * 60,         // 3:00 PM
};
