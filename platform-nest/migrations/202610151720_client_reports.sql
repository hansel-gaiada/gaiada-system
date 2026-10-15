-- 202610151720_client_reports.sql
-- PV7-04a (docs/FRONTEND-BFF-CONTRACT.md §55, docs/PERMISSION-CONTRACT.md §46; plan
-- docs/plans/2026-10-15-pv7-performance-views-tickets.md, ticket PV7-04, findings 5 and 6, lead's calls L5 and L6):
-- a home for the reports a client is meant to READ. Four parts, in one file so the ticket owns exactly one prefix:
--   1. client_reports         — one report published (or about to be) to a client: draft -> published -> withdrawn.
--   2. client_report_reads    — who on the client side has opened which report (the portal's "New" marker).
--   3. files.role             — `client_report_file`, pinned to target `client_report` (the CHECKs re-declared WHOLE).
--   4. IAM seed               — the four `core.client_report.*` keys of the new Cerbos kind and their role rows.
--
-- ── WHY A TABLE OF ITS OWN ─────────────────────────────────────────────────────────────────────────────
-- Delivered social and search reports reached the client as an EMPTY `delivered` deliverable (and only when the
-- engagement had a project): the PDF is a `files` row targeting `social_report` / `search_report`, which the portal's
-- download route cannot serve. Documents are legal and money only (PV-5 decision 18); deliverables have no publish
-- flag and any file attached to one is downloadable at once. So a client report is its own object with a publish step,
-- following the meeting-minutes precedent (a scope builder in portal-visibility.ts, a notice, an SSE topic).
--
-- ── RLS ──────────────────────────────────────────────────────────────────────────────────────────────
-- Both new tables: ENABLE + FORCE RLS and the NULLIF-hardened plain tenant policy (an unset GUC reads ZERO rows), the
-- shape of 202610122330 §8. CORE policy, not a module wall: the social and search modules write it inside their own
-- module scope, and the portal reads it under its own scope with no module declared.
--
-- ── GRANTS (security-relevant, stated for review; NO existing grant is widened) ─────────────────────
-- platform_app gets SELECT, INSERT, UPDATE, DELETE on both new tables (the runtime role's default on owner-created
-- tables, restated here, guarded on the role existing). sync_app gets NOTHING (the platform<->sync boundary).
--
-- ── ROLLOUT ──────────────────────────────────────────────────────────────────────────────────────────
-- Additive. Brief ACCESS EXCLUSIVE lock on `files` while its two role CHECKs are dropped and re-added (no rewrite;
-- the re-add validates every row, all of which satisfy the wider list). NO DML on existing tables beyond the IAM
-- seed (permissions / role_permissions are not FORCE-RLS). Already-delivered reports are NOT back-filled here: the
-- ops tool `node dist/ops/client-reports-backfill.js` lists them (dry run) and creates them only with --apply, on the
-- owner's go. Reverse (before any client report exists): DROP the two tables, re-declare the two files CHECKs without
-- `client_report_file`, DELETE the four permissions (role_permissions cascade by FK or are deleted first).

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 1 · client_reports
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE client_reports (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES companies(id),
  client_id         uuid NOT NULL,
  -- NULL = a client-wide report: it reaches the client-wide contacts only (BFF §55.4, PV-D33 / PV-D37).
  project_id        uuid,
  source            text NOT NULL CHECK (source IN ('social_report', 'search_report', 'account_summary')),
  -- The module report this was published from. NULL only for an account summary (PV7-07: no module row behind it).
  source_id         uuid,
  -- The `delivered` deliverable the delivery made (social/search, only when the engagement had a project).
  deliverable_id    uuid REFERENCES deliverables(id),
  title             text NOT NULL,
  period_start      date NOT NULL,
  period_end        date NOT NULL,
  -- The report's own role file (`files.role = 'client_report_file'`, target this row). Required once published.
  file_id           uuid,
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'withdrawn')),
  published_at      timestamptz,
  published_by      uuid REFERENCES users(id),
  withdrawn_at      timestamptz,
  withdrawn_by      uuid REFERENCES users(id),
  withdrawn_reason  text,
  created_by        uuid REFERENCES users(id),
  origin_site       text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_client_reports_client_tenant FOREIGN KEY (client_id, tenant_id)
    REFERENCES clients (id, tenant_id),
  -- The project must belong to THIS client, in THIS tenant (the conversation_threads shape, 202610122330).
  -- MATCH SIMPLE: a NULL project_id (a client-wide report) is not checked, which is the intent.
  CONSTRAINT fk_client_reports_project_client_tenant FOREIGN KEY (project_id, client_id, tenant_id)
    REFERENCES projects (id, client_id, tenant_id),
  CONSTRAINT fk_client_reports_file_tenant FOREIGN KEY (file_id, tenant_id)
    REFERENCES files (id, tenant_id),
  -- FK target for client_report_reads.
  CONSTRAINT ux_client_reports_id_tenant UNIQUE (id, tenant_id),
  CONSTRAINT client_reports_title_nonblank CHECK (btrim(title) <> ''),
  CONSTRAINT client_reports_period_order CHECK (period_end >= period_start),
  -- A module report is always named; only an account summary may have no source row.
  CONSTRAINT client_reports_source_id_required CHECK (source = 'account_summary' OR source_id IS NOT NULL),
  -- ⚠ A CHECK PASSES ON NULL. Every conjunct below is an `IS [NOT] NULL` test or a comparison on the NOT NULL
  -- `status`, so none of them can evaluate to NULL and let a half-stamped row through.
  -- Published stamps: none while a draft; both, AND the file, once published (withdrawn keeps them: it was published).
  CONSTRAINT client_reports_published_stamps CHECK (
    (status = 'draft' AND published_at IS NULL AND published_by IS NULL)
    OR (status IN ('published', 'withdrawn') AND published_at IS NOT NULL AND published_by IS NOT NULL AND file_id IS NOT NULL)
  ),
  -- Withdrawn stamps: all three, the reason not blank, exactly when withdrawn; none otherwise.
  CONSTRAINT client_reports_withdrawn_stamps CHECK (
    (status = 'withdrawn' AND withdrawn_at IS NOT NULL AND withdrawn_by IS NOT NULL
       AND withdrawn_reason IS NOT NULL AND btrim(withdrawn_reason) <> '')
    OR (status <> 'withdrawn' AND withdrawn_at IS NULL AND withdrawn_by IS NULL AND withdrawn_reason IS NULL)
  ),
  CONSTRAINT client_reports_withdrawn_after_published CHECK (
    withdrawn_at IS NULL OR (published_at IS NOT NULL AND withdrawn_at >= published_at)
  )
);
-- One LIVE row per module report. Partial: NULL defeats UNIQUE (an account summary has no source_id), and a withdrawn
-- row must not block a corrected re-draft of the same source.
CREATE UNIQUE INDEX ux_client_reports_live_source
  ON client_reports (tenant_id, source, source_id)
  WHERE source_id IS NOT NULL AND status <> 'withdrawn';
-- The staff list (one client, every status) and the portal list (published, newest first).
CREATE INDEX ix_client_reports_client_recent
  ON client_reports (tenant_id, client_id, published_at DESC NULLS LAST, created_at DESC);
-- The portal deliverables payload's `reportId` link.
CREATE INDEX ix_client_reports_deliverable
  ON client_reports (tenant_id, deliverable_id) WHERE deliverable_id IS NOT NULL;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 2 · client_report_reads — the read marker
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
CREATE TABLE client_report_reads (
  report_id   uuid NOT NULL,
  tenant_id   uuid NOT NULL REFERENCES companies(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  read_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (report_id, user_id),
  CONSTRAINT fk_client_report_reads_report_tenant FOREIGN KEY (report_id, tenant_id)
    REFERENCES client_reports (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX ix_client_report_reads_user ON client_report_reads (tenant_id, user_id);

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 3 · files.role: the client report's own file
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- ⚠ Re-declared WHOLE. The CURRENT definitions are 202610150300's (PV5-11): roles invoice_pdf, contract_signed_copy,
-- contract_certified_copy, contract_certified_certificate. A DROP+ADD that copied an older list would silently delete
-- values (it happened on live once), so every one of them is restated below, and the DO-block in §5 proves it.
-- `client_report_file` and not `client_report_pdf`: search delivery renders Markdown (text/markdown), not a PDF.
ALTER TABLE files DROP CONSTRAINT files_role_check;
ALTER TABLE files DROP CONSTRAINT files_role_target;
ALTER TABLE files
  ADD CONSTRAINT files_role_check CHECK (
    role IS NULL OR role IN ('invoice_pdf', 'contract_signed_copy', 'contract_certified_copy', 'contract_certified_certificate',
                             'client_report_file')
  ),
  ADD CONSTRAINT files_role_target CHECK (
    role IS NULL
    OR (role = 'invoice_pdf' AND target_entity_type = 'invoice')
    OR (role IN ('contract_signed_copy', 'contract_certified_copy', 'contract_certified_certificate') AND target_entity_type = 'contract')
    OR (role = 'client_report_file' AND target_entity_type = 'client_report')
  );

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 4 · RLS + grants for the two new tables
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['client_reports', 'client_report_reads'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I FOR ALL
        USING (tenant_id = ANY(string_to_array(NULLIF(current_setting('app.current_tenant_ids', true), ''), ',')::uuid[]))
        WITH CHECK (tenant_id = ANY(string_to_array(NULLIF(current_setting('app.current_tenant_ids', true), ''), ',')::uuid[]))
    $f$, t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platform_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO platform_app', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sync_app') THEN
      EXECUTE format('REVOKE ALL ON %I FROM sync_app', t);
    END IF;
  END LOOP;
END $$;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 5 · IAM seed: the `client_report` kind (PERMISSION-CONTRACT §46)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- A new Cerbos kind costs six coupled artifacts; this is #5. The others, all in the same change:
--   1. cerbos/policies/resource_client_report.yaml (+ 1 perm_client_report_read derived role in derived_roles.yaml)
--   2. src/rbac/cerbos.ts            — `ownerUserId` added to Resource AND to the resourcePayload() allow-list
--   3. src/rbac/permission-catalog.json  — the 4 keys + _meta counts (111 kinds / 479 pairs / 464 grantable)
--   4. src/rbac/permission-groups.json   — 1 group (`client_reports`) + _meta counts
--   6. scripts/generate-role-bundles.mjs (NO resolver change: the kind names only direct roles, which DIRECT already
--      maps) and src/rbac/role-permission-bundles.json regenerated.
--
-- ── WHICH REACH IS SEEDED (a mechanical transcription of the policy's role-arm ALLOW rules) ──────
--   platform_admin   — all 4 keys (its Cerbos wildcard; 0094's methodology materialises an explicit row per key)
--   company_admin, owner, manager — read, draft, publish, withdraw (owner MUST mirror company_admin exactly:
--                      owner-role.db.test.ts; a new company_admin key does NOT propagate to owner on its own)
--   member           — read; draft, publish and withdraw as SELF-SCOPED pairs (the client's owner, `ownerUserId`)
--   viewer           — read
--   everything else (client, org_unit_lead, module tiers, ...) — NOTHING. Portal reads go through `portal · read`.
--
-- ── SENSITIVE ─────────────────────────────────────────────────────────────────────────────────
-- `publish` and `withdraw` ARE sensitive, like `core.meeting_recording.share_minutes` (PV4-05): they put words and
-- figures in front of a client, or take them back, and a named person answers for that. `read` and `draft` are not.
INSERT INTO permissions (id, key, module_key, resource, action, description,
                         cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
SELECT gen_random_uuid(), v.key, v.module_key, v.resource, v.action, v.description,
       v.cerbos_kind, v.cerbos_action, v.class, v.sensitive, v.ui_grantable
FROM (VALUES
  ('core.client_report.read', 'core', 'client_report', 'read',
   'View the reports published (or drafted) for a client: social and search reports, the account summary, their files and who has opened them. Same reach as reading clients.',
   'client_report', 'read', 'grantable', false, true),
  ('core.client_report.draft', 'core', 'client_report', 'draft',
   'Draft a report for a client (nothing reaches the client until it is published). Also reached, by Cerbos rule, by the client''s owner.',
   'client_report', 'draft', 'grantable', false, true),
  ('core.client_report.publish', 'core', 'client_report', 'publish',
   'Publish a drafted report to the client''s portal, where the client''s contacts read and download it. Also reached, by Cerbos rule, by the client''s owner. Refused to bot and automation principals by a Cerbos DENY: an agent may draft, a person publishes.',
   'client_report', 'publish', 'grantable', true, true),
  ('core.client_report.withdraw', 'core', 'client_report', 'withdraw',
   'Withdraw a published report from the client''s portal, with a reason. Also reached, by Cerbos rule, by the client''s owner. Refused to bot and automation principals by a Cerbos DENY.',
   'client_report', 'withdraw', 'grantable', true, true)
) AS v(key, module_key, resource, action, description, cerbos_kind, cerbos_action, class, sensitive, ui_grantable)
WHERE NOT EXISTS (SELECT 1 FROM permissions p WHERE p.key = v.key);

INSERT INTO role_permissions (role_id, permission_id, self_scoped)
SELECT r.id, p.id, bundle.self_scoped
FROM (
  -- the full-reach tier: every key (company_admin's reach, mirrored exactly by owner)
  SELECT f.role_name, k.perm_key, false AS self_scoped
    FROM (VALUES ('platform_admin'), ('company_admin'), ('owner'), ('manager')) AS f(role_name)
   CROSS JOIN (VALUES
     ('core.client_report.read'), ('core.client_report.draft'), ('core.client_report.publish'),
     ('core.client_report.withdraw')
   ) AS k(perm_key)
  UNION ALL
  SELECT 'member', 'core.client_report.read', false
  UNION ALL
  SELECT 'viewer', 'core.client_report.read', false
  UNION ALL
  -- the client's OWNER drafts, publishes and withdraws their own client's reports: the self-scoped pairs
  SELECT 'member', 'core.client_report.draft', true
  UNION ALL
  SELECT 'member', 'core.client_report.publish', true
  UNION ALL
  SELECT 'member', 'core.client_report.withdraw', true
) AS bundle(role_name, perm_key, self_scoped)
JOIN roles r ON r.company_id IS NULL AND r.name = bundle.role_name
JOIN permissions p ON p.key = bundle.perm_key
ON CONFLICT (role_id, permission_id) DO UPDATE SET self_scoped = EXCLUDED.self_scoped;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- 6 · Assert, don't assume (202608310900's discipline)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  expected record;
  got integer;
  def text;
  r text;
BEGIN
  -- ── the files CHECKs kept EVERY earlier role and gained the new one ────────────────────────────
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid = 'files'::regclass AND conname = 'files_role_check';
  IF def IS NULL THEN
    RAISE EXCEPTION '202610151720: files_role_check is missing';
  END IF;
  FOREACH r IN ARRAY ARRAY['invoice_pdf', 'contract_signed_copy', 'contract_certified_copy', 'contract_certified_certificate',
                           'client_report_file'] LOOP
    IF position(quote_literal(r) IN def) = 0 THEN
      RAISE EXCEPTION '202610151720: files_role_check lost or never gained role % (definition: %)', r, def;
    END IF;
  END LOOP;
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid = 'files'::regclass AND conname = 'files_role_target';
  IF def IS NULL THEN
    RAISE EXCEPTION '202610151720: files_role_target is missing';
  END IF;
  FOREACH r IN ARRAY ARRAY['invoice_pdf', 'contract_signed_copy', 'contract_certified_copy', 'contract_certified_certificate',
                           'client_report_file', 'invoice', 'contract', 'client_report'] LOOP
    IF position(quote_literal(r) IN def) = 0 THEN
      RAISE EXCEPTION '202610151720: files_role_target lost or never gained % (definition: %)', r, def;
    END IF;
  END LOOP;
  -- The earlier guards this file builds beside, never replaces.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'files'::regclass AND conname = 'files_role_has_content') THEN
    RAISE EXCEPTION '202610151720: files_role_has_content is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_files_guard_role_file' AND NOT tgisinternal) THEN
    RAISE EXCEPTION '202610151720: trigger trg_files_guard_role_file is missing';
  END IF;

  -- ── the two tables: FORCE RLS and the tenant policy ───────────────────────────────────────────
  FOREACH r IN ARRAY ARRAY['client_reports', 'client_report_reads'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = r AND relrowsecurity AND relforcerowsecurity) THEN
      RAISE EXCEPTION '202610151720: % is not ENABLE + FORCE row level security', r;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = r AND policyname = 'tenant_isolation') THEN
      RAISE EXCEPTION '202610151720: tenant_isolation policy missing on %', r;
    END IF;
  END LOOP;
  FOREACH r IN ARRAY ARRAY['client_reports_published_stamps', 'client_reports_withdrawn_stamps', 'client_reports_source_id_required',
                           'client_reports_period_order', 'client_reports_title_nonblank', 'client_reports_withdrawn_after_published',
                           'fk_client_reports_project_client_tenant', 'fk_client_reports_file_tenant'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'client_reports'::regclass AND conname = r) THEN
      RAISE EXCEPTION '202610151720: constraint % is missing on client_reports', r;
    END IF;
  END LOOP;
  SELECT indexdef INTO def FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ux_client_reports_live_source';
  IF def IS NULL OR def NOT LIKE 'CREATE UNIQUE INDEX%' OR def NOT LIKE '%WHERE%' THEN
    RAISE EXCEPTION '202610151720: ux_client_reports_live_source is missing or is not a partial UNIQUE index';
  END IF;

  -- ── the IAM seed ─────────────────────────────────────────────────────────────────────────────
  SELECT count(*) INTO got FROM permissions
   WHERE cerbos_kind = 'client_report' AND class = 'grantable' AND module_key = 'core' AND ui_grantable = true;
  IF got <> 4 THEN
    RAISE EXCEPTION '202610151720: expected 4 grantable, ui_grantable client_report permissions, found %', got;
  END IF;
  SELECT count(*) INTO got FROM permissions
   WHERE cerbos_kind = 'client_report' AND sensitive AND action IN ('publish', 'withdraw');
  IF got <> 2 THEN
    RAISE EXCEPTION '202610151720: publish and withdraw must both be sensitive (found %)', got;
  END IF;
  SELECT count(*) INTO got FROM permissions
   WHERE cerbos_kind = 'client_report' AND sensitive AND action NOT IN ('publish', 'withdraw');
  IF got <> 0 THEN
    RAISE EXCEPTION '202610151720: % unexpected sensitive client_report permission(s)', got;
  END IF;

  FOR expected IN
    SELECT * FROM (VALUES
      ('platform_admin', 4), ('company_admin', 4), ('owner', 4), ('manager', 4),
      ('member', 4), ('viewer', 1),
      ('client', 0), ('org_unit_lead', 0), ('group_executive', 0), ('webdev_staff', 0), ('webdev_manager', 0), ('hr_manager', 0)
    ) AS x(role_name, expected_count)
  LOOP
    SELECT count(*) INTO got
      FROM role_permissions rp
      JOIN roles r2 ON r2.id = rp.role_id
      JOIN permissions p ON p.id = rp.permission_id
     WHERE r2.company_id IS NULL AND r2.name = expected.role_name
       AND p.cerbos_kind = 'client_report';
    IF got <> expected.expected_count THEN
      RAISE EXCEPTION '202610151720: role "%": expected % bundled client_report permission(s), found % (missing/typo''d role name or key, or a prior partial application)',
        expected.role_name, expected.expected_count, got;
    END IF;
  END LOOP;

  -- A viewer only reads.
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r2 ON r2.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r2.company_id IS NULL AND r2.name = 'viewer'
     AND p.cerbos_kind = 'client_report' AND p.action <> 'read';
  IF got <> 0 THEN
    RAISE EXCEPTION '202610151720: viewer holds % non-read client_report permission(s)', got;
  END IF;

  -- The self-scoped marker: exactly member·draft, member·publish and member·withdraw, and nothing else on this kind.
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r2 ON r2.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r2.company_id IS NULL AND p.cerbos_kind = 'client_report' AND rp.self_scoped
     AND NOT (r2.name = 'member' AND p.action IN ('draft', 'publish', 'withdraw'));
  IF got <> 0 THEN
    RAISE EXCEPTION '202610151720: % unexpected self_scoped client_report row(s)', got;
  END IF;
  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r2 ON r2.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r2.company_id IS NULL AND r2.name = 'member'
     AND p.cerbos_kind = 'client_report' AND p.action IN ('draft', 'publish', 'withdraw') AND rp.self_scoped;
  IF got <> 3 THEN
    RAISE EXCEPTION '202610151720: member·draft, member·publish and member·withdraw must all be self_scoped (found %)', got;
  END IF;

  -- owner ≡ company_admin over the kind, in BOTH directions (equal counts alone would not catch the wrong keys).
  SELECT count(*) INTO got FROM (
    (SELECT p.key FROM role_permissions rp
       JOIN roles r2 ON r2.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r2.company_id IS NULL AND r2.name = 'owner' AND p.cerbos_kind = 'client_report'
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r2 ON r2.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r2.company_id IS NULL AND r2.name = 'company_admin' AND p.cerbos_kind = 'client_report')
    UNION ALL
    (SELECT p.key FROM role_permissions rp
       JOIN roles r2 ON r2.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r2.company_id IS NULL AND r2.name = 'company_admin' AND p.cerbos_kind = 'client_report'
     EXCEPT
     SELECT p.key FROM role_permissions rp
       JOIN roles r2 ON r2.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r2.company_id IS NULL AND r2.name = 'owner' AND p.cerbos_kind = 'client_report')
  ) diff;
  IF got <> 0 THEN
    RAISE EXCEPTION '202610151720: owner''s client_report bundle diverges from company_admin''s by % key(s) — owner-role.db.test.ts will fail', got;
  END IF;

  SELECT count(*) INTO got
    FROM role_permissions rp
    JOIN roles r2 ON r2.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
   WHERE r2.company_id IS NULL AND p.cerbos_kind = 'client_report';
  IF got <> 21 THEN
    RAISE EXCEPTION '202610151720: total bundled client_report permissions on global roles: expected 21 (4x4 + 4 + 1), found %', got;
  END IF;

  RAISE NOTICE '202610151720: client_reports + client_report_reads created; files role client_report_file added; % client_report role rows', got;
END $$;

COMMENT ON TABLE client_reports IS
  'PV7-04a (BFF §55): a report published (or drafted) for a client to read in the portal. draft -> published -> withdrawn. Reach: clientReportInPortalScope in platform-nest/src/core/portal-visibility.ts.';
COMMENT ON TABLE client_report_reads IS
  'PV7-04a (BFF §55): the first time a client-side user opened a published report (the portal''s New marker).';
