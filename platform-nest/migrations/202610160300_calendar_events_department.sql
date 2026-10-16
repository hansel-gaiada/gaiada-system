-- DW-10c (docs/FRONTEND-BFF-CONTRACT.md §59.3; plan docs/plans/2026-10-13-department-workspaces.md §12.2, row 10c; owner ruling
-- DW-D33): DEPARTMENT-VISIBLE CALENDAR EVENTS.
--
--   calendar_events.visibility gains `department` (it was `attendees` or `company`), and a new nullable column `unit_node_id` names
--   the org-tree unit the event belongs to. The unit is REQUIRED when the visibility is `department` and NULL otherwise.
--
-- ── THE VISIBILITY CHECK IS DROPPED AND RE-ADDED WHOLE ──────────────────────────────────────────
-- A DROP + ADD on a shared CHECK re-declares EVERYTHING it allowed (memory: a-drop-add-on-a-shared-check-redeclares-everything). The
-- old list was `('attendees', 'company')`, so the new one keeps BOTH and adds `department`; a row written before this migration (every
-- one is `attendees` or `company`, with no unit) stays valid. The old CHECK was declared inline on the column in 202610151100, so its
-- name is the Postgres default (`calendar_events_visibility_check`); this migration finds it in the catalogue by what it constrains
-- rather than by that name, so a database whose constraint was named differently still ends with exactly one visibility CHECK.
--
-- ── THE NULL TRAP ───────────────────────────────────────────────────────────────────────────────
-- A CHECK passes when its expression is NULL. `visibility` is NOT NULL, so `visibility = 'department'` is never NULL, and the pairing
-- compares two booleans (neither can be NULL: one is an IS NULL test) with IS NOT DISTINCT FROM, the 202610151100 idiom. The length
-- rule runs only on a non-NULL value (`unit_node_id IS NULL OR ...`), so it never evaluates to NULL either.
--
-- ── NOTES ───────────────────────────────────────────────────────────────────────────────────────
--   * `unit_node_id` is an org-blob node id (free text, no FK): the `dept_notices.unit_node_id` and `dept_kpi_targets.unit_node_id`
--     convention. The org tree lives in the `company_org_structure` blob, so the application validates the id against the tenant's
--     tree before it writes. Node ids repeat across companies (`d-webdev`), so every read keeps the tenant beside it.
--   * Pure DDL on a table that already has its tenant RLS (202610151100); the column adds no policy.

ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS unit_node_id text;

-- Drop the visibility CHECK(s) by what they constrain, whatever they are called, and re-add ONE whole one.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'calendar_events'::regclass AND contype = 'c'
       AND conname <> 'calendar_events_visibility_ck'
       AND pg_get_constraintdef(oid) ILIKE '%visibility%'
       AND pg_get_constraintdef(oid) NOT ILIKE '%unit_node_id%'
  LOOP
    EXECUTE format('ALTER TABLE calendar_events DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE calendar_events DROP CONSTRAINT IF EXISTS calendar_events_visibility_ck;
ALTER TABLE calendar_events ADD CONSTRAINT calendar_events_visibility_ck
  CHECK (visibility IN ('attendees', 'company', 'department'));

ALTER TABLE calendar_events DROP CONSTRAINT IF EXISTS calendar_events_department_unit_ck;
ALTER TABLE calendar_events ADD CONSTRAINT calendar_events_department_unit_ck
  CHECK ((visibility = 'department') IS NOT DISTINCT FROM (unit_node_id IS NOT NULL));

ALTER TABLE calendar_events DROP CONSTRAINT IF EXISTS calendar_events_unit_node_len_ck;
ALTER TABLE calendar_events ADD CONSTRAINT calendar_events_unit_node_len_ck
  CHECK (unit_node_id IS NULL OR char_length(unit_node_id) BETWEEN 1 AND 200);

-- The department branch of the `mine` list and of the department calendar: the unit's confirmed events in a window.
CREATE INDEX IF NOT EXISTS ix_calendar_events_department
  ON calendar_events (tenant_id, unit_node_id) WHERE visibility = 'department';

-- ── Assert, don't assume ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  n integer;
  def text;
BEGIN
  -- Exactly ONE visibility CHECK, and it keeps both old values and adds the new one.
  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'calendar_events'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%visibility%' AND pg_get_constraintdef(oid) NOT ILIKE '%unit_node_id%';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610160300: calendar_events must carry exactly one visibility CHECK, found %', n;
  END IF;
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conrelid = 'calendar_events'::regclass AND conname = 'calendar_events_visibility_ck';
  IF def IS NULL OR def NOT LIKE '%attendees%' OR def NOT LIKE '%company%' OR def NOT LIKE '%department%' THEN
    RAISE EXCEPTION '202610160300: calendar_events_visibility_ck must allow attendees, company and department, found %', def;
  END IF;

  SELECT count(*) INTO n FROM pg_constraint
   WHERE conrelid = 'calendar_events'::regclass
     AND conname IN ('calendar_events_department_unit_ck', 'calendar_events_unit_node_len_ck');
  IF n <> 2 THEN
    RAISE EXCEPTION '202610160300: the department/unit pairing CHECK and the unit length CHECK are missing (found % of 2)', n;
  END IF;

  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_name = 'calendar_events' AND column_name = 'unit_node_id' AND data_type = 'text' AND is_nullable = 'YES';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610160300: calendar_events.unit_node_id must exist as nullable text';
  END IF;

  SELECT count(*) INTO n FROM pg_indexes WHERE indexname = 'ix_calendar_events_department';
  IF n <> 1 THEN
    RAISE EXCEPTION '202610160300: ix_calendar_events_department is missing';
  END IF;

  -- The old rows are all still valid: none is `department`, none carries a unit. (A row-level read here runs under no tenant GUC
  -- and FORCE RLS would return zero rows, so this asserts the CATALOGUE only; the DB test proves the rows.)
  RAISE NOTICE '202610160300: calendar_events carries the department visibility and unit_node_id';
END $$;
