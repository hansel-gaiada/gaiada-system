// DW-7i-1 (PERMISSION §42a) — the failing-workflows audience rule against real seats, org tree and module flags.
// Each passing kind (platform operator, owner, the GM unit's seated lead, a Project Manager seat) and each refused kind (IT admin,
// company_admin, manager, member, a non-lead seat in the GM unit, the lead of another unit, an ended or retired seat, a seat in
// another company, and anyone in a company with the module off).
//
// ⚠ Needs DATABASE_URL_TEST (CI only: no local Postgres). Skips silently otherwise.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { config } from "../config";
import { newId, withGlobal, withTenants } from "../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser } from "../testing/fixtures";
import type { Principal } from "../rbac/principal";
import { automationFailuresAccess, canSeeAutomationFailures } from "./automation-failures-audience";

const grant = (role: string, scopeType: "global" | "company", scopeId: string | null) => ({ role, scopeType, scopeId });
const asPrincipal = (userId: string, companies: string[], roles: Principal["roles"]): Principal => ({
  userId, assurance: "high", companies, roles, sessionVersion: 0,
});

describe.skipIf(!TEST_URL)("automation failures audience (live PG)", () => {
  let on: string; // automation-console enabled, vertical agency
  let off: string; // module off, with the same seats
  let other: string; // module on, a second company
  const u: Record<string, string> = {};

  async function structure(tenant: string): Promise<void> {
    const root = {
      id: `root-${tenant}`, name: "Root", kind: "company", assigneeId: null, assigneeName: null,
      children: [
        { id: "d-gm", name: "GM", kind: "department", assigneeId: null, assigneeName: null, children: [] },
        { id: "d-web", name: "Web Dev", kind: "department", assigneeId: null, assigneeName: null, children: [] },
      ],
    };
    await withTenants([tenant], (c) =>
      c.query(`INSERT INTO company_org_structure (tenant_id, structure, origin_site) VALUES ($1,$2,$3)`, [tenant, JSON.stringify({ root }), config.originSite]),
    );
  }

  async function seat(
    tenant: string, unit: string, title: string, isLead: boolean, holder: string | null,
    opts: { status?: string; from?: string; to?: string | null } = {},
  ): Promise<void> {
    const id = newId();
    await withTenants([tenant], async (c) => {
      await c.query(`INSERT INTO positions (id, tenant_id, unit_node_id, title, is_lead, status) VALUES ($1,$2,$3,$4,$5,$6)`, [
        id, tenant, unit, title, isLead, opts.status ?? "active",
      ]);
      if (holder) {
        await c.query(
          `INSERT INTO position_assignments (tenant_id, position_id, user_id, valid_from, valid_to)
           VALUES ($1,$2,$3, COALESCE($4::date, current_date), $5::date)`,
          [tenant, id, holder, opts.from ?? null, opts.to ?? null],
        );
      }
    });
  }

  beforeAll(async () => {
    await initTestDb();
    on = await createCompany("DW-7i-1 On", ["automation-console"]);
    off = await createCompany("DW-7i-1 Off", []);
    other = await createCompany("DW-7i-1 Other", ["automation-console"]);
    await withGlobal((c) => c.query(`UPDATE companies SET vertical = 'agency' WHERE id = ANY($1::uuid[])`, [[on, off, other]]));
    for (const t of [on, off, other]) await structure(t);

    for (const n of ["gm", "gmNonLead", "webLead", "gmEnded", "gmRetired", "pm", "pmVacantHolder", "pmOther", "owner", "ownerOff", "it", "admin", "manager", "member", "gmOff", "operator"]) {
      u[n] = await createUser(`${n}@dw7i1.test`);
    }
    // the GM: lead seat of the GM unit
    await seat(on, "d-gm", "General Manager", true, u.gm);
    await seat(off, "d-gm", "General Manager", true, u.gmOff);
    // refused seats in the GM unit / elsewhere
    await seat(on, "d-gm", "GM Analyst", false, u.gmNonLead);
    await seat(on, "d-web", "Head of Web Dev", true, u.webLead);
    await seat(on, "d-gm", "Former GM", true, u.gmEnded, { from: "2026-01-01", to: "2026-01-31" });
    await seat(on, "d-gm", "Retired GM seat", true, u.gmRetired, { status: "retired" });
    // the PM: a seat titled Project Manager (any unit, any casing)
    await seat(on, "d-web", "  project   MANAGER ", false, u.pm);
    await seat(other, "d-web", "Project Manager", false, u.pmOther); // a PM of ANOTHER company
    await seat(on, "d-web", "Assistant Project Manager", false, u.pmVacantHolder);
    // a vacant PM seat matches nobody
    await seat(on, "d-gm", "Project Manager", false, null);
  }, 120_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  it("a platform operator passes anywhere, even where the module is off", async () => {
    const p = asPrincipal(u.operator, [], [grant("platform_admin", "global", null)]);
    expect(await canSeeAutomationFailures(p, on)).toBe(true);
    expect(await canSeeAutomationFailures(p, off)).toBe(true);
  });

  it("the owner of a company with the module on passes; the owner where it is off does not (module_off)", async () => {
    expect(await canSeeAutomationFailures(asPrincipal(u.owner, [on], [grant("owner", "company", on)]), on)).toBe(true);
    const offOwner = asPrincipal(u.ownerOff, [off], [grant("owner", "company", off)]);
    expect(await canSeeAutomationFailures(offOwner, off)).toBe(false);
    expect(await automationFailuresAccess(offOwner, off)).toBe("module_off");
  });

  it("an owner of one company does not pass in another", async () => {
    const p = asPrincipal(u.owner, [on], [grant("owner", "company", on)]);
    expect(await automationFailuresAccess(p, other)).toBe("not_in_audience");
  });

  it("the seated lead of the GM unit passes", async () => {
    expect(await canSeeAutomationFailures(asPrincipal(u.gm, [on], []), on)).toBe(true);
  });

  it("the holder of a Project Manager seat passes, whatever its casing or spacing", async () => {
    expect(await canSeeAutomationFailures(asPrincipal(u.pm, [on], []), on)).toBe(true);
  });

  it("refuses a non-lead seat in the GM unit, the lead of another unit, an ended seat and a retired seat", async () => {
    for (const n of ["gmNonLead", "webLead", "gmEnded", "gmRetired"]) {
      expect(await automationFailuresAccess(asPrincipal(u[n], [on], []), on), n).toBe("not_in_audience");
    }
  });

  it("an Assistant Project Manager is not the Project Manager, and a PM of another company is not ours", async () => {
    expect(await automationFailuresAccess(asPrincipal(u.pmVacantHolder, [on], []), on)).toBe("not_in_audience");
    expect(await automationFailuresAccess(asPrincipal(u.pmOther, [other], []), on)).toBe("not_in_audience");
  });

  it("a GM seat where the module is off does not pass (module_off)", async () => {
    expect(await automationFailuresAccess(asPrincipal(u.gmOff, [off], []), off)).toBe("module_off");
  });

  it("IT staff, company_admin, manager and member do NOT pass on their grants alone", async () => {
    const cases: Array<[string, string]> = [["it", "it_admin"], ["it", "it_manager"], ["it", "it"], ["admin", "company_admin"], ["manager", "manager"], ["member", "member"]];
    for (const [who, role] of cases) {
      expect(await automationFailuresAccess(asPrincipal(u[who], [on], [grant(role, "company", on)]), on), role).toBe("not_in_audience");
    }
  });

  it("a principal with no user id, and a client, are refused", async () => {
    expect(await canSeeAutomationFailures({ ...asPrincipal(u.gm, [on], []), userId: null }, on)).toBe(false);
    expect(await canSeeAutomationFailures({ ...asPrincipal(u.gm, [on], []), kind: "client" }, on)).toBe(false);
  });
});
