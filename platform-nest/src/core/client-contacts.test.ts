// W0-2 — the two deliberate edits that make client_contacts (migration 0072) actually do something:
//   1. rbac/principal.ts unions client_contacts into `principal.companies`, which is what makes
//      resource_portal.yaml's `variables.inTenant` hold for an external contact.
//   2. core/http.ts notify() accepts a client contact as a valid recipient.
//
// BOTH failures are SILENT, which is why they get a suite of their own rather than a line in an
// existing one. A missing tenant means the portal refuses everything with no explanation; a dropped
// notification returns success at the call site and writes nothing. Neither shows up as an error, so
// only an assertion can hold them.
//
// Every test here also serves as the negative control for the leak the design rejected: a client
// contact must NOT become visible as staff.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withGlobal, withTenants, newId } from "../db";
import { config } from "../config";
import { assemblePrincipal } from "../rbac/principal";
import { notify } from "./http";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../testing/fixtures";

async function addClientContact(
  tenantId: string,
  clientId: string,
  userId: string,
  opts: { status?: string; capability?: string; projectId?: string | null } = {},
): Promise<string> {
  const id = newId();
  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, tenantId, clientId, userId, opts.projectId ?? null, opts.capability ?? "viewer", opts.status ?? "active", config.originSite],
    ),
  );
  return id;
}

describe.skipIf(!TEST_URL)("W0: client contacts — principal tenants + notifications", () => {
  let co: string;
  let other: string;
  let clientRow: string;
  let contact: string;
  let staff: string;
  let stranger: string;

  beforeAll(async () => {
    await initTestDb();
    co = await createCompany("Gaiada Creative");
    other = await createCompany("Rival Co");
    staff = await createUser("staff@cc.test");
    contact = await createUser("contact@client.test");
    stranger = await createUser("stranger@nowhere.test");
    await addMembership(co, staff);
    clientRow = await createClient(co, "Bali Beach Resort");
    await addClientContact(co, clientRow, contact, { capability: "signer" });
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  // ---- 1. principal.companies ----

  it("gives an external client contact the tenant (this is what makes inTenant hold)", async () => {
    const p = await assemblePrincipal(contact, "linked");
    expect(p).not.toBeNull();
    expect(p!.companies).toContain(co);
  });

  it("does NOT give them any other tenant", async () => {
    const p = await assemblePrincipal(contact, "linked");
    expect(p!.companies).not.toContain(other);
  });

  it("still resolves staff via company_memberships (the union did not break the existing path)", async () => {
    const p = await assemblePrincipal(staff, "high");
    expect(p!.companies).toContain(co);
  });

  it("gives a user with neither identity no tenants at all", async () => {
    const p = await assemblePrincipal(stranger, "high");
    expect(p!.companies).toEqual([]);
  });

  it("a REVOKED contact loses the tenant (revocation must actually revoke)", async () => {
    const revoked = await createUser("revoked@client.test");
    await addClientContact(co, clientRow, revoked, { status: "revoked" });
    const p = await assemblePrincipal(revoked, "linked");
    expect(p!.companies).toEqual([]);
  });

  it("an INVITED-but-not-yet-accepted contact has no tenant yet", async () => {
    const invited = await createUser("invited@client.test");
    await addClientContact(co, clientRow, invited, { status: "invited" });
    const p = await assemblePrincipal(invited, "linked");
    expect(p!.companies).toEqual([]);
  });

  it("does not duplicate the tenant when someone is BOTH staff and a client contact", async () => {
    // Contrived but reachable: an agency person listed as a stakeholder on their own client's project.
    // UNION (not UNION ALL) is what keeps `companies` a set; a duplicate would be harmless for
    // inTenant but would quietly inflate anything that counts tenants.
    const both = await createUser("both@cc.test");
    await addMembership(co, both);
    await addClientContact(co, clientRow, both, {});
    const p = await assemblePrincipal(both, "high");
    expect(p!.companies.filter((t) => t === co)).toHaveLength(1);
  });

  // ---- 2. notify() ----

  async function notifCount(userId: string): Promise<number> {
    const r = await adminPool().query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1`, [userId]);
    return r.rows[0].n as number;
  }

  it("delivers a notification to a client contact (previously dropped SILENTLY)", async () => {
    const before = await notifCount(contact);
    await notify(co, contact, staff, "pipeline.gate.opened", { title: "Scope ready for your signature" });
    expect(await notifCount(contact)).toBe(before + 1);
  });

  it("still delivers to staff (the union did not break the existing path)", async () => {
    const before = await notifCount(staff);
    await notify(co, staff, contact, "pipeline.gate.decided", { title: "Client signed" });
    expect(await notifCount(staff)).toBe(before + 1);
  });

  it("still drops a recipient who belongs to NEITHER identity", async () => {
    // The membership check is a real control, not an obstacle — widening it must not turn it off.
    const before = await notifCount(stranger);
    await notify(co, stranger, staff, "pipeline.gate.opened", {});
    expect(await notifCount(stranger)).toBe(before);
  });

  it("drops a notification to a REVOKED contact", async () => {
    const gone = await createUser("gone@client.test");
    await addClientContact(co, clientRow, gone, { status: "revoked" });
    const before = await notifCount(gone);
    await notify(co, gone, staff, "pipeline.gate.opened", {});
    expect(await notifCount(gone)).toBe(before);
  });

  // ---- 3. the leak this design exists to prevent ----

  it("a client contact is NOT a company_membership — so no staff listing can see them", async () => {
    // The whole reason clients live in their own table: every staff surface reads
    // company_memberships, and only 6 of 27 such queries filter `kind`. If a contact ever acquires a
    // membership row, this assertion is the thing that notices before /people does.
    const r = await adminPool().query(
      `SELECT count(*)::int AS n FROM company_memberships WHERE user_id = $1`,
      [contact],
    );
    expect(r.rows[0].n).toBe(0);
  });

  it("client_contacts is tenant-isolated: a rival tenant reads nothing", async () => {
    const rows = await withTenants([other], (c) => c.query(`SELECT id FROM client_contacts`));
    expect(rows.rowCount).toBe(0);
  });

  it("principal_lookup exposes only the resolved user, not every contact", async () => {
    // Mirrors how assemblePrincipal reads: the principal GUC set, NO tenant GUC. A second contact
    // must stay invisible, or principal assembly would be a cross-tenant read primitive.
    const someoneElse = await createUser("someone-else@client.test");
    await addClientContact(co, clientRow, someoneElse, {});
    const rows = await withGlobal(async (c) => {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.principal_user_id', $1, true)", [contact]);
      const res = await c.query<{ user_id: string }>(`SELECT user_id FROM client_contacts`);
      await c.query("ROLLBACK");
      return res;
    });
    expect(rows.rows.every((r) => r.user_id === contact)).toBe(true);
  });
});
