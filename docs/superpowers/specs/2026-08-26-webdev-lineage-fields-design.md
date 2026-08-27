# Web Dev lineage fields — briefings, runs and repos carry their department / client / project

**Date:** 2026-08-26 · **Status:** PROTOTYPED — all three changes landed on `reva/ui` 2026-08-27 (platform-nest `0.40.0`–`0.42.0`); DEV-VERIFIED against the local host platform pending its restart · **Owner:** Reva · **Branch:** `reva/ui`

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

## Not in this spec

Project ↔ client enforcement (`clientId` required on `POST/PATCH /projects`) — owner decision
pending on how to treat existing client-less rows. Whisper `verbose_json` paragraphs. The n8n / LLM
pipeline itself.

## Verification

Each change: controller test (existing suites `meetings.test.ts`, `pipeline.test.ts`,
`webdev-controller-http.test.ts`) against the disposable test Postgres + running Cerbos;
`lint:withtenants` and `lint:migration-rls` green; `FRONTEND-BFF-CONTRACT.md` rows updated in the
same commit; then the frontend commit that consumes the field, driven in the browser.
