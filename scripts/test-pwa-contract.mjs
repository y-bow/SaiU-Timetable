/**
 * PWA source-contract test (Node).
 *
 * The service worker deliberately unregisters itself on localhost
 * (see DEV_HOSTS in sw.js), so the version handshake between sw.js and
 * js/core/app.js cannot be exercised in local development — and a mismatch in
 * the message names fails silently: the page just never learns that a newer
 * build exists and no update bar ever appears.
 *
 * That is exactly how a real bug got shipped while building the stale-shell
 * prompt, so the contract is asserted statically here instead. It reads both
 * files as text and checks that:
 *
 *   - every message type app.js SENDS is handled by sw.js
 *   - every message type sw.js POSTS is handled by app.js
 *   - the build-id payload key matches on both sides
 *   - the precache tiers are populated, disjoint, and free of duplicates
 *   - every asset named in a precache tier actually exists on disk
 *
 * Run:  node scripts/test-pwa-contract.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// Comments quote the markup they replaced, so strip them before matching —
// otherwise a page's own "this used to be a preload" comment trips the guards below.
const stripComments = (html) => html.replace(/<!--[\s\S]*?-->/g, '');

const sw = read('sw.js');
const app = read('js/core/app.js');

let checks = 0;
const ok = (label) => { checks++; console.log('  ok  ' + label); };

// ---------------------------------------------------------------------------
// 1. Message handshake
// ---------------------------------------------------------------------------

// Types the page sends to the worker, and the types the worker sends back.
const PAGE_SENDS = [...app.matchAll(/postMessage\(\{\s*type:\s*'([^']+)'/g)].map((m) => m[1]);
const SW_HANDLES = [...sw.matchAll(/data\.type\s*===\s*'([^']+)'/g)].map((m) => m[1]);
const SW_SENDS = [...sw.matchAll(/postMessage\(\{\s*type:\s*'([^']+)'/g)].map((m) => m[1]);
const PAGE_HANDLES = [...app.matchAll(/e\.data\?\.type\s*===\s*'([^']+)'/g)].map((m) => m[1]);

// postMessage({type:'X'}) in the page is not necessarily a worker message
// (channel ports, analytics, ...), so only assert on the known handshake set.
const HANDSHAKE = ['SAIU_VERSION_CHECK', 'SAIU_VERSION', 'SAIU_UPDATE_READY', 'SKIP_WAITING'];

assert.ok(PAGE_SENDS.length > 0, 'app.js sends no postMessage types at all');
assert.ok(SW_SENDS.length > 0, 'sw.js posts no message types at all');

for (const type of new Set(PAGE_SENDS.filter((t) => HANDSHAKE.includes(t)))) {
    assert.ok(SW_HANDLES.includes(type), `sw.js never handles '${type}' sent by app.js`);
}
ok('every handshake message app.js sends is handled by sw.js');

for (const type of new Set(SW_SENDS)) {
    assert.ok(
        PAGE_HANDLES.includes(type),
        `app.js never handles '${type}' posted by sw.js`
    );
}
ok('every message sw.js posts is handled by app.js');

// The version reply is only useful if the build id survives the round trip.
assert.match(sw, /type:\s*'SAIU_VERSION',\s*buildId:\s*BUILD_ID/, 'sw.js must send buildId with SAIU_VERSION');
assert.match(app, /SAIU_VERSION[\s\S]{0,200}?buildId/, 'app.js must read buildId from SAIU_VERSION');
ok('buildId is carried on the version reply in both directions');

// A typo in the id string would compare unequal forever and nag every launch.
assert.match(sw, /const BUILD_ID = '\d{4}-\d{2}-\d{2}-\d{3}'/, 'sw.js BUILD_ID must be a date-sequence string');
ok('BUILD_ID is a comparable YYYY-MM-DD-NNN stamp');

// ---------------------------------------------------------------------------
// 2. Stale-shell detection actually compares, and never auto-reloads
// ---------------------------------------------------------------------------

assert.match(app, /workerBuild\s*!==\s*pageBuild|workerBuild\s*!==\s*CONFIG\.BUILD_ID/, 'app.js must compare the two build ids');
ok('app.js compares worker build against page build');

// Auto-reloading is the behaviour this prompt exists to avoid, and reloading
// while a worker is still waiting would just re-serve the same stale shell.
// Every reload() must be preceded by a SKIP_WAITING handshake.
const reloads = [...app.matchAll(/location\.reload\(\)/g)];
assert.ok(reloads.length > 0, 'app.js never reloads — is the update prompt wired up?');
for (const m of reloads) {
    const before = app.slice(Math.max(0, m.index - 500), m.index);
    assert.ok(
        /SKIP_WAITING/.test(before),
        'app.js calls location.reload() without first asking a waiting worker to activate'
    );
}
ok('every reload waits for SKIP_WAITING first');

// ---------------------------------------------------------------------------
// 3. Precache tiers
// ---------------------------------------------------------------------------

// Entries look like `'teachers.html'` or `versioned('style.css')`, so the
// versioned-ness has to be read from the wrapper — there is no literal ?v= in
// sw.js to recover it from.
const extractArray = (name) => {
    const m = sw.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n\\];`));
    assert.ok(m, `could not find ${name} in sw.js`);
    return [...m[1].matchAll(/^[ \t]*(versioned\()?'([^']+)'/gm)].map((x) => ({
        path: x[2],
        versioned: Boolean(x[1]),
    }));
};

const core = extractArray('CORE_ASSETS');
const extra = extractArray('EXTRA_ASSETS');
const entries = [...core, ...extra];
const corePaths = core.map((e) => e.path);
const extraPaths = extra.map((e) => e.path);

assert.ok(core.length > 0, 'CORE_ASSETS is empty — an offline launch would be broken');
assert.ok(extra.length > 0, 'EXTRA_ASSETS is empty — nothing is being deferred');
ok(`precache tiers parsed (core=${core.length}, extra=${extra.length})`);

for (const [name, list] of [['CORE_ASSETS', corePaths], ['EXTRA_ASSETS', extraPaths]]) {
    const dupes = list.filter((u, i) => list.indexOf(u) !== i);
    assert.deepEqual(dupes, [], `${name} has duplicate entries: ${dupes.join(', ')}`);
}
ok('no duplicates within either tier');

const overlap = corePaths.filter((u) => extraPaths.includes(u));
assert.deepEqual(overlap, [], `assets in both tiers: ${overlap.join(', ')}`);
ok('the two tiers are disjoint');

// Everything listed must exist, or the cache silently stores a 404/HTML page.
for (const e of entries) {
    assert.ok(existsSync(join(ROOT, e.path)), `precached asset does not exist on disk: ${e.path}`);
}
ok('every precached asset exists on disk');

// The self-hosted fonts must be precached or an offline launch renders in the
// system fallback, and the woff2 URL must be versioned like every other asset
// (the SW's cache-first handler is only safe because URLs are versioned).
for (const font of ['fonts/inter-latin.woff2', 'fonts/inter-latin-ext.woff2']) {
    assert.ok(corePaths.some((p) => p === font), `${font} is not precached`);
    const css = read('style.css');
    assert.match(css, new RegExp(`url\\('${font.replace(/\//g, '\\/')}\\?v=`), `${font} is not versioned in style.css`);
}
ok('self-hosted fonts are precached and versioned in style.css');

// Every asset a page references must be precached under the *same* URL — same
// path AND same versioning. A mismatch means the precache entry is dead weight
// and the real request misses the cache: that is exactly how the iOS startup
// images ended up cached unversioned while index.html asked for them with ?v=,
// silently wasting ~424KB on every install and pushing iOS onto the network.
const precached = new Map(entries.map((e) => [e.path, e.versioned]));
const problems = [];
for (const f of ['index.html', 'teachers.html', '404.html']) {
    const html = stripComments(read(f));
    for (const m of html.matchAll(/(?:href|src)="([^"?#]+\.(?:png|woff2|css|js|json))(\?v=[^"]*)?"/g)) {
        const [, path, query] = m;
        if (!precached.has(path)) {
            problems.push(`${f}: ${path} is referenced but not precached`);
        } else if (precached.get(path) !== Boolean(query)) {
            problems.push(
                `${f}: ${path} is ${query ? 'versioned' : 'unversioned'} in the page but ` +
                `${precached.get(path) ? 'versioned' : 'unversioned'} in the precache`
            );
        }
    }
}
assert.deepEqual(problems, [], problems.join('\n  '));
ok(`all page-referenced assets are precached with a matching version`);

// The index.html preload must match the @font-face URL exactly, otherwise the
// browser downloads the font twice and logs a preload-mismatch warning.
const idx = read('index.html');
const preload = idx.match(/<link rel="preload" href="(fonts\/inter-latin\.woff2\?v=[^"]+)"/);
assert.ok(preload, 'index.html has no versioned inter-latin.woff2 preload');
assert.ok(
    read('style.css').includes(`url('${preload[1]}')`),
    `preload ${preload[1]} does not match any @font-face src in style.css`
);
ok('index.html font preload matches the @font-face URL exactly');

// ---------------------------------------------------------------------------
// 4. No third-party font traffic left to precache
// ---------------------------------------------------------------------------

for (const f of ['index.html', 'teachers.html', '404.html', 'sw.js']) {
    assert.ok(
        !/fonts\.(googleapis|gstatic)\.com/.test(read(f)),
        `${f} still references Google Fonts; the SW no longer precaches it`
    );
}
ok('no Google Fonts references remain in any page or in sw.js');

// ---------------------------------------------------------------------------
// 5. FOUC guards (see scripts/build.mjs verifyHtml)
// ---------------------------------------------------------------------------

for (const f of ['index.html', 'teachers.html', '404.html']) {
    const html = stripComments(read(f));
    assert.match(
        html,
        /<link rel="stylesheet" href="style\.css\?v=/,
        `${f} does not render-block on the stylesheet`
    );
    assert.ok(
        !/<link[^>]*rel="preload"[^>]*as="style"/.test(html),
        `${f} preloads the stylesheet asynchronously, which reintroduces the FOUC`
    );
}
ok('every page render-blocks on the stylesheet');

// The build script must still fail loudly rather than emit broken markup.
assert.match(read('scripts/build.mjs'), /function verifyHtml/, 'build.mjs lost its verifyHtml guard');
assert.match(read('scripts/build.mjs'), /<!--\[\\s\\S\]\*\?-->/, 'build.mjs versionRefs is not comment-aware again');
ok('build.mjs keeps its HTML verification and comment-aware versionRefs');

console.log(`\nAll ${checks} PWA contract checks passed.`);
