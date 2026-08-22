# SaiU Timetable — Analytics

## Overview

SaiU Timetable uses two complementary analytics systems: Google Analytics 4 for real-time user behaviour tracking, and a Power BI dashboard for long-term usage insights.

## Google Analytics 4

### Setup

Google Analytics 4 (GA4) is integrated via Google Tag Manager. The tracking script is loaded in `index.html` with privacy-respecting defaults:

- Respects `Do Not Track` browser settings
- Loads asynchronously without blocking page render
- Uses the measurement ID `G-GYB0SEBGZM`

### Events Tracked

| Event Name | Parameters | Description |
|-----------|-----------|-------------|
| `timetable_refreshed` | `source` (initial / manual / background) | When timetable data is fetched |
| `school_changed` | `school` | User switches school |
| `program_changed` | `program` | User switches program |
| `year_changed` | `year` | User switches year |
| `section_changed` | `section` | User switches section |
| `weekday_changed` | `weekday` | User switches day |
| `elective_toggled` | `elective`, `checked` | User toggles an elective |
| `offering_changed` | `elective` | User selects a different offering |
| `emerging_tools_section_changed` | `section` | User picks an Emerging Tools section |
| `lab_group_changed` | `group` | User switches lab group |
| `feedback_click` | — | User clicks the Feedback button |
| `pwa_installed` | — | User installs the PWA |

### Privacy

- No personally identifiable information (PII) is tracked
- User selections (school / year / section) are never sent to GA
- The tracking script is skipped entirely when `Do Not Track` is enabled

## Power BI Dashboard

### Data Source

The Power BI dashboard connects to the same Google Sheets that power the timetable. It provides aggregate views of:

- Timetable structure across schools and years
- Room utilisation patterns
- Course distribution by school / year / section
- Teacher workload analysis

### Metrics

| Metric | Description |
|--------|-------------|
| Classes per day | Total scheduled classes per weekday |
| Room occupancy rate | Percentage of rooms in use per time slot |
| Teacher hours | Weekly teaching hours per teacher |
| Section coverage | Number of sections with complete timetables |
| Elective popularity | Number of students per elective offering |

### Access

The Power BI dashboard is available to authorised university staff. Contact the project maintainer for access.

## Implementation Notes

- GA4 tracking is implemented in `js/services/analytics.js`
- The `trackEvent()` function wraps `gtag()` for consistent event formatting
- Events are buffered and sent asynchronously to avoid blocking the main thread
- The analytics module initialises early in the app bootstrap (`initAnalytics()` in `js/core/app.js`)
