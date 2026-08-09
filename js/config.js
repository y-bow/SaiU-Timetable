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

    WEEKDAYS: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],

    // Cache keys (localStorage)
    CACHE_KEY: 'tt-timetable-cache-v1',
    ROOMS_KEY: 'tt-room-map-v3',
    SECTION_KEY: 'tt-section',

    BREAK_THRESHOLD_MIN: 40,
    LUNCH_START: 12 * 60 + 15,  // 12:15 PM
    LUNCH_END: 15 * 60,         // 3:00 PM

    // Minimum gap (minutes) between "now" and the next class before the
    // Breakout suggestion is shown. Below this the game hint is hidden so a
    // class that is about to start never gets interrupted by an invitation.
    GAME_SUGGEST_MIN: 5,
};
