-- TR-23 (Work Tracker / Reports / Appraisal program, §4 "0058" in the doc — STALE, see below) —
-- report_appraisal_cycles, report_appraisals, report_appraisal_acks: THE APPRAISAL SUBSTRATE +
-- THE THIRD RLS WALL for 'reports'. Schema + tests ONLY — the appraisal engine/endpoints (TR-24),
-- the Cerbos matrix (TR-25), and the UI (TR-26) are all explicitly out of scope for this file.
--
-- ─────────────────────────────── NUMBERING ───────────────────────────────
-- Claimed AT IMPLEMENTATION TIME per migrations/README.md rule 5 and the design doc's §15 PROCESS
-- RULE (never trust a number written in the doc/README/ticket brief without re-checking
-- `ls migrations | sort | tail` first). The doc says "0058" for this ticket; migrations/README.md's
-- own log already records that 0058/0059 are DELIBERATELY UNFILLED orphaned reservations (0058 was
-- reserved for this ticket but never drawn down before TR-08/TR-14 both rebased past it; 0059 was
-- consumed by TR-08 as 0057). `ls migrations | sort | tail` at the moment this file was authored
-- showed the real head as 0067_report_periods_documents.sql (TR-14, landed) with 0068 genuinely
-- free — no further rebase needed this time. Ship as 0068; record this in migrations/README.md
-- exactly as TR-01/TR-08/TR-14 did for their own rebases, and re-verify again if picking this
-- ticket up fresh finds 0068 already taken.
--
-- ─────────────────────────────── WHY THIS TICKET MATTERS MORE THAN A NORMAL SCHEMA TICKET ─────────
-- This opens P5 — appraisal — the most consequential surface in the whole program: these rows
-- describe real people's performance and will be used in real decisions about them. Two design
-- constraints carry ethical weight, not just correctness, and are enforced here at the schema
-- level rather than left to application-code discipline (§5.2 anti-gaming design, §11 privacy &
-- ethics, both in the design doc):
--   1. Mandatory human commentary — a CHECK, not app-code-only, so a commentary-free non-draft
--      appraisal is structurally impossible, not merely discouraged.
--   2. The acknowledgement trail is APPEND-ONLY — a subject's ack/dispute is evidence about a
--      conversation that happened; rewriting it later is falsifying a record. Enforced here with a
--      genuine BEFORE UPDATE/DELETE trigger (0026_service_layer.sql's freeze-trigger precedent,
--      generalised to "no mutation at all", not just "some columns frozen") — see the dedicated
--      note below on exactly what this does and does not cover.
--
-- ─────────────────────────────── WHAT THIS IS FOR ───────────────────────────────
--   report_appraisal_cycles — the admin-defined appraisal window + the weight config (default +
--     per-role overrides) that every appraisal generated under it freezes a COPY of.
--   report_appraisals       — one blended, manager-weighted appraisal per (cycle, subject). Scores
--     are manager-set 1-5 per axis; auto_inputs/weights are snapshotted at generate time so a later
--     config or metric change can never retroactively rewrite a person's score (§5.2 point 4/8).
--   report_appraisal_acks   — the append-only employee trail: acknowledge / dispute / comment /
--     reopen / finalize, one row per event, never mutated.
-- All three sit behind the SAME 'reports' module third wall 0056/0067 established — this migration
-- does not redefine app_module_allowed (CREATE OR REPLACE'd once in 0028, GRANT EXECUTE TO PUBLIC);
-- it only composes it into three more policies with mod='reports'.
--
-- ─────────────────────── RULINGS FROM §15 APPLIED (binding, not preference) ───────────────────────
-- (1) `origin_site text NOT NULL` with NO DEFAULT on all three tables (§15's 2026-07-30 ruling,
--     restated for every table in this program: a `DEFAULT 'central'` would silently mislabel a
--     site-originated row under the sync engine's site/central topology). The doc's own §4 DDL
--     block for these three tables still shows no explicit default either way for this program's
--     later tables, but per the ruling: every future writer (TR-24's generate/submit/ack endpoints)
--     MUST pass config.originSite explicitly.
-- (2) Composite-FK-to-tenant-scoped-parent rule (0027 precedent; restated and applied again by
--     TR-01/TR-03/TR-06/TR-14). Checked against every column in these three tables:
--       - `tenant_id -> companies(id)` (all three tables): companies IS the tenant identity table,
--         not a tenant-scoped CHILD of it — plain FK, same as every other table in this program.
--       - `created_by -> users(id)` (cycles), `subject_user_id`/`manager_user_id -> users(id)`
--         (appraisals), `actor_user_id -> users(id)` (acks): users is NOT tenant-scoped (confirmed
--         by every precedent migration in this program, incl. 0056/0067's own header) — plain FK.
--       - `cycle_id -> report_appraisal_cycles(id)` (report_appraisals): report_appraisal_cycles IS
--         a tenant-scoped CHILD of companies (its own FORCE-RLS'd third-wall table, created a few
--         statements above in THIS SAME file). APPLIES. Closed with the composite FK
--         `(cycle_id, tenant_id) REFERENCES report_appraisal_cycles (id, tenant_id) ON DELETE
--         CASCADE` — `report_appraisal_cycles` is brand-new in this file, so its
--         `UNIQUE (id, tenant_id)` is declared directly in the CREATE TABLE below (no retrofit ALTER
--         needed, unlike 0056's additive UNIQUE on the pre-existing `projects`).
--       - `appraisal_id -> report_appraisals(id)` (report_appraisal_acks): same class, same fix —
--         composite FK `(appraisal_id, tenant_id) REFERENCES report_appraisals (id, tenant_id) ON
--         DELETE CASCADE`, `UNIQUE (id, tenant_id)` declared directly on report_appraisals below.
--       - `period_id -> report_periods(id)` (report_appraisals) — see the DEDICATED note below;
--         this one is NOT a copy-paste of the standard pattern and deserves its own reasoning.
-- (3) No `*_node_id` / org-node columns appear in any of these three tables (0029 convention n/a
--     here — appraisals are person-scoped, not unit-scoped).
-- (4) Backfill / NOBYPASSRLS-role test rule: THIS MIGRATION SHIPS NO BACKFILL DML. All three tables
--     are freshly CREATE TABLE'd here with zero pre-existing rows — there is nothing for this
--     migration to backfill from (appraisal cycles/rows/acks are all created going forward only, by
--     TR-24's future engine). Per the brief: "if so, say so" — said here, and no NOBYPASSRLS-role
--     backfill test is shipped because there is no backfill to prove. A NOBYPASSRLS-role suite IS
--     shipped regardless (src/db/report-appraisals-rls.test.ts) — it proves the RLS walls, the
--     composite FKs, the mandatory-commentary CHECK, and the append-only trigger, not a backfill.
-- (5) No interval/validity columns are added by this migration (no EXCLUDE/valid_from pattern is
--     needed here — appraisals are one-row-per-(cycle,subject), not a history-of-intervals table
--     like 0063's pm_task_assignees), so the "pass valid_from explicitly in tests" rule does not
--     apply — noted only because the brief called it out as a standing rule to check.
--
-- ─────────────── DEDICATED NOTE — report_appraisals.period_id/revision: WHY NOT A PLAIN COPY OF
-- THE STANDARD "COMPOSITE FK TO THE CURRENT REVISION" PATTERN ───────────────────────────────────
-- The brief requires appraisals to "pin (period_id, revision)" via "a composite FK to
-- report_periods, so an appraisal can never silently follow a re-sealed period's new numbers." The
-- literal, most-obvious reading — `FOREIGN KEY (period_id, revision) REFERENCES report_periods
-- (id, revision)` — was deliberately REJECTED after working through what it would actually do:
-- `report_periods.revision` is a MUTABLE "current revision" pointer that TR-15's `sealPeriod`
-- bumps IN PLACE on every re-seal (`UPDATE report_periods SET revision = $3 ... WHERE id = $1`,
-- report-seal.ts). A NO-ACTION FK on (period_id, revision) against that mutable column would mean:
-- the MOMENT any report_appraisals row exists referencing (periodId, oldRevision), Postgres would
-- REFUSE that period's next re-seal outright (the UPDATE would orphan the referencing row) — but
-- §15/TR-24's own documented amend semantics are "amend of a pinned revision flips
-- evidence.stale and blocks FINALIZE until re-confirm", i.e. re-seal must SUCCEED; only the
-- appraisal's own finalize step is meant to be gated. An FK shaped this way would silently turn
-- every future re-seal-with-an-existing-appraisal into a hard 500, contradicting the exact
-- stale-flagging behaviour the ticket asks this schema to SUPPORT. (The alternative, ON UPDATE
-- CASCADE, is worse: it would silently rewrite the appraisal's pinned revision to follow the
-- period's new one — precisely the "silently follow a re-sealed period's new numbers" bug this
-- pin exists to prevent.)
-- What IS shipped instead, and what it actually proves:
--   - `period_id uuid NOT NULL` + a composite FK `(period_id, tenant_id) REFERENCES report_periods
--     (id, tenant_id)` (NO ON DELETE CASCADE — appraisal evidence should not vanish if a period row
--     were ever removed, though nothing in this program ever deletes one). This closes the SAME
--     cross-tenant-smuggling hole ruling (2) closes everywhere else: an appraisal cannot pin a
--     period belonging to a DIFFERENT tenant, proven by test below.
--   - `revision int NOT NULL CHECK (revision >= 0)` — the revision number pinned AT GENERATE TIME,
--     stored as a plain snapshot column, NOT itself FK-checked against report_periods' live
--     `revision` value. Comparing the stored pin against the period's CURRENT revision to decide
--     staleness is TR-24's job (the engine), not something a static FK constraint can express
--     without either blocking re-seals or silently defeating the pin, per the paragraph above.
--   - `evidence_stale boolean NOT NULL DEFAULT false` — a REAL, indexed, directly queryable column
--     (not only a value buried inside the `evidence` jsonb blob) so TR-24 has a first-class flag to
--     set when it detects `report_periods.revision <> report_appraisals.revision` for a pinned
--     period, per §15's "an amended revision must flag dependent appraisals evidence_stale" ruling.
--     `evidence jsonb` is kept alongside it (doc's own shape: `{periodIds:[...],
--     revisions:{...}, stale:false}`) for the richer multi-period detail a cycle spanning more than
--     one sealed calendar period may need — TR-24 populates both; this migration only provides the
--     columns.
-- HONEST STATEMENT OF WHAT THIS DOES NOT ENFORCE: nothing at the schema level stops TR-24's future
-- engine from generating an appraisal against an UNSEALED period, or from failing to flip
-- `evidence_stale` when a pinned period is later amended — both are TR-24's documented "Done when"
-- acceptance bars (generate rejects unsealed with 409; amend flips evidence.stale), enforced in
-- application code, not by this schema. This migration's guarantee is narrower and load-bearing in
-- its own right: the pin CANNOT silently cross a tenant boundary, and the columns TR-24 needs to
-- detect and record staleness genuinely exist.
--
-- ─────────────────────── DEDICATED NOTE — the append-only ack trail: what the trigger proves, and
-- what remains convention ───────────────────────────────────────────────────────────────────────
-- "No UPDATE path, no DELETE" is enforced with a genuine BEFORE UPDATE/BEFORE DELETE trigger that
-- unconditionally raises (generalising 0026_service_layer.sql's freeze-trigger precedent from
-- "some columns frozen" to "the whole row is frozen, permanently, from the moment it exists"). This
-- is real, DB-level enforcement, provable directly through the ordinary NOSUPERUSER/NOBYPASSRLS app
-- role in a test (unlike a REVOKE UPDATE/DELETE on the `platform_app` grant, which was considered
-- and rejected: the standard test harness (`initTestDb`) blanket-GRANTs SELECT/INSERT/UPDATE/DELETE
-- ON ALL TABLES to its OWN throwaway `platform_app_test` role AFTER migrations run, specifically so
-- ordinary suites don't have to fight per-table grants — a migration-level REVOKE against the real
-- `platform_app` role would be invisible to that role and untestable through the harness, and
-- `platform_app` does not even exist in a fresh test database, so a bare REVOKE would error there
-- outright unless IF-EXISTS-guarded like migrate.ts's RUNTIME_GRANTS_SQL does for sync tables. A
-- trigger fires for ANY role's ordinary DML regardless of table grants, so it is both stronger and
-- actually provable here.) What the trigger does NOT cover, stated plainly rather than implied:
--   - TRUNCATE does not fire per-row triggers (only statement-level ones, none are added here). This
--     is accepted as a non-issue in practice: `platform_app` is never granted TRUNCATE at all
--     (`infra/db/init-cluster.sh`'s `ALTER DEFAULT PRIVILEGES` grants only SELECT/INSERT/UPDATE/
--     DELETE), so the application can never reach a TRUNCATE on this table regardless.
--   - A superuser/owner connection COULD `ALTER TABLE ... DISABLE TRIGGER` or drop the trigger
--     entirely before mutating the table, or set `session_replication_role = replica` — i.e. this is
--     not proof against a hostile or compromised DBA-level actor, only against the application's own
--     normal write path (which is the threat model every other RLS/CHECK constraint in this program
--     already accepts implicitly). That residual is convention (operational discipline + migration
--     review), not a schema guarantee, and is stated here rather than left implicit.
DO $$
BEGIN
  IF current_setting('server_version_num')::int < 150000 THEN
    RAISE EXCEPTION
      'migration 0068 requires PostgreSQL 15+ (matches 0056''s own assertion); server_version_num = %',
      current_setting('server_version_num');
  END IF;
END $$;

-- ══ (1) report_appraisal_cycles — the admin-defined appraisal window + weight config.
CREATE TABLE report_appraisal_cycles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES companies(id),
  name            text NOT NULL,
  period_start    date NOT NULL,
  period_end      date NOT NULL CHECK (period_end >= period_start),
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','in_review','closed')),
  default_weights jsonb NOT NULL DEFAULT
    '{"delivery":0.35,"quality":0.30,"effort":0.10,"collaboration":0.25}',
  role_weights    jsonb NOT NULL DEFAULT '{}',    -- {"senior_dev":{"delivery":0.40,...}, ...}
  created_by      uuid NOT NULL REFERENCES users(id),
  origin_site     text NOT NULL,                  -- ruling (1): NO default
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- ruling (2): makes report_appraisal_cycles a valid composite-FK target for report_appraisals
  -- below. Declared directly here (brand-new table) rather than as a retrofit ALTER.
  CONSTRAINT ux_report_appraisal_cycles_id_tenant UNIQUE (id, tenant_id)
);

-- ══ (2) report_appraisals — one blended, manager-weighted appraisal per (cycle, subject).
CREATE TABLE report_appraisals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES companies(id),
  cycle_id        uuid NOT NULL,
  subject_user_id uuid NOT NULL REFERENCES users(id),
  manager_user_id uuid NOT NULL REFERENCES users(id),
  role_key        text,                         -- picks the weight set; NULL = cycle defaults
  weights         jsonb NOT NULL,                -- resolved weights FROZEN at generate time (§5.2.4)
  auto_inputs     jsonb NOT NULL DEFAULT '{}',   -- appraisal-safe metric values + cohort bands (frozen)
  scores          jsonb NOT NULL DEFAULT '{}',   -- {delivery:{auto:3,manager:4,note:"..."}, ...}
  composite       numeric(4,2),                  -- Sigma weight*manager-score, computed at submit
  commentary      text,                           -- MANDATORY for non-draft rows (CHECK below)
  evidence        jsonb NOT NULL DEFAULT '{}',   -- {periodIds:[...], revisions:{...}, stale:false}
  evidence_stale  boolean NOT NULL DEFAULT false, -- real, queryable flag — see the dedicated note above
  period_id       uuid NOT NULL,                  -- the sealed period this appraisal pins (see note above)
  revision        int  NOT NULL CHECK (revision >= 0), -- the pinned revision AT GENERATE TIME
  status          text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','submitted','acknowledged','disputed','finalized')),
  submitted_at    timestamptz,
  finalized_at    timestamptz,
  origin_site     text NOT NULL,                  -- ruling (1): NO default
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- the mandatory-commentary lock (§5.2.4's "blended, manager-weighted" decision, enforced by
  -- CHECK — not application code alone, so a commentary-free non-draft row is structurally
  -- impossible): every status OTHER than 'draft' requires a non-null, >=50-char (after trim)
  -- commentary. 'draft' rows (still being composed) are exempt.
  CONSTRAINT report_appraisals_commentary_required
    CHECK (status = 'draft' OR (commentary IS NOT NULL AND length(btrim(commentary)) >= 50)),
  UNIQUE (tenant_id, cycle_id, subject_user_id),
  -- ruling (2): makes report_appraisals a valid composite-FK target for report_appraisal_acks below.
  CONSTRAINT ux_report_appraisals_id_tenant UNIQUE (id, tenant_id),
  -- ruling (2): tenant-scoped composite FK — a report_appraisals row can never carry tenant A's
  -- tenant_id while cycle_id points at tenant B's cycle.
  CONSTRAINT fk_report_appraisals_cycle_tenant
    FOREIGN KEY (cycle_id, tenant_id) REFERENCES report_appraisal_cycles (id, tenant_id) ON DELETE CASCADE,
  -- the period pin (dedicated note above): tenant-safety only, deliberately NOT FK'd against
  -- report_periods' mutable `revision` column. No ON DELETE clause — nothing in this program ever
  -- deletes a report_periods row, and appraisal evidence should not vanish if that ever changed.
  CONSTRAINT fk_report_appraisals_period_tenant
    FOREIGN KEY (period_id, tenant_id) REFERENCES report_periods (id, tenant_id)
);

-- ══ (3) report_appraisal_acks — append-only employee trail (see the dedicated note above).
CREATE TABLE report_appraisal_acks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES companies(id),
  appraisal_id  uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  action        text NOT NULL CHECK (action IN ('acknowledged','disputed','comment','reopened','finalized')),
  comment       text,
  origin_site   text NOT NULL,                  -- ruling (1): NO default
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- ruling (2): tenant-scoped composite FK to report_appraisals.
  CONSTRAINT fk_report_appraisal_acks_appraisal_tenant
    FOREIGN KEY (appraisal_id, tenant_id) REFERENCES report_appraisals (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX ix_appraisal_acks ON report_appraisal_acks (tenant_id, appraisal_id, created_at);

-- ══ THE APPEND-ONLY ENFORCEMENT — genuine BEFORE UPDATE/DELETE triggers, not convention alone.
-- Generalises 0026_service_layer.sql's `service_assignments_freeze_identity` precedent (which
-- freezes only SOME columns) to "the entire row is frozen, unconditionally, forever" — the correct
-- shape for a trail whose whole purpose is being an immutable record of what someone said/did.
CREATE OR REPLACE FUNCTION report_appraisal_acks_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'report_appraisal_acks is append-only: % is not permitted (id=%)', TG_OP, OLD.id;
END $$;
CREATE TRIGGER trg_report_appraisal_acks_no_update
  BEFORE UPDATE ON report_appraisal_acks
  FOR EACH ROW EXECUTE FUNCTION report_appraisal_acks_append_only();
CREATE TRIGGER trg_report_appraisal_acks_no_delete
  BEFORE DELETE ON report_appraisal_acks
  FOR EACH ROW EXECUTE FUNCTION report_appraisal_acks_append_only();

-- ══ FORCE RLS + the ONE composed tenant_isolation policy per table — THE THIRD WALL for the
--    'reports' module. Byte-identical idiom to 0028_module_hr.sql's DO loop (mirrored again by
--    0056/0067 for this same module); app_module_allowed already exists globally (defined once in
--    0028, GRANT EXECUTE TO PUBLIC) and is reused here unmodified. Written once in a DO loop so the
--    third-wall predicate can never drift per-table — every report_appraisal_* table gets the same
--    `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('reports')`, on BOTH USING
--    (reads) and WITH CHECK (writes: you cannot INSERT a row without declaring the reports module
--    scope). Each table has a tenant_id column, so the rls.test.ts FORCE-RLS sweep covers all three
--    for free.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'report_appraisal_cycles','report_appraisals','report_appraisal_acks'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
         USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''reports''))
         WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''reports''))',
      t
    );
  END LOOP;
END $$;

COMMENT ON TABLE report_appraisal_cycles IS
  'TR-23 — the admin-defined appraisal window + weight config (default + per-role overrides). '
  'Every appraisal generated under a cycle freezes a COPY of the resolved weights (§5.2.4) — this '
  'table is the mutable config; report_appraisals.weights is the immutable snapshot. Third wall: '
  'reports module scope required.';
COMMENT ON TABLE report_appraisals IS
  'TR-23 — one blended, manager-weighted appraisal per (cycle, subject). Mandatory commentary '
  'enforced by CHECK for every non-draft status (§5.2.4). Pins (period_id, revision) at generate '
  'time — tenant-safety enforced by composite FK, staleness detection is TR-24''s engine (see this '
  'file''s dedicated note on why period_id/revision is NOT a live FK against report_periods'' '
  'mutable revision column). Third wall: reports module scope required.';
COMMENT ON TABLE report_appraisal_acks IS
  'TR-23 — the append-only employee acknowledgement/dispute trail. No UPDATE or DELETE path exists '
  '— enforced by a genuine BEFORE UPDATE/DELETE trigger (report_appraisal_acks_append_only), not '
  'convention alone. A subject''s ack/dispute is evidence about a conversation that happened; '
  'rewriting it later would be falsifying a record. Third wall: reports module scope required.';
