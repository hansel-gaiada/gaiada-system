-- SM-36 — per-capability provider preference: keyword metric provenance (docs/blueprints/
-- seo-sem-execution-tracker.md §6 SM-36; design addendum §A2/§A8.3). Additive, CREATE/ALTER-only;
-- no RLS change (every touched table keeps its 0034 tenant-isolation policy as-is).
--
-- ── Part 1 (SM-36 proper): search_keywords provenance ────────────────────────────────────────────
-- §A2's conflict ruling (clause 2) requires every vendor-sourced metric to render with its
-- provenance ("KD 45 · Semrush") because Semrush/Ahrefs/DataForSEO difficulty and volume are
-- different formulas on different scales and must never be blended or silently re-labelled.
-- search_keywords already carries the metric VALUES (volume/difficulty/cpc_usd, 0034) but nowhere
-- to stamp WHICH provider produced them or whether they are synthetic — this migration adds both:
--   * metrics_provider — nullable (a keyword with no metrics pulled yet has no provenance to state;
--     "absent" must stay absent, never a confident wrong answer per the module's own house rule).
--   * metrics_simulated — NOT NULL DEFAULT false, same load-bearing default as 0047's `simulated`
--     columns: every pre-existing row's metrics (if any) were produced before simulation existed,
--     i.e. genuinely real, and a NULL here would go UNKNOWN in a WHERE clause exactly like the
--     §4d/§A4.1 fail-open class.
--
-- ── Part 2 (architect coverage sweep, addendum §A8.3 — extends SM-36's scope) ────────────────────
-- The wave-2 gate found a real schema gap that makes §A4.4's "badged forever in any historical view"
-- unimplementable as things stand: search_rank_snapshots, search_backlink_snapshots and
-- search_ai_visibility (0034) each carry `provider text` + a NULLABLE `provider_call_id` but NO
-- `simulated` column. SM-14/16 would persist synthetic payloads with nowhere to stamp the
-- provenance `DispatchResult.simulated` (dispatch.ts) hands them, and deriving it at read time
-- through the nullable FK is the §4i "confident wrong answer" shape (a UI reading an absent field
-- gets `undefined`, which is falsy — synthetic data would render as real). So this migration also
-- adds, to all three snapshot tables:
--   * simulated boolean NOT NULL DEFAULT false — same shape as 0047, same reason the default is
--     load-bearing: every pre-existing snapshot row was captured before simulation existed, so
--     `false` is not a guess, it is what actually happened; a NULL default would silently badge
--     nothing as real OR simulated, which a future badge-or-refuse read would have to treat as
--     "cannot tell" — the same UNKNOWN-in-a-WHERE-clause hazard as the ledger/cache columns.
-- SM-14/16's AC (not this ticket's) is to stamp this column from DispatchResult.simulated on every
-- persisted snapshot; this migration only makes that possible.
--
-- Per addendum §A4.7 (new standing rule): every future reader/persister of provider-derived rows on
-- these three tables must state its mode handling (filter / stamp / badge) in its own ticket's AC —
-- this migration is schema-only and does not itself read or filter anything.

ALTER TABLE search_keywords ADD COLUMN metrics_provider text;
ALTER TABLE search_keywords ADD COLUMN metrics_simulated boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN search_keywords.metrics_provider IS
  'SM-36: which SearchDataProvider produced the CURRENT volume/difficulty/cpc_usd values (design '
  'addendum §A2 conflict ruling: one source per capability per engagement, never blended). NULL '
  '= no metrics pulled yet for this keyword — stays NULL, never defaulted to a guessed vendor.';

COMMENT ON COLUMN search_keywords.metrics_simulated IS
  'SM-36/§A8.3: true = the current metric values were produced by a SIMULATED provider (or while '
  'config.search.providerMode = simulate). NOT NULL DEFAULT false because every pre-SM-36 row''s '
  'metrics (if any) predate simulation and are genuinely real — see 0047''s identical reasoning for '
  'why this default is load-bearing, not cosmetic.';

ALTER TABLE search_rank_snapshots ADD COLUMN simulated boolean NOT NULL DEFAULT false;
ALTER TABLE search_backlink_snapshots ADD COLUMN simulated boolean NOT NULL DEFAULT false;
ALTER TABLE search_ai_visibility ADD COLUMN simulated boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN search_rank_snapshots.simulated IS
  'Addendum §A8.3: true = this rank snapshot was captured by a SIMULATED provider (or while '
  'config.search.providerMode = simulate). NOT NULL DEFAULT false — every pre-existing snapshot was '
  'captured before simulation existed and is genuinely real. SM-14''s AC: stamp this from '
  'DispatchResult.simulated on every persisted snapshot; never derive it from the nullable '
  'provider_call_id FK (the §4i confident-wrong-answer shape).';

COMMENT ON COLUMN search_backlink_snapshots.simulated IS
  'Addendum §A8.3: true = this backlink snapshot was captured by a SIMULATED provider (or while '
  'config.search.providerMode = simulate). NOT NULL DEFAULT false, same reasoning as '
  'search_rank_snapshots.simulated above. SM-16''s AC: stamp this from DispatchResult.simulated.';

COMMENT ON COLUMN search_ai_visibility.simulated IS
  'Addendum §A8.3: true = this AI-visibility snapshot was captured by a SIMULATED provider (or '
  'while config.search.providerMode = simulate). NOT NULL DEFAULT false, same reasoning as '
  'search_rank_snapshots.simulated above. SM-16''s AC: stamp this from DispatchResult.simulated.';

-- Operational index mirroring 0047's ix_search_data_cache_simulated: cheap on a live-mode deployment
-- (partial, WHERE simulated), useful for "how much of this history is synthetic" / staging-cutover
-- audits without scanning every row.
CREATE INDEX ix_search_rank_snapshots_simulated ON search_rank_snapshots (simulated) WHERE simulated;
CREATE INDEX ix_search_backlink_snapshots_simulated ON search_backlink_snapshots (simulated) WHERE simulated;
CREATE INDEX ix_search_ai_visibility_simulated ON search_ai_visibility (simulated) WHERE simulated;
