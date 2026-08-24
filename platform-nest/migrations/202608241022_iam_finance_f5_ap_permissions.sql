-- Finance F5-06 — the IAM half of the payables subledger (2026-08-24).
--
-- DERIVED from the catalog and the generated bundles, like 202608241014/1016/1018/1020.
-- 6 grantable permissions on ONE new Cerbos kind, `finance_ap`, for 202608241021.
--
-- ── A FINER SPLIT THAN AR, BECAUSE AP CARRIES TWO SEEDED CONFLICTS ──────────────────────────────
-- 202608241013 seeds six blocking segregation-of-duties pairs. TWO of them are payables:
--
--     vendor_master  + ap_payment_release   —  "invent a vendor, pay yourself"
--     ap_bill_entry  + ap_payment_approve   —  "approve your own invoice"
--
-- AP is also where money actually leaves the building, so the actions are split five ways rather
-- than AR's three:
--   read / reconcile · bill_entry · vendor_master · approve · payment_release
--
-- ── WHY `vendor_master` IS ITS OWN RIGHT (and the AR customer equivalent is not) ────────────────
-- Editing a vendor's BANK DETAILS is the highest-leverage fraud in accounts payable: it needs no
-- fake invoice at all, only a redirected payment on a genuine one. An AR customer's bank details
-- move no company money; a vendor's do. Bundling vendor maintenance into a general "manage" action,
-- the way finance_ar does for customers, would be wrong here — and the asymmetry between the two
-- kinds is deliberate rather than an inconsistency.
--
-- ── THE TIERS ───────────────────────────────────────────────────────────────────────────────────
--   finance_staff    read, reconcile, bill_entry. An AP clerk enters bills and nothing else.
--   finance_manager  everything, including payment_release.
--   company_admin    read, reconcile, vendor_master, approve — but NOT bill_entry and NOT
--                    payment_release. An administrative role may authorise a commitment; it should
--                    not be able to move cash, and it does not run the payables desk.
--
-- `payment_release` is the narrowest grant in the entire finance module: module_manager only, D4
-- high assurance, no company_admin.
--
-- ⚠ Role bundles grant CAPABILITY. Segregation of duties binds per company, per PERSON, through
-- finance_duty_assignments + finance_sod_check(). Splitting the actions is what gives the duty
-- matrix something to bind to — it is not itself the control.
--
-- ROLE-ARM ONLY, no perm_* mirror. Additive.

INSERT INTO permissions (id, key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description, v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('finance.ap.read', 'finance', 'ap', 'read',
   'Read AP vendors, bills, payments and the aging schedule.',
   'finance_ap', 'read', 'grantable', true, true),
  ('finance.ap.reconcile', 'finance', 'ap', 'reconcile',
   'Run the AP subledger-to-general-ledger reconciliation check.',
   'finance_ap', 'reconcile', 'grantable', false, true),
  ('finance.ap.bill_entry', 'finance', 'ap', 'bill_entry',
   'Enter and edit draft vendor bills (nothing posted to the ledger yet).',
   'finance_ap', 'bill_entry', 'grantable', true, true),
  ('finance.ap.vendor_master', 'finance', 'ap', 'vendor_master',
   'Create and edit vendors, including their BANK DETAILS. The highest-leverage payables fraud — a redirected payment on a genuine invoice needs no fake bill at all.',
   'finance_ap', 'vendor_master', 'grantable', true, true),
  ('finance.ap.approve', 'finance', 'ap', 'approve',
   'Approve a bill — posts it, committing the company to pay the vendor and to remit withheld tax.',
   'finance_ap', 'approve', 'grantable', true, true),
  ('finance.ap.payment_release', 'finance', 'ap', 'payment_release',
   'Release payment to a vendor. The moment money irreversibly leaves.',
   'finance_ap', 'payment_release', 'grantable', true, true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

-- Bundles, emitted from role-permission-bundles.json so the two cannot disagree.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
  ('company_admin',    'finance.ap.approve'),
  ('company_admin',    'finance.ap.read'),
  ('company_admin',    'finance.ap.reconcile'),
  ('company_admin',    'finance.ap.vendor_master'),

  ('finance_manager',  'finance.ap.approve'),
  ('finance_manager',  'finance.ap.bill_entry'),
  ('finance_manager',  'finance.ap.payment_release'),
  ('finance_manager',  'finance.ap.read'),
  ('finance_manager',  'finance.ap.reconcile'),
  ('finance_manager',  'finance.ap.vendor_master'),

  ('finance_staff',    'finance.ap.bill_entry'),
  ('finance_staff',    'finance.ap.read'),
  ('finance_staff',    'finance.ap.reconcile'),

  ('owner',            'finance.ap.approve'),
  ('owner',            'finance.ap.read'),
  ('owner',            'finance.ap.reconcile'),
  ('owner',            'finance.ap.vendor_master'),

  ('platform_admin',   'finance.ap.approve'),
  ('platform_admin',   'finance.ap.bill_entry'),
  ('platform_admin',   'finance.ap.payment_release'),
  ('platform_admin',   'finance.ap.read'),
  ('platform_admin',   'finance.ap.reconcile'),
  ('platform_admin',   'finance.ap.vendor_master')
) AS v(role_name, perm_key)
JOIN roles       r ON r.company_id IS NULL AND r.name = v.role_name
JOIN permissions p ON p.key = v.perm_key
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
);
