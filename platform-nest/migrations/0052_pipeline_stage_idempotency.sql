-- WD-29 (DEF-2 fix) — pipeline state-transition idempotency: data repair of the raced duplicate
-- `claude_design` stages + a partial unique backstop on the single-shot extraction stages.
--
-- THE DEFECT (characterized in docs/superpowers/plans/2026-07-30-wd08-evidence.md §1.6):
-- `automation/workflows/pipeline-delivery.json`'s `Load + decide` node is a stateless recompute
-- triggered by BOTH `pipeline.gate.decided` and `scope.signed`. When a `prd_sign` decision and a
-- completed scope sign-off land close together, two workflow executions read the run before either's
-- write lands, both evaluate `!design -> release_design`, and both create a `claude_design` stage.
-- The duplicates are client-facing (run workspace + client portal) and they corrupt WD-05's bounded
-- revise loop, which counts DESIGN STAGES (`designs.length < MAX_DESIGNS`) rather than human
-- decisions. The durable fix is in platform-nest (src/core/pipeline-lock.ts + pipeline.controller.ts:
-- per-run advisory xact lock + server-side re-evaluation of the create precondition); this migration
-- cleans up the rows the shipped race already produced and adds the schema-level guard.
--
-- ─── RLS: WHY EVERY DML STATEMENT BELOW IS WRAPPED PER TENANT ────────────────────────────────────
-- Migrations run as `platform_owner` (src/db/migrate.ts, MIGRATE_DATABASE_URL), which deliberately
-- has NO BYPASSRLS (db-topology-roles, verified live: rolbypassrls = f). `pipeline_stages` and
-- `pipeline_gates` both carry FORCE ROW LEVEL SECURITY (0017_pipeline.sql), whose `tenant_isolation`
-- policy gates every row on `tenant_id = ANY(app_current_tenants())` — and `app_current_tenants()`
-- reads the `app.current_tenant_ids` GUC, which is UNSET during a migration. Unset -> NULL ->
-- `= ANY(NULL)` is NULL (falsy) for every row, so an unwrapped UPDATE/DELETE here would match ZERO
-- rows, raise no error, and still be recorded in `schema_migrations` as applied. That is not
-- hypothetical: 0050_pm_short_codes.sql shipped exactly this bug and 0051_pm_short_codes_backfill_fix.sql
-- is its corrective follow-up. Every statement below therefore runs inside a per-company loop that
-- PERFORMs `set_config('app.current_tenant_ids', <company id>, true)` first (SET LOCAL semantics,
-- scoped to this migration's own transaction — the same mechanism src/db/index.ts `withTenants` uses
-- for every ordinary request). `scripts/lint-migration-rls.mjs` (npm run lint:migration-rls) enforces
-- this for 0052+; do not remove the wrapping.
--
-- ─── THE REPAIR RULE, AND WHY "KEEP-OLDEST, DROP THE REST" WOULD HAVE BEEN WRONG ─────────────────
-- The naive repair (per (run_id, track, name) group, keep MIN(created_at), delete the rest) is
-- destructive here, for three independently sufficient reasons found by auditing the live rows:
--
--   1. NOT EVERY DUPLICATE GROUP IS A DUPLICATE. WD-05's bounded revise loop legitimately creates a
--      NEW `claude_design` row per revision. Live run 019fb0a4 ("WD-08 fresh live walk - helper")
--      holds exactly the rev-1/rev-2 pair WD-08 §1.6 drove and proved correct: rev 1 carries a
--      decided `customer_feedback: changes_requested` (the revise trigger) and rev 2 carries the
--      client's `customer_feedback: approved` plus `pm_approval: approved`. A blanket group-wise
--      delete would have destroyed a correct revise loop's second design AND the client approval and
--      PM approval hanging off it. Consequently the naive "4 duplicate groups / 6 excess rows"
--      headline count is an OVER-count: the true excess is 4 rows, because run 019fb0a4 contributes
--      0 and run 019faebe contributes 2 (not 3) — it raced TWICE around one genuine revision.
--
--   2. KEEP-OLDEST KEEPS THE WRONG ROW. `Load + decide` always operates on the LAST design
--      (`const design = designs[designs.length - 1]`, over stages ordered by created_at ASC), so the
--      NEWEST row is the live lineage and the older twin is the abandoned one. Live run 019faec4
--      makes this unambiguous: its older design holds a `pm_review` that is still `pending` (never
--      decided, orphaned by the race) while its newer design carries the entire decided chain
--      (pm_review approved -> customer_feedback approved -> pm_approval approved). Keeping the oldest
--      would have deleted the row the client and PM actually acted on and left the dead one.
--
--   3. THE ROWS ARE NOT INTERCHANGEABLE AND NOT FK-FREE. Each duplicate carries a DIFFERENT
--      `artifact_ref` (the design doc is LLM-generated per call, so "identical duplicate" never
--      matches anything), and `pipeline_gates.stage_id` is a real FK to `pipeline_stages(id)` — so
--      deleting a referenced stage either fails outright or requires disposing of the gate that
--      references it.
--
-- The rule applied instead is CAUSAL and derives from the workflow's own precondition: consecutive
-- design rows (ordered by created_at) belong to the SAME trigger — i.e. are a race pair — unless a
-- `customer_feedback: changes_requested` was DECIDED strictly between them, which is the only event
-- that justifies a new revision. For each such race pair the EARLIER row is the excess one (the
-- pipeline moved on with the later one, per point 2). Everything else is left untouched.
--
-- Idempotent by construction: after the excess rows are gone, every surviving consecutive pair has an
-- intervening `changes_requested` by definition, so a re-run selects nothing. Verified by re-running.
--
-- Gate disposal: an excess stage's referencing gates are the race's own duplicate gates. They are
-- DETACHED (stage_id -> NULL, satisfying the FK) and SOFT-deleted (`deleted_at = now()`, the column
-- pipeline_gates already has), never hard-deleted — two of the four excess rows on this dev DB carry
-- a `pm_review` a human really did decide `approved` (a PM clicking through a duplicated inbox item),
-- and erasing that decision's audit row would be rewriting history to tidy a display bug. Soft-delete
-- removes them from every read path (getRun, listGates, the portal and the workspace all filter
-- `deleted_at IS NULL`) while preserving decided_by/decided_at/decision.

-- 1) Repair: remove race-superseded `claude_design` stages, per tenant.
DO $$
DECLARE
  co RECORD;
BEGIN
  CREATE TEMP TABLE _wd29_excess (stage_id uuid PRIMARY KEY, run_id uuid NOT NULL) ON COMMIT DROP;

  FOR co IN SELECT id FROM companies LOOP
    PERFORM set_config('app.current_tenant_ids', co.id::text, true);

    -- Materialize this tenant's excess set BEFORE mutating anything: the detection predicate reads
    -- `customer_feedback` gates, and step (b) soft-deletes gates, so computing and acting in one
    -- statement could let the repair change its own input mid-flight.
    TRUNCATE _wd29_excess;
    INSERT INTO _wd29_excess (stage_id, run_id)
    SELECT d.id, d.run_id
    FROM (
      SELECT s.id, s.run_id, s.created_at,
             lead(s.created_at) OVER (PARTITION BY s.run_id ORDER BY s.created_at, s.id) AS next_created_at
      FROM pipeline_stages s
      WHERE s.track = 'delivery' AND s.name = 'claude_design'
    ) d
    WHERE d.next_created_at IS NOT NULL           -- a later design exists...
      AND NOT EXISTS (                            -- ...and no revise trigger fired between them
        SELECT 1 FROM pipeline_gates g
        WHERE g.run_id = d.run_id
          AND g.kind = 'customer_feedback'
          AND g.status = 'decided'
          AND g.decision = 'changes_requested'
          AND g.deleted_at IS NULL
          AND g.decided_at > d.created_at
          AND g.decided_at < d.next_created_at
      );

    -- (a) Detach + soft-delete the duplicate gates the same race opened on those stages.
    UPDATE pipeline_gates g
       SET stage_id = NULL, deleted_at = now(), updated_at = now()
     WHERE g.stage_id IN (SELECT stage_id FROM _wd29_excess)
       AND g.deleted_at IS NULL;

    -- (b) Delete the excess stage rows themselves (no FK references remain after (a)).
    DELETE FROM pipeline_stages s WHERE s.id IN (SELECT stage_id FROM _wd29_excess);
  END LOOP;
END $$;

-- 2) Schema-level backstop: at most ONE stage per (run, track) for each SINGLE-SHOT stage name.
--
-- Scope is deliberate. These six names are created exactly once per run by the state machine —
-- `prd_extract`/`report_extract`/`scope_extract` by `createRun` from the extraction flow, and
-- `claude_code`/`staging`/`production` each guarded in `Load + decide` by a bare existence test
-- (`!code`, `!staging`, `!prodStage`) whose read-then-write window has the identical shape to the
-- `!design` race that was actually observed. Making a second row physically impossible means no
-- future code path — or hand-written API call — can reintroduce the duplicate, which a controller
-- guard alone cannot promise.
--
-- `claude_design` is deliberately EXCLUDED, and this is the one honest limitation of this index: a
-- legitimate revise-loop revision and a raced duplicate are INDISTINGUISHABLE by the columns on the
-- row (same run_id/track/name/status; artifact_ref differs in both cases). The rule that separates
-- them is causal and cross-table ("was a `changes_requested` decided on the current head design?"),
-- which no unique index or exclusion constraint can express. Covering `claude_design` at the schema
-- level would need an additive revision/generation discriminator column on pipeline_stages — a write-
-- contract change (allocator, mcp-hub tool surface, portal/workspace display) that is outside this
-- ticket's approved scope and is filed as a follow-up. Until then `claude_design`'s guard is the
-- per-run advisory lock plus the server-side precondition re-check in pipeline.controller.ts.
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_stages_single_shot_uniq
  ON pipeline_stages (run_id, track, name)
  WHERE name IN ('prd_extract', 'report_extract', 'scope_extract', 'claude_code', 'staging', 'production');
