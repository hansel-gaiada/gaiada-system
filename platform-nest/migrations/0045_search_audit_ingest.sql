-- SM-08 — Site-audit ingest + findings triage (docs/blueprints/seo-sem-design.md §12 SM-08).
--
-- Ingest is idempotent: re-posting the SAME crawl/CWV/etc. report for the same property+kind
-- must not create a duplicate audit. The crawler's raw Report (search-crawl-go/internal/crawler)
-- carries no job/report id of its own, so the stable key is a content hash of the canonicalised
-- report JSON, computed server-side in search-audit.ts (sha256, hex). `report_hash` + the UNIQUE
-- constraint below is what makes a re-run a no-op (INSERT ... ON CONFLICT DO NOTHING) rather than
-- app-code-only de-duplication, per the ticket's MUST HOLD.
ALTER TABLE search_audits ADD COLUMN report_hash text;
ALTER TABLE search_audits ADD CONSTRAINT search_audits_ingest_unique
  UNIQUE (tenant_id, property_id, kind, report_hash);
-- NULL report_hash (audits created by future non-ingest paths, e.g. a manual 'run') never collides
-- since Postgres treats NULLs as distinct in a UNIQUE constraint — only ingested rows dedupe.
