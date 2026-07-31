-- TR-14 (Work Tracker / Reports / Appraisal program, §4 "0057" in the doc) —
-- report_periods, report_documents: THE SEALING SUBSTRATE + THE THIRD RLS WALL for 'reports'.
--
-- ─────────────────────────── NUMBERING ───────────────────────────
-- Claimed AT IMPLEMENTATION TIME per migrations/README.md rule 5 and the design doc's §15 PROCESS
-- RULE (never trust the number written in the doc/README without re-checking `ls migrations | tail`
-- first). The doc and an earlier README entry both say "0057" for this ticket; that slot was drawn
-- down by TR-08 (`0057_report_metric_seeds.sql`) before this ticket executed. The README's own most
-- recent entry says "next is likely 0058", but `ls migrations | sort | tail` at the moment this file
-- was authored showed the real head as:
--   ...0063_pm_task_assignee_intervals.sql (TR-34), 0064_search_change_executions.sql (SM-21),
--   0065_search_campaign_metrics_provenance.sql (SM-25c), 0066_search_ads_execution_manifest.sql
--   (a further search-marketing migration) — i.e. `0058`-`0066` are ALL either reserved gaps
--   (0058/0059, deliberately left unfilled for TR-23/appraisal + already-consumed-by-TR-08) or
--   taken by a concurrent search-marketing session. **0058 and 0059 are intentionally NOT filled**
--   (README + doc both reserve them for TR-23's appraisal tables / already-landed TR-08 seeds) — do
--   not draw them down. The next genuinely free number is **0067**. Ship as `0067`, and record this
--   rebase in migrations/README.md exactly as TR-01/TR-08 did for the two rebases before this one.
--
-- ─────────────────────────── WHY THIS MIGRATION MATTERS MORE THAN A NORMAL SCHEMA TICKET ─────────
-- Two accepted limitations elsewhere in this program make sealing the mechanism that renders a
-- historical report defensible at all, not merely convenient:
--   (1) metric #20 `discipline.overdue_open` reads TODAY'S task state over a PAST range — there is
--       no task-state history table (§15, TR-08's landing note).
--   (2) `pm_task_assignees` has no as-of ownership interval for OWNER/RESPONSIBLE outside the
--       [valid_from, valid_to) window TR-34 added on 0063 — TR-07's §15 finding ① and its own
--       mitigation both point at sealing as the fix.
-- Until a period is sealed, a report over it is honest about VOLUME (the additive sums are always
-- correct) but not about POINT-IN-TIME STATE (who owned what, what was still open, as of when).
-- `report_documents` rows written at seal time are the only artifact anyone can defend in an
-- appraisal months later — everything else is a live recomputation that can silently drift.
--
-- ─────────────────────────── WHAT THIS IS FOR ───────────────────────────
--   report_periods   — the sealable unit: day/week/month (calendar) or a user-pinned custom range.
--                       Sealing flips status + stamps revision/seal_hash; amendment bumps revision.
--   report_documents — the stored, immutable-by-convention ReportDocument (§6.1) per (period,
--                       revision, grain, scope). Amendment writes a NEW revision alongside the old
--                       rows — it never UPDATEs a sealed row.
-- Both sit behind the SAME 'reports' module third wall 0056 established — this migration does not
-- redefine app_module_allowed (CREATE OR REPLACE'd once in 0028, GRANT EXECUTE TO PUBLIC); it only
-- composes it into two more policies with mod='reports'.
--
-- The seal/amend SERVICE (TR-15) and the document BUILDER (TR-13) are explicitly out of scope here
-- — this ticket is schema + tests only. No sealing logic, no endpoints, are added by this file.
--
-- ─────────────────────── RULINGS FROM §15 APPLIED (binding, not preference) ───────────────────────
-- (1) `origin_site text NOT NULL` with NO DEFAULT on both tables (§15's 2026-07-30 origin_site
--     ruling, restated for 0055-0059 and applying identically here: a `DEFAULT 'central'` would
--     silently mislabel a site-originated row under the sync engine's site/central topology). Every
--     writer (TR-15's seal/amend service) MUST pass config.originSite explicitly.
-- (2) Composite-FK-to-tenant-scoped-parent rule (0027 precedent; restated and applied again by
--     TR-01/TR-03/TR-06). Checked against every column in these two tables:
--       - `tenant_id -> companies(id)` (both tables): companies IS the tenant identity table, not a
--         tenant-scoped CHILD of it — plain FK, same as every other table in this program.
--       - `sealed_by -> users(id)` (report_periods): users is NOT tenant-scoped — plain FK.
--       - `period_id -> report_periods(id)` (report_documents): report_periods IS a tenant-scoped
--         CHILD of companies (it carries its own `tenant_id`, FORCE RLS, the third wall). A plain
--         `REFERENCES report_periods(id)` would let a report_documents row carry tenant A's
--         tenant_id while period_id points at tenant B's period — invisible to every RLS-scoped
--         SELECT, and on the exact table that is supposed to be the tamper-evident sealed record.
--         Closed with the composite FK `(period_id, tenant_id) REFERENCES report_periods (id,
--         tenant_id)`, exactly as 0027/0056 closed the same class on `service_assignments.unit_id` /
--         `report_work_facts.project_id`. `report_periods` is a brand-new table in THIS migration,
--         so its `UNIQUE (id, tenant_id)` is declared directly in the CREATE TABLE below (no
--         retrofitting ALTER needed, unlike 0056's additive UNIQUE on the pre-existing `projects`).
--     The doc's own §4 DDL block for report_documents still shows a plain
--     `REFERENCES report_periods(id) ON DELETE CASCADE` — that is the shape corrected here; the
--     ruling wins over the doc's uncorrected DDL text.
-- (3) No `*_node_id` / org-node columns appear in either table (0029 convention n/a here).
-- (4) Backfill / NOBYPASSRLS-role test rule: THIS MIGRATION SHIPS NO BACKFILL DML. Both tables are
--     freshly CREATE TABLE'd here with zero pre-existing rows — report_periods is populated only by
--     TR-15's future seal/pin endpoints, report_documents only by TR-15's seal service. There is
--     nothing to backfill and nothing this migration could derive one from. Per the brief: "if so,
--     say so" — said here, and no NOBYPASSRLS-role backfill test is shipped because there is no
--     backfill to prove. (A NOBYPASSRLS-role suite IS shipped regardless — see
--     src/db/report-periods-rls.test.ts — but it proves the RLS walls and constraints, not a
--     backfill.)
-- (5) No interval/validity columns are added by this migration, so the "pass valid_from explicitly
--     in tests" rule (TR-34/TR-36) does not apply here — noted only because the brief called it out
--     as a standing rule to check.
--
-- ─────────────────────── IMMUTABILITY IS BY CONVENTION, NOT ENFORCED IN SQL (v1) ───────────────────
-- Sealed report_documents rows are immutable BY CONVENTION ONLY: the seal/amend service (TR-15) is
-- the sole writer and its contract is "amendment writes a NEW revision, never an UPDATE of an
-- existing one" (§ Seal semantics). Enforcing that with a trigger (e.g. rejecting any UPDATE/DELETE
-- once a row exists) is DELIBERATELY OUT OF SCOPE for v1 — flagged here explicitly rather than left
-- for a future reader to wonder whether one exists. Revisit if a second writer to this table ever
-- appears (e.g. a direct admin-repair path) — until then, the single-writer service is the only
-- thing standing between "sealed" and "silently rewritten", and that is a conscious v1 trade, not an
-- oversight.

-- ══ (1) report_periods — the sealable unit (day/week/month calendar, or a pinned custom range).
CREATE TABLE report_periods (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES companies(id),
  period_kind  text NOT NULL CHECK (period_kind IN ('day','week','month','custom')),
  label        text,                           -- human label; REQUIRED for pinned 'custom' rows
  period_start date NOT NULL,
  period_end   date NOT NULL CHECK (period_end >= period_start),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','sealed','amended')),
  revision     int  NOT NULL DEFAULT 0,        -- bumps on every re-seal after amend
  sealed_at    timestamptz,
  sealed_by    uuid REFERENCES users(id),      -- NULL when sealed by the n8n schedule (system)
  amend_reason text,                           -- last amendment reason (full trail in audit events)
  seal_hash    text,                           -- sha256 over the period's document set (tamper check)
  origin_site  text NOT NULL,                  -- ruling (1): NO default
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- custom-label CHECK: a pinned custom row must carry a human label (transient customs never reach
  -- this table at all per §0057 custom-range rule 1 — the only writer of period_kind='custom' rows
  -- is the explicit pin endpoint, TR-15).
  CONSTRAINT report_periods_custom_needs_label CHECK (period_kind <> 'custom' OR label IS NOT NULL),
  -- ruling (2): makes report_periods a valid composite-FK target for report_documents below.
  -- Declared directly here (brand-new table) rather than as a retrofit ALTER — cannot fail on
  -- existing data because there is none yet.
  CONSTRAINT ux_report_periods_id_tenant UNIQUE (id, tenant_id)
);
-- Calendar periods keep the exact one-row-per-start guarantee. A PARTIAL unique index is required
-- rather than a plain UNIQUE(tenant, kind, start): two different user-chosen custom ranges may
-- legitimately share a start date (Jan 1-Jan 31 and Jan 1-Mar 31 are different reports), which a
-- plain UNIQUE would wrongly reject on the second pin.
CREATE UNIQUE INDEX report_periods_calendar_uq ON report_periods (tenant_id, period_kind, period_start)
  WHERE period_kind <> 'custom';
-- Pinned customs dedupe on the EXACT range instead, so re-pinning the identical window is
-- idempotent (the pin endpoint's UPSERT-shaped contract relies on this index existing).
CREATE UNIQUE INDEX report_periods_custom_uq ON report_periods (tenant_id, period_start, period_end)
  WHERE period_kind = 'custom';

-- ══ (2) report_documents — the stored, immutable-by-convention ReportDocument (§6.1) per
--        (period, revision, grain, scope). Amendment writes a NEW revision alongside the old rows;
--        there is no UPDATE path in the service (see the immutability note above).
CREATE TABLE report_documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES companies(id),
  period_id        uuid NOT NULL,
  revision         int  NOT NULL,                  -- pins the seal revision this document belongs to
  grain            text NOT NULL CHECK (grain IN ('person','project','department','company')),
  scope_ref        text NOT NULL,                  -- user_id | project_id | dept node id | tenant id
  document         jsonb NOT NULL,                 -- the full ReportDocument (§6.1)
  narrative_source text NOT NULL DEFAULT 'deterministic'
    CHECK (narrative_source IN ('ai','deterministic')),
  origin_site      text NOT NULL,                  -- ruling (1): NO default
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- ruling (2): tenant-scoped composite FK, NOT `REFERENCES report_periods(id)` (the doc's DDL was
  -- uncorrected on this point; the ruling wins). ON DELETE CASCADE preserved from the doc's intent
  -- (deleting a period cascades its documents) — composite FKs support ON DELETE CASCADE the same
  -- as single-column ones.
  CONSTRAINT fk_report_documents_period_tenant
    FOREIGN KEY (period_id, tenant_id) REFERENCES report_periods (id, tenant_id) ON DELETE CASCADE,
  UNIQUE (tenant_id, period_id, revision, grain, scope_ref)
);
CREATE INDEX ix_report_documents_scope ON report_documents (tenant_id, grain, scope_ref, created_at DESC);

-- ══ FORCE RLS + the ONE composed tenant_isolation policy per table — THE THIRD WALL for the
--    'reports' module. Byte-identical idiom to 0028_module_hr.sql's DO loop (mirrored again by
--    0056_module_reports_core.sql for this same module); app_module_allowed already exists globally
--    (defined once in 0028, GRANT EXECUTE TO PUBLIC) and is reused here unmodified. Written once in
--    a DO loop so the third-wall predicate can never drift per-table — every report_* table gets the
--    same `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('reports')`, on BOTH USING
--    (reads) and WITH CHECK (writes: you cannot INSERT a report_periods/report_documents row without
--    declaring the reports module scope). Each table has a tenant_id column, so the rls.test.ts
--    FORCE-RLS sweep covers both for free.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'report_periods','report_documents'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
         USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''reports''))
         WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed(''reports''))',
      t
    );
  END LOOP;
END $$;

COMMENT ON TABLE report_periods IS
  'TR-14 — the sealable unit (day/week/month calendar, or a labelled pinned custom range). Ops '
  'reads recompute live; management + appraisal reads come from the sealed snapshot (§4a invariant '
  '4). Custom ranges are never sealed and never appraisal-admissible (enforced by TR-15''s service, '
  'not by this schema) — a period_kind=''custom'' row here exists ONLY via the explicit pin '
  'endpoint. Third wall: reports module scope required (app_module_allowed(''reports'')).';
COMMENT ON TABLE report_documents IS
  'TR-14 — the stored ReportDocument (§6.1) per (period_id, revision, grain, scope_ref). Sealed rows '
  'are immutable BY CONVENTION ONLY (the seal service is the sole writer; no trigger enforces it in '
  'v1 — see this file''s header). Amendment writes a NEW revision alongside the old rows, never an '
  'UPDATE. Third wall: reports module scope required.';
