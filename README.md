# SaiU Timetable

A minimal, real-time university timetable PWA. It reads published CSV data from a Google Sheet, highlights the current class with a live countdown, and keeps the schedule available offline.

**Live:** [https://y-bow.github.io/SaiU-Timetable](https://y-bow.github.io/SaiU-Timetable)

## Features

- Live highlight of the current class with countdown and progress
- Section and weekday filters
- Installable PWA with offline support
- Light and dark themes

## Structure

Static HTML/CSS/JS (no build tools needed to run). The repo is organized by
responsibility:

- Root `index.html`, `404.html`, `style.css`, `manifest.json`,
  `sw.js` — GitHub Pages entry points, kept at the repository root.
- `js/core/` — app bootstrap, config, utilities.
- `js/data/` — timetable parsing and school/year/section config.
- `js/ui/` — rendering, sidebar/navigation, spring motion.
- `js/services/` — storage, analytics, background timetable sync.
- `js/game/` — the Breakout game (isolated from the timetable app).
- `js/generated/` — build output (do not edit by hand).
- `scripts/build.mjs` — regenerates the versioned build.

## Development

```sh
npm run build    # or: node scripts/build.mjs
```

This bumps the `BUILD_ID`, regenerates `js/generated/build.js`, `build.json`,
`.buildinfo`, and rewrites `?v=` versions across HTML/manifests/SW/JS imports.
Commit the output, then push to deploy (GitHub Actions runs it automatically).

## n8n integrations

The app can talk to a self-hosted [n8n](https://n8n.io) instance. All webhook
URLs live in `js/core/config.js`; AI-provider credentials never touch the
frontend (they stay inside n8n workflows).

### Timetable change notifications

When a fetch detects timetable changes (a class moved, a room changed, a class
was cancelled), the app POSTs each change to `N8N_WEBHOOK_URL`. The default
empty URL disables it entirely; the sender is fire-and-forget and never
throws, so a broken n8n can never break the app. Events are de-duplicated per
change id via `N8N_EVENTS_KEY`, and `N8N_DEBUG` exposes a
`window.testN8nWebhook(event)` console hook for local testing.

### "Ask SaiU AI" assistant

A chat panel ("Ask AI") that turns natural-language questions into a POST to
`N8N_AI_WEBHOOK_URL` (the production n8n "SaiU AI" webhook by default),
sending the app's **live parsed timetable** plus the current navigation
context — the AI never sees hard-coded or invented data.

The panel and its buttons render when `isAiEnabled()` returns true, which is
everywhere once `AI_FEATURE_ENABLED` is `true` (live in production), or any
page served from a localhost host while `N8N_AI_WEBHOOK_URL` is set
(development/testing). `N8N_AI_WEBHOOK_URL` must never point at the
production change-notification webhook.

**Request** (`POST`, JSON, bounded by `N8N_AI_TIMEOUT_MS`):

```json
{
  "question": "When are SCDS 3 and SOAI 2 both free?",
  "timetable": [
    {
      "school": "SCDS", "year": 3, "section": 3, "labGroup": null,
      "course": "Deep Learning", "courseId": null,
      "day": "Wednesday", "date": "2026-08-19",
      "startTime": "09:00", "endTime": "10:30",
      "room": "B-201", "teacher": "Prof. X", "elective": false
    }
  ],
  "context": { "school": "SCDS", "year": 3, "section": 3, "labGroup": null }
}
```

Multi-offering electives are expanded one record per offering. Every record
carries a concrete section/faculty/room so n8n can reason per group; group
identity is school + section (never section alone).

**Response** — n8n owns all free-time/conflict calculation and returns JSON.
The chat renders common-free-time answers naturally and the `message` field
verbatim (never raw JSON):

```json
{
  "success": true,
  "message": "Both SCDS Section 3 and SOAI Section 2 are free on Wednesday.",
  "day": "Wednesday",
  "groups": [ { "school": "SCDS", "section": 3 }, { "school": "SOAI", "section": 2 } ],
  "commonFreePeriods": [ { "startTime": "12:00", "endTime": "13:00", "durationMinutes": 60 } ],
  "hasCommonFreeTime": true
}
```

Network failures, timeouts and non-JSON responses never throw or leak internals
— the UI shows a friendly retryable error.

## Contributing

Fork the repo and open a pull request.

## License

MIT. See [LICENSE](LICENSE).
