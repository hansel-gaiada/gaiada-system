-- 202610270910_webdev_site_dns_tasks.sql — M6-P6p (WSK-D89 (4), answering O-12): the DNS records of a delivered domain become
-- ONE PM task a Web Dev person completes, and the ERP's own read-only DNS check (domain-dns.ts) closes it when they point.
-- The code is src/modules/webdev/domain-dns-task.service.ts.
--
-- ── NUMBERING (migrations/README.md, timestamp scheme) ──────────────────────────────────────────
-- Head before this file: 202610261100_client_invites_delivery.sql. This takes a later minute.
--
-- ── WHAT THIS TABLE IS ──────────────────────────────────────────────────────────────────────────
-- The LINK between a registry row (`webdev_sites`) and the `pm_tasks` row created through the PM module's own
-- `createPmTaskInTx` (no second task store). One row per (site, domain) task, open or closed:
--   state 'open'   exactly one per site (ux_wsdt_one_open_per_site): re-running the flow UPDATES this row and its task
--   state 'closed' history: `closed_by` says why (erp_check | manual | domain_changed | site_archived)
-- The records are stored as the typed list the checklist derived (type, name, target): public facts about where a domain
-- should point, never a credential. NO DNS credential and NO DNS API exists anywhere (WSK-D43/D61, O-12).
--
-- `erp_saw_pointing` is what the last ERP check saw; a task a person completes by hand while it is false is recorded as
-- `manual` with `erp_saw_pointing = false`, i.e. "completed by hand, the ERP did not see the records point".
--
-- ── RLS WALL: THIRD WALL ────────────────────────────────────────────────────────────────────────
-- Same shape as webdev_schedule_firings: `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('webdev')`, ENABLE + FORCE.
-- Every access runs inside withTenants(..., {modules: ['webdev', ...]}); without it the table reads ZERO rows.
--
-- ── ZERO BACKFILL DML ───────────────────────────────────────────────────────────────────────────
-- A brand-new table. No UPDATE, DELETE or INSERT anywhere in this file.

CREATE TABLE webdev_site_dns_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES companies(id),
  site_id uuid NOT NULL REFERENCES webdev_sites(id),
  -- The domain this task was made for. A site whose domain differs from it has a STALE task (replaced).
  domain text NOT NULL,
  -- The PM task (pm_tasks.id). pm_tasks carries tenant-only RLS and no composite key, so this is a plain FK.
  task_id uuid NOT NULL REFERENCES pm_tasks(id),
  -- [{type, name, target}], the checklist at the last sync.
  records jsonb NOT NULL,
  -- Who the task went to, and which rule chose them (domain-dns-task.service.ts, "THE ASSIGNEE RULE").
  assignee_source text NOT NULL CHECK (assignee_source IN ('project_owner', 'web_dev_head', 'unassigned')),
  assignee_user_id uuid REFERENCES users(id),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
  closed_by text CHECK (closed_by IN ('erp_check', 'manual', 'domain_changed', 'site_archived')),
  closed_at timestamptz,
  -- What the ERP's read-only check last saw (typed tokens, never resolver text).
  last_checked_at timestamptz,
  last_check_reason text CHECK (last_check_reason IS NULL OR last_check_reason ~ '^[a-z_]{1,40}$'),
  erp_saw_pointing boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wsdt_closed_shape CHECK ((state = 'closed') = (closed_by IS NOT NULL AND closed_at IS NOT NULL)),
  CONSTRAINT wsdt_unassigned_has_no_user CHECK ((assignee_source = 'unassigned') = (assignee_user_id IS NULL)),
  CONSTRAINT ux_wsdt_task UNIQUE (tenant_id, task_id)
);

-- ONE open task per site: the idempotency backstop (the service also locks the site row).
CREATE UNIQUE INDEX ux_wsdt_one_open_per_site ON webdev_site_dns_tasks (tenant_id, site_id) WHERE state = 'open';
CREATE INDEX ix_wsdt_site ON webdev_site_dns_tasks (tenant_id, site_id, created_at DESC);

COMMENT ON TABLE webdev_site_dns_tasks IS
  'M6-P6p: the link between a webdev_sites row and the pm_tasks row that asks a Web Dev person to create the domain''s DNS records. '
  'One open row per site; closed by the ERP''s read-only DNS check (erp_check), by hand (manual), or when the domain changed or the '
  'site was archived. Stores no DNS credential; no DNS API exists. THIRD WALL RLS.';

ALTER TABLE webdev_site_dns_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE webdev_site_dns_tasks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON webdev_site_dns_tasks;
CREATE POLICY tenant_isolation ON webdev_site_dns_tasks FOR ALL
  USING (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('webdev'))
  WITH CHECK (tenant_id = ANY(app_current_tenants()) AND app_module_allowed('webdev'));
