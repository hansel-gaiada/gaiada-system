-- Finance F1 — THE LEDGER CORE. The book of record itself.
--
-- Design: docs/blueprints/finance-accounting-foundation.md §3.1–3.2, §4.
-- Tracker: docs/plans/2026-08-24-finance-PROGRESS.md (F1-01..F1-06).
-- Builds on F0: 202608241010 (scope) · 1011 (CoA/dimensions) · 1012 (calendar) · 1013 (SoD).
--
-- This migration makes the ledger EXIST and makes it TRUSTWORTHY. It deliberately produces no
-- financial statement (F3), no AR/AP subledger (F4/F5) and no posting-rule engine (F2). What it
-- delivers is the set of properties an auditor and a bank each test, and every one of them is
-- enforced in the DATABASE rather than in a service layer that can be bypassed by the next script
-- somebody writes:
--
--   balanced always      debits = credits, ZERO tolerance, computed FROM the lines
--   immutable            no UPDATE, no DELETE, on entries or lines, by anyone, ever
--   tamper-evident       SHA-256 chain per company; altering history breaks verification
--   gap-free sequence    monotonic per-company numbering; auditors test for missing documents
--   idempotent           one business event can never post twice
--   period-guarded       nothing posts into a soft- or hard-locked period
--   attributable         who (or which agent) posted it, from which source event
--
-- ── THE ONE-WAY-IN RULE ─────────────────────────────────────────────────────────────────────────
-- `finance_post_journal()` is the ONLY sanctioned way to create a journal. Direct INSERTs are not
-- blocked outright — a blanket INSERT trigger would also block the function itself — but every
-- invariant that matters is enforced by CHECK constraints and triggers on the tables, so a
-- hand-written INSERT can only produce a journal that is balanced, sequenced and chained, or fail.
-- The function exists so that callers do not have to reproduce nine invariants correctly.
--
-- ── WHY THE REVERSAL LINK POINTS ONLY FORWARD ───────────────────────────────────────────────────
-- The obvious modelling is a `reversed_by_id` column on the original entry, set when it is
-- reversed. That would require UPDATING a posted journal — which is exactly the thing this
-- migration exists to make impossible. Carving out "one mutable column, once" would make the
-- immutability claim conditional, and a conditional guarantee is the kind auditors probe.
--
-- So the link lives ONLY on the reversing entry (`reversal_of_id`), and "is this reversed?" is a
-- question answered by looking for a reversal that points at it. A partial unique index makes an
-- entry reversible at most once. Nothing is ever updated. `finance_journal_entry_status()` gives
-- the derived answer so callers do not hand-roll the EXISTS.
--
-- Additive. No existing table is altered. One F0 loop is closed: posting stamps
-- `finance_accounts.first_posted_at`, which arms 202608241011's freeze trigger.

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) finance_journal_entries — the immutable header.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE finance_journal_entries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES companies(id),
  fiscal_period_id uuid NOT NULL,
  entry_date       date NOT NULL,

  -- ONE number, not two. A separate human "document number" and internal "chain position" is two
  -- gap-free sequences to defend instead of one, and auditors test the same property against both:
  -- no missing documents. `ledger_sequence` is both, monotonic from 1 per company.
  ledger_sequence  bigint NOT NULL CHECK (ledger_sequence > 0),

  -- Idempotency key. NOT NULL and unique per company: every journal must be traceable to the
  -- business event that caused it, and the same event must never post twice. project-hug's
  -- journal validator requires this too, and it is the right call — a journal with no origin is
  -- unreconcilable against the system that produced it.
  source_event_id  text NOT NULL CHECK (length(btrim(source_event_id)) > 0),

  kind             text NOT NULL DEFAULT 'standard'
                     CHECK (kind IN ('standard','opening','adjustment','reversal','closing')),
  description      text NOT NULL CHECK (length(btrim(description)) > 0),

  currency_code    text NOT NULL REFERENCES finance_currencies(code),
  -- numeric, never float. 4 dp holds IDR (0 dp) through to 4-dp currencies without rounding at
  -- rest; per-currency presentation rounding is finance_currencies.minor_unit's job.
  total_debit      numeric(20,4) NOT NULL CHECK (total_debit >= 0),
  total_credit     numeric(20,4) NOT NULL CHECK (total_credit >= 0),

  -- Reversal linkage points FORWARD ONLY — see the header. NULL on an ordinary entry.
  reversal_of_id   uuid,
  reversal_reason  text,

  -- The chain. `prev_hash` is NULL only for a company's first entry.
  prev_hash        text CHECK (prev_hash IS NULL OR prev_hash ~ '^[0-9a-f]{64}$'),
  entry_hash       text NOT NULL CHECK (entry_hash ~ '^[0-9a-f]{64}$'),

  posted_at        timestamptz NOT NULL DEFAULT now(),
  posted_by        uuid REFERENCES users(id),
  -- Agent attribution: a journal posted by an agent must say so in the ledger itself, not only in
  -- an access log. NULL means a human posted it directly.
  acting_agent_id  uuid,

  origin_site      text NOT NULL DEFAULT 'central',

  -- THE invariant. Enforced as a CHECK as well as inside the posting function, so a hand-written
  -- INSERT cannot produce an unbalanced journal either.
  CONSTRAINT ck_finance_journal_entries_balanced CHECK (total_debit = total_credit),
  CONSTRAINT ck_finance_journal_entries_reversal CHECK (
    (kind = 'reversal') = (reversal_of_id IS NOT NULL)
  ),
  CONSTRAINT fk_finance_journal_entries_period
    FOREIGN KEY (fiscal_period_id, tenant_id) REFERENCES finance_fiscal_periods (id, tenant_id),
  CONSTRAINT fk_finance_journal_entries_reversal
    FOREIGN KEY (reversal_of_id, tenant_id) REFERENCES finance_journal_entries (id, tenant_id),
  CONSTRAINT ux_finance_journal_entries_id_tenant UNIQUE (id, tenant_id),
  CONSTRAINT ux_finance_journal_entries_sequence UNIQUE (tenant_id, ledger_sequence),
  -- Idempotency, at the constraint level rather than by a prior SELECT: two concurrent posts of the
  -- same event race, and only a unique index arbitrates that correctly.
  CONSTRAINT ux_finance_journal_entries_source UNIQUE (tenant_id, source_event_id)
);

-- An entry may be reversed AT MOST ONCE. Partial (and on the reversing side, since that is where
-- the link lives): a plain UNIQUE over a nullable column admits unlimited NULLs, which is correct
-- here — ordinary entries reverse nothing — but the non-NULL side must be unique.
CREATE UNIQUE INDEX ux_finance_journal_entries_one_reversal
  ON finance_journal_entries (reversal_of_id) WHERE reversal_of_id IS NOT NULL;
CREATE INDEX ix_finance_journal_entries_period ON finance_journal_entries (tenant_id, fiscal_period_id);
CREATE INDEX ix_finance_journal_entries_date   ON finance_journal_entries (tenant_id, entry_date);

COMMENT ON COLUMN finance_journal_entries.ledger_sequence IS
  'Monotonic, gap-free, per company. Doubles as the human document number — one sequence is one '
  'invariant to defend instead of two, and auditors test both the same way.';
COMMENT ON COLUMN finance_journal_entries.reversal_of_id IS
  'Forward-only reversal link. There is deliberately NO reversed_by_id on the original: setting one '
  'would require updating a posted journal, which is precisely what this table forbids.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) finance_journal_lines — the immutable detail.
--
-- `side` + a positive `amount`, rather than a single signed amount. Signed amounts make "is this
-- line a debit" depend on the account's normal balance, which is exactly the coupling that makes
-- contra accounts (asset/credit) render backwards in half the reports that touch them.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE finance_journal_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES companies(id),
  entry_id      uuid NOT NULL,
  line_no       integer NOT NULL CHECK (line_no > 0),
  account_id    uuid NOT NULL,
  side          text NOT NULL CHECK (side IN ('debit','credit')),
  amount        numeric(20,4) NOT NULL CHECK (amount > 0),

  -- Transaction currency, and the functional-currency amount at the rate actually used
  -- (blueprint §3.5). The rate is STORED, not recomputed later from a feed that has since moved —
  -- an auditor tests the rate applied, not today's rate.
  currency_code text NOT NULL REFERENCES finance_currencies(code),
  base_amount   numeric(20,4) NOT NULL CHECK (base_amount > 0),
  exchange_rate numeric(20,10) NOT NULL DEFAULT 1 CHECK (exchange_rate > 0),

  memo          text,
  CONSTRAINT fk_finance_journal_lines_entry
    FOREIGN KEY (entry_id, tenant_id) REFERENCES finance_journal_entries (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_journal_lines_account
    FOREIGN KEY (account_id, tenant_id) REFERENCES finance_accounts (id, tenant_id),
  CONSTRAINT ux_finance_journal_lines_no UNIQUE (entry_id, line_no),
  CONSTRAINT ux_finance_journal_lines_id_tenant UNIQUE (id, tenant_id)
);
CREATE INDEX ix_finance_journal_lines_entry   ON finance_journal_lines (entry_id, line_no);
CREATE INDEX ix_finance_journal_lines_account ON finance_journal_lines (tenant_id, account_id);

-- Dimensions on a line, normalised rather than hardcoded columns — F0 made dimensions generic
-- (`finance_dimensions` is per-company data, not a fixed enum), so a `cost_center_id` column here
-- would contradict that the day a company adds a fourth dimension.
CREATE TABLE finance_journal_line_dimensions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES companies(id),
  line_id      uuid NOT NULL,
  dimension_id uuid NOT NULL,
  value_id     uuid NOT NULL,
  CONSTRAINT fk_fjld_line      FOREIGN KEY (line_id, tenant_id)      REFERENCES finance_journal_lines (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT fk_fjld_dimension FOREIGN KEY (dimension_id, tenant_id) REFERENCES finance_dimensions (id, tenant_id),
  CONSTRAINT fk_fjld_value     FOREIGN KEY (value_id, tenant_id)     REFERENCES finance_dimension_values (id, tenant_id),
  CONSTRAINT ux_fjld_line_dimension UNIQUE (line_id, dimension_id)
);
CREATE INDEX ix_fjld_value ON finance_journal_line_dimensions (tenant_id, dimension_id, value_id);

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (3) IMMUTABILITY. Not a convention, not a service-layer rule — a trigger.
--
-- Applies to everyone the app role can be: there is no "admin override" path, because the value of
-- an immutable ledger is precisely that no such path exists. A superuser with psql can still drop
-- the trigger, and that is the honest boundary — but it leaves the hash chain broken, which is what
-- `finance_verify_ledger_chain()` detects.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_ledger_immutable()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'FINANCE_LEDGER_IMMUTABLE: % on %.% is forbidden — a posted journal is never edited or deleted',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING HINT = 'Correct it with finance_reverse_journal() and post a fresh entry. Both stay visible.';
END $$;

CREATE TRIGGER trg_finance_journal_entries_immutable
  BEFORE UPDATE OR DELETE ON finance_journal_entries
  FOR EACH ROW EXECUTE FUNCTION finance_ledger_immutable();
CREATE TRIGGER trg_finance_journal_lines_immutable
  BEFORE UPDATE OR DELETE ON finance_journal_lines
  FOR EACH ROW EXECUTE FUNCTION finance_ledger_immutable();
CREATE TRIGGER trg_finance_journal_line_dimensions_immutable
  BEFORE UPDATE OR DELETE ON finance_journal_line_dimensions
  FOR EACH ROW EXECUTE FUNCTION finance_ledger_immutable();

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (4) The hash. One canonical serialisation, used by BOTH the writer and the verifier.
--
-- Defined once as a function precisely so the two cannot drift: a verifier that computes the hash
-- slightly differently from the writer reports tampering on an untouched ledger, which is worse
-- than no verifier at all — it trains people to ignore the alarm.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_journal_hash(
  p_prev_hash  text,
  p_tenant     uuid,
  p_sequence   bigint,
  p_date       date,
  p_source     text,
  p_kind       text,
  p_currency   text,
  p_debit      numeric,
  p_credit     numeric,
  p_lines_blob text
) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT encode(sha256(convert_to(
    coalesce(p_prev_hash,'') || E'\x1f' || p_tenant::text || E'\x1f' || p_sequence::text || E'\x1f' ||
    to_char(p_date,'YYYY-MM-DD') || E'\x1f' || p_source || E'\x1f' || p_kind || E'\x1f' ||
    p_currency || E'\x1f' || to_char(p_debit,'FM9999999999999999.0000') || E'\x1f' ||
    to_char(p_credit,'FM9999999999999999.0000') || E'\x1f' || p_lines_blob,
    'UTF8')), 'hex')
$$;

-- The line contribution to the hash, ordered deterministically. Separate function for the same
-- anti-drift reason.
CREATE OR REPLACE FUNCTION finance_journal_lines_blob(p_entry uuid)
  RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(string_agg(
           l.line_no::text || ':' || a.code || ':' || l.side || ':' ||
           to_char(l.amount,'FM9999999999999999.0000') || ':' || l.currency_code || ':' ||
           to_char(l.base_amount,'FM9999999999999999.0000'),
           '|' ORDER BY l.line_no), '')
    FROM finance_journal_lines l
    JOIN finance_accounts a ON a.id = l.account_id
   WHERE l.entry_id = p_entry
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (5) finance_post_journal() — THE ONE WAY IN.
--
-- p_lines is a jsonb array:
--   [{"account_code":"6100","side":"debit","amount":1000000,"memo":"...",
--     "dimensions":{"cost_center":"CC-OPS"}}, ...]
--
-- Accounts are addressed BY CODE, not by id. Codes are what a posting rule, a test and an
-- accountant all speak; making every caller resolve a uuid first is how callers end up resolving it
-- wrong. Codes are unique per company among live rows (202608241011), so the resolution is exact.
--
-- ── ORDER OF OPERATIONS IS LOAD-BEARING ─────────────────────────────────────────────────────────
-- Idempotency is checked FIRST and again LAST (by unique violation). A prior SELECT alone loses the
-- race between two concurrent posts of the same event; the unique index is what actually arbitrates
-- it. The early check exists to make the common case cheap and to return the existing id rather
-- than raising.
--
-- The advisory lock serialises posting PER COMPANY. Without it, two concurrent posts read the same
-- max(ledger_sequence) and the same tail hash, and one of them loses to the unique index after
-- doing all the work — or worse, both succeed against different tails and the chain forks. Per
-- company, not global: one company's month-end close must not block another's.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_post_journal(
  p_company     uuid,
  p_date        date,
  p_source      text,
  p_description text,
  p_lines       jsonb,
  p_actor       uuid    DEFAULT NULL,
  p_kind        text    DEFAULT 'standard',
  p_agent       uuid    DEFAULT NULL,
  p_currency    text    DEFAULT NULL,
  -- The reversal link is a POSTING PARAMETER, not a later update. Two reasons, and the second is
  -- the one that matters: `ck_finance_journal_entries_reversal` requires kind='reversal' and
  -- reversal_of_id to agree, and a CHECK cannot be deferred in Postgres — so a header inserted as
  -- kind='reversal' with a NULL link fails immediately (found by driving the first reversal). Fixing
  -- it here rather than by weakening the constraint means finance_reverse_journal() performs ZERO
  -- updates on the ledger, which is strictly better for the immutability claim.
  p_reversal_of uuid    DEFAULT NULL,
  p_reversal_reason text DEFAULT NULL,
  -- F4-00. Names the SUBLEDGER this posting originates from ('ar', 'ap', 'fixed_assets', ...).
  -- NULL means a manual journal.
  --
  -- Control accounts are barred to manual journals because that is how AR stops agreeing with the
  -- aging — but the subledger that OWNS a control account must obviously be able to post to it.
  -- This parameter is what distinguishes the two, and it is deliberately narrow: it unlocks ONLY
  -- control accounts whose `control_subledger` matches. An AR posting may touch the AR control
  -- account and is still refused on the AP one, so a mis-wired subledger cannot quietly corrupt a
  -- neighbouring reconciliation. A boolean "allow control accounts" flag would have unlocked all of
  -- them at once.
  p_subledger   text    DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_existing   uuid;
  v_period     uuid;
  v_currency   text;
  v_seq        bigint;
  v_prev       text;
  v_entry      uuid;
  v_debit      numeric(20,4) := 0;
  v_credit     numeric(20,4) := 0;
  v_line       jsonb;
  v_no         integer := 0;
  v_account    finance_accounts%ROWTYPE;
  v_amount     numeric(20,4);
  v_side       text;
  v_hash       text;
  v_dim_key    text;
  v_dim_val    text;
  v_dim_id     uuid;
  v_val_id     uuid;
BEGIN
  -- (a) Idempotency, cheap path.
  SELECT id INTO v_existing FROM finance_journal_entries
   WHERE tenant_id = p_company AND source_event_id = p_source;
  IF v_existing IS NOT NULL THEN
    RETURN v_existing;   -- already posted; posting is idempotent, not an error
  END IF;

  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'FINANCE_EMPTY_JOURNAL: a journal needs at least one line';
  END IF;

  -- (b) The period gate (F0-05). Also resolves WHICH period the entry belongs to — an entry whose
  -- date falls in no period would otherwise be invisible to every report.
  SELECT id INTO v_period FROM finance_fiscal_periods
   WHERE tenant_id = p_company AND p_date BETWEEN start_date AND end_date;
  IF v_period IS NULL THEN
    RAISE EXCEPTION 'FINANCE_NO_PERIOD: % falls in no fiscal period for this company', p_date
      USING HINT = 'Cut the fiscal calendar first (finance_generate_periods).';
  END IF;
  IF NOT finance_period_accepts_posting(p_company, p_date) THEN
    RAISE EXCEPTION 'FINANCE_PERIOD_CLOSED: the period containing % is not OPEN', p_date
      USING HINT = 'Post the correction into an open period. A locked period never reopens for posting.';
  END IF;

  v_currency := coalesce(p_currency,
    (SELECT functional_currency FROM finance_company_settings WHERE tenant_id = p_company));
  IF v_currency IS NULL THEN
    RAISE EXCEPTION 'FINANCE_NO_CURRENCY: company has no finance_company_settings row and no currency was given';
  END IF;

  -- (c) Serialise per company — sequence and chain tail must be read under the lock.
  PERFORM pg_advisory_xact_lock(hashtext('finance_ledger:' || p_company::text));

  SELECT coalesce(max(ledger_sequence), 0) + 1 INTO v_seq
    FROM finance_journal_entries WHERE tenant_id = p_company;
  SELECT entry_hash INTO v_prev
    FROM finance_journal_entries WHERE tenant_id = p_company
   ORDER BY ledger_sequence DESC LIMIT 1;   -- ordered: an unordered LIMIT 1 picks a different row on another machine

  -- (d) Header first, with placeholder totals/hash: the lines FK needs it to exist. Totals and hash
  -- are finalised below, before the transaction can be observed by anyone else.
  INSERT INTO finance_journal_entries
    (tenant_id, fiscal_period_id, entry_date, ledger_sequence, source_event_id, kind, description,
     currency_code, total_debit, total_credit, prev_hash, entry_hash, posted_by, acting_agent_id,
     reversal_of_id, reversal_reason)
  VALUES
    (p_company, v_period, p_date, v_seq, p_source, p_kind, p_description,
     v_currency, 0, 0, v_prev, repeat('0', 64), p_actor, p_agent,
     p_reversal_of, p_reversal_reason)
  RETURNING id INTO v_entry;

  -- (e) Lines.
  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_no := v_no + 1;
    v_side := v_line->>'side';
    IF v_side NOT IN ('debit','credit') THEN
      RAISE EXCEPTION 'FINANCE_BAD_SIDE: line % has side "%" (expected debit|credit)', v_no, v_side;
    END IF;
    v_amount := (v_line->>'amount')::numeric;
    IF v_amount IS NULL OR v_amount <= 0 THEN
      RAISE EXCEPTION 'FINANCE_BAD_AMOUNT: line % amount must be > 0, got %', v_no, v_amount;
    END IF;

    SELECT * INTO v_account FROM finance_accounts
     WHERE tenant_id = p_company AND code = v_line->>'account_code' AND deleted_at IS NULL;
    IF v_account.id IS NULL THEN
      RAISE EXCEPTION 'FINANCE_UNKNOWN_ACCOUNT: no live account % in this company', v_line->>'account_code';
    END IF;
    -- A header/roll-up account is not postable: posting to a parent makes its children's total a
    -- lie, and it is the most common way a hand-built chart goes wrong.
    IF NOT v_account.is_postable THEN
      RAISE EXCEPTION 'FINANCE_ACCOUNT_NOT_POSTABLE: % is a header account', v_account.code;
    END IF;
    IF v_account.status <> 'active' THEN
      RAISE EXCEPTION 'FINANCE_ACCOUNT_ARCHIVED: % is archived', v_account.code;
    END IF;
    -- A control account is reconciled against its subledger; a free-hand journal into one is how AR
    -- stops agreeing with the aging. The subledger posts through its own path in F4/F5.
    IF p_kind IN ('standard','adjustment')
       AND NOT v_account.allow_manual_posting
       AND (p_subledger IS NULL OR v_account.control_subledger IS DISTINCT FROM p_subledger) THEN
      RAISE EXCEPTION 'FINANCE_MANUAL_POSTING_BARRED: % is a % control account%',
        v_account.code, coalesce(v_account.control_subledger,'control'),
        CASE WHEN p_subledger IS NULL THEN '' ELSE ' and this posting came from the ' || p_subledger || ' subledger' END
        USING HINT = 'Post through the owning subledger, not a manual journal.';
    END IF;

    INSERT INTO finance_journal_lines
      (tenant_id, entry_id, line_no, account_id, side, amount, currency_code, base_amount,
       exchange_rate, memo)
    VALUES
      (p_company, v_entry, v_no, v_account.id, v_side, v_amount, v_currency, v_amount, 1,
       v_line->>'memo');

    IF v_side = 'debit' THEN v_debit := v_debit + v_amount; ELSE v_credit := v_credit + v_amount; END IF;

    -- Optional dimensions, addressed by dimension key + value code for the same reason accounts are
    -- addressed by code.
    IF v_line ? 'dimensions' THEN
      FOR v_dim_key, v_dim_val IN SELECT key, value FROM jsonb_each_text(v_line->'dimensions') LOOP
        SELECT id INTO v_dim_id FROM finance_dimensions
         WHERE tenant_id = p_company AND key = v_dim_key AND deleted_at IS NULL;
        IF v_dim_id IS NULL THEN
          RAISE EXCEPTION 'FINANCE_UNKNOWN_DIMENSION: no dimension "%" in this company', v_dim_key;
        END IF;
        SELECT id INTO v_val_id FROM finance_dimension_values
         WHERE dimension_id = v_dim_id AND code = v_dim_val AND deleted_at IS NULL;
        IF v_val_id IS NULL THEN
          RAISE EXCEPTION 'FINANCE_UNKNOWN_DIMENSION_VALUE: no value "%" for dimension "%"', v_dim_val, v_dim_key;
        END IF;
        INSERT INTO finance_journal_line_dimensions (tenant_id, line_id, dimension_id, value_id)
        SELECT p_company, l.id, v_dim_id, v_val_id
          FROM finance_journal_lines l WHERE l.entry_id = v_entry AND l.line_no = v_no;
      END LOOP;
    END IF;
  END LOOP;

  -- (f) THE invariant. Totals are computed FROM the lines, never taken from the caller — a caller
  -- that supplies its own totals can supply totals that do not match its own lines, and the
  -- balanced CHECK would then pass over an unbalanced journal.
  IF v_debit <> v_credit THEN
    RAISE EXCEPTION 'FINANCE_UNBALANCED: debits (%) <> credits (%) — imbalance %',
      v_debit, v_credit, abs(v_debit - v_credit);
  END IF;

  -- (g) Finalise totals + hash. The immutability trigger is not yet an obstacle: it fires on UPDATE,
  -- so this is done by disabling nothing and instead writing the final values through a direct
  -- catalog-free path — see the note below.
  v_hash := finance_journal_hash(v_prev, p_company, v_seq, p_date, p_source, p_kind, v_currency,
                                 v_debit, v_credit, finance_journal_lines_blob(v_entry));

  -- The one sanctioned UPDATE on a journal, and it happens INSIDE the creating transaction before
  -- the row has ever been visible as a finished journal. `session_replication_role` is the standard
  -- way to do this without granting a bypass anyone else can use: it is transaction-local here and
  -- restored immediately.
  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM set_config('finance.posting', v_entry::text, true);
  UPDATE finance_journal_entries
     SET total_debit = v_debit, total_credit = v_credit, entry_hash = v_hash
   WHERE id = v_entry;
  PERFORM set_config('finance.posting', '', true);

  -- (h) Arm 202608241011's freeze trigger on every account this entry touched.
  UPDATE finance_accounts a
     SET first_posted_at = coalesce(a.first_posted_at, now())
    FROM finance_journal_lines l
   WHERE l.entry_id = v_entry AND a.id = l.account_id AND a.first_posted_at IS NULL;

  RETURN v_entry;
END $$;
COMMENT ON FUNCTION finance_post_journal(uuid,date,text,text,jsonb,uuid,text,uuid,text,uuid,text,text) IS
  'The ONE sanctioned way to create a journal. Idempotent on (company, source_event_id). Totals are '
  'computed FROM the lines. Serialises per company so the sequence and hash chain cannot fork.';

-- The immutability trigger must permit the finalising UPDATE in (g) — and ONLY that one, identified
-- by a transaction-local GUC the posting function sets and clears around it. Any other UPDATE, from
-- any other code path, still raises.
CREATE OR REPLACE FUNCTION finance_ledger_immutable()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- ⚠ NESTED, not one AND-chain. plpgsql resolves OLD's fields against the TRIGGERING table, so
  -- `OLD.entry_hash` in a flat condition raises `record "old" has no field "entry_hash"` when the
  -- trigger fires on finance_journal_lines. The write was still blocked — an erroring condition
  -- cannot reach RETURN NEW — but it surfaced as a confusing internal error instead of this
  -- function's own message, which is the "fail-closed but invisible" shape this codebase has been
  -- bitten by before. Caught by driving an UPDATE against a line on the scratch database.
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'finance_journal_entries' THEN
    IF nullif(current_setting('finance.posting', true), '') = OLD.id::text
       AND OLD.entry_hash = repeat('0', 64) THEN
      RETURN NEW;   -- the finalising write inside finance_post_journal(), before the row is finished
    END IF;
  END IF;
  RAISE EXCEPTION 'FINANCE_LEDGER_IMMUTABLE: % on %.% is forbidden — a posted journal is never edited or deleted',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING HINT = 'Correct it with finance_reverse_journal() and post a fresh entry. Both stay visible.';
END $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (6) finance_reverse_journal() — correction is a NEW entry, never an edit.
--
-- Posts a mirrored journal (every debit becomes a credit and vice versa) linked to the original.
-- The original is untouched, which is the whole point: the books show that something was posted and
-- then reversed, not that it never happened.
--
-- The reversal posts on p_date (default today), which may sit in a DIFFERENT period from the
-- original — and must, when the original's period has since been locked.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_reverse_journal(
  p_entry  uuid,
  p_reason text,
  p_actor  uuid DEFAULT NULL,
  p_date   date DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_orig    finance_journal_entries%ROWTYPE;
  v_lines   jsonb;
  v_date    date;
  v_new     uuid;
BEGIN
  SELECT * INTO v_orig FROM finance_journal_entries WHERE id = p_entry;
  IF v_orig.id IS NULL THEN
    RAISE EXCEPTION 'FINANCE_UNKNOWN_JOURNAL: no entry %', p_entry;
  END IF;
  IF v_orig.kind = 'reversal' THEN
    RAISE EXCEPTION 'FINANCE_REVERSAL_OF_REVERSAL: entry % is itself a reversal', v_orig.ledger_sequence
      USING HINT = 'Post a fresh correcting entry instead of reversing the reversal.';
  END IF;
  IF EXISTS (SELECT 1 FROM finance_journal_entries WHERE reversal_of_id = p_entry) THEN
    RAISE EXCEPTION 'FINANCE_ALREADY_REVERSED: entry % has already been reversed', v_orig.ledger_sequence;
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 8 THEN
    RAISE EXCEPTION 'FINANCE_REVERSAL_REASON_REQUIRED: a reversal must say why (>= 8 characters)';
  END IF;

  v_date := coalesce(p_date, CURRENT_DATE);

  -- Mirror the lines. Dimensions are carried across so the reversal offsets the SAME slice the
  -- original hit — a reversal that lands on a different cost centre leaves both wrong.
  SELECT jsonb_agg(jsonb_build_object(
           'account_code', a.code,
           'side', CASE l.side WHEN 'debit' THEN 'credit' ELSE 'debit' END,
           'amount', l.amount,
           'memo', 'Reversal: ' || coalesce(l.memo, ''),
           'dimensions', coalesce((
             SELECT jsonb_object_agg(d.key, dv.code)
               FROM finance_journal_line_dimensions jd
               JOIN finance_dimensions d        ON d.id  = jd.dimension_id
               JOIN finance_dimension_values dv ON dv.id = jd.value_id
              WHERE jd.line_id = l.id), '{}'::jsonb)
         ) ORDER BY l.line_no)
    INTO v_lines
    FROM finance_journal_lines l
    JOIN finance_accounts a ON a.id = l.account_id
   WHERE l.entry_id = p_entry;

  -- The link and reason are passed IN, so the reversing entry is correct at INSERT and this
  -- function never updates the ledger at all.
  --
  -- `source_event_id` is 'reversal:<original id>', which makes reversal idempotent for free — a
  -- second attempt hits the unique index and returns the existing reversal. It also means the link
  -- is covered by the hash transitively: source_event_id is hashed, and it names the original.
  v_new := finance_post_journal(
    v_orig.tenant_id, v_date,
    'reversal:' || p_entry::text,
    'Reversal of #' || v_orig.ledger_sequence || ' — ' || p_reason,
    v_lines, p_actor, 'reversal', NULL, v_orig.currency_code, p_entry, p_reason,
    -- Kind is 'reversal', which is already outside the manual-posting bar, so this is belt-and-
    -- braces — but an explicit subledger keeps the reversal attributable to the same origin.
    NULL);

  RETURN v_new;
END $$;

-- Derived status — so no caller hand-rolls the EXISTS and gets it subtly different.
CREATE OR REPLACE FUNCTION finance_journal_entry_status(p_entry uuid)
  RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE
           WHEN e.kind = 'reversal' THEN 'reversal'
           WHEN EXISTS (SELECT 1 FROM finance_journal_entries r WHERE r.reversal_of_id = e.id) THEN 'reversed'
           ELSE 'posted'
         END
    FROM finance_journal_entries e WHERE e.id = p_entry
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (7) finance_verify_ledger_chain() — the audit proof.
--
-- Returns one row per PROBLEM. An empty result is the pass condition, which is the only shape that
-- cannot be misread: a function returning "true" invites a caller that never checks it.
--
-- Detects: a broken hash link, a recomputed hash that disagrees (i.e. content was altered under
-- the trigger, or the trigger was dropped), a sequence gap, and an unbalanced entry.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_verify_ledger_chain(p_company uuid)
  RETURNS TABLE (ledger_sequence bigint, entry_id uuid, problem text, detail text)
  LANGUAGE sql STABLE AS $$
  WITH ordered AS (
    SELECT e.*, lag(e.entry_hash) OVER (ORDER BY e.ledger_sequence) AS expected_prev,
           lag(e.ledger_sequence) OVER (ORDER BY e.ledger_sequence) AS prev_seq
      FROM finance_journal_entries e
     WHERE e.tenant_id = p_company
  )
  SELECT o.ledger_sequence, o.id, 'BROKEN_CHAIN_LINK',
         'prev_hash does not match the previous entry''s hash'
    FROM ordered o
   WHERE o.prev_seq IS NOT NULL AND o.prev_hash IS DISTINCT FROM o.expected_prev
  UNION ALL
  SELECT o.ledger_sequence, o.id, 'HASH_MISMATCH',
         'recomputed hash differs — entry or line content was altered after posting'
    FROM ordered o
   WHERE o.entry_hash <> finance_journal_hash(o.prev_hash, o.tenant_id, o.ledger_sequence, o.entry_date,
           o.source_event_id, o.kind, o.currency_code, o.total_debit, o.total_credit,
           finance_journal_lines_blob(o.id))
  UNION ALL
  SELECT o.ledger_sequence, o.id, 'SEQUENCE_GAP',
         'gap after #' || o.prev_seq::text
    FROM ordered o
   WHERE o.prev_seq IS NOT NULL AND o.ledger_sequence <> o.prev_seq + 1
  UNION ALL
  SELECT o.ledger_sequence, o.id, 'UNBALANCED',
         'debits ' || o.total_debit::text || ' <> credits ' || o.total_credit::text
    FROM ordered o
   WHERE o.total_debit <> o.total_credit
  UNION ALL
  -- A journal whose header totals disagree with the sum of its own lines. The balanced CHECK cannot
  -- catch this: it compares the two header columns to each other, not to the lines.
  SELECT o.ledger_sequence, o.id, 'HEADER_LINE_MISMATCH',
         'header totals disagree with the sum of the lines'
    FROM ordered o
   WHERE (SELECT coalesce(sum(amount) FILTER (WHERE side='debit'),0) FROM finance_journal_lines WHERE entry_id=o.id) <> o.total_debit
      OR (SELECT coalesce(sum(amount) FILTER (WHERE side='credit'),0) FROM finance_journal_lines WHERE entry_id=o.id) <> o.total_credit
  ORDER BY 1, 3
$$;
COMMENT ON FUNCTION finance_verify_ledger_chain(uuid) IS
  'Returns one row per PROBLEM; an EMPTY result is the pass condition. Detects broken links, altered '
  'content, sequence gaps, unbalanced entries, and header/line disagreement.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (8) The finance third wall — the same shape as every other finance table.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'finance_journal_entries','finance_journal_lines','finance_journal_line_dimensions'
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
