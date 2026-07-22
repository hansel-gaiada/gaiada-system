-- ORG-3 security micro-migration: close the FK-existence-only gap on
-- service_assignments.unit_id.
--
-- PROBLEM: service_assignments.unit_id REFERENCES org_units(id) (0026) is a plain single-column
-- FK, which only proves the id EXISTS somewhere — Postgres FK referential-integrity checks do not
-- evaluate RLS on the referenced table. A bug (or a future write path) could therefore construct a
-- service_assignments row whose unit_id belongs to a DIFFERENT tenant than its own
-- provider_tenant_id, and no ordinary RLS-scoped SELECT would reliably catch it: under
-- withTenants([providerTenantId]) the mismatched unit's real owner is invisible, so a
-- normal-privilege validation query returns "not found" — indistinguishable from "genuinely does
-- not exist" — unless the check runs with a privilege that can see rows in BOTH tenants. Worse, a
-- session scoped to the TARGET tenant (legal under service_assignments' dual-side sa_update policy,
-- 0026 — the target-side accept/revoke/suspend/resume path) can never see the PROVIDER's org_units
-- row at all, RLS or no RLS, which is exactly the scenario ORG-6's future reconciler-driven
-- orphan-repair re-link will run under.
--
-- FIX: a tenant-scoped COMPOSITE foreign key, not a custom trigger.
-- Postgres foreign-key referential-integrity checks are enforced by an internal system trigger that
-- is NOT subject to row security on the referenced table — that bypass is precisely the gap being
-- closed here, now put to work proving the RIGHT invariant instead of merely existence. Declaring
-- the FK over (unit_id, provider_tenant_id) -> org_units(id, tenant_id) makes the database itself
-- guarantee unit_id belongs to provider_tenant_id, unconditionally, from ANY session (provider-
-- scoped, target-scoped, or a future global/system writer), on INSERT and on every UPDATE that
-- touches unit_id (Postgres re-validates a composite FK whenever a referencing column changes) — the
-- ticket's "on any INSERT or unit_id change" requirement, satisfied declaratively.
--
-- DEVIATION FROM THE TICKET'S SUGGESTED MECHANISM (recorded for architect review):
-- The ticket asked for "a SECURITY DEFINER trigger" (rationale: the provider-side org_units row is
-- RLS-invisible under withTenants([target])). Implemented literally, that requires the trigger
-- function to be OWNED by a role with the BYPASSRLS attribute (SECURITY DEFINER only re-points
-- CURRENT_USER to the owner for the duration of the call; it does not itself suppress
-- FORCE ROW LEVEL SECURITY — the owner still needs BYPASSRLS, or the owner-exemption is moot because
-- org_units has FORCE ROW LEVEL SECURITY). This deployment deliberately keeps EVERY role, including
-- the migration owner, NOSUPERUSER NOBYPASSRLS (infra/db/init-cluster.sh; asserted by
-- src/testing/setup.ts and rls.test.ts's harness comment) — and platform_owner is NOCREATEROLE, so a
-- migration cannot even mint a new BYPASSRLS-owning role to transfer the function to. Granting
-- BYPASSRLS to any existing role is a standing security-posture change outside this ticket's remit
-- (schema/privilege-model changes go through senior-db/architect sign-off, not an improvised
-- migration). The composite FK below satisfies the identical normative requirement — "the referenced
-- org_units row must have tenant_id = NEW.provider_tenant_id, checked on INSERT and on unit_id
-- change, regardless of the calling session's tenant scope" — as a strict superset, with zero new
-- roles and zero new BYPASSRLS surface. Flagged for GATE-1/architect review; trivial to swap for a
-- real SECURITY DEFINER trigger later if a dedicated bypass role is ever provisioned at the infra
-- layer.

-- A composite unique constraint so org_units can be the target of a two-column FK (Postgres
-- requires the referenced columns to be covered by a UNIQUE or PRIMARY KEY constraint). Redundant
-- with the existing PK on id alone — this is the standard "tenant-scoped foreign key" pattern.
ALTER TABLE org_units ADD CONSTRAINT ux_org_units_id_tenant UNIQUE (id, tenant_id);

-- Replace the single-column FK from 0026 with the tenant-checked composite FK. Dropping and
-- re-adding is free here: 0026 is dormant (no code writes service_assignments rows yet — ORG-6/7 are
-- the first), so there is no pre-existing data for the new FK to fail against on any real deployment
-- at this point in the migration path.
ALTER TABLE service_assignments DROP CONSTRAINT service_assignments_unit_id_fkey;
ALTER TABLE service_assignments
  ADD CONSTRAINT fk_service_assignments_unit_tenant
  FOREIGN KEY (unit_id, provider_tenant_id) REFERENCES org_units (id, tenant_id);
