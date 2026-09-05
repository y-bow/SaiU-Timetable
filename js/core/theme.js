// ============================================================
// Theme system — user-selectable background + accent colors.
// ============================================================
//
// The app ships exactly one default look (dark background, red accent).
// A saved theme lives in localStorage under 'tt-theme' as JSON of the shape
// { background: <id>, accent: <id> }. Attribute-less pages render the
// built-in dark/red defaults, so users who never touched the theme see
// exactly what they saw before this system existed.
//
// How it applies:
//   - applyTheme() writes data-bg / data-accent onto <html>. The stylesheet
//     maps those attributes to CSS custom properties (see the
//     html[data-bg]/html[data-accent] rules in style.css).
//   - The tiny inline head bootstrap script in index.html / teachers.html /
//     404.html applies the saved theme BEFORE the first paint, so there is
//     never a flash of the default dark theme. This module owns the runtime
//     switcher (sidebar controls) and is deliberately pure of top-level
//     document/localStorage access so the Node test harness can import it.
//   - localStorage is the only storage: the service worker only manages cache
//     storage, and the PWA emergency/probe cleanups only purge timetable/data
//     keys (tt-cache-*, tt-rooms-*, ...), never tt-theme. The theme therefore
//     survives every deployment, service-worker activation, and cache reset.

export const THEME_KEY = 'tt-theme';

export const BACKGROUNDS = Object.freeze([
    { id: 'dark', label: 'Dark', themeColor: '#0D0D0D' },
    { id: 'light', label: 'Light', themeColor: '#F3F4F6' },
    { id: 'slate', label: 'Slate', themeColor: '#0F172A' },
    { id: 'navy', label: 'Navy', themeColor: '#0A1A30' },
    { id: 'warm', label: 'Warm', themeColor: '#171310' },
]);

export const ACCENTS = Object.freeze([
    { id: 'red', label: 'Red', swatch: '#d85757', onSwatch: '#111111' },
    { id: 'blue', label: 'Blue', swatch: '#3B6FE0', onSwatch: '#FFFFFF' },
    { id: 'purple', label: 'Purple', swatch: '#7C5CFC', onSwatch: '#FFFFFF' },
    { id: 'green', label: 'Green', swatch: '#0B8A5F', onSwatch: '#FFFFFF' },
    { id: 'orange', label: 'Orange', swatch: '#EA7A12', onSwatch: '#111111' },
    { id: 'teal', label: 'Teal', swatch: '#0F7A75', onSwatch: '#FFFFFF' },
]);

export const DEFAULT_THEME = Object.freeze({ background: 'dark', accent: 'red' });

const isBg = (id) => BACKGROUNDS.some((b) => b.id === id);
const isAccent = (id) => ACCENTS.some((a) => a.id === id);

// Coerce any partial/invalid stored value to a fully valid theme. Unknown ids
// fall back to the default slot, so a future palette change can never leave a
// user with a broken (styling-less) combination.
export function normalizeTheme(t) {
    return {
        background: t && isBg(t.background) ? t.background : DEFAULT_THEME.background,
        accent: t && isAccent(t.accent) ? t.accent : DEFAULT_THEME.accent,
    };
}

export function getTheme() {
    try {
        const raw = localStorage.getItem(THEME_KEY);
        if (!raw) return { ...DEFAULT_THEME };
        return normalizeTheme(JSON.parse(raw));
    } catch {
        return { ...DEFAULT_THEME };
    }
}

function writeTheme(t) {
    try { localStorage.setItem(THEME_KEY, JSON.stringify(t)); } catch { /* private mode */ }
}

function themeColorFor(bgId) {
    const bg = BACKGROUNDS.find((b) => b.id === bgId);
    return bg ? bg.themeColor : BACKGROUNDS[0].themeColor;
}

// Keep the browser chrome / status bar (mobile PWA) in sync with the current
// background. The inline head bootstrap does this pre-paint; this is the
// runtime equivalent for theme switches.
function setThemeColorMeta(bgId) {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', themeColorFor(bgId));
}

// Set the HTML attributes that drive the CSS custom-property overrides.
// Returns the normalized theme actually applied.
export function applyTheme(theme) {
    const t = normalizeTheme(theme);
    const el = document.documentElement;
    el.setAttribute('data-bg', t.background);
    el.setAttribute('data-accent', t.accent);
    setThemeColorMeta(t.background);
    return t;
}

export function applyStoredTheme() {
    return applyTheme(getTheme());
}

// Merge a partial update into the stored theme, persist it, and apply it.
export function setTheme(partial) {
    const t = normalizeTheme({ ...getTheme(), ...(partial || {}) });
    writeTheme(t);
    applyTheme(t);
    return t;
}

export function resetTheme() {
    try { localStorage.removeItem(THEME_KEY); } catch { /* private mode */ }
    return applyTheme(DEFAULT_THEME);
}

// ============================================================
// Sidebar controls
// ============================================================

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

// Build one swatch row into a sidebar-list container. Each option is a
// standard .sidebar-item radio so selection reuses the app's existing active
// state (tinted background + ring + label color). Accent options lead with a
// round color dot; background options lead with the neutral radio bubble.
function renderSwatchRow(containerId, items, selectedId, dataAttr, onSelect) {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = '';
    for (const item of items) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sidebar-item theme-option' + (item.id === selectedId ? ' active' : '');
        btn.dataset[dataAttr] = item.id;
        btn.setAttribute('role', 'radio');
        btn.setAttribute('aria-checked', item.id === selectedId ? 'true' : 'false');
        btn.setAttribute('aria-label', item.label);
        const decor = dataAttr === 'themeAccent'
            ? `<span class="theme-swatch" style="background:${item.swatch}"></span>`
            : '<span class="sidebar-item-radio"></span>';
        btn.innerHTML = `${decor}<span class="sidebar-item-label">${escapeHtml(item.label)}</span><span class="theme-check" aria-hidden="true">✓</span>`;
        btn.addEventListener('click', () => onSelect(item.id));
        container.appendChild(btn);
    }
}

function syncControls() {
    const t = getTheme();
    const accentCallback = (accent) => setTheme({ accent });
    const bgCallback = (background) => setTheme({ background });
    renderSwatchRow('sidebar-theme-accent', ACCENTS, t.accent, 'themeAccent', accentCallback);
    renderSwatchRow('sidebar-theme-bg', BACKGROUNDS, t.background, 'themeBg', bgCallback);
}

/**
 * Wire up the non-editable theme section in the sidebar (swatch rows + reset).
 *
 * @param {object} [opts]
 * @param {(theme: {background:string, accent:string}) => void} [opts.onThemeChange]
 *        Called after every applied change, e.g. to fire analytics.
 */
export function initThemeControls({ onThemeChange } = {}) {
    if (typeof document === 'undefined' || !document.documentElement) return;

    const t = getTheme();
    renderSwatchRow('sidebar-theme-accent', ACCENTS, t.accent, 'themeAccent',
        (accent) => { const next = setTheme({ accent }); syncControls(); onThemeChange?.(next); });
    renderSwatchRow('sidebar-theme-bg', BACKGROUNDS, t.background, 'themeBg',
        (background) => { const next = setTheme({ background }); syncControls(); onThemeChange?.(next); });

    const resetBtn = document.getElementById('theme-reset-btn');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            const next = resetTheme();
            syncControls();
            onThemeChange?.(next);
        });
    }
}