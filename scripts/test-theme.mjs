/**
 * Theme system test harness (Node).
 *
 * Exercises js/core/theme.js without a browser. The module is deliberately
 * free of top-level window/document/localStorage access (the target is a
 * pre-paint inline bootstrap + sidebar switcher), so the only shims needed
 * are a tiny localStorage store and a no-op document for applyTheme().
 *
 *   normalizeTheme  — unknown ids fall back per-slot to defaults
 *   getTheme        — returns defaults when unset, tolerates malformed JSON
 *   setTheme        — persists merged partials as { background, accent }
 *   resetTheme      — removes the stored key and reapplies defaults
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
const metaAttrs = new Map();
const shimDocument = {
    documentElement: { setAttribute: (k, v) => htmlAttrs.set(k, v) },
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
    await test('DEFAULT_THEME is dark + red', () => {
        assert.equal(mod.DEFAULT_THEME.background, 'dark');
        assert.equal(mod.DEFAULT_THEME.accent, 'red');
    });
    await test('getTheme() returns defaults when nothing stored', () => {
        store.clear();
        assert.deepEqual(mod.getTheme(), { background: 'dark', accent: 'red' });
    });
    await test('BACKGROUNDS and ACCENTS define ids used by style.css', () => {
        const bgIds = mod.BACKGROUNDS.map((b) => b.id).sort();
        const accentIds = mod.ACCENTS.map((a) => a.id).sort();
        assert.deepEqual(bgIds, ['dark', 'light', 'navy', 'slate', 'warm']);
        assert.deepEqual(accentIds, ['blue', 'green', 'orange', 'purple', 'red', 'teal']);
    });
}

{
    console.log('normalizeTheme');
    await test('valid value passes through unscathed', () => {
        assert.deepEqual(
            mod.normalizeTheme({ background: 'light', accent: 'teal' }),
            { background: 'light', accent: 'teal' }
        );
    });
    await test('unknown background falls back to dark', () => {
        assert.deepEqual(
            mod.normalizeTheme({ background: 'neon', accent: 'red' }),
            { background: 'dark', accent: 'red' }
        );
    });
    await test('unknown accent falls back to red', () => {
        assert.deepEqual(
            mod.normalizeTheme({ background: 'slate', accent: 'rainbow' }),
            { background: 'slate', accent: 'red' }
        );
    });
    await test('null/undefined coerces to default theme', () => {
        assert.deepEqual(mod.normalizeTheme(null), { background: 'dark', accent: 'red' });
        assert.deepEqual(mod.normalizeTheme(undefined), { background: 'dark', accent: 'red' });
    });
}

{
    console.log('setTheme');
    await test('setTheme merges partial accent onto defaults and persists', () => {
        store.clear();
        const t = mod.setTheme({ accent: 'blue' });
        assert.deepEqual(t, { background: 'dark', accent: 'blue' });
        assert.equal(store.get(mod.THEME_KEY), JSON.stringify({ background: 'dark', accent: 'blue' }));
    });
    await test('setTheme persists full theme across "sessions"', () => {
        store.clear();
        mod.setTheme({ background: 'light', accent: 'purple' });
        assert.equal(
            store.get(mod.THEME_KEY),
            JSON.stringify({ background: 'light', accent: 'purple' })
        );
    });
    test('stored shape matches the head bootstrap reader (background + accent)', () => {
        store.clear();
        mod.setTheme({ background: 'navy', accent: 'green' });
        const parsed = JSON.parse(store.get(mod.THEME_KEY));
        // The pre-paint inline scripts in index/teachers/404.html read
        // t.background / t.accent exactly — a rename of these keys silently
        // breaks theme restore, so the property names are contractual.
        assert.equal(parsed.background, 'navy');
        assert.equal(parsed.accent, 'green');
        assert.deepEqual(Object.keys(parsed).sort(), ['accent', 'background']);
    });
    await test('stored theme survives across module instances (fresh session)', async () => {
        store.clear();
        mod.setTheme({ background: 'light', accent: 'purple' });
        // Re-import through a fresh copy of the module to mimic a new page load.
        const fresh = await import(new URL('../js/core/theme.js', import.meta.url).href + '#fresh');
        assert.deepEqual(fresh.getTheme(), { background: 'light', accent: 'purple' });
    });
    await test('getTheme() tolerates malformed JSON', () => {
        store.clear();
        store.set(mod.THEME_KEY, '{not valid json');
        assert.deepEqual(mod.getTheme(), { background: 'dark', accent: 'red' });
    });
    await test('getTheme() tolerates a stored non-object', () => {
        store.clear();
        store.set(mod.THEME_KEY, '"dark"');
        assert.deepEqual(mod.getTheme(), { background: 'dark', accent: 'red' });
    });
    await test('setTheme ignores unknown partial keys', () => {
        store.clear();
        mod.setTheme({ garble: true });
        assert.deepEqual(mod.getTheme(), { background: 'dark', accent: 'red' });
    });
}

{
    console.log('applyTheme/resetTheme');
    await test('applyTheme sets data-bg/data-accent on <html>', () => {
        htmlAttrs.clear();
        mod.applyTheme({ background: 'navy', accent: 'orange' });
        assert.equal(htmlAttrs.get('data-bg'), 'navy');
        assert.equal(htmlAttrs.get('data-accent'), 'orange');
    });
    await test('applyTheme updates the theme-color meta', () => {
        metaAttrs.clear();
        mod.applyTheme({ background: 'warm' });
        assert.equal(metaAttrs.get('content'), '#171310');
    });
    await test('resetTheme removes the stored key and reapplies defaults', () => {
        store.clear();
        mod.setTheme({ background: 'light', accent: 'teal' });
        const t = mod.resetTheme();
        assert.deepEqual(t, { background: 'dark', accent: 'red' });
        assert.equal(shimLocalStorage.getItem(mod.THEME_KEY), null);
        assert.equal(htmlAttrs.get('data-bg'), 'dark');
        assert.equal(htmlAttrs.get('data-accent'), 'red');
    });
}

console.log('\nAll theme tests passed.');
})();