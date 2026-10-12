-- 202610130400_pv5_billing_data_model.sql — PV-5 / PV5-01 (part a): the data model for contracts & billing depth.
-- Plan: docs/plans/2026-10-12-pv5-contracts-billing-tickets.md (PV5-01; findings 1, 3, 5, 7, 9; decisions 1, 3, 4, 5, 11, 13).
-- Rulings: PV-D7 (the ledger is the invoice of record), PV-D8 (two signature tiers, content fixed at send),
-- PV-D9 (hosted checkout, verified provider notice), PV-D13 (no company names or ids anywhere).
--
-- THIS IS PART (a) OF TWO. It is purely ADDITIVE and inert for every existing code path: nothing here can
-- reject a row that today's code writes. The two CHECKs that DO reject today's writes (an invoice moving to
-- sent/paid without being issued; a non-draft contract with no content hash) live in part (b),
-- 202610130430_pv5_enforce_issue_and_fixed_content.sql, so (a) can merge on its own and (b) can merge together
-- with PV5-04 / PV5-06, which are the code that satisfies them. See (b)'s header for the legacy-exemption design.
--
-- WHAT THIS ADDS
--   New tables : company_billing_profiles, document_series (+ next_document_no()), payment_checkouts,
--                provider_events.
--   invoices            : invoice_no, issued_at, issued_by, issue_date, due_date, subtotal, tax_total, tax_code,
--                         issuer (frozen snapshot), ar_invoice_id; CHECKs; a trigger that freezes the
--                         invoice-of-record once issued_at is set.
--   finance_ar_customers: one live customer per client (partial unique + composite FK), counterparty_company_id.
--   contracts           : content_sha256, content_fixed_at, signature_tier, certified_requested; a trigger that
--                         freezes the hash, tier and content once the content is fixed.
--   contract_signatures : content_sha256, provider, provider_envelope_id.
--   files               : sha256; a trigger refusing to soft-delete a file referenced by a non-draft contract.
--   invoice_payments    : source, provider, provider_payment_id, ar_receipt_id; method CHECK gains 'online'.
--
-- ── RLS ────────────────────────────────────────────────────────────────────────────────────────────
-- Every new table: ENABLE + FORCE RLS and a `tenant_isolation` policy over the authorized-tenant set, exactly the
-- shape of 202610122330 (NULLIF-hardened, so an UNSET GUC reads ZERO rows and errors on nothing: the zero-row trap,
-- asserted on purpose in the tests).
--   * company_billing_profiles, document_series, payment_checkouts use the CORE policy, NOT the finance module
--     wall (app_module_allowed('finance')). Reason: issue-readiness must be able to say "the finance module is off"
--     and "there is no billing profile" as two separate reasons, which needs the profile readable with the module
--     off; the portal pay route writes payment_checkouts and is not a finance caller. The issue transaction itself
--     runs under withFinance() anyway (PV5-04), so the series row is reached with both walls up.
--   * provider_events is written BEFORE any session exists, by a webhook receiver. It is handled EXACTLY as
--     github_webhook_deliveries (202608311145) handles it: tenant_id is NOT NULL and the policy is the plain
--     tenant policy. The receiver never writes "before the tenant is known": it resolves the tenant from server
--     configuration (the company that owns the provider account, the way the GitHub receiver reads
--     config.githubRepoSync.tenantId), then claims inside withTenants([thatTenant]). The ticket text allowed a
--     tenant-less row; there is no tenant-less row here, because a table with no tenant predicate is not
--     protectable by RLS at all. If one provider account ever serves several companies, the tenant has to come from
--     the verified payload (checkout id -> payment_checkouts), which is PV5-10's design to settle, not a schema
--     loosening to make now.
--   * finance_ar_customers keeps its module wall untouched. It is the one existing finance table this file alters.
--
-- ── GRANTS (security-relevant, stated for review; NO existing grant is widened) ────────────────────
-- platform_app already receives DML on owner-created tables via ALTER DEFAULT PRIVILEGES; the guarded GRANT restates
-- it. sync_app gets NOTHING on any new table (the hard platform<->sync boundary). One NARROWING: DELETE is revoked
-- from platform_app on document_series (a deleted row would restart the number series at 1) and on provider_events
-- (a claim that can be deleted can be replayed). Both guards are on the role existing (dev/test have one shared role).
--
-- ── LEGACY AND NULL TRAPS HANDLED HERE ─────────────────────────────────────────────────────────────
--   * NULL defeats UNIQUE: invoice_no, ar_invoice_id, finance_ar_customers.client_id, provider_payment_id and
--     ar_receipt_id are nullable, so each uniqueness is a PARTIAL unique index over the NOT NULL set.
--   * A CHECK cannot be deferred, and plpgsql OLD/NEW resolve against the TRIGGERING table. Each trigger function
--     below is written for ONE table and names only that table's columns.
--   * invoice_payments.method: the CURRENT definition was read from the catalog (the only migration that ever
--     declared it is 0075: bank_transfer, card, cash, other). The swap below refuses to run if the catalog's
--     definition is not exactly that set, then re-declares the WHOLE list plus 'online'. Nothing is dropped.
--
-- ── FINANCE_AR_CUSTOMERS DUPLICATES: the migration fails loudly ────────────────────────────────────
-- A pre-check SELECT would be BLIND here: the migration owner is NOBYPASSRLS and finance_ar_customers is module
-- walled, so an unscoped SELECT returns zero rows and "finds no duplicates". The unique INDEX BUILD scans the heap
-- without RLS, so the build is the check; its unique_violation is caught and re-raised with an explanation.
-- Likewise the composite FK to clients validates every existing row; a customer whose client_id names a client of
-- another tenant, or no client, fails the migration. Nothing in the repo writes client_id today (grep), so live is
-- expected clean.
--
-- ── invoice_payments.source BACKFILL: none, and why ────────────────────────────────────────────────
-- The only application path that inserts invoice_payments is the portal's client claim
-- (portal-commerce.controller.ts); no staff "record payment" route exists. So every existing row is a
-- client_claim, which is the column default. Nothing can be told apart, so nothing is rewritten.
--
-- ── ROLLOUT ────────────────────────────────────────────────────────────────────────────────────────
-- Additive; safe to deploy before any code that uses it. Brief ACCESS EXCLUSIVE locks on invoices, contracts,
-- files, invoice_payments, finance_ar_customers while columns, indexes and (validated) constraints are added; all
-- are small tables. NO DML in this file. Reverse (before any PV5-04+ code writes): DROP the four tables and
-- next_document_no(); DROP the triggers and their functions; DROP the added columns, indexes and constraints;
-- restore invoice_payments_method_check to the four-value list. No existing row changes.

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 0 · Composite unique the new FKs rely on (0075 §0 pattern); trivially unique, so it cannot fail
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ux_clients_id_tenant') THEN
    RAISE EXCEPTION 'PV5-01: ux_clients_id_tenant (0075) is missing; the composite FK to clients cannot be built';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ux_invoices_id_tenant') THEN
    RAISE EXCEPTION 'PV5-01: ux_invoices_id_tenant (0075) is missing';
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 1 · company_billing_profiles — the issuer's identity and where clients pay (one row per company)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- NPWP and PKP are NOT here: finance_company_settings owns tax identity (decision 4), one source each.
CREATE TABLE company_billing_profiles (
  tenant_id                    uuid PRIMARY KEY REFERENCES companies(id),
  legal_name                   text NOT NULL,
  address                      text NOT NULL,
  -- {prefix}/{yyyy}/{nnnn}: the slash is the separator, so it cannot be in the prefix.
  invoice_prefix               text NOT NULL,
  default_payment_terms_days   integer NOT NULL DEFAULT 30,
  currency_code                text NOT NULL DEFAULT 'IDR' REFERENCES finance_currencies(code),
  -- The bank block clients pay into. Written only by the separate set_bank_details action (PV5-02), so it is
  -- nullable on its own: the profile exists before the bank block is set, and readiness reports it missing.
  bank_name                    text,
  bank_account_name            text,
  bank_account_no              text,
  -- finance_accounts codes (data, never hard-coded). No FK: accounts are unique per company only among LIVE rows
  -- and are renumberable (ruling D-F5); readiness resolves the code at issue time and names it if it is gone.
  bank_ledger_account_code     text,
  default_revenue_account_code text,
  -- PV-D8: NULL = no threshold (counsel has not set one).
  signature_threshold          numeric,
  updated_by                   uuid REFERENCES users(id),
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_profiles_legal_name_nonblank CHECK (btrim(legal_name) <> ''),
  CONSTRAINT billing_profiles_address_nonblank    CHECK (btrim(address) <> ''),
  CONSTRAINT billing_profiles_prefix_format       CHECK (invoice_prefix ~ '^[A-Z0-9-]{1,16}$'),
  CONSTRAINT billing_profiles_terms_range         CHECK (default_payment_terms_days BETWEEN 0 AND 365),
  CONSTRAINT billing_profiles_threshold_positive  CHECK (signature_threshold IS NULL OR signature_threshold > 0),
  -- The bank block is all-or-nothing: a name with no account number is a half-set block clients would copy.
  CONSTRAINT billing_profiles_bank_all_or_none CHECK (
    (bank_name IS NULL) = (bank_account_name IS NULL) AND (bank_name IS NULL) = (bank_account_no IS NULL)
  ),
  CONSTRAINT billing_profiles_bank_nonblank CHECK (
    bank_name IS NULL OR (btrim(bank_name) <> '' AND btrim(bank_account_name) <> '' AND btrim(bank_account_no) <> '')
  )
);

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 2 · document_series + next_document_no() — a GAPLESS number series per company, per series, per year
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- next_no is the number the NEXT caller gets. The caller's transaction holds the row lock from the SELECT ... FOR
-- UPDATE until it commits or rolls back, so a rollback returns the number (the UPDATE rolls back with it) and two
-- concurrent callers are serialised, never given the same number. This is the reason it is a table and not a
-- SEQUENCE: a sequence is non-transactional, so a rolled-back issue would burn a number and auditors read a gap as
-- a deleted invoice. Only the series 'invoice' is used for now; the format check lets a later series arrive with no
-- DDL (a widened IN-list CHECK would be the DROP+ADD re-declaration trap).
CREATE TABLE document_series (
  tenant_id  uuid NOT NULL REFERENCES companies(id),
  series     text NOT NULL,
  year       integer NOT NULL,
  next_no    integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, series, year),
  CONSTRAINT document_series_series_format CHECK (series ~ '^[a-z][a-z0-9_]{0,31}$'),
  CONSTRAINT document_series_year_range    CHECK (year BETWEEN 2000 AND 2999),
  CONSTRAINT document_series_next_positive CHECK (next_no >= 1)
);

CREATE OR REPLACE FUNCTION next_document_no(p_tenant uuid, p_series text, p_year integer)
  RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v integer;
BEGIN
  -- Create the counter row on first use. ON CONFLICT DO NOTHING waits for a concurrent first insert to commit
  -- or abort: if that caller rolls back, this one inserts its own row, so a rolled-back first number is returned too.
  -- Under RLS the WITH CHECK refuses a tenant outside the caller's authorized set, so numbers cannot be minted
  -- for another company.
  INSERT INTO document_series (tenant_id, series, year, next_no)
  VALUES (p_tenant, p_series, p_year, 1)
  ON CONFLICT DO NOTHING;

  SELECT next_no INTO v FROM document_series
   WHERE tenant_id = p_tenant AND series = p_series AND year = p_year
     FOR UPDATE;
  IF v IS NULL THEN
    RAISE EXCEPTION 'PV5_SERIES_NOT_VISIBLE: no % series row for % / % in this tenant context', p_series, p_tenant, p_year;
  END IF;

  UPDATE document_series SET next_no = v + 1
   WHERE tenant_id = p_tenant AND series = p_series AND year = p_year;
  RETURN v;
END
$$;
COMMENT ON FUNCTION next_document_no(uuid, text, integer) IS
  'PV5-01: hands out the next number of a gapless per-company/per-year series. The CALLER''S transaction holds the row lock, so a rollback returns the number and concurrent callers serialise. Never wrap it in its own transaction or call it outside the issuing transaction.';

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 3 · invoices — the invoice of record columns (PV-D7), a frozen issuer snapshot, and an immutability trigger
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE invoices
  ADD COLUMN invoice_no     text,
  ADD COLUMN issued_at      timestamptz,
  ADD COLUMN issued_by      uuid REFERENCES users(id),
  ADD COLUMN issue_date     date,
  ADD COLUMN due_date       date,
  ADD COLUMN subtotal       numeric,
  ADD COLUMN tax_total      numeric,
  ADD COLUMN tax_code       text,
  -- Frozen at issue (decision 5): legal name, address, NPWP, bank details as they were that day.
  ADD COLUMN issuer         jsonb,
  -- The 1:1 link to the ledger AR invoice (composite FK below keeps it inside the tenant).
  ADD COLUMN ar_invoice_id  uuid;

ALTER TABLE invoices
  ADD CONSTRAINT fk_invoices_ar_invoice_tenant FOREIGN KEY (ar_invoice_id, tenant_id)
    REFERENCES finance_ar_invoices (id, tenant_id),
  ADD CONSTRAINT invoices_due_after_issue CHECK (due_date IS NULL OR issue_date IS NULL OR due_date >= issue_date),
  ADD CONSTRAINT invoices_amounts_nonneg CHECK (
    (subtotal IS NULL OR subtotal >= 0) AND (tax_total IS NULL OR tax_total >= 0)
  ),
  ADD CONSTRAINT invoices_issuer_is_object CHECK (issuer IS NULL OR jsonb_typeof(issuer) = 'object'),
  -- Issued means ALL of it, at once. `total` stays the column every portal reader uses; once issued it must equal
  -- subtotal + tax_total, so a reader of either set of columns sees the same money.
  ADD CONSTRAINT invoices_issued_complete CHECK (
    issued_at IS NULL OR (
      invoice_no IS NOT NULL AND btrim(invoice_no) <> ''
      AND issue_date IS NOT NULL AND due_date IS NOT NULL
      AND issuer IS NOT NULL AND ar_invoice_id IS NOT NULL AND issued_by IS NOT NULL
      AND subtotal IS NOT NULL AND tax_total IS NOT NULL
      AND total = subtotal + tax_total
    )
  ),
  -- An issued invoice is sent, paid or void; never a draft or merely approved.
  ADD CONSTRAINT invoices_issued_status CHECK (issued_at IS NULL OR status IN ('sent', 'paid', 'void')),
  -- The converse half: a number, an issuer snapshot, a ledger link or an issuer id on an UNISSUED row is a
  -- half-issued invoice (and a burnt number). The issue transaction writes them in one UPDATE with issued_at.
  ADD CONSTRAINT invoices_no_half_issued CHECK (
    issued_at IS NOT NULL OR (invoice_no IS NULL AND issuer IS NULL AND ar_invoice_id IS NULL AND issued_by IS NULL)
  );

-- NULL defeats UNIQUE: partial over the issued set. Numbers are never reused, so soft-deleted rows count.
CREATE UNIQUE INDEX ux_invoices_tenant_invoice_no ON invoices (tenant_id, invoice_no) WHERE invoice_no IS NOT NULL;
CREATE UNIQUE INDEX ux_invoices_ar_invoice ON invoices (ar_invoice_id) WHERE ar_invoice_id IS NOT NULL;
-- Overdue is by due date (decision 10).
CREATE INDEX ix_invoices_due ON invoices (tenant_id, due_date) WHERE status = 'sent' AND deleted_at IS NULL;

-- The immutability trigger (decision 1): drift is prevented structurally. Once issued_at is set, only status (to
-- paid or void) and the updated_* stamps may change. Written for `invoices` only: every column named is invoices'.
CREATE OR REPLACE FUNCTION pv5_invoices_issued_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.issued_at IS NOT NULL THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.client_id IS DISTINCT FROM OLD.client_id
       OR NEW.period_start IS DISTINCT FROM OLD.period_start
       OR NEW.period_end IS DISTINCT FROM OLD.period_end
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.lines IS DISTINCT FROM OLD.lines
       OR NEW.total IS DISTINCT FROM OLD.total
       OR NEW.invoice_no IS DISTINCT FROM OLD.invoice_no
       OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
       OR NEW.issued_by IS DISTINCT FROM OLD.issued_by
       OR NEW.issue_date IS DISTINCT FROM OLD.issue_date
       OR NEW.due_date IS DISTINCT FROM OLD.due_date
       OR NEW.subtotal IS DISTINCT FROM OLD.subtotal
       OR NEW.tax_total IS DISTINCT FROM OLD.tax_total
       OR NEW.tax_code IS DISTINCT FROM OLD.tax_code
       OR NEW.issuer IS DISTINCT FROM OLD.issuer
       OR NEW.ar_invoice_id IS DISTINCT FROM OLD.ar_invoice_id
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
       OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
      RAISE EXCEPTION 'PV5_INVOICE_ISSUED_IMMUTABLE: invoice % is issued; its invoice-of-record columns, lines and client cannot change (void it instead)', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF OLD.status = 'void' OR NEW.status NOT IN ('paid', 'void') THEN
        RAISE EXCEPTION 'PV5_INVOICE_ISSUED_IMMUTABLE: issued invoice % can only move to paid or void (was %, asked %)', OLD.id, OLD.status, NEW.status
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trg_invoices_issued_immutable
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION pv5_invoices_issued_immutable();

CREATE OR REPLACE FUNCTION pv5_invoices_issued_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.issued_at IS NOT NULL THEN
    RAISE EXCEPTION 'PV5_INVOICE_ISSUED_IMMUTABLE: invoice % is issued and cannot be deleted', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$;
CREATE TRIGGER trg_invoices_issued_no_delete
  BEFORE DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION pv5_invoices_issued_no_delete();

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 4 · finance_ar_customers — one live customer per client; counterparty for group clients (finding 5, 6)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE finance_ar_customers
  ADD COLUMN counterparty_company_id uuid REFERENCES companies(id),
  ADD CONSTRAINT ck_finance_ar_customers_counterparty_not_self
    CHECK (counterparty_company_id IS NULL OR counterparty_company_id <> tenant_id);

-- Live rows only (the house pattern, as ux_finance_ar_customers_code_live): a soft-deleted customer must not block
-- billing the client again. See the header for why the BUILD is the duplicate check.
DO $$
BEGIN
  BEGIN
    CREATE UNIQUE INDEX ux_finance_ar_customers_client_live
      ON finance_ar_customers (tenant_id, client_id) WHERE client_id IS NOT NULL AND deleted_at IS NULL;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'PV5-01: two or more live finance_ar_customers share one client_id in a tenant; merge or archive the duplicates, then re-run (a client must map to one AR customer)';
  END;
END $$;

-- The FK validates every existing row (loud failure, by design: a client_id naming another tenant's client is a defect).
ALTER TABLE finance_ar_customers
  ADD CONSTRAINT fk_finance_ar_customers_client_tenant FOREIGN KEY (client_id, tenant_id)
    REFERENCES clients (id, tenant_id);

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 5 · contracts — content fixing and the signature tier (decisions 11, 13). The CHECK that REQUIRES them on
--     non-draft rows is part (b); this part adds the columns, format checks and the freeze trigger.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE contracts
  ADD COLUMN content_sha256       text,
  ADD COLUMN content_fixed_at     timestamptz,
  -- NULL while draft. Set at send and never changed (decision 13).
  ADD COLUMN signature_tier       text,
  ADD COLUMN certified_requested  boolean NOT NULL DEFAULT false;

ALTER TABLE contracts
  ADD CONSTRAINT contracts_content_sha256_format CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT contracts_signature_tier_check CHECK (signature_tier IS NULL OR signature_tier IN ('attested', 'certified')),
  -- A hash without the time it was fixed (or the reverse) is an incoherent record.
  ADD CONSTRAINT contracts_content_hash_stamped CHECK ((content_sha256 IS NULL) = (content_fixed_at IS NULL)),
  -- A draft carries none of it: tier and hash are born at send.
  ADD CONSTRAINT contracts_draft_not_fixed CHECK (
    status <> 'draft' OR (content_sha256 IS NULL AND content_fixed_at IS NULL AND signature_tier IS NULL)
  );

-- Once the content is fixed, what the hash covers (the attached file, else the body) and the hash, stamp and tier
-- are frozen. The controller already refuses edits to a non-draft contract; this makes it the database's rule too.
-- Written for `contracts` only.
CREATE OR REPLACE FUNCTION pv5_contracts_content_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.content_fixed_at IS NOT NULL THEN
    IF NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
       OR NEW.content_fixed_at IS DISTINCT FROM OLD.content_fixed_at
       OR NEW.signature_tier IS DISTINCT FROM OLD.signature_tier
       OR NEW.file_id IS DISTINCT FROM OLD.file_id
       OR NEW.body_md IS DISTINCT FROM OLD.body_md THEN
      RAISE EXCEPTION 'PV5_CONTRACT_CONTENT_FIXED: contract % has fixed content; its file, body, hash and signature tier cannot change (issue a new version)', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trg_contracts_content_frozen
  BEFORE UPDATE ON contracts
  FOR EACH ROW EXECUTE FUNCTION pv5_contracts_content_frozen();

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 6 · contract_signatures — which content each signature covers, and who signed it if not attested
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- (`signature_ref` exists since 0075 and stays untouched.)
ALTER TABLE contract_signatures
  ADD COLUMN content_sha256        text,
  ADD COLUMN provider              text,   -- NULL = attested (typed name)
  ADD COLUMN provider_envelope_id  text;
ALTER TABLE contract_signatures
  ADD CONSTRAINT contract_signatures_content_sha256_format CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT contract_signatures_envelope_has_provider CHECK (provider_envelope_id IS NULL OR provider IS NOT NULL);

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 7 · files — sha256, and a file under a non-draft contract cannot be soft-deleted (finding 9)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE files ADD COLUMN sha256 text;   -- nullable for old rows
ALTER TABLE files ADD CONSTRAINT files_sha256_format CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$');

-- Hard deletes are already refused by fk_contracts_file_tenant (no cascade); soft delete is the open door.
-- A voided contract still counts: it was sent, and its file is the record of what was sent.
CREATE OR REPLACE FUNCTION pv5_files_guard_contract_file() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM contracts c
     WHERE c.file_id = OLD.id AND c.tenant_id = OLD.tenant_id AND c.status <> 'draft'
  ) THEN
    RAISE EXCEPTION 'PV5_FILE_UNDER_CONTRACT: file % is attached to a contract that is no longer a draft and cannot be deleted', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER trg_files_guard_contract_file
  BEFORE UPDATE OF deleted_at ON files
  FOR EACH ROW
  WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION pv5_files_guard_contract_file();

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 8 · invoice_payments — where the payment came from, the provider's id, the ledger receipt; method gains 'online'
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  con text;
  def text;
  n   integer;
BEGIN
  SELECT count(*), max(conname::text), max(pg_get_constraintdef(oid)) INTO n, con, def
    FROM pg_constraint
   WHERE conrelid = 'invoice_payments'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%method%';
  IF n <> 1 THEN
    RAISE EXCEPTION 'PV5-01: expected exactly one CHECK on invoice_payments.method, found %', n;
  END IF;
  -- Refuse to guess: the swap re-declares the WHOLE list, so the current list must be exactly what we think it is.
  IF def NOT LIKE '%bank_transfer%' OR def NOT LIKE '%''card''%' OR def NOT LIKE '%''cash''%' OR def NOT LIKE '%''other''%'
     OR def LIKE '%online%' OR (length(def) - length(replace(def, ',', ''))) <> 3 THEN
    RAISE EXCEPTION 'PV5-01: invoice_payments.method CHECK is not the expected four-value list: %', def;
  END IF;
  EXECUTE format('ALTER TABLE invoice_payments DROP CONSTRAINT %I', con);
END $$;
ALTER TABLE invoice_payments
  ADD CONSTRAINT invoice_payments_method_check
    CHECK (method IN ('bank_transfer', 'card', 'cash', 'other', 'online'));

ALTER TABLE invoice_payments
  ADD COLUMN source               text NOT NULL DEFAULT 'client_claim',
  ADD COLUMN provider             text,
  ADD COLUMN provider_payment_id  text,
  ADD COLUMN ar_receipt_id        uuid;
ALTER TABLE invoice_payments
  ADD CONSTRAINT invoice_payments_source_check CHECK (source IN ('client_claim', 'staff', 'gateway')),
  ADD CONSTRAINT invoice_payments_provider_pair CHECK ((provider IS NULL) = (provider_payment_id IS NULL)),
  -- A gateway payment names its provider and payment and is method 'online'; 'online' is only ever a gateway payment.
  ADD CONSTRAINT invoice_payments_gateway_consistent CHECK (
    (source <> 'gateway' OR (provider IS NOT NULL AND method = 'online'))
    AND (method <> 'online' OR source = 'gateway')
  ),
  ADD CONSTRAINT fk_invoice_payments_ar_receipt_tenant FOREIGN KEY (ar_receipt_id, tenant_id)
    REFERENCES finance_ar_receipts (id, tenant_id);
CREATE UNIQUE INDEX ux_invoice_payments_provider_payment
  ON invoice_payments (provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL;
CREATE UNIQUE INDEX ux_invoice_payments_ar_receipt
  ON invoice_payments (ar_receipt_id) WHERE ar_receipt_id IS NOT NULL;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 9 · payment_checkouts — a provider-hosted checkout for an issued invoice's outstanding balance
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE payment_checkouts (
  id                    uuid PRIMARY KEY,
  tenant_id             uuid NOT NULL REFERENCES companies(id),
  invoice_id            uuid NOT NULL,
  client_id             uuid NOT NULL,
  amount                numeric(20,4) NOT NULL,
  currency_code         text NOT NULL REFERENCES finance_currencies(code),
  provider              text NOT NULL,
  provider_checkout_id  text NOT NULL,
  checkout_url          text NOT NULL,
  status                text NOT NULL DEFAULT 'open',
  expires_at            timestamptz NOT NULL,
  created_by            uuid REFERENCES users(id),
  origin_site           text NOT NULL DEFAULT 'central',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_checkouts_amount_positive CHECK (amount > 0),
  CONSTRAINT payment_checkouts_status_check CHECK (status IN ('open', 'paid', 'expired', 'failed')),
  CONSTRAINT payment_checkouts_provider_format CHECK (provider ~ '^[a-z][a-z0-9_]{0,31}$'),
  CONSTRAINT fk_payment_checkouts_invoice_tenant FOREIGN KEY (invoice_id, tenant_id) REFERENCES invoices (id, tenant_id),
  CONSTRAINT fk_payment_checkouts_client_tenant  FOREIGN KEY (client_id, tenant_id)  REFERENCES clients (id, tenant_id)
);
-- A provider's checkout id names one row; the webhook finds its checkout by it.
CREATE UNIQUE INDEX ux_payment_checkouts_provider_checkout ON payment_checkouts (provider, provider_checkout_id);
-- "Creates or reuses an open checkout": at most ONE open checkout per invoice.
CREATE UNIQUE INDEX ux_payment_checkouts_open_per_invoice ON payment_checkouts (invoice_id) WHERE status = 'open';
CREATE INDEX ix_payment_checkouts_invoice ON payment_checkouts (tenant_id, invoice_id);
-- The expiry sweep.
CREATE INDEX ix_payment_checkouts_expiry ON payment_checkouts (expires_at) WHERE status = 'open';

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 10 · provider_events — the dedupe claim for provider callbacks (the GitHub deliveries table's shape, adapted)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- INSERT ... ON CONFLICT (provider, event_id) DO NOTHING RETURNING id is the atomic claim: of N concurrent
-- deliveries of one event exactly one gets a row. `error` carries the reason for 'failed' AND for 'ignored'
-- (amount mismatch, unknown checkout, paid or void invoice). 'received' is written BEFORE the handler runs, so a
-- row stuck at 'received' is a handler that crashed mid-flight, visible to a future reconcile job.
CREATE TABLE provider_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      text NOT NULL,
  event_id      text NOT NULL,
  kind          text NOT NULL,
  tenant_id     uuid NOT NULL REFERENCES companies(id),
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  status        text NOT NULL DEFAULT 'received',
  error         text,
  origin_site   text NOT NULL DEFAULT 'central',
  CONSTRAINT provider_events_kind_check   CHECK (kind IN ('payment', 'signature')),
  CONSTRAINT provider_events_status_check CHECK (status IN ('received', 'processed', 'failed', 'ignored')),
  CONSTRAINT provider_events_provider_format CHECK (provider ~ '^[a-z][a-z0-9_]{0,31}$'),
  CONSTRAINT provider_events_error_only_when_unhappy CHECK (error IS NULL OR status IN ('failed', 'ignored')),
  CONSTRAINT ux_provider_events_provider_event UNIQUE (provider, event_id)
);
CREATE INDEX ix_provider_events_tenant_received ON provider_events (tenant_id, received_at DESC);
CREATE INDEX ix_provider_events_unsettled ON provider_events (tenant_id, status) WHERE status <> 'processed';

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 11 · RLS + grants for the four new tables
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['company_billing_profiles', 'document_series', 'payment_checkouts', 'provider_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I FOR ALL
        USING (tenant_id = ANY(string_to_array(NULLIF(current_setting('app.current_tenant_ids', true), ''), ',')::uuid[]))
        WITH CHECK (tenant_id = ANY(string_to_array(NULLIF(current_setting('app.current_tenant_ids', true), ''), ',')::uuid[]))
    $f$, t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO platform_app', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sync_app') THEN
      EXECUTE format('REVOKE ALL ON %I FROM sync_app', t);
    END IF;
  END LOOP;
  -- NARROWING (not a widening): the number series and the dedupe claims are never deleted by the runtime role.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_app') THEN
    REVOKE DELETE ON document_series FROM platform_app;
    REVOKE DELETE ON provider_events FROM platform_app;
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 12 · Self-assertion: a migration that cannot prove its own shape fails loudly instead of shipping
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  t text;
  c text;
  i text;
  def text;
BEGIN
  FOREACH t IN ARRAY ARRAY['company_billing_profiles', 'document_series', 'payment_checkouts', 'provider_events'] LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      RAISE EXCEPTION 'PV5-01: table % was not created', t;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = format('public.%I', t)::regclass AND relrowsecurity AND relforcerowsecurity) THEN
      RAISE EXCEPTION 'PV5-01: RLS is not ENABLED+FORCED on %', t;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = 'tenant_isolation') THEN
      RAISE EXCEPTION 'PV5-01: tenant_isolation policy missing on %', t;
    END IF;
  END LOOP;

  FOREACH c IN ARRAY ARRAY[
    'billing_profiles_prefix_format', 'billing_profiles_bank_all_or_none', 'document_series_series_format',
    'invoices_due_after_issue', 'invoices_issued_complete', 'invoices_issued_status', 'invoices_no_half_issued',
    'ck_finance_ar_customers_counterparty_not_self', 'contracts_content_sha256_format', 'contracts_signature_tier_check',
    'contracts_content_hash_stamped', 'contracts_draft_not_fixed', 'files_sha256_format',
    'invoice_payments_method_check', 'invoice_payments_source_check', 'invoice_payments_gateway_consistent',
    'payment_checkouts_status_check', 'provider_events_status_check'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c AND contype = 'c') THEN
      RAISE EXCEPTION 'PV5-01: CHECK % is missing', c;
    END IF;
  END LOOP;

  FOREACH c IN ARRAY ARRAY['fk_invoices_ar_invoice_tenant', 'fk_finance_ar_customers_client_tenant',
                           'fk_invoice_payments_ar_receipt_tenant', 'fk_payment_checkouts_invoice_tenant',
                           'fk_payment_checkouts_client_tenant'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c AND contype = 'f') THEN
      RAISE EXCEPTION 'PV5-01: FK % is missing', c;
    END IF;
  END LOOP;

  -- Every uniqueness over a nullable column must be a PARTIAL unique index (NULL defeats UNIQUE).
  FOREACH i IN ARRAY ARRAY['ux_invoices_tenant_invoice_no', 'ux_invoices_ar_invoice', 'ux_finance_ar_customers_client_live',
                           'ux_invoice_payments_provider_payment', 'ux_invoice_payments_ar_receipt',
                           'ux_payment_checkouts_open_per_invoice'] LOOP
    SELECT indexdef INTO def FROM pg_indexes WHERE schemaname = 'public' AND indexname = i;
    IF def IS NULL OR def NOT LIKE 'CREATE UNIQUE INDEX%' OR def NOT LIKE '%WHERE%' THEN
      RAISE EXCEPTION 'PV5-01: % is missing or is not a partial UNIQUE index', i;
    END IF;
  END LOOP;

  FOREACH c IN ARRAY ARRAY['trg_invoices_issued_immutable', 'trg_invoices_issued_no_delete',
                           'trg_contracts_content_frozen', 'trg_files_guard_contract_file'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = c AND NOT tgisinternal) THEN
      RAISE EXCEPTION 'PV5-01: trigger % is missing', c;
    END IF;
  END LOOP;

  -- The method list kept every old value and gained 'online'.
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conrelid = 'invoice_payments'::regclass AND conname = 'invoice_payments_method_check';
  IF def NOT LIKE '%bank_transfer%' OR def NOT LIKE '%''card''%' OR def NOT LIKE '%''cash''%'
     OR def NOT LIKE '%''other''%' OR def NOT LIKE '%''online''%' THEN
    RAISE EXCEPTION 'PV5-01: invoice_payments.method lost a value or did not gain online: %', def;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'next_document_no') THEN
    RAISE EXCEPTION 'PV5-01: next_document_no() is missing';
  END IF;
END $$;

COMMENT ON TABLE company_billing_profiles IS
  'PV5-01: the issuer''s legal identity and the bank account clients pay into, one row per company. NPWP/PKP stay in finance_company_settings. The bank block is written only by the set_bank_details action.';
COMMENT ON TABLE document_series IS
  'PV5-01: gapless per-company, per-year number series, advanced by next_document_no() inside the issuing transaction. Never deleted by the runtime role.';
COMMENT ON TABLE payment_checkouts IS
  'PV5-01: a provider-hosted checkout for the outstanding balance of an issued invoice. At most one open checkout per invoice.';
COMMENT ON TABLE provider_events IS
  'PV5-01: dedupe claim for provider callbacks (payment, signature). UNIQUE (provider, event_id) is the atomic claim. Tenant is resolved from server config before the claim, as with github_webhook_deliveries.';
