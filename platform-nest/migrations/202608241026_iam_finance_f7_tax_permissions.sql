-- Finance F7-06 — the IAM half of tax and statutory (2026-08-24).
--
-- DERIVED from the catalog and the generated bundles. 4 grantable permissions on ONE new Cerbos
-- kind, finance_tax, for 202608241025.
--
-- ── file IS THE HIGHEST BAR IN THE MODULE, ALONGSIDE ap.payment_release ────────────────────────
-- Everything else in finance is a statement to ourselves, our auditor or our bank. file is a
-- statement to the STATE, and a wrong one is a legal exposure rather than an accounting error: an
-- understated return is an assessment plus penalties and interest, and an overstated one is money
-- handed over that is very hard to get back.
--
-- ⚠ file does NOT transmit anything. Transmission goes through a licensed ASP/PJAP — blueprint
-- section 6 and owner ruling D-F2-s explicit carve-out. This action records that a return WAS
-- lodged, with its reference, and snapshots the figures as filed so that what we told the tax
-- office stays distinguishable from what the data says today.
--
-- ── configure IS SEPARATED FROM prepare ────────────────────────────────────────────────────────
-- A tax CODE decides the tax on every future document. Someone who can edit a rate or a base
-- multiplier changes the company-s tax position across every unfiled document at once. That is a
-- different order of authority from preparing this month-s return, and they are not the same job.
-- Effective dating limits the blast radius backwards; the forward exposure is real.
--
-- ── prepare IS DELIBERATELY WIDE ───────────────────────────────────────────────────────────────
-- Drafts, extract imports and the reconciliation assert nothing to anyone. The exception lists in
-- particular WANT to be widely runnable: AP_INPUT_VAT_LOST is money the company is silently
-- absorbing, and the sooner somebody sees it the more likely the vendor still answers the phone.
--
-- ROLE-ARM ONLY, no perm_* mirror. Additive.

INSERT INTO permissions (id, key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description, v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('finance.tax.read', 'finance', 'tax', 'read',
   'Read tax codes, returns, PPN/PPh summaries and the e-Faktur exception lists.',
   'finance_tax', 'read', 'grantable', true, true),
  ('finance.tax.prepare', 'finance', 'tax', 'prepare',
   'Build a draft return, import a Coretax extract, and run the Coretax reconciliation.',
   'finance_tax', 'prepare', 'grantable', true, true),
  ('finance.tax.configure', 'finance', 'tax', 'configure',
   'Create and amend tax codes — rates, base multipliers and effective dates. Changes the tax computed on every future document.',
   'finance_tax', 'configure', 'grantable', true, true),
  ('finance.tax.file', 'finance', 'tax', 'file',
   'Mark a return FILED: the assertion that it was lodged with the tax office. Snapshots the figures as filed.',
   'finance_tax', 'file', 'grantable', true, true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

-- Bundles, emitted from role-permission-bundles.json so the two cannot disagree.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
  ('company_admin',    'finance.tax.file'),
  ('company_admin',    'finance.tax.read'),

  ('finance_manager',  'finance.tax.configure'),
  ('finance_manager',  'finance.tax.file'),
  ('finance_manager',  'finance.tax.prepare'),
  ('finance_manager',  'finance.tax.read'),

  ('finance_staff',    'finance.tax.prepare'),
  ('finance_staff',    'finance.tax.read'),

  ('owner',            'finance.tax.file'),
  ('owner',            'finance.tax.read'),

  ('platform_admin',   'finance.tax.configure'),
  ('platform_admin',   'finance.tax.file'),
  ('platform_admin',   'finance.tax.prepare'),
  ('platform_admin',   'finance.tax.read')
) AS v(role_name, perm_key)
JOIN roles       r ON r.company_id IS NULL AND r.name = v.role_name
JOIN permissions p ON p.key = v.perm_key
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
);
