-- 202610101730_webdev_site_builds.sql — WSK-60, the publish → rebuild → staging ledger.
-- Design: docs/plans/2026-10-10-webdesk-write-plane-design.md §9 (Decision G) and §12 WSK-60.
--
-- ── NUMBERING (migrations/README.md — timestamp scheme) ─────────────────────────────────────────
-- `ls migrations | sort | tail` immediately before writing this file showed the head as
-- `202610101500_automation_approvals_origin_webdesk.sql`. This takes a later minute.
--
-- ── WHAT THESE TABLES ARE FOR ───────────────────────────────────────────────────────────────────
-- A publish approval executed in the ERP (WSK-66) dispatches ONE GitHub Actions run in the site repo.
-- `webdev_site_builds` is the honest record of that run, so the editor can say what is true:
--
--   rebuilding  the dispatch was accepted and the staging stamp has not yet shown the content
--   live        `dist/webdesk-build.json` on the staging site proved the content is there
--   unverified  the 20-minute poll window closed without the stamp proving it. NEVER "live".
--   failed      the dispatch itself did not happen; `failure_reason` is the typed token why
--
-- `live` is reachable ONLY through a verified stamp (CHECK below: live ⇒ verified_at). `failed` always
-- names its reason (CHECK below). Nothing in this table is a credential and none of it drives a
-- privileged transition: the approval that authorised the run is recorded, not re-executed.
--
-- ── IDEMPOTENCY ─────────────────────────────────────────────────────────────────────────────────
-- `UNIQUE (tenant_id, approval_id)`: one build per approval. The executor already claims an approval
-- exactly once, but this is the second lock: a duplicated hook call can insert nothing twice, and the
-- caller dispatches only when its INSERT won. `approval_id` is nullable for a future non-approval
-- trigger (the editor's wire shape is `approvalId | null`); NULLs do not collide under UNIQUE.
--
-- ── RLS WALL — THIRD WALL ───────────────────────────────────────────────────────────────────────
-- The same shape as `webdev_zoneb_event_log` (202608261440) and `webdev_provisioned_sites` (0090):
-- `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('webdev')`, FORCE RLS. Every access
-- path (the build-status controller, the dispatch hook in the approval executor, the poller) runs
-- inside the webdev module scope. `app_module_allowed(text)` is defined once in 0028 and only
-- REFERENCED here.
--
-- ── ZERO BACKFILL DML ───────────────────────────────────────────────────────────────────────────
-- Two brand-new tables, CREATE TABLE only. No UPDATE, DELETE or INSERT anywhere in this file (the
-- NOBYPASSRLS-backfill and CI-superuser-masks-RLS traps have nothing to bite).

CREATE TABLE webdev_site_builds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  -- The WebDesk tenant slug and site id the publish named (opaque here; Zone B owns them).
  tenant_slug text NOT NULL,
  site_id uuid NOT NULL,
  -- The WS4 approval that authorised this build (R3: one decision covers publish AND rebuild).
  approval_id uuid,
  kind text NOT NULL CHECK (kind IN ('publish', 'rebuild')),
  state text NOT NULL DEFAULT 'rebuilding' CHECK (state IN ('rebuilding', 'live', 'unverified', 'failed')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  -- When GitHub accepted the dispatch (the poll window and the rebuild-kind proof both start here).
  -- NULL while the dispatch is in flight and for a build that never dispatched.
  dispatched_at timestamptz,
  -- The newest publishedAt Zone B reported for the publish. NULL for a rebuild, and for a publish whose
  -- answer was lost (reconciled by reading): the stamp check then falls back to dispatched_at.
  published_at timestamptz,
  -- What was dispatched: auditable without joining the GitHub ledger.
  repo text,
  ref text,
  -- GH-04's correlation id: the `attempted` row in `activities` (verb github.deploy) for this dispatch.
  github_correlation_id uuid,
  staging_url text,
  verified_at timestamptz,
  -- The last stamp seen (evidence, not authority).
  last_stamp_pulled_at timestamptz,
  last_stamp_max_updated_at timestamptz,
  last_polled_at timestamptz,
  poll_count integer NOT NULL DEFAULT 0 CHECK (poll_count >= 0),
  -- Who authorised it: the DECIDER of the approval (the human whose `deploy` right was checked).
  decided_by uuid REFERENCES users(id),
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Typed token, never free text: it is rendered, logged and compared by name.
  CONSTRAINT wsb_failure_reason_token CHECK (failure_reason IS NULL OR failure_reason ~ '^[a-z0-9_]{1,64}$'),
  -- A failed build says why; a build that is not failed says nothing.
  CONSTRAINT wsb_failed_has_reason CHECK ((state = 'failed') = (failure_reason IS NOT NULL)),
  -- "live" is unreachable without a verification timestamp.
  CONSTRAINT wsb_live_is_verified CHECK ((state = 'live') = (verified_at IS NOT NULL)),
  -- unverified and live both mean a dispatch happened (rebuilding is allowed without one: it is the
  -- brief window between claiming the row and GitHub's answer).
  CONSTRAINT wsb_dispatched_for_poll_outcomes CHECK (state IN ('failed', 'rebuilding') OR dispatched_at IS NOT NULL),
  CONSTRAINT ux_wsb_tenant_approval UNIQUE (tenant_id, approval_id)
);

-- The editor's read: newest build for a site.
CREATE INDEX ix_wsb_site_requested ON webdev_site_builds (tenant_id, site_id, requested_at DESC);
-- The poller's read: only rows still waiting on a stamp.
CREATE INDEX ix_wsb_rebuilding ON webdev_site_builds (tenant_id, requested_at) WHERE state = 'rebuilding';

COMMENT ON TABLE webdev_site_builds IS
  'WSK-60: one row per staging rebuild dispatched (or refused) for a WebDesk publish/rebuild approval. '
  'live only via a verified dist/webdesk-build.json stamp; unverified after the 20 min poll window; '
  'failed carries a typed failure_reason. UNIQUE (tenant_id, approval_id) makes the dispatch at-most-once. '
  'THIRD WALL RLS (app_module_allowed(''webdev'') + app_current_tenants()).';

ALTER TABLE webdev_site_builds ENABLE ROW LEVEL SECURITY;
ALTER TABLE webdev_site_builds FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON webdev_site_builds;
CREATE POLICY tenant_isolation ON webdev_site_builds FOR ALL
  USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('webdev'))
  WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('webdev'));

-- ── The "staging is stale" marker ───────────────────────────────────────────────────────────────
-- An unpublish or delete has no approval and no rebuild of its own (design §9, "Unpublish and delete").
-- The editor shows "the staging site drops it at the next rebuild" while this marker is set. The writer
-- of the unpublish/delete (WSK-59) calls SiteBuildsService.noteStagingStale(); a build DISPATCHED after
-- `stale_since` that reaches `live` clears it. One row per site.
CREATE TABLE webdev_site_staging_marks (
  tenant_id uuid NOT NULL REFERENCES companies(id),
  site_id uuid NOT NULL,
  stale_since timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, site_id)
);

COMMENT ON TABLE webdev_site_staging_marks IS
  'WSK-60: set when content was taken down (unpublish/delete) and cleared when a rebuild dispatched after '
  'that instant is verified live. Drives the editor''s stagingStale flag. THIRD WALL RLS.';

ALTER TABLE webdev_site_staging_marks ENABLE ROW LEVEL SECURITY;
ALTER TABLE webdev_site_staging_marks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON webdev_site_staging_marks;
CREATE POLICY tenant_isolation ON webdev_site_staging_marks FOR ALL
  USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('webdev'))
  WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('webdev'));
