# SaiU Timetable

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![PWA](https://img.shields.io/badge/PWA-ready-orange)
![HTML5](https://img.shields.io/badge/HTML5-E34F26?logo=html5&logoColor=white)
![CSS3](https://img.shields.io/badge/CSS3-1572B6?logo=css3&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=black)

A modern timetable management and analytics platform for **Sai University (SaiU)**, built as a Progressive Web App with AI-powered queries, live notifications, and offline support.

**Live:** [https://y-bow.github.io/SaiU-Timetable](https://y-bow.github.io/SaiU-Timetable)

---

## Features

- **Student Timetable** -- Section-specific daily schedule with live class tracking and countdowns
- **Teacher Timetable** -- Searchable teacher directory with weekly schedule views
- **AI Timetable Assistant** -- Natural-language queries via Gemini/OpenRouter
- **Free Room Finder** -- Real-time room availability across all time slots
- **Teacher Availability Lookup** -- Instantly find when any teacher is free
- **Live Change Notifications** -- Room changes, time changes, and cancellations detected automatically
- **Email Notifications** -- Automated alerts via n8n when the timetable changes
- **Google Analytics** -- Usage tracking and engagement metrics
- **Power BI Dashboard** -- Long-term analytics and reporting
- **Responsive Design** -- Mobile-first layout that works on every screen size
- **Dark Mode** -- System-aware dark/light theme with translucent glass materials
- **Offline Support** -- Full functionality without an internet connection via Service Worker
- **PWA Install** -- Installable on phones and desktops as a native-like app

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | HTML5, CSS3, JavaScript (ES Modules) |
| **Backend / Automation** | n8n, Google Sheets, Gmail API |
| **AI** | Gemini, OpenRouter (via n8n proxy) |
| **Analytics** | Google Analytics 4, Power BI |
| **Deployment** | GitHub Pages, GitHub Actions CI/CD |

## Project Architecture

```
User (Browser / PWA)
    |
    v
SaiU Timetable (HTML / CSS / JS)
    |
    +-- Google Sheets (CSV data source)
    |
    +-- n8n Workflows
    |       |
    |       +-- AI Assistant (Gemini / OpenRouter)
    |       |
    |       +-- Change Detection & Email Notifications
    |
    +-- Google Analytics 4 (usage tracking)
    |
    +-- Power BI (analytics dashboard)
```

## AI Features

The "Ask SaiU AI" assistant understands natural-language timetable queries:

| Query Type | Example |
|-----------|---------|
| Today's schedule | "What classes do I have today?" |
| Teacher timetable | "Show me Prof. Arjun's schedule" |
| Free rooms | "Which rooms are free at 10 AM?" |
| Teacher free time | "When is Prof. David free?" |
| Common free time | "When are SCDS 3 and SOAI 2 both free?" |
| Timetable changes | "Any changes to my schedule?" |

The AI never sees hardcoded data -- it receives the live parsed timetable plus the current navigation context. Credentials stay server-side inside n8n.

## Automation

### Change Detection Workflow

When a timetable refresh detects that a class moved rooms, changed times, or was cancelled, the app POSTs a structured event to the n8n webhook. The workflow formats and sends an email notification. Events are de-duplicated via a deterministic change ID so the same change is never sent twice.

### AI Assistant Workflow

The chat panel sends the user's question, the live timetable, and navigation context to the n8n AI webhook. The workflow routes the request to Gemini or OpenRouter and returns a formatted response. The browser never contacts AI providers directly.

## Analytics

- **Google Analytics 4** -- Tracks timetable refreshes, section/school changes, elective toggles, PWA installs, and feedback clicks. Respects Do Not Track.
- **Power BI Dashboard** -- Aggregate views of room utilisation, teacher workload, course distribution, and timetable completeness across all schools.

## Project Highlights

- Responsive mobile-first design with desktop sidebar
- Translucent glass-morphism UI with spring animations
- AI-powered natural language timetable queries
- Real-time class countdowns and progress bars
- Automatic change detection with email notifications
- Multi-school timetable support (SCDS, SOAI, SOB, SAS, SOT)
- Breakout game on the 404 page

## Installation

### Prerequisites

- A modern web browser
- Node.js 18+ (for building only)

### Running Locally

```sh
# Clone the repository
git clone https://github.com/y-bow/SaiU-Timetable.git
cd SaiU-Timetable

# Install dependencies (for build tooling only)
npm install

# Run the build
npm run build

# Serve the files with any static server
npx serve .
```

### Testing

```sh
npm run test:parser          # CSV parser tests
npm run test:teachers        # Teacher index tests
npm run test:n8n             # n8n notification tests
npm run test:labs            # Lab parser tests
npm run test:change-detector # Change detection tests
npm run test:free-rooms      # Free room finder tests
npm run test:clock           # Real-time clock tests
npm run test:frog            # Easter egg tests
```

## Repository Structure

```
SaiU-Timetable/
+-- index.html              Main student timetable page
+-- teachers.html           Teacher timetable page
+-- 404.html                404 page with Breakout game
+-- style.css               Global stylesheet
+-- sw.js                   Service Worker (offline support)
+-- manifest.json           PWA manifest (dark theme)
+-- manifest-light.json     PWA manifest (light theme)
+-- build.json              Build version metadata
+-- package.json            Project metadata and scripts
+-- LICENSE                 MIT License
+-- robots.txt              Search engine directives
+-- sitemap.xml             XML sitemap
+-- llms.txt                LLM-friendly project description
+-- .gitignore              Git ignore rules
+-- icons/                  App icons and favicons
|   +-- app/                PWA icons (dark + light, maskable)
|   +-- favicon/            Browser favicons
|   +-- source/             Source logo files
+-- js/                     Application JavaScript
|   +-- core/               App bootstrap, config, utilities
|   +-- data/               Timetable parsing, school config, change detection
|   +-- ui/                 Rendering, navigation, AI panel, free rooms
|   +-- services/           Storage, analytics, sync, n8n, AI
|   +-- game/               Breakout game (404 page)
|   +-- teachers/           Teacher timetable page logic
|   +-- generated/          Build output (do not edit)
+-- scripts/                Build and test scripts
|   +-- build.mjs           Production build generator
|   +-- minify.mjs          CSS/JS minifier
|   +-- serve.mjs           Dev server
|   +-- test-*.mjs          Test harnesses (8 files)
+-- docs/                   Project documentation
|   +-- PROJECT.md          Project overview
|   +-- AI.md               AI assistant architecture
|   +-- N8N.md              n8n workflow documentation
|   +-- ANALYTICS.md        Analytics documentation
+-- .github/workflows/      GitHub Actions CI/CD
    +-- deploy.yml          Deploy to GitHub Pages
```

## Future Improvements

1. **Push Notifications** -- Notify students of timetable changes via Web Push API instead of email only
2. **Calendar Integration** -- Export schedules to Google Calendar and Apple Calendar
3. **Multi-Week View** -- Show a full fortnight or month view of the timetable
4. **Conflict Detection** -- Warn students when selected electives overlap in time
5. **Teacher Feedback System** -- Allow teachers to request timetable changes from within the app
6. **Exam Schedule Module** -- Extend the platform to display exam timetables and seating plans
7. **Attendance Integration** -- Connect with the university attendance system for real-time tracking
8. **Internationalization** -- Add support for multiple languages

## Contributing

Fork the repo and open a pull request. For major changes, open an issue first to discuss what you would like to change.

## License

MIT License -- see [LICENSE](LICENSE) for details.

---

Made and Maintained by B. Vaibhav | SCDS, Sai University
