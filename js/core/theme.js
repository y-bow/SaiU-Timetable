// ============================================================
// Theme system — background TYPE + background TINT + accent.
// ============================================================
//
// A saved theme lives in localStorage under 'tt-theme' as JSON of the shape
//   { background: <type id>, accent: <preset id | hex>, bgColor: <hex | ''> }
//   background — one of BACKGROUNDS: sets the base lightness/scheme.
//   bgColor    — optional hue that TINTS the background (~12% mix), e.g.
//                'dark' + '#d85757' → dark-red canvas. '' keeps the type's
//                own natural color.
//   accent     — a preset id from ACCENTS, or any '#rrggbb' for a custom
//                accent (white/black contrast is auto-computed).
// Attribute-less pages render the built-in dark/red defaults, so untouched
// users see exactly what they saw before this system existed.
//
// How it applies:
//   - applyTheme() writes data-bg / data-accent / data-bg-color onto <html>.
//     style.css derives the surface + semantic tokens from those attributes
//     via color-mix() (see the html[data-bg]/html[data-accent] rules), so the
//     tint flows through surfaces/materials as well as the canvas.
//   - The tiny inline head bootstrap script in index.html / teachers.html /
//     404.html applies the saved theme BEFORE the first paint, so there is
//     never a flash of the default dark theme. This module owns the runtime
//     switcher (top-bar / header button → sheet panel) and is deliberately
//     pure of top-level document/localStorage access so the Node test harness
//     can import it.
//   - localStorage is the only storage: the service worker only manages cache
//     storage, and the PWA emergency/probe cleanups only purge timetable/data
//     keys (tt-cache-*, tt-rooms-*, ...), never tt-theme. The theme therefore
//     survives every deployment, service-worker activation, and cache reset.

export const THEME_KEY = 'tt-theme';

export const BACKGROUNDS = Object.freeze([
    { id: 'dark', label: 'Dark', base: '#000000' },
    { id: 'light', label: 'Light', base: '#F3F4F6' },
    { id: 'warm', label: 'Warm', base: '#171310' },
    { id: 'cool', label: 'Cool', base: '#171E29' },
]);

// Legacy preset accents (id → hex). The picker now only exposes the custom
// color wheel, but stored ids from before that change still map to their hex
// so nobody silently loses their accent.
export const ACCENTS = Object.freeze([
    { id: 'red', label: 'Red', swatch: '#d85757' },
    { id: 'blue', label: 'Blue', swatch: '#3B6FE0' },
    { id: 'purple', label: 'Purple', swatch: '#7C5CFC' },
    { id: 'green', label: 'Green', swatch: '#0B8A5F' },
    { id: 'orange', label: 'Orange', swatch: '#EA7A12' },
    { id: 'teal', label: 'Teal', swatch: '#0F7A75' },
]);
const LEGACY_ACCENTS = Object.fromEntries(ACCENTS.map((a) => [a.id, a.swatch]));

export const DEFAULT_THEME = Object.freeze({ background: 'dark', accent: '#d85757', bgColor: '' });

const isBg = (id) => BACKGROUNDS.some((b) => b.id === id);
const HEX = /^#([0-9a-f]{6})$/i;
const isHex = (v) => HEX.test(String(v || ''));
const normHex = (v) => {
    const m = HEX.exec(String(v || ''));
    return m ? `#${m[1].toLowerCase()}` : '';
};

export const bgById = (id) => BACKGROUNDS.find((b) => b.id === id);

export const accentSwatchById = (id) => {
    const a = ACCENTS.find((x) => x.id === id);
    return a ? a.swatch : (isHex(id) ? id : ACCENTS[0].swatch);
};

// ---- color math (pure, unit-tested) -------------------------------------

function parseHex(h) {
    const n = String(h).replace('#', '');
    return [n.slice(0, 2), n.slice(2, 4), n.slice(4, 6)].map((s) => parseInt(s, 16));
}

/** Mix two hex colors; `weightB` is the 0..1 fraction of the second color. */
export function mixHex(a, b, weightB = 0.12) {
    const A = parseHex(a);
    const B = parseHex(b);
    const isN = Number.isFinite(weightB) ? weightB : 0.12;
    return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * isN).toString(16).padStart(2, '0')).join('');
}

/** Black text on bright colors, white text on dark colors. Threshold tuned
 *  so every preset agrees with its hand-tuned --on-accent (red/orange use
 *  dark text; blue/purple/green/teal use white). */
export function contrastText(hex) {
    if (!isHex(hex)) return '#FFFFFF';
    const [r, g, b] = parseHex(hex).map((v) => v / 255);
    const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return lum > 0.2 ? '#111111' : '#FFFFFF';
}

/** The effective canvas color for this theme (used for the browser-chrome
 *  theme-color meta), mirroring the ~12% tint the stylesheet mixes in. */
export function themeColorFor(t) {
    const bg = bgById(t ? t.background : undefined);
    if (!bg) return BACKGROUNDS[0].base;
    const tint = t && t.bgColor ? t.bgColor : bg.base;
    return mixHex(bg.base, tint, 0.12);
}

// ---- storage / normalization --------------------------------------------

// Coerce any partial/invalid stored value to a fully valid theme. Unknown ids
// fall back to the default slot, so a future palette change can never leave a
// user with a broken (styling-less) combination. Legacy preset accent ids are
// mapped to their hex so the picker's custom color wheel shows the same hue.
export function normalizeTheme(t) {
    const rawAccent = t && t.accent;
    const legacy = rawAccent && LEGACY_ACCENTS[rawAccent];
    const accent = isHex(rawAccent)
        ? normHex(rawAccent)
        : (legacy ? normHex(legacy) : DEFAULT_THEME.accent);
    return {
        background: t && isBg(t.background) ? t.background : DEFAULT_THEME.background,
        accent,
        bgColor: t && isHex(t.bgColor) ? normHex(t.bgColor) : '',
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

// Keep the browser chrome / status bar (mobile PWA) in sync with the current
// background. The inline head bootstrap does this pre-paint; this is the
// runtime equivalent for theme switches.
function setThemeColorMeta(t) {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', themeColorFor(t));
}

// Set the HTML attributes + inline CSS variables that drive the theme. CSS
// maps data-bg/data-accent/data-bg-color to custom properties via color-mix;
// the inline --bg-tint / --accent-hex / --on-accent-inline carry the dynamic
// color choices (background tint + custom accent hex).
export function applyTheme(theme) {
    const t = normalizeTheme(theme);
    const el = document.documentElement;
    if (!el) return t;
    const bg = bgById(t.background);
    const tint = t.bgColor || bg.base;
    el.setAttribute('data-bg', t.background);
    el.setAttribute('data-accent', t.accent);
    el.setAttribute('data-bg-color', tint);
    el.style.setProperty('--bg-tint', tint);
    el.style.setProperty('--accent-hex', t.accent);
    el.style.setProperty('--on-accent-inline', contrastText(t.accent));
    setThemeColorMeta(t);
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
// Theme picker (top bar button → sheet panel)
// ============================================================

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

// Build one swatch row into a theme-list container. Each option is a
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

// Shared selection callbacks — every render (initial and re-renders) binds the
// same ones so a pick always re-syncs the highlighted option AND fires the
// change hook. A re-render that only called setTheme() would leave the old
// option highlighted (theme changes, check stays on the previous selection).
let onThemeChange = null;

function emit(next) {
    syncControls();
    onThemeChange?.(next);
}

function bgCallback(background) {
    emit(setTheme({ background }));
}

function setColorInput(inputId, labelId, hex) {
    const input = document.getElementById(inputId);
    const label = document.getElementById(labelId);
    if (input) input.value = hex;
    if (label) label.textContent = hex.toUpperCase();
}

function setRowActive(rowId, active) {
    const row = document.getElementById(rowId);
    if (row) row.classList.toggle('active', !!active);
}

function syncControls() {
    const t = getTheme();
    renderSwatchRow('theme-picker-bg', BACKGROUNDS, t.background, 'themeBg', bgCallback);

    const bg = bgById(t.background);
    setColorInput('theme-bg-color', 'theme-bg-hex', t.bgColor || bg.base);
    setRowActive('theme-bg-row', !!t.bgColor);
    setColorInput('theme-accent-color', 'theme-accent-hex', t.accent);
    setRowActive('theme-accent-row', true);
}

function getPanel() {
    return document.getElementById('theme-panel');
}

export function openThemePanel() {
    const panel = getPanel();
    if (!panel) return;
    syncControls();
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    const closeBtn = document.getElementById('theme-panel-close');
    if (closeBtn) closeBtn.focus();
}

function closeThemePanel() {
    const panel = getPanel();
    if (!panel) return;
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
}

/**
 * Wire up the theme picker: top-bar / header buttons that open the sheet
 * panel, the swatch rows + color pickers + reset inside it, and its
 * backdrop/Escape closing.
 *
 * @param {object} [opts]
 * @param {(theme: {background:string, accent:string, bgColor:string}) => void} [opts.onThemeChange]
 *        Called after every applied change, e.g. to fire analytics.
 */
export function initThemeControls({ onThemeChange: change } = {}) {
    if (typeof document === 'undefined' || !document.documentElement) return;

    onThemeChange = change || null;
    syncControls();

    for (const id of ['theme-btn-mobile', 'theme-btn-desktop']) {
        const btn = document.getElementById(id);
        if (btn) btn.addEventListener('click', openThemePanel);
    }
    const closeBtn = document.getElementById('theme-panel-close');
    if (closeBtn) closeBtn.addEventListener('click', closeThemePanel);
    const backdrop = document.querySelector('#theme-panel [data-theme-close]');
    if (backdrop) backdrop.addEventListener('click', closeThemePanel);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && getPanel()?.classList.contains('open')) closeThemePanel();
    });

    const bgInput = document.getElementById('theme-bg-color');
    if (bgInput) bgInput.addEventListener('input', () => emit(setTheme({ bgColor: bgInput.value })));
    const accentInput = document.getElementById('theme-accent-color');
    if (accentInput) accentInput.addEventListener('input', () => emit(setTheme({ accent: accentInput.value })));

    const resetBtn = document.getElementById('theme-reset-btn');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => emit(resetTheme()));
    }
}