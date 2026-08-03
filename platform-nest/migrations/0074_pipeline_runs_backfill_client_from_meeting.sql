-- WD-30 — backfill pipeline_runs.client_id / project_id from the run's source meeting.
--
-- THE SYMPTOM, observed live on gda-aicenter and not by any test: every pipeline_run had
-- `client_id IS NULL` (5 of 5). `PortalController` filters runs by the calling contact's client ids,
-- so `GET /api/:t/portal/runs` returned `[]` for a contact who had been correctly invited, had a real
-- Keycloak account, held the `client` role, carried the tenant, and passed `resource_portal` authz.
-- The client portal was structurally blind, and every layer upstream of it reported success.
--
-- THE CAUSE: `createRun` has always ACCEPTED `clientId`/`projectId`, and the n8n extraction flow has
-- never sent them. The recording already knew both; only the hand-off dropped them. Fixed forward in
-- pipeline.controller.ts (`createRun` now derives from `meeting_recordings` when the caller omits
-- them, with an explicit body value still winning). This migration repairs the rows already written
-- under the old behaviour — without it, every historical delivery stays invisible to its own client.
--
-- Joined on `source_meeting_id = meeting_recordings.meeting_id`, which is the same key
-- `createRun`'s dedupe SELECT and the WD-26 relink sweep both use. 4 of the 5 live runs resolve to a
-- meeting carrying a client; the 5th is a `mtg-probe-*` row with no client, and it correctly stays
-- NULL — this backfill never invents an attachment.
--
-- RLS GUARD (the reason this is written as a per-tenant loop rather than one UPDATE ... FROM):
-- migrations run as `platform_owner`, which deliberately lacks BYPASSRLS. Under FORCE ROW LEVEL
-- SECURITY the `tenant_isolation` policy reads `app.current_tenant_ids`, which is UNSET during a
-- migration -> `= ANY(NULL)` -> falsy for every row, so a bare UPDATE would match ZERO rows, report
-- success, and leave the portal just as blind while looking fixed. That is the confirmed 0050 bug
-- class (see 0051 and docs/superpowers/plans/2026-07-30-migration-backfill-rls-audit.md), and it is
-- exactly the failure mode this migration would otherwise reproduce. `set_config(..., true)` is
-- SET LOCAL — scoped to this migration's transaction, the same mechanism `withTenants` uses.
--
-- Idempotent by construction: only rows still NULL are selected, so re-running is a true no-op.
DO $$
DECLARE
  co RECORD;
  updated int;
  total int := 0;
BEGIN
  FOR co IN SELECT id FROM companies LOOP
    PERFORM set_config('app.current_tenant_ids', co.id::text, true);

    UPDATE pipeline_runs r
       SET client_id  = COALESCE(r.client_id,  m.client_id),
           project_id = COALESCE(r.project_id, m.project_id),
           updated_at = now()
      FROM meeting_recordings m
     WHERE m.meeting_id = r.source_meeting_id
       AND m.deleted_at IS NULL
       AND r.deleted_at IS NULL
       AND r.source_meeting_id IS NOT NULL
       -- Only rows that actually gain something, so `updated_at` is not churned estate-wide and a
       -- re-run touches nothing at all.
       AND (
         (r.client_id  IS NULL AND m.client_id  IS NOT NULL) OR
         (r.project_id IS NULL AND m.project_id IS NOT NULL)
       );

    GET DIAGNOSTICS updated = ROW_COUNT;
    total := total + updated;
    IF updated > 0 THEN
      RAISE NOTICE '[0074] tenant %: attached % run(s) to their meeting''s client/project', co.id, updated;
    END IF;
  END LOOP;

  -- Reported rather than asserted: a fresh database legitimately has zero runs, so a non-zero count
  -- cannot be a precondition. But a SILENT zero on a populated database is the 0050 signature, and
  -- this line is what makes the difference visible in the deploy log instead of invisible.
  RAISE NOTICE '[0074] total runs attached: %', total;
END $$;

COMMENT ON COLUMN pipeline_runs.client_id IS
  'WD-30: the client this delivery belongs to. Populated by createRun, which derives it from the '
  'source meeting when the caller omits it — the n8n extraction flow never sent one, which left every '
  'run NULL and made the client portal structurally blind (0074 backfilled the historical rows).';
