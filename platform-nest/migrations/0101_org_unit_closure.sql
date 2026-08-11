-- 0101 — IAM-09: the org-unit closure table (docs/superpowers/plans/2026-08-10-iam-hier-01-plan.md
-- §HIER-2 dependency; docs/superpowers/plans/2026-08-10-identity-rbac-program.md Phase 2, IAM-09 as
-- rewritten). Prerequisite for HIER-2's `org_unit_lead` subtree cascade — that ticket does NOT run
-- yet; this migration only builds and maintains the substrate it will read. No Cerbos policy, no
-- role, no `derived_roles.yaml` change here.
--
-- NUMBERING: claimed at implementation time per migrations/README.md rule 5. `ls migrations | sort
-- | tail` showed head = 0100_user_roles_org_unit_scope.sql with 0101 free; re-checked immediately
-- before writing this file (three other agents are working this checkout concurrently per the
-- ticket brief).
--
-- ═══════════════════════════ WHAT THIS TABLE IS ═══════════════════════════
-- One row per (tenant, ancestor node id, descendant node id), with the tree-distance between them.
-- Keyed on free-form TEXT node ids — 0100 widened `user_roles.scope_id` `uuid` -> `text` for
-- exactly this reason (org-unit node ids are `'d-hr'`/`'dv-web'`-shaped per the 0029/0055
-- convention, never uuids) — so this table speaks the SAME id vocabulary as `user_roles`,
-- `org_unit_memberships.unit_node_id`, and `company_org_structure`'s own blob, with no
-- text<->uuid translation seam anywhere in the chain.
--
-- SELF-INCLUSIVE AT DEPTH 0 (a node is its own ancestor). Deliberate, documented in
-- src/core/org-unit-closure.ts's header: HIER-2's own Cerbos condition
-- (`g.scopeId in request.resource.attr.unitAncestors`) must match a grant scoped directly AT the
-- resource's own unit, not only at a strict ancestor above it.
--
-- SCOPE: every node in the org-blob tree (holding/company/department/division/role/person), not
-- filtered to "department"/"division" kind. See src/core/org-unit-closure.ts's header for why a
-- kind-filtered closure would risk drifting from either consumer (person-scope.ts's own,
-- independent `UNIT_KINDS` boundary; the unrestricted `org_unit` scope shape CHECK). Harmless: a
-- grant is only ever minted at a node someone chose to grant leadership over.
--
-- ═══════════════════════════ HOW IT STAYS CORRECT ═══════════════════════════
-- Rebuilt WHOLESALE (DELETE + re-INSERT, not an incremental diff) on every org-blob PUT, inside the
-- SAME transaction as the blob write (company-admin.controller.ts::putOrg calls
-- src/core/org-unit-closure.ts's rebuildOrgUnitClosure() immediately after its existing
-- sweepMemberships() call, before the transaction commits) — so the closure can never disagree
-- with the tree it describes, a node MOVED updates every affected ancestor path (there is nothing
-- incremental to get wrong), and a node DELETED leaves no orphan rows (nothing stale survives a
-- full rebuild). Re-running the rebuild against an unchanged tree is a pure function of that tree,
-- so it is idempotent by construction — no ON CONFLICT needed on that path (DELETE always runs
-- first).
--
-- Two hot queries, both indexed (see below):
--   1. "all ancestors of node N" — what a RESOURCE carries so an org_unit_lead grant can match it
--      (`WHERE tenant_id = $1 AND descendant_id = $2`).
--   2. "all descendants of node N" — the subtree a GRANT at node N covers
--      (`WHERE tenant_id = $1 AND ancestor_id = $2`).
--
-- CROSS-TENANT ISOLATION: node ids are free-form text, NOT globally unique — two tenants can both
-- use `'d-hr'` (the ticket brief calls this out as the most likely real bug). Every column, every
-- index, and the PRIMARY KEY itself lead with `tenant_id`, and FORCE RLS is applied below — no
-- query against this table can silently cross a tenant boundary, whether by a missing WHERE clause
-- or by a missing GUC (the latter yields ZERO rows, per the standard app_current_tenants() policy,
-- not another tenant's rows).
CREATE TABLE org_unit_closure (
  tenant_id      uuid NOT NULL REFERENCES companies(id),
  ancestor_id    text NOT NULL,
  descendant_id  text NOT NULL,
  depth          int  NOT NULL CHECK (depth >= 0),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, ancestor_id, descendant_id)
);

COMMENT ON TABLE org_unit_closure IS
  'IAM-09 — ancestor/descendant/depth closure over company_org_structure''s tree, keyed on '
  'free-form text node ids. Rebuilt wholesale, transactionally, on every org-blob PUT '
  '(company-admin.controller.ts::putOrg) via src/core/org-unit-closure.ts''s pure '
  'computeOrgUnitClosure(). Self-inclusive at depth 0. Load-bearing for HIER-2''s (not yet built) '
  'org_unit_lead subtree cascade: a resource''s unitAncestors = every ancestor_id WHERE '
  'descendant_id = the resource''s own unit node id.';

-- Hot query 1: "all ancestors of node N" — WHERE tenant_id = $1 AND descendant_id = $2, ordered
-- nearest-first. The PRIMARY KEY's leading columns (tenant_id, ancestor_id, ...) do NOT serve this
-- shape (descendant_id is not a prefix column), so a dedicated index is required.
CREATE INDEX ix_org_unit_closure_ancestors ON org_unit_closure (tenant_id, descendant_id, depth);

-- Hot query 2: "all descendants of node N" — WHERE tenant_id = $1 AND ancestor_id = $2. Served by
-- the PRIMARY KEY's own leading columns as a covering leftmost prefix; no separate index needed.

-- FORCE RLS + the standard tenant_isolation policy off the 0025 app_current_tenants() helper —
-- same wall as org_units (0026) / org_unit_memberships (0055) / company_org_structure. Per-company
-- data with a text key that is NOT globally unique (see header) — this is the wall that makes a
-- cross-tenant node_id collision structurally impossible to read or write through, regardless of
-- application-layer bugs.
ALTER TABLE org_unit_closure ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_unit_closure FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON org_unit_closure FOR ALL
  USING (tenant_id = ANY(app_current_tenants()))
  WITH CHECK (tenant_id = ANY(app_current_tenants()));

-- ═══════════════════════════════ BACKFILL (2 companies, per the live scan) ═══════════════════════
-- ⚠ THE RLS ZERO-ROW TRAP (memory `migration-backfill-rls-trap`; confirmed bug class:
-- 0050_pm_short_codes.sql). Migrations run as `platform_owner` (MIGRATE_DATABASE_URL), which has
-- NEITHER BYPASSRLS NOR an ambient `app.current_tenant_ids` GUC. `company_org_structure` carries
-- FORCE ROW LEVEL SECURITY gated on that GUC (0011) — an unguarded read here would silently match
-- ZERO rows, backfill ZERO closures, raise NO error, and still record as applied. `lint:migration-
-- rls` does NOT catch this: its DML scan flags UPDATE/DELETE/INSERT-SELECT statements whose TARGET
-- table is pre-existing and FORCE-RLS'd, but the risk here is on `company_org_structure`, the
-- SOURCE of this block's INSERT-SELECT, not `org_unit_closure` (created fresh in this same file,
-- hence exempt) — the same "not lint-enforced, guarded by inspection" posture 0055's own header
-- documents for its own backfill. Guarded identically: `set_config('app.current_tenant_ids', ...,
-- true)` PER TENANT, inside this DO block's transaction, before touching company_org_structure.
--
-- WHAT IT DOES: mirrors src/core/org-unit-closure.ts's `computeOrgUnitClosure()` in plain SQL — a
-- recursive walk of the saved JSONB tree tracking, for every node, the full id-chain from the
-- tree's root down to it, then emitting one (ancestor, descendant, depth) row per chain prefix
-- (self-inclusive, depth 0 included). Deduplicated by MIN(depth) per (ancestor, descendant) pair —
-- the identical deterministic "nearest wins" tie-break the TS function uses for a malformed tree
-- that repeats an id, so the migration-time and runtime computations can never disagree on a
-- well-formed tree and degrade the same way on a malformed one.
DO $$
DECLARE
  co         RECORD;
  blob       RECORD;
  n_tenants  int := 0;
  n_rows     int := 0;
  rows_this  int;
BEGIN
  FOR co IN SELECT id FROM companies ORDER BY id LOOP
    -- SET LOCAL semantics (is_local = true): scoped to THIS migration's transaction, the same
    -- mechanism src/db/index.ts withTenants() uses for every ordinary request.
    PERFORM set_config('app.current_tenant_ids', co.id::text, true);

    SELECT structure INTO blob FROM company_org_structure WHERE tenant_id = co.id;
    IF NOT FOUND THEN
      CONTINUE; -- no org structure saved for this tenant yet -> nothing to backfill
    END IF;

    WITH RECURSIVE tree(node, chain) AS (
      SELECT (blob.structure -> 'root'), ARRAY[(blob.structure -> 'root') ->> 'id']
      UNION ALL
      SELECT c.child, t.chain || (c.child ->> 'id')
        FROM tree t
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(t.node -> 'children', '[]'::jsonb)) AS c(child)
    ),
    pairs AS (
      SELECT t.chain[i] AS ancestor_id, t.node ->> 'id' AS descendant_id,
             array_length(t.chain, 1) - i AS depth
        FROM tree t, generate_subscripts(t.chain, 1) AS i
    ),
    dedup AS (
      SELECT ancestor_id, descendant_id, MIN(depth) AS depth
        FROM pairs
       WHERE ancestor_id IS NOT NULL AND descendant_id IS NOT NULL
       GROUP BY ancestor_id, descendant_id
    )
    INSERT INTO org_unit_closure (tenant_id, ancestor_id, descendant_id, depth)
    SELECT co.id, ancestor_id, descendant_id, depth FROM dedup
    ON CONFLICT DO NOTHING;

    GET DIAGNOSTICS rows_this = ROW_COUNT;
    n_tenants := n_tenants + 1;
    n_rows := n_rows + rows_this;
  END LOOP;

  -- Asserted, not assumed, per the ticket brief's explicit trap warning: this NOTICE is read by
  -- the migration-time operator AND cross-checked by a live test
  -- (src/db/org-unit-closure.test.ts's NOBYPASSRLS-role re-run of this exact block, which asserts
  -- a non-zero row count rather than trusting this message alone).
  RAISE NOTICE
    'org_unit_closure backfill: % tenant(s) with a saved org blob, % closure row(s) inserted',
    n_tenants, n_rows;
END $$;
