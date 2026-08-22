# SaiU Timetable — Project Overview

## About

SaiU Timetable is a Progressive Web Application (PWA) built as a final-year university project for Sai University. It provides students and teachers with a real-time, offline-capable timetable management platform.

## Objectives

- Provide a centralized, always-available timetable for all SaiU schools
- Enable AI-powered natural language queries about schedules
- Automate change detection and email notifications via n8n
- Deliver analytics on timetable usage through Google Analytics and Power BI
- Support multiple schools, programs, years, and sections in a single interface

## Key Features

| Feature | Description |
|---------|-------------|
| Student Timetable | Section-specific daily schedule with live class tracking and countdowns |
| Teacher Timetable | Searchable teacher directory with weekly schedule views |
| AI Assistant | Natural language queries via Gemini/OpenRouter through n8n |
| Free Room Finder | Real-time room availability across all time slots |
| Change Detection | Automatic detection of room changes, time changes, and cancellations |
| Email Notifications | Automated alerts via n8n workflows when timetable changes occur |
| Offline Support | Full offline functionality via Service Worker caching |
| PWA Install | Installable on mobile and desktop devices |
| Dark Mode | System-aware dark/light theme with translucent glass materials |

## Schools Supported

- **SCDS** — School of Computing and Data Sciences (Years 1–3)
- **SOAI** — School of AI (Years 1–3)
- **SOB** — School of Business (Years 1–2, BBA / B.Com)
- **SAS** — School of Applied Sciences (Year 3 Neuroscience)
- **SOT** — School of Technology (Years 1–2 Biotechnology)

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla HTML, CSS, JavaScript (ES Modules) |
| Data Source | Google Sheets (CSV format) |
| Automation | n8n (self-hosted workflows) |
| AI | Gemini / OpenRouter (via n8n proxy) |
| Analytics | Google Analytics 4, Power BI |
| Hosting | GitHub Pages |
| CI/CD | GitHub Actions |

## Architecture

```
User (Browser / PWA)
    │
    ▼
SaiU Timetable (HTML / CSS / JS)
    │
    ├── Google Sheets (CSV data source)
    │
    ├── n8n Workflows
    │       │
    │       ├── AI Assistant (Gemini / OpenRouter)
    │       │
    │       └── Change Detection & Email Notifications
    │
    ├── Google Analytics 4 (usage tracking)
    │
    └── Power BI (analytics dashboard)
```

## Project Timeline

This project was developed as a easier way to look at timetable and it is now being submitted for MANTRA Ignite university level competition.

- Full-stack web development without frameworks
- Progressive Web App capabilities
- AI integration via workflow automation
- Real-time data synchronization
- Responsive mobile-first design

## License

MIT License — see [LICENSE](../LICENSE) for details.
