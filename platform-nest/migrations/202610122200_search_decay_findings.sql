-- M5-V4 — content-decay findings: one row per page of a search property that is losing Search Console
-- clicks / impressions / position or Umami views (detector: modules/search/content-decay.ts).
--
-- Additive: one new table, no existing object touched. Scoped like every search_* tenant table: the third
-- wall is `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('search')`, byte-identical to
-- 0034 / 0046 / 202608221727, with FORCE ROW LEVEL SECURITY. Written through withTenants([t], {modules:['search']}).
--
-- IDEMPOTENCY. Two unique indexes, both deliberate:
--   * (tenant, property, page_path, window_to, window_days): the same detector run on the same window can
--     never write a second row (the daily job and a retry converge).
--   * partial (tenant, property, page_path) WHERE status is live: at most ONE live finding per page, so the
--     daily job does not file a fresh row every day while a page stays down. A page that recovers is moved
--     to 'resolved' by the job, which frees the slot.
-- STATES: open -> acknowledged -> resolved, or open|acknowledged -> refresh_brief_filed (brief_id set).
-- `reason` is words with counts; `page_path` has no host, query string or fragment (the detector strips
-- them), so no personal data lands here.
--
-- No backfill, no data DML: nothing here touches existing rows, so the RLS zero-row trap does not apply.
-- To undo: DROP TABLE search_decay_findings.

CREATE TABLE search_decay_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  property_id uuid NOT NULL REFERENCES search_properties(id),
  page_path text NOT NULL CHECK (char_length(page_path) BETWEEN 1 AND 512 AND left(page_path, 1) = '/'),
  window_from date NOT NULL,               -- the RECENT window the page was judged on (inclusive, UTC)
  window_to date NOT NULL,
  window_days integer NOT NULL CHECK (window_days BETWEEN 1 AND 400),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','acknowledged','resolved','refresh_brief_filed')),
  reason text NOT NULL,                    -- the reasons, in words
  reasons jsonb NOT NULL DEFAULT '[]',     -- [{metric, basis, recent, baseline, drop, dropPct}]
  brief_id uuid REFERENCES search_content_briefs(id),   -- set when a refresh brief was filed from this finding
  detected_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_by uuid REFERENCES users(id),
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT search_decay_brief_state CHECK ((status = 'refresh_brief_filed') = (brief_id IS NOT NULL) OR status = 'resolved')
);
CREATE UNIQUE INDEX ux_search_decay_window
  ON search_decay_findings (tenant_id, property_id, page_path, window_to, window_days);
CREATE UNIQUE INDEX ux_search_decay_live_page
  ON search_decay_findings (tenant_id, property_id, page_path)
  WHERE status IN ('open','acknowledged','refresh_brief_filed');
CREATE INDEX ix_search_decay_property_status
  ON search_decay_findings (tenant_id, property_id, status, detected_at DESC);

DO $$
BEGIN
  EXECUTE 'ALTER TABLE search_decay_findings ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE search_decay_findings FORCE ROW LEVEL SECURITY';
  EXECUTE
    'CREATE POLICY tenant_isolation ON search_decay_findings FOR ALL
       USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''search''))
       WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''search''))';
END $$;
