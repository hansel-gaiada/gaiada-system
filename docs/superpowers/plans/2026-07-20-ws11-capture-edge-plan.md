# WS11 — Capture Edge Plan (record → local transcribe → ingest → Drive)

**Date:** 2026-07-20
**Status:** PLAN (approved for planning; no code yet)
**Owner ask:** make the meeting→delivery workflow *native and click-driven* in the ERP.
**Decisions locked (2026-07-20):**
1. **Capture = desktop helper from the start** (not browser MediaRecorder).
2. **Google Drive = backend service account → company Shared Drive.**
3. **This step = plan only**, review before build.

---

## 0. Framing — what is and isn't new

The user's 7-step workflow **is** WS11, which is built and live-verified (2026-07-16/17).
This plan does **not** rebuild it. It builds the **front edge (steps 1–2)** that WS11
deliberately left as a stub (`meeting-bot/`, build item 11), and finishes two small tails.

Downstream is triggered by a **frozen contract** — nothing below the ingestion edge changes:

```
POST {n8n}/webhook/mtg/recording-complete
header: x-gaiada-bridge-secret: <N8N_BRIDGE_SECRET>
body: { v:1, meetingId, tenantId, title?, transcript, participants?, startedAt? }
-> { ok, runId, deduped, prdConfidence }
```

`transcript` is a **string** (the `.txt`). Audio/video never touch the pipeline — exactly the
"transcribe locally, upload only the .txt" requirement. `meetingId` is the dedupe key
(delivery is at-least-once).

### Status of the 7 steps

| Step | State | Artifact |
|---|---|---|
| 1. Meeting + record | **NEW (this plan)** | desktop helper + registry |
| 2. Transcription | **NEW wiring** (whisper container exists) | helper → local whisper → `.txt` |
| 3. PRD + sign-off | Built | `mtg-dispatcher.json`, `pipeline.controller.ts` |
| 4. PRD → Claude design | Built | `delivery-tools.ts`, `pipeline-delivery.json` |
| 5. Design → PM → UI/UX → PM → client | Built (3-beat Submission) | `pipeline-delivery.json` |
| 6. Client feedback → PM | Built **minus bounded revise loop** | §8 tail A |
| 7. Claude Code → staging → **prod** | Built through staging; **prod gate missing** | §8 tail B |

---

## 1. Architecture (the edge)

```
┌─ operator's machine ──────────────────────────────┐
│  Gaiada Capture Helper (Tauri/Rust tray app)      │
│   • 2 actions: Record Audio | Record Audio+Video  │
│   • records to a local folder (local-first)       │
│   • watches that folder (detect pre-existing too) │
│   • calls local whisper → meeting.txt             │
│   • registers to ERP + auto-POSTs frozen contract │
└───────────────┬──────────────────┬────────────────┘
                │ register/status   │ transcript(.txt)
                ▼                   ▼
   platform-nest  (meeting_recordings + BFF)     n8n mtg-dispatcher (frozen contract)
                │                                        │
   Drive service acct ──► company Shared Drive           ▼
   (background, non-blocking)                    EXISTING WS11 pipeline (unchanged)
                │
   platform-ui  (Recordings registry + Delivery Pipeline + Client Portal)
```

**Backbone rule preserved (WS4):** n8n orchestrates, mcp-hub tools access, services hold
logic, workflows touch no DB. The helper is a *client* of the same frozen webhook + BFF —
it is not privileged. All writes go through platform-nest/BFF with a scoped token.

---

## 2. Desktop helper (`capture-helper/`)

**Why a helper (locked decision):** a browser can't reliably capture desktop-app (Zoom/Teams)
system audio on Windows, can't record when the tab is closed, and can't detect files it didn't
create. The helper removes all three limits and gives real "local-first + auto-detect + register".

**Stack:** Tauri (Rust core + tiny web UI) — small binary, free, cross-platform, code-signable.
Alternative fallback if Tauri friction: OBS (headless) + a Go/Node folder-watcher. Recommend Tauri.

**Responsibilities:**
1. **Two buttons** → determine the output file:
   - *Audio* → mic (+ system loopback via WASAPI on Windows) → `mtg-<id>.m4a/.wav`.
   - *Audio + Video* → screen + audio → `mtg-<id>.mp4`.
2. **Local-first save** to a configured folder (`%USERPROFILE%\Gaiada\Recordings` default).
3. **Folder watch** — any new media file in that folder (incl. externally created) is
   surfaced as an unregistered recording the user can one-click register.
4. **Local transcription** — pipe audio to the local whisper service (§4) → `mtg-<id>.txt`.
5. **Register + ingest** — `POST /api/:t/meetings/recordings` (metadata) then auto-POST the
   frozen contract with the `.txt`. Show status; retry on failure (at-least-once, dedup by
   `meetingId`).
6. **Drive nudge** — mark `driveStatus:pending`, show reminder; "Sync to Drive" triggers the
   backend upload (§5). Never blocks ingest.

**Auth:** helper holds a per-user **scoped device token** (minted from the ERP account, like the
existing `identity_link`/device pattern) — used for both the BFF and the bridge secret is passed
via the BFF proxy, *not* embedded in the helper (avoid leaking `N8N_BRIDGE_SECRET` to clients).
→ **Ingest is proxied**: helper calls `POST /api/:t/meetings/recordings/:id/ingest`; platform-nest
holds the bridge secret and posts the frozen contract server-side. This keeps the secret server-side.

**meetingId:** minted by platform-nest at `start` (stable, ULID-based) so dedupe is authoritative.

---

## 3. Data model — `meeting_recordings` (platform-nest)

New migration `00NN_meeting_recordings.sql` (FORCE RLS on authorized-tenant-set, like all core).

```
meeting_recordings
  id              uuid pk
  tenant_id       uuid    (RLS)
  meeting_id      text    unique(tenant_id, meeting_id)   -- frozen-contract dedupe key
  client_id       uuid null  fk clients
  project_id      uuid null  fk projects
  title           text
  kind            text    -- 'audio' | 'video'
  status          text    -- 'recording'|'recorded'|'transcribing'|'transcribed'|'ingested'|'failed'
  started_at      timestamptz
  ended_at        timestamptz null
  duration_sec    int null
  size_bytes      bigint null
  local_hint      text null     -- path/filename on the operator machine (reference only)
  transcript_ref  text null     -- files/attachment id of the .txt
  drive_status    text    -- 'none'|'pending'|'uploading'|'synced'|'failed'
  drive_file_id   text null
  drive_link      text null
  pipeline_run_id uuid null     -- set once dispatcher returns runId
  created_by      uuid
  created_at / updated_at
```

Reuses the existing **files/attachments** subsystem for the `.txt` (transcript_ref) — no new blob
store. Emits events on the backbone: `meeting.recording.created|transcribed|ingested|drive.synced`
→ `/admin/audit` + notifications.

---

## 4. Local transcription — CONFIRMED 2026-07-22 (endpoint already exists + tested)

The transcription endpoint is **already built**, not new work:
- infra **`whisper`** service = `fedirz/faster-whisper-server:latest-cpu` (compose §244) — speaks the
  **OpenAI-compatible `POST /v1/audio/transcriptions`** (multipart `file` + `model` +
  `response_format=json`) → `{ text }`. Model = `WHISPER_MODEL` (default `Systran/faster-whisper-small`).
- Gateway **`WhisperProvider`** (`ai-gateway-go/internal/providers/whisper.go`) already wraps it,
  audio-only, failing over to a multimodal provider otherwise. Fully unit-tested (`whisper_test.go`,
  part of the green gateway build). `WHISPER_URL: http://whisper:8000` is wired in compose.
- Hub **`media.transcribe`** tool (`mcp-hub/src/tools.ts`) fronts it (OBO, governed, min-assurance low).

**Wiring decision (from the gateway per-call timeout):** the gateway has a ~2.5-min per-call fetch
timeout (WS11 memory), so a full meeting's audio through hub→gateway would time out. Therefore:
- **Meeting-length audio → the capture-helper calls the whisper server's `/v1/audio/transcriptions`
  DIRECTLY** (local/LAN, no gateway cap), then POSTs only the `.txt` to
  `POST /api/:t/meetings/recordings/:id/transcript`. Config on the helper: `WHISPER_URL`.
- The hub `media.transcribe` path stays for SHORT clips (bot media), unchanged.

- Runs **async** — a 1-hour meeting is minutes on the local iGPU (≈12.5 tok/s ceiling per
  `local-inference-setup`), not seconds. UI shows `transcribing`.
- Only the `.txt` leaves the machine into the pipeline (audio stays local + goes to Drive).
- For better meeting quality, bump `WHISPER_MODEL` to `Systran/faster-whisper-medium` (slower).
- **Optional later:** speaker diarization (whisperX / pyannote) for "who said what" — flagged, not in v1.

---

## 5. Google Drive — backend service account → Shared Drive (locked)

- platform-nest gains a **Drive uploader** using a **service account** with domain-wide delegation
  (or direct Shared Drive membership) → uploads to a **company Shared Drive**, per-client subfolder
  (`/<Client>/<Project>/<meeting-title>-<date>.<ext>`).
- Trigger: `POST /api/:t/meetings/recordings/:id/drive` (from the "Sync to Drive" button / nudge).
  Sets `drive_status: uploading → synced`, stores `drive_file_id` + `drive_link`.
- **Non-blocking:** ingest (§2.5) never waits on Drive. Default `drive_status:pending` + a
  notification reminder so the pipeline is never clogged.
- **Requires Google Workspace** for a true Shared Drive (limitation §9). Config: service-account
  JSON in secrets (OpenBao/`.env`), `DRIVE_SHARED_DRIVE_ID`, `DRIVE_ROOT_FOLDER_ID`.
- The upload of the large media file is done **from the helper or a backend worker**, streamed —
  not held in platform-nest memory.

> Note: the claude.ai Google Drive MCP tools are *my* connector, not the ERP runtime — the ERP uses
> its own service-account integration described here.

**REVISED 2026-07-22 (no Workspace):** gaiada.com is a personal Google account using the domain label,
NOT a Workspace tenant — so a service account / domain-wide delegation / Shared Drive is unavailable.
Decision: **free personal-account OAuth**. A dedicated Google account holds a shared folder (15 GB free);
the **capture-helper uploads directly** to it via an OAuth **refresh token** (scope `drive.file`,
resumable streamed upload) and reports the result to `POST …/:id/drive`. The big media never transits
platform-nest. BUILT in `capture-helper/src/drive.mjs` + `scripts/get-drive-token.mjs` (one-time token
mint). Config: `DRIVE_CLIENT_ID/SECRET/REFRESH_TOKEN/FOLDER_ID`. Limits: files live in that one account's
Drive (team access via the shared folder), 15 GB quota.

---

## 6. BFF endpoints (platform-nest, `/api/:t/meetings/recordings/*`)

Member-readable; writes scoped to creator/elevated; Cerbos `meeting_recording` policy + RLS.

- `POST   /meetings/recordings/start` `{title,kind,clientId?,projectId?}` → `{id, meetingId}`
- `PATCH  /meetings/recordings/:id`   `{status?,endedAt?,durationSec?,sizeBytes?,localHint?}`
- `POST   /meetings/recordings/:id/transcript` `{text}` (or `{fileId}`) → stores `transcript_ref`
- `POST   /meetings/recordings/:id/ingest`     → server-side POST of frozen contract; stores `pipeline_run_id`
- `POST   /meetings/recordings/:id/drive`      → background Drive upload
- `GET    /meetings/recordings`                → registry list (filters: client/project/status)
- `GET    /meetings/recordings/:id`            → detail (+ links to pipeline run + portal)

Cerbos: new `meeting_recording` resource policy (read=member; write=creator|manager|owner).
mcp-hub: **no new tools required** — ingest is BFF-proxied to the existing dispatcher webhook.

---

## 7. UI (platform-ui)

- **Global quick-record** control in the TopBar (kind picker) + a **Record** action on
  `/clients/[id]` and `/projects/[id]` workspaces (ties recording to that client/project).
- **Recording banner** (managed by the helper's local UI; the web ERP shows live status via the
  registry) — timer + Stop.
- **Recordings tab/registry** (`/meetings` or a tab on client/project): table of recordings with
  status chips (`recorded → transcribing → transcribed → ingested`), **Drive chip**
  (`pending`/`synced` + reminder), transcript link, and a deep link to the **Delivery Pipeline**
  run it started. This is the "all people can reference it" surface.
- Everything **degrades gracefully** if the helper isn't installed (same pattern as
  `it-device-contract`) — you can still register an externally-made file + paste/upload a `.txt`.

New FE files (contract-first, like PM/IT): `lib/meetings.ts` (+ types), `lib/meetingsActions.ts`,
`components/meetings/*`, pages. `DEMO_MODE` stateful store for backend-free browsing.

---

## 8. Finish the two WS11 tails

**Tail B — production deploy gate (step 7). BACKEND BUILT 2026-07-22.** `deploy.production` added to
`mcp-hub/src/delivery-tools.ts` (fail-closed, **impact:high**, separate `DEPLOY_PRODUCTION_URL/TOKEN`
in `config.ts`), scoped to `wf:delivery` in `automation-policy.ts`, test added
(`delivery-tools.test.ts` — 8/8 green, hub tsc clean). Reuses existing gate kinds (no schema churn):
client staging review = `customer_feedback`, final `pm_approval` → then the workflow calls
`deploy.production` → `createStage(production)`. **REMAINING (needs live n8n import to verify):** wire
these nodes into `pipeline-delivery.json` after the staging notify: open `customer_feedback` (client
staging sign-off, actorSide client) → on approved open `pm_approval` (prod, actorSide internal) → on
approved `deploy.production` → `updateStage production done` + notify.

**Tail A — bounded revise loop (step 6). SPEC (needs live n8n import).** On `changes_requested` at the
`customer_feedback` beat, re-open the design/prototype beat; bound to N cycles via a counter kept in
`pipeline_stages` meta (or a `revise_count` on the stage), then escalate to PM. This is a
`pipeline-delivery.json` edit (a guard node comparing the count + a loop-back edge).

**Why n8n JSON is spec-not-built:** the 36-node `pipeline-delivery.json` is machine-generated and only
validated by importing into a live n8n (Docker is down this session). Hand-editing it blind risks
invalid workflow JSON that imports broken — so the deterministic backend capability (`deploy.production`)
is built + tested now, and the node wiring is done at the next live-stack session (rebuild mcp-hub image
so the new tool ships, re-import the workflow, walk a run — same procedure as the original WS11 live run).

Both remain **Temporal candidates** long-term but stay n8n for v1 (per WS11 plan).

---

## 9. Limitations (honest register)

- **Helper install/maintenance** per operator machine — the cost of reliable capture (the chosen
  trade). Needs code-signing to avoid SmartScreen (see `smart-app-control-blocks-local-builds`).
- **In-person meetings** = room-mic quality; diarization not in v1.
- **Local whisper is not instant** — minutes/hour on the iGPU; async, no live transcript.
- **Google Shared Drive needs Workspace**; storage quota applies; Drive is best-effort/non-blocking.
- **Claude design + code are the only paid pieces** (by design; everything else free).
- **Prod deploy + revise loop** are genuinely unbuilt until §8 lands.
- The helper must not hold `N8N_BRIDGE_SECRET` — ingest is proxied through the BFF (§2 auth).

---

## 10. Build order (dependency-first) — for when we green-light

1. platform-nest: migration + `MeetingRecordingsController` + Cerbos policy + events (foundation).
2. Local whisper endpoint confirm/expose.
3. Drive service-account uploader (backend) + config.
4. BFF ingest proxy (server holds bridge secret) → dispatcher; verify end-to-end with a pasted `.txt`
   (reuses the existing stub path).
5. platform-ui: `lib/meetings.ts` + registry + record actions + Drive chip.
6. `capture-helper/` (Tauri): record → watch → local whisper → register → ingest → Drive.
7. Tails A + B (revise loop, prod gate).
8. QA gate: full 7-step walk on the live compose stack (per QA norm for risky paths).

Relates to: `ws11-delivery-pipeline-plan`, `automation-stack-live`, `pm-ai-tracker-contract`,
`local-inference-setup`, `smart-app-control-blocks-local-builds`, `it-device-contract`.
