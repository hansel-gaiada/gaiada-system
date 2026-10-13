-- 202610132115_pv5_invoice_numbering.sql — PV-5 / PV5-04b: invoice numbers per ruling PV-D35.
-- Plan: docs/plans/2026-10-12-pv5-contracts-billing-tickets.md (design decision 3, PV5-Q3);
-- ruling: docs/plans/2026-10-10-three-perspectives.md, row PV-D35. PV-D13: no company names or ids anywhere in this file.
--
-- An invoice number now reads `{company}/{yyyy}/{mm}/{code}/{nnnn}`, e.g. `GDA/2026/10/7K3/0001`:
--   {company}  the billing profile's invoice_prefix (unchanged);
--   {code}     a short ALPHANUMERIC code for (service line, the client's business type), looked up in each company's
--              billing settings and deliberately NOT mnemonic: a client cannot easily read it, staff decode it in the ERP;
--   {nnnn}     per company per MONTH, never per code, so numbering stays gap-free for audit.
--
-- WHAT THIS ADDS
--   billing_service_lines    : the company's service lines (data, never hard-coded). Unique (tenant_id, key).
--                              department_id (an org-node id, free text like projects.department_id) optionally links a
--                              line to a department so an invoice can DEFAULT to it. Deactivated, never deleted.
--   billing_number_codes     : the decode table (tenant, service line, business type) -> code. A code is assigned the
--                              first time a pair is needed and then NEVER changes and is never reused: a trigger refuses
--                              any UPDATE or DELETE and the runtime role has neither grant.
--   billing_number_code()    : returns the pair's code, GENERATING one (random, 3 characters, from an alphabet without
--                              O, 0, I, 1, L) on first use. A per-company advisory transaction lock makes two concurrent
--                              first uses agree on ONE code; the issue transaction calls it, so a rolled-back issue
--                              leaves no code behind.
--   invoices.service_line_key, invoices.number_code : the line chosen by staff (nullable until issue) and the code the
--                              number carries (written at issue). Both are FROZEN with the other invoice-of-record
--                              columns: pv5_invoices_issued_immutable() is redefined below with the two extra columns.
--   document_series.month    : smallint NOT NULL DEFAULT 0. 0 is the legacy YEARLY counter (every existing row keeps its
--                              counter, asserted below); 1..12 is a monthly counter. The primary key gains `month`.
--   next_document_no(uuid, text, integer, smallint) : the monthly counter. The 3-argument function stays for old callers
--                              and now delegates with month 0 (see "WHY THE 3-ARGUMENT FUNCTION IS REDEFINED").
--
-- ── WHY THE 3-ARGUMENT FUNCTION IS REDEFINED ──────────────────────────────────────────────────────
-- Left exactly as it was, its `SELECT ... WHERE tenant_id AND series AND year FOR UPDATE` would match the new monthly rows
-- as well as the yearly one and lock/advance an ARBITRARY one of them. It keeps its signature and its behaviour (the
-- yearly counter), by delegating to the 4-argument function with month 0. Credit notes and receipts still use it.
--
-- ── RLS ────────────────────────────────────────────────────────────────────────────────────────────
-- Both new tables: ENABLE + FORCE RLS and the CORE tenant policy (NULLIF-hardened: an unset GUC reads ZERO rows), the
-- shape of 202610130400 §11. Core, not the finance module wall, for the reason company_billing_profiles is: issue
-- readiness must be able to say "no service line" separately from "the finance module is off". They are not finance_*
-- tables. Neither table is ever read by a portal route (the code table is staff-only).
--
-- ── GRANTS (security-relevant; NO existing grant is widened) ───────────────────────────────────────
-- platform_app: billing_service_lines gets no DELETE (a line is deactivated, because invoices reference it);
-- billing_number_codes gets SELECT and INSERT only (a code is a record: no UPDATE, no DELETE). sync_app gets NOTHING.
-- Both guards are on the role existing (dev/test have one shared role).
--
-- ── ROLLOUT ────────────────────────────────────────────────────────────────────────────────────────
-- Additive and inert until the code ships: live has issued no invoice, so no old-format number exists. Brief ACCESS
-- EXCLUSIVE locks on invoices and document_series. The only DML is the assertion's read of document_series, under each
-- company's tenant GUC (the migration owner is NOBYPASSRLS, so an unscoped read would see zero rows and prove nothing).
-- Reverse (before PV5-04b code issues a number): DROP the two tables, billing_number_code(), the 4-argument
-- next_document_no(), restore the 3-argument one from 202610130400, restore pv5_invoices_issued_immutable() from
-- 202610130400, DROP invoices.service_line_key/number_code and their constraints, and re-create document_series' PK on
-- (tenant_id, series, year) after DROP COLUMN month.

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 0 · Preconditions
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF to_regclass('public.document_series') IS NULL OR to_regclass('public.company_billing_profiles') IS NULL THEN
    RAISE EXCEPTION 'PV5-04b: 202610130400 has not run (document_series / company_billing_profiles missing)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_series_pkey') THEN
    RAISE EXCEPTION 'PV5-04b: document_series_pkey is missing; cannot add month to the key';
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 1 · document_series.month, the new key, and the monthly next_document_no()
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- Counters before and after are compared under each company's tenant GUC (RLS-aware, see the header).
DO $$
DECLARE
  co record;
  before_n bigint := 0;
  before_sum bigint := 0;
  after_n bigint := 0;
  after_sum bigint := 0;
  odd bigint := 0;
  k bigint;
  s bigint;
BEGIN
  FOR co IN SELECT id FROM companies ORDER BY id LOOP
    PERFORM set_config('app.current_tenant_ids', co.id::text, true);
    SELECT count(*), COALESCE(sum(next_no), 0) INTO k, s FROM document_series;
    before_n := before_n + k;
    before_sum := before_sum + s;
  END LOOP;
  PERFORM set_config('app.current_tenant_ids', '', true);

  ALTER TABLE document_series ADD COLUMN month smallint NOT NULL DEFAULT 0;
  ALTER TABLE document_series ADD CONSTRAINT document_series_month_range CHECK (month BETWEEN 0 AND 12);
  ALTER TABLE document_series DROP CONSTRAINT document_series_pkey;
  ALTER TABLE document_series ADD CONSTRAINT document_series_pkey PRIMARY KEY (tenant_id, series, year, month);

  FOR co IN SELECT id FROM companies ORDER BY id LOOP
    PERFORM set_config('app.current_tenant_ids', co.id::text, true);
    SELECT count(*), COALESCE(sum(next_no), 0), count(*) FILTER (WHERE month <> 0) INTO k, s, odd FROM document_series;
    after_n := after_n + k;
    after_sum := after_sum + s;
    IF odd <> 0 THEN
      RAISE EXCEPTION 'PV5-04b: % existing document_series row(s) of company % did not get month 0', odd, co.id;
    END IF;
  END LOOP;
  PERFORM set_config('app.current_tenant_ids', '', true);

  IF before_n <> after_n OR before_sum <> after_sum THEN
    RAISE EXCEPTION 'PV5-04b: document_series counters changed (rows % -> %, counter sum % -> %)', before_n, after_n, before_sum, after_sum;
  END IF;
  RAISE NOTICE '[PV5-04b] document_series: % existing row(s) kept their counters (all month 0)', after_n;
END $$;

CREATE OR REPLACE FUNCTION next_document_no(p_tenant uuid, p_series text, p_year integer, p_month smallint)
  RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v integer;
BEGIN
  -- Exactly the 202610130400 logic, one level finer: the caller's transaction holds the row lock until commit, so a
  -- rollback returns the number and concurrent callers serialise. p_month 0 is the legacy yearly counter, 1..12 monthly.
  INSERT INTO document_series (tenant_id, series, year, month, next_no)
  VALUES (p_tenant, p_series, p_year, p_month, 1)
  ON CONFLICT DO NOTHING;

  SELECT next_no INTO v FROM document_series
   WHERE tenant_id = p_tenant AND series = p_series AND year = p_year AND month = p_month
     FOR UPDATE;
  IF v IS NULL THEN
    RAISE EXCEPTION 'PV5_SERIES_NOT_VISIBLE: no % series row for % / % / % in this tenant context', p_series, p_tenant, p_year, p_month;
  END IF;

  UPDATE document_series SET next_no = v + 1
   WHERE tenant_id = p_tenant AND series = p_series AND year = p_year AND month = p_month;
  RETURN v;
END
$$;
COMMENT ON FUNCTION next_document_no(uuid, text, integer, smallint) IS
  'PV5-04b: the next number of a gapless per-company series for one (year, month); month 0 is the legacy yearly counter. The CALLER''S transaction holds the row lock, so a rollback returns the number and concurrent callers serialise.';

-- The yearly counter keeps its signature and behaviour for old callers (credit notes, receipts).
CREATE OR REPLACE FUNCTION next_document_no(p_tenant uuid, p_series text, p_year integer)
  RETURNS integer LANGUAGE plpgsql AS $$
BEGIN
  RETURN next_document_no(p_tenant, p_series, p_year, 0::smallint);
END
$$;
COMMENT ON FUNCTION next_document_no(uuid, text, integer) IS
  'PV5-01, PV5-04b: the next number of the YEARLY series (month 0). Delegates to the 4-argument function.';

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 2 · billing_service_lines
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE billing_service_lines (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES companies(id),
  key           text NOT NULL,
  name          text NOT NULL,
  -- An org-node id as free text, exactly like projects.department_id (0029): no FK, the org tree is not a table here.
  department_id text,
  active        boolean NOT NULL DEFAULT true,
  updated_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ux_billing_service_lines_tenant_key UNIQUE (tenant_id, key),
  CONSTRAINT billing_service_lines_key_format CHECK (key ~ '^[a-z][a-z0-9_]{1,31}$'),
  CONSTRAINT billing_service_lines_name_nonblank CHECK (btrim(name) <> ''),
  CONSTRAINT billing_service_lines_department_nonblank CHECK (department_id IS NULL OR btrim(department_id) <> '')
);

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 3 · billing_number_codes — the decode table
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE billing_number_codes (
  tenant_id        uuid NOT NULL REFERENCES companies(id),
  service_line_key text NOT NULL,
  business_type    text NOT NULL,
  code             text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, service_line_key, business_type),
  -- Two pairs never share a code, so a code on an invoice decodes to exactly one pair.
  CONSTRAINT ux_billing_number_codes_tenant_code UNIQUE (tenant_id, code),
  CONSTRAINT billing_number_codes_code_format CHECK (code ~ '^[A-Z0-9]{2,4}$'),
  CONSTRAINT billing_number_codes_business_type_nonblank CHECK (btrim(business_type) <> ''),
  CONSTRAINT fk_billing_number_codes_service_line FOREIGN KEY (tenant_id, service_line_key)
    REFERENCES billing_service_lines (tenant_id, key)
);

-- A code is a record: once assigned it is never changed and never deleted (an invoice may already carry it, and a freed code
-- could be handed to another pair). A trigger, not only a grant: dev and test connect as a role with blanket DML, and the
-- owner is held to it too. Written for THIS table only.
CREATE OR REPLACE FUNCTION pv5_billing_number_codes_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'PV5_NUMBER_CODE_IMMUTABLE: the number code % for (%, %) is assigned and cannot be % (a code is never changed or reused)',
    OLD.code, OLD.service_line_key, OLD.business_type, CASE TG_OP WHEN 'DELETE' THEN 'deleted' ELSE 'changed' END
    USING ERRCODE = 'check_violation';
END
$$;
CREATE TRIGGER trg_billing_number_codes_immutable
  BEFORE UPDATE OR DELETE ON billing_number_codes
  FOR EACH ROW EXECUTE FUNCTION pv5_billing_number_codes_immutable();

-- The code of a pair, generated on first use. Runs as the CALLER (RLS applies), inside the caller's transaction.
--   * existing pair: returned, no lock taken;
--   * first use: a per-company advisory TRANSACTION lock serialises the generators, the pair is read again under it (a
--     concurrent first use that committed while we waited is returned, not duplicated), and only then is a code made.
-- The lock key is shared with the pre-assign endpoint (billing-numbering.controller.ts), which takes the same lock before
-- inserting a code it was given.
-- The alphabet has no O, 0, I, 1 or L (31 characters); the code is 3 random characters and is never derived from the key
-- or the business type, so it is not mnemonic. 31^3 = 29,791 codes per company.
CREATE OR REPLACE FUNCTION billing_number_code(p_tenant uuid, p_service_line text, p_business_type text)
  RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v text;
  cand text;
  i integer;
  tries integer := 0;
BEGIN
  SELECT code INTO v FROM billing_number_codes
   WHERE tenant_id = p_tenant AND service_line_key = p_service_line AND business_type = p_business_type;
  IF v IS NOT NULL THEN RETURN v; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('billing_number_code:' || p_tenant::text, 0));

  SELECT code INTO v FROM billing_number_codes
   WHERE tenant_id = p_tenant AND service_line_key = p_service_line AND business_type = p_business_type;
  IF v IS NOT NULL THEN RETURN v; END IF;

  LOOP
    tries := tries + 1;
    IF tries > 500 THEN
      RAISE EXCEPTION 'PV5_NUMBER_CODE_EXHAUSTED: could not find a free number code for company %', p_tenant;
    END IF;
    cand := '';
    FOR i IN 1..3 LOOP
      cand := cand || substr(alphabet, 1 + floor(random() * 31)::integer, 1);
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM billing_number_codes WHERE tenant_id = p_tenant AND code = cand) THEN
      INSERT INTO billing_number_codes (tenant_id, service_line_key, business_type, code)
      VALUES (p_tenant, p_service_line, p_business_type, cand);
      RETURN cand;
    END IF;
  END LOOP;
END
$$;
COMMENT ON FUNCTION billing_number_code(uuid, text, text) IS
  'PV5-04b: the number code of (service line, business type), generated on first use under a per-company advisory transaction lock. Call it only inside the issuing (or pre-assigning) transaction.';

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 4 · invoices.service_line_key / number_code, frozen with the rest of the invoice of record
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE invoices
  ADD COLUMN service_line_key text,
  ADD COLUMN number_code      text;

ALTER TABLE invoices
  -- MATCH SIMPLE: a NULL key (not chosen yet) is not checked; a chosen one must be a line of THIS company.
  ADD CONSTRAINT fk_invoices_service_line FOREIGN KEY (tenant_id, service_line_key)
    REFERENCES billing_service_lines (tenant_id, key),
  ADD CONSTRAINT invoices_number_code_format CHECK (number_code IS NULL OR number_code ~ '^[A-Z0-9]{2,4}$'),
  -- The code is written by the issue UPDATE together with issued_at; on an unissued row it would be a half-issued invoice.
  ADD CONSTRAINT invoices_number_code_needs_issue CHECK (number_code IS NULL OR issued_at IS NOT NULL);

CREATE INDEX ix_invoices_service_line ON invoices (tenant_id, service_line_key) WHERE service_line_key IS NOT NULL;

-- 202610130400's function, with the two new columns frozen too. Everything else is as it was.
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
       OR NEW.service_line_key IS DISTINCT FROM OLD.service_line_key
       OR NEW.number_code IS DISTINCT FROM OLD.number_code
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

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 5 · RLS + grants for the two new tables
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing_service_lines', 'billing_number_codes'] LOOP
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
  -- NARROWING (not a widening): lines are deactivated, never deleted; a code is a record, never rewritten or deleted.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_app') THEN
    REVOKE DELETE ON billing_service_lines FROM platform_app;
    REVOKE UPDATE, DELETE ON billing_number_codes FROM platform_app;
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 6 · Self-assertion
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  t text;
  c text;
  def text;
  cols text;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing_service_lines', 'billing_number_codes'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = format('public.%I', t)::regclass AND relrowsecurity AND relforcerowsecurity) THEN
      RAISE EXCEPTION 'PV5-04b: RLS is not ENABLED+FORCED on %', t;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = 'tenant_isolation') THEN
      RAISE EXCEPTION 'PV5-04b: tenant_isolation policy missing on %', t;
    END IF;
  END LOOP;

  FOREACH c IN ARRAY ARRAY[
    'billing_service_lines_key_format', 'billing_number_codes_code_format', 'invoices_number_code_format',
    'invoices_number_code_needs_issue', 'document_series_month_range'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c AND contype = 'c') THEN
      RAISE EXCEPTION 'PV5-04b: CHECK % is missing', c;
    END IF;
  END LOOP;
  FOREACH c IN ARRAY ARRAY['ux_billing_service_lines_tenant_key', 'ux_billing_number_codes_tenant_code'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c AND contype = 'u') THEN
      RAISE EXCEPTION 'PV5-04b: UNIQUE % is missing', c;
    END IF;
  END LOOP;
  FOREACH c IN ARRAY ARRAY['fk_billing_number_codes_service_line', 'fk_invoices_service_line'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c AND contype = 'f') THEN
      RAISE EXCEPTION 'PV5-04b: FK % is missing', c;
    END IF;
  END LOOP;

  -- The series key is now (tenant_id, series, year, month), and the default month is the legacy yearly counter.
  SELECT string_agg(a.attname, ',' ORDER BY k.ord) INTO cols
    FROM pg_constraint pc
    CROSS JOIN LATERAL unnest(pc.conkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = pc.conrelid AND a.attnum = k.attnum
   WHERE pc.conname = 'document_series_pkey' AND pc.conrelid = 'document_series'::regclass;
  IF cols IS DISTINCT FROM 'tenant_id,series,year,month' THEN
    RAISE EXCEPTION 'PV5-04b: document_series primary key is (%), expected (tenant_id,series,year,month)', cols;
  END IF;
  SELECT pg_get_expr(d.adbin, d.adrelid) INTO def
    FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
   WHERE d.adrelid = 'document_series'::regclass AND a.attname = 'month';
  IF def IS DISTINCT FROM '0' THEN
    RAISE EXCEPTION 'PV5-04b: document_series.month default is %, expected 0', def;
  END IF;

  IF (SELECT count(*) FROM pg_proc WHERE proname = 'next_document_no') <> 2 THEN
    RAISE EXCEPTION 'PV5-04b: expected both next_document_no() overloads (3 and 4 arguments)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'billing_number_code') THEN
    RAISE EXCEPTION 'PV5-04b: billing_number_code() is missing';
  END IF;
  FOREACH c IN ARRAY ARRAY['trg_billing_number_codes_immutable', 'trg_invoices_issued_immutable'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = c AND NOT tgisinternal) THEN
      RAISE EXCEPTION 'PV5-04b: trigger % is missing', c;
    END IF;
  END LOOP;
  SELECT prosrc INTO def FROM pg_proc WHERE proname = 'pv5_invoices_issued_immutable';
  IF def NOT LIKE '%service_line_key%' OR def NOT LIKE '%number_code%' THEN
    RAISE EXCEPTION 'PV5-04b: pv5_invoices_issued_immutable() does not freeze service_line_key and number_code';
  END IF;
END $$;

COMMENT ON TABLE billing_service_lines IS
  'PV5-04b: a company''s service lines (data). An invoice picks one before issue; its code in the invoice number comes from billing_number_codes. Deactivated, never deleted.';
COMMENT ON TABLE billing_number_codes IS
  'PV5-04b: the staff-only decode table (service line, business type) -> number code. Assigned once, never changed or reused. Never read by a portal route.';
