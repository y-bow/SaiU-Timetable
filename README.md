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

## Contributing

Fork the repo and open a pull request.

## License

MIT. See [LICENSE](LICENSE).
