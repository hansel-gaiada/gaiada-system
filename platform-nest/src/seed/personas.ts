// IAM-06a — one real user per role tier, idempotent, alongside `seed:agency`.
//
// Purpose: a stable, deterministic set of principals Web Dev / PM / QA can log into (real
// backend session, real Cerbos decisions) without hand-rolling role/grant/membership boilerplate
// per suite. This is the SHARED/DEMO-style seed — it plants durable rows in whatever database
// `DATABASE_URL` points at (dev box, gda-aicenter staging), same as `seed:agency`. Integration
// TESTS should NOT depend on this having run — see `src/testing/personas.ts` (IAM-06b) for the
// per-test, fresh-tenant equivalent that seeds its own throwaway personas on every run.
//
// Run: DATABASE_URL=... tsx src/seed/personas.ts   (or `npm run seed:personas` after a build)
//
// Emails are deterministic: persona.<key>@iam-personas.test — so "log in as org_unit_lead" is
// always the same address, in every environment this has been seeded into, forever.
//
// ⚠ Two personas this file deliberately does NOT create:
//   - `owner` (D-8) — NOT YET BUILT. There is no `owner` role in Cerbos or `roles` today. A
//     persona for a role that doesn't exist would silently coach consumers into testing against
//     a fiction. When Phase 3 (IAM-14) ships `owner`, add it here as a NEW persona key — do not
//     repurpose `group_executive`'s slot.
//   - A second `client` — one is enough to exercise the portal boundary; see CLIENT below.
//
// `group_executive` IS seeded, because it exists in the system today (D-7 marks it OBSOLETE and
// slated for removal in Phase 3, not gone). Every consumer of this persona must treat it as
// "the tier that is going away", never as a stand-in for the future `owner` role — they are NOT
// the same thing, and D-8's `owner` envelope (no platform/system controls) is intentionally
// narrower than `group_executive`'s current reach.
import { newId, withGlobal, withTenants, closePool } from "../db";
import { config } from "../config";
import { migrate } from "../db/migrate";
import { createRole, grantRole, addMembership } from "../testing/fixtures";

const site = () => config.originSite;
const TENANT_NAME = "IAM Persona Sandbox";
const EMAIL_DOMAIN = "iam-personas.test";
const CLIENT_NAME = "Persona Client Co";
// HIER-3 (2026-08-11): replaces TEAM_NAME. A bare 0029-convention free-form org-unit node id (no
// `company_org_structure` blob needed — `org_unit_memberships.unit_node_id` has no FK, per 0055's
// header). Self-inclusive-at-depth-0 (HIER-2's ancestor containment), so the org_unit_lead grant
// covers the persona's own placement at this same unit without needing a subtree.
const ORG_UNIT_ID = "d-persona";

export type PersonaKey =
  | "superadmin" | "company_admin" | "manager" | "org_unit_lead" | "member" | "viewer"
  | "hr_staff" | "hr_manager" | "it_admin" | "search_staff" | "search_manager"
  | "agency_approver" | "client_contact";

interface PersonaSpec {
  key: PersonaKey;
  role: string; // roles.name
  scope: "global" | "company" | "org_unit";
  label: string;
  extraRole?: string; // e.g. agency_approver also holds plain `member`, mirroring seed:agency
}

// HIER-3 (2026-08-11): `team_lead` retired ALONGSIDE the role itself; `org_unit_lead` (HIER-2's
// org-chart subtree-cascade replacement) takes its slot — placed AND granted at the same fixed
// org-unit node id (ORG_UNIT_ID below), so person-scope narrowing is actually exercised.
// Ordered so the report/README table reads sensibly top-to-bottom (tier, then module roles).
export const PERSONAS: PersonaSpec[] = [
  { key: "superadmin", role: "platform_admin", scope: "global", label: "Persona Superadmin" },
  { key: "company_admin", role: "company_admin", scope: "company", label: "Persona Company Admin" },
  { key: "manager", role: "manager", scope: "company", label: "Persona Manager" },
  { key: "org_unit_lead", role: "org_unit_lead", scope: "org_unit", label: "Persona Org Unit Lead" },
  { key: "member", role: "member", scope: "company", label: "Persona Member" },
  { key: "viewer", role: "viewer", scope: "company", label: "Persona Viewer" },
  { key: "hr_staff", role: "hr_staff", scope: "company", label: "Persona HR Staff" },
  { key: "hr_manager", role: "hr_manager", scope: "company", label: "Persona HR Manager" },
  { key: "it_admin", role: "it_admin", scope: "company", label: "Persona IT Admin" },
  { key: "search_staff", role: "search_staff", scope: "company", label: "Persona Search Staff" },
  { key: "search_manager", role: "search_manager", scope: "company", label: "Persona Search Manager" },
  { key: "agency_approver", role: "agency_approver", scope: "company", label: "Persona Agency Approver", extraRole: "member" },
  // IAM-15: the "Persona Group Executive" entry is removed. It already carried its own expiry note
  // — "⚠ obsolete — D-7, removal is Phase 3" — and this is Phase 3. Seeding a persona for a role
  // that no longer exists would create a principal whose grant joins to nothing.
];

export interface SeededPersonas {
  tenantId: string;
  orgUnitId: string;
  clientId: string;
  users: Record<PersonaKey, string>;
  emails: Record<PersonaKey, string>;
}

async function ensureUser(email: string, name: string): Promise<string> {
  const found = await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM users WHERE email=$1`, [email]));
  if (found.rows[0]) return found.rows[0].id;
  const id = newId();
  await withGlobal((c) =>
    c.query(`INSERT INTO users (id, email, name, origin_site) VALUES ($1,$2,$3,$4)`, [id, email, name, site()]),
  );
  return id;
}

async function ensureCompany(name: string): Promise<string> {
  const found = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM companies WHERE name=$1 AND deleted_at IS NULL`, [name]),
  );
  if (found.rows[0]) return found.rows[0].id;
  const id = newId();
  // Every module a seeded persona role might need to actually reach a policy is enabled here —
  // an unenabled module can fail closed on module-gated tables (see agency.ts's report_checkins
  // comment on `app_module_allowed`), which would make e.g. the hr_staff persona look "denied"
  // for a reason that has nothing to do with the role/permission being tested.
  await withGlobal((c) =>
    c.query(
      `INSERT INTO companies (id, name, type, enabled_modules, origin_site) VALUES ($1,$2,'agency',$3,$4)`,
      [id, name, ["agency", "hr", "reports", "search", "assistant", "webdev", "pm", "it"], site()],
    ),
  );
  return id;
}

/** Places `userId` at `unitNodeId` as their PRIMARY, currently-open org-unit membership —
 *  idempotent (skips if an open placement at this exact unit already exists), matching this
 *  file's `ensure*` idiom. Placement matters: `person-scope.ts` narrows a unit-scoped tier by the
 *  SUBJECT's placement, not merely by the caller holding a grant. */
async function ensureOrgUnitPlacement(tenantId: string, userId: string, unitNodeId: string): Promise<void> {
  const found = await withTenants([tenantId], (c) =>
    c.query<{ id: string }>(
      `SELECT id FROM org_unit_memberships WHERE tenant_id=$1 AND user_id=$2 AND unit_node_id=$3 AND valid_to IS NULL`,
      [tenantId, userId, unitNodeId],
    ),
  );
  if (found.rows[0]) return;
  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO org_unit_memberships (id, tenant_id, user_id, unit_node_id, is_primary, valid_from, source, origin_site)
       VALUES ($1,$2,$3,$4,true,'2020-01-01','manual',$5)`,
      [newId(), tenantId, userId, unitNodeId, site()],
    ),
  );
}

async function ensureClient(tenantId: string, name: string): Promise<string> {
  const found = await withTenants([tenantId], (c) =>
    c.query<{ id: string }>(`SELECT id FROM clients WHERE tenant_id=$1 AND name=$2`, [tenantId, name]),
  );
  if (found.rows[0]) return found.rows[0].id;
  const id = newId();
  await withTenants([tenantId], (c) =>
    c.query(`INSERT INTO clients (id, tenant_id, name, origin_site) VALUES ($1,$2,$3,$4)`, [id, tenantId, name, site()]),
  );
  return id;
}

/**
 * `client_contacts`, NOT `company_memberships` — see `principal.ts`'s long comment (grepped
 * before writing this): clients are kept out of the staff-membership table on purpose, so a
 * client contact can never appear in `/people`, HR, or any staff listing. This is the ONLY
 * insert path this file uses for the client persona; do not "simplify" it into `addMembership`.
 */
async function ensureClientContact(tenantId: string, clientId: string, userId: string): Promise<string> {
  const found = await withTenants([tenantId], (c) =>
    c.query<{ id: string }>(
      `SELECT id FROM client_contacts WHERE tenant_id=$1 AND client_id=$2 AND user_id=$3`,
      [tenantId, clientId, userId],
    ),
  );
  if (found.rows[0]) return found.rows[0].id;
  const id = newId();
  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, capability, status, activated_at, origin_site)
       VALUES ($1,$2,$3,$4,'viewer','active', now(), $5)`,
      [id, tenantId, clientId, userId, site()],
    ),
  );
  return id;
}

export async function seedPersonas(): Promise<SeededPersonas> {
  const tenantId = await ensureCompany(TENANT_NAME);
  const orgUnitId = ORG_UNIT_ID;
  const clientId = await ensureClient(tenantId, CLIENT_NAME);

  const users = {} as Record<PersonaKey, string>;
  const emails = {} as Record<PersonaKey, string>;

  for (const p of PERSONAS) {
    const email = `persona.${p.key}@${EMAIL_DOMAIN}`;
    const userId = await ensureUser(email, p.label);
    users[p.key] = userId;
    emails[p.key] = email;

    const roleId = await createRole(p.role);
    if (p.scope === "org_unit") {
      await addMembership(tenantId, userId);
      await ensureOrgUnitPlacement(tenantId, userId, orgUnitId);
      await grantRole(userId, roleId, "org_unit", orgUnitId);
    } else if (p.scope === "global") {
      // Global role AND a company membership — the membership is what puts this tenant in the
      // principal's authorized-tenant set at all (mirrors seed:agency's superadmin/exec pattern).
      await addMembership(tenantId, userId);
      await grantRole(userId, roleId, "global", null);
    } else {
      await addMembership(tenantId, userId);
      await grantRole(userId, roleId, "company", tenantId);
    }
    if (p.extraRole) {
      await grantRole(userId, await createRole(p.extraRole), "company", tenantId);
    }
  }

  // The client contact: portal-only, deliberately outside company_memberships.
  const clientEmail = `persona.client_contact@${EMAIL_DOMAIN}`;
  const clientUserId = await ensureUser(clientEmail, "Persona Client Contact");
  await ensureClientContact(tenantId, clientId, clientUserId);
  users.client_contact = clientUserId;
  emails.client_contact = clientEmail;

  return { tenantId, orgUnitId, clientId, users, emails };
}

if (require.main === module) {
  (async () => {
    await migrate();
    const r = await seedPersonas();
    console.log(`seeded personas in tenant ${r.tenantId}`);
    for (const p of [...PERSONAS, { key: "client_contact" as const, role: "(client_contacts)", scope: "company" as const, label: "Persona Client Contact" }]) {
      console.log(`  ${p.key.padEnd(16)} ${r.emails[p.key]}  (${r.users[p.key]})`);
    }
    await closePool();
    process.exit(0);
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
