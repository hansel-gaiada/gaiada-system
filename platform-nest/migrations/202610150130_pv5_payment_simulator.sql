-- 202610150130_pv5_payment_simulator.sql — PV-D41 (owner, 2026-10-14): a SIMULATED Midtrans for the review stage.
-- Plan: docs/plans/2026-10-12-pv5-contracts-billing-tickets.md (PV5-10); contract BFF §30c "Simulated Midtrans".
--
-- "simulate midtrans for now": online payment works end to end on the review stage with no real keys and no real money,
-- in the spirit of PV-D40's simulated second factor: labelled, audited, flag-gated (PAYMENTS_SIMULATION_ENABLED), and
-- OFF before the ERP holds real data. The REAL Midtrans adapter, webhook, signature check, dedupe, status re-fetch and
-- posting all run unchanged; only the far end is our own in-process simulator (src/payments/simulator*.ts).
--
-- WHAT THIS ADDS
--   1. payment_simulator_orders: the simulator's own record of each Snap order and its transaction state (what Midtrans
--      would hold on its side). One row per order id. Tenant-scoped (tenant_id NOT NULL = MIDTRANS_TENANT_ID, the
--      merchant company), ENABLE + FORCE RLS and the house `tenant_isolation` policy (NULLIF-hardened: an unset GUC reads
--      ZERO rows). The simulator only ever reads it inside withTenants([MIDTRANS_TENANT_ID]). No FK to payment_checkouts on
--      purpose: the simulator stands in for an EXTERNAL system and must not know our tables (Midtrans does not); the
--      checkout is linked by the order id, as with the real provider.
--   2. payment_checkouts.environment gains 'simulated'. The CHECK is re-declared WHOLE (sandbox, production, simulated):
--      a DROP+ADD on a CHECK re-declares every value, so none is dropped. The environment rules (a checkout is reused,
--      re-checked or expired only with its own environment's key) keep simulated checkouts apart from real ones.
--
-- GRANTS: platform_app DML on the new table (restated, guarded on the role); sync_app nothing; DELETE revoked (the
-- simulator's history is the audit of what "the provider" said).
-- ROLLOUT: additive. Reverse: drop the table; re-declare the environment CHECK without 'simulated' (only after no
-- simulated checkout row remains).

CREATE TABLE payment_simulator_orders (
  order_id            text PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES companies(id),
  gross_amount        numeric(20,2) NOT NULL,
  currency            text NOT NULL DEFAULT 'IDR',
  -- NULL until the payer acts (Midtrans: no transaction exists until a payment method is chosen; status answers 404).
  transaction_status  text,
  status_code         text,
  transaction_id      text,
  fraud_status        text,
  payment_type        text,
  transaction_time    timestamptz,
  settlement_time     timestamptz,
  expires_at          timestamptz NOT NULL,
  -- The notices the simulator delivered (for the audit trail and the replay test).
  deliveries          integer NOT NULL DEFAULT 0,
  last_delivery_at    timestamptz,
  last_delivery_error text,
  origin_site         text NOT NULL DEFAULT 'central',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_simulator_orders_amount_positive CHECK (gross_amount > 0),
  CONSTRAINT payment_simulator_orders_order_format CHECK (order_id ~ '^[A-Za-z0-9._~-]{1,50}$'),
  CONSTRAINT payment_simulator_orders_status_check CHECK (
    transaction_status IS NULL OR transaction_status IN ('pending', 'settlement', 'deny', 'expire', 'cancel')
  ),
  -- A transaction, once it exists, has an id and a time.
  CONSTRAINT payment_simulator_orders_txn_complete CHECK (
    transaction_status IS NULL OR (transaction_id IS NOT NULL AND transaction_time IS NOT NULL AND status_code IS NOT NULL)
  )
);
CREATE INDEX ix_payment_simulator_orders_tenant ON payment_simulator_orders (tenant_id, created_at DESC);

ALTER TABLE payment_simulator_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_simulator_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_simulator_orders FOR ALL
  USING (tenant_id = ANY(string_to_array(NULLIF(current_setting('app.current_tenant_ids', true), ''), ',')::uuid[]))
  WITH CHECK (tenant_id = ANY(string_to_array(NULLIF(current_setting('app.current_tenant_ids', true), ''), ',')::uuid[]));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_app') THEN
    GRANT SELECT, INSERT, UPDATE ON payment_simulator_orders TO platform_app;
    REVOKE DELETE ON payment_simulator_orders FROM platform_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sync_app') THEN
    REVOKE ALL ON payment_simulator_orders FROM sync_app;
  END IF;
END $$;

-- payment_checkouts.environment: the whole list, plus 'simulated'.
ALTER TABLE payment_checkouts DROP CONSTRAINT payment_checkouts_environment_check;
ALTER TABLE payment_checkouts
  ADD CONSTRAINT payment_checkouts_environment_check CHECK (environment IN ('sandbox', 'production', 'simulated'));

-- Self-assertion.
DO $$
DECLARE def text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.payment_simulator_orders'::regclass AND relrowsecurity AND relforcerowsecurity) THEN
    RAISE EXCEPTION 'PV-D41: RLS is not ENABLED+FORCED on payment_simulator_orders';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'payment_simulator_orders' AND policyname = 'tenant_isolation') THEN
    RAISE EXCEPTION 'PV-D41: tenant_isolation policy missing on payment_simulator_orders';
  END IF;
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conrelid = 'payment_checkouts'::regclass AND conname = 'payment_checkouts_environment_check';
  IF def NOT LIKE '%sandbox%' OR def NOT LIKE '%production%' OR def NOT LIKE '%simulated%' THEN
    RAISE EXCEPTION 'PV-D41: payment_checkouts.environment lost a value or did not gain simulated: %', def;
  END IF;
END $$;

COMMENT ON TABLE payment_simulator_orders IS
  'PV-D41: the SIMULATED Midtrans''s own order/transaction records (review stage only, PAYMENTS_SIMULATION_ENABLED). Stands in for the provider side; no real money.';
