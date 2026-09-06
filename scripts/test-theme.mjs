/**
 * Theme system test harness (Node).
 *
 * Exercises js/core/theme.js without a browser. The module is deliberately
 * free of top-level window/document/localStorage access (the target is a
 * pre-paint inline bootstrap + sidebar switcher), so the only shims needed
 * are a tiny localStorage store and a no-op document for applyTheme().
 *
 *   normalizeTheme  — unknown ids fall back per-slot to defaults; custom hex
 *                     accents pass through; bgColor validated as #rrggbb
 *   getTheme        — returns defaults when unset, tolerates malformed JSON
 *   setTheme        — persists merged partials as { background, accent, bgColor }
 *   resetTheme      — removes the stored key and reapplies defaults
 *   mixHex          — tint blend math (mirrors bootstrap meta computation)
 *   contrastText    — white/black text contrast for custom accents
 *   applyTheme      — writes data-bg / data-accent / data-bg-color + inline
 *                     vars and the mixed theme-color meta
 *
 * Run:  node scripts/test-theme.mjs
 */

import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Browser shims (must exist before the module is imported).
// ---------------------------------------------------------------------------

const store = new Map();
const shimLocalStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
};
globalThis.localStorage = shimLocalStorage;

const htmlAttrs = new Map();
const inlineVars = new Map();
const metaAttrs = new Map();
const shimDocument = {
    documentElement: {
        setAttribute: (k, v) => htmlAttrs.set(k, v),
        style: {
            setProperty: (k, v) => inlineVars.set(k, v),
            removeProperty: (k) => inlineVars.delete(k),
        },
    },
    getElementById: () => null,
    querySelector: () => ({ setAttribute: (k, v) => metaAttrs.set(k, v) }),
};
globalThis.document = shimDocument;

// ---------------------------------------------------------------------------

const mod = await import(new URL('../js/core/theme.js', import.meta.url).href);

async function test(name, fn) {
    try {
        await fn();
        console.log('  PASS  ' + name);
    } catch (err) {
        console.error('  FAIL  ' + name);
        throw err;
    }
}

await (async () => {
    {
    console.log('defaults');
    await test('DEFAULT_THEME is dark + red hex, no tint', () => {
        assert.equal(mod.DEFAULT_THEME.background, 'dark');
        assert.equal(mod.DEFAULT_THEME.accent, '#d85757');
        assert.equal(mod.DEFAULT_THEME.bgColor, '');
    });
    await test('getTheme() returns defaults when nothing stored', () => {
        store.clear();
        assert.deepEqual(mod.getTheme(), { background: 'dark', accent: '#d85757', bgColor: '' });
    });
    await test('BACKGROUNDS and ACCENTS define ids used by style.css', () => {
        const bgIds = mod.BACKGROUNDS.map((b) => b.id).sort();
        const accentIds = mod.ACCENTS.map((a) => a.id).sort();
        assert.deepEqual(bgIds, ['cool', 'dark', 'light', 'warm']);
        assert.deepEqual(accentIds, ['blue', 'green', 'orange', 'purple', 'red', 'teal']);
    });
    await test('every BACKGROUND defines a base color', () => {
        for (const b of mod.BACKGROUNDS) assert.match(b.base, /^#[0-9a-f]{6}$/i);
    });
}

{
    console.log('normalizeTheme');
    await test('valid theme passes through (records hex accent)', () => {
        assert.deepEqual(
            mod.normalizeTheme({ background: 'light', accent: '#0f7a75', bgColor: '#123456' }),
            { background: 'light', accent: '#0f7a75', bgColor: '#123456' }
        );
    });
    await test('custom hex accent passes through (lowercased)', () => {
        assert.deepEqual(
            mod.normalizeTheme({ background: 'dark', accent: '#FF3399', bgColor: '' }),
            { background: 'dark', accent: '#ff3399', bgColor: '' }
        );
    });
    await test('legacy preset accent ids map to their hex', () => {
        assert.deepEqual(
            mod.normalizeTheme({ background: 'dark', accent: 'orange', bgColor: '' }),
            { background: 'dark', accent: '#ea7a12', bgColor: '' }
        );
    });
    await test('unknown background falls back to dark', () => {
        assert.deepEqual(
            mod.normalizeTheme({ background: 'neon', accent: 'red' }),
            { background: 'dark', accent: '#d85757', bgColor: '' }
        );
    });
    await test('unknown accent falls back to the default hex', () => {
        assert.deepEqual(
            mod.normalizeTheme({ background: 'cool', accent: 'rainbow' }),
            { background: 'cool', accent: '#d85757', bgColor: '' }
        );
    });
    await test('invalid bgColor is dropped', () => {
        assert.deepEqual(
            mod.normalizeTheme({ background: 'dark', accent: '#123456', bgColor: 'palegreen' }),
            { background: 'dark', accent: '#123456', bgColor: '' }
        );
    });
    await test('null/undefined coerces to default theme', () => {
        assert.deepEqual(mod.normalizeTheme(null), { background: 'dark', accent: '#d85757', bgColor: '' });
        assert.deepEqual(mod.normalizeTheme(undefined), { background: 'dark', accent: '#d85757', bgColor: '' });
    });
}

{
    console.log('color math');
    await test('mixHex dark + red at 12% tints the canvas', () => {
        assert.equal(mod.mixHex('#000000', '#d85757', 0.12), '#1a0a0a');
    });
    await test('mixHex with the same color is a no-op', () => {
        assert.equal(mod.mixHex('#171310', '#171310', 0.12), '#171310');
    });
    await test('contrastText picks black on bright presets, white on dark', () => {
        assert.equal(mod.contrastText('#d85757'), '#111111'); // red
        assert.equal(mod.contrastText('#EA7A12'), '#111111'); // orange
        assert.equal(mod.contrastText('#3B6FE0'), '#FFFFFF'); // blue
        assert.equal(mod.contrastText('#7C5CFC'), '#FFFFFF'); // purple
        assert.equal(mod.contrastText('#0B8A5F'), '#FFFFFF'); // green
        assert.equal(mod.contrastText('#0F7A75'), '#FFFFFF'); // teal
    });
    await test('contrastText handles black/white endpoints', () => {
        assert.equal(mod.contrastText('#000000'), '#FFFFFF');
        assert.equal(mod.contrastText('#FFFFFF'), '#111111');
    });
    await test('themeColorFor returns the base when no tint, blended otherwise', () => {
        assert.equal(mod.themeColorFor({ background: 'warm', bgColor: '' }), '#171310');
        assert.equal(mod.themeColorFor({ background: 'dark', bgColor: '#d85757' }), '#1a0a0a');
    });
    await test('hsvToHex hits the primary hue/sat/value corners', () => {
        assert.equal(mod.hsvToHex(0, 1, 1), '#ff0000');
        assert.equal(mod.hsvToHex(120, 1, 1), '#00ff00');
        assert.equal(mod.hsvToHex(240, 1, 1), '#0000ff');
        assert.equal(mod.hsvToHex(0, 0, 1), '#ffffff');
        assert.equal(mod.hsvToHex(0, 0, 0), '#000000');
    });
    await test('hsvToHex / hexToHsv round-trip colors exactly', () => {
        for (const hex of ['#d85757', '#3b6fe0', '#ea7a12', '#808080', '#f5f5f5']) {
            const [h, s, v] = mod.hexToHsv(hex);
            assert.equal(mod.hsvToHex(h, s, v), hex);
        }
    });
    await test('hexToHsv black has zero saturation', () => {
        assert.deepEqual(mod.hexToHsv('#000000'), [0, 0, 0]);
    });
}

{
    console.log('setTheme');
    await test('setTheme merges partial accent onto defaults and persists', () => {
        store.clear();
        const t = mod.setTheme({ accent: 'blue' });
        assert.deepEqual(t, { background: 'dark', accent: '#3b6fe0', bgColor: '' });
        assert.equal(store.get(mod.THEME_KEY), JSON.stringify({ background: 'dark', accent: '#3b6fe0', bgColor: '' }));
    });
    await test('setTheme persists bgColor + custom accent', () => {
        store.clear();
        mod.setTheme({ background: 'cool', accent: '#00FF88', bgColor: '#3b2a10' });
        assert.equal(
            store.get(mod.THEME_KEY),
            JSON.stringify({ background: 'cool', accent: '#00ff88', bgColor: '#3b2a10' })
        );
    });
    test('stored shape matches the head bootstrap reader (background + accent + bgColor)', () => {
        store.clear();
        mod.setTheme({ background: 'warm', accent: 'green' });
        const parsed = JSON.parse(store.get(mod.THEME_KEY));
        // The pre-paint inline scripts in index/teachers/404.html read
        // t.background / t.accent / t.bgColor exactly — a rename silently
        // breaks theme restore, so the property names are contractual.
        assert.equal(parsed.background, 'warm');
        assert.equal(parsed.accent, '#0b8a5f');
        assert.equal(parsed.bgColor, '');
        assert.deepEqual(Object.keys(parsed).sort(), ['accent', 'background', 'bgColor']);
    });
    await test('stored theme survives across module instances (fresh session)', async () => {
        store.clear();
        mod.setTheme({ background: 'light', accent: 'purple', bgColor: '#ffeecc' });
        const fresh = await import(new URL('../js/core/theme.js', import.meta.url).href + '#fresh');
        assert.deepEqual(fresh.getTheme(), { background: 'light', accent: '#7c5cfc', bgColor: '#ffeecc' });
    });
    await test('getTheme() tolerates malformed JSON', () => {
        store.clear();
        store.set(mod.THEME_KEY, '{not valid json');
        assert.deepEqual(mod.getTheme(), { background: 'dark', accent: '#d85757', bgColor: '' });
    });
    await test('getTheme() tolerates a stored non-object', () => {
        store.clear();
        store.set(mod.THEME_KEY, '"dark"');
        assert.deepEqual(mod.getTheme(), { background: 'dark', accent: '#d85757', bgColor: '' });
    });
    await test('setTheme ignores unknown partial keys', () => {
        store.clear();
        mod.setTheme({ garble: true });
        assert.deepEqual(mod.getTheme(), { background: 'dark', accent: '#d85757', bgColor: '' });
    });
}

{
    console.log('applyTheme/resetTheme');
    await test('applyTheme sets data-bg/data-accent/data-bg-color + tint var', () => {
        htmlAttrs.clear(); inlineVars.clear();
        mod.applyTheme({ background: 'cool', accent: 'red', bgColor: '#d85757' });
        assert.equal(htmlAttrs.get('data-bg'), 'cool');
        assert.equal(htmlAttrs.get('data-accent'), '#d85757');
        assert.equal(htmlAttrs.get('data-bg-color'), '#d85757');
        assert.equal(inlineVars.get('--bg-tint'), '#d85757');
    });
    await test('applyTheme defaults --bg-tint to the type base when no tint', () => {
        inlineVars.clear();
        mod.applyTheme({ background: 'warm', accent: 'red' });
        assert.equal(inlineVars.get('--bg-tint'), '#171310');
    });
    await test('accent always sets inline --accent-hex/--on-accent-inline (legacy id maps too)', () => {
        inlineVars.clear();
        mod.applyTheme({ background: 'dark', accent: '#ff8c00', bgColor: '' });
        assert.equal(inlineVars.get('--accent-hex'), '#ff8c00');
        assert.equal(inlineVars.get('--on-accent-inline'), '#111111');
        mod.applyTheme({ background: 'dark', accent: 'red', bgColor: '' });
        assert.equal(inlineVars.get('--accent-hex'), '#d85757');
        assert.equal(inlineVars.get('--on-accent-inline'), '#111111');
    });
    await test('applyTheme updates the theme-color meta (mixed for tinted bg)', () => {
        metaAttrs.clear();
        mod.applyTheme({ background: 'warm' });
        assert.equal(metaAttrs.get('content'), '#171310');
        metaAttrs.clear();
        mod.applyTheme({ background: 'dark', accent: 'red', bgColor: '#d85757' });
        assert.equal(metaAttrs.get('content'), '#1a0a0a');
    });
    await test('resetTheme removes the stored key and reapplies defaults', () => {
        store.clear();
        mod.setTheme({ background: 'light', accent: 'teal', bgColor: '#abc123' });
        const t = mod.resetTheme();
        assert.deepEqual(t, { background: 'dark', accent: '#d85757', bgColor: '' });
        assert.equal(shimLocalStorage.getItem(mod.THEME_KEY), null);
        assert.equal(htmlAttrs.get('data-bg'), 'dark');
        assert.equal(htmlAttrs.get('data-accent'), '#d85757');
        assert.equal(htmlAttrs.get('data-bg-color'), '#000000');
    });
}

console.log('\nAll theme tests passed.');
})();