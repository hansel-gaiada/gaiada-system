-- Finance F3-06 — the IAM half of the statement surface (2026-08-24).
--
-- DERIVED from src/rbac/permission-catalog.json and src/rbac/role-permission-bundles.json, like
-- 202608241014 and 202608241016. Frozen once applied.
--
-- Lands 2 grantable permissions on ONE new Cerbos kind, `finance_statement`, for the reporting
-- functions in 202608241017 (trial balance, general ledger, P&L, balance sheet, verification).
--
-- ── THERE IS NO WRITE ACTION, AND THAT IS THE POINT ─────────────────────────────────────────────
-- A statement is DERIVED from the ledger. There is nothing to create, edit or delete: if a figure
-- is wrong, the LEDGER is wrong, and it is corrected there by reversal. Cataloguing a
-- `finance.statement.update` would imply a statement can be adjusted independently of the entries
-- behind it, which is the exact practice double-entry bookkeeping exists to prevent.
--
-- ── WHY `export` IS A SEPARATE RIGHT FROM `read` ────────────────────────────────────────────────
-- Reading a P&L on screen and producing a signed PDF for a bank are different acts. The export
-- outlives the session, carries no access control once it exists, and is the artefact a lender
-- makes a decision on — blueprint 10.4 has banks and the tax office receiving a sealed package
-- rather than a login, and this is the action that produces it.
--
-- It therefore sits at the D4 HIGH-ASSURANCE tier, alongside `hr_record.export` and
-- `finance.period.close`. `notLow` admits any ordinary SSO session without MFA.
--
-- ── READ IS WIDER THAN LEDGER READ, ON PURPOSE ──────────────────────────────────────────────────
-- A statement is an AGGREGATE. Someone who should see departmental cost totals does not thereby
-- need every journal line behind them. Both are held by `finance_staff` today; the ordering matters
-- for roles added later, and is recorded so the next person does not "tidy" them into one tier.
--
-- ROLE-ARM ONLY, no perm_* mirror — same posture as the other five finance kinds.
-- Additive. No existing row is updated or deleted.

INSERT INTO permissions (id, key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description, v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('finance.statement.read', 'finance', 'statement', 'read',
   'Read the trial balance, general ledger, profit and loss, and balance sheet.',
   'finance_statement', 'read', 'grantable', true, true),
  ('finance.statement.export', 'finance', 'statement', 'export',
   'Export financial statements as a file that leaves the ERP — the bank, auditor or board pack.',
   'finance_statement', 'export', 'grantable', true, true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

-- Bundles, emitted from role-permission-bundles.json so the two cannot disagree.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
  ('company_admin',    'finance.statement.export'),
  ('company_admin',    'finance.statement.read'),

  ('finance_manager',  'finance.statement.export'),
  ('finance_manager',  'finance.statement.read'),

  ('finance_staff',    'finance.statement.read'),

  ('owner',            'finance.statement.export'),
  ('owner',            'finance.statement.read'),

  ('platform_admin',   'finance.statement.export'),
  ('platform_admin',   'finance.statement.read')
) AS v(role_name, perm_key)
JOIN roles       r ON r.company_id IS NULL AND r.name = v.role_name
JOIN permissions p ON p.key = v.perm_key
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
);
