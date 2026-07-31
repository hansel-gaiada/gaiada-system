-- SM-25b — GSC + GA4 performance tables (design addendum §A12; tracker §6x.3 item 5 "SM-25b").
--
-- ── NUMBERING (migrations/README.md rule 5) ────────────────────────────────────────────────────────
-- `ls migrations | tail` at write time showed head = 0060_search_google_oauth_states.sql, and the
-- README's own "next unused is 0061" note (added by SM-51, 2026-07-30) confirms it against the
-- reservation table (0058/0059 still held for TR-23/metric-seeds, neither landed as a file on disk).
-- Cross-checked against `schema_migrations` on the live dev DB AND the ephemeral test DB, per the
-- README's own standing warning ("an instruction naming a number is a hint, not a fact") — both are
-- stale/behind the disk state (older deployed images / per-file throwaway DBs), so disk + README are
-- what this migration trusts, exactly as the protocol says to. Takes 0061.
--
-- ── WHAT THIS IS ───────────────────────────────────────────────────────────────────────────────────
-- Two NEW tenant-scoped tables that persist the Google-derived reads SM-25a's OAuth core and
-- api-client.ts already hand back as parsed envelopes:
--   * search_gsc_performance — Search Console Search Analytics rows.
--   * search_ga4_metrics     — GA4 Data API runReport rows.
-- Response INTERPRETATION lives in the new google/gsc-client.ts and google/ga4-client.ts (SM-25b's own
-- files); this migration only creates somewhere honest for the interpreted rows to land.
--
-- ── THE TWO PROHIBITIONS, RESTATED AT THE SCHEMA LEVEL (design addendum §A12.1, §6x.3 ruling 2) ─────
-- GSC/GA4 data is CLIENT-PRIVATE, $0-billed, per-client-OAuth — a THIRD egress class, structurally
-- unlike the shared, cross-tenant, PAID market-data vendors (DataForSEO/Semrush/Ahrefs):
--   1. NEVER `search_data_cache`. That table is DELIBERATELY NO-RLS shared market data (0034's own
--      COMMENT, owner-ratified D-4) — putting a client's own Search Console/GA4 rows there would be a
--      cross-tenant leak BY CONSTRUCTION, not by bug. Both tables below are NEW, tenant-scoped,
--      FORCE-RLS tables — the opposite shape, deliberately.
--   2. NEVER `dispatchProviderOp` / `search_provider_calls`. There is no vendor dollar to meter on a
--      client's own Google account, and inventing a synthetic ledger row would pollute the ledger's
--      §A3 "cost-to-serve" meaning for every other reader of it (rollups, budget sums). Neither table
--      below carries a `provider_call_id` FK to that ledger — there is nothing to point at.
-- The bounding resource for these reads is Google QUOTA (row/page caps), enforced in
-- google/gsc-client.ts and google/ga4-client.ts, not here.
--
-- ── GRAIN, AND WHY (senior-db eyes owed here per the ticket) ──────────────────────────────────────
-- search_gsc_performance: one row per (property, date, query, page, device). This is the grain the
-- Search Console UI itself reports at and the one an SEO operator actually acts on ("which PAGE ranks
-- for which QUERY, on which DEVICE, and how did that change day over day") — coarser grains (date-only,
-- or query-only aggregated at ingest time) would throw away exactly the comparison a rank/content
-- decision needs, and country/searchAppearance dimensions are deliberately OMITTED from this first cut
-- (extensible additively later; the ticket flagged row volume as the thing to watch, and every extra
-- dimension multiplies row count). Row-volume containment is NOT schema-level — it is in the ingest
-- code (google/gsc-client.ts): a caller pulls one explicit, human-chosen date range at a time (this
-- migration adds no scheduler wiring), `rowLimit` is bounded to Google's documented 25 000-per-request
-- ceiling, and a page-count safety cap bounds total rows per single pull call. What IS schema-level is
-- the idempotency key (below) and the two indexes this table's actual read shapes need:
--   * ix_search_gsc_performance_property_date (tenant_id, property_id, date DESC) — "this property's
--     performance over a date range", the Search-Performance surface's primary list/history query and
--     the freshness-lag-aware re-pull's own "what's already here" check.
--   * ix_search_gsc_performance_query (tenant_id, property_id, query) — "top queries for this
--     property" aggregation (GROUP BY query), incl. the GSC-sourced keyword-import route, which reads
--     THIS table (never re-queries Google) to build a candidate keyword list.
--   * ix_search_gsc_performance_page (tenant_id, property_id, page) — the symmetric "top pages" shape;
--     added for the same reason as the query index, since a content/technical-SEO reviewer needs both
--     cuts and this table is the only place either can be answered from without a fresh Google call.
--
-- search_ga4_metrics: one row per (property, date, channel_group) — coarser than GSC on purpose. GA4's
-- own dimension space (event name × page path × device × source/medium × …) explodes combinatorially in
-- a way Search Console's does not, and the ticket's own framing ("GA4 sessions/conversions") points at
-- a rollup-style channel-attribution grain — the number an exec/report view needs ("how much of this
-- property's traffic/conversions came from organic vs paid vs direct, per day"), not an event-level
-- warehouse (explicitly out of this ticket's scope; a future ticket can add a second, finer-grained GA4
-- table additively without touching this one). `channel_group` values are GA4's own short, bounded
-- default-channel-group taxonomy ("Organic Search", "Direct", "(not set)", …) — NOT arbitrary free text
-- like a GSC query/page — so a direct UNIQUE constraint on the tuple is safe and legible; it does not
-- need GSC's content-hash indirection (see below).
--   * ix_search_ga4_metrics_property_date (tenant_id, property_id, date DESC) — the property's metrics
--     over a date range, this table's one real read shape.
--
-- ── IDEMPOTENCY: A SCHEMA-LEVEL CONSTRAINT, NOT APPLICATION LOGIC (the ticket's own instruction) ────
-- Re-pulling an overlapping date range must never duplicate rows, and the ticket names SM-08's
-- "UNIQUE over a server-computed hash" as the in-repo precedent (0045_search_audit_ingest.sql:
-- `report_hash` + `UNIQUE (tenant_id, property_id, kind, report_hash)`, computed in search-audit.ts's
-- `hashReport`). The SAME reasoning applies here, transposed:
--   * search_gsc_performance's natural key (property, date, query, page, device) has UNBOUNDED-LENGTH
--     members (`query` and especially `page`, a URL) — a direct multi-column UNIQUE over raw text
--     columns works, but a content HASH is the precedent's own shape and keeps the unique index small
--     and fixed-width regardless of how long a query string or URL gets. `row_hash` is computed
--     server-side in google/gsc-client.ts (sha256 hex over the canonical tuple) and is what the UNIQUE
--     constraint actually keys on; `query`/`page`/`device`/`date` stay as their own columns purely for
--     readable filtering/grouping (the two indexes above), never for the uniqueness guarantee itself.
--   * search_ga4_metrics's natural key (property, date, channel_group) has no unbounded member (see the
--     grain note above), so it gets a direct UNIQUE on the tuple — no hash indirection needed, and
--     adding one where the plain columns already do the job would be needless indirection over the
--     exact precedent this ticket is following.
-- Both are enforced via `INSERT ... ON CONFLICT ... DO UPDATE` in the ingest code, which is the part
-- that makes the constraint a CONCURRENT-RACE guarantee rather than a documentation comment: two
-- overlapping pulls racing on the same row resolve at the index, atomically, with no "check-then-insert"
-- window in application code for either to race through (SM-08's own QA gate proved a check-then-insert
-- shape fails under a genuine concurrent race where sequential tests do not catch it — this migration
-- does not repeat that shape).
--
-- ── PROVENANCE: `simulated` FROM DAY ONE (§A12.2, the same rule 0060 states) ─────────────────────────
-- Both tables get `simulated boolean NOT NULL DEFAULT false`, stamped by the ingest code from the SAME
-- source the rest of this Google surface already uses for it (0060/oauth.ts): the CONNECTION's own
-- recorded issuer-host honesty flag (`integration_connections.meta.googleIssuerIsGoogle` — §A12.3's
-- "audience, not label" carrier). `simulated = !issuerIsGoogle` at the moment of the pull that WROTE
-- the row — never re-derived later from current config, exactly like 0048's stamping law for the vendor
-- snapshot tables. `NOT NULL DEFAULT false` is load-bearing for the identical reason as every prior
-- provenance column in this module: there are no pre-existing rows in a brand-new table, but a NULL
-- default would leave a future WHERE clause with the same UNKNOWN-in-a-predicate hazard as the §4d/§A4.1
-- fail-open class the instant one is ever written.
--
-- ── GA4 SAMPLING: RECORDED, NOT SILENTLY AVERAGED (the ticket's own standing rule) ───────────────────
-- `sampled boolean NOT NULL DEFAULT false` on search_ga4_metrics ONLY (GSC's Search Analytics API is not
-- documented to sample the way GA4's reporting API is). GA4's runReport response signals sampling at the
-- REPORT level (`metadata.samplingMetadatas`, present only when the query was too large to answer from
-- unsampled data) — one flag per response, not per row — so every row FROM one sampled response is
-- stamped `sampled = true` (a report-level fact denormalized onto its rows, the same "stamp at the same
-- INSERT as the payload" discipline 0048's column-comment law already established for `simulated`).
-- This module's own standing rule, restated because it is the reason the column exists at all: an
-- unlabelled plausible number is the most expensive kind of lie a metrics table can tell — a sampled
-- sessions/conversions figure must never render indistinguishably from an exact one.
--
-- ── FRESHNESS LAG: NOT A SCHEMA CONCERN, NOTED HERE SO NO READER GOES LOOKING FOR A COLUMN ───────────
-- GSC's well-documented 2-3 day data-freshness lag (a partial day is NOT a real drop to zero) is handled
-- in google/gsc-client.ts by never REQUESTING a date inside the lag window in the first place — there is
-- no "this row is partial" column here because a partial-day row is never written; the ingest code's
-- own doc comment carries the full reasoning and the disclosed clamp value in its returned outcome.
--
-- ── RLS ────────────────────────────────────────────────────────────────────────────────────────────
-- FORCE ROW LEVEL SECURITY + 0034's byte-identical composed policy
-- (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('search')) on BOTH tables — the same
-- shape 0060 used for exactly this reason: a client's own Google performance data must be no more
-- reachable than any other search_* tenant row.
--
-- ── NO DML ─────────────────────────────────────────────────────────────────────────────────────────
-- CREATE-only: no UPDATE, no DELETE, no INSERT...SELECT, no backfill. There is nothing to backfill —
-- these rows can only be produced by code that does not exist before this migration. Runtime DML grants
-- come from the owner's ALTER DEFAULT PRIVILEGES + RUNTIME_GRANTS_SQL pass (migrations/README.md); no
-- in-migration GRANTs.

CREATE TABLE search_gsc_performance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  property_id uuid NOT NULL REFERENCES search_properties(id),
  -- Which credential produced this row — audit/debug only (never read for authorization; RLS +
  -- resolvePropertyConnection own that). Nullable: a connection can be unbound/revoked after the fact
  -- without invalidating history already captured under it (same posture as the snapshot tables' own
  -- nullable provider_call_id, 0034).
  connection_id uuid REFERENCES integration_connections(id),
  date date NOT NULL,
  query text NOT NULL,
  page text NOT NULL,
  device text NOT NULL DEFAULT 'DESKTOP' CHECK (device IN ('DESKTOP', 'MOBILE', 'TABLET')),
  clicks integer NOT NULL DEFAULT 0,
  impressions integer NOT NULL DEFAULT 0,
  ctr numeric(9, 6),                      -- Google's own units: a FRACTION (0..1), never a percentage
  position numeric(9, 2),                 -- 1-based average position; a float, per Google's own shape
  -- The idempotency key (see the file header). sha256 hex of the canonical
  -- `property_id|date|query|page|device` tuple, computed in google/gsc-client.ts — never guessed here.
  row_hash text NOT NULL,
  simulated boolean NOT NULL DEFAULT false,
  origin_site text NOT NULL DEFAULT 'central',
  fetched_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, property_id, row_hash)
);
CREATE INDEX ix_search_gsc_performance_property_date ON search_gsc_performance (tenant_id, property_id, date DESC);
CREATE INDEX ix_search_gsc_performance_query ON search_gsc_performance (tenant_id, property_id, query);
CREATE INDEX ix_search_gsc_performance_page ON search_gsc_performance (tenant_id, property_id, page);

CREATE TABLE search_ga4_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  property_id uuid NOT NULL REFERENCES search_properties(id),
  connection_id uuid REFERENCES integration_connections(id),
  date date NOT NULL,
  -- GA4's own default-channel-group taxonomy (Organic Search / Direct / Paid Search / …), a short
  -- bounded string, NOT arbitrary free text — see the file header for why this table needs no hash
  -- indirection the way search_gsc_performance does.
  channel_group text NOT NULL DEFAULT '(not set)',
  sessions integer NOT NULL DEFAULT 0,
  engaged_sessions integer NOT NULL DEFAULT 0,
  -- GA4's own metric is a count of conversion-marked events, which the Data API always renders as a
  -- STRING over the wire (ga4-run-report.ts fixture's own documented shape) but is logically a whole
  -- number of events — numeric, not integer, only because GA4 can return a fractional value for some
  -- metric configurations (documented; unverified against real Google — SM-41G).
  conversions numeric(14, 2) NOT NULL DEFAULT 0,
  total_revenue numeric(14, 2),           -- nullable: absent unless the property has ecommerce/revenue events
  -- §A12.2/module standing rule: a report-level sampling flag, denormalized onto every row of the
  -- response that produced it. See the file header's GA4 SAMPLING section.
  sampled boolean NOT NULL DEFAULT false,
  simulated boolean NOT NULL DEFAULT false,
  origin_site text NOT NULL DEFAULT 'central',
  fetched_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, property_id, date, channel_group)
);
CREATE INDEX ix_search_ga4_metrics_property_date ON search_ga4_metrics (tenant_id, property_id, date DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['search_gsc_performance', 'search_ga4_metrics'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
         USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''search''))
         WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''search''))',
      t
    );
  END LOOP;
END $$;

COMMENT ON TABLE search_gsc_performance IS
  'SM-25b — Search Console Search Analytics rows (design addendum §A12). Grain: property x date x '
  'query x page x device. NEVER search_data_cache (client-private, would be a cross-tenant leak by '
  'construction) and NEVER search_provider_calls (no vendor dollar to meter). Idempotent via UNIQUE '
  '(tenant_id, property_id, row_hash), a server-computed content hash (SM-08''s precedent) — enforced '
  'at the index under INSERT...ON CONFLICT, so a concurrent re-pull race resolves atomically rather '
  'than duplicating rows. simulated stamped from the CONNECTION''s own issuer-honesty flag at write '
  'time (§A12.2/§A12.3), never re-derived later.';

COMMENT ON TABLE search_ga4_metrics IS
  'SM-25b — GA4 Data API runReport rows (design addendum §A12). Grain: property x date x '
  'channel_group (a rollup cut, deliberately coarser than GSC''s — see 0061''s file header). NEVER '
  'search_data_cache, NEVER search_provider_calls, same reasoning as search_gsc_performance. '
  'Idempotent via a direct UNIQUE (tenant_id, property_id, date, channel_group) — channel_group is '
  'GA4''s own short bounded taxonomy, so no content-hash indirection is needed here. sampled is a '
  'REPORT-level GA4 flag (metadata.samplingMetadatas) denormalized onto every row of that response — '
  'never averaged away. simulated stamped from the CONNECTION''s own issuer-honesty flag, same as '
  'search_gsc_performance.';

COMMENT ON COLUMN search_gsc_performance.row_hash IS
  'sha256 hex of the canonical property_id|date|query|page|device tuple (google/gsc-client.ts). THE '
  'idempotency key — the UNIQUE (tenant_id, property_id, row_hash) constraint is what makes a '
  'concurrent re-pull race-safe; query/page/device/date are kept as their own columns for readable '
  'filtering only and are never themselves relied on for uniqueness (page/query are unbounded-length).';

COMMENT ON COLUMN search_gsc_performance.simulated IS
  'true = this row was captured through a NON-Google issuer (local Keycloak google-dev realm client, '
  'or SM-51''s sandbox) — stamped from the owning connection''s meta.googleIssuerIsGoogle at the SAME '
  'INSERT as the row''s payload (§A12.2). NOT NULL DEFAULT false: load-bearing for the same reason as '
  'every prior provenance column in this module (0047/0048/0060) — an UNKNOWN-in-a-WHERE-clause is a '
  'fail-open the moment any reader ever filters on this column.';

COMMENT ON COLUMN search_ga4_metrics.simulated IS
  'Same rule as search_gsc_performance.simulated, transposed: stamped from the owning connection''s '
  'meta.googleIssuerIsGoogle at write time, never re-derived from current config.';

COMMENT ON COLUMN search_ga4_metrics.sampled IS
  'true = the GA4 runReport response that produced this row carried metadata.samplingMetadatas (the '
  'report was too large to answer from unsampled data). A REPORT-level fact denormalized onto every '
  'row of that response — this module''s standing rule is that an unlabelled plausible figure is the '
  'most expensive kind of lie, so a sampled sessions/conversions number must render distinguishably '
  'from an exact one, never silently averaged into one.';
