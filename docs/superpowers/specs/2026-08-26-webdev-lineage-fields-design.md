# Web Dev lineage fields — briefings, runs and repos carry their department / client / project

**Date:** 2026-08-26 · **Status:** PROTOTYPED — all three changes landed on `reva/ui` 2026-08-27 (platform-nest `0.44.0`–`0.47.0` after the 2026-08-31 merge renumber; they landed on `reva/ui` as `0.40.0`–`0.43.0`); DEV-VERIFIED against the local host platform pending its restart · **Owner:** Reva · **Branch:** `reva/ui`

## Why

The Web Dev console (PRD Studio, Repositories, a project's Meetings tab) was rebuilt on `reva/ui`
against endpoints that exist. Three facts it needs are not stored anywhere, so the UI infers them:

1. **Which department a briefing (meeting recording) or PRD run belongs to.** Inferred through
   `project.department_id`. A briefing with no project cannot be attributed at all.
2. **Which client/project a standalone (off-pipeline) provisioned site belongs to.** Not storable;
   the UI labels them "not linked to a project · standalone".
3. **The approval state of each run on a list.** `GET /pipeline/runs` carries no gates, so the UI
   reads `GET /pipeline/runs/:id` per run, capped at 12.

Each inference is a frontend-first drift waiting to happen. This spec makes them backend facts.

## Changes

### 1. `department_id` on `meeting_recordings` and `pipeline_runs`

- Migration: `ALTER TABLE meeting_recordings ADD COLUMN department_id text` (org-node id, same
  free-text shape as `projects.department_id`, nullable); partial index on `(tenant_id,
  department_id)`. Same column on `pipeline_runs`.
- Backfill: `pipeline_runs.department_id` from the run's project (`projects.department_id`) where
  set; `meeting_recordings.department_id` likewise from its project. Runs as a plain SQL migration
  (superuser at migrate time; no RLS context needed), touching only rows where the value is NULL.
- API: `POST /meetings/recordings/start` accepts `departmentId?`; list + detail return
  `department_id`. `POST /pipeline/runs` accepts `departmentId?` and, exactly like `client_id` /
  `project_id` today, derives it from the source meeting when not passed; list + detail return it.
  `PATCH /meetings/recordings/:id` does not gain it (lineage is set at creation).
- Frontend: PRD Studio and the project's Meetings tab send `departmentId`; `scopeToDepartment`
  uses `department_id` first and the project only as fallback for rows that pre-date this.

### 2. `client_id` / `project_id` on `webdev_provisioned_sites`

- Migration: two nullable FK columns (`clients(id)`, `projects(id)`), backfilled from the run for
  rows with a `pipeline_run_id`.
- API: `POST /modules/webdev/provision` accepts `clientId?` / `projectId?` for the standalone
  shape (when `runId` is given they are copied from the run and any passed values must agree);
  the DTO and `SITE_COLUMNS` return them.
- Frontend: standalone repos show client · project; the Create form's Standalone mode gains
  optional client / project pickers.

### 3. Gates on the runs list

- API: `GET /pipeline/runs?include=gates` returns each run with `gates: PipelineGate[]`
  (one extra query grouped by `run_id`; same row shape as the detail endpoint). Without the
  parameter the response is unchanged.
- Frontend: PRD Studio, the project's Meetings tab and the Repositories inventory use it; the
  12-run cap and the per-run detail reads go away.

### 4. A project belongs to a client (approved 2026-08-27)

- Rule: `POST /projects` requires `clientId`. The one sanctioned client-less shape is the company's
  OWN work, declared explicitly with `isInternal: true` (the existing `projects.is_internal` column
  and the CC-1 `?clientId=internal` facet already mean exactly this). Both at once is a 400; an
  omitted client is a 400 on field `clientId` — never a silent NULL. The client must exist in the
  caller's tenant (400 `clientId`, not a 500 on a uuid cast).
- `PATCH /projects/:id`: `clientId: null` (detach) is a 400 — it used to be swallowed by `COALESCE`
  and look like success. Setting a client on an internal project converts it (`is_internal → false`).
- Existing client-less rows (8 of 17 locally, 9 on the live estate per `client-filter.ts`) are left
  as they are: nothing can invent their client, and a `NOT NULL` would block archiving them. The
  UI's edit form already requires a client, so they get one when someone next touches them. Tracked
  as a data gap, not a schema one — no migration.
- Same rule under every actor (agentic-native bar): the UI form (Client picker already required),
  the hub's `projects.create` (gains `isInternal`; the platform stays the authority), n8n's
  `on-client-created-seed` (already passes `clientId`).

## Not in this spec

Whisper `verbose_json` paragraphs. The n8n / LLM pipeline itself. A `NOT NULL` on
`projects.client_id` — needs the legacy rows resolved first.

## Verification

Each change: controller test (existing suites `meetings.test.ts`, `pipeline.test.ts`,
`webdev-controller-http.test.ts`) against the disposable test Postgres + running Cerbos;
`lint:withtenants` and `lint:migration-rls` green; `FRONTEND-BFF-CONTRACT.md` rows updated in the
same commit; then the frontend commit that consumes the field, driven in the browser.
