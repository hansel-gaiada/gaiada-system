-- Finance F5b — the IAM half of AP vendor credits and write-offs (2026-08-27), for 202608272000.
--
-- Two grantable permissions on the EXISTING `finance_ap` Cerbos kind, plus ONE new segregation-of-
-- duties duty and TWO conflict pairs.
--
-- ── WHY A NEW DUTY HERE, WHEN AR NEEDED NONE ───────────────────────────────────────────────────
-- F4b needed no new duty because 202608241013 had already seeded `ar_writeoff_approve` and named it
-- "AR credit note / write-off approval" — the AR side was anticipated. The AP side was not: its
-- duties are `ap_bill_entry` (record), `ap_payment_approve` (authorise) and `ap_payment_release`
-- (custody), none of which covers reducing a liability without paying it.
--
-- Folding it into `ap_payment_approve` was rejected. Approving a payment and cancelling a debt are
-- different acts with different evidence: one produces money leaving and a bank line to match, the
-- other produces nothing to match at all, which is exactly why it needs its own binding.
--
-- ── THE TWO CONFLICTS, AND WHY BOTH ARE BLOCKING ───────────────────────────────────────────────
--   ap_bill_entry + ap_credit_writeoff_approve
--       Enter a bill, then credit it away. The paperwork nets to nothing and the expense account
--       carries a debit and a credit nobody reconciles. The AP mirror of the AR lapping pair.
--
--   ap_credit_writeoff_approve + ap_payment_release
--       Release the payment somewhere it should not go, then write the payable off so nothing is
--       left outstanding to chase. This is the strongest of the two and the direct analogue of
--       `ar_receipt_posting + ar_writeoff_approve` — "pocket the cash, then write off the debt",
--       with the cash running the other way.
--
-- Stored canonically (duty_a < duty_b) per `ck_finance_sod_conflicts_order`:
--   'ap_bill_entry'              < 'ap_credit_writeoff_approve'
--   'ap_credit_writeoff_approve' < 'ap_payment_release'
--
-- ── THE TIERS ───────────────────────────────────────────────────────────────────────────────────
--   finance_staff   NEITHER. The AP clerk enters bills; letting the same person cancel them is the
--                   first conflict above, structurally rather than by configuration.
--   finance_manager both.
--   company_admin   both — cancelling a debt is a governance decision.
--   owner           mirrors company_admin. ⚠ NOT automatic (IAM-14's one-time INSERT..SELECT).
--   platform_admin  both.
--
-- `write_off` additionally requires high assurance in the Cerbos policy; `credit_note` does not,
-- for the frequency argument F4b sets out — a purchase return is routine traffic and a step-up in
-- front of every one of them gets the step-up granted away permanently.
--
-- ROLE-ARM ONLY, no perm_* mirror. Additive.

INSERT INTO finance_duties (key, name, control_function, description)
SELECT 'ap_credit_writeoff_approve', 'AP vendor credit / write-off approval', 'authorise',
       'Reduce or cancel what the company owes a vendor without paying it'
WHERE NOT EXISTS (SELECT 1 FROM finance_duties WHERE key = 'ap_credit_writeoff_approve');

INSERT INTO finance_sod_conflicts (duty_a, duty_b, severity, rationale)
SELECT v.a, v.b, 'blocking', v.r
FROM (VALUES
  ('ap_bill_entry', 'ap_credit_writeoff_approve',
   'Enter a bill, then credit it away — the paperwork nets to nothing'),
  ('ap_credit_writeoff_approve', 'ap_payment_release',
   'Divert the payment, then write off the debt so nothing is left to chase')
) AS v(a, b, r)
WHERE NOT EXISTS (
  SELECT 1 FROM finance_sod_conflicts c WHERE c.duty_a = v.a AND c.duty_b = v.b);

INSERT INTO permissions (id, key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description, v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('finance.ap.credit_note', 'finance', 'ap', 'credit_note',
   'Raise and issue an AP vendor credit (purchase return, over-billing or agreed discount). Reduces the payable, reverses INPUT VAT, and unwinds any withholding — which makes an amended bukti potong necessary.',
   'finance_ap', 'credit_note', 'grantable', true, true),
  ('finance.ap.write_off', 'finance', 'ap', 'write_off',
   'Write off a payable the company will not pay. Credits OTHER INCOME, not an expense — released debt is taxable income.',
   'finance_ap', 'write_off', 'grantable', true, true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
  ('company_admin',   'finance.ap.credit_note'),
  ('company_admin',   'finance.ap.write_off'),
  ('finance_manager', 'finance.ap.credit_note'),
  ('finance_manager', 'finance.ap.write_off'),
  ('owner',           'finance.ap.credit_note'),
  ('owner',           'finance.ap.write_off'),
  ('platform_admin',  'finance.ap.credit_note'),
  ('platform_admin',  'finance.ap.write_off')
) AS v(role_name, perm_key)
JOIN roles       r ON r.company_id IS NULL AND r.name = v.role_name
JOIN permissions p ON p.key = v.perm_key
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id);

-- Assert, rather than trust — the ui_grantable invariant that took nine files red on 2026-08-27
-- when 202608271400 inserted a grantable non-portal key with ui_grantable = false.
DO $$
DECLARE v_bad integer;
BEGIN
  SELECT count(*) INTO v_bad FROM permissions
   WHERE ui_grantable IS NOT TRUE AND class <> 'relationship' AND key NOT LIKE 'portal.%';
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'IAM_UI_GRANTABLE_INVARIANT_BROKEN: % non-relationship, non-portal permission(s) are ui_grantable=false', v_bad;
  END IF;
END $$;
