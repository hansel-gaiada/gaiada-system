// DW-D29 (BFF §48a, PERMISSION-CONTRACT §40a): `GET /api/:t/time-entries` read by person-axis tier, over the real HTTP surface
// against live Postgres + RLS + Cerbos. Before DW-D29 every staff role with `time_entry` read got the whole company's entries.
//
// Rows are seeded by direct SQL so every owner and project is pinned exactly; the people sit in two units (d-a, d-b) by
// `org_unit_memberships`, which is all the unit_scoped narrowing reads (no org tree row needed: a missing tree degrades to
// the unit itself).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createProject } from "../testing/fixtures";
import { newId, withTenants } from "../db";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

interface Entry { id: string; user_id: string; project_id: string; minutes: number }

describe.skipIf(!TEST_URL)("GET /time-entries is read by person-axis tier (DW-D29)", () => {
  let app: NestFastifyApplication;
  let t: string;
  let rival: string;
  let p1: string;
  let p2: string;
  let a: string; // member, unit d-a
  let b: string; // member, unit d-a
  let head: string; // manager, unit d-a
  let c: string; // member, unit d-b
  let otherHead: string; // manager, unit d-b
  let viewer: string; // viewer, no unit
  let admin: string; // company_admin
  let hr: string; // hr_staff (+ member)
  let unitLead: string; // member + org_unit_lead on d-b, no primary unit
  let rivalAdmin: string;
  let rivalUser: string;
  const stranger = "00000000-0000-4000-8000-000000000001"; // a well-formed uuid that is nobody

  const seed = async (tenant: string, userId: string, projectId: string, minutes: number): Promise<void> => {
    await withTenants([tenant], (cl) =>
      cl.query(
        `INSERT INTO time_entries (id, tenant_id, user_id, project_id, minutes, billable, entry_date, notes, origin_site)
         VALUES ($1, $2, $3, $4, $5, false, '2026-10-01', 'tier test', 'central')`,
        [newId(), tenant, userId, projectId, minutes],
      ),
    );
  };
  const setUnit = (tenant: string, userId: string, unit: string) =>
    withTenants([tenant], (cl) =>
      cl.query(
        `INSERT INTO org_unit_memberships (id, tenant_id, user_id, unit_node_id, is_primary, valid_from, source, origin_site)
         VALUES ($1, $2, $3, $4, true, '2020-01-01', 'manual', 'central')`,
        [newId(), tenant, userId, unit],
      ),
    );
  const list = (qs: string, as: string, tenant = t) => app.inject({ method: "GET", url: `/api/${tenant}/time-entries${qs}`, headers: asUser(as) });
  const owners = (r: { json: () => unknown }): string[] => [...new Set((r.json() as Entry[]).map((e) => e.user_id))].sort();
  const sorted = (...ids: string[]) => [...ids].sort();

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    t = await createCompany("Time Tier Co", []);
    rival = await createCompany("Time Tier Rival Co", []);
    const mk = async (label: string, role: string, tenant = t) => {
      const u = await createUser(`${label}@time-tier.test`, label);
      await addMembership(tenant, u);
      await grantRole(u, await createRole(role), "company", tenant);
      return u;
    };
    a = await mk("a", "member");
    b = await mk("b", "member");
    head = await mk("head", "manager");
    c = await mk("c", "member");
    otherHead = await mk("otherhead", "manager");
    viewer = await mk("viewer", "viewer");
    admin = await mk("admin", "company_admin");
    hr = await mk("hr", "hr_staff");
    // HR's people readers also hold the everyday member grant (time_entry read is a member-level grant)
    await grantRole(hr, await createRole("member"), "company", t);
    // A head by the org_unit_lead GRANT on d-b (how live heads are seated), with no primary unit of their own and no entries.
    unitLead = await mk("unitlead", "member");
    await grantRole(unitLead, await createRole("org_unit_lead", null), "org_unit", "d-b");
    rivalAdmin = await mk("rivaladmin", "company_admin", rival);
    rivalUser = await mk("rivaluser", "member", rival);
    await setUnit(t, a, "d-a");
    await setUnit(t, b, "d-a");
    await setUnit(t, head, "d-a");
    await setUnit(t, c, "d-b");
    await setUnit(t, otherHead, "d-b");
    p1 = await createProject(t, "Tier P1");
    p2 = await createProject(t, "Tier P2");
    const rp = await createProject(rival, "Rival P");
    for (const u of [a, b, head, c, otherHead, viewer, admin, hr]) await seed(t, u, p1, 60);
    await seed(t, a, p2, 30); // a second project, a's only
    await seed(rival, rivalUser, rp, 45);
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  describe("self_only (a member, a viewer)", () => {
    it("a member's unfiltered list holds only their own rows, though colleagues logged time", async () => {
      const r = await list("", a);
      expect(r.statusCode).toBe(200);
      expect((r.json() as Entry[]).length).toBe(2); // 60 on p1 + 30 on p2
      expect(owners(r)).toEqual([a]);
    });

    it("a viewer's unfiltered list holds only their own row", async () => {
      const r = await list("", viewer);
      expect(r.statusCode).toBe(200);
      expect((r.json() as Entry[]).length).toBe(1);
      expect(owners(r)).toEqual([viewer]);
    });

    it("a member naming a colleague's userId is 403 outside your reporting line, even one in their own unit", async () => {
      for (const who of [b, c, head, stranger]) {
        const r = await list(`?userId=${who}`, a);
        expect(r.statusCode, who).toBe(403);
        expect(JSON.stringify(r.json())).toContain("outside your reporting line");
      }
    });

    it("naming yourself is your own entries; a non-uuid naming someone else is a 403, never a 400", async () => {
      const own = await list(`?userId=${a}`, a);
      expect(own.statusCode).toBe(200);
      expect(owners(own)).toEqual([a]);
      expect((await list("?userId=not-a-uuid", a)).statusCode).toBe(403);
      expect((await list("?userId=not-a-uuid", viewer)).statusCode).toBe(403);
    });

    it("mine=me is the caller's own entries", async () => {
      const r = await list("?mine=me", a);
      expect(r.statusCode).toBe(200);
      expect(owners(r)).toEqual([a]);
    });

    it("projectId still narrows inside what the caller may read", async () => {
      const r2 = await list(`?projectId=${p2}`, a);
      expect((r2.json() as Entry[]).length).toBe(1);
      expect(owners(r2)).toEqual([a]);
      const r1 = await list(`?projectId=${p1}`, a);
      expect((r1.json() as Entry[]).length).toBe(1); // only a's own row on p1, not the colleagues'
      expect(owners(r1)).toEqual([a]);
    });
  });

  describe("unit_scoped (a head)", () => {
    it("an unfiltered list holds own plus the led unit's people, and not a sibling unit's", async () => {
      const r = await list("", head);
      expect(r.statusCode).toBe(200);
      expect(owners(r)).toEqual(sorted(a, b, head));
      expect((r.json() as Entry[]).length).toBe(4); // a x2, b, head
      const other = await list("", otherHead);
      expect(owners(other)).toEqual(sorted(c, otherHead));
    });

    it("?userId of someone in the led unit is theirs; outside it is 403", async () => {
      const inUnit = await list(`?userId=${b}`, head);
      expect(inUnit.statusCode).toBe(200);
      expect(owners(inUnit)).toEqual([b]);
      for (const who of [c, otherHead, viewer, stranger]) {
        const r = await list(`?userId=${who}`, head);
        expect(r.statusCode, who).toBe(403);
        expect(JSON.stringify(r.json())).toContain("outside your reporting line");
      }
    });

    it("?userId of the head is their own; a non-uuid is a 400 naming the field", async () => {
      expect(owners(await list(`?userId=${head}`, head))).toEqual([head]);
      const bad = await list("?userId=not-a-uuid", head);
      expect(bad.statusCode).toBe(400);
      expect(bad.json()).toMatchObject({ field: "userId" });
    });

    it("a head by the org_unit_lead grant reads the granted unit's people, and no one outside it", async () => {
      const r = await list("", unitLead);
      expect(r.statusCode).toBe(200);
      expect(owners(r)).toEqual(sorted(c, otherHead));
      expect(owners(await list(`?userId=${c}`, unitLead))).toEqual([c]);
      const out = await list(`?userId=${a}`, unitLead);
      expect(out.statusCode).toBe(403);
      expect(JSON.stringify(out.json())).toContain("outside your reporting line");
    });

    it("mine=me is the head's own entries only", async () => {
      expect(owners(await list("?mine=me", head))).toEqual([head]);
    });

    it("projectId narrows within the led scope", async () => {
      const r = await list(`?projectId=${p1}`, head);
      expect(owners(r)).toEqual(sorted(a, b, head));
      expect((r.json() as Entry[]).length).toBe(3);
      const r2 = await list(`?projectId=${p2}`, head);
      expect(owners(r2)).toEqual([a]);
    });
  });

  describe("unrestricted and company_wide tiers", () => {
    it("a company admin and an HR people reader see everyone's entries, as before", async () => {
      for (const who of [admin, hr]) {
        const r = await list("", who);
        expect(r.statusCode, who).toBe(200);
        expect((r.json() as Entry[]).length, who).toBe(9);
        expect(owners(r), who).toEqual(sorted(a, b, head, c, otherHead, viewer, admin, hr));
      }
    });

    it("?userId=X is X's entries for them; a non-uuid is a 400", async () => {
      for (const who of [admin, hr]) {
        const r = await list(`?userId=${c}`, who);
        expect(r.statusCode, who).toBe(200);
        expect(owners(r), who).toEqual([c]);
        const bad = await list("?userId=not-a-uuid", who);
        expect(bad.statusCode, who).toBe(400);
        expect(bad.json(), who).toMatchObject({ field: "userId" });
      }
    });

    it("mine=me is their own entries, and projectId narrows", async () => {
      expect(owners(await list("?mine=me", admin))).toEqual([admin]);
      expect(owners(await list("?mine=me", hr))).toEqual([hr]);
      const r = await list(`?projectId=${p2}`, admin);
      expect((r.json() as Entry[]).length).toBe(1);
      expect(owners(r)).toEqual([a]);
    });
  });

  describe("tenancy", () => {
    it("the company wall holds: another company's entries never appear, for any tier", async () => {
      expect(owners(await list("", rivalAdmin, rival))).toEqual([rivalUser]);
      expect(owners(await list("", admin))).not.toContain(rivalUser);
      // a member of one company cannot read another's list at all
      expect((await list("", a, rival)).statusCode).toBe(403);
    });
  });
});
