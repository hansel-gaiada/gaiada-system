-- P3-10 — pm_doc_versions: append-only doc history + endpoints + version-on-write.
--
-- One row per (tenant, doc, version). The pm_docs row stays the "latest" (title/body updated
-- in place, as before); every write that actually changes title and/or body appends a new,
-- immutable version row here — history is NEVER rewritten, only appended to. createDoc writes
-- version 1; patchDoc appends MAX(version)+1 authored by the patcher (skipped entirely when
-- both title and body are unchanged — a true no-op PATCH leaves no trace); restore sets the doc
-- row to a past version's content AND appends a new version authored by the restorer (never
-- rewrites the row being restored FROM).
--
-- Concurrency: the app layer takes `SELECT ... FOR UPDATE` on the pm_docs row before computing
-- MAX(version)+1 (pm.controller.ts), so two racing PATCH/restore calls on the SAME doc serialize
-- through the pm_docs row lock — the second transaction can only compute MAX(version)+1 after the
-- first has committed its own INSERT, so version numbers can never collide (enforced doubly by the
-- UNIQUE(tenant_id, doc_id, version) constraint below as a hard backstop).
--
-- FORCE RLS off the 0025 app_current_tenants() helper — same pattern as every pm_* table since
-- 0036/0038/0040/0041/0043.
CREATE TABLE pm_doc_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  doc_id uuid NOT NULL REFERENCES pm_docs(id),
  version int NOT NULL,
  title text,
  body text,
  author_id uuid REFERENCES users(id),
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, doc_id, version)
);
CREATE INDEX pm_doc_versions_doc_idx ON pm_doc_versions (doc_id, version DESC);

DO $$
BEGIN
  EXECUTE 'ALTER TABLE pm_doc_versions ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE pm_doc_versions FORCE ROW LEVEL SECURITY';
  EXECUTE
    'CREATE POLICY tenant_isolation ON pm_doc_versions FOR ALL
       USING (tenant_id = ANY(app_current_tenants()))
       WITH CHECK (tenant_id = ANY(app_current_tenants()))';
END $$;
