-- P4-B1/B2 (PM Repsona Parity Phase 4, workstream B — Ball = assignee, renamed, §1.5 of
-- 2026-08-04-pm-repsona-parity-phase4-plan.md) — the assignment-history LEDGER beside the existing
-- `pm_tasks.assignee` field.
--
-- ─────────────────────────── WHAT THIS IS, AND WHAT IT IS NOT ───────────────────────────
-- The plan's §1.5 resolves the "Ball" gap NOT as a new axis (Ball IS `assignee.refId`/`kind`,
-- Responsible IS `assignee.responsibleId` — both already exist), but as a missing HISTORY: passing
-- the ball must not erase the previous holder. So this migration adds ONE append-only table and
-- nothing else — no denormalised "current holder" column (pm_tasks.assignee already is that), no
-- change to pm_task_assignees (0054/0063 — that table is the reporting/appraisal SUBSTRATE with its
-- own interval semantics; this one is a human-readable EVENT LOG of every assignee write, kept
-- deliberately separate per decision 7 in the plan: "should feed those, not become a fourth parallel
-- record" — contributors/work_activity feeds are a follow-up ticket, not this one).
--
-- ─────────────────────────── NUMBERING ───────────────────────────
-- Claimed AT IMPLEMENTATION TIME per migrations/README.md rule 5. `ls migrations | sort | tail`
-- showed the real head as `0086_assistant_thread_title_backfill.sql` with `0087` genuinely free (the
-- ticket brief's own number, `0078`, was stale — `0078`-`0086` were all already taken by concurrent
-- sessions by the time this was authored). `0058`/`0059`/`0070` remain the permanently-orphaned
-- reservation gaps noted throughout this file's history — not touched here.
--
-- ─────────────────────────── DEVIATIONS FROM THE TICKET'S LITERAL COLUMN LIST (documented, not
-- silent — same discipline as 0054's "deviations from the doc's DDL" header) ───────────────────────
-- (1) NAMING — the ticket's column list writes `company_id`; every existing pm_* table (0018, 0036,
--     0038, 0040, 0041, 0043, 0044, 0054, 0063) names that column `tenant_id`, and every helper this
--     table's RLS policy and every application query depends on (`withTenants`, `app_current_tenants()`)
--     is written against `tenant_id`. Renaming to `company_id` here would be a one-table island in a
--     module that is otherwise perfectly consistent. Kept as `tenant_id`.
-- (2) RLS WALL — the ticket text says "RLS + the app_module_allowed two-sided handshake apply". That
--     handshake is real (0028) but is NOT how any pm_* table is gated — 0054's own header is explicit:
--     "PLAIN tenant policy off app_current_tenants(), NOT the app_module_allowed() third wall, because
--     this is pm_* substrate like every other pm_* table." This table is pm_* substrate too (a
--     sibling of pm_task_assignees, sharing its FK target), so it gets the SAME plain tenant_isolation
--     policy as 0054/0063/0036/0038/0040/0041/0043/0044 — not the reports/mail/assistant third wall.
-- (3) APPEND-ONLY ENFORCEMENT — the ticket says "the runtime role must get INSERT+SELECT but NOT
--     UPDATE/DELETE" (i.e. a GRANT-level REVOKE). 0068_report_appraisals.sql already worked through
--     this exact trade-off for report_appraisal_acks and rejected the REVOKE approach: the test
--     harness's `platform_app_test` role gets a blanket SELECT/INSERT/UPDATE/DELETE grant on ALL
--     TABLES *after* migrations run (so ordinary suites don't fight per-table grants), which makes a
--     migration-level REVOKE against the real `platform_app` role invisible to the test role — and
--     `platform_app` does not even exist in a fresh test DB, so a bare REVOKE errors there outright.
--     A genuine BEFORE UPDATE/BEFORE DELETE trigger that unconditionally raises is real DB-level
--     enforcement, provable through the ordinary NOSUPERUSER/NOBYPASSRLS app role in a test, and is
--     what is shipped here — same precedent as 0068, generalising 0026's freeze-trigger from "some
--     columns frozen" to "the whole row is frozen, permanently, from the moment it exists". See that
--     file's "DEDICATED NOTE" for the honest statement of what a trigger does NOT cover (TRUNCATE,
--     and a superuser dropping/disabling the trigger) — the same residual applies here and is
--     accepted for the same reason: it is convention/operational discipline against a hostile
--     DBA-level actor, not a schema guarantee, exactly like every other constraint in this program.
--
-- ─────────────────────────── SHAPE ───────────────────────────
--   ref_id / ref_kind   — the BALL at the moment of this event: assignee.refId / assignee.kind.
--                         Both NULL together when the ball was cleared (assignee set to null).
--   responsible_id      — the RESPONSIBLE person at the moment of this event: assignee.responsibleId.
--                         Independent of ref_id/ref_kind (nullable on its own), though in practice
--                         `validAssignee()` (pm.controller.ts) only ever produces an Assignee with
--                         BOTH populated or neither.
--   status_id           — the task's status AT THE MOMENT OF HANDOFF (plan §1.5: "each ball event
--                         records the status at the moment of handoff"). text, NOT NULL, NO FK — same
--                         reason pm_tasks.status has none (0038): statuses are synth-on-read, and a
--                         project that never materialized its registry has no pm_project_statuses
--                         rows to FK against at all.
--   note                — optional free-text reason, e.g. a correction ("wrong queue, reassigning").
--   changed_by          — the actor, NULL for a system-derived event with no attributable human (the
--                         same "NULL for backfilled rows" convention as 0054's created_by).
CREATE TABLE pm_task_assignment_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES companies(id),
  task_id        uuid NOT NULL,          -- composite FK to pm_tasks(id, tenant_id) below
  ref_id         text,                   -- ball: person uuid text, or a unit org-node id; NULL = cleared
  ref_kind       text CHECK (ref_kind IN ('person', 'department', 'division')),
  responsible_id uuid REFERENCES users(id),
  status_id      text NOT NULL,
  note           text,
  changed_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),

  -- ref_id and ref_kind are always populated together (mirrors Assignee's own shape: either the
  -- whole blob is null, or refId+kind are both set) — never a ball with no kind or vice versa.
  CONSTRAINT pm_task_assignment_events_ref_pair
    CHECK ((ref_id IS NULL) = (ref_kind IS NULL)),
  CONSTRAINT pm_task_assignment_events_ref_nonempty
    CHECK (ref_id IS NULL OR length(ref_id) > 0),
  -- SECURITY — tenant-scoped COMPOSITE FK, not a bare `REFERENCES pm_tasks(id)`: identical reasoning
  -- to 0054 deviation (1) — a single-column FK only proves the task id exists SOMEWHERE (FK checks
  -- bypass row security on the referenced table), which on a cross-tenant-attribution-sensitive
  -- ledger is exactly the smuggling hole ORG-3/TR-01 closed for their own tables. Reuses the
  -- `ux_pm_tasks_id_tenant` unique constraint 0054 already added for this same purpose.
  CONSTRAINT fk_pm_task_assignment_events_task_tenant
    FOREIGN KEY (task_id, tenant_id) REFERENCES pm_tasks (id, tenant_id) ON DELETE CASCADE
);

-- Per the ticket: "(company_id, task_id, created_at DESC)" and "(company_id, ref_id)" — tenant_id
-- per deviation (1) above.
CREATE INDEX ix_pm_task_assignment_events_task ON pm_task_assignment_events (tenant_id, task_id, created_at DESC);
CREATE INDEX ix_pm_task_assignment_events_ref ON pm_task_assignment_events (tenant_id, ref_id) WHERE ref_id IS NOT NULL;

-- ══ APPEND-ONLY ENFORCEMENT — see deviation (3) above. ══
CREATE OR REPLACE FUNCTION pm_task_assignment_events_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'pm_task_assignment_events is append-only: % is not permitted (id=%)', TG_OP, OLD.id;
END $$;
CREATE TRIGGER trg_pm_task_assignment_events_no_update
  BEFORE UPDATE ON pm_task_assignment_events
  FOR EACH ROW EXECUTE FUNCTION pm_task_assignment_events_append_only();
CREATE TRIGGER trg_pm_task_assignment_events_no_delete
  BEFORE DELETE ON pm_task_assignment_events
  FOR EACH ROW EXECUTE FUNCTION pm_task_assignment_events_append_only();

-- FORCE RLS + the plain tenant_isolation policy off app_current_tenants() — see deviation (2) above.
-- Byte-identical idiom to 0054/0063.
DO $$
BEGIN
  EXECUTE 'ALTER TABLE pm_task_assignment_events ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE pm_task_assignment_events FORCE ROW LEVEL SECURITY';
  EXECUTE
    'CREATE POLICY tenant_isolation ON pm_task_assignment_events FOR ALL
       USING (tenant_id = ANY(app_current_tenants()))
       WITH CHECK (tenant_id = ANY(app_current_tenants()))';
END $$;

COMMENT ON TABLE pm_task_assignment_events IS
  'P4-B1 — append-only assignment/ball history beside pm_tasks.assignee. One row per write that '
  'changed the ball (assignee.refId/kind) or responsible (assignee.responsibleId), recording the '
  'task''s status at the moment of handoff. NEVER updated or deleted (trigger-enforced) — a '
  'correction is a NEW row, never a mutation of an old one. pm_tasks.assignee remains the ONLY '
  'current-holder source; this table is history only, read via GET '
  '/api/:t/pm/tasks/:id/assignment-history.';

-- ═════════════════════════════════ BACKFILL (P4-B2) ═════════════════════════════════
-- Seeds ONE history row per EXISTING task that already has a non-null assignee blob, so a task
-- assigned before this migration does not read as "never assigned" the moment the UI starts
-- rendering the chain. Dated from the task's own `created_at` (same "Done when" bar 0063 used for
-- its own owner/responsible backfill) — the genuine assignment TIME is unknown, and the task's own
-- creation is the least-wrong proxy available. `changed_by` is NULL (unattributable, same convention
-- as 0054's `created_by`); `note` records that this row is synthetic, not a real write-path event.
--
-- WHY THE PER-TENANT set_config WRAPPER IS MANDATORY (not defensive style) — identical reasoning to
-- 0054/0063: migrations run as platform_owner (MIGRATE_DATABASE_URL), which does NOT have BYPASSRLS.
-- `pm_tasks` carries FORCE ROW LEVEL SECURITY (0018/0025) gating every row on
-- `tenant_id = ANY(app_current_tenants())`, reading the `app.current_tenant_ids` GUC — UNSET during a
-- migration run. Unset -> NULL -> `= ANY(NULL)` is NULL (falsy) for every row, so an unguarded
-- `SELECT ... FROM pm_tasks` here would see ZERO rows, insert ZERO history rows, raise NO error, and
-- still be recorded in schema_migrations as applied — the confirmed 0050_pm_short_codes.sql bug
-- class. The guard below is therefore load-bearing.
--
-- WORTH FLAGGING (same as 0054's own note): `npm run lint:migration-rls` would NOT catch a missing
-- guard here even without it — its `createdHere` carve-out skips DML whose TARGET table
-- (pm_task_assignment_events) is CREATE TABLE'd in this same file, but the silent-no-op risk is on
-- the SOURCE side of the SELECT (pm_tasks), which the lint does not model. The guard below is
-- included anyway, and pm-assignment-events.test.ts proves it empirically the same way
-- pm-task-assignees.test.ts does for 0054: re-running this exact block through a NOBYPASSRLS role
-- with no ambient tenant context and asserting a NON-ZERO row count.
--
-- IDEMPOTENCY: guarded by a NOT EXISTS against this exact table, so a second run of this migration
-- (impossible in practice — ledger-keyed — but exercised directly by the test above) inserts nothing
-- new. SUPERUSER-SAFE: the inner SELECT filters `tenant_id = co.id` explicitly rather than relying on
-- RLS to scope it (same "behaves identically under both privilege models" reasoning as 0054).
DO $$
DECLARE
  co        RECORD;
  t         RECORD;
  resp_user uuid;
  n_seeded  int := 0;
  n_skipped int := 0;
  uuid_re   text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
BEGIN
  FOR co IN SELECT id FROM companies ORDER BY id LOOP
    -- SET LOCAL semantics (is_local = true): scoped to THIS migration's transaction, the same
    -- mechanism src/db/index.ts withTenants() uses for every ordinary request.
    PERFORM set_config('app.current_tenant_ids', co.id::text, true);

    FOR t IN
      SELECT id, tenant_id, status, created_at,
             assignee->>'kind'          AS kind,
             assignee->>'refId'         AS ref_id,
             assignee->>'responsibleId' AS responsible_id
      FROM pm_tasks
      WHERE tenant_id = co.id
        AND deleted_at IS NULL
        AND assignee IS NOT NULL
        AND jsonb_typeof(assignee) = 'object'
        AND NOT EXISTS (
          SELECT 1 FROM pm_task_assignment_events e
          WHERE e.tenant_id = co.id AND e.task_id = pm_tasks.id
        )
      ORDER BY created_at, id
    LOOP
      -- Defensive resolution, same posture as 0054: an unrepresentable ref (not uuid-shaped for a
      -- person kind) is skipped rather than guessed at, and never aborts the whole migration.
      resp_user := NULL;
      IF t.responsible_id ~ uuid_re THEN
        SELECT u.id INTO resp_user FROM users u WHERE u.id = t.responsible_id::uuid;
      END IF;

      IF t.kind = 'person' AND NOT (t.ref_id ~ uuid_re) THEN
        n_skipped := n_skipped + 1;
        CONTINUE;
      END IF;

      INSERT INTO pm_task_assignment_events
        (tenant_id, task_id, ref_id, ref_kind, responsible_id, status_id, note, changed_by, created_at)
      VALUES (
        t.tenant_id, t.id, t.ref_id, t.kind,
        resp_user, -- NULL when unresolvable; the ref_id/kind pair is still recorded either way
        t.status, 'backfill: pre-existing assignment (migration 0087)', NULL, t.created_at
      );
      n_seeded := n_seeded + 1;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'pm_task_assignment_events backfill: % row(s) seeded, % unrepresentable ref(s) skipped',
    n_seeded, n_skipped;
END $$;
