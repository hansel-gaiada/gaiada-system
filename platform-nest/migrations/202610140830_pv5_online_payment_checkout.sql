-- 202610140830_pv5_online_payment_checkout.sql — PV-5 / PV5-10: online payment through a provider-hosted checkout.
-- Plan: docs/plans/2026-10-12-pv5-contracts-billing-tickets.md (PV5-10; finding 14, 15, 16; design decisions 14-17).
-- Rulings: PV-D9 (hosted checkout, a verified provider notice confirms with no staff step), PV-D25 (Midtrans),
-- PV-D13 (no company names or ids anywhere: the merchant company and every account code are configuration and data).
--
-- 202610130400 (PV5-01a) already created payment_checkouts, provider_events and invoice_payments.source/provider/
-- provider_payment_id/ar_receipt_id. This file adds only what the PV5-10 code needs on top, and is ADDITIVE.
--
-- WHAT THIS ADDS
--   1. THE PROVIDER'S AUTOMATION PRINCIPAL. One `users` row per provider (plan: "one users row per provider, created by
--      this ticket's migration and named in its header"):
--          id    a7100000-0000-4000-8000-000000000001
--          email midtrans@payments.automation.invalid      (RFC 2606 .invalid: never a deliverable address)
--          name  Midtrans (online payments)
--          kind  automation
--      It holds NO roles, NO membership and NO identity link, so it can never be minted as an HTTP principal by the
--      AuthGuard and Cerbos would deny it everything. It exists only so that `invoice_payments.recorded_by` /
--      `confirmed_by`, the AR receipt's journal actor and the activity row say truthfully who wrote the money. The
--      processing path checks no Cerbos rule (server-internal, like the GitHub receiver) and never goes through the
--      staff decide route or D14 (src/payments/webhook.controller.ts header). The id is also in
--      src/payments/registry.ts (PROVIDER_PRINCIPALS); a self-assertion below proves the row is there and is automation.
--   2. company_billing_profiles.gateway_clearing_account_code: the finance_accounts code a gateway payment's AR receipt
--      is booked into (DR clearing, CR AR). PER COMPANY DATA, set by Finance through PUT /billing-profile like the two
--      ledger codes PV5-01a added, and for the same reasons: account codes are per company and renumberable (D-F5), an env
--      var would apply one code to every company and could not be changed by Finance, and a code in code breaks PV-D13.
--      No FK (as bank_ledger_account_code): online payment is not offered while it does not resolve to a live, postable,
--      non-control account, and the processor names it if it disappears later.
--   3. provider_events gains the columns the asynchronous processor needs (the claim row IS the job; no new queue):
--        ref                  the provider's id for the checkout the notice is about (Midtrans order_id);
--        notice               a scrubbed copy of the notice (whitelisted fields, strings only; no card data, no secret);
--        attempts, next_attempt_at, last_error : the retry clock while status = 'received' (`error` stays reserved for
--                             the terminal 'failed' / 'ignored' reason, per 202610130400's CHECK);
--        outcome              what processing concluded, in words (also for 'processed' rows: "no payment: pending");
--        finance_notified_at  the once-only claim for telling Finance (a single UPDATE ... WHERE IS NULL).
--   4. payment_checkouts gains `environment` (sandbox | production: a checkout is only ever reused, re-checked or
--      expired with the key of the environment it was opened in) and `last_checked_at` (the reconciliation sweep's
--      clock: an unpaid checkout is re-checked with the provider before it is expired and for N days after, so a payment
--      whose notice was lost is still recorded). A composite unique (id, tenant_id) backs the FK below.
--   5. invoice_payments.checkout_id: the checkout a GATEWAY payment came through, composite FK inside the tenant, with a
--      PARTIAL UNIQUE index: one checkout can never yield two payments, at the database level. Only a gateway payment may
--      name one (CHECK); the processor always sets it. No backfill: no gateway payment exists before this file.
--
-- RLS / GRANTS: no new table. provider_events and company_billing_profiles keep their ENABLE+FORCE RLS and tenant
-- policies; columns inherit them. No grant changes (platform_app keeps no DELETE on provider_events). users carries no
-- RLS (it never has).
--
-- ROLLOUT: additive; safe before the code. Brief ACCESS EXCLUSIVE locks on four small tables. The one DML is the
-- principal INSERT (idempotent: ON CONFLICT DO NOTHING, then asserted). Reverse: drop the added columns and constraints;
-- the principal row can stay (it is referenced by any gateway payment ever written, so it must stay once one exists).

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 1 · The provider's automation principal
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
INSERT INTO users (id, email, name, status, kind, origin_site)
VALUES ('a7100000-0000-4000-8000-000000000001', 'midtrans@payments.automation.invalid', 'Midtrans (online payments)',
        'active', 'automation', 'central')
ON CONFLICT DO NOTHING;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 2 · The gateway clearing account, per company
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE company_billing_profiles
  ADD COLUMN gateway_clearing_account_code text;
ALTER TABLE company_billing_profiles
  ADD CONSTRAINT billing_profiles_clearing_code_format
    CHECK (gateway_clearing_account_code IS NULL OR gateway_clearing_account_code ~ '^[A-Za-z0-9._-]{1,32}$');
COMMENT ON COLUMN company_billing_profiles.gateway_clearing_account_code IS
  'PV5-10: finance_accounts code a payment-gateway receipt is booked into (DR clearing, CR AR). NULL = online payment is not offered. The provider payout (clearing -> bank) and its fee are posted by Finance by hand in v1.';

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 3 · provider_events: the processor's columns
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE provider_events
  ADD COLUMN ref                  text,
  ADD COLUMN notice               jsonb,
  ADD COLUMN attempts             integer NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at      timestamptz,
  ADD COLUMN last_error           text,
  ADD COLUMN outcome              text,
  ADD COLUMN finance_notified_at  timestamptz;

-- No row exists yet (nothing wrote provider_events before this ticket), so these validate against an empty table.
-- `ref` stays NULLABLE on purpose: 202610130400's own suite claims rows with no ref, and the webhook always writes one;
-- a payment claim with no ref is retried and then failed by the processor (it cannot be re-fetched), never paid.
ALTER TABLE provider_events
  ADD CONSTRAINT provider_events_ref_format     CHECK (ref IS NULL OR (length(ref) BETWEEN 1 AND 128)),
  ADD CONSTRAINT provider_events_notice_object  CHECK (notice IS NULL OR jsonb_typeof(notice) = 'object'),
  ADD CONSTRAINT provider_events_attempts_nonneg CHECK (attempts >= 0),
  -- The retry clock only runs while the event is still to be processed.
  ADD CONSTRAINT provider_events_retry_only_when_received CHECK (status = 'received' OR next_attempt_at IS NULL);

-- The sweep reads "received, due" per tenant; ix_provider_events_unsettled (tenant_id, status) already serves it.
CREATE INDEX ix_provider_events_ref ON provider_events (provider, ref) WHERE ref IS NOT NULL;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 4 · payment_checkouts: environment and the reconciliation clock
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- No checkout exists before PV5-10's code; the transient default only lets the NOT NULL column be added to a table that
-- is empty everywhere, and is dropped at once so every row states its environment explicitly.
ALTER TABLE payment_checkouts
  ADD COLUMN environment     text NOT NULL DEFAULT 'sandbox',
  ADD COLUMN last_checked_at timestamptz;
ALTER TABLE payment_checkouts ALTER COLUMN environment DROP DEFAULT;
ALTER TABLE payment_checkouts
  ADD CONSTRAINT payment_checkouts_environment_check CHECK (environment IN ('sandbox', 'production')),
  ADD CONSTRAINT ux_payment_checkouts_id_tenant UNIQUE (id, tenant_id);
-- The reconciliation sweep: unpaid checkouts by expiry.
CREATE INDEX ix_payment_checkouts_unpaid_expiry ON payment_checkouts (tenant_id, provider, expires_at) WHERE status <> 'paid';

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 5 · invoice_payments.checkout_id: one checkout, at most one payment
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE invoice_payments ADD COLUMN checkout_id uuid;
ALTER TABLE invoice_payments
  ADD CONSTRAINT fk_invoice_payments_checkout_tenant FOREIGN KEY (checkout_id, tenant_id)
    REFERENCES payment_checkouts (id, tenant_id),
  -- Only a gateway payment names a checkout. (The converse, "every gateway payment names one", is the processor's rule,
  -- not a CHECK: PV5-01a's own suite writes provider-only gateway rows to test its constraints.)
  ADD CONSTRAINT invoice_payments_checkout_gateway CHECK (checkout_id IS NULL OR source = 'gateway');
-- NULL defeats UNIQUE: partial over the gateway set.
CREATE UNIQUE INDEX ux_invoice_payments_checkout ON invoice_payments (checkout_id) WHERE checkout_id IS NOT NULL;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 6 · Self-assertion
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  k text;
  c text;
BEGIN
  SELECT kind INTO k FROM users WHERE id = 'a7100000-0000-4000-8000-000000000001' AND deleted_at IS NULL;
  IF k IS DISTINCT FROM 'automation' THEN
    RAISE EXCEPTION 'PV5-10: the Midtrans automation principal is missing or is not kind=automation (found %)', k;
  END IF;
  IF EXISTS (SELECT 1 FROM user_roles WHERE user_id = 'a7100000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'PV5-10: the Midtrans automation principal must hold no roles';
  END IF;
  FOREACH c IN ARRAY ARRAY['billing_profiles_clearing_code_format', 'provider_events_ref_format', 'provider_events_notice_object',
                           'provider_events_attempts_nonneg', 'provider_events_retry_only_when_received',
                           'payment_checkouts_environment_check', 'invoice_payments_checkout_gateway'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c AND contype = 'c') THEN
      RAISE EXCEPTION 'PV5-10: CHECK % is missing', c;
    END IF;
  END LOOP;
  SELECT indexdef INTO c FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ux_invoice_payments_checkout';
  IF c IS NULL OR c NOT LIKE 'CREATE UNIQUE INDEX%' OR c NOT LIKE '%WHERE%' THEN
    RAISE EXCEPTION 'PV5-10: ux_invoice_payments_checkout is missing or is not a partial UNIQUE index';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_invoice_payments_checkout_tenant' AND contype = 'f') THEN
    RAISE EXCEPTION 'PV5-10: FK fk_invoice_payments_checkout_tenant is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.provider_events'::regclass AND relrowsecurity AND relforcerowsecurity) THEN
    RAISE EXCEPTION 'PV5-10: provider_events lost ENABLE+FORCE RLS';
  END IF;
END $$;
