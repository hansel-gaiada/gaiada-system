-- SM-21 — the api-mode (automated twin) execution record for SEM change proposals
-- (docs/blueprints/seo-sem-design.md §04/§07/§12 SM-21, decisions D-6/D-8; tracker §1/§6o/§6ba).
--
-- ── NUMBERING (migrations/README.md rule 5) ────────────────────────────────────────────────────────
-- Checked BOTH sources at write time rather than trusting the ticket brief (which said "head is
-- 0062" — it was already stale, exactly as the README warns):
--   * `ls migrations` head file  = 0063_pm_task_assignee_intervals.sql
--   * README's own ledger note   = "2026-07-31 update (TR-34 ...) — 0063 is TAKEN. Next unused is 0064."
--   * live `schema_migrations`   = 0061_search_google_performance.sql (the dev DB is BEHIND the
--     files — 0062/0063 exist on disk but are not applied there; tracker §6aw records that fact)
-- 0058/0059 remain RESERVED for TR-23/TR-14 and are deliberately NOT filled by this migration, for
-- the same reason 0060/0062 skipped past them. This migration takes 0064.
--
-- ── WHAT THIS IS ───────────────────────────────────────────────────────────────────────────────────
-- ONE new tenant-scoped table, `search_change_executions`: the durable record of an ATTEMPT to
-- execute an approved, mode='api' change proposal against a client's live advertising account.
-- One row per attempt, and — see the UNIQUE below — at most one row per WS4 approval, ever.
--
-- Why a new table rather than more columns on `search_change_proposals` (0034): a proposal is a
-- PLAN (one row, editable while proposed, hashed at approval); an execution is an EVENT with its own
-- outcome, its own per-change results, its own actor and its own clock. Folding the second into the
-- first would force the "partial" outcome to be represented as a proposal status — which is exactly
-- the rounding this ticket exists to prevent — and would leave no place for the per-operation result
-- list at all. 0034's `applied_by`/`applied_at`/`status='applied'` stay the proposal-level summary;
-- this table is the evidence behind it.
--
-- ── REPLAY SAFETY IS THE POINT OF THIS TABLE, AND IT IS SCHEMA-LEVEL ──────────────────────────────
-- `UNIQUE (approval_id)` is the one-shot consumption of design §07's "one-shot approvalId". The
-- INSERT of a row here IS the claim on the approval: the executor is called only AFTER that insert
-- commits, so two concurrent attempts cannot both proceed — the loser hits a real `23505` at the
-- index and is refused (409), not absorbed. Deliberately UNLIKE SM-20's ingest (0062), this insert
-- carries NO `ON CONFLICT` clause: a redelivered ingest row should converge, but a second execution
-- of a live ad-account change must be REFUSED. An application-level "does an execution already
-- exist?" pre-check is not a substitute and is not relied upon — the constraint is the guarantee,
-- and the suite proves it under a deliberately widened race window with a naive check-then-insert
-- competitor as the negative control (tracker §6bg's model, §6bc/§6bi Ruling 4's requirement).
--
-- The uniqueness is GLOBAL, not per-tenant, and that is correct: `approval_id` references
-- `automation_approvals(id)`, itself a global uuid PK, and an approval belongs to exactly one tenant.
-- A tenant-scoped unique index would permit two rows for one approval if a tenant_id were ever
-- mismatched, which is the one case a defence-in-depth constraint should catch rather than allow.
--
-- ── WHY approval_id IS NOT NULL ────────────────────────────────────────────────────────────────────
-- There is no such thing as an execution without an approval on this path (design D-6: "api-mode
-- executions require one-shot approved approvalId (humans included)"). Making the column nullable
-- would make the unique constraint silently non-binding for NULL rows — Postgres treats NULLs as
-- distinct — which would reopen replay for precisely the rows that had no authorization. NOT NULL is
-- therefore load-bearing, not tidiness.
--
-- ── PARTIAL EXECUTION IS A FIRST-CLASS STATE (ticket property 4) ───────────────────────────────────
-- `status` has FOUR terminal values plus one in-flight value, chosen so no real state is rounded:
--   dispatched    claimed and sent; no settlement recorded yet. Also the CRASH WINDOW state: if the
--                 process dies between the claim and the settlement, the row stays 'dispatched'
--                 forever and the approval is spent. That is deliberate and is the honest reading —
--                 changes MAY exist in the ad account, so an automatic retry could double-apply.
--                 There is NO automatic recovery (see the D14 note below); a stuck 'dispatched' row
--                 is an operator-visible incident whose remedy is a NEW proposal.
--   applied       every operation applied. The only status that stamps the proposal 'applied'.
--   partial       >=1 applied AND >=1 failed, and we know exactly which (per_change carries it).
--                 The same shape as `search_provider_calls.status='incurred'` (0053/§A11): "the
--                 action happened, the result is not in our hands". Never rounded to applied/failed.
--   failed        zero operations applied.
--   indeterminate the executor's response could not be paired to what we sent (an unknown,
--                 duplicated or missing operation ref), or its own simulated/live claim contradicted
--                 the platform's mode. Live changes may exist; we refuse to say WHICH. This is
--                 addendum §A14.5's pairing discriminator applied to a write: a violated IDENTITY on
--                 a paired response impeaches the addressing scheme, not one row, so the remedy is
--                 record-everything-then-refuse-attribution. Kept distinct from `partial` on
--                 purpose — partial means "we know the split", indeterminate means "we do not".
--
-- ── D14: NO RESUME PATH EXISTS, AND THIS TABLE DOES NOT PRETEND OTHERWISE ──────────────────────────
-- Project memory `d14-no-resume-gap` + 0014's own header: approving a suspended automation write
-- executes NOTHING. This ticket does not change that. Deciding the approval writes no row here; the
-- CALLER re-drives the same route, and only then is a row created. So there is no
-- `automation_approval.decided` handler pointed at this table, by design — HR's leave handler
-- (modules/hr/leave-decision.ts) moves an internal row on decision; this would spend a client's
-- advertising money with no human present at the moment of execution.
--
-- ── PROVENANCE: `simulated` FROM DAY ONE (§A4.7) ───────────────────────────────────────────────────
-- Same law as 0047/0048/0060/0061/0062: NOT NULL DEFAULT false, stamped at the SAME write as the
-- outcome, never re-derived later. Its source here is the EXECUTOR's own report, cross-checked
-- against `config.search.providerMode` before persistence (sem-apply.ts's `reconcileExecution`): an
-- executor claiming a live push while the platform is in simulate mode yields `indeterminate`, never
-- a quietly-accepted row. A nullable column would leave the first `WHERE simulated = <mode>` reader
-- exposed to the UNKNOWN-in-a-predicate fail-open the whole §A4.7 rule exists to foreclose.
--
-- ── MONEY LANGUAGE (§A3) ───────────────────────────────────────────────────────────────────────────
-- Nothing here is OUR cost. This path dispatches no data vendor, writes no `search_provider_calls`
-- row, and has no `provider_call_id` FK — the third-egress-class reasoning 0061/0062 already
-- recorded, transposed to a WRITE. Any budget figure inside `per_change` is the CLIENT's own
-- advertising budget in minor units and must never be summed with `cost_usd`.
--
-- ── RLS ────────────────────────────────────────────────────────────────────────────────────────────
-- FORCE ROW LEVEL SECURITY + 0034's byte-identical composed policy
-- (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('search')).
--
-- ── NO DML ─────────────────────────────────────────────────────────────────────────────────────────
-- CREATE-only: no UPDATE, no DELETE, no INSERT...SELECT, no backfill — nothing to backfill, since
-- this table can only be populated by code that does not exist before this migration. (Project
-- memory `migration-backfill-rls-trap`: a backfill under FORCE RLS with no tenant GUC silently
-- affects zero rows and reports success. There is no backfill here, so the trap cannot apply.)
-- Runtime DML grants come from the owner's ALTER DEFAULT PRIVILEGES + RUNTIME_GRANTS_SQL pass
-- (migrations/README.md); no in-migration GRANTs.

CREATE TABLE search_change_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  proposal_id uuid NOT NULL REFERENCES search_change_proposals(id),
  campaign_id uuid NOT NULL REFERENCES search_campaigns(id),
  -- NOT NULL is load-bearing — see the file header. This is the WS4 one-shot approval being spent.
  approval_id uuid NOT NULL REFERENCES automation_approvals(id),
  kind text NOT NULL CHECK (kind IN ('launch','pause','budget','bid','negatives_batch','ads_batch')),
  -- Only the api twin ever reaches this table; the manual twin's terminus is
  -- search_change_proposals.applied_by/applied_at via SM-30's mark-applied route. A CHECK rather
  -- than a comment so a future caller cannot quietly file a manual-mode execution here.
  mode text NOT NULL DEFAULT 'api' CHECK (mode = 'api'),
  -- sha256 hex of the canonical {kind, mode, payload} of the proposal AS EXECUTED
  -- (sem-apply.ts hashChangeProposalContent). Recorded so the executed content identity is provable
  -- after the fact, independently of whether the proposal row is later touched.
  payload_hash text NOT NULL,
  status text NOT NULL DEFAULT 'dispatched'
    CHECK (status IN ('dispatched','applied','partial','failed','indeterminate')),
  changes_total integer NOT NULL DEFAULT 0 CHECK (changes_total >= 0),
  changes_applied integer NOT NULL DEFAULT 0 CHECK (changes_applied >= 0),
  changes_failed integer NOT NULL DEFAULT 0 CHECK (changes_failed >= 0),
  -- Operations the response said nothing about. Non-zero always accompanies status='indeterminate'.
  changes_unknown integer NOT NULL DEFAULT 0 CHECK (changes_unknown >= 0),
  -- Per-operation record: [{ref, opType, entityType, entityId, outcome, remoteId, detail}]. The
  -- evidence behind `partial` — without it, "some applied" would be an unfalsifiable claim.
  per_change jsonb NOT NULL DEFAULT '[]',
  -- Echo-validation failures (§A14/§A14.5), verbatim, so an impeached response is diagnosable
  -- later. Empty array on every non-indeterminate row.
  echo_violations jsonb NOT NULL DEFAULT '[]',
  provider text,                                       -- 'simulation' today; 'google_ads' at SM-26
  simulated boolean NOT NULL DEFAULT false,
  error text,                                          -- executor-level failure, bounded by the caller
  executed_by uuid REFERENCES users(id),
  finished_at timestamptz,
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- THE replay guarantee. See the file header for why it is global and why there is no ON CONFLICT.
  UNIQUE (approval_id)
);
CREATE INDEX ix_search_change_executions_proposal
  ON search_change_executions (tenant_id, proposal_id, created_at DESC);
CREATE INDEX ix_search_change_executions_campaign
  ON search_change_executions (tenant_id, campaign_id, created_at DESC);

ALTER TABLE search_change_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_change_executions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON search_change_executions;
CREATE POLICY tenant_isolation ON search_change_executions FOR ALL
  USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('search'))
  WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('search'));

COMMENT ON TABLE search_change_executions IS
  'SM-21 — one row per ATTEMPT to execute an approved, mode=''api'' SEM change proposal against a '
  'client''s live ad account (design §07, D-6/D-8). UNIQUE (approval_id) is the one-shot consumption '
  'of the WS4 approval: inserting the row IS claiming the approval, so a replay loses at the index '
  '(23505 -> 409) rather than executing twice. No ON CONFLICT anywhere — unlike an idempotent '
  'ingest, a second execution must be refused. Four terminal statuses so no real outcome is rounded: '
  'applied / partial (the `incurred` shape) / failed / indeterminate (§A14.5 — response identity '
  'unpairable, so effects may exist and attribution is refused). Never our cost (§A3): no vendor is '
  'dispatched and no search_provider_calls row is written.';

COMMENT ON COLUMN search_change_executions.approval_id IS
  'The WS4 automation_approvals row spent by this execution. NOT NULL + UNIQUE = the one-shot '
  'guarantee; a nullable column would make the constraint non-binding for exactly the rows that had '
  'no authorization (Postgres treats NULLs as distinct). Resolved from '
  'search_change_proposals.approval_id — stored state — NEVER from a request parameter, because '
  'POST /api/:t/automation-approvals lets a member-tier principal file a row with arbitrary '
  'tool_args, so an approval found by MATCHING tool_args would be forgeable.';

COMMENT ON COLUMN search_change_executions.payload_hash IS
  'sha256 hex over the canonical {kind, mode, payload} of the proposal at execution time '
  '(sem-apply.ts hashChangeProposalContent — SM-08/SM-20''s server-computed-hash precedent). The '
  'approval row carries the SAME hash in tool_args.payloadHash, computed when it was minted; '
  'execution refuses on any difference, so approval cannot survive an edit of what it approved.';

COMMENT ON COLUMN search_change_executions.status IS
  'dispatched = claimed and sent, no settlement recorded (also the crash window; NOT automatically '
  'retryable — the approval is already spent and changes may exist). applied = all operations '
  'applied (the only status that stamps the proposal ''applied''). partial = some applied, some not, '
  'and per_change says which. failed = none applied. indeterminate = the response could not be '
  'paired to what was sent, or the executor''s simulated/live claim contradicted the platform mode '
  '(§A14.5) — effects may exist, attribution refused, cascade suppressed.';

COMMENT ON COLUMN search_change_executions.simulated IS
  'true = nothing left this process; the built-in simulation executor produced this row. Stamped '
  'from the EXECUTOR''s own report, cross-checked against config.search.providerMode before '
  'persistence — a mismatch yields status=''indeterminate'' rather than a quietly accepted row. NOT '
  'NULL DEFAULT false for the same §A4.7 reason as every prior provenance column in this module.';

COMMENT ON COLUMN search_change_executions.per_change IS
  'Per-operation results: [{ref, opType, entityType, entityId, outcome(applied|failed|unknown), '
  'remoteId, detail}]. `ref` is our OWN server-computed operation identity (opType#rowId), which is '
  'what the executor must echo — a positional pairing would make the echo check tautological (any '
  'response of the right length would validate). Any budget figure here is the CLIENT''s ad spend '
  '(§A3), never our cost-to-serve.';
