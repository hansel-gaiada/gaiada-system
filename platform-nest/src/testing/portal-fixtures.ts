// Shared PORTAL fixtures for the portal HTTP suites (real Postgres + RLS + Cerbos; the Linux gate).
//
// THE MULTI-CLIENT CONTACT (portal scope kernel per client, 2026-10-13). One person who is a portal contact
// of TWO clients of the same agency, with a DIFFERENT reach and capability on each:
//   * client A: client-wide (`project_id IS NULL`) `signer`;
//   * client B: `viewer` limited to ONE project, B1. B also has a second project, B2, and a client-wide
//     ("General") conversation thread, which this contact must never reach.
// The portal used to flatten a contact's rows across clients, so this person saw every project of B and could
// sign B's agreements. Any suite that adds a portal read or a signing route should drive it with this contact:
// A must be fully visible and signable, B visible only through B1 (plus B's project-less contracts and change
// requests, which admit a project-scoped contact of that client), and nothing of B signable.
//
// Usage:
//   const m = await createMultiClientContact(co, { tag: "my-suite", staffUserId: admin });
//   app.inject({ ..., headers: { authorization: "Bearer svc-token", "x-user-id": m.userId } })
// The tenant must already exist; the caller owns `config.serviceToken` and the app, as every portal suite does.
import { newId, withGlobal, withTenants } from "../db";
import { config } from "../config";
import { addMembership, createClient, createProject, createRole, createUser, grantRole } from "./fixtures";

export interface MultiClientContact {
  /** The contact's user id (users.kind = 'client', `client` role at company scope, a member of the tenant). */
  userId: string;
  /** Client A: the contact is a client-wide SIGNER here. */
  clientA: string;
  /** A's one project. */
  projectA: string;
  /** Client B: the contact is a VIEWER limited to projectB1 here. */
  clientB: string;
  /** B's project the contact IS scoped to. */
  projectB1: string;
  /** B's project the contact is NOT scoped to. */
  projectB2: string;
  /** A's client-wide ("General") conversation thread: visible to the contact. */
  generalThreadA: string;
  /** B's client-wide ("General") conversation thread: never visible to the contact (PV4-Q1). */
  generalThreadB: string;
}

/** Create the multi-client contact and everything their scope is defined by (two clients, three projects,
 *  two contact rows, two General threads). `tag` keeps emails and names unique when a suite makes several;
 *  `staffUserId` owns the projects and opens the threads (a staff member of the tenant). */
export async function createMultiClientContact(
  tenantId: string,
  opts: { tag: string; staffUserId: string },
): Promise<MultiClientContact> {
  const site = config.originSite;
  const userId = await createUser(`multi-${opts.tag}@portal-fixture.test`, `Multi ${opts.tag}`);
  await addMembership(tenantId, userId);
  await grantRole(userId, await createRole("client"), "company", tenantId);
  await withGlobal((c) => c.query(`UPDATE users SET kind = 'client' WHERE id = $1`, [userId]));

  const clientA = await createClient(tenantId, `Multi ${opts.tag} A`);
  const clientB = await createClient(tenantId, `Multi ${opts.tag} B`);
  const projectA = await createProject(tenantId, `Multi ${opts.tag} A project`, opts.staffUserId);
  const projectB1 = await createProject(tenantId, `Multi ${opts.tag} B1 project`, opts.staffUserId);
  const projectB2 = await createProject(tenantId, `Multi ${opts.tag} B2 project`, opts.staffUserId);
  const generalThreadA = newId();
  const generalThreadB = newId();

  await withTenants([tenantId], async (c) => {
    await c.query(`UPDATE projects SET client_id = $2 WHERE id = $1`, [projectA, clientA]);
    await c.query(`UPDATE projects SET client_id = $2 WHERE id = ANY($1::uuid[])`, [[projectB1, projectB2], clientB]);
    const contact = (clientId: string, projectId: string | null, capability: string) =>
      c.query(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, activated_at, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', now(), $7)`,
        [newId(), tenantId, clientId, userId, projectId, capability, site],
      );
    await contact(clientA, null, "signer");
    await contact(clientB, projectB1, "viewer");
    const general = (id: string, clientId: string) =>
      c.query(
        `INSERT INTO conversation_threads (id, tenant_id, client_id, project_id, subject, created_by, created_side, origin_site)
         VALUES ($1, $2, $3, NULL, 'General', $4, 'staff', $5)`,
        [id, tenantId, clientId, opts.staffUserId, site],
      );
    await general(generalThreadA, clientA);
    await general(generalThreadB, clientB);
  });

  return { userId, clientA, projectA, clientB, projectB1, projectB2, generalThreadA, generalThreadB };
}
