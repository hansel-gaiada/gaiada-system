-- 202608261440_webdev_zoneb_event_log.sql — WSK-12, the Zone A consumer half of the WebDesk
-- B->A signed-events channel. Design: docs/blueprints/webdesk-design.md §03 (channel 1 — signed
-- fact webhooks), §04 (this table's sketch), §10 (the `wd-zoneb-intake` n8n flow this table
-- backs).
--
-- ── NUMBERING (migrations/README.md — the timestamp scheme; WSK-D21) ───────────────────────────
-- `date -u +%Y%m%d%H%M` at authoring time. `ls migrations | sort | tail` immediately before
-- writing this file showed the real head as `202608261100_activity_approval_attribution.sql`; no
-- coordination needed under the current rule, and this migration creates no table name any other
-- in-flight session would plausibly also be creating.
--
-- ── WHAT THIS TABLE IS FOR (§03/§04) ────────────────────────────────────────────────────────────
-- The idempotency ledger for facts Zone B (the internet-facing WebDesk platform) reports about
-- itself over the ONE outbound channel it is allowed: an HMAC-signed webhook into the n8n bridge.
-- `UNIQUE (tenant_id, event_id)` IS the idempotency key — a retried or duplicated delivery of the
-- same Zone B event upserts nothing twice. `payload` carries a SCHEMA-VALIDATED SLIM PROJECTION
-- only, never the raw webhook blob (§04's own comment) — the n8n flow's schema-check step is what
-- keeps that true before a row ever reaches this table.
--
-- ── THE SECURITY INVARIANT THIS TABLE ENFORCES BY WHAT IT DOES NOT HAVE (§03, non-negotiable) ──
-- No column here can drive a privileged transition. There is no `status` this row moves, no FK a
-- deploy/promote/key/schema path reads, and no trigger. The worst a forged, replayed, or mutated
-- Zone B webhook can do — even one that reaches this table by some future bug in the n8n flow's
-- own HMAC/schema gates — is occupy an idempotency slot and sit here as an inert fact. A forged
-- fact is noise, not authority: every privileged command in this program originates in Zone A
-- behind WS4, never from a fact row.
--
-- ── RLS WALL DECISION — THIRD WALL, same reasoning 0090 (`webdev_provisioned_sites`) already
--    wrote for the sibling `webdev` module ─────────────────────────────────────────────────────
-- Nothing portal- or core-scoped ever touches this table: every access path (the intake
-- controller this migration backs, and any future Sites-tab read model) runs inside the
-- `webdev` ModuleContract shell (PRV-02's shell, additively extended — see
-- `platform-nest/src/modules/webdev/index.ts`'s own header on shared-shell coordination),
-- behind `ModuleEnabledGuard("webdev")`, calling `withTenants(tenants, { modules: ["webdev"] })`
-- exactly like 0028's hr_*, 0079's assistant_*, and 0090 itself. `app_module_allowed(text)` is
-- defined once in 0028 (CREATE OR REPLACE, GRANT EXECUTE TO PUBLIC) and only REFERENCED here,
-- composed with `app_current_tenants()` (0025) into one `tenant_isolation` policy.
--
-- ── ZERO BACKFILL DML ────────────────────────────────────────────────────────────────────────────
-- Brand-new table, CREATE TABLE only. No ALTER-with-default, UPDATE, DELETE-with-a-row-set, or
-- INSERT ... SELECT anywhere in this file — the NOBYPASSRLS-backfill-silently-no-ops trap
-- (migrations run as `platform_owner` WITHOUT BYPASSRLS against FORCE-RLS tables) has nothing to
-- bite. `npm run lint:migration-rls` has nothing to flag here by construction.
--
-- ── `kind` VOCABULARY — CHECK-enumerated, not open text ─────────────────────────────────────────
-- §04's own listing (`form.received | deploy.done | promote.done | rollback.done |
-- contract.published | alert.raised`) does not end in an ellipsis the way e.g. 0090's
-- `failure_reason` does — read as the intended v1-frozen set, so it is constrained here rather
-- than left as an application-typed token. A future kind is a follow-up migration (widen-only
-- CHECK, same idiom 0028 uses for `automation_approvals.origin`), not a silent schema drift.

CREATE TABLE webdev_zoneb_event_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  -- Zone B's own event id (a uuid it mints per fact) — THE idempotency key, paired with tenant_id
  -- below. Free text, not uuid-typed: Zone B is a separate trust zone (§03) and this column must
  -- never reject a well-formed-but-differently-shaped id with a 500 instead of a clean refusal.
  event_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'form.received', 'deploy.done', 'promote.done', 'rollback.done',
    'contract.published', 'alert.raised'
  )),
  -- Schema-validated SLIM PROJECTION only (§04's own comment) — the n8n flow's schema-check step,
  -- and this migration's own CHECK below, are what keep the raw webhook blob out of this column.
  payload jsonb NOT NULL DEFAULT '{}',
  CONSTRAINT wzel_payload_is_object CHECK (jsonb_typeof(payload) = 'object'),
  received_at timestamptz NOT NULL DEFAULT now(),
  -- Zone B's own site/box identity (e.g. a tenant slug or box name) — opaque here, no cross-zone
  -- FK, same "origin_site: opaque, attribution not authz" treatment every other origin_site column
  -- in this ledger already gets.
  origin_site text NOT NULL,
  CONSTRAINT ux_wzel_tenant_event UNIQUE (tenant_id, event_id)
);

-- The console read-model / "recent WebDesk activity" query shape (§08, future WSK-24): newest
-- facts of a given kind for a tenant. `ux_wzel_tenant_event` above already covers the dedup
-- lookup itself (tenant_id, event_id) — this is the SEPARATE by-kind/recency access path.
CREATE INDEX ix_wzel_tenant_kind_received ON webdev_zoneb_event_log (tenant_id, kind, received_at DESC);

COMMENT ON TABLE webdev_zoneb_event_log IS
  'WSK-12: the Zone A idempotency ledger for facts Zone B (WebDesk) reports over the ONE signed '
  'B->A webhook channel (docs/blueprints/webdesk-design.md §03 channel 1). UNIQUE (tenant_id, '
  'event_id) is the idempotency key. payload is a schema-validated slim projection, never the raw '
  'webhook blob. THIRD WALL RLS (app_module_allowed(''webdev'') + app_current_tenants()), same '
  'shape as 0090''s sibling webdev_provisioned_sites. This table can drive no privileged '
  'transition by construction (§03) — a forged/replayed/mutated fact is noise, not authority.';

-- FORCE RLS, THIRD WALL — composed tenant_isolation policy, byte-identical shape to 0090's own
-- (app_module_allowed defined once in 0028; app_current_tenants defined in 0025; both referenced,
-- not redefined, here).
ALTER TABLE webdev_zoneb_event_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE webdev_zoneb_event_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON webdev_zoneb_event_log;
CREATE POLICY tenant_isolation ON webdev_zoneb_event_log FOR ALL
  USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('webdev'))
  WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('webdev'));
