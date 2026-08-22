# SaiU Timetable — AI Assistant

## Overview

The "Ask SaiU AI" feature provides a natural language interface for querying timetable information. Users can ask questions in plain English and receive formatted answers about schedules, free rooms, teacher availability, and common free times.

## Architecture

```
User Question
    │
    ▼
Chat Panel (js/ui/ai-assistant.js)
    │
    ▼
n8n Webhook (POST)
    │
    ▼
n8n Workflow
    │
    ├── Intent Parser
    │       │
    │       ├── Timetable queries
    │       ├── Free room queries
    │       ├── Teacher availability
    │       └── Common free time
    │
    ▼
AI Provider (Gemini / OpenRouter)
    │
    ▼
Formatted Response
    │
    ▼
Chat Panel (rendered)
```

## Request Format

The chat panel sends a POST request to the n8n webhook with:

```json
{
  "question": "When are SCDS 3 and SOAI 2 both free?",
  "timetable": [ ... ],
  "context": {
    "school": "SCDS",
    "year": 3,
    "section": 3,
    "labGroup": null
  }
}
```

The `timetable` array contains the live parsed timetable data, ensuring the AI never sees hardcoded or invented data.

## Response Format

n8n returns JSON that the chat panel renders naturally:

```json
{
  "success": true,
  "message": "Both SCDS Section 3 and SOAI Section 2 are free on Wednesday.",
  "day": "Wednesday",
  "groups": [
    { "school": "SCDS", "section": 3 },
    { "school": "SOAI", "section": 2 }
  ],
  "commonFreePeriods": [
    { "startTime": "12:00", "endTime": "13:00", "durationMinutes": 60 }
  ],
  "hasCommonFreeTime": true
}
```

## Supported Query Types

| Query Type | Example |
|-----------|---------|
| Today's schedule | "What classes do I have today?" |
| Teacher timetable | "Show me Prof. Arjun's schedule" |
| Free rooms | "Which rooms are free at 10 AM?" |
| Teacher free time | "When is Prof. David free?" |
| Common free time | "When are SCDS 3 and SOAI 2 both free?" |
| Timetable changes | "Any changes to my schedule?" |

## Security

- AI provider credentials (API keys) never leave the n8n server
- The browser only communicates with the n8n webhook
- No PII (personally identifiable information) is sent to the AI
- Request timeout prevents hanging (45 seconds)

## Configuration

AI features are controlled by these flags in `js/core/config.js`:

| Flag | Description |
|------|-------------|
| `AI_UI_ENABLED` | Master toggle for all AI UI elements |
| `AI_FEATURE_ENABLED` | Enables the chat panel and API calls |
| `N8N_AI_WEBHOOK_URL` | Production n8n webhook endpoint |
| `N8N_AI_TIMEOUT_MS` | Request timeout (default: 45 000 ms) |

## Error Handling

- Network failures show a friendly retryable error
- Timeouts (45 s) prevent hung requests
- Non-JSON responses are handled gracefully
- The app never throws on AI failures
