-- SM-25c — provenance columns on `search_campaign_metrics_daily` (design addendum §A12; tracker
-- §6x.3 item 5 "SM-25c · Ads read binding").
--
-- ── NUMBERING (migrations/README.md rule 5) ────────────────────────────────────────────────────────
-- First drafted as 0064, then re-checked per the coordinator's live correction and found collided with
-- `0064_search_change_executions.sql` (SM-21, a concurrent in-flight session on this same module).
-- `ls migrations | tail` at re-check time showed head = 0064 (SM-21's file) with 0065 unused. Renamed
-- to 0065 before this file was ever applied anywhere — no ledger, no schema_migrations row, nothing to
-- collide with. Whoever writes the NEXT search migration: re-check disk again, the same way.
--
-- ── WHAT THIS IS, AND WHY IT WIDENS AN EXISTING TABLE RATHER THAN CREATING A NEW ONE ────────────────
-- `search_campaign_metrics_daily` already exists (0034), created for SM-20's Ads-Scripts/CSV bridge
-- (`source` = 'csv' | 'ads_scripts'), keyed `UNIQUE (campaign_id, date)` — exactly the grain (campaign
-- x day) SM-25c's Google Ads OAuth read pull produces, and exactly what the ticket names: "read pulls
-- into the SM-20 tables (same idempotent UNIQUE-day upserts)". Writing a second table for the same
-- grain under a different `source` would fork a figure ("this campaign's spend/clicks on this day")
-- that every pacing/rollup reader (search/index.ts's `search.sem_spend.month` rollup among them) needs
-- to be ONE number regardless of which pipe wrote it. This migration is additive-only: two nullable-
-- safe columns with DEFAULTs, no table recreated, no existing column touched.
--
-- ── PROVENANCE: `simulated` FROM DAY ONE (§A12.2, §6x.3 ruling 2, the same rule 0061 states) ────────
-- Every new GOOGLE-derived write into this table (SM-25c's OAuth read pull) stamps `simulated` from
-- the owning CONNECTION's own recorded issuer-honesty flag (`integration_connections.meta.
-- googleIssuerIsGoogle`), exactly like search_gsc_performance/search_ga4_metrics — never re-derived
-- later from current config. Rows written by the OTHER two existing sources (`csv`, `ads_scripts`)
-- predate this column and backfill to the DEFAULT `false`: a human-driven CSV import or a client's own
-- Ads Script export is not a Google-OAuth-derived row at all, so "not simulated" (i.e. "not produced by
-- a dev/sandbox Google issuer") is the honest default for both, not a guess. NOT NULL DEFAULT false is
-- load-bearing for the identical reason as every prior provenance column in this module (0047/0048/
-- 0060/0061) — an UNKNOWN-in-a-WHERE-clause is a fail-open the instant any reader ever filters on it.
--
-- ── connection_id: audit/debug only, same posture as 0061's identical column ────────────────────────
-- Which credential produced a `google_ads_api`-sourced row — never read for authorization (RLS +
-- resolvePropertyConnection own that), nullable because `csv`/`ads_scripts` rows have no OAuth
-- connection at all and a connection can be revoked after the fact without invalidating history
-- already captured under it.
--
-- ── THE TWO §A12.1 PROHIBITIONS STILL HOLD, UNCHANGED BY THIS MIGRATION ─────────────────────────────
-- This table is NOT search_data_cache (it is, and remains, a FORCE-RLS tenant table — unaffected by
-- this ALTER) and no column here points at search_provider_calls: there is no vendor dollar of OURS to
-- meter on a client's own Ads account. `cost_minor`/`conv_value_minor` on a `google_ads_api`-sourced
-- row are the CLIENT's own real Ads spend/value (design addendum §A3) — identical in kind to the
-- figure `ads_scripts`/`csv` rows already carry in this same table, never summable with
-- `search_provider_calls.cost_usd` and never rendered as though it were our cost-to-serve.
--
-- ── RLS: NO CHANGE NEEDED ────────────────────────────────────────────────────────────────────────────
-- `search_campaign_metrics_daily` already carries FORCE ROW LEVEL SECURITY + the composed
-- tenant_isolation policy (0034's DO-loop). Adding two plain columns does not touch a policy
-- definition; both new columns are covered by the table's existing USING/WITH CHECK predicate.
--
-- ── NO DML, NO BACKFILL NEEDED ───────────────────────────────────────────────────────────────────────
-- `ADD COLUMN ... DEFAULT false` populates every pre-existing row via Postgres's own fast metadata-only
-- path (a constant default needs no per-row rewrite, PG 11+) — there is no UPDATE/DELETE/INSERT...
-- SELECT here for the lint-migration-rls backfill-RLS class to ever flag. CREATE-only in spirit: no
-- in-migration GRANTs (owner's ALTER DEFAULT PRIVILEGES already covers ALTER TABLE on an
-- owner-created table).

ALTER TABLE search_campaign_metrics_daily
  ADD COLUMN simulated boolean NOT NULL DEFAULT false,
  ADD COLUMN connection_id uuid REFERENCES integration_connections(id);

COMMENT ON COLUMN search_campaign_metrics_daily.simulated IS
  'SM-25c: true = this row was captured through a NON-Google issuer (local Keycloak google-dev realm '
  'client, or SM-51''s sandbox) via the Google Ads OAuth read pull — stamped from the owning '
  'connection''s meta.googleIssuerIsGoogle at the SAME INSERT as the row''s payload (§A12.2), never '
  're-derived from current config. Rows from the pre-existing csv/ads_scripts sources default to '
  'false (they carry no OAuth connection at all, so "not Google-issuer-simulated" is the honest '
  'default, not a guess). NOT NULL DEFAULT false: an UNKNOWN-in-a-WHERE-clause is a fail-open the '
  'moment any reader filters on this column.';

COMMENT ON COLUMN search_campaign_metrics_daily.connection_id IS
  'SM-25c: which Google Ads OAuth connection produced a source=''google_ads_api'' row — audit/debug '
  'only, never read for authorization (RLS + resolvePropertyConnection own that). NULL for csv/'
  'ads_scripts rows, which have no OAuth connection at all; NULL also survives a later connection '
  'revoke without invalidating history already captured under it (0061''s identical posture).';
