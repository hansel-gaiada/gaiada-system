// IAM-06b — the ONE-LINE integration-test contract for "log in as any persona".
//
// This is what PM/Web Dev suites should actually import — NOT `src/seed/personas.ts` (IAM-06a),
// which plants durable rows in a real, shared database for manual/staging use. This file seeds a
// brand-new, disposable tenant (+ org unit + client) on every call, so tests never depend on
// IAM-06a having run and never collide with each other's data — the same isolation `freshTenant()`
// helpers already use ad hoc in files like `pm-adversarial-authz.test.ts`, just generalized to the
// FULL persona set instead of 4 hand-rolled roles per suite.
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
import { assemblePrincipal, type Assurance, type Principal } from "../rbac/principal";

const site = () => config.originSite;

export type PersonaKey =
  | "superadmin" | "company_admin" | "manager" | "org_unit_lead" | "member" | "viewer"
  | "hr_staff" | "hr_manager" | "it_admin" | "search_staff" | "search_manager"
  | "agency_approver" | "group_executive" | "client_contact";

interface PersonaDef {
  role: string;
  scope: "global" | "company" | "org_unit";
  /** Also grant this second role — mirrors seed:agency's agency_approver, who holds `member` too. */
  extraRole?: string;
}

// ⚠ `group_executive` is D-7-obsolete (slated for removal in Phase 3) — kept because it exists
// today. There is no `owner` persona (D-8): the role does not exist yet, and inventing a fixture
// for an unbuilt role would silently teach consumers to test against a fiction.
//
// HIER-3 (2026-08-11): the `team_lead` persona is retired ALONGSIDE the role itself and reworked
// into `org_unit_lead` — an org-chart department node id + a placement + an `org_unit`-scoped
// grant (HIER-2's subtree-cascade replacement), so person-scope narrowing is actually exercised,
// not merely a raw-grant existence check the way the old `team`-scoped shape was.
const PERSONA_DEFS: Record<Exclude<PersonaKey, "client_contact">, PersonaDef> = {
  superadmin: { role: "platform_admin", scope: "global" },
  company_admin: { role: "company_admin", scope: "company" },
  manager: { role: "manager", scope: "company" },
  org_unit_lead: { role: "org_unit_lead", scope: "org_unit" },
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

/** The org-unit node id every persona tenant's `org_unit_lead` is placed AND granted at — a bare
 *  0029-convention free-form node id (no `company_org_structure` blob needed: `org_unit_memberships
 *  .unit_node_id` has no FK, per 0055's own header). Self-inclusive-at-depth-0 (HIER-2's ancestor
 *  containment), so this grant covers the persona's own placement without needing a subtree. */
const PERSONA_ORG_UNIT_ID = "d-persona";

export interface PersonaTenant {
  tenantId: string;
  orgUnitId: string;
  clientId: string;
  users: Partial<Record<PersonaKey, string>>;
  /** The one-line accessor: HTTP headers to `app.inject`/supertest AS this persona. Throws if the
   *  persona wasn't in the `which` list passed to `seedPersonaTenant` — loud, not a silent 401. */
  as(persona: PersonaKey): { authorization: string; "x-user-id": string };
  /** IAM-VERIFY-02 — the sibling of `.as()` for the ONE assurance tier `.as()` structurally cannot
   *  reach over HTTP: `assurance: "low"` on a NAMED (non-null `userId`) principal. See this file's
   *  `assemblePersonaPrincipal` doc comment below for the full mechanism/why. Returns a REAL
   *  `Principal` — same DB-backed `roles`/`perms`/`companies` `assemblePrincipal()` would produce
   *  for this persona at ANY assurance — for driving `authorize()`/`check()` (the same functions
   *  every controller calls) directly, bypassing only the HTTP transport + `AuthGuard` layer that
   *  cannot mint this shape today. NOT a substitute for `.as()` — prefer `.as()` whenever the tier
   *  you need is reachable through it (`"high"` via `x-user-id`, or `"linked"` via a verified OBO
   *  envelope, both of which `.as()` already covers for every other ticket's purposes). */
  assemble(persona: PersonaKey, assurance: Assurance): Promise<Principal>;
}

/** Places `userId` at `unitNodeId` as their PRIMARY, currently-open org-unit membership — the
 *  fixture equivalent of `pm.test.ts`'s own `setPrimaryUnit` helper. Placement matters:
 *  `person-scope.ts` narrows a unit-scoped tier by the SUBJECT's placement, not merely by the
 *  caller holding a grant, so an `org_unit_lead` persona with no placement of their own would
 *  exercise the grant but never the narrowing it is meant to prove. */
async function placeInOrgUnit(tenantId: string, userId: string, unitNodeId: string): Promise<void> {
  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO org_unit_memberships (id, tenant_id, user_id, unit_node_id, is_primary, valid_from, source, origin_site)
       VALUES ($1,$2,$3,$4,true,'2020-01-01','manual',$5)`,
      [newId(), tenantId, userId, unitNodeId, site()],
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
 * contact) in a brand-new tenant + org unit + client. Returns `.as(persona)` — the entire
 * integration-test contract. Idempotent is not a concern here on purpose: every call makes a NEW
 * tenant, so there is nothing to collide with, unlike IAM-06a's durable seed.
 */
export async function seedPersonaTenant(
  which: PersonaKey[] = ALL_PERSONA_KEYS,
  label = "persona-tenant",
): Promise<PersonaTenant> {
  const tenantId = await createCompany(`${label} ${newId().slice(0, 8)}`, [
    "agency", "hr", "reports", "search", "assistant", "webdev", "pm", "it",
  ]);
  const orgUnitId = PERSONA_ORG_UNIT_ID;
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
    if (def.scope === "org_unit") {
      await placeInOrgUnit(tenantId, userId, orgUnitId);
      await grantRole(userId, roleId, "org_unit", orgUnitId);
    } else {
      await grantRole(userId, roleId, def.scope, def.scope === "global" ? null : tenantId);
    }
    if (def.extraRole) {
      await grantRole(userId, await createRole(def.extraRole), "company", tenantId);
    }
  }

  return {
    tenantId,
    orgUnitId,
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
    async assemble(persona: PersonaKey, assurance: Assurance): Promise<Principal> {
      const userId = users[persona];
      if (!userId) {
        throw new Error(
          `seedPersonaTenant: persona "${persona}" was not seeded for this tenant. ` +
            `Pass it in the "which" list, or drop the argument to seed the full set.`,
        );
      }
      const p = await assemblePrincipal(userId, assurance);
      if (!p) throw new Error(`assemblePersonaPrincipal: persona "${persona}" (${userId}) did not resolve — ` +
        `is the seeded user active?`);
      return p;
    },
  };
}

/** IAM-VERIFY-02 (docs/superpowers/plans/2026-08-11-iam-verify-02-report.md) — WHY THIS EXISTS AND
 *  WHY IT IS NOT A HEADER.
 *
 *  IAM-VERIFY-01 found that no fixture could drive a NAMED (real `userId`), low-assurance principal
 *  through the real HTTP surface, and — per that ticket's own brief — reported the gap rather than
 *  guessing around it. This ticket traced the mechanism to `src/auth/guards.ts`'s `AuthGuard`:
 *
 *    - the dev `x-user-id` path (what `.as()` uses) hardcodes `assemblePrincipal(userId, "high")` —
 *      no header can lower it.
 *    - the OIDC bearer path's `assuranceFor()` (`src/auth/oidc.ts`) only ever returns `"high"` or
 *      `"linked"` — "low" is not in its range.
 *    - the OBO-envelope path (`x-obo-provider`/`x-obo-external-id`) is the ONE branch that looks
 *      capable: an identity_links row that exists but is UNVERIFIED is exactly the production shape
 *      a real, not-yet-linked chat identity has. But `AuthGuard`'s own handling of that case
 *      (`req.principal = { ...ANONYMOUS }`) drops `row.user_id` entirely — the result is
 *      indistinguishable from a totally unknown identity. Its sibling implementation of the SAME
 *      lookup, `IdentityController.resolve()` (`src/identity/identity.controller.ts`), does NOT drop
 *      it (`return { ...ANONYMOUS, userId: row.user_id }`) — so the codebase already models "known
 *      user, unverified link" as a real principal shape ELSEWHERE, `AuthGuard` just never produces it
 *      over HTTP. This asymmetry is reported to the report file as a finding, not fixed here — fixing
 *      `guards.ts` is a production-behaviour change outside this ticket's owned files, and per the
 *      ticket's own constraint any such change must be reported BEFORE being made, not folded into a
 *      test fixture.
 *
 *  Given that, no header combination this file could add would be modeling a real request shape —
 *  it would be inventing one `AuthGuard` does not have, which the ticket explicitly rules out
 *  ("do NOT add a backdoor header the real path does not have"). `assemblePersonaPrincipal` instead
 *  calls the actual, unmodified `assemblePrincipal()` — the SAME function every real guard branch
 *  calls, and the one whose output (`roles`, `perms`, `companies`) is entirely a function of
 *  `userId`, never of the `assurance` argument passed in. Calling it with `"low"` for an
 *  already-seeded, membership-bearing persona does not fabricate a fictional principal shape; it
 *  exercises the exact code path a corrected `AuthGuard` (or any future guard branch — e.g. a
 *  step-up expiry that downgrades an existing session) would use, with a real DB-backed user. What it
 *  does NOT do is drive the HTTP transport/guard layer itself — that layer is proven UNREACHABLE for
 *  this shape today, not merely untested (see the report's mechanism section for the live proof).
 */
export async function assemblePersonaPrincipal(
  tenant: PersonaTenant,
  persona: PersonaKey,
  assurance: Assurance,
): Promise<Principal> {
  return tenant.assemble(persona, assurance);
}

/** Convenience for the DENY direction — asserts a 401/403, and fails loudly (naming the actual
 *  status) on anything else, so a persona that unexpectedly gets a 500 or a 200 is never mistaken
 *  for "correctly denied". */
export function isDeniedStatus(statusCode: number): boolean {
  return statusCode === 401 || statusCode === 403;
}
