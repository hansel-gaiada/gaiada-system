-- Finance F2 — POSTING RULES. The seam every other department posts through.
--
-- Design: docs/blueprints/finance-accounting-foundation.md §4 ("posting_rules — this is what lets
-- non-accountants' actions post correct accounting"). Builds on F1's ledger.
--
-- This is the idea the F0 audit singled out as project-hug's best: **business modules EMIT events;
-- finance decides the accounting.** Sales does not know what account revenue lands in. HR does not
-- know how a payroll accrual is booked. They say what HAPPENED, in their own vocabulary, and the
-- finance module owns the mapping.
--
-- Without this seam, the first time Sales needs delivery to post revenue somebody hardcodes a chart
-- of accounts into the sales module — and the chart of accounts is EDITABLE DATA (ruling D-F5), so
-- that hardcoding is wrong the moment the accountant renumbers an account.
--
-- It is also what this program's agentic-native bar demands: a capability must work identically
-- under a human, under n8n, and under an agent. An event inbox is that seam — all three write the
-- same row.
--
-- ── THERE IS NO EXPRESSION LANGUAGE, AND THAT IS THE MOST IMPORTANT DECISION HERE ───────────────
-- A rule line takes an amount from a NAMED PATH in the event payload, times an optional fixed
-- multiplier. That is all it can do. No arithmetic between fields, no conditionals, no functions.
--
-- The temptation is obvious and the cost is not: the moment a rule can COMPUTE, the chart of
-- accounts becomes a programming language with no debugger, no tests and no review — and "why did
-- this post there?" stops having a short answer. Accounting mappings are audited by people who read
-- them, not by people who trace them.
--
-- If a mapping needs logic, the EMITTING MODULE computes the number and puts it in the payload,
-- where it is ordinary code with ordinary tests. The multiplier exists only for the one case that
-- genuinely belongs to the mapping rather than the event: splitting one amount across two accounts
-- (a -1 to flip sign, a 0.5 to halve).
--
-- ── EVERY POSTING STILL GOES THROUGH finance_post_journal() ─────────────────────────────────────
-- This migration adds no second way into the ledger. `finance_process_event()` builds a line array
-- and hands it to F1's one way in, so balance validation, period guards, account guards, the hash
-- chain and idempotency all apply unchanged. A posting-rule engine that wrote journals directly
-- would be a second implementation of nine invariants.

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) finance_posting_rules — event type → journal template.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE finance_posting_rules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES companies(id),
  -- The business vocabulary, not the accounting one: 'sales.delivery.completed',
  -- 'hr.payroll.approved', 'webdev.hosting.renewed'.
  event_type    text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.]{2,80}$'),
  name          text NOT NULL,
  description   text,
  journal_kind  text NOT NULL DEFAULT 'standard'
                  CHECK (journal_kind IN ('standard','opening','adjustment','closing')),
  -- Which subledger this rule posts on behalf of, if any (F4-00). NULL = an ordinary journal, and
  -- control accounts stay barred to it.
  subledger     text CHECK (subledger IN ('ar','ap','inventory','fixed_assets','payroll','tax','bank','cash')),
  -- Effective dating, for the same reason tax codes have it: the mapping that applied when an event
  -- was posted is a fact about that posting, and re-mapping history breaks reproducibility.
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to   date,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','retired')),
  activated_at  timestamptz,
  activated_by  uuid REFERENCES users(id),
  origin_site   text NOT NULL DEFAULT 'central',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_finance_posting_rules_dates CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT ck_finance_posting_rules_activated CHECK (
    (status = 'active') = (activated_at IS NOT NULL)
  ),
  CONSTRAINT ux_finance_posting_rules_id_tenant UNIQUE (id, tenant_id)
);
-- At most ONE active rule per event type per company at a time. Two active rules for the same event
-- is not a feature — it is an ambiguity that would post one event two ways depending on row order.
CREATE UNIQUE INDEX ux_finance_posting_rules_active
  ON finance_posting_rules (tenant_id, event_type)
  WHERE status = 'active' AND effective_to IS NULL;
CREATE INDEX ix_finance_posting_rules_lookup ON finance_posting_rules (tenant_id, event_type, status);

CREATE TABLE finance_posting_rule_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES companies(id),
  rule_id       uuid NOT NULL,
  line_no       integer NOT NULL CHECK (line_no > 0),
  -- The account, BY CODE. Resolved at post time against the company's live chart, so an accountant
  -- renumbering an account breaks loudly (FINANCE_UNKNOWN_ACCOUNT) instead of posting silently to
  -- the wrong place — which is what a stored account id would do after a re-code.
  account_code  text NOT NULL,
  side          text NOT NULL CHECK (side IN ('debit','credit')),
  -- The ONLY dynamic part: a top-level key in the event payload holding the amount.
  amount_path   text NOT NULL CHECK (amount_path ~ '^[a-zA-Z][a-zA-Z0-9_]{0,60}$'),
  -- The ONLY arithmetic: a fixed multiplier. See the file header for why there is no more.
  multiplier    numeric(12,6) NOT NULL DEFAULT 1 CHECK (multiplier <> 0),
  memo_template text,
  CONSTRAINT fk_finance_posting_rule_lines_rule
    FOREIGN KEY (rule_id, tenant_id) REFERENCES finance_posting_rules (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT ux_finance_posting_rule_lines_no UNIQUE (rule_id, line_no),
  CONSTRAINT ux_finance_posting_rule_lines_id_tenant UNIQUE (id, tenant_id)
);
CREATE INDEX ix_finance_posting_rule_lines_rule ON finance_posting_rule_lines (rule_id, line_no);

COMMENT ON COLUMN finance_posting_rule_lines.account_code IS
  'BY CODE, resolved at post time. A stored account id would keep posting silently after an '
  'accountant re-codes an account; a code breaks loudly, which is the correct failure.';
COMMENT ON COLUMN finance_posting_rule_lines.multiplier IS
  'The only arithmetic a rule may do. Exists for splitting one payload amount across accounts '
  '(0.5) or flipping sign (-1). Anything more and the chart of accounts becomes an unauditable '
  'programming language — the emitting module computes it instead.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) finance_ledger_events — the inbox.
--
-- One row per business event. INSERT-FIRST idempotency: the unique index on
-- (tenant, source_event_id) is what makes a retrying emitter safe, not a prior SELECT.
--
-- ── A FAILED EVENT MUST NOT VANISH ──────────────────────────────────────────────────────────────
-- `status='failed'` is a VISIBLE, queryable state carrying the error — never a deleted row and
-- never a silent skip. Unposted revenue is precisely the thing nobody notices: the books simply
-- look smaller, everything reconciles, and the gap surfaces at year end. The event stays, with its
-- payload and its reason, until somebody resolves it.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE finance_ledger_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES companies(id),
  event_type      text NOT NULL,
  -- The emitter's own id for this event. The idempotency key.
  source_event_id text NOT NULL CHECK (length(btrim(source_event_id)) > 0),
  source_module   text,
  event_date      date NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}',
  description     text,

  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','posted','failed','ignored')),
  journal_entry_id uuid,
  error_code      text,
  error_detail    text,
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at timestamptz,

  -- Agent attribution: an event raised by an agent says so, and the journal it posts inherits it.
  acting_agent_id uuid,
  received_at     timestamptz NOT NULL DEFAULT now(),
  origin_site     text NOT NULL DEFAULT 'central',

  CONSTRAINT fk_finance_ledger_events_journal
    FOREIGN KEY (journal_entry_id, tenant_id) REFERENCES finance_journal_entries (id, tenant_id),
  CONSTRAINT ux_finance_ledger_events_source UNIQUE (tenant_id, source_event_id),
  CONSTRAINT ux_finance_ledger_events_id_tenant UNIQUE (id, tenant_id),
  CONSTRAINT ck_finance_ledger_events_posted CHECK (
    (status = 'posted') = (journal_entry_id IS NOT NULL)
  ),
  CONSTRAINT ck_finance_ledger_events_failed CHECK (
    status <> 'failed' OR error_code IS NOT NULL
  )
);
-- The work queue: what still needs posting, oldest first.
CREATE INDEX ix_finance_ledger_events_pending
  ON finance_ledger_events (tenant_id, received_at)
  WHERE status IN ('pending','failed');
CREATE INDEX ix_finance_ledger_events_type ON finance_ledger_events (tenant_id, event_type, status);

COMMENT ON TABLE finance_ledger_events IS
  'The seam other departments post through. Insert-first idempotency on (tenant, source_event_id). '
  'A failed event stays VISIBLE with its reason — unposted revenue is the thing nobody notices, '
  'because the books simply look smaller and everything still reconciles.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (3) finance_process_event() — resolve the rule, build the lines, hand them to F1.
--
-- Returns the journal entry id on success. On failure it records the reason on the event and
-- RE-RAISES, so a caller in a transaction rolls back cleanly — but a caller that catches (the
-- sweeper below) leaves a durable, readable failure behind.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION finance_process_event(p_event uuid, p_actor uuid DEFAULT NULL)
  RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_ev    finance_ledger_events%ROWTYPE;
  v_rule  finance_posting_rules%ROWTYPE;
  v_lines jsonb := '[]'::jsonb;
  v_line  record;
  v_amt   numeric;
  v_raw   text;
  v_entry uuid;
BEGIN
  SELECT * INTO v_ev FROM finance_ledger_events WHERE id = p_event;
  IF v_ev.id IS NULL THEN
    RAISE EXCEPTION 'FINANCE_EVENT_UNKNOWN: no event %', p_event;
  END IF;
  IF v_ev.status = 'posted' THEN
    RETURN v_ev.journal_entry_id;   -- idempotent: already done
  END IF;
  IF v_ev.status = 'ignored' THEN
    RAISE EXCEPTION 'FINANCE_EVENT_IGNORED: event % was deliberately excluded', v_ev.source_event_id;
  END IF;

  -- Resolve the ONE active rule for this event type, as at the event's own date.
  SELECT * INTO v_rule FROM finance_posting_rules r
   WHERE r.tenant_id = v_ev.tenant_id
     AND r.event_type = v_ev.event_type
     AND r.status = 'active'
     AND v_ev.event_date >= r.effective_from
     AND (r.effective_to IS NULL OR v_ev.event_date <= r.effective_to)
   ORDER BY r.effective_from DESC
   LIMIT 1;

  IF v_rule.id IS NULL THEN
    -- ⚠ DISTINGUISH "no rule" FROM "a rule exists but is not effective on this date".
    --
    -- These are completely different problems — one needs a rule authored, the other needs a date
    -- changed — and they were the same message in the first draft. The F2 test suite hit it
    -- immediately: a rule created today cannot post an event dated in February (effective_from
    -- defaults to CURRENT_DATE), and the error said "no active posting rule" while the rule sat
    -- there plainly active. That is the kind of message that costs an hour.
    --
    -- The effective-dating behaviour itself is CORRECT and deliberate: a mapping is effective from
    -- when you make it, and back-dating it silently would re-map history. Loading historical events
    -- means setting effective_from deliberately — which is exactly the decision that should be
    -- explicit.
    SELECT * INTO v_rule FROM finance_posting_rules r
     WHERE r.tenant_id = v_ev.tenant_id AND r.event_type = v_ev.event_type AND r.status = 'active'
     ORDER BY r.effective_from LIMIT 1;

    IF v_rule.id IS NOT NULL THEN
      UPDATE finance_ledger_events
         SET status='failed', error_code='RULE_NOT_EFFECTIVE',
             error_detail='rule "' || v_rule.name || '" for ' || v_ev.event_type ||
                          ' is active but effective from ' || v_rule.effective_from::text ||
                          coalesce(' to ' || v_rule.effective_to::text, '') ||
                          '; this event is dated ' || v_ev.event_date::text,
             attempts = attempts + 1, last_attempt_at = now()
       WHERE id = p_event;
      RAISE EXCEPTION 'FINANCE_RULE_NOT_EFFECTIVE: rule "%" is effective from % but the event is dated %',
        v_rule.name, v_rule.effective_from, v_ev.event_date
        USING HINT = 'Back-date the rule deliberately, or correct the event date. Back-dating re-maps history.';
    END IF;

    UPDATE finance_ledger_events
       SET status='failed', error_code='NO_ACTIVE_RULE',
           error_detail='no active posting rule exists for event type ' || v_ev.event_type,
           attempts = attempts + 1, last_attempt_at = now()
     WHERE id = p_event;
    RAISE EXCEPTION 'FINANCE_NO_ACTIVE_RULE: no active posting rule for event type %', v_ev.event_type;
  END IF;

  -- Build the lines. Every amount comes from a named payload key times a fixed multiplier.
  FOR v_line IN
    SELECT * FROM finance_posting_rule_lines WHERE rule_id = v_rule.id ORDER BY line_no
  LOOP
    v_raw := v_ev.payload ->> v_line.amount_path;
    IF v_raw IS NULL THEN
      UPDATE finance_ledger_events
         SET status='failed', error_code='PAYLOAD_MISSING_PATH',
             error_detail='rule line ' || v_line.line_no || ' expects payload key "' ||
                          v_line.amount_path || '" and the event does not carry it',
             attempts = attempts + 1, last_attempt_at = now()
       WHERE id = p_event;
      RAISE EXCEPTION 'FINANCE_PAYLOAD_MISSING_PATH: event % has no payload key "%"',
        v_ev.source_event_id, v_line.amount_path;
    END IF;

    BEGIN
      v_amt := round(v_raw::numeric * v_line.multiplier, 4);
    EXCEPTION WHEN others THEN
      UPDATE finance_ledger_events
         SET status='failed', error_code='PAYLOAD_NOT_NUMERIC',
             error_detail='payload key "' || v_line.amount_path || '" is not a number: ' || v_raw,
             attempts = attempts + 1, last_attempt_at = now()
       WHERE id = p_event;
      RAISE EXCEPTION 'FINANCE_PAYLOAD_NOT_NUMERIC: payload key "%" is not a number', v_line.amount_path;
    END;

    -- A zero line is skipped rather than rejected: a rule that maps an optional component (a
    -- discount, a tax) legitimately produces zero when the event has none, and F1 refuses
    -- non-positive amounts. Skipping keeps one rule usable for both shapes.
    IF v_amt <> 0 THEN
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'account_code', v_line.account_code,
        'side', CASE WHEN v_amt > 0 THEN v_line.side
                     ELSE CASE v_line.side WHEN 'debit' THEN 'credit' ELSE 'debit' END END,
        'amount', abs(v_amt),
        'memo', coalesce(v_line.memo_template, v_rule.name)));
    END IF;
  END LOOP;

  IF jsonb_array_length(v_lines) = 0 THEN
    UPDATE finance_ledger_events
       SET status='failed', error_code='RULE_PRODUCED_NO_LINES',
           error_detail='every rule line evaluated to zero for this payload',
           attempts = attempts + 1, last_attempt_at = now()
     WHERE id = p_event;
    RAISE EXCEPTION 'FINANCE_RULE_PRODUCED_NO_LINES: rule % produced nothing for event %',
      v_rule.name, v_ev.source_event_id;
  END IF;

  -- Hand off to F1's ONE way in. Balance, period, account and chain guards all apply unchanged.
  v_entry := finance_post_journal(
    v_ev.tenant_id, v_ev.event_date,
    'evt:' || v_ev.source_event_id,
    coalesce(v_ev.description, v_rule.name),
    v_lines, p_actor, v_rule.journal_kind, v_ev.acting_agent_id, NULL, NULL, NULL, v_rule.subledger);

  UPDATE finance_ledger_events
     SET status='posted', journal_entry_id=v_entry, error_code=NULL, error_detail=NULL,
         attempts = attempts + 1, last_attempt_at = now()
   WHERE id = p_event;

  RETURN v_entry;
END $$;
COMMENT ON FUNCTION finance_process_event(uuid,uuid) IS
  'Resolves the one active posting rule for the event type as at the event date, builds lines from '
  'named payload keys, and hands them to finance_post_journal(). Adds NO second way into the ledger.';

-- ── The sweeper: process what is queued, and leave failures durable ─────────────────────────────
-- Each event is processed in its own subtransaction so one bad event cannot roll back the batch —
-- and its failure record survives, which a single flat transaction would discard along with the
-- error.
CREATE OR REPLACE FUNCTION finance_process_pending_events(
  p_company uuid, p_limit integer DEFAULT 100, p_actor uuid DEFAULT NULL
) RETURNS TABLE (processed integer, failed integer) LANGUAGE plpgsql AS $$
DECLARE
  v_id  uuid;
  v_ok  integer := 0;
  v_bad integer := 0;
BEGIN
  FOR v_id IN
    SELECT id FROM finance_ledger_events
     WHERE tenant_id = p_company AND status = 'pending'
     ORDER BY received_at
     LIMIT p_limit
  LOOP
    BEGIN
      PERFORM finance_process_event(v_id, p_actor);
      v_ok := v_ok + 1;
    EXCEPTION WHEN others THEN
      -- finance_process_event() already recorded the reason on the row before raising; the
      -- subtransaction rollback undoes that too, so re-record it here where it survives.
      UPDATE finance_ledger_events
         SET status = 'failed',
             error_code = coalesce(nullif(SQLSTATE,''), 'ERROR'),
             error_detail = SQLERRM,
             attempts = attempts + 1,
             last_attempt_at = now()
       WHERE id = v_id;
      v_bad := v_bad + 1;
    END;
  END LOOP;
  RETURN QUERY SELECT v_ok, v_bad;
END $$;
COMMENT ON FUNCTION finance_process_pending_events(uuid,integer,uuid) IS
  'Each event in its own subtransaction so one bad event cannot roll back the batch — and so its '
  'failure record SURVIVES, which a single flat transaction would discard along with the error.';

-- ── finance_event_backlog() — what is stuck, and why ────────────────────────────────────────────
-- The operational view. A failed event is invisible unless somebody looks, so this is the thing a
-- close checklist or a monitor reads.
CREATE OR REPLACE FUNCTION finance_event_backlog(p_company uuid)
  RETURNS TABLE (status text, event_type text, error_code text, count bigint, oldest timestamptz)
  LANGUAGE sql STABLE AS $$
  SELECT e.status, e.event_type, e.error_code, count(*), min(e.received_at)
    FROM finance_ledger_events e
   WHERE e.tenant_id = p_company AND e.status IN ('pending','failed')
   GROUP BY e.status, e.event_type, e.error_code
   ORDER BY min(e.received_at)
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (4) The finance third wall.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'finance_posting_rules','finance_posting_rule_lines','finance_ledger_events'
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
