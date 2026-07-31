-- SM-26 — the pre-send Google Ads mutate operation manifest (tracker §6bp Ruling 6, binding on
-- SM-26's spec; design addendum §A14.5 "generalised to writes" clause 2/3).
--
-- ── NUMBERING (migrations/README.md rule 5) ────────────────────────────────────────────────────────
-- Checked at write time, not trusted from the ticket brief: `ls migrations` head = 0065
-- (0065_search_campaign_metrics_provenance.sql, SM-25c); README's own 2026-07-31 ledger note says
-- "Next unused is 0066." This migration takes 0066. 0058/0059 remain reserved for TR-23/TR-14 and
-- are deliberately not filled, same as every migration since 0060.
--
-- ── WHAT THIS IS, AND WHY IT MUST BE WRITTEN BEFORE ANY NETWORK CALL ──────────────────────────────
-- Google Ads mutate responses (`.../{resource}:mutate`) are documented to return results
-- POSITIONALLY, in request order, each carrying only the created/updated `resource_name` — there is
-- no client-supplied per-operation ref echoed back (tracker §6bp Ruling 6, the architect's pre-ruling
-- on the exact question §6bn deferred to staging). That is the opposite of every other vendor
-- boundary this module has echo-validated (DataForSEO's `task_get`, GAQL's self-describing rows): here
-- there is nothing IN THE RESPONSE for us to validate an identity against.
--
-- So SM-26 supplies the pairing authority itself, and it must predate the response for the discipline
-- to mean anything: this table is the ORDERED record of "what we intended to send, and in what order"
-- (execution_id, position, ref, op_type, entity_type, entity_id), INSERTed and COMMITted before
-- `sem-executor-google-ads.ts` makes its first Ads mutate HTTP call. Only afterwards is
-- `resource_name`/`outcome` filled in from whatever the response actually said (or left NULL if the
-- addressing was impeached and no result could be attributed — see below).
--
-- ── WHY A DURABLE TABLE AND NOT JUST AN IN-MEMORY ARRAY ────────────────────────────────────────────
-- The pairing itself could be done from the in-memory `ChangeOperation[]` array `search.controller.ts`
-- already builds and hands to the executor (SM-21's `AdsExecutorContext.operations`) — nothing here
-- makes that array MORE correct. What a database row buys is DURABILITY across exactly the crash
-- window `search_change_executions.status='dispatched'` already names (0064's own header): if the
-- process dies after an Ads mutate call has actually left this process but before the executor
-- function returns, the in-memory manifest is gone forever and the stranded 'dispatched' row carries
-- no record of what was attempted, in what order, or against which entities — an operator investigating
-- that incident (project memory `d14-no-resume-gap`: a stuck 'dispatched' row is an OPERATOR incident,
-- not auto-retryable) would have nothing to reconcile against except the live ad account itself. This
-- table is exactly that forensic trace, committed before the risk is taken, per §A14.5's writes clause
-- 3 ("record-before-raise... for a write, that row is the only local trace of a possibly-executed
-- remote change") applied one step earlier than the execution row's own settlement.
--
-- ── outcome/resource_name ARE FORENSIC, NEVER AUTHORITATIVE ───────────────────────────────────────
-- The AUTHORITATIVE per-operation record stays `search_change_executions.per_change` (0064), written by
-- `search.controller.ts` from the `ExecutorReport` the executor returns — unchanged by this ticket.
-- This table's `resource_name`/`outcome`/`error_detail` are a SECOND, independent capture the executor
-- writes for itself (defence in depth, and the ONLY surviving record when the executor is forced to
-- report `indeterminate` — the `ExecutorReport` it returns in that case carries NO results at all, so
-- without this table the resource_names Google DID return for a partially-impeached response would be
-- lost even though they are real, billable, live-account facts). Nothing reads this table to decide
-- proposal/execution status; `search_change_executions.status` remains sem-apply.ts's
-- `reconcileExecution` output, untouched by this migration.
--
-- ── WHY execution_id, NOT proposal_id ──────────────────────────────────────────────────────────────
-- `AdsExecutorContext` (sem-apply.ts) does not carry the execution row's own id — only proposalId/
-- campaignId — but by the time the executor runs, `search_change_executions`' claim INSERT (STEP 5,
-- search.controller.ts) has already committed with `status='dispatched'`, and `UNIQUE (approval_id)`
-- guarantees at most one such row will EVER exist for a given proposal (a second attempt loses at the
-- index before the executor is even called — 0064's own header). `sem-executor-google-ads.ts` looks
-- that row up by `proposal_id` at the top of its run and manifests against its real `id`, which is a
-- cleaner FK than proposal_id would be and matches this table to the SAME row the crash-window
-- incident is keyed on.
--
-- ── RLS ────────────────────────────────────────────────────────────────────────────────────────────
-- FORCE ROW LEVEL SECURITY + the module's byte-identical composed policy (0034/0064's own).
--
-- ── NO DML ─────────────────────────────────────────────────────────────────────────────────────────
-- CREATE-only: no UPDATE/DELETE/backfill — this table can only be populated by code that does not
-- exist before this migration (project memory `migration-backfill-rls-trap` does not apply: there is
-- nothing to backfill).

CREATE TABLE search_ads_execution_manifest (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  execution_id uuid NOT NULL REFERENCES search_change_executions(id),
  -- 0-based send order — the vendor's own documented pairing contract (Ruling 6.2: "order preservation
  -- is the vendor's documented contract"). Global across the whole execution (spans every Ads
  -- resource-type mutate call this execution makes), so the forensic record reads as one ordered list
  -- even though the Ads-side pairing is actually validated per resource-type call.
  position integer NOT NULL CHECK (position >= 0),
  -- Our OWN server-computed operation identity (sem-apply.ts's `opType#ourRowId`, never positional —
  -- §A14.5 writes clause 2). Carried here even though Ads never echoes it, so this table's rows can be
  -- joined back onto `search_change_executions.per_change` by a human reconciling an incident.
  ref text NOT NULL,
  op_type text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  -- Which Ads resource-type mutate call (`.../{ads_resource}:mutate`) this operation was batched into
  -- — e.g. 'campaigns', 'campaignBudgets', 'adGroupCriteria', 'adGroupAds'. Recorded because Ads pairs
  -- results PER RESOURCE-TYPE CALL, not globally, so this is what a forensic re-derivation of the
  -- pairing needs alongside `position`.
  ads_resource text NOT NULL,
  -- Filled in AFTER the response returns (NULL beforehand, and NULL forever if this specific
  -- operation's resource-type call could not be paired at all). Never required, never trusted as an
  -- identity — see the file header: this table is forensic, not authoritative.
  resource_name text,
  outcome text CHECK (outcome IS NULL OR outcome IN ('applied', 'failed')),
  -- Best-effort human-readable detail (vendor `partialFailureError.message`, a request-layer failure
  -- message, or an addressing-impeachment note applied uniformly across every row of this execution
  -- when Ruling 6.3's count/shape mismatch fires). Bounded by the caller before persistence.
  error_detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- One manifest row per (execution, send-position) — the shape the positional-pairing discipline
  -- itself depends on. `buildChangeOperations` (sem-apply.ts) already asserts every `ref` within one
  -- execution is unique, so this is a second, schema-level backstop rather than the only guarantee.
  UNIQUE (execution_id, position)
);
CREATE INDEX ix_search_ads_execution_manifest_execution
  ON search_ads_execution_manifest (tenant_id, execution_id, position);

ALTER TABLE search_ads_execution_manifest ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_ads_execution_manifest FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON search_ads_execution_manifest;
CREATE POLICY tenant_isolation ON search_ads_execution_manifest FOR ALL
  USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('search'))
  WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('search'));

COMMENT ON TABLE search_ads_execution_manifest IS
  'SM-26 — the pre-send, ordered record of Google Ads mutate operations for one execution attempt '
  '(tracker §6bp Ruling 6). Written BEFORE the first Ads mutate HTTP call, because Google Ads mutate '
  'responses carry no client-supplied operation ref (positional-only, per resource-type call) — this '
  'table is what makes positional parsing admissible: the pairing authority is our own pre-send '
  'record, never the response. resource_name/outcome are filled in afterwards and are FORENSIC ONLY '
  '(defence in depth / crash-window trace) — the authoritative per-operation record stays '
  'search_change_executions.per_change, unchanged by this migration.';

COMMENT ON COLUMN search_ads_execution_manifest.execution_id IS
  'search_change_executions.id for this attempt. Looked up by proposal_id at executor start — '
  'AdsExecutorContext (sem-apply.ts) does not carry it directly, but UNIQUE (approval_id) on that '
  'table guarantees at most one dispatched row per proposal ever exists by the time the executor runs.';

COMMENT ON COLUMN search_ads_execution_manifest.position IS
  'Global 0-based send order across the whole execution. Positional pairing is admissible here '
  '(unlike DFS task_post, §6bi) because order preservation is documented vendor contract AND this row '
  'is written before any response exists, so nothing response-derived can rewrite the addressing '
  '(tracker §6bp Ruling 6.2).';

COMMENT ON COLUMN search_ads_execution_manifest.outcome IS
  'applied/failed once known; NULL if never learned (addressing impeached for this operation''s '
  'resource-type call, or the request never got an answer at all). A per-result partial_failure error '
  'from Ads is a PER-ROW outcome (failed), never an addressing failure (tracker §6bp Ruling 6.3) — '
  'only a count/shape mismatch against this table''s own row count for a resource-type call collapses '
  'that call''s operations to indeterminate at the ExecutorReport layer (this table still records what '
  'was learned, even then).';
