-- Finance F0-03/F0-04 — CHART OF ACCOUNTS (as editable data) AND ACCOUNTING DIMENSIONS.
--
-- Second F0 migration. Still nothing posts — this is the vocabulary the ledger will speak in F1.
--
-- ── WHY THE CoA IS DATA AND NOT A SEEDED CONSTANT (owner ruling D-F5, 2026-08-24) ────────────────
-- "We don't have [an accountant] yet, but the company will give the accountant an account to this
-- ERP so everything can be done with ERP as source of truth."
--
-- Two things follow, and they pull in opposite directions:
--   * We must NOT block F0 waiting for the hire. A finance foundation with no chart of accounts is
--     not a foundation.
--   * We must NOT hard-code a chart the accountant cannot change. A CoA compiled into the app is
--     a chart nobody can correct, and the first correction always comes.
--
-- The resolution: a **template** (global reference data, this file seeds one PSAK-aligned Indonesian
-- chart) that is INSTANTIATED into a company as ordinary, editable rows. The accountant adjusts
-- their company's rows on arrival; the template is only ever a starting point, never the live chart.
-- No company gets a chart from this file — instantiation is a deliberate act, not a side effect.
--
-- ── THE ONE-WAY DOOR: posting protection ─────────────────────────────────────────────────────────
-- An account's TYPE and NORMAL BALANCE may be edited freely until the first journal hits it, and
-- never afterwards. Re-typing a posted account silently rewrites history: every prior balance
-- flips sign or moves statement, and the trial balance that an auditor signed stops reproducing.
--
-- `first_posted_at` is the door. F1's posting path stamps it once; the trigger below then freezes
-- the identity-bearing columns. Deliberately a COLUMN and not a join to a journal table: the
-- journal does not exist yet, and a forward FK would make this migration undeployable.
--
-- Additive. No existing table is touched.

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) finance_coa_templates / finance_coa_template_lines — GLOBAL reference data, no tenant.
--
-- Why global and un-walled: a template belongs to nobody. It carries no company's figures — only
-- account codes and names — so there is nothing to isolate. Giving it a tenant_id would force us to
-- pick a company to "own" the Indonesian standard chart, which is a fiction, and would then need
-- copying per company before it could be read. Read-only to the app; changed only by migration.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE finance_coa_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text,
  -- Jurisdiction/standard this chart is shaped for. A template is only safe to apply to a company
  -- reporting under the same basis.
  standard    text NOT NULL DEFAULT 'PSAK' CHECK (standard IN ('PSAK','IFRS','OTHER')),
  country_code text NOT NULL DEFAULT 'ID' CHECK (length(country_code) = 2),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE finance_coa_template_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id    uuid NOT NULL REFERENCES finance_coa_templates(id) ON DELETE CASCADE,
  code           text NOT NULL,
  name           text NOT NULL,
  -- Parent by CODE, not by id: a template is authored as a flat list and the hierarchy is implied
  -- by the numbering. Resolving codes at instantiation keeps the seed readable and diffable.
  parent_code    text,
  account_type   text NOT NULL CHECK (account_type IN ('asset','liability','equity','revenue','expense')),
  normal_balance text NOT NULL CHECK (normal_balance IN ('debit','credit')),
  is_postable    boolean NOT NULL DEFAULT true,
  is_control     boolean NOT NULL DEFAULT false,
  control_subledger text CHECK (control_subledger IN ('ar','ap','inventory','fixed_assets','payroll','tax','bank','cash')),
  description    text,
  sort_order     integer NOT NULL DEFAULT 0,
  CONSTRAINT ux_finance_coa_template_lines_code UNIQUE (template_id, code),
  -- A control account is reconciled against its subledger; one without a named subledger is
  -- un-reconcilable and is almost always a mis-flag.
  CONSTRAINT ck_finance_coa_template_lines_control CHECK (
    (is_control = false AND control_subledger IS NULL) OR (is_control = true AND control_subledger IS NOT NULL)
  )
);
CREATE INDEX ix_finance_coa_template_lines_template ON finance_coa_template_lines (template_id, sort_order);

COMMENT ON TABLE finance_coa_templates IS
  'Global (un-tenanted) CoA starting points. Instantiated into a company as editable finance_accounts '
  'rows — never read as a company''s live chart. Owner ruling D-F5.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) finance_accounts — the company's LIVE chart. Editable data, per company.
--
-- `normal_balance` is stored, not derived from `account_type`, because CONTRA accounts exist and
-- are not an edge case: accumulated depreciation is an ASSET carrying a CREDIT normal balance, and
-- a sales return is REVENUE carrying a DEBIT one. Deriving the sign from the type would make those
-- unrepresentable and push the workaround into report code, where it becomes invisible.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE finance_accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES companies(id),
  code           text NOT NULL,
  name           text NOT NULL,
  parent_id      uuid REFERENCES finance_accounts(id),
  account_type   text NOT NULL CHECK (account_type IN ('asset','liability','equity','revenue','expense')),
  normal_balance text NOT NULL CHECK (normal_balance IN ('debit','credit')),

  -- Header/roll-up accounts are NOT postable. Posting to a parent makes its children's total a lie
  -- and is the most common way a hand-built chart goes wrong.
  is_postable    boolean NOT NULL DEFAULT true,

  -- A control account's balance must equal its SUBLEDGER's total (blueprint section 3.2). Manual
  -- journals into one are how AR stops agreeing with the aging, so they are barred by default.
  --
  -- ⚠ CONTROL means "reconciled against a subledger that POSTS INTO IT" — AR, AP, inventory, fixed
  -- assets. It does NOT mean "reconciled" in general, and the difference is not academic:
  --   * BANK and CASH are reconciled against a bank STATEMENT, which is a matching exercise, not a
  --     subledger. Recording a payment from the bank IS an ordinary journal, and barring it makes
  --     the most common transaction in a small company impossible.
  --   * TAX accounts are reconciled against the tax return. Manual adjustment is routine there too.
  -- The F0 seed below originally flagged all four groups as control. Driving the first real posting
  -- through finance_post_journal() rejected `1120 Bank` on a rent payment, which is the correct
  -- behaviour for the flag and the wrong flag for the account. Fixed at the seed.
  is_control     boolean NOT NULL DEFAULT false,
  control_subledger text CHECK (control_subledger IN ('ar','ap','inventory','fixed_assets','payroll','tax','bank','cash')),
  allow_manual_posting boolean NOT NULL DEFAULT true,

  -- Optional currency pin (bank accounts held in USD, etc.). NULL = the company's functional
  -- currency, resolved at posting time.
  currency_code  text,

  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  description    text,
  -- Provenance: which template line this came from, if any. Lets us diff a company's chart against
  -- the standard later without guessing.
  source_template_line_id uuid REFERENCES finance_coa_template_lines(id),

  -- THE ONE-WAY DOOR. Stamped once by F1's posting path; freezes the columns below via trigger.
  first_posted_at timestamptz,

  origin_site    text NOT NULL DEFAULT 'central',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,

  CONSTRAINT ck_finance_accounts_control CHECK (
    (is_control = false AND control_subledger IS NULL) OR (is_control = true AND control_subledger IS NOT NULL)
  ),
  -- A control account that also accepts free-hand journals cannot be reconciled. Forbid the
  -- combination outright rather than warning about it in a UI nobody reads.
  CONSTRAINT ck_finance_accounts_control_manual CHECK (
    is_control = false OR allow_manual_posting = false
  ),
  CONSTRAINT ck_finance_accounts_parent_not_self CHECK (parent_id IS NULL OR parent_id <> id),
  CONSTRAINT ux_finance_accounts_id_tenant UNIQUE (id, tenant_id)
);

-- Account codes are unique per company among LIVE rows. Partial, because an archived 5010 must not
-- block re-creating 5010, and because a plain UNIQUE over a nullable deleted_at admits duplicates.
CREATE UNIQUE INDEX ux_finance_accounts_code_live
  ON finance_accounts (tenant_id, code) WHERE deleted_at IS NULL;
CREATE INDEX ix_finance_accounts_parent ON finance_accounts (parent_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_finance_accounts_type ON finance_accounts (tenant_id, account_type) WHERE deleted_at IS NULL;

COMMENT ON COLUMN finance_accounts.normal_balance IS
  'Stored, not derived: contra accounts (accumulated depreciation = asset/credit, sales returns = '
  'revenue/debit) are unrepresentable if the sign is inferred from account_type.';
COMMENT ON COLUMN finance_accounts.first_posted_at IS
  'Stamped once by the F1 posting path. Non-NULL freezes code/type/normal_balance — re-typing a '
  'posted account rewrites every prior balance and breaks trial-balance reproducibility.';

-- ── The freeze trigger ───────────────────────────────────────────────────────────────────────────
-- Enforced in the database, not the service layer, because the whole point is that no code path —
-- including a future migration, an admin script, or a direct psql session — may quietly re-type a
-- posted account. `first_posted_at` itself is one-way: it may be set once, never cleared.
CREATE OR REPLACE FUNCTION finance_accounts_freeze_posted()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.first_posted_at IS NOT NULL THEN
    IF NEW.code IS DISTINCT FROM OLD.code THEN
      RAISE EXCEPTION 'FINANCE_ACCOUNT_FROZEN: account % has postings; code cannot change', OLD.code
        USING HINT = 'Archive this account and create a new one; re-coding rewrites history.';
    END IF;
    IF NEW.account_type IS DISTINCT FROM OLD.account_type THEN
      RAISE EXCEPTION 'FINANCE_ACCOUNT_FROZEN: account % has postings; account_type cannot change', OLD.code;
    END IF;
    IF NEW.normal_balance IS DISTINCT FROM OLD.normal_balance THEN
      RAISE EXCEPTION 'FINANCE_ACCOUNT_FROZEN: account % has postings; normal_balance cannot change', OLD.code;
    END IF;
  END IF;
  IF OLD.first_posted_at IS NOT NULL AND NEW.first_posted_at IS NULL THEN
    RAISE EXCEPTION 'FINANCE_ACCOUNT_FROZEN: first_posted_at is one-way and cannot be cleared';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER trg_finance_accounts_freeze
  BEFORE UPDATE ON finance_accounts
  FOR EACH ROW EXECUTE FUNCTION finance_accounts_freeze_posted();

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (3) Accounting dimensions — the second axis every real report is sliced on.
--
-- Without dimensions, "what did the Creative department cost us on the Viceroy project" is
-- unanswerable except by proliferating accounts (5010-CREATIVE-VICEROY, ...), which is how charts
-- reach four thousand lines and stop being readable. The account says WHAT; the dimension says
-- WHERE/WHO/WHICH.
--
-- Requirement is set PER ACCOUNT, not globally: a cost centre is mandatory on an expense line and
-- meaningless on a bank account. `finance_account_dimension_rules` carries that, with 'forbidden'
-- as a first-class option so a balance-sheet account can refuse a dimension outright.
--
-- ⚠ Dimensions must NOT reach the trial balance (blueprint section 4 / project-hug's own checkpoint
--   on the same point): the TB is an account-level statement, and a dimension-split TB double-counts
--   the moment one line carries a dimension and its sibling does not. They belong on the GL and
--   statement projections. Enforced in F3's read models; recorded here so it is not rediscovered.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE finance_dimensions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES companies(id),
  key         text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,30}$'),
  name        text NOT NULL,
  description text,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  origin_site text NOT NULL DEFAULT 'central',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  CONSTRAINT ux_finance_dimensions_id_tenant UNIQUE (id, tenant_id)
);
CREATE UNIQUE INDEX ux_finance_dimensions_key_live
  ON finance_dimensions (tenant_id, key) WHERE deleted_at IS NULL;

CREATE TABLE finance_dimension_values (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES companies(id),
  dimension_id uuid NOT NULL,
  code         text NOT NULL,
  name         text NOT NULL,
  parent_id    uuid REFERENCES finance_dimension_values(id),
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  origin_site  text NOT NULL DEFAULT 'central',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  -- Composite FK: a value can never belong to a dimension in another company.
  CONSTRAINT fk_finance_dimension_values_dim
    FOREIGN KEY (dimension_id, tenant_id) REFERENCES finance_dimensions (id, tenant_id),
  CONSTRAINT ck_finance_dimension_values_parent_not_self CHECK (parent_id IS NULL OR parent_id <> id),
  CONSTRAINT ux_finance_dimension_values_id_tenant UNIQUE (id, tenant_id)
);
CREATE UNIQUE INDEX ux_finance_dimension_values_code_live
  ON finance_dimension_values (dimension_id, code) WHERE deleted_at IS NULL;
CREATE INDEX ix_finance_dimension_values_dim ON finance_dimension_values (dimension_id) WHERE deleted_at IS NULL;

CREATE TABLE finance_account_dimension_rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES companies(id),
  account_id   uuid NOT NULL,
  dimension_id uuid NOT NULL,
  requirement  text NOT NULL DEFAULT 'optional' CHECK (requirement IN ('required','optional','forbidden')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_fadr_account   FOREIGN KEY (account_id, tenant_id)   REFERENCES finance_accounts (id, tenant_id),
  CONSTRAINT fk_fadr_dimension FOREIGN KEY (dimension_id, tenant_id) REFERENCES finance_dimensions (id, tenant_id),
  CONSTRAINT ux_fadr_account_dimension UNIQUE (account_id, dimension_id)
);

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (4) The finance third wall — the shape established in 202608241010, applied byte-identically.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'finance_accounts','finance_dimensions','finance_dimension_values',
    'finance_account_dimension_rules'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
         USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''finance''))
         WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''finance''))',
      t
    );
  END LOOP;
END $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (5) SEED: a PSAK-aligned Indonesian chart of accounts template.
--
-- A starting point for a trading/services group, using the conventional Indonesian 1–8 numbering.
-- It is deliberately MODEST — roughly sixty lines covering the accounts an operating company
-- actually needs on day one, including the Indonesian tax accounts that a generic international
-- chart omits (PPN Masukan/Keluaran, PPh 21/23/4(2) payable) and which are the first thing anyone
-- has to add by hand otherwise.
--
-- ⚠ This is NOT an audited chart and no accountant has signed it (open question Q5/D-F5). It exists
--   so F0 is not blocked, and it is explicitly expected to be edited on arrival. Nothing in the
--   system reads it as authority; it is copied once and then owned by the company.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
INSERT INTO finance_coa_templates (key, name, description, standard, country_code) VALUES
  ('id_psak_general_v1',
   'Indonesia general (PSAK) — v1',
   'Starting chart for an Indonesian operating company under PSAK. Trading/services shape, with '
   'Indonesian tax accounts included. Expected to be edited by the company''s accountant.',
   'PSAK', 'ID');

INSERT INTO finance_coa_template_lines
  (template_id, code, name, parent_code, account_type, normal_balance, is_postable, is_control, control_subledger, sort_order)
SELECT t.id, x.code, x.name, x.parent_code, x.account_type, x.normal_balance, x.is_postable, x.is_control, x.control_subledger, x.sort_order
FROM finance_coa_templates t,
(VALUES
  -- ── 1 ASSETS ───────────────────────────────────────────────────────────────────────────────────
  ('1000','ASET',                              NULL,  'asset','debit', false,false,NULL, 100),
  ('1100','Aset Lancar',                       '1000','asset','debit', false,false,NULL, 110),
  ('1110','Kas',                               '1100','asset','debit', true, false,NULL,   111),
  ('1120','Bank',                              '1100','asset','debit', true, false,NULL,   112),
  ('1130','Piutang Usaha',                     '1100','asset','debit', true, true,'ar',   113),
  ('1131','Cadangan Kerugian Piutang',         '1100','asset','credit',true, false,NULL,  114),
  ('1140','Piutang Lain-lain',                 '1100','asset','debit', true, false,NULL,  115),
  ('1150','Persediaan',                        '1100','asset','debit', true, true,'inventory', 116),
  ('1160','Biaya Dibayar di Muka',             '1100','asset','debit', true, false,NULL,  117),
  ('1170','PPN Masukan',                       '1100','asset','debit', true, false,NULL,   118),
  ('1180','PPh Dibayar di Muka',               '1100','asset','debit', true, false,NULL,   119),
  ('1200','Aset Tidak Lancar',                 '1000','asset','debit', false,false,NULL,  120),
  ('1210','Aset Tetap',                        '1200','asset','debit', true, true,'fixed_assets', 121),
  ('1220','Akumulasi Penyusutan',              '1200','asset','credit',true, true,'fixed_assets', 122),
  ('1230','Aset Tak Berwujud',                 '1200','asset','debit', true, false,NULL,  123),
  ('1240','Akumulasi Amortisasi',              '1200','asset','credit',true, false,NULL,  124),
  ('1250','Investasi pada Entitas Anak',       '1200','asset','debit', true, false,NULL,  125),
  ('1290','Piutang Pihak Berelasi',            '1200','asset','debit', true, false,NULL,  129),
  -- ── 2 LIABILITIES ──────────────────────────────────────────────────────────────────────────────
  ('2000','LIABILITAS',                        NULL,  'liability','credit',false,false,NULL, 200),
  ('2100','Liabilitas Jangka Pendek',          '2000','liability','credit',false,false,NULL, 210),
  ('2110','Utang Usaha',                       '2100','liability','credit',true, true,'ap',  211),
  ('2120','Utang Lain-lain',                   '2100','liability','credit',true, false,NULL, 212),
  ('2130','Beban yang Masih Harus Dibayar',    '2100','liability','credit',true, false,NULL, 213),
  ('2140','PPN Keluaran',                      '2100','liability','credit',true, false,NULL, 214),
  ('2150','Utang PPh 21',                      '2100','liability','credit',true, false,NULL, 215),
  ('2151','Utang PPh 23',                      '2100','liability','credit',true, false,NULL, 216),
  ('2152','Utang PPh 4(2) Final',              '2100','liability','credit',true, false,NULL, 217),
  ('2153','Utang PPh Badan',                   '2100','liability','credit',true, false,NULL, 218),
  ('2160','Utang Gaji',                        '2100','liability','credit',true, false,NULL,    219),
  ('2170','Utang BPJS',                        '2100','liability','credit',true, false,NULL,    220),
  ('2180','Pendapatan Diterima di Muka',       '2100','liability','credit',true, false,NULL, 221),
  ('2200','Liabilitas Jangka Panjang',         '2000','liability','credit',false,false,NULL, 230),
  ('2210','Utang Bank Jangka Panjang',         '2200','liability','credit',true, false,NULL, 231),
  ('2290','Utang Pihak Berelasi',              '2200','liability','credit',true, false,NULL, 239),
  -- ── 3 EQUITY ───────────────────────────────────────────────────────────────────────────────────
  ('3000','EKUITAS',                           NULL,  'equity','credit',false,false,NULL, 300),
  ('3100','Modal Saham',                       '3000','equity','credit',true, false,NULL, 310),
  ('3200','Tambahan Modal Disetor',            '3000','equity','credit',true, false,NULL, 320),
  ('3300','Saldo Laba Ditahan',                '3000','equity','credit',true, false,NULL, 330),
  ('3400','Laba Tahun Berjalan',               '3000','equity','credit',true, false,NULL, 340),
  ('3500','Dividen',                           '3000','equity','debit', true, false,NULL, 350),
  -- ── 4 REVENUE ──────────────────────────────────────────────────────────────────────────────────
  ('4000','PENDAPATAN',                        NULL,  'revenue','credit',false,false,NULL, 400),
  ('4100','Pendapatan Usaha',                  '4000','revenue','credit',true, false,NULL, 410),
  ('4200','Potongan Penjualan',                '4000','revenue','debit', true, false,NULL, 420),
  ('4300','Retur Penjualan',                   '4000','revenue','debit', true, false,NULL, 430),
  -- ── 5 COST OF SALES ────────────────────────────────────────────────────────────────────────────
  ('5000','HARGA POKOK PENJUALAN',             NULL,  'expense','debit',false,false,NULL, 500),
  ('5100','Harga Pokok Penjualan',             '5000','expense','debit',true, false,NULL, 510),
  ('5200','Biaya Produksi Langsung',           '5000','expense','debit',true, false,NULL, 520),
  -- ── 6 OPERATING EXPENSES ───────────────────────────────────────────────────────────────────────
  ('6000','BEBAN OPERASIONAL',                 NULL,  'expense','debit',false,false,NULL, 600),
  ('6100','Beban Gaji dan Tunjangan',          '6000','expense','debit',true, false,NULL, 610),
  ('6110','Beban BPJS dan Kesejahteraan',      '6000','expense','debit',true, false,NULL, 611),
  ('6200','Beban Sewa',                        '6000','expense','debit',true, false,NULL, 620),
  ('6300','Beban Utilitas',                    '6000','expense','debit',true, false,NULL, 630),
  ('6400','Beban Pemasaran dan Iklan',         '6000','expense','debit',true, false,NULL, 640),
  ('6500','Beban Perjalanan Dinas',            '6000','expense','debit',true, false,NULL, 650),
  ('6600','Beban Profesional dan Jasa',        '6000','expense','debit',true, false,NULL, 660),
  ('6700','Beban Penyusutan dan Amortisasi',   '6000','expense','debit',true, false,NULL, 670),
  ('6800','Beban Perlengkapan Kantor',         '6000','expense','debit',true, false,NULL, 680),
  ('6850','Beban Teknologi dan Langganan',     '6000','expense','debit',true, false,NULL, 685),
  ('6900','Beban Operasional Lainnya',         '6000','expense','debit',true, false,NULL, 690),
  -- ── 7 OTHER INCOME / EXPENSE ───────────────────────────────────────────────────────────────────
  ('7000','PENDAPATAN DAN BEBAN LAIN-LAIN',    NULL,  'revenue','credit',false,false,NULL, 700),
  ('7100','Pendapatan Bunga',                  '7000','revenue','credit',true, false,NULL, 710),
  ('7200','Laba/Rugi Selisih Kurs',            '7000','revenue','credit',true, false,NULL, 720),
  ('7300','Pendapatan Lain-lain',              '7000','revenue','credit',true, false,NULL, 730),
  ('7500','Beban Bunga',                       '7000','expense','debit', true, false,NULL, 750),
  ('7600','Beban Administrasi Bank',           '7000','expense','debit', true, false,NULL, 760),
  ('7900','Beban Lain-lain',                   '7000','expense','debit', true, false,NULL, 790),
  -- ── 8 TAX ──────────────────────────────────────────────────────────────────────────────────────
  ('8000','PAJAK PENGHASILAN',                 NULL,  'expense','debit',false,false,NULL, 800),
  ('8100','Beban Pajak Penghasilan Kini',      '8000','expense','debit',true, false,NULL, 810),
  ('8200','Beban Pajak Penghasilan Tangguhan', '8000','expense','debit',true, false,NULL, 820)
) AS x(code,name,parent_code,account_type,normal_balance,is_postable,is_control,control_subledger,sort_order)
WHERE t.key = 'id_psak_general_v1';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (6) finance_instantiate_coa(company, template_key, actor) — copy a template into a company.
--
-- Idempotent by account code: re-running adds only the codes the company does not already have, so
-- an interrupted run is safe to repeat and a later template revision can be topped up without
-- clobbering the accountant's edits. It NEVER updates an existing account — the company's chart
-- wins over the template, always. That is the whole point of D-F5.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_instantiate_coa(p_company uuid, p_template_key text)
  RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_template uuid;
  v_created  integer := 0;
BEGIN
  SELECT id INTO v_template FROM finance_coa_templates WHERE key = p_template_key;
  IF v_template IS NULL THEN
    RAISE EXCEPTION 'FINANCE_TEMPLATE_UNKNOWN: no CoA template with key %', p_template_key;
  END IF;

  -- Pass 1: the accounts themselves, parents left NULL.
  INSERT INTO finance_accounts
    (tenant_id, code, name, account_type, normal_balance, is_postable, is_control,
     control_subledger, allow_manual_posting, source_template_line_id)
  SELECT p_company, l.code, l.name, l.account_type, l.normal_balance, l.is_postable, l.is_control,
         l.control_subledger,
         -- Control accounts refuse manual journals (see ck_finance_accounts_control_manual).
         NOT l.is_control,
         l.id
    FROM finance_coa_template_lines l
   WHERE l.template_id = v_template
     AND NOT EXISTS (
       SELECT 1 FROM finance_accounts a
        WHERE a.tenant_id = p_company AND a.code = l.code AND a.deleted_at IS NULL
     );
  GET DIAGNOSTICS v_created = ROW_COUNT;

  -- Pass 2: resolve parent_code -> parent_id, now that every row exists. Only fills NULLs, so an
  -- accountant who has already re-parented an account keeps their change.
  UPDATE finance_accounts child
     SET parent_id = parent.id
    FROM finance_coa_template_lines l
    JOIN finance_accounts parent
      ON parent.tenant_id = p_company AND parent.code = l.parent_code AND parent.deleted_at IS NULL
   WHERE l.template_id = v_template
     AND child.tenant_id = p_company
     AND child.code = l.code
     AND child.deleted_at IS NULL
     AND child.parent_id IS NULL
     AND l.parent_code IS NOT NULL;

  RETURN v_created;
END $$;
COMMENT ON FUNCTION finance_instantiate_coa(uuid, text) IS
  'Copies a CoA template into a company as editable rows. Idempotent by code; NEVER overwrites an '
  'existing account — the company''s chart always wins over the template (owner ruling D-F5).';
