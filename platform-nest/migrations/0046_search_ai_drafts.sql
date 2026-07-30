-- SM-10 — AI drafting services: content briefs + audit-finding triage/fix drafts (docs/blueprints/
-- seo-sem-design.md §07/§12 SM-10). Three additions:
--
--   1. search_content_briefs — NEW table. No brief entity exists in the §04 domain model (briefs
--      are described only as "brief docs" persisted as "rows/files", design §07); a dedicated table
--      is the natural shape given the console needs list/detail (topic, outline, body, geo notes,
--      status, grounding provenance) rather than an opaque file blob. Scoped to search_properties
--      (design §07: "RAG over the property's crawled content") — Cerbos-wise it rides the EXISTING
--      resource_search_property policy (read/create/update actions already granted to
--      module_staff/module_manager/company_admin, SM-03) rather than adding an 8th Cerbos resource
--      kind for a single low-impact draft artifact; see search.controller.ts's brief routes.
--   2. search_audits.ai_summary — Hermes-drafted "summary + prioritized fix list" for the whole
--      audit (design §07 row: "Audit-finding triage & fix drafts | Hermes | Post-audit | Summary +
--      prioritized fix list on the audit").
--   3. search_audit_findings.ai_fix_suggestion / ai_drafted_at — the per-finding fix/meta/on-page
--      draft (design §07's separate "Meta/title/on-page suggestions" row folds into this SAME
--      column: the §08 console button matrix has exactly ONE Site-Audit AI action — "AI triage
--      findings / draft fixes" — so a missing-title finding's ai_fix_suggestion IS its meta/title
--      suggestion; there is no separate UI action or table for it).
--
-- All three are DRAFT-ONLY, human-approves surfaces (design §07 "AI-drafts -> human-approves"):
-- ai_summary/ai_fix_suggestion are free-text columns a human reads and edits; briefs carry their
-- own status ('draft'|'approved') but that flip is a plain permission-gated PATCH, never automatic.
-- Nothing here is wired to publish/apply anything live.

CREATE TABLE search_content_briefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  property_id uuid NOT NULL REFERENCES search_properties(id),
  topic text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved')),
  outline jsonb NOT NULL DEFAULT '[]',        -- string[] of section headings
  body text NOT NULL DEFAULT '',              -- Hermes draft -> optional Claude polish -> human-edited
  geo_notes text,                             -- GEO/AEO extractability guidance draft (design §07)
  grounding jsonb NOT NULL DEFAULT '{}',      -- transparency record: {auditId, findingCount, keywordCount, knowledgeHits:[{sourceRef,score}]}
  model text,                                 -- gateway-reported provider for the LATEST completion call (informational only)
  drafted_via text NOT NULL DEFAULT 'ai' CHECK (drafted_via IN ('ai','fallback')), -- 'fallback' = gateway was unreachable; deterministic template used
  polished_at timestamptz,                    -- last time the (optional) polish pass ran
  created_by uuid REFERENCES users(id),
  origin_site text NOT NULL DEFAULT 'central',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX ix_search_content_briefs_property ON search_content_briefs (tenant_id, property_id) WHERE deleted_at IS NULL;

ALTER TABLE search_audits ADD COLUMN ai_summary text;
ALTER TABLE search_audit_findings ADD COLUMN ai_fix_suggestion text;
ALTER TABLE search_audit_findings ADD COLUMN ai_drafted_at timestamptz;

-- Same byte-identical third-wall predicate as every other search_* tenant table (0034's DO loop) —
-- written again here (not by editing 0034, which is already-applied/immutable) for the ONE new
-- table this migration adds. search_audits/search_audit_findings already have it from 0034; adding
-- columns to them needs no RLS change.
DO $$
BEGIN
  EXECUTE 'ALTER TABLE search_content_briefs ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE search_content_briefs FORCE ROW LEVEL SECURITY';
  EXECUTE
    'CREATE POLICY tenant_isolation ON search_content_briefs FOR ALL
       USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''search''))
       WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''search''))';
END $$;
