-- 5c.2 correction: the core schema (0001) already defines clients, deliverables and
-- time_entries — the platform's shared client-work entities the agency (and every other
-- vertical) bills against. The earlier 0007 wrongly duplicated them into the agency
-- namespace before server.ts could be touched; now that constraint is gone, client-work is
-- wired to the CORE tables and these agency-local duplicates are dropped. No data exists in
-- them (pre-first-deploy). agency_creative_assets (0006) and its approvals link are kept.
ALTER TABLE IF EXISTS agency_approvals DROP CONSTRAINT IF EXISTS agency_approvals_deliverable_fk;
DROP TABLE IF EXISTS agency_time_entries;
DROP TABLE IF EXISTS agency_deliverables;
DROP TABLE IF EXISTS agency_clients;
