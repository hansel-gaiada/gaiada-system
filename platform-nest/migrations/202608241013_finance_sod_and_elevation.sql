-- Finance F0-08/F0-10 — SEGREGATION OF DUTIES, ELEVATION GRANTS, AND THE ACCESS LOG.
--
-- The control layer for the access topology in blueprint section 10. Three objects:
--
--   finance_duty_assignments   who holds which duty in which company  (the SoD matrix's input)
--   finance_access_grants      time-boxed, purpose-tagged elevation   (the "approval from Anthony")
--   finance_access_log         who LOOKED, not only who posted
--
-- ── WHY SoD IS DATA AND NOT A ROLE NAME (blueprint section 2.2, 10.5) ────────────────────────────
-- The rule auditors and bank credit teams test first: no one person may perform two of
-- {authorise, record, custody, reconcile} for the same transaction class. That cannot be expressed
-- by role names alone, because the conflict is between two grants held by one person IN ONE
-- COMPANY — and our finance departments are SHARED (owner ruling, blueprint section 10.1). A single
-- AP officer serving five companies is efficient and concentrates risk: the department collectively
-- separates duties while the individual does not.
--
-- So the binding is PER COMPANY, PER PERSON. `finance_duty_assignments` records the pair, and
-- `finance_sod_conflicts` (seeded below, editable) records which pairs may not coexist. The check
-- is a function, so the service layer, a migration, and a test all ask the same question.
--
-- ── WHY ELEVATION IS A GRANT WITH AN EXPIRY, NOT A ROLE ──────────────────────────────────────────
-- Owner ruling, blueprint section 10.3: "the higher the role can see below company after approval
-- from Anthony." Modelled deliberately narrowly:
--
--   * The OWNER and the holding CFO are NOT gated. Requiring the owner to request permission to see
--     his own companies inverts the relationship — Anthony approves on the owner's behalf. Their
--     scope comes from the ownership graph (202608241010) and from IAM positions, never from here.
--   * This object exists for STAFF reaching outside their staffed scope, and for every WRITE
--     outside it.
--   * It EXPIRES ON ITS OWN. Nothing may depend on someone remembering to revoke it.
--   * The approver is a POSITION, not a person. A hardcoded user id becomes an outage the first
--     week Anthony is on a plane, and cannot survive him changing roles.
--
-- ── WHY THE ACCESS LOG IS SEPARATE FROM THE AUDIT TRAIL ──────────────────────────────────────────
-- The ledger's audit trail answers "who changed this figure". Auditors also ask "who LOOKED at this
-- company's books, and under what authority". A read leaves no trace in the ledger by construction,
-- so it needs its own append-only record. This is also the only way an ungated owner read stays
-- visible: the ruling says never blocked, it does not say never recorded.
--
-- Additive. No existing table is touched.

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) finance_duties + finance_sod_conflicts — the matrix. Seeded, then owned by the accountant.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE finance_duties (
  key         text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{2,40}$'),
  name        text NOT NULL,
  -- Which of the four classical control functions this duty performs. Two duties conflict when
  -- they put one person on two sides of the same transaction class.
  control_function text NOT NULL CHECK (control_function IN ('authorise','record','custody','reconcile')),
  description text
);

INSERT INTO finance_duties (key, name, control_function, description) VALUES
  ('vendor_master',      'Vendor master maintenance',   'record',    'Create/edit vendors and their bank details'),
  ('ap_bill_entry',      'AP bill entry',               'record',    'Enter vendor bills'),
  ('ap_payment_approve', 'AP payment approval',         'authorise', 'Approve a payment run or a single payment'),
  ('ap_payment_release', 'AP payment release',          'custody',   'Actually move the money'),
  ('ar_receipt_posting', 'AR receipt posting',          'record',    'Apply customer receipts'),
  ('ar_writeoff_approve','AR credit note / write-off approval','authorise','Forgive or reduce a receivable'),
  ('cash_custody',       'Cash and bank custody',       'custody',   'Holds the cash or the banking credentials'),
  ('bank_reconcile',     'Bank reconciliation',         'reconcile', 'Match the statement to the ledger'),
  ('journal_post',       'Journal entry posting',       'record',    'Post manual journals'),
  ('period_close',       'Period close approval',       'authorise', 'Soft/hard lock a fiscal period'),
  ('payroll_master',     'Payroll master data',         'record',    'Employee pay rates and bank accounts'),
  ('payroll_release',    'Payroll run release',         'custody',   'Release the payroll payment');

CREATE TABLE finance_sod_conflicts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  duty_a      text NOT NULL REFERENCES finance_duties(key),
  duty_b      text NOT NULL REFERENCES finance_duties(key),
  severity    text NOT NULL DEFAULT 'blocking' CHECK (severity IN ('blocking','warning')),
  rationale   text NOT NULL,
  -- Ordered pair stored canonically so (a,b) and (b,a) cannot both exist and be checked
  -- inconsistently. The check function normalises before lookup.
  CONSTRAINT ck_finance_sod_conflicts_order CHECK (duty_a < duty_b),
  CONSTRAINT ux_finance_sod_conflicts_pair UNIQUE (duty_a, duty_b)
);

-- The six pairs from blueprint section 2.2, canonically ordered (duty_a < duty_b).
INSERT INTO finance_sod_conflicts (duty_a, duty_b, severity, rationale) VALUES
  ('ap_payment_release','vendor_master',      'blocking','Invent a vendor, pay yourself'),
  ('ap_bill_entry',     'ap_payment_approve', 'blocking','Approve your own invoice'),
  ('bank_reconcile',    'cash_custody',       'blocking','Hide the theft inside the reconciliation'),
  ('ar_receipt_posting','ar_writeoff_approve','blocking','Pocket the cash, then write off the debt'),
  ('journal_post',      'period_close',       'blocking','Post an adjustment nobody reviews'),
  ('payroll_master',    'payroll_release',    'blocking','Ghost employees');

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) finance_duty_assignments — person × company × duty. The unit the conflict is checked on.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE finance_duty_assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES companies(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  duty_key    text NOT NULL REFERENCES finance_duties(key),
  -- A compensating control: the conflict was accepted because someone reviews an exception report.
  -- Recording WHY and WHO makes it an artefact an auditor can test, rather than a habit. Blueprint
  -- section 2.2: in a small team one human holds several duties, and that is survivable only if the
  -- compensation is written down.
  conflict_waiver_reason  text,
  conflict_waived_by      uuid REFERENCES users(id),
  conflict_waived_at      timestamptz,
  granted_by  uuid REFERENCES users(id),
  granted_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  origin_site text NOT NULL DEFAULT 'central',
  CONSTRAINT ck_finance_duty_assignments_waiver CHECK (
    num_nonnulls(conflict_waiver_reason, conflict_waived_by, conflict_waived_at) IN (0,3)
  ),
  CONSTRAINT ux_finance_duty_assignments_id_tenant UNIQUE (id, tenant_id)
);
CREATE UNIQUE INDEX ux_finance_duty_assignments_live
  ON finance_duty_assignments (tenant_id, user_id, duty_key) WHERE revoked_at IS NULL;
CREATE INDEX ix_finance_duty_assignments_user ON finance_duty_assignments (user_id) WHERE revoked_at IS NULL;

-- ── finance_sod_check(company, user, duty) — what would conflict if this duty were granted ──────
-- Returns the offending rows; an empty result means the grant is clean. A FUNCTION rather than a
-- constraint because the answer is needed BEFORE the write (to warn, or to demand a waiver), and
-- because a waived conflict must still be recordable — a hard constraint would make the
-- compensating-control case unrepresentable and push it off-system into a spreadsheet.
CREATE OR REPLACE FUNCTION finance_sod_check(p_company uuid, p_user uuid, p_duty text)
  RETURNS TABLE (conflicting_duty text, severity text, rationale text)
  LANGUAGE sql STABLE AS $$
  SELECT a.duty_key, c.severity, c.rationale
    FROM finance_duty_assignments a
    JOIN finance_sod_conflicts c
      ON (c.duty_a = LEAST(a.duty_key, p_duty) AND c.duty_b = GREATEST(a.duty_key, p_duty))
   WHERE a.tenant_id = p_company
     AND a.user_id   = p_user
     AND a.revoked_at IS NULL
     AND a.duty_key <> p_duty
$$;
COMMENT ON FUNCTION finance_sod_check(uuid, uuid, text) IS
  'Blueprint section 2.2/10.5. Bound PER COMPANY PER PERSON: a shared-service officer serving five '
  'companies may hold ap_bill_entry in one and ap_payment_approve in another without conflict, but '
  'never both in the same company.';
GRANT EXECUTE ON FUNCTION finance_sod_check(uuid, uuid, text) TO PUBLIC;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (3) finance_access_grants — elevation. Time-boxed, purpose-tagged, self-expiring.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE finance_access_grants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The company being REACHED. Anchored on the target, never on a membership the requester already
  -- holds — a cross-company grant has no root, and anchoring it on the requester's own company is
  -- how a grant silently authorises itself.
  tenant_id     uuid NOT NULL REFERENCES companies(id),
  grantee_id    uuid NOT NULL REFERENCES users(id),

  -- 'read_detail' — a subsidiary's transaction-level GL/invoices/payroll (group AGGREGATES need no
  --                 grant; gating those would make a holding CFO's job impossible).
  -- 'write'       — posting. Requires a finance position in that company as WELL as this grant:
  --                 approval alone never confers posting rights.
  scope         text NOT NULL CHECK (scope IN ('read_detail','write')),
  purpose       text NOT NULL CHECK (length(btrim(purpose)) >= 8),

  requested_at  timestamptz NOT NULL DEFAULT now(),
  approved_by   uuid REFERENCES users(id),
  approved_at   timestamptz,
  -- The approver POSITION that authorised it — not a person. Anthony holds the position; the
  -- position outlives him being on a plane, or changing roles.
  approver_position_key text,

  -- D14 semantics: approving EXECUTES. `expires_at` is set at approval, and the grant is live from
  -- that instant until it lapses. There is no separate "activate" step to forget.
  expires_at    timestamptz,
  revoked_at    timestamptz,
  revoked_by    uuid REFERENCES users(id),

  -- Pairs with the existing /step-up re-authentication on the elevated session.
  step_up_required boolean NOT NULL DEFAULT true,

  origin_site   text NOT NULL DEFAULT 'central',
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_finance_access_grants_approval CHECK (
    num_nonnulls(approved_by, approved_at) <> 1
  ),
  -- An approved grant MUST have an expiry, and it must be in the future relative to approval.
  -- An indefinite elevation is the failure mode this whole object exists to prevent.
  CONSTRAINT ck_finance_access_grants_expiry CHECK (
    approved_at IS NULL OR (expires_at IS NOT NULL AND expires_at > approved_at)
  ),
  CONSTRAINT ux_finance_access_grants_id_tenant UNIQUE (id, tenant_id)
);
CREATE INDEX ix_finance_access_grants_live
  ON finance_access_grants (grantee_id, tenant_id, scope, expires_at)
  WHERE approved_at IS NOT NULL AND revoked_at IS NULL;

COMMENT ON TABLE finance_access_grants IS
  'Elevation for STAFF reaching outside their staffed scope, and for every write outside it. NOT '
  'for the owner or the holding CFO — their scope comes from the ownership graph and IAM positions '
  '(blueprint section 10.3). Self-expiring by construction.';

-- ── finance_has_elevated_access(user, company, scope) — one place that decides "is it live" ─────
-- Deliberately a single function so no caller re-implements the four conditions and forgets one.
-- The one most often forgotten is `expires_at > now()`, which is precisely the condition that makes
-- the grant temporary rather than permanent.
-- SECURITY DEFINER for the same reason as finance_owner_company_ids: an elevation grant is an INPUT
-- to the scope decision, so it must be readable before the scope exists. Returns a boolean and
-- nothing else.
CREATE OR REPLACE FUNCTION finance_has_elevated_access(p_user uuid, p_company uuid, p_scope text)
  RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE
  SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM finance_access_grants g
     WHERE g.grantee_id = p_user
       AND g.tenant_id  = p_company
       AND g.scope      = p_scope
       AND g.approved_at IS NOT NULL
       AND g.revoked_at  IS NULL
       AND g.expires_at  > now()
  )
$$;
GRANT EXECUTE ON FUNCTION finance_has_elevated_access(uuid, uuid, text) TO PUBLIC;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (4) finance_access_log — append-only. Who LOOKED.
--
-- No UPDATE or DELETE is granted anywhere; the table is written and then only read. A revoke or a
-- correction is a NEW row, never an edit — the same posture the ledger itself will take in F1.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE finance_access_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES companies(id),
  user_id     uuid REFERENCES users(id),
  -- Null for a human. Set when an agent answered under a caller's scope — the leak channel RLS
  -- alone does not close (blueprint section 10.3b), so the trail records WHICH scope it answered in.
  acting_agent_id uuid,
  action      text NOT NULL,            -- 'read_gl' | 'export_statements' | ...
  resource    text,                     -- optional: the account/report/period reached
  -- 'baseline'  — position or ownership scope
  -- 'elevated'  — under a finance_access_grants row (id recorded below)
  -- 'ownership' — the ungated owner/holding-CFO path: never blocked, always recorded
  basis       text NOT NULL CHECK (basis IN ('baseline','elevated','ownership','external')),
  grant_id    uuid REFERENCES finance_access_grants(id),
  request_id  text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_finance_access_log_grant CHECK (basis <> 'elevated' OR grant_id IS NOT NULL)
);
CREATE INDEX ix_finance_access_log_tenant_time ON finance_access_log (tenant_id, occurred_at DESC);
CREATE INDEX ix_finance_access_log_user_time   ON finance_access_log (user_id, occurred_at DESC);

COMMENT ON TABLE finance_access_log IS
  'Append-only record of finance READS. The ledger audit trail says who changed a figure; auditors '
  'also ask who looked and under what authority. basis=ownership covers the ungated owner path — '
  'the ruling says never blocked, not never recorded.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (5) The finance third wall.
--
-- finance_duties and finance_sod_conflicts are global reference data (the matrix is a standard, not
-- a company's data) and carry no tenant_id, like finance_currencies and the CoA templates.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'finance_duty_assignments','finance_access_grants','finance_access_log'
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
