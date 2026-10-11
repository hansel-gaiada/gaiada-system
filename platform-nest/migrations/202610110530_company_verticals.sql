-- 202610110530_company_verticals.sql — PV1-01: each of our companies gets a vertical (business line).
-- Tickets: docs/plans/2026-10-11-pv1-company-context-tickets.md, PV1-01. Rulings: PV-D1, PV-D14.
--
-- ── NUMBERING (migrations/README.md — timestamp scheme) ─────────────────────────────────────────
-- `ls migrations | sort | tail` immediately before writing this file showed the head as
-- `202610110441_webdev_schedule_firings.sql`. This takes a later minute.
--
-- ── WHAT ────────────────────────────────────────────────────────────────────────────────────────
-- `company_verticals` is a LOOKUP TABLE, not a CHECK: adding a vertical later is one INSERT, and no
-- shared CHECK is ever re-declared (a DROP+ADD on a shared CHECK once deleted a live value). The ids
-- are exactly `VERTICALS` in src/core/packs.ts and platform-ui/src/lib/packs.ts; packs.test.ts reads
-- the INSERT below and fails on drift. A vertical with no pack yet resolves to the generic pack.
--
-- `companies.type` stays as the descriptive sub-type (resort, restaurant, bar, spa, …).
--
-- ── THE BACKFILL, AND WHY A PLAIN UPDATE IS SAFE HERE ──────────────────────────────────────────
-- `companies` has no row-level security (it is a global table; the `root_company_id` backfill in
-- 202608201326_mon00a_root_anchor.sql:64 is the precedent). So the UPDATE below reaches every row
-- when run as platform_owner. It is still ASSERTED: the DO block at the end raises unless every
-- company's vertical equals the mapping, which the NOT NULL default alone would not prove.
CREATE TABLE company_verticals (
  id text PRIMARY KEY,
  label text NOT NULL
);

INSERT INTO company_verticals (id, label) VALUES
  ('holding', 'Holding'),
  ('agency', 'Agency'),
  ('hospitality', 'Hospitality'),
  ('catering', 'Catering'),
  ('general', 'General');

ALTER TABLE companies
  ADD COLUMN vertical text NOT NULL DEFAULT 'general' REFERENCES company_verticals(id);

UPDATE companies SET vertical = CASE type
    WHEN 'agency' THEN 'agency'
    WHEN 'resort' THEN 'hospitality'
    WHEN 'restaurant' THEN 'hospitality'
    WHEN 'bar' THEN 'hospitality'
    WHEN 'spa' THEN 'hospitality'
    WHEN 'catering' THEN 'catering'
    WHEN 'holding' THEN 'holding'
    ELSE 'general'
  END;

DO $$
DECLARE
  wrong integer;
BEGIN
  SELECT count(*) INTO wrong FROM companies
   WHERE vertical IS DISTINCT FROM CASE type
       WHEN 'agency' THEN 'agency'
       WHEN 'resort' THEN 'hospitality'
       WHEN 'restaurant' THEN 'hospitality'
       WHEN 'bar' THEN 'hospitality'
       WHEN 'spa' THEN 'hospitality'
       WHEN 'catering' THEN 'catering'
       WHEN 'holding' THEN 'holding'
       ELSE 'general'
     END;
  IF wrong > 0 THEN
    RAISE EXCEPTION 'company_verticals backfill: % companies do not carry the vertical their type maps to', wrong;
  END IF;
END $$;
-- No GRANT here: infra/db/init-cluster.sh's ALTER DEFAULT PRIVILEGES makes platform_owner's new
-- tables readable by platform_app, as for every other table this directory creates.
