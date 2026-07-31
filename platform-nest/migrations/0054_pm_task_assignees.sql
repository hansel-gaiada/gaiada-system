-- TR-01 (Work Tracker / Reports / Appraisal program, §3.1 "Blocker 1") —
-- relational task assignees beside the existing `pm_tasks.assignee` JSONB blob.
--
-- ─────────────────────────── NUMBERING: 0050 -> 0054 REBASE ───────────────────────────
-- The design doc (docs/blueprints/tracker-reporting-foundation.md §4) reserves 0050–0055 for this
-- program and names this file `0050_pm_task_assignees.sql`. That reservation was drawn from a
-- ledger head of 0049. By the time TR-01 was executed, 0050–0053 had ALL been consumed out of band
-- (0050_pm_short_codes.sql, 0051_pm_short_codes_backfill_fix.sql, 0052_pipeline_stage_idempotency.sql,
-- 0053_search_provider_incurred_cost.sql). Per migrations/README.md rule 5 ("the second to merge
-- bumps to the following free slot") and rule 3 (duplicate prefixes are FORBIDDEN), this ticket
-- takes 0054 and the rest of the program's block rebases by +4: TR-03 org_unit_memberships -> 0055,
-- TR-06 reports core -> 0056, report_periods/report_documents -> 0057, appraisal -> 0058,
-- metric seeds -> 0059. Recorded in migrations/README.md rule 2.
--
-- ─────────────────────────── WHAT THIS TABLE IS FOR ───────────────────────────
-- `pm_tasks.assignee` (0018) is a single unindexed JSONB blob
-- {kind, refId, refName, responsibleId, responsibleName}: no multi-assignee, a unit-assigned task
-- has no person, and person-grain SQL over JSONB is not trustworthy. This table is the relational
-- substrate every downstream report/appraisal number is computed from. Role semantics (closed set):
--
--   owner        exactly ONE per task (partial unique). The outcome-credit target. May be a person
--                OR a unit (department/division) — mirrors the blob's kind/refId.
--   responsible  at most ONE per task (partial unique), ALWAYS a person — mirrors the blob's
--                responsibleId ("the person in charge; AI delivers here"). Present even when the
--                owner is a unit; that is how a unit-owned task still attributes to a person
--                (§3.1 attribution table row 2) without inventing a person that isn't there.
--   contributor  zero or more, always persons. NEW capability (TR-02 exposes the API). Listed with
--                logged hours; NEVER outcome-credited.
--
-- The blob stays authoritative for FE reads in v1. TR-02 adds the dual-write; TR-07 adds the drift
-- guard; the authority flip is explicitly out of scope. Reporting reads ONLY this table.
--
-- ─────────────────────── DEVIATIONS FROM THE DOC'S §4 DDL (all deliberate) ───────────────────────
-- Flagged for architect review. The doc's DDL block was authoritative; these are corrections to it,
-- not preference changes.
--
-- (1) SECURITY — tenant-scoped COMPOSITE FK on task_id, not the doc's single-column
--     `REFERENCES pm_tasks(id)`. A single-column FK only proves the task id exists SOMEWHERE:
--     Postgres FK referential-integrity checks are enforced by an internal system trigger that is
--     NOT subject to row security on the referenced table, so a bug or a future write path could
--     construct a pm_task_assignees row whose tenant_id is tenant A while its task_id belongs to
--     tenant B — and no RLS-scoped SELECT would catch it (under withTenants([A]) the mismatched
--     task's real owner is simply invisible, indistinguishable from "does not exist"). On the
--     substrate that every outcome credit, every dept rollup and every appraisal number is derived
--     from, that is cross-tenant attribution smuggling. Closed exactly as ORG-3 closed the same
--     class on service_assignments.unit_id (0027_service_assignment_unit_guard.sql): a composite FK
--     (task_id, tenant_id) -> pm_tasks(id, tenant_id), which needs the additive composite UNIQUE on
--     pm_tasks below. Zero new roles, zero new BYPASSRLS surface, enforced from ANY session.
--
-- (2) INTEGRITY — added `pm_task_assignees_ref_matches_user`: for person rows assignee_ref must
--     equal user_id::text. Without it a person row carries TWO independent representations of the
--     same person and nothing stops them disagreeing — the exact dual-source-of-truth failure this
--     whole table exists to eliminate. NOTE FOR TR-02: pass `user_id::text` (canonical lowercase
--     hyphenated uuid) as assignee_ref for person rows, not the raw blob string; a non-canonical
--     uuid spelling fails LOUDLY here rather than silently forking attribution.
--
-- (3) ROBUSTNESS — the doc's backfill says "for each pm_tasks row with a non-null blob -> insert
--     owner row". Implemented literally that ABORTS THE MIGRATION on live data. `validAssignee()`
--     (pm.controller.ts:297) validates only that refId/responsibleId are non-empty STRINGS — never
--     that they are uuids, never that they reference a real user. A person-kind blob whose refId is
--     not a well-formed uuid raises invalid input syntax; one that is a uuid but not a users(id)
--     raises an FK violation. Either kills the whole migration transaction. This backfill therefore
--     RESOLVES person refs defensively (uuid-shaped AND present in users) and SKIPS what it cannot
--     represent, reporting the skip count via RAISE NOTICE instead of failing or, worse, inventing
--     a person. Soft-deleted users are deliberately NOT filtered out — historical attribution to a
--     since-departed employee is the correct answer, and the FK is still satisfied.
--
-- (4) `updated_at` added per the house convention for tenant tables (the doc's block had only
--     created_at); TR-02's upsert path wants it.
--
-- (5) The doc's second CHECK was written as
--     `CHECK (role IN ('responsible','contributor') IS NOT TRUE OR assignee_kind = 'person')`.
--     That parses and is logically correct, but is rewritten below as the equivalent, legible
--     `role = 'owner' OR assignee_kind = 'person'` (role is NOT NULL and CHECKed to the three-value
--     set, so the two are identical). No semantic change.
--
-- Kept from the doc as-is: `origin_site text NOT NULL DEFAULT 'central'` (the doc's §4 convention
-- paragraph states it for all six of this program's migrations, so the block stays internally
-- consistent — note it differs from the pm_* precedent of 0036/0038/0040/0041/0043/0044, which
-- declare origin_site NOT NULL with NO default and force the app to pass config.originSite);
-- org-node ids as free-form text with NO FK (0029 convention — org nodes are a JSONB blob, not a
-- table); PLAIN tenant policy off app_current_tenants(), NOT the app_module_allowed() third wall,
-- because this is pm_* substrate like every other pm_* table.

-- Composite UNIQUE so pm_tasks can be the target of the two-column FK below (Postgres requires the
-- referenced columns to be covered by a UNIQUE or PRIMARY KEY). Redundant with the PK on id alone,
-- so it CANNOT fail on existing data — the standard tenant-scoped-foreign-key pattern (0027).
ALTER TABLE pm_tasks ADD CONSTRAINT ux_pm_tasks_id_tenant UNIQUE (id, tenant_id);

CREATE TABLE pm_task_assignees (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES companies(id),
  task_id       uuid NOT NULL,               -- composite FK to pm_tasks(id, tenant_id) below
  role          text NOT NULL CHECK (role IN ('owner','responsible','contributor')),
  assignee_kind text NOT NULL CHECK (assignee_kind IN ('person','department','division')),
  assignee_ref  text NOT NULL,               -- user_id::text when person; org-node id when unit (NO FK, 0029)
  user_id       uuid REFERENCES users(id),   -- resolved person (NULL for unit rows)
  created_by    uuid REFERENCES users(id),   -- NULL for backfilled rows (no attributable actor)
  origin_site   text NOT NULL DEFAULT 'central',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- person rows carry a resolved user; unit rows never do
  CONSTRAINT pm_task_assignees_person_user
    CHECK ((assignee_kind = 'person') = (user_id IS NOT NULL)),
  -- responsible/contributor are ALWAYS persons; only owner may be a unit
  CONSTRAINT pm_task_assignees_person_role
    CHECK (role = 'owner' OR assignee_kind = 'person'),
  -- deviation (2): one representation of a person per row, never two that can drift
  CONSTRAINT pm_task_assignees_ref_matches_user
    CHECK (assignee_kind <> 'person' OR assignee_ref = user_id::text),
  CONSTRAINT pm_task_assignees_ref_nonempty
    CHECK (length(assignee_ref) > 0),

  -- the ON CONFLICT DO NOTHING idempotency key for the backfill and for TR-02's dual-write
  CONSTRAINT ux_pm_task_assignees_row
    UNIQUE (tenant_id, task_id, role, assignee_kind, assignee_ref),
  -- deviation (1): tenant-scoped composite FK, NOT `REFERENCES pm_tasks(id)`
  CONSTRAINT fk_pm_task_assignees_task_tenant
    FOREIGN KEY (task_id, tenant_id) REFERENCES pm_tasks (id, tenant_id) ON DELETE CASCADE
);

-- The two cardinality invariants. ux_pm_task_assignees_row alone does NOT enforce them (it includes
-- assignee_ref, so two DIFFERENT owners on one task would pass it) — these partial uniques do.
CREATE UNIQUE INDEX ux_pm_task_assignees_one_owner
  ON pm_task_assignees (tenant_id, task_id) WHERE role = 'owner';
CREATE UNIQUE INDEX ux_pm_task_assignees_one_responsible
  ON pm_task_assignees (tenant_id, task_id) WHERE role = 'responsible';

-- Person-grain reporting (every metric keyed on "this person's tasks in this tenant, by role").
CREATE INDEX ix_pm_task_assignees_person ON pm_task_assignees (tenant_id, user_id, role);
-- Unit-grain reporting (dept/division owner rollups).
CREATE INDEX ix_pm_task_assignees_unit ON pm_task_assignees (tenant_id, assignee_ref)
  WHERE assignee_kind <> 'person';
-- No separate (tenant_id, task_id) index: ux_pm_task_assignees_row leads with exactly those two
-- columns, so the per-task read path and the FK's ON DELETE CASCADE both use it.

-- FORCE RLS + the plain tenant_isolation policy off the 0025 app_current_tenants() helper — byte
-- identical to every pm_* table since 0036/0038/0040/0041/0043. Enabled BEFORE the backfill on
-- purpose, so the backfill below exercises the same row-security path production writes will.
DO $$
BEGIN
  EXECUTE 'ALTER TABLE pm_task_assignees ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE pm_task_assignees FORCE ROW LEVEL SECURITY';
  EXECUTE
    'CREATE POLICY tenant_isolation ON pm_task_assignees FOR ALL
       USING (tenant_id = ANY(app_current_tenants()))
       WITH CHECK (tenant_id = ANY(app_current_tenants()))';
END $$;

COMMENT ON TABLE pm_task_assignees IS
  'TR-01 — relational task assignees (owner/responsible/contributor). The ONLY assignee source '
  'reporting/appraisal may read; pm_tasks.assignee remains the FE-facing blob in v1 and is kept in '
  'sync by TR-02 dual-write. owner: exactly one, person or unit. responsible: at most one, always a '
  'person. contributor: 0..n persons, never outcome-credited.';

-- ═════════════════════════════════ BACKFILL ═════════════════════════════════
-- WHY THE PER-TENANT set_config WRAPPER IS MANDATORY (not defensive style):
-- migrations run as platform_owner (MIGRATE_DATABASE_URL), which deliberately does NOT have
-- BYPASSRLS (db-topology role split, 2026-07-15; rolbypassrls = false, verified live). pm_tasks
-- carries FORCE ROW LEVEL SECURITY, and its policy gates every row on
-- `tenant_id = ANY(app_current_tenants())`, which reads the app.current_tenant_ids GUC — UNSET
-- during a migration run. Unset -> NULL -> `= ANY(NULL)` is NULL (falsy) for every row, so an
-- unguarded `INSERT INTO ... SELECT ... FROM pm_tasks` here would insert ZERO rows, raise NO error,
-- and still be recorded in schema_migrations as applied. That is not hypothetical: it is exactly
-- what 0050_pm_short_codes.sql did on the live dev DB, fixed by 0051_pm_short_codes_backfill_fix.sql
-- and now guarded by `npm run lint:migration-rls`.
--
-- WORTH FLAGGING: that lint would NOT have caught this file. Its `createdHere` carve-out skips any
-- DML whose TARGET table is CREATE TABLE'd in the same migration (correctly reasoning such a table
-- has zero pre-existing rows) — but the silent-no-op risk here is on the SOURCE side of the
-- INSERT...SELECT (pm_tasks, force-RLS'd since 0018/0025), which the lint does not model. The
-- guard below is therefore load-bearing and NOT lint-enforced; pm-task-assignees.test.ts proves it
-- empirically by re-running this block through a NOBYPASSRLS role with no ambient tenant context
-- and asserting a NON-ZERO row count.
--
-- IDEMPOTENCY: every insert is ON CONFLICT DO NOTHING against ux_pm_task_assignees_row (and the two
-- partial uniques — a bare ON CONFLICT DO NOTHING covers ALL unique indexes on the table, so a
-- second pass that would produce a DIFFERENT owner is also a silent no-op rather than an error).
-- The block reads no state it also mutates, so a second pass is a true no-op: identical rows, same
-- ids, same timestamps.
--
-- SUPERUSER-SAFE TOO: the inner SELECT filters `tenant_id = co.id` explicitly rather than relying
-- on RLS to scope it. Under a BYPASSRLS role (the test harness runs migrate() as superuser) an
-- RLS-only filter would return EVERY tenant's tasks on EVERY outer iteration — still correct,
-- because tenant_id is taken from the task row, but O(tenants x tasks). The explicit predicate makes
-- the block behave identically under both privilege models.
DO $$
DECLARE
  co           RECORD;
  t            RECORD;
  owner_user   uuid;
  resp_user    uuid;
  n_owner      int := 0;
  n_resp       int := 0;
  n_skipped    int := 0;
  -- canonical uuid text; anything else in refId/responsibleId is unrepresentable (see deviation 3)
  uuid_re      text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
BEGIN
  FOR co IN SELECT id FROM companies ORDER BY id LOOP
    -- SET LOCAL semantics (is_local = true): scoped to THIS migration's transaction, the same
    -- mechanism src/db/index.ts withTenants() uses for every ordinary request.
    PERFORM set_config('app.current_tenant_ids', co.id::text, true);

    FOR t IN
      SELECT id, tenant_id, origin_site,
             assignee->>'kind'          AS kind,
             assignee->>'refId'         AS ref_id,
             assignee->>'responsibleId' AS responsible_id
      FROM pm_tasks
      WHERE tenant_id = co.id
        AND assignee IS NOT NULL
        AND jsonb_typeof(assignee) = 'object'
      ORDER BY created_at, id
    LOOP
      owner_user := NULL;
      resp_user  := NULL;

      -- Resolve the owner ref to a real user ONLY for person-kind blobs.
      IF t.kind = 'person' AND t.ref_id ~ uuid_re THEN
        SELECT u.id INTO owner_user FROM users u WHERE u.id = t.ref_id::uuid;
      END IF;
      -- Resolve the responsible ref (always a person by contract) independently.
      IF t.responsible_id ~ uuid_re THEN
        SELECT u.id INTO resp_user FROM users u WHERE u.id = t.responsible_id::uuid;
      END IF;

      -- ── owner row ──
      IF t.kind IN ('department', 'division') AND coalesce(t.ref_id, '') <> '' THEN
        -- Unit owner: NO person is invented. Person-grain credit comes from the responsible row
        -- below (or is simply absent when there is none) — §3.1 attribution table rows 2 and 3.
        INSERT INTO pm_task_assignees
          (tenant_id, task_id, role, assignee_kind, assignee_ref, user_id, origin_site)
        VALUES (t.tenant_id, t.id, 'owner', t.kind, t.ref_id, NULL, t.origin_site)
        ON CONFLICT DO NOTHING;
        n_owner := n_owner + 1;
      ELSIF t.kind = 'person' AND owner_user IS NOT NULL THEN
        -- assignee_ref is the CANONICAL uuid text, satisfying pm_task_assignees_ref_matches_user.
        INSERT INTO pm_task_assignees
          (tenant_id, task_id, role, assignee_kind, assignee_ref, user_id, origin_site)
        VALUES (t.tenant_id, t.id, 'owner', 'person', owner_user::text, owner_user, t.origin_site)
        ON CONFLICT DO NOTHING;
        n_owner := n_owner + 1;
      ELSE
        -- Unrepresentable owner (missing/blank kind, unknown kind, or a person ref that is not a
        -- uuid / not a users row). Counted and reported, never guessed at.
        n_skipped := n_skipped + 1;
      END IF;

      -- ── responsible row ──
      -- Per §3.1: insert when responsibleId resolves to a real person AND is not already
      -- represented by a person-owner row for that same person.
      IF resp_user IS NOT NULL AND NOT (owner_user IS NOT NULL AND owner_user = resp_user) THEN
        INSERT INTO pm_task_assignees
          (tenant_id, task_id, role, assignee_kind, assignee_ref, user_id, origin_site)
        VALUES (t.tenant_id, t.id, 'responsible', 'person', resp_user::text, resp_user, t.origin_site)
        ON CONFLICT DO NOTHING;
        n_resp := n_resp + 1;
      END IF;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'pm_task_assignees backfill: % owner row(s), % responsible row(s), % unrepresentable owner blob(s) skipped',
    n_owner, n_resp, n_skipped;
END $$;
