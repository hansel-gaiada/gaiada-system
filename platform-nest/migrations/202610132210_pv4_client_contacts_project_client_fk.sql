-- 202610132210_pv4_client_contacts_project_client_fk.sql — PV4-13: a client contact's project belongs to the contact's client.
-- Follow-up to the portal scope-per-client fix (4ea548d0) and owner ruling PV-D36 (2026-10-13, the portal People list).
--
-- THE GAP
--   client_contacts.project_id is a plain FK to projects(id). Nothing says the project belongs to the row's client_id,
--   so a contact row can point at a project of ANOTHER client (same tenant). The portal's scope kernel reads such a row
--   as "this contact reaches client X, limited to that project", and the People list (PV-D36) would show it to the
--   wrong people. The write path that could do it (POST /clients/:id/contacts, `projectId`) only checked that the
--   project existed in the tenant; it is fixed in the same change, but a declarative FK is the guard that holds for
--   every writer (the app, a seed, psql).
--
-- THE FIX: a COMPOSITE FK, the same shape as PV4-01's thread FK (202610122330_pv4_conversation_data_model.sql, decision 1)
--   client_contacts (project_id, client_id, tenant_id) REFERENCES projects (id, client_id, tenant_id)
--   The referenced unique, ux_projects_id_client_tenant, already exists (PV4-01).
--   * project_id NULL = client-wide contact. The FK is MATCH SIMPLE, so a NULL project_id skips the check, which is
--     exactly right: the plain client_id / tenant_id FKs cover that case.
--   * An INTERNAL project (projects.client_id IS NULL) cannot be given a contact: NULL never equals the contact's
--     client_id, so the row is refused. That is correct, an internal project has no client contacts.
--   * It also protects the other direction: a project cannot be re-assigned to a different client while a contact row
--     still points at it (ON UPDATE NO ACTION, the default).
--   SQLSTATE of a refused write: 23503 (foreign_key_violation).
--
-- ── NOT VALID, AND WHY (read before "tidying" it) ──────────────────────────────────────────────────────
-- The constraint is added NOT VALID: Postgres enforces it for every INSERT and for every UPDATE of the row's
-- (project_id, client_id, tenant_id) from now on, but does NOT scan the rows that already exist. Live data is review
-- seed and has not been checked; a plain ADD CONSTRAINT would validate every existing row and FAIL THE DEPLOY on the
-- first one that points across clients. NOT VALID cannot fail on existing data.
-- It is deliberately NOT VALIDATED HERE. Validation is a LATER step, once the count printed below is 0 on live (or the
-- offending rows have been corrected by a person): `ALTER TABLE client_contacts VALIDATE CONSTRAINT
-- fk_client_contacts_project_client_tenant;` takes only a SHARE UPDATE EXCLUSIVE lock, so it can run on a live table.
-- Do not add the VALIDATE to this file or to a deploy hook: a failed validation must be a decision, not a deploy abort.
--
-- ── THE VIOLATION COUNT ───────────────────────────────────────────────────────────────────────────────
-- The DO block below counts the existing rows that would violate the constraint (a contact with a project_id whose
-- project is not in the contact's own client and tenant) and prints ONE number as a NOTICE: "[PV4-13] ... : N row(s)".
-- Read it from the deploy log. It prints the count only, never a row, an id or a name.
-- ZERO-ROW TRAP: client_contacts and projects are FORCE RLS and the migration owner is NOBYPASSRLS, so a bare count would
-- read ZERO rows and report a reassuring 0 on a table that has violations. The count therefore runs per company with
-- app.current_tenant_ids set (the 0051/0108 idiom, as in 202610131820_pv5_enforce_contract_content_fixed.sql). The count
-- also filters `cc.tenant_id = co.id` itself, so a session that does bypass RLS (a superuser) counts each row once, not once
-- per company.
--
-- ── ROLLOUT ───────────────────────────────────────────────────────────────────────────────────────────
-- Ships WITH the PV4-13 code (the invite route now answers 404 for a project of another client instead of reaching
-- this FK). Reverse: ALTER TABLE client_contacts DROP CONSTRAINT fk_client_contacts_project_client_tenant.
-- No secrets; no company names or ids.

-- ── count the existing violations, per company (RLS) ─────────────────────────────────────────────
DO $$
DECLARE
  co RECORD;
  n integer;
  total integer := 0;
BEGIN
  FOR co IN SELECT id FROM companies LOOP
    PERFORM set_config('app.current_tenant_ids', co.id::text, true);

    SELECT count(*) INTO n
      FROM client_contacts cc
     WHERE cc.tenant_id = co.id
       AND cc.project_id IS NOT NULL
       AND NOT EXISTS (
             SELECT 1 FROM projects p
              WHERE p.id = cc.project_id AND p.client_id = cc.client_id AND p.tenant_id = cc.tenant_id);
    total := total + n;
  END LOOP;
  PERFORM set_config('app.current_tenant_ids', '', true);
  RAISE NOTICE '[PV4-13] existing client_contacts rows whose project is not in the contact''s own client (the new FK is NOT VALID and does not check them): % row(s)', total;
END $$;

-- DDL refuses to run while a deferrable constraint trigger is pending on a table this transaction wrote; the block above
-- wrote nothing, so none is pending, but this keeps the order safe regardless.
SET CONSTRAINTS ALL IMMEDIATE;

-- ── the guard (enforced for new and updated rows only) ───────────────────────────────────────────
ALTER TABLE client_contacts
  ADD CONSTRAINT fk_client_contacts_project_client_tenant
  FOREIGN KEY (project_id, client_id, tenant_id)
  REFERENCES projects (id, client_id, tenant_id)
  NOT VALID;

COMMENT ON CONSTRAINT fk_client_contacts_project_client_tenant ON client_contacts IS
  'PV4-13: a contact''s project belongs to the contact''s client and tenant. NOT VALID on purpose (existing rows are not '
  'checked; VALIDATE is a later, deliberate step once the deploy-log count is 0). MATCH SIMPLE: a NULL project_id (client-wide) skips it.';
