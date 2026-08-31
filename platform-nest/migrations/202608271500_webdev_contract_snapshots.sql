-- 202608271500_webdev_contract_snapshots.sql — WSK-19, the Zone A end of the ONE-RAIL contract
-- mirror. Design: docs/blueprints/webdesk-design.md §06 ("Zone A end — the mirror"), §04 (this
-- table's sketch, "the ONE-RAIL pin"), §05 (the hash discipline the mirror enforces).
--
-- ── NUMBERING (migrations/README.md — the timestamp scheme; WSK-D21) ───────────────────────────
-- `date -u +%Y%m%d%H%M` at authoring time. `ls migrations | sort | tail` immediately before
-- writing this file showed the real head as `202608271400_iam_webdev_zoneb_event_permissions.sql`
-- (WSK-12's own IAM migration); no coordination needed under the current rule.
--
-- ── WHAT THIS TABLE IS (§04/§06) ─────────────────────────────────────────────────────────────────
-- The pin that makes a scaffolded site's dependency on Zone B's codegen output REPRODUCIBLE and
-- AUDITABLE without Zone A ever executing anything Zone B produced (D-6). One row = one
-- content-addressed contract bundle `code.scaffold` v2 (WSK-20, not this ticket) may pin via
-- `contractSnapshotId` in the FROZEN scaffold envelope (webdev-design §05 / webdesk-design §06).
--
-- ── IMMUTABLE BY CONSTRUCTION — TWO LAYERS, NOT ONE ──────────────────────────────────────────────
-- (1) No UPDATE path in the application: the refresh endpoint (WSK-19's own controller) exposes no
--     PATCH/PUT and never issues an UPDATE against this table. Supersession is always a NEW row —
--     a newer `contract_version` for the same (tenant, slug).
-- (2) A DATABASE TRIGGER, not merely an application convention — same doctrine
--     202608241015_finance_ledger_core.sql's own header states for FINANCE_LEDGER_IMMUTABLE
--     ("not a convention, not a service-layer rule — a trigger. Applies to everyone the app role
--     can be: there is no admin-override path"). `webdev_contract_snapshot_immutable()` refuses
--     UPDATE and DELETE unconditionally; a superuser with psql can still drop the trigger, and that
--     is the same honest boundary the finance ledger accepts.
--
-- ── THE HASH DISCIPLINE THIS TABLE PINS (§05/§06) ───────────────────────────────────────────────
-- `content_hash` is `contentHash` from §05: sha256 over a CANONICAL MANIFEST of per-artifact
-- sha256 hashes (sorted keys, no timestamp in the hashed body). The mirror's own service
-- (contract-snapshot.service.ts) recomputes this from the DOWNLOADED bytes and refuses loudly on:
--   (a) a mismatch against Zone B's claimed contentHash in the /control/v1/tenants/:slug/contract
--       response — transport corruption;
--   (b) an existing (tenant_id, webdesk_tenant_slug, contract_version) row whose recomputed hash
--       DIFFERS from what is already stored — a codegen DETERMINISM BREACH (the double-run CI gate
--       failed to catch it, or Zone B's generator drifted between two "same version" fetches).
-- Neither refusal is a DDL concern — both are application-layer checks BEFORE the INSERT this
-- table's UNIQUE constraint would otherwise happily accept as a legitimate first row for that
-- version. The UNIQUE constraint's OWN job is narrower and mechanical: it is what turns a
-- same-version, same-hash re-fetch into an honest idempotent 200 rather than a duplicate row.
--
-- ── THIRD WALL RLS — byte-identical shape to the sibling webdev_zoneb_event_log
--    (202608261440), which itself matches 0028's hr_*/0090's webdev_provisioned_sites ─────────────
-- Every access to this table runs inside the `webdev` ModuleContract shell
-- (platform-nest/src/modules/webdev/index.ts, extended additively by this ticket), behind
-- `ModuleEnabledGuard("webdev")`, calling `withTenants(tenants, { modules: ["webdev"] })`.
-- `app_module_allowed(text)` is defined once in 0028 (CREATE OR REPLACE, GRANT EXECUTE TO PUBLIC)
-- and only REFERENCED here, composed with `app_current_tenants()` (0025) into one
-- `tenant_isolation` policy. A caller that forgets `{modules:['webdev']}` reads/writes ZERO ROWS
-- silently (the WD-23A-1 two-sided handshake) rather than erroring — the failure mode every
-- sibling migration in this family documents identically.
--
-- ── ZERO BACKFILL DML ────────────────────────────────────────────────────────────────────────────
-- Brand-new table, CREATE TABLE + trigger DDL only. No ALTER-with-default, UPDATE, DELETE, or
-- INSERT anywhere in this file — the NOBYPASSRLS-backfill-silently-no-ops trap has nothing to bite,
-- and `npm run lint:migration-rls` has nothing to flag by construction.

CREATE TABLE webdev_contract_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  -- Zone B `tenants.slug` this contract belongs to (§04's own comment: "Zone B tenants.slug this
  -- contract belongs to"). Free text, not FK'd — Zone B is a separate trust zone/database (§03) and
  -- this column must never reject a well-formed-but-unrecognized slug with a 500.
  webdesk_tenant_slug text NOT NULL,
  -- Tenant contract semver (§05's "Tenant contract semver" row) — what a scaffolded site pins.
  contract_version text NOT NULL,
  -- Vocabulary semver the codegen ran against (§05's "Vocabulary semver" row) — the OTHER axis a
  -- pin must be auditable against (§05's governance rule: "Snapshot rows carry vocabulary_version
  -- so every pin is auditable against both axes").
  vocabulary_version text NOT NULL,
  -- sha256 over the canonical per-artifact-hash manifest (§05/§06). "sha256:<64 hex>" — the same
  -- prefixed form Zone B's /control/v1/tenants/:slug/contract response uses, so a stored value and
  -- a freshly-claimed value are byte-comparable with no normalization step to get wrong.
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  -- { sdkTs: <filesId>, sdkPhp: <filesId>|null (P6, D-10), openapi: <filesId>, contractMd: <filesId>,
  --   hashes: {perArtifact sha256}, blockLibrary: {package, version, range} } — §04's own shape.
  artifacts jsonb NOT NULL,
  CONSTRAINT wcs_artifacts_is_object CHECK (jsonb_typeof(artifacts) = 'object'),
  -- Who (or what — the automation identity, WSK-31) triggered this refresh. Nullable: a system/
  -- automation-triggered refresh may have no ERP user id, same treatment `files.uploader_id` and
  -- `webdev_provisioned_sites.requested_by` already give an optional actor.
  fetched_by uuid REFERENCES users(id),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  origin_site text NOT NULL,
  CONSTRAINT ux_wcs_tenant_slug_version UNIQUE (tenant_id, webdesk_tenant_slug, contract_version)
);

-- The Contract card's own read shape (§08, WSK-24, not built yet): "pinned contract@X.Y vs latest
-- published, per site" — newest snapshot first, per (tenant, slug). The UNIQUE constraint above
-- already covers the idempotency/determinism lookup (tenant_id, webdesk_tenant_slug,
-- contract_version); this is the separate by-recency access path.
CREATE INDEX ix_wcs_tenant_slug_fetched ON webdev_contract_snapshots (tenant_id, webdesk_tenant_slug, fetched_at DESC);

COMMENT ON TABLE webdev_contract_snapshots IS
  'WSK-19: the Zone A end of the one-rail contract mirror (docs/blueprints/webdesk-design.md §06). '
  'IMMUTABLE by construction (no UPDATE path in the app + trg_webdev_contract_snapshots_immutable). '
  'UNIQUE (tenant_id, webdesk_tenant_slug, contract_version) is the idempotency key; content_hash is '
  'recomputed and verified against Zone B''s claim on every refresh, and a differing hash on an '
  'EXISTING version is a codegen determinism breach, not an ordinary conflict. THIRD WALL RLS '
  '(app_module_allowed(''webdev'') + app_current_tenants()), same shape as the sibling '
  'webdev_zoneb_event_log (202608261440) and webdev_provisioned_sites (0090).';

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- IMMUTABILITY. A trigger, not a convention — same doctrine as FINANCE_LEDGER_IMMUTABLE
-- (202608241015_finance_ledger_core.sql). Applies to everyone the app role can be; there is no
-- "admin override" path, because the value of a content-addressed audit pin is precisely that no
-- such path exists. A superuser with psql can still drop the trigger — the honest boundary every
-- sibling immutability trigger in this repo accepts.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION webdev_contract_snapshot_immutable()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'WEBDEV_CONTRACT_SNAPSHOT_IMMUTABLE: % on %.% is forbidden — a fetched contract snapshot is never edited or deleted',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING HINT = 'Supersede it with a NEW row (a newer contract_version) — see webdesk-design.md §06.';
END $$;

CREATE TRIGGER trg_webdev_contract_snapshots_immutable
  BEFORE UPDATE OR DELETE ON webdev_contract_snapshots
  FOR EACH ROW EXECUTE FUNCTION webdev_contract_snapshot_immutable();

-- THIRD WALL RLS — composed tenant_isolation policy, byte-identical shape to
-- 202608261440_webdev_zoneb_event_log.sql's own (app_module_allowed defined once in 0028;
-- app_current_tenants defined in 0025; both referenced, not redefined, here).
ALTER TABLE webdev_contract_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE webdev_contract_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON webdev_contract_snapshots;
CREATE POLICY tenant_isolation ON webdev_contract_snapshots FOR ALL
  USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('webdev'))
  WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('webdev'));
