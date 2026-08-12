/**
 * Central configuration.
 *
 * SHEET_ID and GID are now resolved dynamically per school/year via
 * navigation.js. The values here are used only as a fallback when no
 * navigation state is available (e.g. first paint before init completes).
 */
export const CONFIG = {
    // Build version injected by build.mjs (see js/generated/build.js). Every
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

    // n8n timetable-change notifications (see js/services/n8n.js).
    // The n8n "Webhook" node URL. Keep empty to disable the integration: the
    // timetable then works exactly as before and no network requests are made.
    // Set a real URL to enable event delivery (see README for n8n CORS setup).
    N8N_WEBHOOK_URL: 'https://saiutimetable.app.n8n.cloud/webhook/timetable-change',

    // Short timeout so a slow or unreachable n8n can never stall the app.
    // Event dispatch is fire-and-forget anyway; this only bounds the request.
    N8N_TIMEOUT_MS: 4000,

    // Development-only debug logging + window.testN8nWebhook(event) hook.
    // With N8N_DEBUG: true the app exposes window.testN8nWebhook() which
    // manually fires a fake timetable-change event (room_changed /
    // time_changed / class_cancelled) through the real n8n sender — handy for
    // local testing without waiting for a real change. Keep false in
    // production (see README).
    N8N_DEBUG: false,

    // localStorage key holding recently dispatched change ids, so the same
    // timetable change is never POSTed to n8n twice (see js/services/n8n.js).
    N8N_EVENTS_KEY: 'tt-n8n-sent-v1',

    // ---------------------------------------------------------------------
    // Generative-AI timetable assistant ("Ask SaiU Timetable AI").
    //
    // LOCALHOST ONLY for now — the production build must not depend on this
    // feature yet. The chat panel and its launch buttons are only rendered
    // when isAiEnabled() (js/services/timetable-ai.js) returns true, which is:
    //   - any page served from a localhost host while N8N_AI_WEBHOOK_URL is
    //     set (development/testing), OR
    //   - everywhere once AI_FEATURE_ENABLED is flipped to true (the single
    //     switch for going live in production).
    // Until then N8N_AI_WEBHOOK_URL MUST stay a localhost / test n8n webhook.
    // It must never point at the production timetable-change webhook
    // (N8N_WEBHOOK_URL) and never at a production AI webhook.
    AI_FEATURE_ENABLED: false,

    // n8n cloud "timetable AI" test webhook (POST). The browser talks ONLY to
    // this webhook; AI provider credentials (Gemini/OpenAI/…) stay inside n8n.
    N8N_AI_WEBHOOK_URL: 'https://saiutimetable.app.n8n.cloud/webhook-test/60e460ce-2b67-424e-bf2e-eec687c8172e',

    // Bounded request timeout — a slow or unreachable n8n must never hang the
    // chat; the UI shows a friendly error and lets the user retry.
    N8N_AI_TIMEOUT_MS: 15000,
};
