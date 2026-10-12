# search: content-decay alerts (M5-V4, PROTOTYPED)

Finds pages that are losing traffic and keeps them as findings. Contract: `docs/FRONTEND-BFF-CONTRACT.md` section 28a.

| File | What |
|---|---|
| `content-decay.ts` | the pure detector: thresholds, windows, path normalisation. No DB, no clock, no network |
| `content-decay-job.ts` | the daily sweep + the env-flagged loop (`SEARCH_DECAY_ENABLED=1`, otherwise OFF) |
| `content-decay.controller.ts` | list, acknowledge, file a refresh brief |
| `content-decay-mcp-tools.ts` | the three MCP tools |
| `notifications.ts` (`notifyDecayFindings`) | the bell to the property's owners |
| `migrations/202610122200_search_decay_findings.sql` | the table |

Rules to keep: missing data is `null`, never 0 (no alert on a window nobody could measure); GSC rows with
`simulated = true` never count; view counts under 5 leave the API as `"<5"`; the job makes no call at all when the
flag is off; a page has at most one live finding.

Thresholds (per 28-day window, `DECAY_THRESHOLDS`): see the table in the ticket report or the constants themselves.
Change a number there and the tests in `content-decay.test.ts` say which behaviour moved.
