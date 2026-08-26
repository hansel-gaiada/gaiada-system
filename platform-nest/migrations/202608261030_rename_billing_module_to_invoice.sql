-- RENAME THE `billing` MODULE TO `invoice`.
--
-- The module key, its five permission keys and its UI path all said "billing" while every route
-- (`/api/:tenantId/invoices`), every table (`invoices`) and the Cerbos kind (`resource_invoice`)
-- already said "invoice". The owner's framing settled which word is right: this module is for the
-- OUTSIDE contract — Gaia Digital Agency and its clients — and what it produces is an invoice.
--
-- "Billing" also carried two UNRELATED senses in this codebase — a client's billing ADDRESS
-- (`clients.contact`) and vendor billing in the search providers — so the word named three
-- different things and disambiguated none of them. Those two are deliberately NOT touched here.
--
-- ── WHY THIS IS A MIGRATION AND NOT JUST A CODE RENAME ─────────────────────────────────────────
-- Both the module key and the permission keys are STORED, not just referenced:
--
--   companies.enabled_modules      — a text[] naming the module; Gaia Digital Agency has it on
--   service_assignments.module_key — the shared-service path to the same module
--   permissions.key                — the five `billing.invoice.*` rows
--
-- Rename the code without this and the module silently switches OFF for every company that had it:
-- `isModuleEnabled(tenant, 'invoice')` finds no such key, the guard denies, and the invoices page
-- goes empty with no error anywhere. Same class as the seed rename trap in platform-nest/CLAUDE.md,
-- and worse, because a fresh test database creates the row under the NEW name and every suite
-- passes with this file deleted.

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) Permission keys — `billing.invoice.<action>` becomes `invoice.<action>`
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Two-part keys, following the `portal.*` precedent — the other place in this catalog where the
-- domain and the Cerbos kind are the same word. `invoice.invoice.read` would have been the
-- mechanical result and reads as a stutter.
--
-- ★ THE ROWS ARE UPDATED, NEVER DELETED AND RE-INSERTED. `role_permissions` keys off
-- `permission_id`, so renaming the key in place carries every existing grant with it. A
-- delete-then-insert would cascade those grants away (ON DELETE CASCADE) and silently strip the
-- capability from every role that holds it — on the live estate that is 17 rows across the baseline
-- roles, and nothing would report the loss.
UPDATE permissions SET key = 'invoice.read'     WHERE key = 'billing.invoice.read';
UPDATE permissions SET key = 'invoice.create'   WHERE key = 'billing.invoice.create';
UPDATE permissions SET key = 'invoice.update'   WHERE key = 'billing.invoice.update';
UPDATE permissions SET key = 'invoice.delete'   WHERE key = 'billing.invoice.delete';
UPDATE permissions SET key = 'invoice.approve'  WHERE key = 'billing.invoice.approve';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) The module key wherever it is stored
-- ════════════════════════════════════════════════════════════════════════════════════════════════
UPDATE companies
   SET enabled_modules = array_replace(enabled_modules, 'billing', 'invoice')
 WHERE 'billing' = ANY(enabled_modules);

-- `service_assignments.module_key` is IMMUTABLE after insert, enforced by a trigger
-- (0026_service_layer.sql) that raises on any change to provider/target/module_key. That guard is
-- correct — an assignment is a standing agreement to serve a named module, and silently re-pointing
-- one at a DIFFERENT module would move real access without an audit trail.
--
-- This is the one legitimate exception: the module is not changing, only its name. So the trigger is
-- disabled for exactly this statement and re-enabled immediately, rather than being weakened.
-- ALTER TABLE ... DISABLE TRIGGER is transactional and takes an ACCESS EXCLUSIVE lock, so nothing
-- else can slip through the window it opens.
--
-- ⚠ ALSO WRAPPED PER TENANT. `service_assignments` is FORCE-RLS and this migration runs as
-- `platform_owner` (NOBYPASSRLS), so a bare UPDATE would match ZERO rows and report success — the
-- assignments would keep pointing at a module key that no longer exists, and every served company
-- would silently lose the module with nothing logged. The row is reachable from EITHER side of the
-- agreement, so both the provider and the target tenant are set.
ALTER TABLE service_assignments DISABLE TRIGGER USER;
DO $$
DECLARE co record;
BEGIN
  FOR co IN SELECT id FROM companies LOOP
    PERFORM set_config('app.current_tenant_ids', co.id::text, true);
    UPDATE service_assignments SET module_key = 'invoice'
     WHERE module_key = 'billing'
       AND (provider_tenant_id = co.id OR target_tenant_id = co.id);
  END LOOP;
END $$;
ALTER TABLE service_assignments ENABLE TRIGGER USER;

-- The rollup registry names its owning module too. Left as an UPDATE rather than assumed empty:
-- "there are no rows" has been wrong here before, and an UPDATE over zero rows costs nothing.
-- `metric_definitions` is a global registry with no tenant column, so it needs no GUC.
UPDATE metric_definitions SET module = 'invoice' WHERE module = 'billing';
-- `rollup_metrics` IS tenant-scoped and FORCE-RLS, so it gets the same per-tenant wrapping.
DO $$
DECLARE co record;
BEGIN
  FOR co IN SELECT id FROM companies LOOP
    PERFORM set_config('app.current_tenant_ids', co.id::text, true);
    UPDATE rollup_metrics SET module = 'invoice' WHERE module = 'billing' AND tenant_id = co.id;
  END LOOP;
END $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (3) Prove it landed
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- ⚠ These run as the MIGRATOR role, which is not subject to RLS — so they see every company. A
-- verification query run under an app role with no tenant GUC set would return zero rows and report
-- success, which is the trap platform-nest/CLAUDE.md documents.
--
-- The check is that NOTHING is left holding the old name. A count of the new name would pass on a
-- fresh database where the old name never existed, which is precisely the case this must not be
-- fooled by.
DO $$
DECLARE
  v_perms int;
  v_companies int;
  v_assignments int;
BEGIN
  SELECT count(*) INTO v_perms       FROM permissions WHERE key LIKE 'billing.%';
  SELECT count(*) INTO v_companies   FROM companies WHERE 'billing' = ANY(enabled_modules);
  SELECT count(*) INTO v_assignments FROM service_assignments WHERE module_key = 'billing';

  IF v_perms > 0 OR v_companies > 0 OR v_assignments > 0 THEN
    RAISE EXCEPTION
      'billing->invoice rename incomplete: % permission(s), % compan(ies), % assignment(s) still hold the old key',
      v_perms, v_companies, v_assignments;
  END IF;
END $$;
