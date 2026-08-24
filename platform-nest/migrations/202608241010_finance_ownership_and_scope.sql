-- Finance F0-01/F0-02 — THE MODULE WALL AND THE OWNERSHIP GRAPH.
--
-- First migration of the Finance & Accounting program
-- (docs/blueprints/finance-accounting-foundation.md; tracker docs/plans/2026-08-24-finance-PROGRESS.md).
-- It deliberately creates NO accounting object. Nothing here posts, balances, or closes. It creates
-- the two things every later finance query has to pass through, because both are impossible to
-- retrofit:
--
--   (1) the `finance` third wall — the module predicate composed into every finance_* RLS policy
--       from here on, established byte-identically to 0028's `hr` wall;
--   (2) the OWNERSHIP GRAPH and its scope resolver — who may see which company's books.
--
-- ── WHY OWNERSHIP IS A GRAPH AND NOT A ROLE FLAG (owner ruling D-F8, 2026-08-24) ─────────────────
-- The ruling: "holding owner should be able to see all; but company owner or shareholder could be
-- only a company, or some." A boolean `is_owner` cannot express that, and a hand-maintained list of
-- company ids per owner is a list somebody forgets to update the day a sixth PT is incorporated.
--
-- So scope is DERIVED. The holding owner owns the ROOT entity; the root owns the subsidiaries
-- (`companies.parent_company_id`, which has existed since 0001 and is used here rather than
-- duplicated). "Sees all" therefore falls out of a walk, and a new subsidiary becomes visible the
-- moment its parent edge exists — with no permission edit and no chance of missing one.
--
-- ── WHY THIS TABLE IS NOT `companies.parent_company_id` ──────────────────────────────────────────
-- That column is entity→entity: which company is inside which. This table is holder→company: WHO
-- owns it, person or entity, and how much. Both are needed and they answer different questions.
-- A person never appears in `parent_company_id`, and a stake percentage has nowhere to live there.
--
-- ── WHAT THIS TABLE IS NOT ───────────────────────────────────────────────────────────────────────
-- **It is not a directorship register.** The blueprint (§10.3b) separates two grants that routinely
-- sit on the same human: a SHAREHOLDER holds an economic claim (⇒ financial statements, equity
-- account, dividends — NOT the transaction-level GL), while a DIRECTOR / owner-manager runs the
-- company (⇒ full detail for that company). Directorship is a POSITION and belongs in the IAM
-- position tree from 0109, not here. Conflating them is how a 5% investor ends up reading payroll.
--
-- ── ENFORCEMENT MODEL ────────────────────────────────────────────────────────────────────────────
-- These functions resolve a scope; they do not enforce one. The app calls the resolver, sets the
-- `app.current_tenant_ids` GUC through the existing `withTenants(...)` path, and RLS does the
-- enforcing exactly as it does for every other module. That keeps ONE enforcement point instead of
-- a second, subtly-different one — and it means a finance query that forgets the scope reads ZERO
-- rows rather than everything (0025's fail-closed contract).
--
-- Additive. No table is altered, no row is written. `company_ownership` starts EMPTY: the real
-- ownership map is open question Q9 and is owner-supplied data, not something this file may invent.
-- An empty graph resolves to an empty scope, which is the correct fail-closed answer.

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (1) company_ownership — holder → company, economic ownership only.
--
-- `tenant_id` IS the owned company. Naming it `tenant_id` rather than `company_id` is not cosmetic:
-- it is what makes the row reachable by the standard `tenant_isolation` policy shape used by every
-- other table in this database. A second, differently-named company column would need its own
-- policy and would drift. (Tenancy in this schema *is* company — `tenant_id uuid REFERENCES
-- companies(id)` throughout since 0001.)
--
-- The holder is a person OR an entity, never both and never neither — see ck_company_ownership_holder.
-- Entity holders are what make the transitive walk work: the holding PT holds its subsidiaries.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE company_ownership (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The OWNED company. Data never re-homes (the 0028 convention).
  tenant_id         uuid NOT NULL REFERENCES companies(id),

  -- Exactly one of these two is set.
  holder_user_id    uuid REFERENCES users(id),
  holder_company_id uuid REFERENCES companies(id),

  -- 'holding'     — an entity edge: this holder IS the parent/holding vehicle. Confers the
  --                 transitive walk in finance_owner_company_ids().
  -- 'shareholder' — an economic stake in this company alone. NO transitive reach: a shareholder of
  --                 company A sees A, never A's siblings, and never a group total that would leak
  --                 the others by arithmetic (blueprint §10.3b).
  kind              text NOT NULL CHECK (kind IN ('holding','shareholder')),

  -- Nullable on purpose: the stake may be legally recorded elsewhere and unknown to us, and a
  -- fabricated 0 or 100 would be worse than an honest NULL. numeric, never float — a percentage
  -- feeds dividend and equity arithmetic.
  stake_pct         numeric(9,6) CHECK (stake_pct IS NULL OR (stake_pct > 0 AND stake_pct <= 100)),

  -- Effective dating: ownership changes, and last year's statements were true under last year's
  -- cap table. NULL `effective_to` = current.
  effective_from    date NOT NULL DEFAULT CURRENT_DATE,
  effective_to      date,

  notes             text,
  origin_site       text NOT NULL DEFAULT 'central',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,

  -- A holder is a person or an entity. `num_nonnulls` states that in one place; two separate
  -- IS NULL checks drift the first time someone adds a third holder kind.
  CONSTRAINT ck_company_ownership_holder CHECK (
    num_nonnulls(holder_user_id, holder_company_id) = 1
  ),
  -- A company cannot own itself. Without this, the descendant walk has a trivial cycle on day one.
  CONSTRAINT ck_company_ownership_not_self CHECK (
    holder_company_id IS NULL OR holder_company_id <> tenant_id
  ),
  CONSTRAINT ck_company_ownership_dates CHECK (
    effective_to IS NULL OR effective_to >= effective_from
  ),
  -- Composite-FK anchor (the 0027/0081 pattern), so a future child row cannot point at a parent in
  -- another tenant.
  CONSTRAINT ux_company_ownership_id_tenant UNIQUE (id, tenant_id)
);

-- One LIVE edge per holder per company. Two partial indexes rather than one UNIQUE over all four
-- columns, because NULL defeats UNIQUE: with a plain constraint, ten rows with a NULL
-- holder_user_id would all be "distinct" and the duplicate we are trying to forbid slips through.
-- (This trap is recorded in the program's own history — global rows need a partial index.)
CREATE UNIQUE INDEX ux_company_ownership_user_live
  ON company_ownership (tenant_id, holder_user_id)
  WHERE holder_user_id IS NOT NULL AND deleted_at IS NULL AND effective_to IS NULL;
CREATE UNIQUE INDEX ux_company_ownership_entity_live
  ON company_ownership (tenant_id, holder_company_id)
  WHERE holder_company_id IS NOT NULL AND deleted_at IS NULL AND effective_to IS NULL;

-- The resolver's hot path: "which companies does this person hold?" — the walk starts here.
CREATE INDEX ix_company_ownership_holder_user
  ON company_ownership (holder_user_id)
  WHERE holder_user_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX ix_company_ownership_holder_company
  ON company_ownership (holder_company_id)
  WHERE holder_company_id IS NOT NULL AND deleted_at IS NULL;

COMMENT ON TABLE company_ownership IS
  'Economic ownership edges (holder -> owned company), F0-02. Person or entity holders; entity '
  'holders drive the transitive walk in finance_owner_company_ids(). NOT a directorship register — '
  'a director is an IAM position (0109). Blueprint docs/blueprints/finance-accounting-foundation.md '
  'section 10.3b, owner ruling D-F8.';
COMMENT ON COLUMN company_ownership.tenant_id IS 'The OWNED company. Named tenant_id so the standard tenant_isolation policy applies unchanged.';
COMMENT ON COLUMN company_ownership.kind IS
  'holding = entity parent edge, confers transitive reach over descendants. shareholder = stake in '
  'this company ONLY, no group reach (a group total would leak sibling companies by arithmetic).';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (2) finance_company_descendants(root) — the corporate-structure walk.
--
-- Walks `companies.parent_company_id` downward from `root`, INCLUSIVE of root itself.
--
-- Cycle safety is not optional here. `parent_company_id` has no constraint preventing A→B→A (0001
-- did not add one, and adding one now would need a check over live data this file is not entitled
-- to touch). An unguarded recursive CTE against a cycle does not return a wrong answer — it hangs
-- the connection. The `path` array + NOT ok cutoff makes a cycle terminate quietly instead.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- SECURITY DEFINER: see the note on finance_owner_company_ids below. Returns company IDs only.
CREATE OR REPLACE FUNCTION finance_company_descendants(root uuid)
  RETURNS TABLE (company_id uuid)
  LANGUAGE sql STABLE PARALLEL SAFE
  SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    WITH RECURSIVE walk AS (
      SELECT c.id, ARRAY[c.id] AS path
        FROM companies c
       WHERE c.id = root
         AND c.deleted_at IS NULL
      UNION ALL
      SELECT c.id, w.path || c.id
        FROM companies c
        JOIN walk w ON c.parent_company_id = w.id
       WHERE c.deleted_at IS NULL
         AND NOT c.id = ANY(w.path)          -- cycle cutoff
         AND array_length(w.path, 1) < 32     -- depth backstop; no real group nests this deep
    )
    SELECT DISTINCT id FROM walk
  $$;
COMMENT ON FUNCTION finance_company_descendants(uuid) IS
  'Inclusive downward walk of companies.parent_company_id. Cycle- and depth-guarded: parent_company_id '
  'carries no acyclicity constraint, and an unguarded recursive CTE would hang rather than err.';
GRANT EXECUTE ON FUNCTION finance_company_descendants(uuid) TO PUBLIC;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (3) finance_owner_company_ids(user) — THE SCOPE RESOLVER. Ruling D-F8 in one function.
--
--   holding edge     -> that company AND every descendant   (the holding owner "sees all")
--   shareholder edge -> that company ONLY                    (no sibling reach, no group total)
--
-- Returns the empty set for a user with no edges, which is the correct fail-closed answer and the
-- state every user is in until the ownership map (Q9) is loaded.
--
-- ⚠ This resolves ECONOMIC scope only. It is not the whole answer to "what may this person see":
--   * a shareholder's DEPTH is capped at the statements tier by authz (Cerbos, F0-09), not here —
--     this function says WHICH companies, never HOW DEEP;
--   * staff scope comes from IAM positions, not from ownership;
--   * elevation grants (F0-10) add companies temporarily.
-- The app unions these sources and sets the GUC. Callers must not treat this as the final word.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- ⚠ SECURITY DEFINER, and it has to be. A scope resolver CANNOT be gated by the scope it resolves:
--   RLS on `company_ownership` admits rows only for companies already in `app.current_tenant_ids`,
--   but this function exists to COMPUTE that set, before it is set. Running it as the caller returns
--   the empty set for everyone — including the holding owner — and the failure is silent, because an
--   empty scope is indistinguishable from "owns nothing".
--
--   Caught by src/db/finance-f0-foundations.test.ts on its first run: every ownership assertion
--   returned [] against a fixture that plainly had edges. Left as INVOKER it would have shipped as
--   "the owner sees nothing", which is the exact opposite of ruling D-F8.
--
--   The widening is bounded and deliberate: this returns COMPANY IDS and nothing else — no balance,
--   no journal, no name. It is an input to authorization, not a bypass of it; RLS still governs
--   every table the resolved scope is then used against. search_path is pinned so a caller cannot
--   shadow `company_ownership` with a temp table.
CREATE OR REPLACE FUNCTION finance_owner_company_ids(p_user uuid)
  RETURNS TABLE (company_id uuid)
  LANGUAGE sql STABLE PARALLEL SAFE
  SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    WITH direct AS (
      SELECT o.tenant_id, o.kind
        FROM company_ownership o
       WHERE o.holder_user_id = p_user
         AND o.deleted_at IS NULL
         AND o.effective_to IS NULL
    ),
    -- A person may hold the holding VEHICLE rather than the operating companies directly; that
    -- entity's own holdings are theirs too. One hop is deliberate: multi-level holder-of-holder
    -- chains are resolved by the descendant walk below, not by recursing this table.
    via_entity AS (
      SELECT o2.tenant_id, o2.kind
        FROM direct d
        JOIN company_ownership o2
          ON o2.holder_company_id = d.tenant_id
       WHERE d.kind = 'holding'
         AND o2.deleted_at IS NULL
         AND o2.effective_to IS NULL
    ),
    edges AS (
      SELECT * FROM direct
      UNION
      SELECT * FROM via_entity
    )
    SELECT DISTINCT x.company_id FROM (
      -- holding: the company and everything under it
      SELECT d.company_id
        FROM edges e
        CROSS JOIN LATERAL finance_company_descendants(e.tenant_id) d
       WHERE e.kind = 'holding'
      UNION
      -- shareholder: that company, and nothing else
      SELECT e.tenant_id
        FROM edges e
       WHERE e.kind = 'shareholder'
    ) x
  $$;
COMMENT ON FUNCTION finance_owner_company_ids(uuid) IS
  'Owner ruling D-F8: resolves a user''s OWNERSHIP scope. holding edge => company + all descendants; '
  'shareholder edge => that company only. Economic scope only — depth (statements vs GL) is an authz '
  'decision, staff scope comes from IAM positions, elevation grants add companies temporarily. '
  'Empty set for a user with no edges (fail-closed).';
GRANT EXECUTE ON FUNCTION finance_owner_company_ids(uuid) TO PUBLIC;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- (4) The `finance` third wall.
--
-- No new function: `app_module_allowed(text)` from 0028 already reads the request-declared module
-- scope (`app.scopes` GUC). This block only establishes the policy SHAPE that every finance_* table
-- in F0-03..F0-06 and beyond must carry, byte-identically, applied through the same DO-loop so it
-- cannot drift per table:
--
--     tenant_id = ANY(app_current_tenants()) AND app_module_allowed('finance')
--
-- A caller that reaches a finance table WITHOUT `withTenants(..., { modules: ["finance"] })` reads
-- and writes ZERO rows and gets NO error. That silence is the design; it is also the trap, so
-- F0-11's test suite asserts the zero-row case explicitly rather than trusting it.
--
-- ⚠ Correction carried forward from 202608240140: an unset `app.scopes` makes app_module_allowed()
--   return NULL, not false. RLS is unaffected (a policy admits only on TRUE), but any guard OUTSIDE
--   a policy must test `IS NOT TRUE`, never `= false` — `NOT NULL` is NULL.
--
-- `company_ownership` is walled the same way, with one deliberate difference noted below.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['company_ownership'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    -- NOTE: no app_module_allowed('finance') here, unlike every finance_* table that follows.
    -- The ownership graph is CORE identity/structure, not finance data: the scope resolver must be
    -- readable to decide a user's company set BEFORE any module scope is declared, and HR/PM/GM
    -- surfaces legitimately need to know who owns what. Gating it on the finance module would make
    -- the resolver unusable from every non-finance caller — including the login path that computes
    -- the tenant set in the first place. The tenant wall still applies in full.
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
         USING (tenant_id = ANY(app_current_tenants()))
         WITH CHECK (tenant_id = ANY(app_current_tenants()))',
      t
    );
  END LOOP;
END $$;
