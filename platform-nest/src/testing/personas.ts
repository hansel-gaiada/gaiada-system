// IAM-06b — the ONE-LINE integration-test contract for "log in as any persona".
//
// This is what PM/Web Dev suites should actually import — NOT `src/seed/personas.ts` (IAM-06a),
// which plants durable rows in a real, shared database for manual/staging use. This file seeds a
// brand-new, disposable tenant (+ team + client) on every call, so tests never depend on IAM-06a
// having run and never collide with each other's data — the same isolation `freshTenant()` helpers
// already use ad hoc in files like `pm-adversarial-authz.test.ts`, just generalized to the FULL
// persona set instead of 4 hand-rolled roles per suite.
//
// See `platform-nest/README-PERSONAS.md` for copy-pasteable ALLOW and DENY examples. The short
// version:
//
//   const p = await seedPersonaTenant();
//   const allowed = await app.inject({ method: "GET",  url: `/api/${p.tenantId}/it/devices`, headers: p.as("it_admin") });
//   expect(allowed.statusCode).toBe(200);          // ALLOW
//   const denied  = await app.inject({ method: "POST", url: `/api/${p.tenantId}/it/devices`, headers: p.as("viewer") });
//   expect(denied.statusCode).toBe(403);           // DENY
//
// Requires `config.serviceToken` to already be set and the app built with the matching
// `PLATFORM_SERVICE_TOKEN` — every suite that calls `buildApp()` already does this for its own
// `asUser`-style header helper (see pm-adversarial-authz.test.ts's `beforeAll`).
import { newId, withTenants } from "../db";
import { config } from "../config";
import { createCompany, createUser, createRole, grantRole, addMembership } from "./fixtures";

const site = () => config.originSite;

export type PersonaKey =
  | "superadmin" | "company_admin" | "manager" | "team_lead" | "member" | "viewer"
  | "hr_staff" | "hr_manager" | "it_admin" | "search_staff" | "search_manager"
  | "agency_approver" | "group_executive" | "client_contact";

interface PersonaDef {
  role: string;
  scope: "global" | "company" | "team";
  /** Also grant this second role — mirrors seed:agency's agency_approver, who holds `member` too. */
  extraRole?: string;
}

// ⚠ `group_executive` is D-7-obsolete (slated for removal in Phase 3) — kept because it exists
// today. There is no `owner` persona (D-8): the role does not exist yet, and inventing a fixture
// for an unbuilt role would silently teach consumers to test against a fiction.
const PERSONA_DEFS: Record<Exclude<PersonaKey, "client_contact">, PersonaDef> = {
  superadmin: { role: "platform_admin", scope: "global" },
  company_admin: { role: "company_admin", scope: "company" },
  manager: { role: "manager", scope: "company" },
  team_lead: { role: "team_lead", scope: "team" },
  member: { role: "member", scope: "company" },
  viewer: { role: "viewer", scope: "company" },
  hr_staff: { role: "hr_staff", scope: "company" },
  hr_manager: { role: "hr_manager", scope: "company" },
  it_admin: { role: "it_admin", scope: "company" },
  search_staff: { role: "search_staff", scope: "company" },
  search_manager: { role: "search_manager", scope: "company" },
  agency_approver: { role: "agency_approver", scope: "company", extraRole: "member" },
  group_executive: { role: "group_executive", scope: "global" },
};

export const ALL_PERSONA_KEYS: PersonaKey[] = [...(Object.keys(PERSONA_DEFS) as PersonaKey[]), "client_contact"];

export interface PersonaTenant {
  tenantId: string;
  teamId: string;
  clientId: string;
  users: Partial<Record<PersonaKey, string>>;
  /** The one-line accessor: HTTP headers to `app.inject`/supertest AS this persona. Throws if the
   *  persona wasn't in the `which` list passed to `seedPersonaTenant` — loud, not a silent 401. */
  as(persona: PersonaKey): { authorization: string; "x-user-id": string };
}

async function ensureTeam(tenantId: string, name: string): Promise<string> {
  const id = newId();
  await withTenants([tenantId], (c) =>
    c.query(`INSERT INTO teams (id, tenant_id, name, origin_site) VALUES ($1,$2,$3,$4)`, [id, tenantId, name, site()]),
  );
  return id;
}

async function addTeamLead(tenantId: string, teamId: string, userId: string): Promise<void> {
  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO team_memberships (id, tenant_id, user_id, team_id, role, origin_site) VALUES ($1,$2,$3,$4,'lead',$5)`,
      [newId(), tenantId, userId, teamId, site()],
    ),
  );
}

async function createClientAndContact(tenantId: string): Promise<{ clientId: string; userId: string }> {
  const clientId = newId();
  await withTenants([tenantId], (c) =>
    c.query(`INSERT INTO clients (id, tenant_id, name, origin_site) VALUES ($1,$2,'Persona Client',$3)`, [
      clientId, tenantId, site(),
    ]),
  );
  const userId = await createUser(`${newId()}@personas.test`, "Persona Client Contact");
  // client_contacts, NOT company_memberships — see principal.ts's comment (grepped before this
  // file was written): clients are kept out of the staff table structurally, on purpose.
  // Needs `withTenants` (not `withGlobal`): the table's `tenant_isolation` RLS policy is `FOR ALL`,
  // not just SELECT, so an insert under a global connection with no tenant GUC set is rejected.
  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, capability, status, activated_at, origin_site)
       VALUES ($1,$2,$3,$4,'viewer','active', now(), $5)`,
      [newId(), tenantId, clientId, userId, site()],
    ),
  );
  // ⚠ DEFECT A FIX (IAM-VERIFY-01, 2026-08-11). The `client_contacts` row above is necessary but
  // NOT sufficient: it gives the principal a TENANT (via `assemblePrincipal()`'s UNION over
  // client_contacts), while `resource_portal.yaml` grants its actions to the `client` DERIVED role,
  // which `derived_roles.yaml` matches as `g.role == "client" && g.scopeType == "company"` — i.e.
  // an actual `user_roles` grant. Without it this persona authenticates, resolves a tenant, and is
  // then refused the entire portal.
  //
  // Found only by DRIVING the real endpoint as this persona: every suite was green, because nothing
  // had ever exercised the portal as a client. Confirmed by granting the role by hand and watching
  // the same request flip 403 -> 200.
  //
  // This matters beyond the fixture: `client_contact` is the persona Web Dev and PM would reach for
  // to test client-facing gating, and it would have told them the portal denies clients.
  const clientRoleId = await createRole("client");
  await grantRole(userId, clientRoleId, "company", tenantId);
  return { clientId, userId };
}

/**
 * Seeds one fresh user per requested persona (default: ALL of them, including the client
 * contact) in a brand-new tenant + team + client. Returns `.as(persona)` — the entire integration
 * -test contract. Idempotent is not a concern here on purpose: every call makes a NEW tenant, so
 * there is nothing to collide with, unlike IAM-06a's durable seed.
 */
export async function seedPersonaTenant(
  which: PersonaKey[] = ALL_PERSONA_KEYS,
  label = "persona-tenant",
): Promise<PersonaTenant> {
  const tenantId = await createCompany(`${label} ${newId().slice(0, 8)}`, [
    "agency", "hr", "reports", "search", "assistant", "webdev", "pm", "it",
  ]);
  const teamId = await ensureTeam(tenantId, "Persona Team");
  const users: Partial<Record<PersonaKey, string>> = {};
  let clientId = "";

  for (const key of which) {
    if (key === "client_contact") {
      const { clientId: cid, userId } = await createClientAndContact(tenantId);
      clientId = cid;
      users[key] = userId;
      continue;
    }
    const def = PERSONA_DEFS[key];
    const userId = await createUser(`${newId()}@personas.test`, `Persona ${key}`);
    users[key] = userId;
    await addMembership(tenantId, userId);
    const roleId = await createRole(def.role);
    if (def.scope === "team") {
      await addTeamLead(tenantId, teamId, userId);
      await grantRole(userId, roleId, "team", teamId);
    } else {
      await grantRole(userId, roleId, def.scope, def.scope === "global" ? null : tenantId);
    }
    if (def.extraRole) {
      await grantRole(userId, await createRole(def.extraRole), "company", tenantId);
    }
  }

  return {
    tenantId,
    teamId,
    clientId,
    users,
    as(persona: PersonaKey) {
      const userId = users[persona];
      if (!userId) {
        throw new Error(
          `seedPersonaTenant: persona "${persona}" was not seeded for this tenant. ` +
            `Pass it in the "which" list, or drop the argument to seed the full set.`,
        );
      }
      return { authorization: `Bearer ${config.serviceToken}`, "x-user-id": userId };
    },
  };
}

/** Convenience for the DENY direction — asserts a 401/403, and fails loudly (naming the actual
 *  status) on anything else, so a persona that unexpectedly gets a 500 or a 200 is never mistaken
 *  for "correctly denied". */
export function isDeniedStatus(statusCode: number): boolean {
  return statusCode === 401 || statusCode === 403;
}
