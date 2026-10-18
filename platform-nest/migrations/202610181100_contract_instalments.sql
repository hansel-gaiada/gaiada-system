-- 202610181100_contract_instalments.sql — DW-10f-1, the contract and invoice half of the data layer for contract billing.
-- Contract: docs/FRONTEND-BFF-CONTRACT.md §61.2 (data model), §61.3, §61.4a (DW-D49), §61.12 (RLS), §61.14 (proofs).
-- Plan: docs/plans/2026-10-13-department-workspaces.md §12.2 "10f design". Rulings DW-D45, DW-D48, DW-D49.
-- The time and payables half is the next file, 202610181101_freelancer_bills.sql.
--
-- WHAT THIS ADDS
--   contract_instalments (new, core): a contract's payment schedule, one row per instalment, and the claim
--                        (`invoice_id`) that makes "each instalment is invoiced once" a database fact.
--   contracts          : schedule_sha256 (fixed at send), schedule_added_at + schedule_added_by (DW-D49's one-time
--                        addition to a signed contract); four CHECKs.
--   contract_signatures: schedule_sha256 (copied from the contract by each signature insert; 10f-2a writes it).
--   contract_schedule_sha256(uuid, text, numeric): the ONE place the schedule's hash is computed.
--   Six triggers, one of them a deferred constraint trigger:
--     contract_instalments_guard           (contract_instalments, BEFORE INSERT/UPDATE/DELETE)  PD610, PD611
--     contracts_schedule_on_send           (contracts, BEFORE UPDATE OF status, draft -> sent)  PD612
--     contracts_terms_frozen               (contracts, BEFORE UPDATE, not a draft)              PD613, PD618
--     contracts_schedule_addition_complete (contracts, deferred constraint trigger)             PD618
--     invoices_release_instalments         (invoices, AFTER UPDATE OF status, deleted_at)       (releases claims)
--     invoices_instalment_unvoid_guard     (invoices, BEFORE UPDATE OF status, deleted_at)      PD614
--   Each trigger function is written for ONE table and names only that table's columns (plpgsql OLD/NEW resolve
--   against the triggering table), as PV-5's are. Trigger and function share a name (separate namespaces).
--
-- ── SQLSTATES (§61's range) ────────────────────────────────────────────────────────────────────────────────────────
--   PD610 schedule_frozen · PD611 instalment_claim_invalid · PD612 schedule_total_mismatch · PD613 contract_terms_frozen
--   PD614 invoice_unvoid_refused · PD618 schedule_addition_invalid. (PD615 to PD617 are the next file's.)
--
-- ── RLS AND THE "HIDDEN READS AS GONE" TRAP ────────────────────────────────────────────────────────────────────────
-- contract_instalments is on the PLAIN tenant wall (no module predicate), exactly like contracts, contract_signatures and
-- invoices: the portal reads it and the portal is not a module (§61.12). Every trigger here is SECURITY INVOKER and reads
-- contracts and invoices under the caller's own tenant set. That is sound ONLY because (a) the composite FKs pin an
-- instalment's contract and invoice to the instalment's own tenant, and (b) all four tables carry the same tenant-only
-- policy, so a session that can see the instalment it is writing can see its contract and its invoice. A parent that is
-- not found is therefore really gone (or the write is a referential action, which runs as the table owner with RLS off).
-- If either parent table ever gains a module predicate, this reasoning breaks: the release branches below would read a
-- hidden invoice as gone. The DO block at the end asserts the two parents' policies carry no app_module_allowed().
--
-- ── LOCKS ──────────────────────────────────────────────────────────────────────────────────────────────────────────
-- The guard takes FOR SHARE on the parent contract (insert, delete, term change, claim) and on the claimed invoice. So an
-- instalment insert racing a send waits for it and is then refused (the send's own SELECT ... FOR UPDATE conflicts), and a
-- claim racing a void of its invoice either waits and is refused, or commits first and is then released by the void's
-- trigger. Two concurrent claims of one instalment serialise on the instalment's row lock; the loser either re-reads a
-- claimed row (the handler's `AND invoice_id IS NULL` matches nothing) or is a move (PD611).
--
-- ── WHAT THE SEND TRIGGER DOES NOT SEE ─────────────────────────────────────────────────────────────────────────────
-- A contract INSERTED directly as sent or signed (seeds, fixtures) is not checked: draft -> sent is the only runtime path
-- to a sent contract, and that is where the check runs (§61.2). Instalments cannot be added to such a row afterwards
-- (PD610), except through DW-D49's two steps on a signed one.
--
-- ── IDEMPOTENT ─────────────────────────────────────────────────────────────────────────────────────────────────────
-- CREATE TABLE / ADD COLUMN / CREATE INDEX ... IF NOT EXISTS; constraints, policies and triggers dropped IF EXISTS and
-- created again; functions CREATE OR REPLACE. Applying the file twice raises nothing and changes no row.
--
-- ── GRANTS (security-relevant, stated for review; NO existing grant is widened) ───────────────────────────────────
-- platform_app gets SELECT/INSERT/UPDATE/DELETE on contract_instalments (it already receives DML on owner-created tables by
-- default privileges; the guarded GRANT restates it, the 202610130400 shape). sync_app gets NOTHING (REVOKE ALL): the hard
-- platform<->sync boundary; contracts and invoices are not in the sync writeback registry either.
--
-- ── ROLLOUT ────────────────────────────────────────────────────────────────────────────────────────────────────────
-- Additive; NO DML; nothing existing writes the new columns. No backfill: no existing contract has a schedule (§61.2).
-- Brief ACCESS EXCLUSIVE locks on contracts, contract_signatures and invoices while columns, CHECKs and triggers are added;
-- all are small tables. The CHECKs validate every existing row and hold trivially (the new columns are NULL).
-- BEHAVIOUR CHANGE that ships with this file: a contract with a value above zero can no longer move draft -> sent unless
-- its schedule adds up to the value and the UPDATE stores the hash (PD612); `POST contracts/:id/send` stores it in the
-- same change (contracts.controller.ts). Deploy the code with the migration (it boots and migrates in one step).
-- Reverse (before 10f-2a writes any schedule): drop the six triggers and their functions, contract_schedule_sha256(), the
-- table contract_instalments, the four contracts CHECKs and the FK, the three contracts columns, and the signatures column
-- and its CHECK. No company names or ids anywhere (PV-D13).

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 0 · Prerequisites: the composite uniques the new FKs point at (0075)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ux_contracts_id_tenant') THEN
    RAISE EXCEPTION 'DW-10f-1: ux_contracts_id_tenant (0075) is missing; the composite FK to contracts cannot be built';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ux_invoices_id_tenant') THEN
    RAISE EXCEPTION 'DW-10f-1: ux_invoices_id_tenant (0075) is missing; the composite FK to invoices cannot be built';
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 1 · contract_instalments — the schedule, and the claim
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS contract_instalments (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES companies(id),
  contract_id uuid NOT NULL,
  -- The order, 1 to N with no gaps (the handler writes them).
  position    smallint NOT NULL,
  label       text NOT NULL,
  -- In the contract's currency; the handler checks its precision against finance_currencies.minor_unit.
  amount      numeric(20,4) NOT NULL,
  due_kind    text NOT NULL,
  due_on      date,
  -- The claim: the ONE live invoice that bills this instalment.
  invoice_id  uuid,
  claimed_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE contract_instalments DROP CONSTRAINT IF EXISTS contract_instalments_position_ck;
ALTER TABLE contract_instalments DROP CONSTRAINT IF EXISTS contract_instalments_label_ck;
ALTER TABLE contract_instalments DROP CONSTRAINT IF EXISTS contract_instalments_amount_ck;
ALTER TABLE contract_instalments DROP CONSTRAINT IF EXISTS contract_instalments_due_kind_ck;
ALTER TABLE contract_instalments DROP CONSTRAINT IF EXISTS contract_instalments_due_ck;
ALTER TABLE contract_instalments DROP CONSTRAINT IF EXISTS contract_instalments_claim_ck;
ALTER TABLE contract_instalments DROP CONSTRAINT IF EXISTS fk_contract_instalments_contract_tenant;
ALTER TABLE contract_instalments DROP CONSTRAINT IF EXISTS fk_contract_instalments_invoice_tenant;
ALTER TABLE contract_instalments DROP CONSTRAINT IF EXISTS ux_contract_instalments_position;
ALTER TABLE contract_instalments DROP CONSTRAINT IF EXISTS ux_contract_instalments_id_tenant;

ALTER TABLE contract_instalments
  ADD CONSTRAINT contract_instalments_position_ck CHECK (position BETWEEN 1 AND 60),
  ADD CONSTRAINT contract_instalments_label_ck CHECK (btrim(label) <> '' AND length(label) <= 120),
  ADD CONSTRAINT contract_instalments_amount_ck CHECK (amount > 0),
  ADD CONSTRAINT contract_instalments_due_kind_ck CHECK (due_kind IN ('on_signing', 'date')),
  -- A date exactly when the kind is 'date'. (A CHECK passes on NULL; both sides here are booleans that are never NULL.)
  ADD CONSTRAINT contract_instalments_due_ck CHECK ((due_kind = 'date') = (due_on IS NOT NULL)),
  -- A claim names its invoice and when it was taken, or neither.
  ADD CONSTRAINT contract_instalments_claim_ck CHECK ((invoice_id IS NULL) = (claimed_at IS NULL)),
  -- Contracts are soft-deleted, so the cascade only ever meets a hard-deleted draft.
  ADD CONSTRAINT fk_contract_instalments_contract_tenant
    FOREIGN KEY (contract_id, tenant_id) REFERENCES contracts (id, tenant_id) ON DELETE CASCADE,
  -- Column-list SET NULL (PG 15+, the 0079 pattern): a hard-deleted draft invoice releases the claim and the row keeps its
  -- tenant. The guard trigger clears claimed_at in the same UPDATE, so contract_instalments_claim_ck holds.
  ADD CONSTRAINT fk_contract_instalments_invoice_tenant
    FOREIGN KEY (invoice_id, tenant_id) REFERENCES invoices (id, tenant_id) ON DELETE SET NULL (invoice_id),
  ADD CONSTRAINT ux_contract_instalments_position UNIQUE (contract_id, position),
  ADD CONSTRAINT ux_contract_instalments_id_tenant UNIQUE (id, tenant_id);

-- At most one "on signing" instalment per contract (partial: the dated rows are unconstrained).
CREATE UNIQUE INDEX IF NOT EXISTS ux_contract_instalments_on_signing
  ON contract_instalments (contract_id) WHERE due_kind = 'on_signing';
CREATE INDEX IF NOT EXISTS ix_contract_instalments_contract ON contract_instalments (tenant_id, contract_id);
-- "Which instalments does this invoice claim" (the release trigger and the readiness blockers).
CREATE INDEX IF NOT EXISTS ix_contract_instalments_invoice
  ON contract_instalments (tenant_id, invoice_id) WHERE invoice_id IS NOT NULL;
-- "What is due to invoice" (the billable read).
CREATE INDEX IF NOT EXISTS ix_contract_instalments_due
  ON contract_instalments (tenant_id, due_on) WHERE invoice_id IS NULL;

-- RLS: enabled + forced, one tenant_isolation policy, NULLIF-hardened (the 202610130400 shape): an UNSET GUC reads ZERO rows
-- and errors on nothing. NO module predicate (see the header).
ALTER TABLE contract_instalments ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_instalments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON contract_instalments;
CREATE POLICY tenant_isolation ON contract_instalments FOR ALL
  USING (tenant_id = ANY(string_to_array(NULLIF(current_setting('app.current_tenant_ids', true), ''), ',')::uuid[]))
  WITH CHECK (tenant_id = ANY(string_to_array(NULLIF(current_setting('app.current_tenant_ids', true), ''), ',')::uuid[]));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON contract_instalments TO platform_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sync_app') THEN
    REVOKE ALL ON contract_instalments FROM sync_app;
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 2 · contracts — the schedule hash, and DW-D49's who and when
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS schedule_sha256 text;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS schedule_added_at timestamptz;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS schedule_added_by uuid;

ALTER TABLE contracts DROP CONSTRAINT IF EXISTS contracts_schedule_sha256_format;
ALTER TABLE contracts DROP CONSTRAINT IF EXISTS contracts_schedule_draft_unset;
ALTER TABLE contracts DROP CONSTRAINT IF EXISTS contracts_schedule_added_pair;
ALTER TABLE contracts DROP CONSTRAINT IF EXISTS contracts_schedule_added_not_draft;
ALTER TABLE contracts DROP CONSTRAINT IF EXISTS fk_contracts_schedule_added_by;

ALTER TABLE contracts
  ADD CONSTRAINT contracts_schedule_sha256_format CHECK (schedule_sha256 IS NULL OR schedule_sha256 ~ '^[0-9a-f]{64}$'),
  -- A draft's schedule is not fixed yet, so it has no hash.
  ADD CONSTRAINT contracts_schedule_draft_unset CHECK (status <> 'draft' OR schedule_sha256 IS NULL),
  ADD CONSTRAINT contracts_schedule_added_pair CHECK ((schedule_added_at IS NULL) = (schedule_added_by IS NULL)),
  ADD CONSTRAINT contracts_schedule_added_not_draft CHECK (schedule_added_at IS NULL OR status <> 'draft'),
  ADD CONSTRAINT fk_contracts_schedule_added_by FOREIGN KEY (schedule_added_by) REFERENCES users (id);

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 3 · contract_signatures — which schedule a signature covers (copied from the contract, never from a request)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE contract_signatures ADD COLUMN IF NOT EXISTS schedule_sha256 text;
ALTER TABLE contract_signatures DROP CONSTRAINT IF EXISTS contract_signatures_schedule_sha256_format;
ALTER TABLE contract_signatures
  ADD CONSTRAINT contract_signatures_schedule_sha256_format
    CHECK (schedule_sha256 IS NULL OR schedule_sha256 ~ '^[0-9a-f]{64}$');

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 4 · contract_schedule_sha256() — the one place the schedule's hash is computed
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- NULL when the contract has no instalments. Otherwise the SHA-256 (lower-case hex) of the UTF-8 text of the jsonb
--   {"v": 1, "currency": <p_currency>, "value": <trim_scale(p_value)>,
--    "instalments": [{"position": n, "label": "...", "amount": <trim_scale(amount)>, "due": "on_signing" | "YYYY-MM-DD"}, ...]}
-- with the instalments in position order. jsonb's text form is canonical (keys sorted, fixed separators), and trim_scale
-- makes 60000000.0000 and 60000000 one value. The date is written with to_char, never ::text (which follows DateStyle).
-- The send, its trigger and the sealed copy's check all call this function; no TypeScript re-derives it.
-- SECURITY INVOKER and STABLE: it reads the instalments under the caller's tenant set (a caller with no tenant set reads
-- none and gets NULL, which never equals a stored hash).
CREATE OR REPLACE FUNCTION contract_schedule_sha256(p_contract uuid, p_currency text, p_value numeric)
  RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN count(*) = 0 THEN NULL ELSE
    encode(sha256(convert_to(
      jsonb_build_object(
        'v', 1,
        'currency', p_currency,
        'value', trim_scale(p_value),
        'instalments', jsonb_agg(
          jsonb_build_object(
            'position', i.position,
            'label', i.label,
            'amount', trim_scale(i.amount),
            'due', CASE WHEN i.due_kind = 'on_signing' THEN 'on_signing' ELSE to_char(i.due_on, 'YYYY-MM-DD') END
          ) ORDER BY i.position)
      )::text, 'UTF8')), 'hex')
  END
  FROM contract_instalments i
  WHERE i.contract_id = p_contract
$$;
COMMENT ON FUNCTION contract_schedule_sha256(uuid, text, numeric) IS
  'DW-10f (BFF §61.2): SHA-256 of a contract''s payment schedule in canonical jsonb form (v 1). NULL with no instalments. The only place the hash is computed: send, the send trigger, DW-D49''s closing step and the sealed copy all call it.';

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 5 · contract_instalments_guard — the freeze (PD610) and the claim (PD611)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION contract_instalments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  k      record;
  inv    record;
  v_n    integer;
  v_ok   boolean;
BEGIN
  -- ── INSERT: into a draft, or into DW-D49's open addition (signed, added_at set, hash still NULL) ──
  IF TG_OP = 'INSERT' THEN
    IF NEW.invoice_id IS NOT NULL OR NEW.claimed_at IS NOT NULL THEN
      RAISE EXCEPTION 'instalment_claim_invalid: an instalment is born unclaimed; a claim is an UPDATE (instalment %)', NEW.id
        USING ERRCODE = 'PD611';
    END IF;
    SELECT c.status, c.schedule_added_at, c.schedule_sha256 INTO k
      FROM contracts c WHERE c.id = NEW.contract_id AND c.tenant_id = NEW.tenant_id
       FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'schedule_frozen: no contract % in this company to schedule', NEW.contract_id
        USING ERRCODE = 'PD610';
    END IF;
    IF k.status = 'draft'
       OR (k.status = 'signed' AND k.schedule_added_at IS NOT NULL AND k.schedule_sha256 IS NULL) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'schedule_frozen: contract % is % and its schedule is fixed; instalments are added only to a draft (or by the one-time addition after signing)', NEW.contract_id, k.status
      USING ERRCODE = 'PD610';
  END IF;

  -- ── DELETE: only from a draft, or when the contract itself is gone (the cascade of a hard-deleted draft) ──
  IF TG_OP = 'DELETE' THEN
    SELECT c.status INTO k FROM contracts c WHERE c.id = OLD.contract_id AND c.tenant_id = OLD.tenant_id FOR SHARE;
    IF NOT FOUND OR k.status = 'draft' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'schedule_frozen: contract % is % and its schedule is fixed; an instalment cannot be deleted', OLD.contract_id, k.status
      USING ERRCODE = 'PD610';
  END IF;

  -- ── UPDATE (a): the terms of an instalment change only while its contract (old and new) is a draft ──
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.contract_id IS DISTINCT FROM OLD.contract_id
     OR NEW.position IS DISTINCT FROM OLD.position
     OR NEW.label IS DISTINCT FROM OLD.label
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.due_kind IS DISTINCT FROM OLD.due_kind
     OR NEW.due_on IS DISTINCT FROM OLD.due_on THEN
    SELECT c.status INTO k FROM contracts c WHERE c.id = OLD.contract_id AND c.tenant_id = OLD.tenant_id FOR SHARE;
    IF NOT FOUND OR k.status <> 'draft' THEN
      RAISE EXCEPTION 'schedule_frozen: the schedule of contract % is fixed; instalment % cannot change', OLD.contract_id, OLD.id
        USING ERRCODE = 'PD610';
    END IF;
    IF NEW.contract_id IS DISTINCT FROM OLD.contract_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
      SELECT c.status INTO k FROM contracts c WHERE c.id = NEW.contract_id AND c.tenant_id = NEW.tenant_id FOR SHARE;
      IF NOT FOUND OR k.status <> 'draft' THEN
        RAISE EXCEPTION 'schedule_frozen: instalment % can move only to a draft contract', OLD.id
          USING ERRCODE = 'PD610';
      END IF;
    END IF;
  END IF;

  -- ── UPDATE (b): the claim ──
  IF NEW.invoice_id IS DISTINCT FROM OLD.invoice_id THEN
    IF OLD.invoice_id IS NOT NULL AND NEW.invoice_id IS NOT NULL THEN
      RAISE EXCEPTION 'instalment_claim_invalid: instalment % is claimed by invoice %; a claim never moves to another invoice', OLD.id, OLD.invoice_id
        USING ERRCODE = 'PD611';
    END IF;

    IF NEW.invoice_id IS NULL THEN
      -- A release: the invoice is void, soft-deleted or gone (gone = a referential SET NULL, or a hard-deleted draft).
      SELECT i.status, i.deleted_at INTO inv FROM invoices i WHERE i.id = OLD.invoice_id AND i.tenant_id = OLD.tenant_id;
      IF FOUND AND inv.status <> 'void' AND inv.deleted_at IS NULL THEN
        RAISE EXCEPTION 'instalment_claim_invalid: invoice % is live (%); instalment % is released only when it is voided or deleted', OLD.invoice_id, inv.status, OLD.id
          USING ERRCODE = 'PD611';
      END IF;
      -- The referential SET NULL (invoice_id) clears only invoice_id; the claim's time goes with it.
      NEW.claimed_at := NULL;
      RETURN NEW;
    END IF;

    -- A claim (NULL -> X). The invoice: live, unissued, of the contract's client and currency, naming this instalment once
    -- at its amount.
    SELECT i.status, i.issued_at, i.deleted_at, i.client_id, i.currency, i.lines INTO inv
      FROM invoices i WHERE i.id = NEW.invoice_id AND i.tenant_id = NEW.tenant_id
       FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'instalment_claim_invalid: no invoice % in this company', NEW.invoice_id
        USING ERRCODE = 'PD611';
    END IF;
    IF inv.status NOT IN ('draft', 'approved') OR inv.issued_at IS NOT NULL OR inv.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'instalment_claim_invalid: invoice % is not a live unissued invoice (status %)', NEW.invoice_id, inv.status
        USING ERRCODE = 'PD611';
    END IF;
    -- The contract: signed, not deleted, and no signed version supersedes it.
    SELECT c.status, c.deleted_at, c.client_id, c.currency INTO k
      FROM contracts c WHERE c.id = NEW.contract_id AND c.tenant_id = NEW.tenant_id
       FOR SHARE;
    IF NOT FOUND OR k.status <> 'signed' OR k.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'instalment_claim_invalid: instalment % belongs to a contract that is not signed', NEW.id
        USING ERRCODE = 'PD611';
    END IF;
    IF EXISTS (SELECT 1 FROM contracts s
                WHERE s.tenant_id = NEW.tenant_id AND s.supersedes_id = NEW.contract_id
                  AND s.status = 'signed' AND s.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'instalment_claim_invalid: contract % is superseded by a signed version', NEW.contract_id
        USING ERRCODE = 'PD611';
    END IF;
    IF inv.client_id IS DISTINCT FROM k.client_id OR inv.currency IS DISTINCT FROM k.currency THEN
      RAISE EXCEPTION 'instalment_claim_invalid: invoice % is for another client or currency than contract %', NEW.invoice_id, NEW.contract_id
        USING ERRCODE = 'PD611';
    END IF;
    SELECT count(*),
           bool_and(CASE WHEN jsonb_typeof(e->'amount') = 'number' THEN (e->>'amount')::numeric = NEW.amount ELSE false END)
      INTO v_n, v_ok
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(inv.lines) = 'array' THEN inv.lines ELSE '[]'::jsonb END) AS e
     WHERE e->>'kind' = 'instalment' AND lower(e->>'instalmentId') = NEW.id::text;
    IF v_n <> 1 OR NOT COALESCE(v_ok, false) THEN
      RAISE EXCEPTION 'instalment_claim_invalid: invoice % must carry exactly one instalment line for % at its amount % (found %)', NEW.invoice_id, NEW.id, NEW.amount, v_n
        USING ERRCODE = 'PD611';
    END IF;
    RETURN NEW;
  END IF;

  -- ── UPDATE (c): the claim's time moves only with the claim ──
  IF NEW.claimed_at IS DISTINCT FROM OLD.claimed_at THEN
    RAISE EXCEPTION 'instalment_claim_invalid: claimed_at of instalment % changes only with its claim', OLD.id
      USING ERRCODE = 'PD611';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS contract_instalments_guard ON contract_instalments;
CREATE TRIGGER contract_instalments_guard
  BEFORE INSERT OR UPDATE OR DELETE ON contract_instalments
  FOR EACH ROW EXECUTE FUNCTION contract_instalments_guard();

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 6 · contracts_schedule_on_send — a valued contract is sent only with a schedule that adds up, and its hash (PD612)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION contracts_schedule_on_send() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_n     integer;
  v_total numeric;
BEGIN
  SELECT count(*), COALESCE(sum(i.amount), 0) INTO v_n, v_total
    FROM contract_instalments i WHERE i.contract_id = NEW.id AND i.tenant_id = NEW.tenant_id;
  IF NEW.value IS NOT NULL AND NEW.value > 0 THEN
    IF v_n = 0 OR v_total <> NEW.value THEN
      RAISE EXCEPTION 'schedule_total_mismatch: contract % has value % and a schedule of % instalment(s) totalling %', NEW.id, NEW.value, v_n, v_total
        USING ERRCODE = 'PD612';
    END IF;
  ELSIF v_n > 0 THEN
    RAISE EXCEPTION 'schedule_total_mismatch: contract % has no value, so it carries no schedule (found % instalment(s))', NEW.id, v_n
      USING ERRCODE = 'PD612';
  END IF;
  IF NEW.schedule_sha256 IS DISTINCT FROM contract_schedule_sha256(NEW.id, NEW.currency, NEW.value) THEN
    RAISE EXCEPTION 'schedule_total_mismatch: contract % is sent with a schedule_sha256 that is not its schedule''s hash', NEW.id
      USING ERRCODE = 'PD612';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS contracts_schedule_on_send ON contracts;
CREATE TRIGGER contracts_schedule_on_send
  BEFORE UPDATE OF status ON contracts
  FOR EACH ROW
  WHEN (OLD.status = 'draft' AND NEW.status = 'sent')
  EXECUTE FUNCTION contracts_schedule_on_send();

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 7 · contracts_terms_frozen — money and term columns freeze at send (PD613); DW-D49's two steps (PD618)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- PV-5's trg_contracts_content_frozen (file, body, hash, tier) is untouched; this covers the money and the terms.
--   Opening (DW-D49 step 2): schedule_added_at/_by NULL -> set, schedule_sha256 stays NULL, nothing else frozen moves,
--     status signed before and after, value > 0, not deleted, no instalments, no signed version supersedes it.
--   Closing (step 4): schedule_sha256 NULL -> contract_schedule_sha256(...), the addition open (added_at/_by set and
--     unchanged), nothing else frozen moves, status signed before and after, the instalments add up to value.
-- Any other change of a frozen column is PD613: in particular schedule_added_at, schedule_added_by or schedule_sha256 once
-- set, and a schedule_sha256 on a contract that opened no addition.
CREATE OR REPLACE FUNCTION contracts_terms_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_other boolean;
  v_open  boolean;
  v_close boolean;
  v_n     integer;
  v_total numeric;
BEGIN
  v_other := NEW.client_id IS DISTINCT FROM OLD.client_id
          OR NEW.project_id IS DISTINCT FROM OLD.project_id
          OR NEW.kind IS DISTINCT FROM OLD.kind
          OR NEW.amends_id IS DISTINCT FROM OLD.amends_id
          OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id
          OR NEW.version IS DISTINCT FROM OLD.version
          OR NEW.value IS DISTINCT FROM OLD.value
          OR NEW.currency IS DISTINCT FROM OLD.currency
          OR NEW.starts_on IS DISTINCT FROM OLD.starts_on
          OR NEW.ends_on IS DISTINCT FROM OLD.ends_on;
  v_open  := OLD.schedule_added_at IS NULL AND NEW.schedule_added_at IS NOT NULL;
  v_close := OLD.schedule_sha256 IS NULL AND NEW.schedule_sha256 IS NOT NULL;

  IF NOT v_open AND NOT v_close THEN
    IF v_other
       OR NEW.schedule_sha256 IS DISTINCT FROM OLD.schedule_sha256
       OR NEW.schedule_added_at IS DISTINCT FROM OLD.schedule_added_at
       OR NEW.schedule_added_by IS DISTINCT FROM OLD.schedule_added_by THEN
      RAISE EXCEPTION 'contract_terms_frozen: contract % is %; its client, project, kind, amendment and version links, value, currency, term and schedule cannot change (void it, or issue a new version)', OLD.id, OLD.status
        USING ERRCODE = 'PD613';
    END IF;
    RETURN NEW;
  END IF;

  -- One of DW-D49's two steps. Each is its own statement, changes nothing else, and keeps the contract signed.
  IF v_open AND v_close THEN
    RAISE EXCEPTION 'schedule_addition_invalid: contract %: opening an addition and fixing its hash are two steps', OLD.id
      USING ERRCODE = 'PD618';
  END IF;
  IF v_other THEN
    RAISE EXCEPTION 'schedule_addition_invalid: contract %: a step of the addition changes no other term', OLD.id
      USING ERRCODE = 'PD618';
  END IF;
  IF OLD.status <> 'signed' OR NEW.status <> 'signed' THEN
    RAISE EXCEPTION 'schedule_addition_invalid: contract % is % (asked %); a schedule is added after signing only to a signed contract', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'PD618';
  END IF;

  IF v_open THEN
    IF OLD.schedule_sha256 IS NOT NULL THEN
      RAISE EXCEPTION 'schedule_addition_invalid: contract % already has a schedule', OLD.id
        USING ERRCODE = 'PD618';
    END IF;
    IF NEW.value IS NULL OR NEW.value <= 0 THEN
      RAISE EXCEPTION 'schedule_addition_invalid: contract % has no value to schedule', OLD.id
        USING ERRCODE = 'PD618';
    END IF;
    IF NEW.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'schedule_addition_invalid: contract % is deleted', OLD.id
        USING ERRCODE = 'PD618';
    END IF;
    IF EXISTS (SELECT 1 FROM contract_instalments i WHERE i.contract_id = NEW.id AND i.tenant_id = NEW.tenant_id) THEN
      RAISE EXCEPTION 'schedule_addition_invalid: contract % already has instalments', OLD.id
        USING ERRCODE = 'PD618';
    END IF;
    IF EXISTS (SELECT 1 FROM contracts s
                WHERE s.tenant_id = NEW.tenant_id AND s.supersedes_id = NEW.id
                  AND s.status = 'signed' AND s.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'schedule_addition_invalid: contract % is superseded by a signed version', OLD.id
        USING ERRCODE = 'PD618';
    END IF;
    RETURN NEW;
  END IF;

  -- v_close
  IF OLD.schedule_added_at IS NULL
     OR NEW.schedule_added_at IS DISTINCT FROM OLD.schedule_added_at
     OR NEW.schedule_added_by IS DISTINCT FROM OLD.schedule_added_by THEN
    RAISE EXCEPTION 'schedule_addition_invalid: contract % has no open addition; its schedule_sha256 is set only at send or to close an addition', OLD.id
      USING ERRCODE = 'PD618';
  END IF;
  SELECT count(*), COALESCE(sum(i.amount), 0) INTO v_n, v_total
    FROM contract_instalments i WHERE i.contract_id = NEW.id AND i.tenant_id = NEW.tenant_id;
  IF v_n = 0 OR v_total <> NEW.value THEN
    RAISE EXCEPTION 'schedule_addition_invalid: contract % has value % and the added schedule totals % (% instalment(s))', OLD.id, NEW.value, v_total, v_n
      USING ERRCODE = 'PD618';
  END IF;
  IF NEW.schedule_sha256 IS DISTINCT FROM contract_schedule_sha256(NEW.id, NEW.currency, NEW.value) THEN
    RAISE EXCEPTION 'schedule_addition_invalid: contract %: schedule_sha256 is not the added schedule''s hash', OLD.id
      USING ERRCODE = 'PD618';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS contracts_terms_frozen ON contracts;
CREATE TRIGGER contracts_terms_frozen
  BEFORE UPDATE ON contracts
  FOR EACH ROW
  WHEN (OLD.status <> 'draft')
  EXECUTE FUNCTION contracts_terms_frozen();

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 8 · contracts_schedule_addition_complete — an addition is closed in the transaction that opened it (PD618)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Deferred to COMMIT and re-reads the row (the event's NEW is the row as that one statement left it). Fails CLOSED: a row
-- it cannot re-read (another tenant set by then) refuses the commit, so the open state can never outlive its transaction.
-- A NULL hash never matches: an addition opened with no instalments is refused too.
CREATE OR REPLACE FUNCTION contracts_schedule_addition_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  r record;
BEGIN
  SELECT c.id, c.currency, c.value, c.schedule_added_at, c.schedule_sha256 INTO r
    FROM contracts c WHERE c.id = NEW.id AND c.tenant_id = NEW.tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'schedule_addition_invalid: contract % cannot be re-read at commit to prove its addition is closed', NEW.id
      USING ERRCODE = 'PD618';
  END IF;
  IF r.schedule_added_at IS NOT NULL
     AND (r.schedule_sha256 IS NULL
          OR r.schedule_sha256 IS DISTINCT FROM contract_schedule_sha256(r.id, r.currency, r.value)) THEN
    RAISE EXCEPTION 'schedule_addition_invalid: contract %: a schedule added after signing must be closed with its hash in the same transaction', NEW.id
      USING ERRCODE = 'PD618';
  END IF;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS contracts_schedule_addition_complete ON contracts;
CREATE CONSTRAINT TRIGGER contracts_schedule_addition_complete
  AFTER UPDATE OF schedule_added_at, schedule_sha256 ON contracts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.schedule_added_at IS NOT NULL)
  EXECUTE FUNCTION contracts_schedule_addition_complete();

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 9 · invoices_release_instalments — voiding or soft-deleting an invoice releases its instalments
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Both doors: PATCH {status: 'void'} on an unissued draft, and POST .../void on an issued invoice. A hard delete of a draft
-- is the FK's SET NULL. The UPDATE runs under the caller's tenant set, which can see the invoice it just changed and so its
-- instalments (same tenant, same plain policy).
CREATE OR REPLACE FUNCTION invoices_release_instalments() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE contract_instalments
     SET invoice_id = NULL, claimed_at = NULL, updated_at = now()
   WHERE tenant_id = NEW.tenant_id AND invoice_id = NEW.id;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS invoices_release_instalments ON invoices;
CREATE TRIGGER invoices_release_instalments
  AFTER UPDATE OF status, deleted_at ON invoices
  FOR EACH ROW
  WHEN ((NEW.status = 'void' AND OLD.status IS DISTINCT FROM 'void')
        OR (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL))
  EXECUTE FUNCTION invoices_release_instalments();

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 10 · invoices_instalment_unvoid_guard — a released instalment invoice never comes back (PD614)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Its claims were released when it was voided (or soft-deleted) and may now be on another invoice. Hourly invoices keep
-- today's behaviour. The un-delete door is closed for the same reason (a stricter reading of §61.2's row, stated for review).
CREATE OR REPLACE FUNCTION invoices_instalment_unvoid_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(OLD.lines) = 'array' THEN OLD.lines ELSE '[]'::jsonb END) AS e
              WHERE e->>'kind' = 'instalment')
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.lines) = 'array' THEN NEW.lines ELSE '[]'::jsonb END) AS e
              WHERE e->>'kind' = 'instalment') THEN
    RAISE EXCEPTION 'invoice_unvoid_refused: invoice % carries instalment lines; its instalments were released when it was voided or deleted, so it cannot come back (draft a new invoice)', OLD.id
      USING ERRCODE = 'PD614';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS invoices_instalment_unvoid_guard ON invoices;
CREATE TRIGGER invoices_instalment_unvoid_guard
  BEFORE UPDATE OF status, deleted_at ON invoices
  FOR EACH ROW
  WHEN ((OLD.status = 'void' AND NEW.status <> 'void')
        OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL))
  EXECUTE FUNCTION invoices_instalment_unvoid_guard();

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 11 · Self-assertion: the catalog, by name. It counts NO rows (with no tenant set a count reads zero and lies).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  c   text;
  def text;
  n   integer;
BEGIN
  IF to_regclass('public.contract_instalments') IS NULL THEN
    RAISE EXCEPTION 'DW-10f-1: table contract_instalments was not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.contract_instalments'::regclass AND relrowsecurity AND relforcerowsecurity) THEN
    RAISE EXCEPTION 'DW-10f-1: RLS is not ENABLED+FORCED on contract_instalments';
  END IF;
  SELECT count(*) INTO n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contract_instalments';
  IF n <> 1 OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contract_instalments'
                             AND policyname = 'tenant_isolation' AND qual LIKE '%app.current_tenant_ids%'
                             AND qual NOT LIKE '%app_module_allowed%') THEN
    RAISE EXCEPTION 'DW-10f-1: contract_instalments must have exactly one tenant_isolation policy, with no module predicate (found %)', n;
  END IF;
  -- The guard's "not found = gone" reading holds only while the parents are on the same plain wall (see the header).
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('contracts', 'invoices')
               AND (qual LIKE '%app_module_allowed%' OR with_check LIKE '%app_module_allowed%')) THEN
    RAISE EXCEPTION 'DW-10f-1: contracts or invoices now carries a module predicate; contract_instalments_guard''s release reads would fail open';
  END IF;

  -- Columns.
  FOREACH c IN ARRAY ARRAY['id', 'tenant_id', 'contract_id', 'position', 'label', 'amount', 'due_kind', 'due_on',
                           'invoice_id', 'claimed_at', 'created_at', 'updated_at'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'contract_instalments' AND column_name = c) THEN
      RAISE EXCEPTION 'DW-10f-1: contract_instalments.% is missing', c;
    END IF;
  END LOOP;
  FOREACH c IN ARRAY ARRAY['schedule_sha256', 'schedule_added_at', 'schedule_added_by'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'contracts' AND column_name = c AND is_nullable = 'YES') THEN
      RAISE EXCEPTION 'DW-10f-1: contracts.% is missing or not nullable', c;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'contract_signatures' AND column_name = 'schedule_sha256') THEN
    RAISE EXCEPTION 'DW-10f-1: contract_signatures.schedule_sha256 is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'contract_instalments' AND column_name = 'amount'
                   AND numeric_precision = 20 AND numeric_scale = 4) THEN
    RAISE EXCEPTION 'DW-10f-1: contract_instalments.amount must be numeric(20,4)';
  END IF;

  -- CHECKs.
  FOREACH c IN ARRAY ARRAY['contract_instalments_position_ck', 'contract_instalments_label_ck', 'contract_instalments_amount_ck',
                           'contract_instalments_due_kind_ck', 'contract_instalments_due_ck', 'contract_instalments_claim_ck',
                           'contracts_schedule_sha256_format', 'contracts_schedule_draft_unset', 'contracts_schedule_added_pair',
                           'contracts_schedule_added_not_draft', 'contract_signatures_schedule_sha256_format'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c AND contype = 'c' AND convalidated) THEN
      RAISE EXCEPTION 'DW-10f-1: CHECK % is missing or not validated', c;
    END IF;
  END LOOP;

  -- FKs, with their referential actions.
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conname = 'fk_contract_instalments_contract_tenant' AND contype = 'f';
  IF def IS NULL OR def NOT LIKE '%(contract_id, tenant_id) REFERENCES contracts(id, tenant_id) ON DELETE CASCADE%' THEN
    RAISE EXCEPTION 'DW-10f-1: fk_contract_instalments_contract_tenant is missing or wrong: %', def;
  END IF;
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conname = 'fk_contract_instalments_invoice_tenant' AND contype = 'f';
  IF def IS NULL OR def NOT LIKE '%(invoice_id, tenant_id) REFERENCES invoices(id, tenant_id) ON DELETE SET NULL (invoice_id)%' THEN
    RAISE EXCEPTION 'DW-10f-1: fk_contract_instalments_invoice_tenant is missing or not SET NULL (invoice_id): %', def;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_contracts_schedule_added_by' AND contype = 'f') THEN
    RAISE EXCEPTION 'DW-10f-1: FK fk_contracts_schedule_added_by is missing';
  END IF;

  -- Uniques and indexes.
  FOREACH c IN ARRAY ARRAY['ux_contract_instalments_position', 'ux_contract_instalments_id_tenant'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c AND contype = 'u') THEN
      RAISE EXCEPTION 'DW-10f-1: UNIQUE % is missing', c;
    END IF;
  END LOOP;
  SELECT indexdef INTO def FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ux_contract_instalments_on_signing';
  IF def IS NULL OR def NOT LIKE 'CREATE UNIQUE INDEX%' OR def NOT LIKE '%on_signing%' THEN
    RAISE EXCEPTION 'DW-10f-1: ux_contract_instalments_on_signing is missing or not a partial UNIQUE index';
  END IF;
  FOREACH c IN ARRAY ARRAY['ix_contract_instalments_contract', 'ix_contract_instalments_invoice', 'ix_contract_instalments_due'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = c) THEN
      RAISE EXCEPTION 'DW-10f-1: index % is missing', c;
    END IF;
  END LOOP;

  -- Triggers (enabled), and the deferred one is a deferred constraint trigger.
  FOREACH c IN ARRAY ARRAY['contract_instalments_guard', 'contracts_schedule_on_send', 'contracts_terms_frozen',
                           'contracts_schedule_addition_complete', 'invoices_release_instalments',
                           'invoices_instalment_unvoid_guard'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = c AND NOT tgisinternal AND tgenabled = 'O') THEN
      RAISE EXCEPTION 'DW-10f-1: trigger % is missing or disabled', c;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'contracts_schedule_addition_complete'
                   AND tgconstraint <> 0 AND tgdeferrable AND tginitdeferred) THEN
    RAISE EXCEPTION 'DW-10f-1: contracts_schedule_addition_complete must be a DEFERRABLE INITIALLY DEFERRED constraint trigger';
  END IF;
  -- PV-5's content freeze is untouched.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_contracts_content_frozen' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'DW-10f-1: PV-5''s trg_contracts_content_frozen is missing';
  END IF;

  -- The function, by signature.
  IF to_regprocedure('contract_schedule_sha256(uuid, text, numeric)') IS NULL THEN
    RAISE EXCEPTION 'DW-10f-1: contract_schedule_sha256(uuid, text, numeric) is missing';
  END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid = to_regprocedure('contract_schedule_sha256(uuid, text, numeric)')) <> 's'
     OR (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('contract_schedule_sha256(uuid, text, numeric)')) THEN
    RAISE EXCEPTION 'DW-10f-1: contract_schedule_sha256 must be STABLE and SECURITY INVOKER';
  END IF;
END $$;

COMMENT ON TABLE contract_instalments IS
  'DW-10f (BFF §61.2): a contract''s payment schedule, one row per instalment, fixed at send (PD610). invoice_id is the claim: the one live invoice that bills it (PD611), released when that invoice is voided or deleted.';
COMMENT ON COLUMN contracts.schedule_sha256 IS
  'DW-10f: contract_schedule_sha256() of the schedule, stored by the send (PD612) or by DW-D49''s one-time addition after signing (PD618). Frozen once set (PD613).';
COMMENT ON COLUMN contracts.schedule_added_at IS
  'DW-D49: when Finance added a schedule to this already-signed contract (with schedule_added_by). NULL for a schedule fixed at send.';
COMMENT ON COLUMN contract_signatures.schedule_sha256 IS
  'DW-10f: the contract''s schedule_sha256 at the moment of signing, copied from the contract (never from a request). NULL for a contract with no schedule fixed at send.';
