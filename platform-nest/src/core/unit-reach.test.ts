// DW-10a (docs/FRONTEND-BFF-CONTRACT.md §57.2) — core/unit-reach.ts: the shared "placed in the unit's subtree today, or leads it, or is
// company-wide" predicate that `authorizeUnitRead` (department KPIs) and the notice board both use. Pure: the only I/O is two reads
// (the caller's primary placement and the org tree), faked here by a client that answers by SQL text. The same predicate over real
// Postgres is covered by dept-kpis.controller.db.test.ts (authorizeUnitRead, unchanged) and dept-notices.test.ts (the notice board).
import { describe, it, expect } from "vitest";
import type { PoolClient } from "pg";
import type { Principal, RoleGrant } from "../rbac/principal";
import { callerReachesUnit, isCompanyWide, loadLeadSeatUnits, loadUnitReach } from "./unit-reach";

const T = "aaaaaaaa-1010-0000-0000-000000000001";
const OTHER_T = "aaaaaaaa-1010-0000-0000-000000000002";
const ASOF = "2026-10-15";

// The real stored shape: `{ root: ... }`. Departments contain divisions.
const STRUCTURE = {
  root: {
    id: "d-corp", kind: "company", name: "Corp",
    children: [
      { id: "d-web", kind: "department", name: "Web Dev", children: [
        { id: "dv-fe", kind: "division", name: "Frontend", children: [] },
        { id: "dv-be", kind: "division", name: "Backend", children: [] },
      ] },
      { id: "d-seo", kind: "department", name: "SEO", children: [] },
      { id: "d-ops", kind: "department", name: "Operations", children: [] },
    ],
  },
};
const UNITS = ["d-corp", "d-web", "dv-fe", "dv-be", "d-seo", "d-ops", "d-unknown"];

/** A client that answers only the two reads the predicate makes, and counts them. */
function fakeClient(placement: string | null) {
  const calls: string[] = [];
  const client = {
    query: async (sql: string) => {
      calls.push(sql.includes("org_unit_memberships") ? "placement" : sql.includes("company_org_structure") ? "structure" : "other");
      if (sql.includes("org_unit_memberships")) return { rows: placement ? [{ unit_node_id: placement }] : [] };
      if (sql.includes("company_org_structure")) return { rows: [{ structure: STRUCTURE }] };
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as PoolClient;
  return { client, calls };
}

const co = (role: string, scopeId = T): RoleGrant => ({ role, scopeType: "company", scopeId });
const unitGrant = (role: string, scopeId: string): RoleGrant => ({ role, scopeType: "org_unit", scopeId });
const glob = (role: string): RoleGrant => ({ role, scopeType: "global", scopeId: null });
function principal(roles: RoleGrant[], userId: string | null = "u-me"): Principal {
  return { userId, assurance: "high", companies: [T], rootCompanies: [T], roles, perms: [], sessionVersion: 1 } as unknown as Principal;
}

/** What the predicate answers for every unit, for one caller placed at `placement`. */
async function reachMap(p: Principal, placement: string | null): Promise<Record<string, boolean>> {
  const { client } = fakeClient(placement);
  const out: Record<string, boolean> = {};
  for (const u of UNITS) out[u] = await callerReachesUnit(client, p, T, STRUCTURE, u, ASOF);
  return out;
}
const reachedUnits = (m: Record<string, boolean>) => Object.keys(m).filter((u) => m[u]).sort();

describe("DW-10a · isCompanyWide: the company-wide tiers", () => {
  it("platform_admin, company_admin, the HR tiers, the served reports tiers and owner OF THIS COMPANY", () => {
    for (const roles of [[glob("platform_admin")], [co("company_admin")], [co("hr_staff")], [co("hr_manager")], [co("reports_staff")], [co("reports_manager")], [co("owner")]]) {
      expect(isCompanyWide(principal(roles), T), JSON.stringify(roles)).toBe(true);
    }
  });
  it("not a plain member, viewer, manager or head, and not another company's admin or owner", () => {
    for (const roles of [[co("member")], [co("viewer")], [co("manager")], [unitGrant("org_unit_lead", "d-web")], [co("company_admin", OTHER_T)], [co("owner", OTHER_T)], []]) {
      expect(isCompanyWide(principal(roles), T), JSON.stringify(roles)).toBe(false);
    }
  });
});

describe("DW-10a · callerReachesUnit", () => {
  it("a company-wide caller reaches every unit and reads nothing (no placement or tree query)", async () => {
    const { client, calls } = fakeClient(null);
    for (const u of UNITS) expect(await callerReachesUnit(client, principal([co("company_admin")]), T, STRUCTURE, u, ASOF), u).toBe(true);
    expect(calls).toEqual([]);
  });

  it("a person placed in a unit reaches it AND every unit above it (placed in U or below U: a division's staff reach their department, never the reverse)", async () => {
    const member = principal([co("member")]);
    // placed in a division: the division, its department and the tree's root, and nothing beside or below
    expect(reachedUnits(await reachMap(member, "dv-fe"))).toEqual(["d-corp", "d-web", "dv-fe"]);
    // placed in the department: the department and the root, NOT its divisions
    expect(reachedUnits(await reachMap(member, "d-web"))).toEqual(["d-corp", "d-web"]);
    expect(reachedUnits(await reachMap(member, "d-seo"))).toEqual(["d-corp", "d-seo"]);
  });

  it("a person placed nowhere reaches nothing (an unplaceable person is in no one's line)", async () => {
    expect(reachedUnits(await reachMap(principal([co("member")]), null))).toEqual([]);
    expect(reachedUnits(await reachMap(principal([co("viewer")]), null))).toEqual([]);
  });

  it("an org_unit_lead grant reaches the led unit and below, wherever the head is placed (a head above is not a head of a sibling)", async () => {
    const head = principal([co("member"), unitGrant("org_unit_lead", "d-web")]);
    expect(reachedUnits(await reachMap(head, "d-seo"))).toEqual(["d-corp", "d-seo", "d-web", "dv-be", "dv-fe"]); // placed in d-seo (+ its line), leads d-web and below
    const divisionHead = principal([co("member"), unitGrant("org_unit_lead", "dv-fe")]);
    expect(reachedUnits(await reachMap(divisionHead, null))).toEqual(["dv-fe"]);
  });

  it("the placement-derived lead: a company-wide `manager` placed in a unit leads that unit's subtree; a bare member does not lead anything", async () => {
    const lead = principal([co("manager")]);
    expect(reachedUnits(await reachMap(lead, "d-web"))).toEqual(["d-corp", "d-web", "dv-be", "dv-fe"]);
    expect(reachedUnits(await reachMap(principal([co("member")]), "d-seo"))).toEqual(["d-corp", "d-seo"]);
  });

  it("a principal with no user id reaches nothing", async () => {
    expect(reachedUnits(await reachMap(principal([co("member")], null), "d-web"))).toEqual([]);
  });

  it("an unknown unit is reached by nobody below company-wide (the 404 is the caller's, after this)", async () => {
    expect((await reachMap(principal([co("member")]), "d-web"))["d-unknown"]).toBe(false);
    expect((await reachMap(principal([co("company_admin")]), null))["d-unknown"]).toBe(true);
  });
});

describe("DW-10a · loadUnitReach (the batch form) answers exactly what callerReachesUnit does, unit by unit", () => {
  const callers: Array<[string, Principal, string | null]> = [
    ["company_admin", principal([co("company_admin")]), null],
    ["platform_admin", principal([glob("platform_admin")]), null],
    ["member placed in d-web", principal([co("member")]), "d-web"],
    ["member placed in dv-fe", principal([co("member")]), "dv-fe"],
    ["unplaced member", principal([co("member")]), null],
    ["head of d-web placed in d-seo", principal([co("member"), unitGrant("org_unit_lead", "d-web")]), "d-seo"],
    ["division head, unplaced", principal([co("member"), unitGrant("org_unit_lead", "dv-fe")]), null],
    ["manager placed in d-ops", principal([co("manager")]), "d-ops"],
    ["no user id", principal([co("member")], null), "d-web"],
  ];
  for (const [label, p, placement] of callers) {
    it(label, async () => {
      const { client } = fakeClient(placement);
      const batch = await loadUnitReach(client, p, T, STRUCTURE, ASOF);
      const single = await reachMap(p, placement);
      for (const u of UNITS) expect(batch.reaches(u), `${label} / ${u}`).toBe(single[u]);
      expect(batch.companyWide).toBe(isCompanyWide(p, T));
    });
  }
  it("a company-wide caller costs no query at all", async () => {
    const { client, calls } = fakeClient(null);
    await loadUnitReach(client, principal([co("company_admin")]), T, STRUCTURE, ASOF);
    expect(calls).toEqual([]);
  });
});

describe("DW-10e-6 · loadLeadSeatUnits: the units a person heads in ONE company, from that company's own lead seats", () => {
  /** A client that answers only the seat read, records its SQL and parameters, and returns `seats` as the rows. */
  function seatClient(seats: string[]) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes("FROM positions")) return { rows: seats.map((unit_node_id) => ({ unit_node_id })) };
        throw new Error(`unexpected query: ${sql}`);
      },
    } as unknown as PoolClient;
    return { client, calls };
  }
  const sorted = (s: Set<string>) => [...s].sort();

  it("expands each seat's unit through the company's tree: a department head covers its divisions, a division head only its own", async () => {
    expect(sorted(await loadLeadSeatUnits(seatClient(["d-web"]).client, T, "u-me", STRUCTURE))).toEqual(["d-web", "dv-be", "dv-fe"]);
    expect(sorted(await loadLeadSeatUnits(seatClient(["dv-fe"]).client, T, "u-me", STRUCTURE))).toEqual(["dv-fe"]);
    expect(sorted(await loadLeadSeatUnits(seatClient(["dv-fe", "d-seo"]).client, T, "u-me", STRUCTURE))).toEqual(["d-seo", "dv-fe"]);
  });

  it("no seat is an empty set (heads nothing), and a principal with no user id reads nothing at all", async () => {
    expect(sorted(await loadLeadSeatUnits(seatClient([]).client, T, "u-me", STRUCTURE))).toEqual([]);
    const none = seatClient(["d-web"]);
    expect(sorted(await loadLeadSeatUnits(none.client, T, null, STRUCTURE))).toEqual([]);
    expect(none.calls).toEqual([]);
  });

  it("a seat on a unit the tree no longer holds still names that unit alone (no subtree), never the whole tree", async () => {
    expect(sorted(await loadLeadSeatUnits(seatClient(["d-gone"]).client, T, "u-me", STRUCTURE))).toEqual(["d-gone"]);
    expect(sorted(await loadLeadSeatUnits(seatClient(["d-web"]).client, T, "u-me", null))).toEqual(["d-web"]);
  });

  it("is anchored on the company: the query binds the tenant and the user, keeps active lead seats with an open assignment, and reads no role grant", async () => {
    const { client, calls } = seatClient(["d-web"]);
    // an org_unit_lead GRANT on another node changes nothing: the helper takes no principal and never reads roles
    await loadLeadSeatUnits(client, OTHER_T, "u-me", STRUCTURE);
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual([OTHER_T, "u-me"]);
    const sql = calls[0].sql.replace(/\s+/g, " ");
    expect(sql).toContain("JOIN position_assignments pa ON pa.position_id = p.id AND pa.tenant_id = p.tenant_id");
    expect(sql).toContain("p.tenant_id = $1 AND p.is_lead AND p.status = 'active' AND pa.valid_to IS NULL AND pa.user_id = $2");
    expect(sql).not.toMatch(/user_roles|org_unit_lead/);
  });
});
