-- SM-70 — widen search_audits.source to accept 'nexus-import' (docs/plans/2026-08-13-gaia-nexus-harvest.md
-- §4 H1 + §5 SM-70: "stamped source='nexus-import' ... real analyst output, real provenance").
--
-- 0034_module_search.sql defined `CHECK (source IN ('seonaut','crawler','unlighthouse','ai'))`. The Gaia
-- Nexus harvest imports 126 real, human/AI-hybrid-authored audit + SEO documents (63 technical audits +
-- 63 SEO analyses, one row per property per kind) that are NEITHER a crawler Report NOR our own AI-drafted
-- findings (source='ai' in this schema means SM-10's future AI-drafted-findings adapter, not "content that
-- happens to have been produced with AI assistance upstream, by a different team, with no report-shape
-- adapter of its own"). Collapsing the import into 'ai' would erase exactly the provenance distinction the
-- harvest plan calls out as the whole point of a real, dated, human-reviewed analyst corpus — indistinguishable
-- from a future in-house AI-findings run. A dedicated value keeps `source` an honest provenance tag.
--
-- Widen-only, robust to the constraint's auto-generated name, and idempotent on re-run — same shape as
-- 0083_approval_status_cancelled.sql, which hit (and documented) the failure modes an unordered/substring
-- match runs into on a shared, concurrently-migrated database. Identified by CONKEY (the exact single
-- column `source`), not by substring: `search_audits` also carries a `kind` CHECK and a `status` CHECK,
-- and a name/substring guess here has already cost a deploy once elsewhere in this file's sibling.
DO $$
DECLARE cname text;
BEGIN
  SELECT con.conname INTO cname
    FROM pg_constraint con
    JOIN pg_attribute att
      ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
   WHERE con.conrelid = 'search_audits'::regclass
     AND con.contype = 'c'
   GROUP BY con.conname
  HAVING array_agg(att.attname::text ORDER BY att.attname::text) = ARRAY['source']::text[];

  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE search_audits DROP CONSTRAINT %I', cname);
  END IF;
  -- Covers the re-run case and a name-collision fallback, same defensive pair as 0083.
  ALTER TABLE search_audits DROP CONSTRAINT IF EXISTS search_audits_source_check;

  ALTER TABLE search_audits
    ADD CONSTRAINT search_audits_source_check
    CHECK (source IN ('seonaut','crawler','unlighthouse','ai','nexus-import'));
END $$;

COMMENT ON COLUMN search_audits.source IS
  'seonaut | crawler | unlighthouse (report-shape adapters, SM-08) | ai (SM-10 AI-drafted findings) | '
  'nexus-import (SM-70: real analyst-authored Markdown harvested from the decommissioned Gaia Nexus '
  'portfolio tool, one row per property per kind — technical or content).';
