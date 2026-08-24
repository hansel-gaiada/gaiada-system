-- Finance F4-07 — the IAM half of the receivables subledger (2026-08-24).
--
-- DERIVED from src/rbac/permission-catalog.json and src/rbac/role-permission-bundles.json, like
-- 202608241014/1016/1018. Frozen once applied.
--
-- 6 grantable permissions on ONE new Cerbos kind, `finance_ar`, for 202608241019.
--
-- ── THE ACTIONS MAP ONTO SoD DUTIES, NOT ONTO CRUD ──────────────────────────────────────────────
--   read / reconcile   see the subledger; run the subledger-to-GL tie-out
--   manage             customers and DRAFT invoices — nothing has reached the books
--   issue              post an invoice to the ledger; it becomes a receivable
--   receipt            record money arriving, and allocate it to invoices
--   write_off          void an issued invoice / forgive a debt
--
-- `receipt` and `write_off` are separate rights because 202608241013 seeds this as a BLOCKING
-- conflict: `ar_receipt_posting` + `ar_writeoff_approve` — "pocket the cash, then write off the
-- debt". That is the classic receivables fraud and it is only preventable if the two can be granted
-- apart. A single `manage` action covering both would make the seeded conflict unenforceable.
--
-- ⚠ SAME CAVEAT AS finance_ledger, STATED UP FRONT THIS TIME: `finance_manager` holds both. That is
-- not the control and not an oversight. Role bundles grant CAPABILITY; segregation of duties binds
-- per company, per PERSON, via `finance_duty_assignments` + `finance_sod_check()`. Splitting the
-- ACTIONS is what gives the duty matrix something to bind to.
--
-- ── THE TIERS ───────────────────────────────────────────────────────────────────────────────────
--   finance_staff   read, reconcile, manage, issue, receipt — the AR officer's whole day job.
--                   NOT write_off: the other half of the fraud pair.
--   finance_manager everything, including write_off (D4 high assurance in policy).
--   company_admin   read, reconcile, manage, write_off — but NOT issue or receipt. An administrative
--                   role does not run the receivables desk; it can, however, authorise forgiving a
--                   debt, which is a governance decision rather than a bookkeeping one.
--
-- ROLE-ARM ONLY, no perm_* mirror. Additive; no existing row is updated or deleted.

INSERT INTO permissions (id, key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description, v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('finance.ar.read', 'finance', 'ar', 'read',
   'Read AR customers, invoices, receipts and the aging schedule.',
   'finance_ar', 'read', 'grantable', true, true),
  ('finance.ar.reconcile', 'finance', 'ar', 'reconcile',
   'Run the AR subledger-to-general-ledger reconciliation check.',
   'finance_ar', 'reconcile', 'grantable', false, true),
  ('finance.ar.manage', 'finance', 'ar', 'manage',
   'Maintain AR customers and draft invoices (nothing posted to the ledger yet).',
   'finance_ar', 'manage', 'grantable', true, true),
  ('finance.ar.issue', 'finance', 'ar', 'issue',
   'Issue a draft invoice — posts it to the ledger as a receivable.',
   'finance_ar', 'issue', 'grantable', true, true),
  ('finance.ar.receipt', 'finance', 'ar', 'receipt',
   'Record customer receipts and allocate them to invoices.',
   'finance_ar', 'receipt', 'grantable', true, true),
  ('finance.ar.write_off', 'finance', 'ar', 'write_off',
   'Void an issued invoice or forgive a receivable. The half of the receipt/write-off fraud pair with no other trace.',
   'finance_ar', 'write_off', 'grantable', true, true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

-- Bundles, emitted from role-permission-bundles.json so the two cannot disagree.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
  ('company_admin',    'finance.ar.manage'),
  ('company_admin',    'finance.ar.read'),
  ('company_admin',    'finance.ar.reconcile'),
  ('company_admin',    'finance.ar.write_off'),

  ('finance_manager',  'finance.ar.issue'),
  ('finance_manager',  'finance.ar.manage'),
  ('finance_manager',  'finance.ar.read'),
  ('finance_manager',  'finance.ar.receipt'),
  ('finance_manager',  'finance.ar.reconcile'),
  ('finance_manager',  'finance.ar.write_off'),

  ('finance_staff',    'finance.ar.issue'),
  ('finance_staff',    'finance.ar.manage'),
  ('finance_staff',    'finance.ar.read'),
  ('finance_staff',    'finance.ar.receipt'),
  ('finance_staff',    'finance.ar.reconcile'),

  ('owner',            'finance.ar.manage'),
  ('owner',            'finance.ar.read'),
  ('owner',            'finance.ar.reconcile'),
  ('owner',            'finance.ar.write_off'),

  ('platform_admin',   'finance.ar.issue'),
  ('platform_admin',   'finance.ar.manage'),
  ('platform_admin',   'finance.ar.read'),
  ('platform_admin',   'finance.ar.receipt'),
  ('platform_admin',   'finance.ar.reconcile'),
  ('platform_admin',   'finance.ar.write_off')
) AS v(role_name, perm_key)
JOIN roles       r ON r.company_id IS NULL AND r.name = v.role_name
JOIN permissions p ON p.key = v.perm_key
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
);
