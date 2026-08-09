-- 0090_webdev_provisioned_sites.sql — PRV-01, the ERP-side mirror of a provision/webdesk-created
-- site+repo. Design: docs/blueprints/provision-erp-seam-design.md §05 (DDL sketch) + §04 (idempotency
-- + the 409 adopt-only-if-ours rule this schema exists to make safe).
--
-- ── NUMBERING (migrations/README.md rule 5) ─────────────────────────────────────────────────────────
-- `ls migrations | sort | tail` at authoring time showed the real head as
-- `0089_pm_dependency_enforcement.sql` (a concurrent PM session, already landed) with `0090` genuinely
-- free — re-verify with the same command before trusting that, exactly as every prior entry in that
-- file has had to. `0058`/`0059`/`0070` remain the permanently-orphaned reservation gaps from other
-- programs — not touched, not filled. This migration creates zero new tables that any other in-flight
-- session would plausibly also be creating (a fresh `webdev_provisioned_sites` name), so the risk here
-- is a taken NUMBER, not a taken TABLE name.
--
-- ── RLS WALL DECISION (D-2 THIRD WALL, not 0088's D-2a plain wall) ──────────────────────────────────
-- 0088 (`webdev_change_requests`) took the PLAIN core tenant wall specifically because the CLIENT
-- PORTAL is its primary writer, and portal controllers declare no module scope in `app.scopes` — a
-- third wall there would silently zero every portal read (the WD-23A-1 lesson).
--
-- THAT EXCEPTION DOES NOT APPLY HERE. Nothing portal-scoped or core-scoped ever touches
-- `webdev_provisioned_sites`: per the design (§04/§06), every access path — the provisioning POST, the
-- read GET, the reconcile POST, the poller, the reconcile n8n flow — runs inside the NEW `webdev`
-- ModuleContract shell (PRV-02), whose controllers are declared `@Controller("api/:tenantId/modules/
-- webdev")` behind `ModuleEnabledGuard` and call `withTenants(tenants, { modules: ['webdev'] })`
-- exactly like every other module (0028's hr_*, 0079's assistant_*). This table's primary writer is a
-- STAFF/AUTOMATION path (the run workspace's "Provision" action, or D14 executing the automation
-- principal's approved call) — not the portal — so the D-2a exception's own precondition ("the portal
-- writes it") is false, and the D-2 THIRD WALL is the correct default. The design doc's own §05 sketch
-- already calls this explicitly ("nothing portal- or core-scoped touches this one"); this migration
-- implements that call, not a fresh one.
--
-- `app_module_allowed(text)` was defined once in 0028 (CREATE OR REPLACE, GRANT EXECUTE TO PUBLIC) and
-- is only REFERENCED here, composed with `app_current_tenants()` (defined in 0025, itself NULLIF-
-- hardened) into one `tenant_isolation` policy per table — byte-identical shape to 0079's assistant_*
-- loop. Both wings of the handshake are asserted in the verification suite: right tenant WITHOUT the
-- `webdev` scope declared -> zero rows (not an error), and a DIFFERENT declared scope (e.g. 'hr') must
-- fail the same way, not just "unset" — the exact WD-23A-1 regression class.
--
-- ── NULLIF HARDENING (0025) ──────────────────────────────────────────────────────────────────────────
-- Not written out again here as raw SQL — `app_current_tenants()` and `app_module_allowed()` already
-- wrap their GUC reads in `NULLIF(current_setting(...,true), '')` (0025/0028's own bodies), so composing
-- them (rather than re-deriving the tenant/module arrays inline) inherits the hardening instead of
-- re-risking the `string_to_array('', ',') = ARRAY['']` cast-to-uuid[] trap this project has already
-- hit once.
--
-- ── COMPOSITE TENANT-SCOPED FK to pipeline_runs (0075 §0 standard) ──────────────────────────────────
-- `pipeline_runs` already carries `ux_pipeline_runs_id_tenant UNIQUE (id, tenant_id)` — added by 0088's
-- guarded DO block, which runs and commits before this migration (lower number, applied first by the
-- runner's lexicographic ordering) — so it is REUSED, not recreated, per the design sketch's own note.
-- An FK check runs as the table owner OUTSIDE RLS (0075 §0's point), so the two-column composite form
-- is what actually guarantees "a run this row points at belongs to the SAME tenant", not a plain
-- single-column FK.
--
-- ── DEVIATIONS FROM THE DESIGN'S LITERAL §05 SKETCH (flagged, not silently made) ─────────────────────
-- (1) `provider_ref` is NULLABLE here, not `NOT NULL` as the sketch literally wrote it. The design's own
--     §04 state machine requires this: ERP status flows `requested (pre-egress) -> pending ->
--     provisioned -> live`, and `requested` is explicitly PRE-EGRESS — the mirror row must be lockable
--     and insertable (to occupy the partial-unique slot and block a concurrent double-fire) BEFORE
--     provision's `POST /api/provision` has returned a `202 {id}` to correlate as `provider_ref`. §03
--     also states a hop failure can leave the row "stays requested if the failure precedes any
--     successful egress" and land `failed/egress_error` — both cases are consistent with `provider_ref`
--     never having been assigned. A literal NOT NULL would make the documented `requested` state
--     unrepresentable. Resolved with a structural CHECK (the 0088 `wcr_route_matches_status` idiom)
--     tying presence to status instead of controller discipline: `pending`/`provisioned`/`live` MUST
--     carry a `provider_ref` (egress is documented to have succeeded by then); `requested`/`failed` MAY
--     or may not (failed before vs. after a successful egress are "indistinguishable and safe" per §03,
--     so the schema does not force a distinction the design itself declines to make).
-- (2) Added `ux_wps_provider_ref` — a tenant-scoped partial-unique on `(tenant_id, provider_ref)` for
--     non-failed rows — beyond what the §05 sketch enumerated. The design's adopt-only-if-ours rule
--     (§04) is implemented in SERVICE code (PRV-02) as a lookup, not a constraint, but nothing in the
--     sketch stops a service bug from INSERTing a second live mirror row against a provider_ref an
--     existing row already tracks (as opposed to UPDATEing/adopting the existing one, which is the
--     documented flow). This index makes that bug a constraint violation instead of a silent duplicate,
--     at zero cost to the legitimate paths (adoption is an UPDATE on the existing row, never a second
--     INSERT). Flagged here because it is this migration's addition, not the design doc's.
-- (3) `failure_reason` stays free `text`, not a CHECK-enumerated set. §04's own listing
--     ("poll_timeout | slug_conflict_foreign | egress_error | ...") ends in an ellipsis — read as an
--     intentionally open, growable vocabulary (new failure modes are expected as the live leg (PRV-07)
--     is exercised), so constraining it here would need a follow-up migration for the first failure mode
--     nobody enumerated yet. Left as an application-typed token, same treatment as
--     `webdev_change_requests.declined_reason` (0088) and `assistant_messages.error_kind` (0079).
--
-- ── NULL DEFEATS UNIQUE / ON CONFLICT (the house trap, applied correctly here) ───────────────────────
-- Both partial-unique backstops below are over the NON-NULL, NON-FAILED subset — the 0072/0075/0088
-- house pattern for exactly this reason: a plain `UNIQUE (pipeline_run_id)` would let every off-pipeline
-- row (NULL `pipeline_run_id`, an explicitly supported case — "a site may be provisioned off-pipeline")
-- collide as "all NULLs are distinct, so nothing is actually constrained" in the WRONG direction (it
-- would look constrained and not be), while separately a naive `UNIQUE` with no partial predicate would
-- block a legitimate RETRY row after a `failed` attempt. The `WHERE ... AND status <> 'failed'`
-- predicate is what makes "many NULLs allowed, second live attempt refused, retry-after-failure allowed"
-- all three true at once.
--
-- ── ZERO BACKFILL DML ─────────────────────────────────────────────────────────────────────────────────
-- Brand-new table, CREATE TABLE only. No ALTER-with-default, UPDATE, DELETE-with-a-row-set, or
-- INSERT ... SELECT anywhere in this file — the 0050 NOBYPASSRLS-backfill-silently-no-ops trap
-- (migrations run as `platform_owner` WITHOUT BYPASSRLS against FORCE-RLS tables) has nothing to bite.
-- `npm run lint:migration-rls` has nothing to flag here by construction.

CREATE TABLE webdev_provisioned_sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  -- Nullable: a site may be provisioned off-pipeline (design §05 note; e.g. a future direct staff
  -- action with no run behind it). When set, the composite FK below is the tenancy guarantee.
  pipeline_run_id uuid,
  -- D-P2: the absorption seam. A column, not a redesign, so a future `WebdeskProvider` driver (webdesk
  -- P4) swaps behind the SAME table and the SAME tool name.
  provider text NOT NULL DEFAULT 'provision' CHECK (provider IN ('provision', 'webdesk')),
  -- provision's `projects.id` (or webdesk's future equivalent) — opaque correlation key, no cross-zone
  -- FK (provision's DB is a different trust zone, Zone B'; §03). See header deviation (1): nullable,
  -- state-tied by the CHECK below, not literally NOT NULL as the design's raw sketch wrote it.
  provider_ref text,
  -- Repo + hostname name. Grammar mirrors provision's own `^[a-z0-9-]+$` (provisionProject.ts:261) plus
  -- the ERP's `deriveRunSlug()` cap of 40 chars (design §04 D-P8).
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9-]{1,40}$'),
  -- v1 provider vocabulary only (design §04 D-P7); WordPress/full-stack are refused-with-routing before
  -- a row is ever written, never downgraded into one of these two values.
  framework text NOT NULL CHECK (framework IN ('vite', 'nextjs')),
  repo_url text,
  staging_url text,
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'pending', 'provisioned', 'live', 'failed')),
  -- See header deviation (1): only requested/failed may have a NULL provider_ref; every state that
  -- implies a successful egress must carry one.
  CONSTRAINT wps_provider_ref_present_once_egressed CHECK (
    status NOT IN ('pending', 'provisioned', 'live') OR provider_ref IS NOT NULL
  ),
  failure_reason text,
  requested_by uuid REFERENCES users(id),
  -- automation_approvals.id when WS4-pathed. Bare uuid, NO FK — mirrors assistant_tool_calls.approval_id
  -- (0079) exactly: automation_approvals carries no `UNIQUE (id, tenant_id)` today, so a composite FK
  -- is not available without a separate retrofit migration touching a live, unrelated table, and this
  -- column is attribution/audit only, never an access-control gate (RLS + the D14 registry precondition
  -- already are).
  approval_id uuid,
  last_reconciled_at timestamptz,
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ux_webdev_provisioned_sites_id_tenant UNIQUE (id, tenant_id),
  CONSTRAINT fk_wps_run_tenant FOREIGN KEY (pipeline_run_id, tenant_id)
    REFERENCES pipeline_runs (id, tenant_id)
);

-- The reconciler's scan (design §04's poll/backoff + the hourly `wd-provision-reconcile` flow).
CREATE INDEX ix_wps_nonterminal ON webdev_provisioned_sites (tenant_id, status)
  WHERE status IN ('requested', 'pending', 'provisioned');
-- "This run's site" (run-workspace card read).
CREATE INDEX ix_wps_run ON webdev_provisioned_sites (tenant_id, pipeline_run_id) WHERE pipeline_run_id IS NOT NULL;
-- The 409 adopt-only-if-ours lookup (design §04): find a row that already references this provider_ref.
-- Tenant-scoped, but note the SAFETY property this composes with RLS, not just an index: a query here
-- runs inside `withTenants([tenantId])`, so a `provider_ref` that belongs to a DIFFERENT ERP tenant's row
-- is invisible to this lookup even though provision's own project-name namespace is global (§04's
-- "adopt-only-if-ours" hazard) — the tenant wall is what makes "ours" a safe, non-leaking question to
-- ask, not application logic re-deriving it.
CREATE INDEX ix_wps_provider_ref ON webdev_provisioned_sites (tenant_id, provider_ref) WHERE provider_ref IS NOT NULL;

-- Idempotency, schema half (NULL defeats UNIQUE / ON CONFLICT — 0072/0075/0088 house pattern). Both
-- partial uniques are over the non-null, non-failed subset: many off-pipeline (NULL) rows are fine,
-- many retries-after-failure are fine, but only ONE live attempt may exist at a time per key.
--
-- Property 1 (task spec): a double-fire must not create two repos or two vhosts. This is the schema
-- half of that guarantee — the transition half (advisory lock + server-side precondition re-check) is
-- PRV-02's, in the D14 registry entry AND the endpoint, per the house rule that a lock without a
-- server-side re-check does nothing.
CREATE UNIQUE INDEX ux_wps_run ON webdev_provisioned_sites (pipeline_run_id)
  WHERE pipeline_run_id IS NOT NULL AND status <> 'failed';
CREATE UNIQUE INDEX ux_wps_slug ON webdev_provisioned_sites (tenant_id, slug)
  WHERE status <> 'failed';
-- Header deviation (2): the added provider_ref backstop (not in the design's literal sketch).
CREATE UNIQUE INDEX ux_wps_provider_ref ON webdev_provisioned_sites (tenant_id, provider_ref)
  WHERE provider_ref IS NOT NULL AND status <> 'failed';

COMMENT ON TABLE webdev_provisioned_sites IS
  'PRV-01: ERP-side mirror of one provision/webdesk-created site+repo (design '
  'docs/blueprints/provision-erp-seam-design.md). THIRD WALL RLS (app_module_allowed(''webdev'') + '
  'app_current_tenants()), NOT 0088''s plain wall — this table''s primary writer is the staff/automation '
  '`webdev` module path (PRV-02), never the client portal. provider_ref is nullable pre-egress (see this '
  'file''s header, deviation 1) and state-tied by wps_provider_ref_present_once_egressed. Two partial-'
  'unique backstops guarantee at most one LIVE (non-failed) attempt per pipeline_run_id and per '
  '(tenant_id, slug); a third (ux_wps_provider_ref, deviation 2) guards the same invariant for '
  '(tenant_id, provider_ref).';

-- FORCE RLS, THIRD WALL — composed tenant_isolation policy, byte-identical shape to 0079's assistant_*
-- loop (app_module_allowed defined once in 0028; app_current_tenants defined in 0025; both referenced,
-- not redefined, here).
ALTER TABLE webdev_provisioned_sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE webdev_provisioned_sites FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON webdev_provisioned_sites;
CREATE POLICY tenant_isolation ON webdev_provisioned_sites FOR ALL
  USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('webdev'))
  WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('webdev'));
