-- ORG-CORE ORG-2 — the shared-services relational layer (as amended by §2 A2/A3/A8/A12/A16).
--
-- Renumbered from 0024 by WS0-1 (2026-07-22) — see 0025 header + migrations/README.md.
--
-- Two new tables (org_units, service_assignments) + the claims junction (service_grant_claims) +
-- provenance columns (kind/managed_by) on the existing access tables + the hr role seed. DORMANT:
-- no code reads these in this ticket; the reconciler/controllers arrive in ORG-6/ORG-7. Composes
-- every policy from app_current_tenants() (0025). No sync_app grants — none of these tables sync in
-- v1 (central-authoritative metadata, like site_subscriptions).
--
-- Binding red-team amendments encoded here:
--   A3  service_assignments uses PER-COMMAND policies (sa_select / sa_insert / sa_update), NOT one
--       FOR ALL — the target-side accept handshake UPDATEs a provider-owned row under
--       withTenants([target]); a FOR ALL WITH CHECK(provider) would fail it. Immutability of the
--       relationship-identity columns (provider/target/module) is enforced by a BEFORE UPDATE
--       trigger (defense-in-depth; unit_id stays mutable to support the documented re-link flow —
--       see the deviation note below).
--   A2  NO provenance coalescing. A refcounting claims junction (service_grant_claims) owns the
--       liveness of every reconciler-materialized membership/grant; managed_by is a marker (NULL =
--       manual, never reconciler-touched), NOT the single source of liveness. The existing
--       user_roles UNIQUE(user_id,role_id,scope_type,scope_id) and company_memberships
--       UNIQUE(tenant_id,user_id) are LEFT UNCHANGED (A2: refcount, don't widen uniqueness).
--   A8  unit_name/unit_kind/unit_status denormalized onto service_assignments so the TARGET side can
--       render unit metadata without reading the provider-only org_units row (which tenant_isolation
--       hides from it). org_units stays strictly provider-side.
--   A12 lead_user_id on service_assignments (chosen in the confirm sheet) → the reconciler grants
--       _manager to the lead, _staff to the rest. No org-blob flag needed.
--   A16 'suspended' status (grants off, edge + audit kept) in the status CHECK.

-- ══ (A) org_units — the lazy relational anchor for an org-blob node. Provider-side, tenant-isolated.
CREATE TABLE org_units (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES companies(id),   -- provider / home company (blob owner)
  node_id     text NOT NULL,                            -- OrgNode.id in company_org_structure (e.g. 'd-hr')
  kind        text NOT NULL CHECK (kind IN ('department','division')),
  name        text NOT NULL,                            -- denormalized display name; reconciler refreshes on org PUT
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','orphaned')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, node_id)
);
ALTER TABLE org_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_units FORCE ROW LEVEL SECURITY;
-- Standard tenant_isolation composed from the 0025 helper. Has a tenant_id column, so the
-- rls.test.ts FORCE-RLS sweep covers it automatically.
CREATE POLICY tenant_isolation ON org_units FOR ALL
  USING (tenant_id = ANY(app_current_tenants()))
  WITH CHECK (tenant_id = ANY(app_current_tenants()));

-- ══ (B) service_assignments — the connect-the-dots edge. One row = "unit U of provider P operates
--        module M for target company T". No column literally named tenant_id, so the rls.test.ts
--        sweep MISSES it → this migration ships a dedicated FORCE-RLS + per-command-policy test.
CREATE TABLE service_assignments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unit_id             uuid NOT NULL REFERENCES org_units(id),
  provider_tenant_id  uuid NOT NULL REFERENCES companies(id),  -- = org_units.tenant_id (denormalized for RLS)
  target_tenant_id    uuid NOT NULL REFERENCES companies(id),
  module_key          text NOT NULL,                            -- validated against the module registry at the API layer
  status              text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('proposed','active','suspended','revoked')),  -- A16: 'suspended'
  -- A12: the confirm-sheet lead → reconciler grants _manager to this user, _staff to the rest.
  lead_user_id        uuid REFERENCES users(id),
  -- A8: denormalized unit metadata for the target-facing views (org_units is provider-only).
  unit_name           text NOT NULL,
  unit_kind           text NOT NULL CHECK (unit_kind IN ('department','division')),
  unit_status         text NOT NULL DEFAULT 'active' CHECK (unit_status IN ('active','orphaned')),
  created_by          uuid NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  accepted_by         uuid REFERENCES users(id),                -- target-side consent (NULL for a global-actor auto-accept)
  accepted_at         timestamptz,
  revoked_by          uuid REFERENCES users(id),
  revoked_at          timestamptz,
  suspended_at        timestamptz,                              -- A16
  origin_site         text NOT NULL DEFAULT 'central',
  CHECK (provider_tenant_id <> target_tenant_id)
);
-- At most one live-ish edge per (unit, target, module). 'suspended' is included (DEVIATION from the
-- spec's proposed/active-only index): a suspended edge still occupies the relationship slot, so a new
-- one cannot be created alongside it — the controller resumes the suspended row instead. Prevents a
-- confusing duplicate live relationship. 'revoked' rows are excluded so the same triple can be
-- re-connected after a revoke.
CREATE UNIQUE INDEX ux_service_assignments_active
  ON service_assignments(unit_id, target_tenant_id, module_key)
  WHERE status IN ('proposed','active','suspended');
-- Target-side "is this module served?" lookup (ModuleEnabledGuard OR-clause) — only 'active' counts.
CREATE INDEX ix_service_assignments_target ON service_assignments(target_tenant_id, module_key)
  WHERE status = 'active';
CREATE INDEX ix_service_assignments_provider ON service_assignments(provider_tenant_id);
CREATE INDEX ix_service_assignments_unit ON service_assignments(unit_id);

ALTER TABLE service_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_assignments FORCE ROW LEVEL SECURITY;
-- A3: PER-COMMAND policies (NOT one FOR ALL). The deliberate dual-side D5 widening lives in SELECT
-- and UPDATE (visible/updatable from EITHER side — the accept/revoke handshake runs under the
-- TARGET's tenant set); INSERT stays provider-only (creation is a provider gesture). No DELETE
-- policy: rows are never hard-deleted (revoke is an UPDATE to status='revoked'); with FORCE RLS and
-- no permissive DELETE policy, DELETE is denied outright — intentional.
CREATE POLICY sa_select ON service_assignments FOR SELECT
  USING (
    provider_tenant_id = ANY(app_current_tenants())
    OR target_tenant_id = ANY(app_current_tenants())
  );
CREATE POLICY sa_insert ON service_assignments FOR INSERT
  WITH CHECK (provider_tenant_id = ANY(app_current_tenants()));
CREATE POLICY sa_update ON service_assignments FOR UPDATE
  USING (
    provider_tenant_id = ANY(app_current_tenants())
    OR target_tenant_id = ANY(app_current_tenants())
  )
  WITH CHECK (
    provider_tenant_id = ANY(app_current_tenants())
    OR target_tenant_id = ANY(app_current_tenants())
  );

-- A3 column immutability: freeze the relationship-identity columns after insert. provider/target/
-- module are hard-frozen (mutating target_tenant_id post-accept would be a cross-tenant escalation
-- the per-command UPDATE policy alone cannot stop). unit_id is deliberately NOT frozen: the spec's
-- orphan re-link flow (PATCH assignment.unit_id) requires it, and re-pointing within the same
-- provider is re-validated + re-denormalized by the reconciler. See the deviation note in the report.
CREATE OR REPLACE FUNCTION service_assignments_freeze_identity() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provider_tenant_id <> OLD.provider_tenant_id
     OR NEW.target_tenant_id <> OLD.target_tenant_id
     OR NEW.module_key <> OLD.module_key THEN
    RAISE EXCEPTION 'service_assignments: provider_tenant_id, target_tenant_id and module_key are immutable after insert';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_service_assignments_freeze_identity
  BEFORE UPDATE ON service_assignments
  FOR EACH ROW EXECUTE FUNCTION service_assignments_freeze_identity();

-- ══ (C) service_grant_claims — A2 refcounting junction. Each row = "assignment X is one reason
--        membership M / grant G exists in the target tenant". A managed membership/grant is deleted
--        ONLY when its LAST claim is removed AND kind='service'. Manual rows (managed_by NULL) are
--        never claimed, resurrected, or deleted by the reconciler. tenant_id = the TARGET tenant
--        (where the grant lives), so this is ordinary tenant-isolated data AND is auto-covered by the
--        rls.test.ts FORCE-RLS sweep.
CREATE TABLE service_grant_claims (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES companies(id),          -- target tenant (the grant's home)
  assignment_id uuid NOT NULL REFERENCES service_assignments(id),
  membership_id uuid REFERENCES company_memberships(id),
  user_role_id  uuid REFERENCES user_roles(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- exactly one artifact per claim row
  CHECK (num_nonnulls(membership_id, user_role_id) = 1)
);
-- One claim per (assignment, artifact). Partial indexes because NULLs are distinct in a plain UNIQUE
-- and would let duplicate claims through, corrupting the refcount.
CREATE UNIQUE INDEX ux_claims_membership ON service_grant_claims(assignment_id, membership_id)
  WHERE membership_id IS NOT NULL;
CREATE UNIQUE INDEX ux_claims_user_role ON service_grant_claims(assignment_id, user_role_id)
  WHERE user_role_id IS NOT NULL;
-- Reverse lookups for "is this the LAST claim on artifact A?" during revoke.
CREATE INDEX ix_claims_membership ON service_grant_claims(membership_id) WHERE membership_id IS NOT NULL;
CREATE INDEX ix_claims_user_role ON service_grant_claims(user_role_id) WHERE user_role_id IS NOT NULL;
CREATE INDEX ix_claims_assignment ON service_grant_claims(assignment_id);

ALTER TABLE service_grant_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_grant_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON service_grant_claims FOR ALL
  USING (tenant_id = ANY(app_current_tenants()))
  WITH CHECK (tenant_id = ANY(app_current_tenants()));

-- ══ (D) Provenance columns on the existing access tables (backward compatible, defaulted).
--        managed_by is a MARKER only: NOT NULL ⇒ reconciler-owned (humans can't edit via admin
--        endpoints; A1's invariant test keys on it); NULL ⇒ manual (reconciler never touches).
--        AUTHORITATIVE liveness is the claims count (C), never this single pointer (that is exactly
--        the coalescing trap A2 rejects).
ALTER TABLE company_memberships
  ADD COLUMN kind text NOT NULL DEFAULT 'employee' CHECK (kind IN ('employee','service')),
  ADD COLUMN managed_by uuid REFERENCES service_assignments(id);
ALTER TABLE user_roles
  ADD COLUMN managed_by uuid REFERENCES service_assignments(id);
CREATE INDEX ix_memberships_managed ON company_memberships(managed_by) WHERE managed_by IS NOT NULL;
CREATE INDEX ix_user_roles_managed ON user_roles(managed_by) WHERE managed_by IS NOT NULL;

-- ══ (E) hr module roles (global roles; company_id NULL). Seeded here per ORG-2 so the Cerbos
--        module_staff/module_manager derived pair (ORG-5) and the reconciler (ORG-6) have real
--        role_ids to grant. NOT EXISTS guard (a global role's NULL company_id makes ON CONFLICT
--        (company_id,name) unreliable — NULLs are distinct in the unique index).
INSERT INTO roles (id, company_id, name)
SELECT gen_random_uuid(), NULL, r.name
FROM (VALUES ('hr_staff'), ('hr_manager')) AS r(name)
WHERE NOT EXISTS (
  SELECT 1 FROM roles WHERE company_id IS NULL AND name = r.name
);
