-- SM-50 — INCURRED-COST ledger rows: the vendor was charged and delivered no data
-- (design addendum §A11, binding; tracker §6x.2; the hole itself is recorded in tracker §6w).
--
-- ── NUMBERING NOTE (read before assuming this file is misnumbered) ────────────────────────────────
-- The SM-50 ticket spec says "one additive migration" and the ticket-time ledger note said the head
-- was 0048, i.e. "yours is 0049". That was already stale when this ticket ran: 0049
-- (meeting_recordings_audio_ref), 0050/0051 (pm_short_codes + its backfill fix) and 0052
-- (pipeline_stage_idempotency) had all merged AND applied. migrations/README.md rule 2 is explicit —
-- "take the next unused number; never reuse one" — and rule 4 forbids renaming an applied file, so
-- reusing 0049 would have collided with an applied ledger row. This file therefore takes 0053.
--
-- ── WHAT THIS FIXES ──────────────────────────────────────────────────────────────────────────────
-- A provider exception fires INSIDE runInCacheCriticalSection's transaction, before
-- insertLedgerRow — so the whole critical section rolls back and no row survives. That is CORRECT
-- for a failure before the vendor was engaged (auth rejected, connection refused; a scope/budget
-- refusal already writes its own row via recordBlocked, in its own transaction). It is WRONG after a
-- BILLABLE side effect: DataForSEO's Standard queue charges at `task_post` (dataforseo.ts's own
-- header, ~$0.0006/task), so post -> vendor charges -> polling exhausts -> throw -> rollback left
-- money spent at the vendor and NOTHING in our ledger. Because the stop-loss SUMS this table, a run
-- of poll failures burned real deposit that no budget tier could see — a fail-open reached through
-- transactional atomicity rather than through a missing guard.
--
-- ── STATUS: a NEW value, never a cost-bearing `failed` row (§A11.1.2) ────────────────────────────
-- 0034 (line ~175) constrained status to ('posted','completed','failed') and ledger.ts's header
-- carries the SM-04 invariant `failed => cost_usd = 0`. That invariant is PRESERVED here: refusals
-- and pre-engagement failures keep writing `failed`/0 rows exactly as before. Encoding "charged but
-- undelivered" as `failed AND cost_usd > 0` was REJECTED by the ruling as an implicit semantic (the
-- §6r class: every consumer would have to know a convention nothing enforces). Hence a fourth,
-- explicitly-named value whose meaning is quotable:
--
--     incurred = the vendor was engaged and confirmably charged (standard-rate accounting per §A3)
--                and no data was delivered.
--
-- Widening a CHECK is additive in the only sense that matters — it strictly ENLARGES the accepted
-- set, so every row already in the table still satisfies the new constraint and no existing writer
-- can start failing. Postgres has no ALTER CONSTRAINT for CHECK bodies, so drop-then-add is the only
-- expression of "widen"; both statements run inside the runner's single per-file transaction
-- (src/db/migrate.ts), so there is no window in which the column is unconstrained.
--
-- ── vendor_ref: the reconciliation key (§A11.1.4) ────────────────────────────────────────────────
-- NULLABLE and stamped on incurred rows AND on successful rows going forward, wherever the driver
-- has a vendor-side id (the DataForSEO task id). This is what SM-41's staging reconciliation matches
-- our ledger against the vendor console's line items with: an incurred row is precisely the
-- reconciling entry for a console charge that has no corresponding data row on our side. NULL means
-- "this vendor/capability exposes no per-call id" — it stays NULL rather than being defaulted to
-- anything, per this module's own house rule (an absent fact must read as absent, never as a
-- confident wrong answer).
--
-- ── NO BACKFILL, and that is a fact rather than a decision ──────────────────────────────────────
-- No `incurred` row can exist before the code that writes one, and `vendor_ref` is genuinely unknown
-- for every historical row (we never captured it). So there is no DML in this file at all — which
-- also keeps it clear of the whole 0050-class hazard (an owner-role backfill silently affecting zero
-- rows under RLS with an unset tenant GUC, then reporting success).
--
-- Additive, ALTER/CREATE-only. No RLS change: search_provider_calls keeps 0034's third-wall policy
-- untouched. No in-migration GRANTs, per migrations/README.md — column privileges follow the table
-- grants already in place.
--
-- ⚠️ THE PROPERTY THIS MIGRATION EXISTS TO SERVE, stated here because a schema reader is exactly who
-- would be tempted to break it: every money sum over this table is STATUS-BLIND, verified in the SQL
-- (ledger.sumMonthToDate, GLOBAL_MTD_QUERY_SQL, PROVIDER_MTD_QUERY_SQL, and the
-- search.provider_cost.month rollup in modules/search/index.ts). That is WHY incurred cost binds
-- every budget tier and the exec rollup with zero query changes. Adding a status predicate to any of
-- them — "exclude incurred from the ceiling" — would silently exempt real deposit burn from the very
-- ceilings this ticket exists to feed, and is forbidden without a design gate (§A11.2 #1-#5). The
-- only status-AWARE statement over this table is the generic true-up (`WHERE status = 'posted'`),
-- deliberately so: correcting an estimate on a delivered call and reconciling an orphaned charge are
-- different operations on different code paths (§A11.2 #7).

ALTER TABLE search_provider_calls DROP CONSTRAINT search_provider_calls_status_check;
ALTER TABLE search_provider_calls ADD CONSTRAINT search_provider_calls_status_check
  CHECK (status IN ('posted', 'completed', 'failed', 'incurred'));

ALTER TABLE search_provider_calls ADD COLUMN vendor_ref text;

COMMENT ON COLUMN search_provider_calls.status IS
  'SM-04/SM-50 metering state. posted = dispatched, cost is the pre-dispatch estimate. completed = '
  'delivered (cache hit, or trued-up to a vendor-reported actual). failed = REFUSED or failed BEFORE '
  'the vendor was engaged — invariant: cost_usd = 0, always. incurred (SM-50, addendum §A11) = the '
  'vendor was engaged and confirmably charged and NO data was delivered, e.g. a DataForSEO Standard '
  'task_post that was accepted (and therefore billed) whose task_get polling then exhausted. An '
  'incurred row carries cost_usd > 0 and is written OUTSIDE the rolled-back dispatch transaction by '
  'ledger.recordIncurred() — the only writer permitted to produce this status. Every money sum over '
  'this table is status-blind BY DESIGN so incurred burn binds every budget tier; do not add a status '
  'predicate to one.';

COMMENT ON COLUMN search_provider_calls.vendor_ref IS
  'SM-50 (addendum §A11.1.4): the vendor-side identifier for this call (the DataForSEO task id), '
  'stamped on incurred rows AND on successful rows wherever the driver exposes one. This is the key '
  'SM-41''s staging reconciliation matches our ledger against the vendor console''s line items with — '
  'an incurred row is the reconciling entry for a console charge with no data row on our side. NULL '
  '= this vendor/capability exposes no per-call id; never defaulted to a placeholder.';

-- Operational index, same shape and rationale as 0047's ix_search_data_cache_simulated: partial, so
-- it costs essentially nothing on a deployment where no charge has ever gone unreconciled. The one
-- query an operator (and SM-41's reconciliation) actually runs against this column is "find the
-- ledger row for this vendor console line item".
CREATE INDEX ix_search_provider_calls_vendor_ref ON search_provider_calls (vendor_ref)
  WHERE vendor_ref IS NOT NULL;

-- And the reconciliation sweep's own access path: "which charges are still written off?". Partial on
-- the status, so it is empty (and free) on a healthy deployment.
CREATE INDEX ix_search_provider_calls_incurred ON search_provider_calls (tenant_id, created_at DESC)
  WHERE status = 'incurred';
