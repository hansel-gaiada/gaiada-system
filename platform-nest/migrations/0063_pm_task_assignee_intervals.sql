-- TR-34 (Work Tracker / Reports / Appraisal program) — as-of TASK OWNERSHIP: validity intervals on
-- `pm_task_assignees`, closing the identical history-rewrite hole `org_unit_memberships` (0055)
-- closed for the UNIT axis, this time for the OWNERSHIP axis. Escalated by TR-07 (§15 ①): today
-- `pm_task_assignees` has no `valid_from`/`valid_to`, so recomputing ANY past fact slice credits a
-- task's completion to whoever owns it TODAY — reassign a task in September and August's recomputed
-- numbers move with it. Appraisal numbers must not be able to change because of a later reassignment.
--
-- ─────────────────────────── NUMBERING ───────────────────────────
-- Claimed AT IMPLEMENTATION TIME per migrations/README.md rule 5 and the doc's §15 PROCESS RULE.
-- `ls migrations | tail` showed head files up to `0057_report_metric_seeds.sql` plus `0060`-`0062`
-- (search-marketing programme, landed out of band per README's 2026-07-30 SM-51 note). `0058`/`0059`
-- remain deliberately reserved for TR-23/TR-14 (per that same README note) and are NOT filled here.
-- Next genuinely free number is **0063**. Recorded in migrations/README.md.
--
-- ─────────────────────────── THE TEMPLATE THIS FOLLOWS ───────────────────────────
-- `0055_org_unit_memberships.sql` (TR-03, §3.2) is the model, verbatim in spirit: one row per
-- (task, role) validity interval, `valid_to IS NULL` = open/current, a transfer NEVER rewrites
-- history (old row closed, new row opened), and a SINGLE btree_gist EXCLUDE constraint gives BOTH
-- "no two intervals for the same (tenant, task, role) may overlap" AND — for free, because two
-- open-ended rows both collapse to the same upper bound (`COALESCE(valid_to, '9999-12-31')`) and
-- therefore always overlap each other — "at most one currently-open interval per (tenant, task,
-- role)". That is the DB-enforced invariant the ticket requires; no application code decides it.
--
-- ─────────────────────── DESIGN JUDGEMENT (delegated by the ticket, justified here) ───────────────────────
-- Do validity intervals apply to ALL THREE roles, or only owner/responsible?
--
-- RULING: owner and responsible get intervals; contributor does NOT. Reasoning:
--   1. Outcome credit (the thing TR-34 exists to protect) is decided ENTIRELY by `attributePerson()`
--      in fact-job.ts off the owner/responsible axis (§3.1's attribution table). Contributors are
--      explicitly NEVER outcome-credited — their reporting signal is `time_entries.minutes`, which
--      already carries its own `entry_date` and needs no interval of its own to be as-of-correct.
--      A contributor interval would protect a number that isn't derived from this table in the
--      first place.
--   2. The ONE place contributor role currently feeds an as-of-sensitive decision is fact-job.ts's
--      `task_role` classification for `minutes_contributed` (effort query) — and TR-34 fixes THAT
--      query to resolve owner/responsible as-of the time entry's own date, falling back to
--      'contributor' UNFILTERED (see fact-job.ts). A contributor row's mere EXISTENCE (not a date
--      range) is all that decision needs, because contributor add/remove already has its own
--      correct-for-purpose lifecycle: `addContributor`/`removeContributor` (pm.controller.ts) DELETE
--      the row outright on removal — there is no "contributor as of a past date" question to answer,
--      because contributor status was never used to gate a PAST fact until this ticket, and now that
--      it is, the fix is "prefer owner/responsible, whichever is as-of-valid; else contributor,
--      whichever is CURRENT" — exactly mirroring the existing owner-takes-all precedence, not
--      inventing a fourth kind of interval.
--   3. Cost/benefit: giving contributor its own interval (close-on-remove instead of delete-on-remove)
--      would add EXCLUDE-constraint complexity and a second amend/transfer/remove state machine in
--      the controller for a role whose own reporting number (`minutes_contributed`) is already
--      date-correct via `time_entries.entry_date` — real complexity for no correctness gain.
-- Net: `valid_from`/`valid_to` are added to the TABLE (shared columns, since it is one physical
-- table for all three roles) but the EXCLUDE constraint and the close/open dual-write logic apply
-- ONLY `WHERE role IN ('owner','responsible')`. Contributor rows get a `valid_from` default
-- (harmless, unused) and `valid_to` always NULL; DELETE remains their whole lifecycle, unchanged from
-- TR-02.
--
-- ─────────────────────────── WHAT THIS MIGRATION DOES ───────────────────────────
--   1. Adds `valid_from date NOT NULL DEFAULT CURRENT_DATE` and `valid_to date` (NULL = open) to
--      `pm_task_assignees`, plus the same `valid_range` CHECK 0055 uses.
--   2. Backfills `valid_from` for every EXISTING row: owner/responsible rows are dated from
--      `pm_tasks.created_at::date` (the ticket's explicit "Done when" bar — the task's own creation,
--      not the migration's run date), contributor rows from their OWN `pm_task_assignees.created_at`
--      (harmless/unused per the ruling above, but a real date is cheaper than an arbitrary one).
--   3. Widens `ux_pm_task_assignees_row`'s UNIQUE key to include `valid_from`. WITHOUT this, a
--      round-trip reassignment (A owns -> B owns -> A owns again) would collide with A's own FIRST,
--      now-CLOSED row on `(tenant_id, task_id, role, assignee_kind, assignee_ref)` — the exact
--      column set the old key used, which assumed at most one row per role ever existed. Widening by
--      `valid_from` (which differs between A's two stints) is the minimal fix; it does not weaken
--      the key for any of its other callers (the 0054 backfill's `ON CONFLICT DO NOTHING`, or
--      `addContributor`'s `ON CONFLICT ON CONSTRAINT ux_pm_task_assignees_row`) because both only
--      ever insert with `valid_from` implicitly `CURRENT_DATE`, so same-day repeats still collide
--      and dedupe exactly as before.
--   4. DROPS `ux_pm_task_assignees_one_owner` / `ux_pm_task_assignees_one_responsible` (0054's
--      "exactly one row per role, ever" partial uniques) — these are now WRONG on their own terms:
--      once closed historical rows are kept, a reassigned task legitimately has MORE than one owner
--      row, just not more than one OPEN one. Replaced by the EXCLUDE constraint below, which encodes
--      the correct invariant ("no two intervals for the same role may overlap in TIME", which yields
--      "at most one open" as a corollary) instead of the wrong one ("at most one row, full stop").
--      SECURITY-RELEVANT CHANGE, flagged per the standing instruction: this is a WIDENING of what the
--      table permits (multiple rows per role are now allowed where they previously were not) — but it
--      is not a widening of any RLS/grant boundary, and the new EXCLUDE constraint is strictly
--      necessary to represent history at all; the ticket's whole point is that the OLD constraint was
--      too strict for a design that must retain history.
--   5. Adds `pm_task_assignees_no_overlap`, the EXCLUDE constraint (see "template" note above), and
--      a supporting `(tenant_id, task_id, role, valid_from, valid_to)` index for the as-of lookups
--      fact-job.ts now performs.
--
-- btree_gist: already installed by 0055; `CREATE EXTENSION IF NOT EXISTS` is idempotent and
-- therefore a documented no-op here (ruling 4 of the brief).
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE pm_task_assignees ADD COLUMN valid_from date NOT NULL DEFAULT CURRENT_DATE;
ALTER TABLE pm_task_assignees ADD COLUMN valid_to date; -- NULL = open/current

ALTER TABLE pm_task_assignees ADD CONSTRAINT pm_task_assignees_valid_range
  CHECK (valid_to IS NULL OR valid_to >= valid_from);

-- ═════════════════════════════════ BACKFILL ═════════════════════════════════
-- WHY THE PER-TENANT set_config WRAPPER IS MANDATORY (ruling 1 of the brief, not defensive style):
-- migrations run as platform_owner (MIGRATE_DATABASE_URL), which does NOT have BYPASSRLS. Both
-- `pm_task_assignees` (FORCE RLS since 0054) and `pm_tasks` (FORCE RLS since 0018/0025) gate every
-- row on `tenant_id = ANY(app_current_tenants())`, reading the `app.current_tenant_ids` GUC — UNSET
-- during a migration run. Unset -> NULL -> `= ANY(NULL)` is NULL (falsy) for every row, so an
-- unguarded UPDATE here would silently touch ZERO rows, raise NO error, and still be recorded in
-- schema_migrations as applied — the confirmed 0050_pm_short_codes.sql bug class. The guard below is
-- therefore load-bearing and NOT lint-enforced the same way a fresh-table backfill would be exempt:
-- `lint:migration-rls`'s `createdHere` carve-out does not apply (neither `pm_task_assignees` nor
-- `pm_tasks` is CREATE TABLE'd in this file), so this file IS enforced by that lint, and it passes
-- because `set_config('app.current_tenant_ids', ...)` appears before every UPDATE.
-- `pm-task-assignee-intervals.test.ts` proves it empirically by re-running this exact block through
-- a NOBYPASSRLS role with no ambient tenant context and asserting a non-zero, correctly-dated result
-- (the standing ruling 1 NOBYPASSRLS-role test).
--
-- IDEMPOTENCY: both UPDATEs are plain, unconditional re-assignments of `valid_from` from a
-- deterministic source (`pm_tasks.created_at::date` / the assignee row's own `created_at::date`), so
-- a second pass recomputes the SAME value and writes nothing observably different — a true no-op,
-- not merely "no error".
DO $$
DECLARE
  co            RECORD;
  n_owner_resp  int := 0;
  n_contributor int := 0;
  affected      int;
BEGIN
  FOR co IN SELECT id FROM companies ORDER BY id LOOP
    -- SET LOCAL semantics (is_local = true): scoped to THIS migration's transaction, the same
    -- mechanism src/db/index.ts withTenants() uses for every ordinary request.
    PERFORM set_config('app.current_tenant_ids', co.id::text, true);

    -- owner/responsible: dated from the TASK's own creation (the ticket's explicit "Done when" bar).
    UPDATE pm_task_assignees pta
       SET valid_from = t.created_at::date
      FROM pm_tasks t
     WHERE pta.tenant_id = co.id
       AND pta.task_id = t.id
       AND t.tenant_id = co.id
       AND pta.role IN ('owner', 'responsible');
    GET DIAGNOSTICS affected = ROW_COUNT;
    n_owner_resp := n_owner_resp + affected;

    -- contributor: dated from the ASSIGNEE ROW's own creation (harmless/unused per the design
    -- judgement above — contributor never gets interval semantics — but a real date costs nothing).
    UPDATE pm_task_assignees pta
       SET valid_from = pta.created_at::date
     WHERE pta.tenant_id = co.id
       AND pta.role = 'contributor';
    GET DIAGNOSTICS affected = ROW_COUNT;
    n_contributor := n_contributor + affected;
  END LOOP;

  RAISE NOTICE 'pm_task_assignees interval backfill: % owner/responsible row(s) dated from task creation, % contributor row(s) dated from their own creation',
    n_owner_resp, n_contributor;
END $$;

-- ═══════════════════ WIDEN ux_pm_task_assignees_row (see note 3 above) ═══════════════════
ALTER TABLE pm_task_assignees DROP CONSTRAINT ux_pm_task_assignees_row;
ALTER TABLE pm_task_assignees ADD CONSTRAINT ux_pm_task_assignees_row
  UNIQUE (tenant_id, task_id, role, assignee_kind, assignee_ref, valid_from);

-- ═══════════════════ REPLACE the "one row ever" partial uniques (see note 4 above) ═══════════════════
DROP INDEX ux_pm_task_assignees_one_owner;
DROP INDEX ux_pm_task_assignees_one_responsible;

-- The ONE constraint that gives both non-overlap AND "at most one open row per role", exactly as
-- 0055_org_unit_memberships.sql's header documents for the unit axis. `role WITH =` scopes the
-- comparison so an owner interval never competes with a responsible interval on the same task; the
-- `WHERE` clause deliberately excludes 'contributor' (see the design judgement above).
ALTER TABLE pm_task_assignees ADD CONSTRAINT pm_task_assignees_no_overlap EXCLUDE USING gist (
  tenant_id WITH =, task_id WITH =, role WITH =,
  daterange(valid_from, COALESCE(valid_to, '9999-12-31'::date), '[]') WITH &&
) WHERE (role IN ('owner', 'responsible'));

-- As-of resolution support (fact-job.ts's owner/responsible-as-of-fact_date joins).
CREATE INDEX ix_pm_task_assignees_asof ON pm_task_assignees (tenant_id, task_id, role, valid_from, valid_to)
  WHERE role IN ('owner', 'responsible');

COMMENT ON TABLE pm_task_assignees IS
  'TR-01/TR-34 — relational task assignees (owner/responsible/contributor), owner/responsible now '
  'TIME-AWARE via valid_from/valid_to (TR-34, §15 ①): a reassignment closes the old interval and '
  'opens a new one rather than mutating in place, so a fact recomputed for a PAST date resolves to '
  'that date''s owner, never today''s. valid_to IS NULL = open/current. contributor rows are NOT '
  'interval-tracked (DELETE remains their whole lifecycle) — see this file''s design-judgement '
  'comment for why. The ONLY assignee source reporting/appraisal may read.';
COMMENT ON COLUMN pm_task_assignees.valid_from IS
  'TR-34 — interval start (inclusive). For owner/responsible, the day that value became true. For '
  'contributor, unused for interval semantics (set at row-creation time, never read as-of).';
COMMENT ON COLUMN pm_task_assignees.valid_to IS
  'TR-34 — interval end (inclusive), NULL = open/current. Only ever set for owner/responsible; a '
  'contributor row is deleted outright on removal, never closed.';
