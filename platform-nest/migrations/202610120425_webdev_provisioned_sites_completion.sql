-- 202610120425_webdev_provisioned_sites_completion.sql
--
-- M6-P4c (docs/plans/2026-10-11-webdesk-m6-plan.md) — provisioning finishes webdesk-design-v2.md §08:
-- "A signed PRD (automation) or a staff button (manual) yields: a private GitHub repo from a per-kind
-- template, the right folder structure inside it, a `webdev_sites` row, and a Zone B tenant with a pinned
-- contract — with idempotency and crash-resume". Until this migration the mirror table recorded only the
-- repo step. These columns record the three steps that follow it, so each one is resumable after a crash
-- and none can run twice. The state machine itself is written out at the top of
-- `src/modules/webdev/provision-completion.ts`; this file is its schema half.
--
-- ── WHAT THIS ADDS (every step additive; no existing column, CHECK, index or policy is touched) ──────
--   completion_state      NULL (not begun) | 'registered' | 'tenant_ready' | 'complete'. Monotone: the
--                         service only ever moves it forward, with a WHERE on the previous value.
--   webdev_site_id        the `webdev_sites` row this provisioning created (or adopted). Composite FK on
--                         (webdev_site_id, tenant_id) to `webdev_sites`' own `ux_webdev_sites_id_tenant`,
--                         so a provisioned row can never point at another company's registry row.
--   webdesk_tenant_slug   the WebDesk tenant created for the site (= the provisioned slug).
--   contract_snapshot_id  the pinned `webdev_contract_snapshots` row (immutable, content-addressed).
--   completion_error      the last typed reason a step could not finish (cleared when a step succeeds).
--                         A token, never a response body.
--   completion_updated_at when completion_state or completion_error last moved.
--
-- ── THE INVARIANTS ARE IN THE SCHEMA, NOT ONLY IN THE SERVICE ─────────────────────────────────────────
-- wps_completion_links: a state can only be recorded together with the link it implies (registered needs
-- the registry row, tenant_ready the tenant, complete the snapshot). ux_wps_webdev_site: one registry row
-- is claimed by at most one provisioned row, the structural backstop for the service's "adopt only if
-- ours" check on a registry conflict (the same two-layer shape as 0090's ux_wps_run / ux_wps_slug).
--
-- ── RLS ──────────────────────────────────────────────────────────────────────────────────────────────
-- No new table. webdev_provisioned_sites already has ENABLE + FORCE ROW LEVEL SECURITY and the third wall
-- (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('webdev')) from 0090; new columns inherit it.
--
-- ── ZERO BACKFILL DML ────────────────────────────────────────────────────────────────────────────────
-- Every existing row gets completion_state NULL, which satisfies every new CHECK. An ERP repo control row
-- (provider 'erp_repo') provisioned before this migration starts its completion on its next reconcile,
-- exactly like a new one; mirror rows of the decommissioned `provision` host (provider 'provision') never
-- begin one on their own (the service's rule, provision-completion.ts).
--
-- ROLLOUT: no reader depends on the columns; the service writes them from the first reconcile after
-- deploy. To undo: DROP the index, the two constraints and the six columns.
ALTER TABLE webdev_provisioned_sites
  ADD COLUMN IF NOT EXISTS completion_state text
    CHECK (completion_state IN ('registered', 'tenant_ready', 'complete')),
  ADD COLUMN IF NOT EXISTS webdev_site_id uuid,
  ADD COLUMN IF NOT EXISTS webdesk_tenant_slug text,
  ADD COLUMN IF NOT EXISTS contract_snapshot_id uuid REFERENCES webdev_contract_snapshots (id),
  ADD COLUMN IF NOT EXISTS completion_error text,
  ADD COLUMN IF NOT EXISTS completion_updated_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'webdev_provisioned_sites'::regclass AND conname = 'fk_wps_webdev_site_tenant'
  ) THEN
    ALTER TABLE webdev_provisioned_sites
      ADD CONSTRAINT fk_wps_webdev_site_tenant
      FOREIGN KEY (webdev_site_id, tenant_id) REFERENCES webdev_sites (id, tenant_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'webdev_provisioned_sites'::regclass AND conname = 'wps_completion_links'
  ) THEN
    ALTER TABLE webdev_provisioned_sites
      ADD CONSTRAINT wps_completion_links CHECK (
        (completion_state IS NULL OR webdev_site_id IS NOT NULL)
        AND (completion_state IS NULL OR completion_state = 'registered' OR webdesk_tenant_slug IS NOT NULL)
        AND (completion_state IS DISTINCT FROM 'complete' OR contract_snapshot_id IS NOT NULL)
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_wps_webdev_site
  ON webdev_provisioned_sites (webdev_site_id) WHERE webdev_site_id IS NOT NULL;

COMMENT ON COLUMN webdev_provisioned_sites.completion_state IS
  'M6-P4c, §08: NULL = not begun (the repo step is still running, or has not reached provisioned/live) | '
  'registered = the webdev_sites row exists (webdev_site_id) | tenant_ready = the WebDesk tenant exists '
  '(webdesk_tenant_slug) | complete = the first contract snapshot is pinned (contract_snapshot_id). '
  'Monotone; each step is idempotent and resumed by the next reconcile.';
