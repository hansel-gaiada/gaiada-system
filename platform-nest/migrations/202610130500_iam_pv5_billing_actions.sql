-- IAM — PV5-02: four new actions on three EXISTING Cerbos kinds (docs/plans/2026-10-12-pv5-contracts-billing-tickets.md,
-- PV5-02; rulings PV-D7, PV-D8). Pure IAM seed on the global reference tables: no DDL, no tenant rows, no new kind.
--
--   invoice.issue                    invoice       issue            grantable, sensitive, ui_grantable
--   invoice.void_issued              invoice       void_issued      grantable, sensitive, ui_grantable
--   core.contract.mark_certified     contract      mark_certified   grantable, sensitive, ui_grantable
--   finance.config.set_bank_details  finance_config set_bank_details grantable, sensitive, NOT ui_grantable
--
-- The first three have a `perm_*` mirror in cerbos/policies (perm_invoice_issue, perm_invoice_void_issued,
-- perm_contract_mark_certified), so a holder of the key reaches the action through the permission arm; that is also how
-- the permission-native `owner` reaches them. `finance.config.set_bank_details` has NO mirror and NO module_manager rule:
-- it is reached only by an inline Cerbos GRANT rule (owner or finance_manager at company scope on the tenant) or the
-- platform_admin wildcard, so holding the key grants nothing. It is `ui_grantable = false` for the same reason as
-- `core.contract.countersign` (202610112330), and it is bundled on platform_admin alone: a `ui_grantable = false` key in
-- company_admin's, owner's or finance_manager's bundle would make that role unattachable to positions (0110's
-- position_roles_guard clause (b)).
--
-- WHICH BUNDLE HOLDS WHAT (a mechanical transcription of what scripts/generate-role-bundles.mjs derives from the policy):
--   invoice.issue                    platform_admin (wildcard), company_admin + manager (role arm), owner (= company_admin's set)
--   invoice.void_issued              platform_admin, company_admin, owner. NOT manager.
--   core.contract.mark_certified     platform_admin, company_admin, owner. (the holders of core.contract.send, which manager lacks)
--   finance.config.set_bank_details  platform_admin ONLY.
--   every other role                 NOTHING (member, viewer, org_unit_lead, client, the module tiers, finance_manager included:
--                                    finance_manager reaches set_bank_details by its GRANT, not by a bundle row).
--
-- `permissions.id` has no default, so it is supplied explicitly (202608310900's pattern). Idempotent.
INSERT INTO permissions (id, key, module_key, resource, action, description,
                         cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description,
       v.cerbos_kind, v.cerbos_action, 'grantable', true, v.ui_grantable
FROM (VALUES
  ('invoice.issue', 'invoice', 'invoice', 'issue',
   'Issue an approved invoice through the finance ledger: takes the next invoice number and posts the matching AR invoice in one transaction (PV-D7). Held by the roles that hold approve; not maker/checker-bound (approval already was). Refused to bot and automation principals by a Cerbos DENY.',
   'invoice', 'issue', true),
  ('invoice.void_issued', 'invoice', 'invoice', 'void_issued',
   'Void an ISSUED invoice: posts the full AR reversal (credit note) in the same transaction (PV-D7). company_admin and owner only (manager may issue, not void). Refused to bot and automation principals by a Cerbos DENY.',
   'invoice', 'void_issued', true),
  ('core.contract.mark_certified', 'core', 'contract', 'mark_certified',
   'Mark a client contract for the certified (PSrE) signature tier at send (PV-D8). Held by the roles that hold send.',
   'contract', 'mark_certified', true),
  ('finance.config.set_bank_details', 'finance', 'config', 'set_bank_details',
   'Change the bank account clients pay issued invoices into (the company billing profile''s bank block). Reached ONLY through the Cerbos rule for an owner or finance_manager grant on this company, or the platform_admin wildcard; holding this key grants nothing (no perm-arm rule). Needs high assurance from everyone, platform_admin included (PV-D26). Refused to bot and automation principals by a Cerbos DENY.',
   'finance_config', 'set_bank_details', false)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
  ('platform_admin', 'invoice.issue'),
  ('company_admin',  'invoice.issue'),
  ('manager',        'invoice.issue'),
  ('owner',          'invoice.issue'),
  ('platform_admin', 'invoice.void_issued'),
  ('company_admin',  'invoice.void_issued'),
  ('owner',          'invoice.void_issued'),
  ('platform_admin', 'core.contract.mark_certified'),
  ('company_admin',  'core.contract.mark_certified'),
  ('owner',          'core.contract.mark_certified'),
  ('platform_admin', 'finance.config.set_bank_details')
) AS v(role_name, perm_key)
JOIN roles r ON r.company_id IS NULL AND r.name = v.role_name
JOIN permissions p ON p.key = v.perm_key
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
);

-- ── Assert, don't assume ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  expected record;
  got integer;
BEGIN
  FOR expected IN
    SELECT * FROM (VALUES
      ('invoice.issue',                    'invoice',        'issue',          true,  true),
      ('invoice.void_issued',              'invoice',        'void_issued',    true,  true),
      ('core.contract.mark_certified',     'contract',       'mark_certified', true,  true),
      ('finance.config.set_bank_details',  'finance_config', 'set_bank_details', true, false)
    ) AS x(perm_key, kind, action, sens, ui)
  LOOP
    SELECT count(*) INTO got FROM permissions
     WHERE key = expected.perm_key AND class = 'grantable'
       AND cerbos_kind = expected.kind AND cerbos_action = expected.action
       AND sensitive = expected.sens AND ui_grantable = expected.ui;
    IF got <> 1 THEN
      RAISE EXCEPTION '202610130500: expected 1 % (grantable, sensitive=%, ui_grantable=%), found %',
        expected.perm_key, expected.sens, expected.ui, got;
    END IF;
  END LOOP;

  -- The exact holder set per key, in BOTH directions: the global roles that must hold it do, and no other role
  -- row (global or company-defined) holds it. A hand-written custom role that already carried a key is refused
  -- rather than left in place.
  FOR expected IN
    SELECT * FROM (VALUES
      ('invoice.issue',                   ARRAY['company_admin','manager','owner','platform_admin']),
      ('invoice.void_issued',             ARRAY['company_admin','owner','platform_admin']),
      ('core.contract.mark_certified',    ARRAY['company_admin','owner','platform_admin']),
      ('finance.config.set_bank_details', ARRAY['platform_admin'])
    ) AS x(perm_key, holders)
  LOOP
    SELECT count(*) INTO got FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
     WHERE p.key = expected.perm_key AND r.company_id IS NULL AND r.name = ANY(expected.holders);
    IF got <> cardinality(expected.holders) THEN
      RAISE EXCEPTION '202610130500: % should be held by % global role(s) (%), found %',
        expected.perm_key, cardinality(expected.holders), expected.holders, got;
    END IF;

    SELECT count(*) INTO got FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
     WHERE p.key = expected.perm_key
       AND NOT (r.company_id IS NULL AND r.name = ANY(expected.holders));
    IF got <> 0 THEN
      RAISE EXCEPTION '202610130500: % is held by % role row(s) outside its expected set', expected.perm_key, got;
    END IF;
  END LOOP;

  -- owner stays equal to company_admin, in both directions, across the three keys that reach company_admin.
  SELECT count(*) INTO got FROM (
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner'
        AND p.key IN ('invoice.issue','invoice.void_issued','core.contract.mark_certified','finance.config.set_bank_details')
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin'
        AND p.key IN ('invoice.issue','invoice.void_issued','core.contract.mark_certified','finance.config.set_bank_details'))
    UNION ALL
    (SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'company_admin'
        AND p.key IN ('invoice.issue','invoice.void_issued','core.contract.mark_certified','finance.config.set_bank_details')
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.company_id IS NULL AND r.name = 'owner'
        AND p.key IN ('invoice.issue','invoice.void_issued','core.contract.mark_certified','finance.config.set_bank_details'))
  ) diff;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610130500: owner''s bundle diverges from company_admin''s by % of the new key(s) — owner-role.db.test.ts will fail', got;
  END IF;
END $$;
