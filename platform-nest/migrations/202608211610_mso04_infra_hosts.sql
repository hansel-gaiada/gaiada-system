-- MSO-04/MSO-05 — infra_hosts: the estate's inventory of Plane A hosts
-- (docs/plans/2026-08-21-multi-server-observability.md §3, schema sketch §3.1, ratified by architect).
--
-- BUILT BY MSO-05 (senior-be), NOT MSO-04 (senior-db), because MSO-05 (the estate observability
-- endpoint) cannot satisfy its own non-negotiable #3 — "expected-but-dark hosts must appear" —
-- without an inventory table that survives a host going fully silent. As of this migration MSO-04
-- had not landed under its own ticket, and the design doc explicitly offers this path: "if MSO-04's
-- infra_hosts table does not exist yet, either create it ... or ... keep this ticket backend-only".
-- The DDL below is copied VERBATIM from §3.1 (no improvised columns/constraints) — this is the
-- "architect-approved migration spec" case, not a senior-be schema decision. If a concurrent
-- MSO-04 session lands the same table first, this file's CREATE TABLE will fail loudly (no
-- IF NOT EXISTS) rather than silently diverge from the ratified shape; whichever migration is
-- discovered second in that race must be deleted, not "reconciled" by hand.
--
-- WHY NO RLS: this is a GLOBAL table — there is nothing per-tenant about our own server estate.
-- Same posture as `permissions` (0001_core.sql / documented in 0093_iam_permission_catalog.sql):
-- no tenant_id column, no FORCE ROW LEVEL SECURITY, read via `withGlobal()` only. This satisfies
-- lint:withtenants (no withTenants() call is introduced) and lint:migration-rls (no DML against a
-- FORCE-RLS table) the same way the permission catalog's global tables do.
CREATE TABLE infra_hosts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key           text NOT NULL UNIQUE CHECK (key ~ '^[a-z0-9][a-z0-9-]*$'), -- = `host` series label, immutable
  display_name  text NOT NULL,
  env           text NOT NULL CHECK (env IN ('production','staging','ops','dev')),
  role          text NOT NULL DEFAULT '',            -- 'erp-core' | 'observability-hub' | 'ai-host' | …
  provider      text,
  wg_ip         inet,                                 -- mesh address ledger; partial-unique where set
  ssh_alias     text,                                 -- operator convenience ONLY; nothing dials it
  status        text NOT NULL DEFAULT 'onboarding'
                CHECK (status IN ('active','onboarding','decommissioned')),
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX infra_hosts_wg_ip ON infra_hosts (wg_ip) WHERE wg_ip IS NOT NULL;

COMMENT ON TABLE infra_hosts IS
  'MSO-04/05. Global (non-tenant) inventory of Plane A hosts — the console''s source of truth for '
  'WHICH hosts should exist, so a fully-dark host still renders instead of silently vanishing from '
  'a series-derived list. The `host` remote_write external label is the join key (key column). No '
  'RLS: read via withGlobal() only, same as permissions/roles. v1 has no CRUD UI — rows land by '
  'seed/migration; an admin CRUD endpoint is a later ticket if the owner wants one.';

-- Seed v1 with the two hosts verified LIVE as of 2026-08-21 (design doc §1/§3.1): gda-aicenter
-- (production / erp-core) and sumopod (ops / observability-hub, the WireGuard hub 10.88.0.2).
-- Every other host from the operator's ssh config waits on OQ-1 (owner has not yet named env/role
-- for them), so seeding them here would be a guess this migration is not entitled to make.
-- ON CONFLICT ... DO UPDATE keeps the seed idempotent (re-running it churns nothing but updated_at)
-- per §9's MSO-04 acceptance criterion ("seed idempotent").
INSERT INTO infra_hosts (key, display_name, env, role, status, notes)
VALUES
  ('gda-aicenter', 'gda-aicenter', 'production', 'erp-core', 'active',
   'MSO seed 2026-08-21: verified live (count by (host)(up) = 14 series, MSO-01).'),
  ('sumopod', 'SumoPod (observability hub)', 'ops', 'observability-hub', 'active',
   'MSO seed 2026-08-21: verified live (count by (host)(up) = 2 series, MSO-01); WireGuard hub 10.88.0.2.')
ON CONFLICT (key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  env = EXCLUDED.env,
  role = EXCLUDED.role,
  status = EXCLUDED.status,
  notes = EXCLUDED.notes,
  updated_at = now();
