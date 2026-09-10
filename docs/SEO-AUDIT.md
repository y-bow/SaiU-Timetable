# SEO Audit Report — SaiU Timetable

**URL:** https://y-bow.github.io/SaiU-Timetable/  
**Date:** 2026-09-10  
**Audited by:** Seobility-based manual review

---

## Summary

| Category | Score | Status |
|----------|-------|--------|
| Meta Tags | 7/10 | Needs improvement |
| Structured Data | 5/10 | Partial — only on index.html |
| Open Graph / Twitter Cards | 8/10 | Good, minor gaps |
| Sitemap & Robots | 7/10 | Missing lastmod |
| Accessibility & Semantics | 8/10 | Good |
| Page Speed / Rendering | 9/10 | Excellent |
| 404 Handling | 4/10 | Needs noindex |

---

## Issues Found

### Critical

| # | Issue | Page | Status |
|---|-------|------|--------|
| 1 | Title tag too short — "SaiU Timetable" lacks descriptive keywords | index.html | Fixed |
| 2 | 404 page has canonical URL — should be `noindex` | 404.html | Fixed |
| 3 | Missing structured data (JSON-LD) on teachers page | teachers.html | Fixed |

### Important

| # | Issue | Page | Status |
|---|-------|------|--------|
| 4 | Sitemap missing `<lastmod>` dates | sitemap.xml | Fixed |
| 5 | OG image missing `og:image:width` and `og:image:height` | index.html, teachers.html | Fixed |
| 6 | Meta description doesn't mention "Sai University" by name | index.html | Fixed |
| 7 | Missing `<meta name="author">` tag | index.html | Fixed |

### Minor

| # | Issue | Page | Status |
|---|-------|------|--------|
| 8 | robots.txt has redundant `Allow` rules (default is Allow) | robots.txt | Fixed |
| 9 | 404 page should be disallowed in robots.txt | robots.txt | Fixed |
| 10 | Canonical URL missing trailing slash inconsistency | teachers.html | Fixed |

---

## Fixes Applied

### 1. `index.html`

- **Title:** Changed from `SaiU Timetable` to `SaiU Timetable – Live University Class Schedule & PWA`
- **Description:** Updated to mention "Sai University" and add more keywords
- **OG image:** Added `og:image:width` (512) and `og:image:height` (512)
- **Author meta:** Added `<meta name="author" content="B Vaibhav, SCDS, Sai University">`
- **JSON-LD:** Added `author` and `dateModified` fields

### 2. `teachers.html`

- **Title:** Enhanced with more context
- **Canonical URL:** Added trailing slash for consistency
- **OG image:** Added width/height
- **JSON-LD:** Added `WebApplication` structured data

### 3. `404.html`

- **Canonical:** Removed (404 pages should not have canonical)
- **Added:** `<meta name="robots" content="noindex, nofollow">`
- **Removed:** `<link rel="canonical">`

### 4. `sitemap.xml`

- Added `<lastmod>` to all URLs
- Kept existing priorities

### 5. `robots.txt`

- Simplified to minimal directives
- Added `Disallow: /404.html`

---

## Recommendations (Future)

1. Consider adding `hreflang` if multilingual content is added
2. Add a `<link rel="alternate">` for RSS/Atom if timetable changes are frequent
3. Consider adding `FAQPage` schema for common questions
4. Monitor Core Web Vitals via Google Search Console
5. Add `rel="preconnect"` for any additional third-party origins
