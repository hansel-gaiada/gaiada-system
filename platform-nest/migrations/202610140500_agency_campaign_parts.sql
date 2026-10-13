-- DW-5a (docs/FRONTEND-BFF-CONTRACT.md §31.1; plan docs/plans/2026-10-13-department-workspaces.md §7.1, ruling
-- DW-D13): shared campaigns gain PARTS, one per taking-part department.
--
--   1. agency_campaigns gains `lead_unit_id`, `starts_on`, `ends_on`.
--   2. agency_campaign_parts (new): one live row per (campaign, department), with an owner, a status, a brief,
--      a due date and an optional budget ALLOCATION (a share of the campaign's own budget, never a second one).
--   3. search_campaigns.agency_part_id and social_campaigns.agency_part_id link a department's own campaign
--      to a part (at most one part per child; a part may have many children).
--
-- Money (§31.3): a part has NO currency column. Its allocation is in the campaign's currency, and the rules that
-- keep the sum of allocations within the campaign budget live in the application (one `FOR UPDATE` lock on the
-- campaign row serialises them), not in a trigger: they span two tables and depend on the part's status.
--
-- `unit_id` and `lead_unit_id` are org-blob node ids (free text, no FK), the `projects.department_id` convention.
-- The application validates them against the tenant's org tree on every write.
--
-- Pure DDL. The Cerbos kind's permission seed is the NEXT migration (202610140510).

-- ── 1 · agency_campaigns ────────────────────────────────────────────────────────────────────────
ALTER TABLE agency_campaigns
  ADD COLUMN IF NOT EXISTS lead_unit_id text,
  ADD COLUMN IF NOT EXISTS starts_on date,
  ADD COLUMN IF NOT EXISTS ends_on date;

ALTER TABLE agency_campaigns DROP CONSTRAINT IF EXISTS agency_campaigns_dates_ck;
ALTER TABLE agency_campaigns
  ADD CONSTRAINT agency_campaigns_dates_ck
  CHECK (ends_on IS NULL OR starts_on IS NULL OR ends_on >= starts_on);

-- ── 2 · agency_campaign_parts ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agency_campaign_parts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  campaign_id uuid NOT NULL REFERENCES agency_campaigns(id),
  unit_id text NOT NULL,
  owner_id uuid REFERENCES users(id),
  status text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','active','blocked','done','cancelled')),
  brief text NOT NULL DEFAULT '' CHECK (char_length(brief) <= 4000),
  due_on date,
  -- An ALLOCATION from the campaign's budget, in the campaign's currency, in minor units (D12). NULL = none.
  budget_minor bigint CHECK (budget_minor IS NULL OR budget_minor >= 0),
  created_by uuid REFERENCES users(id),
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- One live part per department per campaign. A soft-deleted part frees the slot.
CREATE UNIQUE INDEX IF NOT EXISTS ux_agency_campaign_parts_campaign_unit
  ON agency_campaign_parts (campaign_id, unit_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_agency_campaign_parts_tenant_unit
  ON agency_campaign_parts (tenant_id, unit_id) WHERE deleted_at IS NULL;

ALTER TABLE agency_campaign_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE agency_campaign_parts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agency_campaign_parts;
CREATE POLICY tenant_isolation ON agency_campaign_parts FOR ALL
  USING (tenant_id = ANY(app_current_tenants()))
  WITH CHECK (tenant_id = ANY(app_current_tenants()));

-- ── 3 · the departments' own campaigns link to a part ───────────────────────────────────────────
-- NULL where the agency module is off (the column is simply never written). RLS on both tables is the module
-- wall (`app_module_allowed('search'|'social')`) and is untouched: a link is read and written only inside a
-- request that declares that module.
ALTER TABLE search_campaigns
  ADD COLUMN IF NOT EXISTS agency_part_id uuid REFERENCES agency_campaign_parts(id);
ALTER TABLE social_campaigns
  ADD COLUMN IF NOT EXISTS agency_part_id uuid REFERENCES agency_campaign_parts(id);

CREATE INDEX IF NOT EXISTS ix_search_campaigns_agency_part
  ON search_campaigns (agency_part_id) WHERE agency_part_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_social_campaigns_agency_part
  ON social_campaigns (agency_part_id) WHERE agency_part_id IS NOT NULL;

-- ── Assert, don't assume ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_name = 'agency_campaigns' AND column_name IN ('lead_unit_id', 'starts_on', 'ends_on');
  IF n <> 3 THEN
    RAISE EXCEPTION '202610140500: agency_campaigns should gain 3 columns, found %', n;
  END IF;

  SELECT count(*) INTO n FROM pg_class
   WHERE relname = 'agency_campaign_parts' AND relrowsecurity AND relforcerowsecurity;
  IF n <> 1 THEN
    RAISE EXCEPTION '202610140500: agency_campaign_parts must exist with RLS ENABLED and FORCED';
  END IF;

  SELECT count(*) INTO n FROM pg_policies
   WHERE tablename = 'agency_campaign_parts' AND policyname = 'tenant_isolation';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610140500: agency_campaign_parts needs exactly one tenant_isolation policy, found %', n;
  END IF;

  SELECT count(*) INTO n FROM information_schema.columns
   WHERE column_name = 'agency_part_id' AND table_name IN ('search_campaigns', 'social_campaigns');
  IF n <> 2 THEN
    RAISE EXCEPTION '202610140500: search_campaigns and social_campaigns should each gain agency_part_id, found %', n;
  END IF;

  SELECT count(*) INTO n FROM pg_indexes
   WHERE indexname = 'ux_agency_campaign_parts_campaign_unit';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610140500: the one-live-part-per-department unique index is missing';
  END IF;
END $$;
