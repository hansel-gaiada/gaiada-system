-- TR-42 — seed the global reports_staff/reports_manager roles the served-dept tier has been
-- waiting on since TR-25.
--
-- The bug, precisely: `cerbos/policies/resource_report_document.yaml`'s `module_staff`/
-- `module_manager` derived roles (see derived_roles.yaml) already grant the served-dept tier
-- (§8's fifth column) whenever a principal holds a grant named `<module>_staff`/`<module>_manager`
-- scoped to the served company. `service-reconciler.ts`'s `moduleRoleId(c, moduleKey, kind)` composes
-- exactly that name (`${moduleKey}_${kind}`) and looks it up via
-- `SELECT id FROM roles WHERE company_id IS NULL AND name = $1` — but 0026 block (E) seeded ONLY the
-- hr pair (hr_staff/hr_manager). For any REAL `service_assignments` row with `module_key='reports'`,
-- `moduleRoleId` returns NULL, and the reconciler's caller does exactly this:
--   const rid = await moduleRoleId(c, row.module_key, kind);
--   if (!rid) { skipped.push(userId); continue; }  -- no grant, no error, no log a lead would see
-- Net effect: a provider lead with an ACTIVE service_assignments edge into a served company gets
-- silence instead of data when they read that company's department-grain report. The policy, the
-- platform-ui/src/lib/rbac.ts mirror, and the tests (tr25-person-axis.db.test.ts's "served-dept
-- provider tier" block, reports-cerbos.test.ts, person-scope.test.ts) were all already written and
-- have been waiting on these two rows.
--
-- Same idiom as 0026 block (E), reused deliberately, not "improved": a global role has
-- company_id IS NULL, and NULLs are distinct in the UNIQUE(company_id, name) index, so
-- `ON CONFLICT (company_id, name)` cannot be relied on to de-duplicate a NULL-company_id row across
-- runs — a NOT EXISTS guard scoped explicitly to `company_id IS NULL` is what actually makes this
-- idempotent.
--
-- Backfill note (this migration's only DML is this INSERT): `roles` is a GLOBAL table
-- (company_id IS NULL here, by definition — there is no tenant to scope it to), not tenant-scoped
-- data, so the "migration runs as a BYPASSRLS owner / tenant GUC unset" backfill trap
-- (migration-backfill-rls-trap.md) does not apply here — there is no RLS on `roles` for the owner
-- role to bypass, and no tenant GUC that could make the WHERE clause silently match nothing. A
-- NOBYPASSRLS-role re-run test would be ceremonial for this table; the idempotency test below (a
-- second migrate producing exactly 2 rows, not 4) is the real proof and is included instead.
--
-- No Cerbos policy change needed: resource_report_document.yaml + derived_roles.yaml already spell
-- 'module_staff'/'module_manager' generically (string-composed from resource.attr.module), and this
-- migration reuses that exact spelling — 'reports_staff'/'reports_manager'. No cerbos restart
-- required for this ticket.
INSERT INTO roles (id, company_id, name)
SELECT gen_random_uuid(), NULL, r.name
FROM (VALUES ('reports_staff'), ('reports_manager')) AS r(name)
WHERE NOT EXISTS (
  SELECT 1 FROM roles WHERE company_id IS NULL AND name = r.name
);
