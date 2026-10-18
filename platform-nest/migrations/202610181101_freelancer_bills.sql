-- 202610181101_freelancer_bills.sql — DW-10f-1, the time and payables half of the data layer for freelancer bills.
-- Contract: docs/FRONTEND-BFF-CONTRACT.md §61.2 ("The time and payables half"), §61.7, §61.8, §61.12, §61.14.
-- Plan: docs/plans/2026-10-13-department-workspaces.md §12.2 "10f design". Rulings DW-D46, DW-D47.
-- The contract and invoice half is the previous file, 202610181100_contract_instalments.sql.
--
-- WHAT THIS ADDS
--   time_entries       : ap_bill_id, the claim that makes "each logged hour is paid once" a database fact; composite FK
--                        to finance_ap_bills ON DELETE SET NULL (ap_bill_id); two partial indexes.
--   finance_ap_vendors : user_id (the person a freelancer's vendor pays), at most one live vendor per person and company.
--   finance_freelancer_rates (new, finance wall): dated hourly rates; no two of one person overlap (EXCLUDE).
--   finance_freelancer_bills (new, finance wall): one row per freelancer draft, beside its AP bill.
--   Three triggers:
--     time_entries_ap_bill_guard     (time_entries, BEFORE INSERT/UPDATE/DELETE)          PD615, PD616
--     finance_ap_bills_delete_guard  (finance_ap_bills, BEFORE DELETE)                    PD617
--     finance_ap_bills_release_hours (finance_ap_bills, AFTER UPDATE OF status -> void)   (releases claims)
--
-- ── THE FINANCE SCOPE IS THE WALL FOR THE CLAIM (PD616) ───────────────────────────────────────────────────────────
-- time_entries is CORE (no module predicate) but finance_ap_bills composes app_module_allowed('finance'). So a session
-- without the finance scope sees a claimed entry but NOT its bill, and a trigger that read "bill not found" as "bill gone"
-- would let that session release the claim: the fail-open that §61.12 names. Hence ANY change of ap_bill_id needs a
-- finance-scoped session (COALESCE(app_module_allowed('finance'), false), because the function returns NULL when the GUC is
-- unset), and only then is "not found" read as gone. Referential actions (the discard's cascade SET NULL) run as the table
-- owner with RLS off, inside the discarding session, whose finance scope is still set.
--
-- ── STRICTER THAN §61.2's ROW, STATED FOR REVIEW ──────────────────────────────────────────────────────────────────
-- The guard also fires on INSERT (an entry is born unclaimed: PD616) and on DELETE (a claimed entry is never hard-deleted:
-- PD615). No route hard-deletes or inserts a claimed time entry today, so neither changes an existing path.
--
-- ── SYNC ───────────────────────────────────────────────────────────────────────────────────────────────────────────
-- sync_app keeps its DML on time_entries (migrate.ts RUNTIME_GRANTS_SQL) and never writes ap_bill_id (not in the writeback
-- registry's column set). A writeback that changes minutes, date, project, task or person of a CLAIMED entry is refused
-- (PD615), which is the invariant working: a paid hour cannot change under the bill. sync_app gets nothing on the two new
-- tables (REVOKE ALL).
--
-- ── GRANTS (security-relevant, stated for review; NO existing grant is widened) ───────────────────────────────────
-- platform_app: SELECT/INSERT/UPDATE/DELETE on the two new tables (restating default privileges). sync_app: none on them.
--
-- ── ROLLOUT ────────────────────────────────────────────────────────────────────────────────────────────────────────
-- Additive; NO DML; no backfill (no time entry is claimed and no vendor names a person). Brief ACCESS EXCLUSIVE locks on
-- time_entries, finance_ap_vendors and finance_ap_bills while columns, FKs, indexes and triggers are added. The FK validation
-- reads time_entries once (every ap_bill_id is NULL). Behaviour change: an AP bill that is not a draft can no longer be
-- deleted (PD617); no route deletes an AP bill today. Reverse (before 10f-4a drafts any bill): drop the three triggers and
-- their functions, the two tables, the vendor index, FK and column, and the time_entries indexes, FK and column.
-- Idempotent: IF NOT EXISTS / DROP ... IF EXISTS then create; applying the file twice raises nothing and changes no row.
-- No company names or ids anywhere (PV-D13).

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 0 · Prerequisites
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
CREATE EXTENSION IF NOT EXISTS btree_gist;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ux_finance_ap_bills_id_tenant') THEN
    RAISE EXCEPTION 'DW-10f-1: ux_finance_ap_bills_id_tenant (202608241021) is missing; the composite FKs to AP bills cannot be built';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ux_finance_ap_vendors_id_tenant') THEN
    RAISE EXCEPTION 'DW-10f-1: ux_finance_ap_vendors_id_tenant (202608241021) is missing';
  END IF;
  IF to_regprocedure('app_module_allowed(text)') IS NULL OR to_regprocedure('app_current_tenants()') IS NULL THEN
    RAISE EXCEPTION 'DW-10f-1: app_module_allowed(text) / app_current_tenants() are missing';
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 1 · time_entries.ap_bill_id — the claim
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE time_entries ADD COLUMN IF NOT EXISTS ap_bill_id uuid;
ALTER TABLE time_entries DROP CONSTRAINT IF EXISTS fk_time_entries_ap_bill_tenant;
-- Column-list SET NULL (PG 15+): discarding a draft (a hard delete) releases its entries and keeps their tenant.
ALTER TABLE time_entries
  ADD CONSTRAINT fk_time_entries_ap_bill_tenant
    FOREIGN KEY (ap_bill_id, tenant_id) REFERENCES finance_ap_bills (id, tenant_id) ON DELETE SET NULL (ap_bill_id);
-- "This person's unbilled hours in a period" (the preview and the draft).
CREATE INDEX IF NOT EXISTS ix_time_entries_unbilled
  ON time_entries (tenant_id, user_id, entry_date) WHERE ap_bill_id IS NULL AND deleted_at IS NULL;
-- "The entries this bill claims" (release, discard, the bill's detail).
CREATE INDEX IF NOT EXISTS ix_time_entries_ap_bill ON time_entries (ap_bill_id) WHERE ap_bill_id IS NOT NULL;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 2 · finance_ap_vendors.user_id — the person a freelancer's vendor pays
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE finance_ap_vendors ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE finance_ap_vendors DROP CONSTRAINT IF EXISTS fk_finance_ap_vendors_user;
ALTER TABLE finance_ap_vendors
  ADD CONSTRAINT fk_finance_ap_vendors_user FOREIGN KEY (user_id) REFERENCES users (id);
-- NULL defeats UNIQUE, and an archived (soft-deleted) vendor must not block linking the person again: partial.
CREATE UNIQUE INDEX IF NOT EXISTS ux_finance_ap_vendors_user_live
  ON finance_ap_vendors (tenant_id, user_id) WHERE user_id IS NOT NULL AND deleted_at IS NULL;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 3 · finance_freelancer_rates — dated hourly rates, no overlaps
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS finance_freelancer_rates (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES companies(id),
  user_id              uuid NOT NULL REFERENCES users(id),
  hourly_rate          numeric(20,4) NOT NULL,
  -- The company's functional currency (the handler checks it: the ledger books at rate 1).
  currency_code        text NOT NULL REFERENCES finance_currencies(code),
  -- A code, not an id: accounts are renumberable (the billing profile's rule); resolved when a bill is drafted.
  expense_account_code text NOT NULL,
  valid_from           date NOT NULL,
  valid_to             date,          -- NULL = open
  note                 text,
  created_by           uuid REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE finance_freelancer_rates DROP CONSTRAINT IF EXISTS ck_finance_freelancer_rates_rate;
ALTER TABLE finance_freelancer_rates DROP CONSTRAINT IF EXISTS ck_finance_freelancer_rates_account;
ALTER TABLE finance_freelancer_rates DROP CONSTRAINT IF EXISTS ck_finance_freelancer_rates_valid;
ALTER TABLE finance_freelancer_rates DROP CONSTRAINT IF EXISTS ck_finance_freelancer_rates_note;
ALTER TABLE finance_freelancer_rates DROP CONSTRAINT IF EXISTS ex_finance_freelancer_rates_no_overlap;
ALTER TABLE finance_freelancer_rates
  ADD CONSTRAINT ck_finance_freelancer_rates_rate CHECK (hourly_rate > 0),
  ADD CONSTRAINT ck_finance_freelancer_rates_account CHECK (btrim(expense_account_code) <> ''),
  ADD CONSTRAINT ck_finance_freelancer_rates_valid CHECK (valid_to IS NULL OR valid_to >= valid_from),
  ADD CONSTRAINT ck_finance_freelancer_rates_note CHECK (note IS NULL OR length(note) <= 500),
  -- No two rates of one person in one company overlap. Both ends inclusive; an open rate runs to the end of time (the
  -- 0109 positions pattern).
  ADD CONSTRAINT ex_finance_freelancer_rates_no_overlap EXCLUDE USING gist (
    tenant_id WITH =,
    user_id WITH =,
    daterange(valid_from, COALESCE(valid_to, '9999-12-31'::date), '[]') WITH &&
  );

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 4 · finance_freelancer_bills — one row per freelancer draft, beside its AP bill
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS finance_freelancer_bills (
  bill_id      uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES companies(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  vendor_id    uuid NOT NULL,
  period_start date NOT NULL,
  period_end   date NOT NULL,
  minutes      integer NOT NULL,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE finance_freelancer_bills DROP CONSTRAINT IF EXISTS fk_finance_freelancer_bills_bill;
ALTER TABLE finance_freelancer_bills DROP CONSTRAINT IF EXISTS fk_finance_freelancer_bills_vendor;
ALTER TABLE finance_freelancer_bills DROP CONSTRAINT IF EXISTS ck_finance_freelancer_bills_period;
ALTER TABLE finance_freelancer_bills DROP CONSTRAINT IF EXISTS ck_finance_freelancer_bills_minutes;
ALTER TABLE finance_freelancer_bills
  -- Discarding the draft (deleting the AP bill) takes this row with it.
  ADD CONSTRAINT fk_finance_freelancer_bills_bill
    FOREIGN KEY (bill_id, tenant_id) REFERENCES finance_ap_bills (id, tenant_id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_finance_freelancer_bills_vendor
    FOREIGN KEY (vendor_id, tenant_id) REFERENCES finance_ap_vendors (id, tenant_id),
  ADD CONSTRAINT ck_finance_freelancer_bills_period CHECK (period_end >= period_start),
  ADD CONSTRAINT ck_finance_freelancer_bills_minutes CHECK (minutes > 0);
CREATE INDEX IF NOT EXISTS ix_finance_freelancer_bills_user ON finance_freelancer_bills (tenant_id, user_id, period_start);

-- RLS for both: enabled + forced, one tenant_isolation policy composing the finance wall, like every finance_* table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_freelancer_rates', 'finance_freelancer_bills'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
         USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''finance''))
         WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''finance''))',
      t
    );
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO platform_app', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sync_app') THEN
      EXECUTE format('REVOKE ALL ON %I FROM sync_app', t);
    END IF;
  END LOOP;
END $$;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 5 · time_entries_ap_bill_guard — a claimed entry is frozen (PD615); the claim moves only in finance scope (PD616)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION time_entries_ap_bill_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  b record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.ap_bill_id IS NOT NULL THEN
      RAISE EXCEPTION 'time_entry_billed: time entry % is on freelancer bill % and cannot be deleted', OLD.id, OLD.ap_bill_id
        USING ERRCODE = 'PD615';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.ap_bill_id IS NOT NULL THEN
      RAISE EXCEPTION 'time_entry_claim_invalid: a time entry is born unclaimed; a claim is an UPDATE (entry %)', NEW.id
        USING ERRCODE = 'PD616';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE, claim unchanged.
  IF NEW.ap_bill_id IS NOT DISTINCT FROM OLD.ap_bill_id THEN
    IF OLD.ap_bill_id IS NOT NULL
       AND (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
            OR NEW.user_id IS DISTINCT FROM OLD.user_id
            OR NEW.project_id IS DISTINCT FROM OLD.project_id
            OR NEW.task_id IS DISTINCT FROM OLD.task_id
            OR NEW.pm_task_id IS DISTINCT FROM OLD.pm_task_id
            OR NEW.minutes IS DISTINCT FROM OLD.minutes
            OR NEW.entry_date IS DISTINCT FROM OLD.entry_date
            OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at) THEN
      RAISE EXCEPTION 'time_entry_billed: time entry % is on freelancer bill %; its company, person, project, task, minutes, date and deletion cannot change (billable and notes may)', OLD.id, OLD.ap_bill_id
        USING ERRCODE = 'PD615';
    END IF;
    RETURN NEW;
  END IF;

  -- The claim changes. Only a finance-scoped session may, so that "the bill is not visible" can only mean "it is gone".
  IF NOT COALESCE(app_module_allowed('finance'), false) THEN
    RAISE EXCEPTION 'time_entry_claim_invalid: the claim of time entry % changes only in a finance-scoped session', OLD.id
      USING ERRCODE = 'PD616';
  END IF;

  IF OLD.ap_bill_id IS NOT NULL AND NEW.ap_bill_id IS NOT NULL THEN
    RAISE EXCEPTION 'time_entry_claim_invalid: time entry % is on bill %; a claim never moves to another bill', OLD.id, OLD.ap_bill_id
      USING ERRCODE = 'PD616';
  END IF;

  IF NEW.ap_bill_id IS NULL THEN
    -- A release: the bill is gone (the discard's cascade) or void.
    SELECT ab.status INTO b FROM finance_ap_bills ab WHERE ab.id = OLD.ap_bill_id AND ab.tenant_id = OLD.tenant_id;
    IF FOUND AND b.status <> 'void' THEN
      RAISE EXCEPTION 'time_entry_claim_invalid: bill % is %; time entry % is released only when the bill is discarded or voided', OLD.ap_bill_id, b.status, OLD.id
        USING ERRCODE = 'PD616';
    END IF;
    RETURN NEW;
  END IF;

  -- A claim (NULL -> X): a draft bill of this company, made for this person, whose period holds the entry's date.
  IF NEW.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'time_entry_claim_invalid: time entry % is deleted and cannot be billed', NEW.id
      USING ERRCODE = 'PD616';
  END IF;
  SELECT ab.status, fb.user_id, fb.period_start, fb.period_end INTO b
    FROM finance_ap_bills ab
    JOIN finance_freelancer_bills fb ON fb.bill_id = ab.id AND fb.tenant_id = ab.tenant_id
   WHERE ab.id = NEW.ap_bill_id AND ab.tenant_id = NEW.tenant_id
     FOR SHARE OF ab;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'time_entry_claim_invalid: % is not a freelancer bill of this company', NEW.ap_bill_id
      USING ERRCODE = 'PD616';
  END IF;
  IF b.status <> 'draft' OR b.user_id IS DISTINCT FROM NEW.user_id
     OR NEW.entry_date < b.period_start OR NEW.entry_date > b.period_end THEN
    RAISE EXCEPTION 'time_entry_claim_invalid: bill % (status %, person %, % to %) cannot claim time entry % (person %, dated %)',
      NEW.ap_bill_id, b.status, b.user_id, b.period_start, b.period_end, NEW.id, NEW.user_id, NEW.entry_date
      USING ERRCODE = 'PD616';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS time_entries_ap_bill_guard ON time_entries;
CREATE TRIGGER time_entries_ap_bill_guard
  BEFORE INSERT OR UPDATE OR DELETE ON time_entries
  FOR EACH ROW EXECUTE FUNCTION time_entries_ap_bill_guard();

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 6 · finance_ap_bills_delete_guard — only a draft is deleted (PD617)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- A posted bill would leave its journal behind and break the AP reconciliation.
CREATE OR REPLACE FUNCTION finance_ap_bills_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'ap_bill_posted_no_delete: AP bill % is % and cannot be deleted (only a draft can)', OLD.id, OLD.status
      USING ERRCODE = 'PD617';
  END IF;
  RETURN OLD;
END
$$;
DROP TRIGGER IF EXISTS finance_ap_bills_delete_guard ON finance_ap_bills;
CREATE TRIGGER finance_ap_bills_delete_guard
  BEFORE DELETE ON finance_ap_bills
  FOR EACH ROW EXECUTE FUNCTION finance_ap_bills_delete_guard();

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 7 · finance_ap_bills_release_hours — a voided bill releases its time entries
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- No route voids an AP bill today; the invariant holds for the day one does. The voiding session is finance-scoped (the
-- bill is behind the finance wall), so the guard above admits the release.
CREATE OR REPLACE FUNCTION finance_ap_bills_release_hours() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE time_entries SET ap_bill_id = NULL, updated_at = now()
   WHERE tenant_id = NEW.tenant_id AND ap_bill_id = NEW.id;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS finance_ap_bills_release_hours ON finance_ap_bills;
CREATE TRIGGER finance_ap_bills_release_hours
  AFTER UPDATE OF status ON finance_ap_bills
  FOR EACH ROW
  WHEN (NEW.status = 'void' AND OLD.status IS DISTINCT FROM 'void')
  EXECUTE FUNCTION finance_ap_bills_release_hours();

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 8 · Self-assertion: the catalog, by name. It counts NO rows.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  t   text;
  c   text;
  def text;
  n   integer;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_freelancer_rates', 'finance_freelancer_bills'] LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      RAISE EXCEPTION 'DW-10f-1: table % was not created', t;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = format('public.%I', t)::regclass AND relrowsecurity AND relforcerowsecurity) THEN
      RAISE EXCEPTION 'DW-10f-1: RLS is not ENABLED+FORCED on %', t;
    END IF;
    SELECT count(*) INTO n FROM pg_policies WHERE schemaname = 'public' AND tablename = t;
    IF n <> 1 OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t
                               AND policyname = 'tenant_isolation'
                               AND qual LIKE '%app_current_tenants()%' AND qual LIKE '%app_module_allowed(''finance''%'
                               AND with_check LIKE '%app_module_allowed(''finance''%') THEN
      RAISE EXCEPTION 'DW-10f-1: % must have exactly one tenant_isolation policy composing the finance wall (found %)', t, n;
    END IF;
  END LOOP;
  -- The guard reads the bill only in finance scope; the bills table must stay behind that wall.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'finance_ap_bills'
                   AND qual LIKE '%app_module_allowed(''finance''%') THEN
    RAISE EXCEPTION 'DW-10f-1: finance_ap_bills is no longer behind the finance wall; time_entries_ap_bill_guard assumes it is';
  END IF;

  -- Columns.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'time_entries' AND column_name = 'ap_bill_id' AND is_nullable = 'YES') THEN
    RAISE EXCEPTION 'DW-10f-1: time_entries.ap_bill_id is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'finance_ap_vendors' AND column_name = 'user_id' AND is_nullable = 'YES') THEN
    RAISE EXCEPTION 'DW-10f-1: finance_ap_vendors.user_id is missing';
  END IF;
  FOREACH c IN ARRAY ARRAY['id', 'tenant_id', 'user_id', 'hourly_rate', 'currency_code', 'expense_account_code', 'valid_from',
                           'valid_to', 'note', 'created_by', 'created_at', 'updated_at'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'finance_freelancer_rates' AND column_name = c) THEN
      RAISE EXCEPTION 'DW-10f-1: finance_freelancer_rates.% is missing', c;
    END IF;
  END LOOP;
  FOREACH c IN ARRAY ARRAY['bill_id', 'tenant_id', 'user_id', 'vendor_id', 'period_start', 'period_end', 'minutes',
                           'created_by', 'created_at'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'finance_freelancer_bills' AND column_name = c) THEN
      RAISE EXCEPTION 'DW-10f-1: finance_freelancer_bills.% is missing', c;
    END IF;
  END LOOP;

  -- CHECKs and the EXCLUDE.
  FOREACH c IN ARRAY ARRAY['ck_finance_freelancer_rates_rate', 'ck_finance_freelancer_rates_account', 'ck_finance_freelancer_rates_valid',
                           'ck_finance_freelancer_rates_note', 'ck_finance_freelancer_bills_period', 'ck_finance_freelancer_bills_minutes'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c AND contype = 'c' AND convalidated) THEN
      RAISE EXCEPTION 'DW-10f-1: CHECK % is missing or not validated', c;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ex_finance_freelancer_rates_no_overlap' AND contype = 'x') THEN
    RAISE EXCEPTION 'DW-10f-1: EXCLUDE ex_finance_freelancer_rates_no_overlap is missing';
  END IF;

  -- FKs, with their referential actions.
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conname = 'fk_time_entries_ap_bill_tenant' AND contype = 'f';
  IF def IS NULL OR def NOT LIKE '%(ap_bill_id, tenant_id) REFERENCES finance_ap_bills(id, tenant_id) ON DELETE SET NULL (ap_bill_id)%' THEN
    RAISE EXCEPTION 'DW-10f-1: fk_time_entries_ap_bill_tenant is missing or not SET NULL (ap_bill_id): %', def;
  END IF;
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conname = 'fk_finance_freelancer_bills_bill' AND contype = 'f';
  IF def IS NULL OR def NOT LIKE '%(bill_id, tenant_id) REFERENCES finance_ap_bills(id, tenant_id) ON DELETE CASCADE%' THEN
    RAISE EXCEPTION 'DW-10f-1: fk_finance_freelancer_bills_bill is missing or not ON DELETE CASCADE: %', def;
  END IF;
  FOREACH c IN ARRAY ARRAY['fk_finance_freelancer_bills_vendor', 'fk_finance_ap_vendors_user'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c AND contype = 'f') THEN
      RAISE EXCEPTION 'DW-10f-1: FK % is missing', c;
    END IF;
  END LOOP;

  -- Indexes.
  SELECT indexdef INTO def FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ux_finance_ap_vendors_user_live';
  IF def IS NULL OR def NOT LIKE 'CREATE UNIQUE INDEX%' OR def NOT LIKE '%WHERE%' THEN
    RAISE EXCEPTION 'DW-10f-1: ux_finance_ap_vendors_user_live is missing or not a partial UNIQUE index';
  END IF;
  FOREACH c IN ARRAY ARRAY['ix_time_entries_unbilled', 'ix_time_entries_ap_bill', 'ix_finance_freelancer_bills_user'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = c) THEN
      RAISE EXCEPTION 'DW-10f-1: index % is missing', c;
    END IF;
  END LOOP;

  -- Triggers (enabled).
  FOREACH c IN ARRAY ARRAY['time_entries_ap_bill_guard', 'finance_ap_bills_delete_guard', 'finance_ap_bills_release_hours'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = c AND NOT tgisinternal AND tgenabled = 'O') THEN
      RAISE EXCEPTION 'DW-10f-1: trigger % is missing or disabled', c;
    END IF;
  END LOOP;
END $$;

COMMENT ON COLUMN time_entries.ap_bill_id IS
  'DW-10f (BFF §61.2): the claim; the freelancer AP bill that pays this entry. While set, the entry''s person, project, task, minutes, date and deletion are frozen (PD615); it changes only in a finance-scoped session (PD616).';
COMMENT ON COLUMN finance_ap_vendors.user_id IS
  'DW-10f: the person this vendor pays (a freelancer). At most one live vendor per person and company. Vendor-master data.';
COMMENT ON TABLE finance_freelancer_rates IS
  'DW-10f (BFF §61.7): a freelancer''s hourly rate, valid from a date to an optional date. No two of one person overlap (EXCLUDE). Finance wall.';
COMMENT ON TABLE finance_freelancer_bills IS
  'DW-10f (BFF §61.8): one row per freelancer AP draft (the person, vendor, period and minutes). Deleted with its AP bill. Finance wall.';
