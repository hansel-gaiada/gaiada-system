-- Core schema (WS1 sub-spec §3) + FORCE RLS on the authorized-tenant-set (D5).
-- Conventions (§2): app-generated UUIDv7 ids, tenant_id, origin_site, created_at,
-- updated_at (logical clock), deleted_at (soft delete).

-- ============ Global tables (no tenant_id; app-layer guarded) ============

CREATE TABLE companies (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  type text NOT NULL DEFAULT 'general',
  enabled_modules text[] NOT NULL DEFAULT '{}',
  parent_company_id uuid REFERENCES companies(id),
  settings jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active',
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  title text,
  status text NOT NULL DEFAULT 'active',
  -- D11: bumped on disable/role change; sensitive paths compare against it.
  session_version integer NOT NULL DEFAULT 1,
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE permissions (
  id uuid PRIMARY KEY,
  key text NOT NULL UNIQUE, -- e.g. 'projects:read', 'agency:campaign:approve'
  description text NOT NULL DEFAULT ''
);

CREATE TABLE roles (
  id uuid PRIMARY KEY,
  company_id uuid REFERENCES companies(id), -- NULL = global role
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  UNIQUE (company_id, name)
);

CREATE TABLE role_permissions (
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_roles (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  scope_type text NOT NULL CHECK (scope_type IN ('global','company','team','project','record')),
  scope_id uuid, -- NULL for global scope
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role_id, scope_type, scope_id)
);

-- External identity -> user (D4). Only the platform reads/writes this.
CREATE TABLE identity_links (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL, -- whatsapp / telegram / ...
  external_id text NOT NULL,
  verified_at timestamptz, -- dual-proof enrollment timestamp; NULL = unverified
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_id)
);

-- D12: governed metric registry — the only source of comparable metrics.
CREATE TABLE metric_definitions (
  metric_key text PRIMARY KEY, -- canonical, e.g. 'core.tasks.open_ratio'
  module text NOT NULL, -- owning module ('core', 'agency', ...)
  description text NOT NULL DEFAULT '',
  unit text NOT NULL, -- 'count' | 'ratio' | 'minutes' | 'money_minor' | ...
  is_monetary boolean NOT NULL DEFAULT false,
  aggregation_rule text NOT NULL CHECK (aggregation_rule IN ('sum','ratio_of_sums','max','last'))
);

-- ============ Tenant-scoped tables (FORCE RLS) ============

CREATE TABLE company_memberships (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  user_id uuid NOT NULL REFERENCES users(id),
  primary_role_id uuid REFERENCES roles(id),
  status text NOT NULL DEFAULT 'active',
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (tenant_id, user_id)
);

CREATE TABLE teams (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  name text NOT NULL,
  parent_team_id uuid REFERENCES teams(id),
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE team_memberships (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  user_id uuid NOT NULL REFERENCES users(id),
  team_id uuid NOT NULL REFERENCES teams(id),
  role text NOT NULL DEFAULT 'member',
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (tenant_id, user_id, team_id)
);

CREATE TABLE clients (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  name text NOT NULL,
  contact jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active',
  custom_fields jsonb NOT NULL DEFAULT '{}',
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE projects (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  client_id uuid REFERENCES clients(id), -- nullable: internal work (mixed model)
  is_internal boolean NOT NULL DEFAULT false,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  start_date date,
  due_date date,
  owner_id uuid REFERENCES users(id),
  custom_fields jsonb NOT NULL DEFAULT '{}',
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX idx_projects_tenant ON projects (tenant_id, status);

CREATE TABLE tasks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  parent_task_id uuid REFERENCES tasks(id),
  title text NOT NULL,
  status text NOT NULL DEFAULT 'todo',
  priority text NOT NULL DEFAULT 'normal',
  assignee_id uuid REFERENCES users(id),
  due_date date,
  sort_order integer NOT NULL DEFAULT 0,
  custom_fields jsonb NOT NULL DEFAULT '{}',
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX idx_tasks_tenant_project ON tasks (tenant_id, project_id, status);

CREATE TABLE deliverables (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  client_id uuid REFERENCES clients(id),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  due_date date,
  custom_fields jsonb NOT NULL DEFAULT '{}',
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE time_entries (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  user_id uuid NOT NULL REFERENCES users(id),
  task_id uuid REFERENCES tasks(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  minutes integer NOT NULL CHECK (minutes > 0),
  billable boolean NOT NULL DEFAULT false,
  entry_date date NOT NULL,
  notes text NOT NULL DEFAULT '',
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE activities (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  actor_id uuid, -- NULL = system/service
  verb text NOT NULL, -- 'created' | 'updated' | 'authz.deny' | ...
  target_entity_type text NOT NULL,
  target_entity_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  origin_site text NOT NULL
);
CREATE INDEX idx_activities_tenant_time ON activities (tenant_id, occurred_at DESC);

CREATE TABLE comments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  author_id uuid NOT NULL REFERENCES users(id),
  target_entity_type text NOT NULL,
  target_entity_id uuid NOT NULL,
  body text NOT NULL,
  parent_comment_id uuid REFERENCES comments(id),
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  user_id uuid NOT NULL REFERENCES users(id),
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  read_at timestamptz,
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- D17: JSONB custom fields on entities + this registry (validated on write, no EAV).
CREATE TABLE custom_field_definitions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  entity_type text NOT NULL, -- 'project' | 'task' | 'client' | module targets
  key text NOT NULL,
  label text NOT NULL,
  data_type text NOT NULL CHECK (data_type IN ('text','number','boolean','date','select')),
  options jsonb NOT NULL DEFAULT '[]',
  required boolean NOT NULL DEFAULT false,
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (tenant_id, entity_type, key)
);

-- D12: rollup rows — ratios as numerator/denominator, money in minor units + currency,
-- idempotent on (tenant, module, metric_key, period).
CREATE TABLE rollup_metrics (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES companies(id),
  module text NOT NULL,
  metric_key text NOT NULL REFERENCES metric_definitions(metric_key),
  period text NOT NULL, -- e.g. '2026-07-05' or '2026-07'
  numerator numeric NOT NULL,
  denominator numeric, -- NULL for plain counts/sums
  currency text, -- required when the metric is monetary
  dimensions jsonb NOT NULL DEFAULT '{}',
  as_of timestamptz NOT NULL, -- source watermark (provisional vs closed)
  computed_at timestamptz NOT NULL DEFAULT now(),
  origin_site text NOT NULL,
  -- D12 idempotency key; dimensions included so dimensioned metrics keep one row per slice.
  UNIQUE (tenant_id, module, metric_key, period, dimensions)
);

-- ============ RLS (D5): FORCE + authorized-tenant-SET on every tenant table ============
-- current_setting unset -> NULL -> policy false -> zero rows (fail-closed).

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'company_memberships','teams','team_memberships','clients','projects','tasks',
    'deliverables','time_entries','activities','comments','notifications',
    'custom_field_definitions','rollup_metrics'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
       USING (tenant_id = ANY(string_to_array(current_setting(''app.current_tenant_ids'', true), '','')::uuid[]))
       WITH CHECK (tenant_id = ANY(string_to_array(current_setting(''app.current_tenant_ids'', true), '','')::uuid[]))',
      t
    );
  END LOOP;
END $$;

-- Principal assembly (RBAC spec §2) must discover a user's tenants BEFORE any tenant
-- context exists. This narrow additional policy lets a session read exactly ONE user's
-- membership rows — the user named in app.principal_user_id — and nothing else.
CREATE POLICY principal_lookup ON company_memberships FOR SELECT
  USING (user_id = current_setting('app.principal_user_id', true)::uuid);
