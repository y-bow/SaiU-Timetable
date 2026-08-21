import { CONFIG } from '../core/config.js?v=2026-08-21-003';

/**
 * Google Analytics 4 helpers.
 *
 * The gtag.js bootstrap and the automatic initial page_view live in
 * index.html <head> (the Measurement ID is configured there). This module
 * only adds:
 *   trackEvent(name, params)  — send any custom event with one line
 *   trackPageView()           — a page_view for SPA navigation
 *   init()                    — wires SPA route tracking (no-op today)
 *
 * Every helper is defensive: a missing or blocked analytics must never
 * throw or interfere with the application.
 */

const ID = CONFIG.GA_ID;

// One-line helper for future events:
//   trackEvent('download_timetable', { format: 'ics' });
export function trackEvent(name, params = {}) {
    try {
        if (window.gtag && ID) window.gtag('event', name, params);
    } catch {
        // Analytics must never break the app.
    }
}

// Fire a page_view for the current location (SPA route changes only).
// The initial load's page_view comes from `gtag('config', id)` in <head>,
// so calling this at startup would create a duplicate — don't.
export function trackPageView(params = {}) {
    try {
        if (!window.gtag || !ID) return;
        window.gtag('event', 'page_view', {
            page_location: window.location.href,
            page_title: document.title,
            page_path: window.location.pathname + window.location.search,
            ...params,
        });
    } catch {
        // Analytics must never break the app.
    }
}

// Auto-track client-side navigation for any future pushState / hash routes.
// The app is a single view today and never changes location, so this never
// fires on its own — no duplicate page_view events. A window flag makes the
// binding idempotent across hot reloads.
function bindSpaNavigation() {
    if (!window.history || window.__TT_GA_SPA_BOUND) return;
    window.__TT_GA_SPA_BOUND = true;

    const onRouteChange = () => trackPageView();

    // history.pushState / replaceState do not emit popstate.
    const wrap = (method) => {
        const original = history[method];
        history[method] = function (...args) {
            const result = original.apply(this, args);
            onRouteChange();
            return result;
        };
    };
    wrap('pushState');
    wrap('replaceState');
    window.addEventListener('popstate', onRouteChange);
    window.addEventListener('hashchange', onRouteChange);
}

export function init() {
    bindSpaNavigation();
}
