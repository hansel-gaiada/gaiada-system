-- IAM — M5-P1: the agency lead pipeline changes what two existing permissions MEAN, so their catalog
-- descriptions must say so (docs/plans/2026-10-11-m5-lead-pipeline-design.md §6 and §9 P1-d).
--
-- Wording only. No key, action, grant, role, Cerbos rule or count changes. Admins choose who to grant
-- from these descriptions, so a stale one would invite a grant made on the wrong understanding:
--   * agency.lead.triage now also moves a lead's pipeline stage, and a stage move can start a WS4-gated
--     ad upload;
--   * agency.lead.update now also sets the lead's deal value.
-- The Cerbos decisions are unchanged (the YAML edit is a header comment only), so no Cerbos restart is
-- needed. The catalog JSON carries the same two strings: src/rbac/permission-catalog.json.
--
-- This table is not tenant-scoped, so there is no RLS/GUC trap here. The UPDATE and its row count sit in
-- one block, because GET DIAGNOSTICS reads the statement immediately before it: a silent no-op would
-- otherwise leave the catalog and the database disagreeing without a sound.

DO $$
DECLARE
  n integer;
BEGIN
  UPDATE permissions
     SET description = CASE key
       WHEN 'agency.lead.triage' THEN
         'Disposition an agency lead — open review, decline, or nurture, and move its pipeline stage, which can start a WS4-gated ad upload (AD-1/AD-7). Separate from `agency.lead.update` by design: an editor of a lead''s fields should not automatically hold this.'
       WHEN 'agency.lead.update' THEN
         'Edit an agency lead''s fields (owner, contact details) and set its deal value.'
     END
   WHERE key IN ('agency.lead.triage', 'agency.lead.update');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 2 THEN
    RAISE EXCEPTION 'IAM_AGENCY_LEAD_DESCRIPTIONS: expected 2 rows updated, got %', n;
  END IF;
END $$;
