-- Finance F6-05 — the IAM half of bank reconciliation (2026-08-24).
--
-- DERIVED from the catalog and the generated bundles, like 202608241014/1016/1018/1020/1022.
-- 4 grantable permissions on ONE new Cerbos kind, `finance_bank`, for 202608241023.
--
-- ── THE SoD PAIR IS SATISFIED STRUCTURALLY HERE, WHICH IS A FIRST FOR THIS MODULE ──────────────
-- 202608241013 seeds `bank_reconcile` + `cash_custody` as a BLOCKING conflict — hide the theft
-- inside the reconciliation. Whoever can move money must not be the one who declares the bank
-- agrees.
--
-- Across the finance tiers that now falls out by construction:
--
--   finance_staff    reconciles the bank, and CANNOT release payments — F5 keeps
--                    finance.ap.payment_release at module_manager, high assurance.
--   finance_manager  can do both, and therefore needs a duty-matrix waiver if actually assigned
--                    both duties.
--
-- So the DEFAULT staffing — an AR/AP officer who reconciles, a controller who releases — satisfies
-- the seeded pair with nobody configuring anything. Every previous finance kind relied on the duty
-- matrix to catch the overlap; this one is arranged so the overlap does not arise at the staff tier.
--
-- ── WHAT HAS NO ACTION, DELIBERATELY ───────────────────────────────────────────────────────────
--   * Editing a statement line. The statement is the BANK-s version of events; if the bank is
--     wrong the answer is a dispute and a correcting entry, never an edit that makes the two agree.
--     No function in 202608241023 updates a transaction row.
--   * An adjustment / write-off-the-difference action. There is no such field by design: an
--     unexplained difference IS the finding, and a plug turns a real problem into a rounding line.
--
-- `reconcile` is the one non-sensitive key here — it returns problems, not figures, and a check
-- only the person who could have broken it may run is not a check.
--
-- ROLE-ARM ONLY, no perm_* mirror. Additive.

INSERT INTO permissions (id, key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description, v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('finance.bank.read', 'finance', 'bank', 'read',
   'Read bank statements, their lines and match state.',
   'finance_bank', 'read', 'grantable', true, true),
  ('finance.bank.reconcile', 'finance', 'bank', 'reconcile',
   'Run the bank reconciliation and the period close-readiness check.',
   'finance_bank', 'reconcile', 'grantable', false, true),
  ('finance.bank.import', 'finance', 'bank', 'import',
   'Import a bank statement and its transaction lines.',
   'finance_bank', 'import', 'grantable', true, true),
  ('finance.bank.match', 'finance', 'bank', 'match',
   'Match a bank statement line to a ledger line, or unmatch one. A judgement that two records are the same event.',
   'finance_bank', 'match', 'grantable', true, true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

-- Bundles, emitted from role-permission-bundles.json so the two cannot disagree.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
  ('company_admin',    'finance.bank.read'),
  ('company_admin',    'finance.bank.reconcile'),

  ('finance_manager',  'finance.bank.import'),
  ('finance_manager',  'finance.bank.match'),
  ('finance_manager',  'finance.bank.read'),
  ('finance_manager',  'finance.bank.reconcile'),

  ('finance_staff',    'finance.bank.import'),
  ('finance_staff',    'finance.bank.match'),
  ('finance_staff',    'finance.bank.read'),
  ('finance_staff',    'finance.bank.reconcile'),

  ('owner',            'finance.bank.read'),
  ('owner',            'finance.bank.reconcile'),

  ('platform_admin',   'finance.bank.import'),
  ('platform_admin',   'finance.bank.match'),
  ('platform_admin',   'finance.bank.read'),
  ('platform_admin',   'finance.bank.reconcile')
) AS v(role_name, perm_key)
JOIN roles       r ON r.company_id IS NULL AND r.name = v.role_name
JOIN permissions p ON p.key = v.perm_key
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
);
