// Seed helpers shared across suites. All writes go through the app role (RLS-bound)
// except role/permission/company creation, which are global-table inserts.
import { newId, withGlobal, withTenants } from "../db";
import { config } from "../config";

const site = () => config.originSite;

export async function createCompany(
  name: string,
  enabledModules: string[] = [],
  parentCompanyId: string | null = null,
): Promise<string> {
  const id = newId();
  await withGlobal((c) =>
    c.query(
      `INSERT INTO companies (id, name, enabled_modules, parent_company_id, origin_site) VALUES ($1, $2, $3, $4, $5)`,
      [id, name, enabledModules, parentCompanyId, site()],
    ),
  );
  return id;
}

export async function createUser(email: string, name = email.split("@")[0], title: string | null = null): Promise<string> {
  const id = newId();
  await withGlobal((c) =>
    c.query(`INSERT INTO users (id, email, name, title, origin_site) VALUES ($1, $2, $3, $4, $5)`, [
      id, email, name, title, site(),
    ]),
  );
  return id;
}

/**
 * `kind` defaults to the column default ('employee'). Pass 'service' for a NON-HUMAN principal —
 * an n8n workflow's service account, a bot. It is what every people-shaped surface filters on
 * (`GET /api/:t/members`, `GET /api/:t/users`), so a service account created without it is
 * indistinguishable from staff: 17 automation accounts sat in the People directory and HR
 * headcount read 36 instead of 19 for exactly this reason.
 *
 * NOT retroactive on an existing row — `ON CONFLICT DO NOTHING` deliberately leaves a membership
 * that already exists alone, so re-running a seed never silently re-tags or re-activates one.
 */
export async function addMembership(
  tenantId: string,
  userId: string,
  kind: "employee" | "service" = "employee",
): Promise<void> {
  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO company_memberships (id, tenant_id, user_id, origin_site, kind) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, user_id) DO NOTHING`,
      [newId(), tenantId, userId, site(), kind],
    ),
  );
}

/**
 * Get-or-create a role. Used by the re-runnable seed (`src/seed/agency.ts`), so it MUST be
 * idempotent for global roles as well as per-company ones.
 *
 * It was not. `ON CONFLICT (company_id, name)` infers the 0001 `UNIQUE (company_id, name)`
 * constraint, and for a GLOBAL role `company_id` is NULL — which SQL treats as distinct from every
 * other NULL for uniqueness. The conflict target therefore never matched, `DO NOTHING` never fired,
 * and every call inserted another row. The live DB had accumulated 10 × `manager`, 3 ×
 * `company_admin` and 2 × `member` this way — one per seed run — surfacing as ten identical options
 * in the assign-role picker. Migration 0073 collapses them and adds the partial unique index this
 * now targets, which is what makes the global branch actually conflict.
 */
export async function createRole(name: string, companyId: string | null = null): Promise<string> {
  const id = newId();
  await withGlobal((c) =>
    companyId === null
      ? c.query(
          // Matches 0073's `roles_global_name_uniq ON roles (name) WHERE company_id IS NULL`.
          `INSERT INTO roles (id, company_id, name) VALUES ($1, NULL, $2)
           ON CONFLICT (name) WHERE company_id IS NULL DO NOTHING`,
          [id, name],
        )
      : c.query(
          `INSERT INTO roles (id, company_id, name) VALUES ($1, $2, $3)
           ON CONFLICT (company_id, name) DO NOTHING`,
          [id, companyId, name],
        ),
  );
  const { rows } = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM roles WHERE name = $1 AND company_id IS NOT DISTINCT FROM $2`, [
      name,
      companyId,
    ]),
  );
  return rows[0].id;
}

export async function grantRole(
  userId: string,
  roleId: string,
  scopeType: "global" | "company" | "team" | "project" | "record",
  scopeId: string | null,
): Promise<void> {
  await withGlobal((c) =>
    c.query(
      `INSERT INTO user_roles (id, user_id, role_id, scope_type, scope_id) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [newId(), userId, roleId, scopeType, scopeId],
    ),
  );
}

export async function linkIdentity(
  userId: string,
  provider: string,
  externalId: string,
  verified: boolean,
): Promise<void> {
  await withGlobal((c) =>
    c.query(
      `INSERT INTO identity_links (id, user_id, provider, external_id, verified_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [newId(), userId, provider, externalId, verified ? new Date() : null],
    ),
  );
}

export async function defineCustomField(
  tenantId: string,
  entityType: string,
  key: string,
  dataType: string,
  required = false,
): Promise<void> {
  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO custom_field_definitions (id, tenant_id, entity_type, key, label, data_type, required, origin_site)
       VALUES ($1, $2, $3, $4, $4, $5, $6, $7)`,
      [newId(), tenantId, entityType, key, dataType, required, site()],
    ),
  );
}

export async function createClient(tenantId: string, name: string, portalUserId?: string): Promise<string> {
  const id = newId();
  await withTenants([tenantId], (c) =>
    c.query(`INSERT INTO clients (id, tenant_id, name, portal_user_id, origin_site) VALUES ($1, $2, $3, $4, $5)`, [
      id, tenantId, name, portalUserId ?? null, site(),
    ]),
  );
  return id;
}

export async function createProject(tenantId: string, name: string, ownerId?: string): Promise<string> {
  const id = newId();
  await withTenants([tenantId], (c) =>
    c.query(`INSERT INTO projects (id, tenant_id, name, owner_id, origin_site) VALUES ($1, $2, $3, $4, $5)`, [
      id,
      tenantId,
      name,
      ownerId ?? null,
      site(),
    ]),
  );
  return id;
}

export async function createTask(tenantId: string, projectId: string, title: string, status = "todo"): Promise<string> {
  const id = newId();
  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO tasks (id, tenant_id, project_id, title, status, origin_site) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, tenantId, projectId, title, status, site()],
    ),
  );
  return id;
}
