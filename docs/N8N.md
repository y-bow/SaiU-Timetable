# SaiU Timetable — n8n Workflows

## Overview

SaiU Timetable integrates with [n8n](https://n8n.io) (a workflow automation platform) to provide two key automation features: timetable change detection with email notifications, and the AI-powered chat assistant.

## Architecture

```
SaiU Timetable (Browser)
    │
    ├── Webhook 1: Timetable Changes
    │       │
    │       ▼
    │   n8n Workflow: Change Detection
    │       │
    │       ├── Process change event
    │       ├── Format email
    │       └── Send via Gmail API
    │
    └── Webhook 2: AI Assistant
            │
            ▼
        n8n Workflow: SaiU AI
            │
            ├── Parse question
            ├── Route to AI provider
            ├── Format response
            └── Return to browser
```

## Workflow 1 — Timetable Change Notifications

### Trigger

The app detects timetable changes (room changes, time changes, class cancellations) during each data refresh. When a change is found, it POSTs an event to the change notification webhook.

### Event Types

| Event Type | Description |
|-----------|-------------|
| `room_changed` | A class moved to a different room |
| `time_changed` | A class moved to a different time or day |
| `class_cancelled` | A class was removed from the timetable |

### Event Payload

```json
{
  "changeType": "room_changed",
  "course": "Deep Learning",
  "courseId": "deep-learning",
  "section": 3,
  "day": "Wednesday",
  "startTime": "15:00",
  "endTime": "15:55",
  "room": "AB1 Computer Lab",
  "oldRoom": "AB2",
  "newRoom": "AB1 Computer Lab",
  "oldStartTime": null,
  "newStartTime": null,
  "oldEndTime": null,
  "newEndTime": null,
  "teacher": "Prof. Dr.K.K.Singh",
  "school": "SCDS",
  "year": "scds-3",
  "labGroup": null,
  "date": "2026-08-20",
  "detectedAt": "2026-08-20T15:30:00.000Z",
  "changeId": "a1b2c3d4",
  "source": "timetable"
}
```

### Deduplication

Each change is assigned a deterministic `changeId` (FNV-1a hash of stable properties). The app persists sent change IDs in localStorage (`tt-n8n-sent-v1`) and never re-sends the same change, even across page reloads.

### Email Notifications

The n8n workflow:
1. Receives the change event via webhook
2. Formats a human-readable email with the change details
3. Sends the email via the Gmail API to configured recipients
4. Returns a success/failure status

### Configuration

| Setting | Location | Description |
|---------|----------|-------------|
| `N8N_ENABLED` | `js/core/config.js` | Master toggle for change notifications |
| `N8N_WEBHOOK_URL` | `js/core/config.js` | Webhook endpoint URL |
| `N8N_TIMEOUT_MS` | `js/core/config.js` | Request timeout (default: 4 000 ms) |
| `N8N_DEBUG` | `js/core/config.js` | Exposes `window.testN8nWebhook()` for local testing |

## Workflow 2 — SaiU AI Assistant

### Trigger

The chat panel POSTs a JSON payload to the AI webhook containing the user's question, the live timetable data, and the current navigation context.

### Processing

1. **Intent parsing** — n8n classifies the question type (schedule, free rooms, teacher availability, common free time)
2. **Data enrichment** — the timetable data is structured for the AI provider
3. **AI generation** — the enriched prompt is sent to Gemini / OpenRouter
4. **Response formatting** — the AI response is structured as JSON for the chat panel

### Configuration

| Setting | Location | Description |
|---------|----------|-------------|
| `AI_FEATURE_ENABLED` | `js/core/config.js` | Enables the AI chat panel |
| `N8N_AI_WEBHOOK_URL` | `js/core/config.js` | AI webhook endpoint |
| `N8N_AI_TIMEOUT_MS` | `js/core/config.js` | Request timeout (default: 45 000 ms) |

### Security

- API keys for Gemini / OpenRouter are stored server-side in n8n
- The browser never directly contacts AI providers
- No user-identifiable information is sent to the AI
- The webhook URL is different from the change-notification webhook
