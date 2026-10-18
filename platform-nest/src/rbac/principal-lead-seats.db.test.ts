// DW-10g-2 Part B (docs/PERMISSION-CONTRACT.md §50) — the principal's `org_unit_lead` grants carry `tenantIds`, the companies
// whose OWN lead seat backs them, read by `assemblePrincipal()` through the seat tables' `principal_lookup` policies (migration
// 202610180911). Driven as the APP role (NOSUPERUSER NOBYPASSRLS: the harness repoints the pool, so `withGlobal` here is exactly
// what production runs). Never through `adminPool()` for a read under test: a superuser bypasses RLS and would prove nothing.
//
// What would go wrong silently, and is pinned here:
//   * FAIL-CLOSED: the read sees ZERO seats (a missing or broken policy, an unset GUC) -> every grant gets `tenantIds: []` -> every
//     `org_unit_lead` rule in Cerbos stops matching, with no error. (a) proves the real head gets their company.
//   * FAIL-OPEN: the policy exposes more than the principal's own open assignments. (b) proves another user's seats, an ENDED
//     assignment and a seat in a company the user is not a member of never reach the principal; (c) that an unset GUC reads zero.
//   * A STALE PRINCIPAL: nothing caches an assembled principal (the AuthGuard assembles on every request, `auth/guards.ts`,
//     `auth/oidc.ts`); (d) proves a seat change is seen by the very next assembly.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withGlobal } from "../db";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { addMembership, createCompany, createRole, createUser, grantLeadSeat, grantRole } from "../testing/fixtures";
import { assemblePrincipal } from "./principal";
import { principalPayload } from "./cerbos";

describe.skipIf(!TEST_URL)("DW-10g-2 assemblePrincipal() resolves the companies that back an org_unit_lead grant (app role)", () => {
  let H: string; let P: string; let X: string;
  let head: string; // member of H and P; org_unit_lead d-web; a seat on d-web in H only
  let other: string; // member of H; org_unit_lead d-web; a seat on d-seo in H (NOT d-web)
  let ended: string; // member of H; org_unit_lead d-web; their seat's assignment ENDED
  let stranger: string; // member of H only; org_unit_lead d-web; a seat on d-web in X, where they are NOT a member
  let manager: string; // a company manager: no org_unit_lead grant, so no tenantIds at all

  const leadOf = async (userId: string) => {
    const p = await assemblePrincipal(userId, "high");
    expect(p).toBeTruthy();
    return p!.roles.filter((g) => g.role === "org_unit_lead");
  };

  beforeAll(async () => {
    await initTestDb();
    H = await createCompany("Lead Seats H");
    P = await createCompany("Lead Seats P");
    X = await createCompany("Lead Seats X");
    head = await createUser("seat-head@lead-seats.test");
    other = await createUser("seat-other@lead-seats.test");
    ended = await createUser("seat-ended@lead-seats.test");
    stranger = await createUser("seat-stranger@lead-seats.test");
    manager = await createUser("seat-manager@lead-seats.test");
    const lead = await createRole("org_unit_lead");
    const member = await createRole("member");
    for (const [u, ts] of [[head, [H, P]], [other, [H]], [ended, [H]], [stranger, [H]], [manager, [H]]] as const) {
      for (const t of ts) {
        await addMembership(t, u);
        await grantRole(u, member, "company", t);
      }
    }
    for (const u of [head, other, ended, stranger]) await grantRole(u, lead, "org_unit", "d-web");
    await grantRole(manager, await createRole("manager"), "company", H);
    await grantLeadSeat(H, "d-web", head);
    await grantLeadSeat(H, "d-seo", other);
    await grantLeadSeat(H, "d-web", ended, { ended: true });
    await grantLeadSeat(X, "d-web", stranger);
  });
  afterAll(teardownTestDb);

  it("(a) a head's org_unit_lead grant carries the company whose own seat backs it, and principalPayload sends it to Cerbos", async () => {
    expect(await leadOf(head)).toEqual([{ role: "org_unit_lead", scopeType: "org_unit", scopeId: "d-web", tenantIds: [H] }]);
    const p = await assemblePrincipal(head, "high");
    const sent = (principalPayload(p!).attr.grants as Array<Record<string, unknown>>).find((g) => g.role === "org_unit_lead");
    expect(sent).toEqual({ role: "org_unit_lead", scopeType: "org_unit", scopeId: "d-web", tenantIds: [H] });
    // P: a member there too, but no seat there -> P is NOT in the list (the cross-company case)
    expect((await leadOf(head))[0].tenantIds).not.toContain(P);
  });

  it("the ROLE ROW is the source of lead power: a role row on a position without is_lead is a head; is_lead without the role row is not", async () => {
    const roleOnly = await createUser("seat-role-only@lead-seats.test");
    const titleOnly = await createUser("seat-title-only@lead-seats.test");
    for (const u of [roleOnly, titleOnly]) {
      await addMembership(H, u);
      await grantRole(u, await createRole("org_unit_lead"), "org_unit", "d-fin");
    }
    await grantLeadSeat(H, "d-fin", roleOnly, { isLead: false }); // what the position reconciler grants from
    await grantLeadSeat(H, "d-fin", titleOnly, { noRole: true }); // display only
    expect((await leadOf(roleOnly))[0].tenantIds).toEqual([H]);
    expect((await leadOf(titleOnly))[0].tenantIds).toEqual([]);
  });

  it("(b) only the principal's OWN OPEN assignments count: a seat on another node, an ended assignment, a company they are not a member of", async () => {
    expect(await leadOf(other)).toEqual([{ role: "org_unit_lead", scopeType: "org_unit", scopeId: "d-web", tenantIds: [] }]);
    expect(await leadOf(ended)).toEqual([{ role: "org_unit_lead", scopeType: "org_unit", scopeId: "d-web", tenantIds: [] }]);
    expect(await leadOf(stranger)).toEqual([{ role: "org_unit_lead", scopeType: "org_unit", scopeId: "d-web", tenantIds: [] }]);
    // a principal with no org_unit_lead grant carries no tenantIds anywhere (the payload keeps its historical shape)
    const m = await assemblePrincipal(manager, "high");
    expect(m!.roles.some((g) => "tenantIds" in g)).toBe(false);
  });

  it("(b) through the principal_lookup path itself: with the GUC naming one user, another user's seats are invisible", async () => {
    const seen = await withGlobal(async (c) => {
      await c.query("BEGIN");
      try {
        await c.query("SELECT set_config('app.principal_user_id', $1, true)", [other]);
        const pa = await c.query<{ user_id: string }>(`SELECT user_id::text FROM position_assignments`);
        const pos = await c.query<{ unit_node_id: string }>(`SELECT unit_node_id FROM positions ORDER BY unit_node_id`);
        const roles = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM position_roles`);
        await c.query("COMMIT");
        return { users: pa.rows.map((r) => r.user_id), units: pos.rows.map((r) => r.unit_node_id), roleRows: roles.rows[0].n };
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      }
    });
    expect(seen.users).toEqual([other]);
    expect(seen.units).toEqual(["d-seo"]);
    expect(seen.roleRows).toBe(1);
    // the superuser view, for contrast: the seats really exist (so the zeros above are the policy, not an empty table)
    expect(Number((await adminPool().query(`SELECT count(*) AS n FROM position_assignments`)).rows[0].n)).toBeGreaterThanOrEqual(4);
  });

  it("(c) with the GUC unset, the seat tables read zero rows (never an error)", async () => {
    const counts = await withGlobal(async (c) => {
      const n = async (t: string) => (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
      return { pa: await n("position_assignments"), p: await n("positions"), pr: await n("position_roles") };
    });
    expect(counts).toEqual({ pa: 0, p: 0, pr: 0 });
  });

  it("(d) nothing caches the principal: closing the seat's assignment is seen by the very next assembly", async () => {
    const late = await createUser("seat-late@lead-seats.test");
    await addMembership(H, late);
    await grantRole(late, await createRole("org_unit_lead"), "org_unit", "d-ops");
    const pos = await grantLeadSeat(H, "d-ops", late);
    expect((await leadOf(late))[0].tenantIds).toEqual([H]);
    await adminPool().query(`UPDATE position_assignments SET valid_to = current_date WHERE position_id = $1`, [pos]);
    expect((await leadOf(late))[0].tenantIds).toEqual([]);
  });
});
