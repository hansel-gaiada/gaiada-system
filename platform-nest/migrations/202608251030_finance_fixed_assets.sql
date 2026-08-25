-- Finance F8 — FIXED ASSETS AND DEPRECIATION. The third subledger.
--
-- Design: docs/blueprints/finance-accounting-foundation.md §4. Builds on F1's ledger
-- (202608241015) and the CoA (202608241011). Owner ruling 2026-08-25: **book AND tax
-- depreciation, with deferred tax** — not book alone.
--
-- ── THE INVARIANT THIS PHASE EXISTS TO HOLD ─────────────────────────────────────────────────────
-- Same shape as AR/AP, two identities instead of one:
--
--     SUM(asset cost, not disposed)        == `1210 Aset Tetap` balance
--     SUM(accumulated depreciation, book)  == `1220 Akumulasi Penyusutan` balance
--
-- A fixed-asset register that does not tie to the balance sheet is the same failure as an aging
-- that does not tie: an authoritative-looking number that is wrong. `finance_fa_reconcile()` is a
-- CHECK and never a fixer.
--
-- ── WHY THERE ARE TWO SETS OF NUMBERS, AND WHY THAT IS THE WHOLE POINT ──────────────────────────
-- Indonesian tax depreciation (UU PPh Ps. 11 / PMK) is a STATUTORY schedule: an asset falls in a
-- golongan, and the golongan fixes the life and the permitted methods. PSAK 16 book depreciation is
-- a MANAGEMENT ESTIMATE of how the asset is consumed. They routinely disagree — a laptop written
-- off over 4 years for tax may be depreciated over 3 for book.
--
-- That disagreement is not an inconsistency to be reconciled away. It is a **temporary difference**,
-- and it is the input to deferred tax (PSAK 46). Storing only one number does not simplify the
-- problem; it moves it into a spreadsheet outside the ERP, which contradicts the owner's ruling
-- that the ERP is the source of truth for all.
--
-- So every asset carries both, they are computed by the same generator from different parameters,
-- and the difference is derivable at any date rather than remembered.
--
-- ── THE SCHEDULE IS DERIVED, NOT STORED ────────────────────────────────────────────────────────
-- `finance_asset_depreciation_schedule()` computes the full life of an asset from its parameters.
-- Nothing persists it. A stored schedule is a second source of truth that silently goes stale the
-- moment a life is revised, and PSAK 16 requires life and residual to be reviewed at least
-- annually — so revision is the normal case, not the exception.
--
-- What IS persisted is what was actually POSTED (`finance_depreciation_lines`), because that is a
-- fact about the ledger rather than a calculation. The two are compared, never conflated.
--
-- ── CONTRA IS NOT A SPECIAL CASE ───────────────────────────────────────────────────────────────
-- `1220 Akumulasi Penyusutan` is an ASSET account with a CREDIT normal balance. Every sign in here
-- comes from `normal_balance`, never from a list of account codes that "are contra". The F0 CoA was
-- built that way for exactly this phase.

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (0) CoA additions — deferred tax balances, disposal result, impairment
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- `8200 Beban Pajak Penghasilan Tangguhan` (deferred tax EXPENSE) already exists; what F8 needs and
-- F0 did not have is the BALANCE SHEET side of deferred tax, plus somewhere for a disposal result
-- and an impairment to land.
--
-- ⚠ These are added to the TEMPLATE only. They are NOT back-instantiated into existing companies
-- here, deliberately: `finance_instantiate_coa()` reads tenant-scoped tables behind
-- `app_module_allowed('finance')`, and a migration runs with no such scope set — so the loop would
-- write ZERO rows and report success, which is this program's most-recorded trap. Re-running
-- `npm run seed:finance-config` instantiates them through the path that sets the scope, and it is
-- idempotent by account code so it adds only what is missing.
INSERT INTO finance_coa_template_lines
  (template_id, code, name, parent_code, account_type, normal_balance, is_postable, is_control, control_subledger, sort_order)
SELECT t.id, x.code, x.name, x.parent_code, x.account_type, x.normal_balance, x.is_postable, x.is_control, x.control_subledger, x.sort_order
FROM finance_coa_templates t,
(VALUES
  ('1260','Aset Pajak Tangguhan',            '1200','asset',    'debit',  true, false, NULL, 126),
  ('2250','Liabilitas Pajak Tangguhan',      '2200','liability','credit', true, false, NULL, 235),
  ('6750','Beban Penurunan Nilai Aset',      '6000','expense',  'debit',  true, false, NULL, 675),
  ('7400','Laba/Rugi Pelepasan Aset Tetap',  '7000','revenue',  'credit', true, false, NULL, 740)
) AS x(code, name, parent_code, account_type, normal_balance, is_postable, is_control, control_subledger, sort_order)
WHERE t.key = 'id_psak_general_v1'
  AND NOT EXISTS (
    SELECT 1 FROM finance_coa_template_lines l WHERE l.template_id = t.id AND l.code = x.code
  );

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) finance_asset_classes — where the DEFAULTS live
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- A class carries the book policy and the tax golongan, so an accountant sets "Kendaraan" up once
-- rather than restating a life on every asset. The asset may override; the class is a default, not
-- a constraint.
--
-- The GL accounts live here too. Which account a class capitalises into is configuration — a
-- company that splits `1210` into vehicles and equipment must not need a code change.
CREATE TABLE finance_asset_classes (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES companies(id),
  code                 text NOT NULL,
  name                 text NOT NULL,

  -- ── Book policy (PSAK 16) ────────────────────────────────────────────────────────────────────
  book_method          text NOT NULL DEFAULT 'straight_line'
                         CHECK (book_method IN ('straight_line','declining_balance','units_of_production','none')),
  book_life_months     integer CHECK (book_life_months IS NULL OR book_life_months > 0),
  -- Residual as a PERCENTAGE of cost. A class-level absolute amount would be meaningless across
  -- assets of different cost.
  book_residual_pct    numeric(9,6) NOT NULL DEFAULT 0
                         CHECK (book_residual_pct >= 0 AND book_residual_pct < 100),

  -- ── Tax policy (UU PPh Ps. 11) ───────────────────────────────────────────────────────────────
  -- The golongan is the statutory bucket. Life and rate are DERIVED from it by
  -- finance_tax_golongan_params() rather than stored, because they are law, not configuration —
  -- storing them invites an accountant to "correct" a statutory rate into a wrong one.
  tax_golongan         text CHECK (tax_golongan IS NULL OR tax_golongan IN (
                         'gol_1','gol_2','gol_3','gol_4',
                         'bangunan_permanen','bangunan_non_permanen','non_depreciable')),
  tax_method           text CHECK (tax_method IS NULL OR tax_method IN ('garis_lurus','saldo_menurun')),

  -- ── GL wiring ────────────────────────────────────────────────────────────────────────────────
  asset_account_code   text NOT NULL DEFAULT '1210',
  accum_account_code   text NOT NULL DEFAULT '1220',
  expense_account_code text NOT NULL DEFAULT '6700',

  is_active            boolean NOT NULL DEFAULT true,
  origin_site          text NOT NULL DEFAULT 'central',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz,

  -- Buildings MUST use straight-line under Indonesian tax law; saldo menurun is available only for
  -- non-building assets (Gol 1-4). Encoded as a constraint rather than trusted to a UI, because a
  -- building on declining balance produces a tax return that is wrong in a way nothing else here
  -- would catch.
  CONSTRAINT ck_asset_class_building_method CHECK (
    tax_golongan IS NULL
    OR tax_golongan NOT IN ('bangunan_permanen','bangunan_non_permanen')
    OR tax_method = 'garis_lurus'
  ),
  -- A depreciating class needs a life; a non-depreciating one (land) must not have a method.
  CONSTRAINT ck_asset_class_life CHECK (
    book_method = 'none' OR book_life_months IS NOT NULL
  ),
  CONSTRAINT ux_asset_class_id_tenant UNIQUE (id, tenant_id)
);
CREATE UNIQUE INDEX ux_finance_asset_classes_code
  ON finance_asset_classes (tenant_id, code) WHERE deleted_at IS NULL;

COMMENT ON TABLE finance_asset_classes IS
  'F8 asset classes: book policy (PSAK 16 estimate) + tax golongan (UU PPh Ps. 11 statutory) + GL '
  'wiring. Defaults for assets, never a ceiling on them.';
COMMENT ON COLUMN finance_asset_classes.tax_golongan IS
  'Statutory bucket. Life and rate are DERIVED via finance_tax_golongan_params(), not stored — they '
  'are law, and a stored copy invites someone to edit a statutory rate.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) finance_assets — the register
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE finance_assets (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES companies(id),
  class_id             uuid NOT NULL,
  code                 text NOT NULL,
  name                 text NOT NULL,
  description          text,

  -- ── Componentisation (PSAK 16.43) ────────────────────────────────────────────────────────────
  -- A significant part with a different useful life must be depreciated separately — an aircraft
  -- engine inside an airframe, a lift inside a building. A component is a full asset row pointing
  -- at its parent, so it gets its own life and its own schedule with no special-casing anywhere.
  parent_asset_id      uuid,

  acquisition_date     date NOT NULL,
  -- Depreciation starts here, NOT at acquisition. An asset bought in March and commissioned in June
  -- depreciates from June — capitalising the wait would overstate expense. NULL = not yet in
  -- service (construction in progress); such an asset appears in the register and is NEVER
  -- depreciated.
  in_service_date      date,

  cost                 numeric(20,2) NOT NULL CHECK (cost >= 0),
  -- Absolute residual, defaulted from the class percentage at creation time by the application.
  residual_amount      numeric(20,2) NOT NULL DEFAULT 0 CHECK (residual_amount >= 0),

  -- ── Book overrides (NULL = inherit the class) ────────────────────────────────────────────────
  book_method          text CHECK (book_method IS NULL OR book_method IN ('straight_line','declining_balance','units_of_production','none')),
  book_life_months     integer CHECK (book_life_months IS NULL OR book_life_months > 0),
  -- Units-of-production denominator. Required when the method is units_of_production and
  -- meaningless otherwise.
  book_total_units     numeric(20,4) CHECK (book_total_units IS NULL OR book_total_units > 0),

  -- ── Tax overrides (NULL = inherit the class) ─────────────────────────────────────────────────
  tax_golongan         text CHECK (tax_golongan IS NULL OR tax_golongan IN (
                         'gol_1','gol_2','gol_3','gol_4',
                         'bangunan_permanen','bangunan_non_permanen','non_depreciable')),
  tax_method           text CHECK (tax_method IS NULL OR tax_method IN ('garis_lurus','saldo_menurun')),

  status               text NOT NULL DEFAULT 'active'
                         CHECK (status IN ('cip','active','fully_depreciated','disposed','written_off')),
  disposed_date        date,

  notes                text,
  origin_site          text NOT NULL DEFAULT 'central',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz,

  -- Composite FKs (the 0027/0081 pattern) so a child can never point across tenants.
  CONSTRAINT fk_finance_assets_class
    FOREIGN KEY (class_id, tenant_id) REFERENCES finance_asset_classes (id, tenant_id),
  CONSTRAINT ux_finance_assets_id_tenant UNIQUE (id, tenant_id),
  CONSTRAINT fk_finance_assets_parent
    FOREIGN KEY (parent_asset_id, tenant_id) REFERENCES finance_assets (id, tenant_id),

  CONSTRAINT ck_finance_assets_not_own_parent CHECK (parent_asset_id IS NULL OR parent_asset_id <> id),
  -- Residual cannot exceed cost: depreciable base would be negative and the schedule would credit
  -- depreciation, i.e. silently reverse itself.
  CONSTRAINT ck_finance_assets_residual CHECK (residual_amount <= cost),
  CONSTRAINT ck_finance_assets_in_service CHECK (in_service_date IS NULL OR in_service_date >= acquisition_date),
  CONSTRAINT ck_finance_assets_disposed CHECK (
    (status IN ('disposed','written_off')) = (disposed_date IS NOT NULL)
  ),
  -- CIP means "not yet in service" — the two must not disagree.
  CONSTRAINT ck_finance_assets_cip CHECK (
    (status = 'cip') = (in_service_date IS NULL)
  ),
  CONSTRAINT ck_finance_assets_units CHECK (
    book_method IS DISTINCT FROM 'units_of_production' OR book_total_units IS NOT NULL
  )
);
CREATE UNIQUE INDEX ux_finance_assets_code
  ON finance_assets (tenant_id, code) WHERE deleted_at IS NULL;
CREATE INDEX ix_finance_assets_class ON finance_assets (tenant_id, class_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_finance_assets_parent ON finance_assets (parent_asset_id) WHERE parent_asset_id IS NOT NULL;

COMMENT ON TABLE finance_assets IS
  'F8 fixed-asset register. Carries BOTH book (PSAK 16 estimate) and tax (UU PPh statutory) '
  'parameters — the difference between them is the input to deferred tax, not an inconsistency.';
COMMENT ON COLUMN finance_assets.in_service_date IS
  'Depreciation starts HERE, not at acquisition. NULL = construction in progress; never depreciated.';
COMMENT ON COLUMN finance_assets.parent_asset_id IS
  'PSAK 16.43 componentisation: a significant part with its own useful life is a full asset row '
  'pointing at its parent, so it gets its own schedule with no special-casing.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (3) finance_tax_golongan_params — the statute, in one place
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- UU PPh Ps. 11. Returns life in months and the ANNUAL rate for each method.
--
-- Rates are stated rather than computed from the life because that is how the law states them, and
-- because saldo menurun's rate is exactly double the straight-line rate only by construction — an
-- implementation that derived it would look correct and drift the first time a golongan changed.
CREATE OR REPLACE FUNCTION finance_tax_golongan_params(p_golongan text)
  RETURNS TABLE (life_months integer, rate_garis_lurus numeric, rate_saldo_menurun numeric)
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$
    -- Every column is CAST explicitly. An untyped NULL in a VALUES list takes the column's inferred
    -- type from its siblings, and Postgres then refuses the function with "return type mismatch in
    -- function declared to return record" — which names the function, not the column, so it is
    -- worth stating here rather than rediscovering.
    -- Columns listed explicitly, NOT `SELECT *`: the subquery carries `golongan` as a fourth
    -- column and the function declares three, which Postgres reports as the same opaque "return
    -- type mismatch" as a type error.
    SELECT t.life_months, t.rate_gl, t.rate_sm FROM (VALUES
      ('gol_1',                  48::integer, 25.0::numeric, 50.0::numeric),
      ('gol_2',                  96::integer, 12.5::numeric, 25.0::numeric),
      ('gol_3',                 192::integer,  6.25::numeric, 12.5::numeric),
      ('gol_4',                 240::integer,  5.0::numeric, 10.0::numeric),
      -- Buildings: straight-line only. The saldo menurun column is NULL rather than 0 so that a
      -- caller which ignores the building rule gets a NULL it must handle, not a silent zero
      -- charge that would look like a correctly depreciating asset.
      ('bangunan_permanen',     240::integer,  5.0::numeric, NULL::numeric),
      ('bangunan_non_permanen', 120::integer, 10.0::numeric, NULL::numeric),
      ('non_depreciable',         0::integer,  0.0::numeric, NULL::numeric)
    ) AS t(golongan, life_months, rate_gl, rate_sm)
    WHERE t.golongan = p_golongan;
  $$;
COMMENT ON FUNCTION finance_tax_golongan_params(text) IS
  'UU PPh Ps. 11 statutory depreciation parameters. Buildings return NULL for saldo menurun because '
  'the method is not permitted for them — a NULL forces the caller to handle it, a 0 would look '
  'like a correctly depreciating asset charging nothing.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (4) finance_asset_depreciation_schedule() — the generator
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Full monthly life of one asset, BOOK and TAX side by side. Derived, never stored (see header).
--
-- Three behaviours worth stating because they are where depreciation engines usually go wrong:
--
--  1. **The final period absorbs the rounding.** Monthly amounts rounded to 2dp do not sum to the
--     depreciable base. Charging the rounded amount every month leaves a few rupiah of book value
--     on a fully depreciated asset forever, and that residue never reconciles against the GL. The
--     last period is computed as "whatever is left", not as the monthly figure.
--
--  2. **Declining balance terminates.** Saldo menurun approaches zero asymptotically and never
--     arrives, so Indonesian practice (and the law's intent) writes off the remaining book value in
--     the FINAL year of the golongan life. Without that an asset depreciates forever.
--
--  3. **Depreciation never takes book value below residual** (book) **or below zero** (tax — tax
--     recognises no residual). Enforced by clamping each charge, not by trusting the arithmetic.
CREATE OR REPLACE FUNCTION finance_asset_depreciation_schedule(p_asset uuid)
  RETURNS TABLE (
    seq            integer,
    period_start   date,
    book_charge    numeric,
    book_accum     numeric,
    book_nbv       numeric,
    tax_charge     numeric,
    tax_accum      numeric,
    tax_nbv        numeric
  )
  LANGUAGE plpgsql STABLE
  AS $$
  DECLARE
    a                 record;
    v_book_method     text;
    v_book_life       integer;
    v_tax_gol         text;
    v_tax_method      text;
    v_tax_life        integer;
    v_tax_rate        numeric;
    v_book_base       numeric;      -- cost - residual
    v_book_accum      numeric := 0;
    v_tax_accum       numeric := 0;
    v_book_charge     numeric;
    v_tax_charge      numeric;
    v_months          integer;
    i                 integer;
    v_period          date;
    v_book_monthly    numeric;
    v_tax_monthly     numeric;
  BEGIN
    SELECT s.*, c.book_method AS c_book_method, c.book_life_months AS c_book_life,
           c.tax_golongan AS c_tax_gol, c.tax_method AS c_tax_method
      INTO a
      FROM finance_assets s
      JOIN finance_asset_classes c ON c.id = s.class_id AND c.tenant_id = s.tenant_id
     WHERE s.id = p_asset AND s.deleted_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'FINANCE_ASSET_NOT_FOUND: no asset %', p_asset;
    END IF;

    -- Not in service: no schedule at all. Deliberately an empty result rather than a row of zeros —
    -- zeros would tie in a reconciliation and hide that the asset was never commissioned.
    IF a.in_service_date IS NULL THEN
      RETURN;
    END IF;

    v_book_method := COALESCE(a.book_method, a.c_book_method);
    v_book_life   := COALESCE(a.book_life_months, a.c_book_life);
    v_tax_gol     := COALESCE(a.tax_golongan, a.c_tax_gol);
    v_tax_method  := COALESCE(a.tax_method, a.c_tax_method);

    v_book_base := a.cost - a.residual_amount;

    -- Tax parameters from the statute.
    IF v_tax_gol IS NOT NULL AND v_tax_gol <> 'non_depreciable' THEN
      SELECT g.life_months,
             CASE WHEN v_tax_method = 'saldo_menurun' THEN g.rate_saldo_menurun ELSE g.rate_garis_lurus END
        INTO v_tax_life, v_tax_rate
        FROM finance_tax_golongan_params(v_tax_gol) g;
      IF v_tax_method = 'saldo_menurun' AND v_tax_rate IS NULL THEN
        RAISE EXCEPTION 'FINANCE_TAX_METHOD_NOT_PERMITTED: saldo menurun is not permitted for golongan %', v_tax_gol;
      END IF;
    END IF;

    -- The schedule runs for the LONGER of the two lives, so neither side is truncated by the other.
    v_months := GREATEST(COALESCE(v_book_life, 0), COALESCE(v_tax_life, 0));
    IF v_months = 0 THEN
      RETURN;
    END IF;

    v_book_monthly := CASE
      WHEN v_book_method = 'straight_line' AND v_book_life > 0 THEN round(v_book_base / v_book_life, 2)
      ELSE NULL
    END;
    v_tax_monthly := CASE
      WHEN v_tax_method = 'garis_lurus' AND v_tax_life > 0 THEN round(a.cost * v_tax_rate / 100.0 / 12.0, 2)
      ELSE NULL
    END;

    FOR i IN 1 .. v_months LOOP
      v_period := (date_trunc('month', a.in_service_date) + make_interval(months => i - 1))::date;

      -- ── BOOK ────────────────────────────────────────────────────────────────────────────────
      v_book_charge := 0;
      IF v_book_life IS NOT NULL AND i <= v_book_life AND v_book_method <> 'none' THEN
        IF v_book_method = 'straight_line' THEN
          v_book_charge := CASE WHEN i = v_book_life THEN v_book_base - v_book_accum ELSE v_book_monthly END;
        ELSIF v_book_method = 'declining_balance' THEN
          -- Double-declining, monthly. Final period writes off the remainder (see header note 2).
          IF i = v_book_life THEN
            v_book_charge := v_book_base - v_book_accum;
          ELSE
            v_book_charge := round((a.cost - v_book_accum) * (2.0 / v_book_life), 2);
          END IF;
        ELSIF v_book_method = 'units_of_production' THEN
          -- Units consumed are a fact about operations, not a schedule. Reported as zero here and
          -- charged by usage at run time; emitting a straight-line guess would be a fabricated
          -- number in a register somebody reconciles.
          v_book_charge := 0;
        END IF;
        -- Never below residual (header note 3).
        v_book_charge := LEAST(v_book_charge, v_book_base - v_book_accum);
        v_book_charge := GREATEST(v_book_charge, 0);
      END IF;

      -- ── TAX ─────────────────────────────────────────────────────────────────────────────────
      v_tax_charge := 0;
      IF v_tax_life IS NOT NULL AND i <= v_tax_life AND v_tax_gol <> 'non_depreciable' THEN
        IF v_tax_method = 'garis_lurus' THEN
          v_tax_charge := CASE WHEN i = v_tax_life THEN a.cost - v_tax_accum ELSE v_tax_monthly END;
        ELSE
          IF i = v_tax_life THEN
            v_tax_charge := a.cost - v_tax_accum;   -- terminate (header note 2)
          ELSE
            v_tax_charge := round((a.cost - v_tax_accum) * v_tax_rate / 100.0 / 12.0, 2);
          END IF;
        END IF;
        -- Tax recognises no residual: the base is full cost, floor is zero.
        v_tax_charge := LEAST(v_tax_charge, a.cost - v_tax_accum);
        v_tax_charge := GREATEST(v_tax_charge, 0);
      END IF;

      v_book_accum := v_book_accum + v_book_charge;
      v_tax_accum  := v_tax_accum  + v_tax_charge;

      seq          := i;
      period_start := v_period;
      book_charge  := v_book_charge;
      book_accum   := v_book_accum;
      book_nbv     := a.cost - v_book_accum;
      tax_charge   := v_tax_charge;
      tax_accum    := v_tax_accum;
      tax_nbv      := a.cost - v_tax_accum;
      RETURN NEXT;
    END LOOP;
  END;
  $$;
COMMENT ON FUNCTION finance_asset_depreciation_schedule(uuid) IS
  'F8: full monthly life of one asset, book and tax side by side. DERIVED, never stored — PSAK 16 '
  'requires life and residual to be reviewed at least annually, so revision is the normal case and '
  'a stored schedule would go stale silently. The final period absorbs rounding; declining balance '
  'writes off the remainder in the final period rather than approaching zero forever.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (5) finance_depreciation_runs / _lines — what was actually POSTED
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE finance_depreciation_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES companies(id),
  period_id      uuid NOT NULL,
  journal_id     uuid,
  asset_count    integer NOT NULL DEFAULT 0,
  book_total     numeric(20,2) NOT NULL DEFAULT 0,
  tax_total      numeric(20,2) NOT NULL DEFAULT 0,
  run_by         uuid REFERENCES users(id),
  run_at         timestamptz NOT NULL DEFAULT now(),
  origin_site    text NOT NULL DEFAULT 'central',
  CONSTRAINT ux_finance_dep_runs_id_tenant UNIQUE (id, tenant_id)
);
-- ★ IDEMPOTENCY IS A CONSTRAINT, NOT A CODE PATH.
-- One run per period, enforced by the database. A second run cannot double-post even if the
-- application logic is wrong, the job is retried, or two operators click at once. F8-06 asked for
-- "re-running a period must not double-post"; a uniqueness rule in SQL is the only version of that
-- which survives a concurrent caller.
CREATE UNIQUE INDEX ux_finance_dep_runs_period
  ON finance_depreciation_runs (tenant_id, period_id);

CREATE TABLE finance_depreciation_lines (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES companies(id),
  run_id         uuid NOT NULL,
  asset_id       uuid NOT NULL,
  seq            integer NOT NULL,
  book_charge    numeric(20,2) NOT NULL DEFAULT 0,
  tax_charge     numeric(20,2) NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_finance_dep_lines_run
    FOREIGN KEY (run_id, tenant_id) REFERENCES finance_depreciation_runs (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT fk_finance_dep_lines_asset
    FOREIGN KEY (asset_id, tenant_id) REFERENCES finance_assets (id, tenant_id)
);
CREATE INDEX ix_finance_dep_lines_asset ON finance_depreciation_lines (tenant_id, asset_id);
CREATE UNIQUE INDEX ux_finance_dep_lines_run_asset ON finance_depreciation_lines (run_id, asset_id);

COMMENT ON TABLE finance_depreciation_runs IS
  'F8: what depreciation was actually POSTED, per period. Compared against the derived schedule, '
  'never conflated with it. One run per period is a UNIQUE INDEX — idempotency that survives a '
  'concurrent caller, not a code path that hopes to be called once.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (6) RLS — the three-wall pattern, unchanged
-- ════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'finance_asset_classes','finance_assets','finance_depreciation_runs','finance_depreciation_lines'
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

-- Runtime DML grants come from the owner's ALTER DEFAULT PRIVILEGES, as everywhere else in this
-- migration set. An explicit GRANT here would be the only one in the finance series and would
-- diverge from that mechanism the moment a role is renamed.
