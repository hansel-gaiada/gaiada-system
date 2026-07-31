-- TR-03 (Work Tracker / Reports / Appraisal program, §3.2 "Blocker 2") —
-- org_unit_memberships: time-aware person<->org-unit membership, the substrate server-side
-- department resolution (TR-04) resolves against for an as-of date, replacing the FE-only,
-- today-only placement lookup in `platform-ui/src/lib/departments.ts`.
--
-- ─────────────────────────── NUMBERING ───────────────────────────
-- Claimed AT IMPLEMENTATION TIME per migrations/README.md rule 5 and the doc's §15 PROCESS RULE
-- (never trust the number written in the doc/README without re-checking `ls migrations | tail`).
-- `ls migrations` showed head = 0054_pm_task_assignees.sql (TR-01, merged) with 0055 still free —
-- the doc's and README's `0055` reservation held this time, no further rebase needed. If a later
-- ticket in this program finds 0055 taken, the same rule applies to it: take the next free slot and
-- record the rebase in migrations/README.md, exactly as TR-01 did for 0050->0054.
--
-- ─────────────────────────── WHAT THIS TABLE IS FOR ───────────────────────────
-- One row per (person, unit) validity interval. `valid_to IS NULL` = the currently-open row. A
-- transfer NEVER rewrites history: the old row is closed (valid_to set) and a new row is opened —
-- so a report for last month keeps resolving to last month's department forever, even after the
-- person has since moved elsewhere (TR-04 owns writing that sweep; this migration only lays the
-- table + the one-time backfill). `is_primary` distinguishes the ONE membership that counts for
-- outcome attribution (§3.2 precedence step ②) from any number of secondary, non-primary
-- memberships (e.g. a committee, a temporary loan) that must never compete with it for the overlap
-- guarantee below — non-primary rows are free to overlap each other and the primary row.
--
-- `unit_node_id` is a free-form org-node id (0029 convention: org-node ids are not a database
-- table). `org_units` (0026) stays the LAZY relational anchor for a unit's name/kind; it is never
-- authoritative for placement — this table is. No FK here, same posture as
-- `pm_task_assignees.assignee_ref` for unit rows and `projects.department_id`.
--
-- ─────────────────────── RULINGS FROM §15 APPLIED (binding, not preference) ───────────────────────
-- (1) `origin_site text NOT NULL` with NO DEFAULT. The doc's own §4 convention paragraph still
--     reads "DEFAULT 'central'" for 0055-0059 (not yet rewritten there — see the README's note that
--     it, not the doc, is authoritative on numbers; the same applies to this ruling); §15's later
--     amendment overrides that for every table in the 0055-0059 range (0054 alone keeps its
--     default, deliberately, since it had already merged). This table's backfill inherits
--     origin_site from its SOURCE row (`company_org_structure.origin_site`) rather than the
--     tenant's own `companies.origin_site` — see the backfill block — so declaring NO default costs
--     the backfill nothing, and it forces TR-04's sweeper to pass `config.originSite` explicitly on
--     every non-backfill write, exactly as the ruling intends (a site-originated membership must
--     never silently mislabel itself 'central').
-- (2) Composite-FK-to-tenant-scoped-parent rule (0027 precedent, restated by TR-01's fix #2 on
--     `pm_task_assignees.task_id`): CHECKED against every column here and found NOT APPLICABLE.
--     `tenant_id -> companies(id)` is the tenant-identity FK every table has — `companies` IS the
--     tenant, not a tenant-scoped CHILD of it, so it needs no guard (same as every other table's
--     plain `tenant_id REFERENCES companies(id)`). `user_id -> users(id)` and
--     `created_by -> users(id)` reference `users`, which the ticket brief explicitly confirms is
--     NOT tenant-scoped, so both stay plain single-column FKs. `unit_node_id` carries NO FK at all
--     (see above) — there is no tenant-scoped parent table for a foreign tenant's row to hide
--     behind. Net: zero columns in this table needed the composite-FK treatment; nothing to change.
-- (3) The backfill ships a NOBYPASSRLS-role test (`src/db/org-unit-memberships.test.ts`) that
--     re-executes THIS FILE's own backfill DO block, parsed verbatim, through the app's
--     NOSUPERUSER/NOBYPASSRLS pool with NO tenant GUC set, and asserts a non-zero row count — the
--     only guard that would have caught the 0050_pm_short_codes.sql bug class (§15's amendment
--     log; `initTestDb()` runs `migrate()` as the superuser, which bypasses RLS, so a silently
--     no-op backfill still passes a normal test run).
--
-- ─────────────────────── btree_gist (the §15 "open verification item") ───────────────────────
-- No migration in this repo has ever run CREATE EXTENSION before this one. btree_gist has been
-- `trusted` since PG13, so a non-superuser role with CREATE on the target schema can install it
-- without ever being superuser. `platform_owner` (NOSUPERUSER NOBYPASSRLS per
-- infra/db/init-cluster.sh) is the DATABASE OWNER of gaiada_platform, and on PG15+ (this stack runs
-- PG17) the `public` schema is owned by the `pg_database_owner` pseudo-role, which resolves to
-- whoever owns the current database — so `platform_owner` owns `public` transitively and has
-- CREATE there without any extra grant. PROVEN, not assumed, per the brief: a fresh throwaway
-- database owned by `platform_owner`, migrated end-to-end via `MIGRATE_DATABASE_URL` pointed at
-- `platform_owner` (NOT the test harness's superuser role), applied this file's
-- `CREATE EXTENSION IF NOT EXISTS btree_gist` and the rest of the migration successfully — see the
-- ticket report (TR-03, senior-db) for the exact command and output.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE org_unit_memberships (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES companies(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  unit_node_id text NOT NULL,                  -- org-node id (NO FK, 0029 convention)
  is_primary   boolean NOT NULL DEFAULT true,
  valid_from   date NOT NULL,
  valid_to     date,                            -- NULL = open/current
  source       text NOT NULL DEFAULT 'org_blob' CHECK (source IN ('org_blob','manual','backfill')),
  origin_site  text NOT NULL,                   -- ruling (1) above: NO default
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT org_unit_memberships_valid_range
    CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT org_unit_memberships_unit_nonempty
    CHECK (length(unit_node_id) > 0),

  -- DB-ENFORCED non-overlap for PRIMARY memberships only: no two open-or-closed primary intervals
  -- for the same (tenant, person) may share a single day, from ANY session, including a future bug
  -- in TR-04's sweeper. `COALESCE(valid_to, '9999-12-31')` folds the open-row case into the same
  -- range-overlap check (two NULL-valid_to rows both collapse onto '...-9999-12-31' and therefore
  -- always overlap each other), so "at most one currently-open primary per person" falls out of
  -- this ONE constraint for free — no separate partial-unique index is needed for that half.
  CONSTRAINT org_unit_memberships_no_overlap EXCLUDE USING gist (
    tenant_id WITH =, user_id WITH =,
    daterange(valid_from, COALESCE(valid_to, '9999-12-31'::date), '[]') WITH &&
  ) WHERE (is_primary)
);

-- As-of resolution (TR-04's precedence step ②: "person's primary membership as of date D").
CREATE INDEX ix_oum_asof ON org_unit_memberships (tenant_id, user_id, valid_from, valid_to);
-- Unit-grain reads (dept rollups: who is CURRENTLY placed in this unit).
CREATE INDEX ix_oum_unit ON org_unit_memberships (tenant_id, unit_node_id) WHERE valid_to IS NULL;

-- FORCE RLS + the plain tenant_isolation policy off the 0025 app_current_tenants() helper — this is
-- org CORE, the same wall as org_units (0026) and pm_task_assignees (0054), NOT the
-- app_module_allowed() third wall (reserved for the report_* tables, 0056+).
DO $$
BEGIN
  EXECUTE 'ALTER TABLE org_unit_memberships ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE org_unit_memberships FORCE ROW LEVEL SECURITY';
  EXECUTE
    'CREATE POLICY tenant_isolation ON org_unit_memberships FOR ALL
       USING (tenant_id = ANY(app_current_tenants()))
       WITH CHECK (tenant_id = ANY(app_current_tenants()))';
END $$;

COMMENT ON TABLE org_unit_memberships IS
  'TR-03 — time-aware person<->org-unit membership, as-of resolution substrate for server-side '
  'department attribution (§3.2). is_primary: the ONE membership counted for outcome attribution '
  '(EXCLUDE-enforced non-overlap); non-primary rows may freely overlap. valid_to IS NULL = open/'
  'current. unit_node_id is a free-form org-node id (no FK, 0029) — the nearest department/division '
  'ancestor of the person in company_org_structure at the time the row was written.';

-- ═════════════════════════════════ BACKFILL ═════════════════════════════════
-- WHY THE PER-TENANT set_config WRAPPER IS MANDATORY (not defensive style): migrations run as
-- platform_owner (MIGRATE_DATABASE_URL), which deliberately does NOT have BYPASSRLS (db-topology
-- role split, 2026-07-15). `company_org_structure` carries FORCE ROW LEVEL SECURITY, gated on
-- `tenant_id = ANY(app_current_tenants())`, which reads the app.current_tenant_ids GUC — UNSET
-- during a migration run. Unset -> NULL -> `= ANY(NULL)` is NULL (falsy) for every row, so an
-- unguarded read of company_org_structure here would silently see ZERO rows, insert ZERO
-- memberships, raise NO error, and still be recorded in schema_migrations as applied — exactly the
-- confirmed 0050_pm_short_codes.sql bug class (§15's amendment log). The guard below is therefore
-- load-bearing and NOT lint-enforced (`lint:migration-rls`'s `createdHere` carve-out only reasons
-- about DML whose TARGET table is created in the same migration; the risk here is on the SOURCE
-- side, `company_org_structure`, which pre-exists since 0011); org-unit-memberships.test.ts proves
-- it empirically by re-running this exact block through a NOBYPASSRLS role with no ambient tenant
-- context and asserting a non-zero row count.
--
-- WHAT IT DOES: for each tenant with a saved org-structure blob, walk the OrgNode tree
-- (`{id, name, kind, assigneeId, children}`, platform-ui/src/lib/org.ts) tracking the NEAREST
-- ancestor of kind 'department' or 'division' (the only two kinds org_units/0026 recognises as a
-- "unit" — 'role' and 'company'/'holding' are structural, not units), and for every 'person' node
-- that carries a resolvable assigneeId, opens ONE primary membership row dated
-- `LEAST(company.created_at::date, that person's earliest work_activity.occurred_at::date)` — a
-- documented one-time approximation (pre-adoption history resolves to the CURRENT unit; amendable
-- by manual rows per §13). `LEAST(x, NULL)` in Postgres ignores the NULL argument rather than
-- propagating it, so a person with no work_activity evidence yet simply falls back to the company's
-- own creation date, which is the correct default.
--
-- DEFENSIVE PERSON-REF RESOLUTION (mirrors 0054's fix #1, restated by §15 as binding for every
-- migration in this program): `assigneeId` is app-validated only as a non-empty string, NEVER as a
-- uuid or a real users row. Concretely, `platform-ui/src/lib/org.ts`'s OWN seeded default structure
-- carries placeholder assignees like "u-dev"/"u-pm" — not uuids at all. A backfill that blindly
-- cast assigneeId::uuid or trusted it to exist would ABORT THE WHOLE MIGRATION on the very first
-- non-conforming tenant. This backfill therefore resolves each assigneeId defensively (uuid-shaped
-- AND present in `users`) and SKIPS what it cannot represent — never inventing a person, never
-- erroring the transaction.
--
-- DEDUP: if the same assigneeId appears more than once in one tenant's tree (a malformed or
-- legacy blob — the intended shape has each person placed once), `DISTINCT ON` keeps exactly one
-- placement, chosen by the lexicographically smallest unit_node_id — an arbitrary but FULLY
-- DETERMINISTIC tie-break (matters for the idempotency test: a second backfill pass must pick the
-- SAME row every time), so "exactly one open primary row per placed person" holds even on a
-- malformed source blob.
--
-- IDEMPOTENCY: `ON CONFLICT DO NOTHING` with no target catches ANY constraint violation on this
-- table, including the EXCLUDE constraint (Postgres: an unqualified ON CONFLICT DO NOTHING is not
-- limited to unique-index arbiters) — so a second pass, which would try to insert the identical
-- (tenant, user, date-range) row again, is silently absorbed rather than erroring.
DO $$
DECLARE
  co         RECORD;
  blob       RECORD;
  m          RECORD;
  person_uid uuid;
  n_found    int := 0;
  n_inserted int := 0;
  n_skipped  int := 0;
  uuid_re    text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
BEGIN
  FOR co IN SELECT id, created_at FROM companies ORDER BY id LOOP
    -- SET LOCAL semantics (is_local = true): scoped to THIS migration's transaction, the same
    -- mechanism src/db/index.ts withTenants() uses for every ordinary request.
    PERFORM set_config('app.current_tenant_ids', co.id::text, true);

    SELECT structure, origin_site INTO blob FROM company_org_structure WHERE tenant_id = co.id;
    IF NOT FOUND THEN
      CONTINUE; -- no org structure saved for this tenant yet -> nothing to backfill
    END IF;

    FOR m IN
      WITH RECURSIVE walk(node, unit_node_id) AS (
        SELECT blob.structure -> 'root', NULL::text
        UNION ALL
        SELECT
          child,
          CASE WHEN walk.node ->> 'kind' IN ('department', 'division')
               THEN walk.node ->> 'id'
               ELSE walk.unit_node_id
          END
        FROM walk, jsonb_array_elements(COALESCE(walk.node -> 'children', '[]'::jsonb)) AS child
      )
      SELECT DISTINCT ON (node ->> 'assigneeId')
        node ->> 'assigneeId' AS assignee_id,
        unit_node_id
      FROM walk
      WHERE node ->> 'kind' = 'person'
        AND node ->> 'assigneeId' IS NOT NULL
        AND unit_node_id IS NOT NULL   -- person has no department/division ancestor -> unrepresentable
      ORDER BY node ->> 'assigneeId', unit_node_id
    LOOP
      n_found := n_found + 1;
      person_uid := NULL;

      IF m.assignee_id ~ uuid_re THEN
        SELECT u.id INTO person_uid FROM users u WHERE u.id = m.assignee_id::uuid;
      END IF;

      IF person_uid IS NOT NULL THEN
        INSERT INTO org_unit_memberships
          (tenant_id, user_id, unit_node_id, is_primary, valid_from, valid_to, source, origin_site)
        VALUES (
          co.id, person_uid, m.unit_node_id, true,
          LEAST(
            co.created_at::date,
            (SELECT MIN(w.occurred_at)::date FROM work_activity w
              WHERE w.tenant_id = co.id AND w.actor_user_id = person_uid)
          ),
          NULL, 'backfill', blob.origin_site
        )
        ON CONFLICT DO NOTHING;
        n_inserted := n_inserted + 1;
      ELSE
        -- Unrepresentable assignee (not uuid-shaped, or uuid-shaped but no such users row) —
        -- counted and reported, never guessed at.
        n_skipped := n_skipped + 1;
      END IF;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'org_unit_memberships backfill: % placed person(s) found, % row(s) inserted, % unrepresentable assignee(s) skipped',
    n_found, n_inserted, n_skipped;
END $$;
