-- 0088_webdev_change_requests.sql — maintenance intake (webdev D-7, MI-01).
-- Program: docs/superpowers/plans/2026-08-07-webdev-maintenance-intake-design.md §1.2
--
-- ── NUMBERING (migrations/README.md rule 5) ───────────────────────────────────────────────────────
-- `ls migrations | sort | tail` at write time showed head = 0087_pm_task_assignment_events.sql
-- (untracked, a concurrent PM session), so 0088 is next-unused. Re-verified immediately before
-- writing this file — no further collision. `0058`/`0059`/`0070` remain the permanently-orphaned
-- reservation gaps from earlier programs: do NOT fill them.
--
-- ── RLS WALL (D-2a, ratified 2026-08-07 — see design doc §1.1 and webdev-design.md §14) ──────────
-- This table takes the PLAIN CORE tenant wall (0075's shape), NOT the app_module_allowed('webdev')
-- third wall D-2 would otherwise assign to a webdev-private table. Cause: the client portal is the
-- table's primary writer, portal controllers are core and declare no module scope in the
-- app.scopes GUC, and app_module_allowed() is a two-sided handshake — a third-walled table would
-- read as zero rows, silently, on every portal query. Do NOT add a module column or an
-- app_module_allowed() clause here "for consistency"; that would reintroduce the exact failure
-- this decision exists to avoid. Estimates/rate-cards/QA-runs stay third-walled per D-2, unchanged.
--
-- No DML in this migration — a brand-new table, nothing to backfill, so the 0050 NOBYPASSRLS
-- backfill trap (migrations run as platform_owner without BYPASSRLS against FORCE-RLS tables) does
-- not apply.

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 0 · TENANT-SCOPED FOREIGN KEYS — composite UNIQUEs on the parents this table points at
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- Additive and cannot fail: `id` is each table's PK, so (id, tenant_id) is trivially unique.
-- `pm_tasks` already carries `ux_pm_tasks_id_tenant` (from 0054) — this no-ops for it and creates
-- the constraint fresh for `pipeline_runs` (verified: neither 0017 nor any later migration added
-- one for pipeline_runs before this file).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pipeline_runs', 'pm_tasks'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = format('ux_%s_id_tenant', t)) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT ux_%s_id_tenant UNIQUE (id, tenant_id)', t, t);
    END IF;
  END LOOP;
END $$;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 1 · webdev_change_requests
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE webdev_change_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  -- Which client asked. SERVER-DERIVED on the portal path (from the caller's resolved scope, never
  -- the body — 0075's "rule 1": a client cannot name their own client_id). Nullable only for
  -- source='internal' (staff logging internal maintenance), enforced by the CHECK below.
  client_id uuid,
  -- Optional narrowing to one project. Portal rule (design doc §5): a project-scoped contact MUST
  -- name one of their projects; only a client-wide contact may leave it NULL.
  project_id uuid,
  source text NOT NULL DEFAULT 'portal' CHECK (source IN ('portal','internal')),
  kind text NOT NULL CHECK (kind IN ('content','design','feature','bug')),
  title text NOT NULL,
  body text,
  -- Lifecycle (design doc §2.2): new → (declined | triaged → in_progress → done).
  status text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','triaged','in_progress','done','declined')),
  -- Set at triage. 'control_plane' is schema-admitted now but refused by the v1 convert endpoint
  -- (webdesk P4 does not exist yet) — see design doc §2.3.
  route text CHECK (route IN ('control_plane','mini_run','pm_task')),
  -- STRUCTURAL state machine, not controller discipline: a route exists exactly on the post-triage,
  -- non-declined statuses. (v1 declines only from 'new', so declined rows carry no route.)
  CONSTRAINT wcr_route_matches_status CHECK ((route IS NULL) = (status IN ('new','declined'))),
  -- A portal submission always has a requester and a client; collapsing that into controller
  -- discipline is how a "who asked this?" NULL appears in the triage queue a month later.
  CONSTRAINT wcr_portal_has_requester CHECK (
    source <> 'portal' OR (client_id IS NOT NULL AND requested_by IS NOT NULL)
  ),
  -- The spawned artifacts (exactly one, per route). Tenant-scoped composite FKs: an FK check runs as
  -- the table owner OUTSIDE RLS, so the two-column form is what actually guarantees same-tenant
  -- (0075 §0).
  pipeline_run_id uuid,
  pm_task_id uuid,
  triaged_by uuid REFERENCES users(id),
  triaged_at timestamptz,
  declined_reason text,
  -- The requester as a plain users FK (portal contacts ARE users rows, 0072; notify()/display need
  -- the user either way).
  requested_by uuid REFERENCES users(id),
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT fk_wcr_client_tenant   FOREIGN KEY (client_id, tenant_id)       REFERENCES clients (id, tenant_id),
  CONSTRAINT fk_wcr_project_tenant  FOREIGN KEY (project_id, tenant_id)      REFERENCES projects (id, tenant_id),
  CONSTRAINT fk_wcr_run_tenant      FOREIGN KEY (pipeline_run_id, tenant_id) REFERENCES pipeline_runs (id, tenant_id),
  CONSTRAINT fk_wcr_task_tenant     FOREIGN KEY (pm_task_id, tenant_id)      REFERENCES pm_tasks (id, tenant_id)
);

-- Portal list ("my client's requests") — the hot path.
CREATE INDEX ix_wcr_client  ON webdev_change_requests (tenant_id, client_id)  WHERE deleted_at IS NULL;
-- The triage queue (mirrors ix_invoice_payments_pending, 0075:235).
CREATE INDEX ix_wcr_new     ON webdev_change_requests (tenant_id, status)     WHERE status = 'new' AND deleted_at IS NULL;
CREATE INDEX ix_wcr_project ON webdev_change_requests (tenant_id, project_id) WHERE project_id IS NOT NULL AND deleted_at IS NULL;
-- "Requests I raised" (portal detail auth + my-requests filter).
CREATE INDEX ix_wcr_requester ON webdev_change_requests (tenant_id, requested_by) WHERE deleted_at IS NULL;

-- Trap: NULL defeats UNIQUE / ON CONFLICT (SQL NULLs are distinct — a plain UNIQUE on a nullable
-- column constrains nothing). Both backstops below are PARTIAL uniques over the non-null set, the
-- 0072:73–79 / 0075:148–153 house pattern.
-- One change request per spawned run — the schema half of the spawner's idempotency story (design
-- doc §3); the transition half is the advisory lock + precondition re-check (MI-03).
CREATE UNIQUE INDEX ux_wcr_run  ON webdev_change_requests (pipeline_run_id) WHERE pipeline_run_id IS NOT NULL;
CREATE UNIQUE INDEX ux_wcr_task ON webdev_change_requests (pm_task_id)      WHERE pm_task_id IS NOT NULL;

-- FORCE RLS, plain tenant wall — byte-identical to 0075's block (NULLIF hardening per 0025).
-- NO app_module_allowed() clause (D-2a, see header). NO principal_lookup policy either: unlike
-- client_contacts (0072 §7b), nothing reads this table during principal assembly — every read runs
-- under withTenants.
ALTER TABLE webdev_change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE webdev_change_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON webdev_change_requests;
CREATE POLICY tenant_isolation ON webdev_change_requests FOR ALL
  USING (tenant_id = ANY(string_to_array(NULLIF(current_setting('app.current_tenant_ids', true), ''), ',')::uuid[]))
  WITH CHECK (tenant_id = ANY(string_to_array(NULLIF(current_setting('app.current_tenant_ids', true), ''), ',')::uuid[]));
