// ⚡ TR-25 — the PURE half of the person-axis boundary (person-scope.ts). No DB, no Cerbos.
//
// `reports-cerbos.test.ts` proves which TIER may attempt what. This file proves the two pure
// decisions the in-app half rests on — tier resolution and the unit-subtree walk — because those are
// where §15 finding ① said the boundary had been getting silently wrong.
import { describe, it, expect } from "vitest";
import { collectUnitSubtree, personAxisTier, requiresUnitNarrowing, isSelfOnlyTier, sliceRowsToUnitScope, unwrapOrgRoot, todayIsoInTz } from "./person-scope";
import type { Principal, RoleGrant } from "../../rbac/principal";

const T1 = "dddddddd-3333-0000-0000-000000000001";
const T2 = "dddddddd-3333-0000-0000-000000000002";

const p = (roles: RoleGrant[], companies: string[] = [T1]): Principal => ({
  userId: "u1", assurance: "high", companies, roles, sessionVersion: 1,
});
const g = (role: string, scopeType: RoleGrant["scopeType"], scopeId: string | null): RoleGrant => ({ role, scopeType, scopeId });

// The org shape TR-37 established this estate actually runs: departments CONTAINING divisions, with
// people placed at the division level. Written in the shape `sanitizeStructure()` really stores —
// WRAPPED in `{root: …}` — per §15's lesson that a fixture written from the reader's assumption
// rather than the writer's output cannot catch the reader's bug.
const ORG = {
  root: {
    id: "co", kind: "company", children: [
      {
        id: "d-web", kind: "department", children: [
          { id: "dv-frontend", kind: "division", children: [{ id: "r-dev", kind: "role", children: [] }] },
          { id: "dv-backend", kind: "division", children: [] },
        ],
      },
      { id: "d-seo", kind: "department", children: [{ id: "dv-content", kind: "division", children: [] }] },
      { id: "d-hr", kind: "department", children: [] },
    ],
  },
};

describe("TR-25 personAxisTier — ONE tier detector replacing three divergent ones", () => {
  it("platform_admin is unrestricted, regardless of tenant", () => {
    expect(personAxisTier(p([g("platform_admin", "global", null)], []), T1)).toBe("unrestricted");
  });

  it("exec / company_admin / both HR tiers are company_wide", () => {
    expect(personAxisTier(p([g("group_executive", "global", null)], []), T1)).toBe("company_wide");
    expect(personAxisTier(p([g("company_admin", "company", T1)]), T1)).toBe("company_wide");
    expect(personAxisTier(p([g("hr_staff", "company", T1)]), T1)).toBe("company_wide");
    expect(personAxisTier(p([g("hr_manager", "company", T1)]), T1)).toBe("company_wide");
  });

  it("the reconciler-materialized SERVED module grants are company_wide, not unit_scoped", () => {
    // Why this matters: a served provider lead's own org unit lives in the PROVIDER's tree, not the
    // served tenant's. Classifying them `unit_scoped` would narrow them against the WRONG tenant's org
    // chart — they'd resolve no unit and silently see nothing. Cerbos already bounds which GRAINS this
    // tier reaches (department/project only, never person), so `company_wide` here is not a widening.
    expect(personAxisTier(p([g("reports_manager", "company", T1)], [T1, T2]), T1)).toBe("company_wide");
    expect(personAxisTier(p([g("reports_staff", "company", T1)], [T1, T2]), T1)).toBe("company_wide");
  });

  it("manager AND team_lead both resolve to unit_scoped — the divergence TR-25 closed", () => {
    // checkins.controller.ts's old `isManagerTierOnly` ignored `team_lead` entirely (so such a
    // principal fell through to self-only and got NO narrowing applied at all on that surface), while
    // appraisals.controller.ts's copy counted it. One boundary, one answer.
    expect(personAxisTier(p([g("manager", "company", T1)]), T1)).toBe("unit_scoped");
    expect(personAxisTier(p([g("team_lead", "team", "d-web")]), T1)).toBe("unit_scoped");
    expect(personAxisTier(p([g("manager", "project", "proj-1")]), T1)).toBe("unit_scoped");
  });

  it("a plain member — or no grant at all — is self_only", () => {
    expect(personAxisTier(p([g("member", "company", T1)]), T1)).toBe("self_only");
    expect(personAxisTier(p([]), T1)).toBe("self_only");
    expect(isSelfOnlyTier(p([g("member", "company", T1)]), T1)).toBe(true);
  });

  it("a grant scoped to ANOTHER company does not confer its tier here (A4: no wildcard scopeId)", () => {
    expect(personAxisTier(p([g("manager", "company", T2)], [T1, T2]), T1)).toBe("self_only");
    expect(personAxisTier(p([g("hr_manager", "company", T2)], [T1, T2]), T1)).toBe("self_only");
    expect(personAxisTier(p([g("company_admin", "company", null)], [T1]), T1)).toBe("self_only");
  });

  it("the broader tier always WINS over a co-held manager grant — narrowing must not apply to an exec who also leads a team", () => {
    expect(personAxisTier(p([g("manager", "company", T1), g("group_executive", "global", null)], [T1]), T1)).toBe("company_wide");
    expect(requiresUnitNarrowing(p([g("manager", "company", T1), g("hr_manager", "company", T1)]), T1)).toBe(false);
    expect(requiresUnitNarrowing(p([g("manager", "company", T1)]), T1)).toBe(true);
  });
});

describe("TR-25 collectUnitSubtree — §8's 'own unit' means the unit AND everything under it", () => {
  it("⚡ THE FIX: a department resolves to itself PLUS its divisions", () => {
    // This is the defect TR-09's exact-equality comparison had. A `d-web` lead whose reports sit in
    // `dv-frontend` matched NOBODY and saw an empty grid — while the boundary *looked* like it was
    // working, because a denial is indistinguishable from "no data" on a listing surface.
    expect(collectUnitSubtree(ORG, "d-web").sort()).toEqual(["d-web", "dv-backend", "dv-frontend"]);
  });

  it("a division resolves to just itself — a division lead does not see sibling divisions", () => {
    expect(collectUnitSubtree(ORG, "dv-frontend")).toEqual(["dv-frontend"]);
  });

  it("sibling departments never leak into each other", () => {
    expect(collectUnitSubtree(ORG, "d-seo").sort()).toEqual(["d-seo", "dv-content"]);
    expect(collectUnitSubtree(ORG, "d-seo")).not.toContain("dv-frontend");
    expect(collectUnitSubtree(ORG, "d-hr")).toEqual(["d-hr"]);
  });

  it("non-unit node kinds (role/person) are never treated as units", () => {
    // `r-dev` is a `role` node under `dv-frontend`. Including it would put a non-unit id into a scope
    // set that is compared against `org_unit_memberships.unit_node_id` — never a match, but it would
    // make the set lie about what it contains.
    expect(collectUnitSubtree(ORG, "dv-frontend")).not.toContain("r-dev");
  });

  it("fails CLOSED, not open: an absent/empty/unknown tree degrades to exact-unit equality", () => {
    // The single most important property here. If the org blob is missing, unreadable (RLS), or the
    // node simply is not in it, the scope must shrink to the one unit — NEVER widen to everything.
    expect(collectUnitSubtree(null, "d-web")).toEqual(["d-web"]);
    expect(collectUnitSubtree(undefined, "d-web")).toEqual(["d-web"]);
    expect(collectUnitSubtree({}, "d-web")).toEqual(["d-web"]);
    expect(collectUnitSubtree(ORG, "d-nonexistent")).toEqual(["d-nonexistent"]);
    expect(collectUnitSubtree({ root: { id: "co", kind: "company" } }, "d-web")).toEqual(["d-web"]);
  });

  it("survives a malformed blob (null children, missing kind, non-object entries) without throwing", () => {
    const messy = { root: { id: "co", kind: "company", children: [null, { id: "d-x", children: null }, { kind: "division", children: [] }] } };
    expect(() => collectUnitSubtree(messy, "d-x")).not.toThrow();
    expect(collectUnitSubtree(messy, "d-x")).toEqual(["d-x"]);
  });

  it("⚠ TR-37's bug cannot recur: BOTH the wrapped and bare-root shapes work", () => {
    // `sanitizeStructure()` ALWAYS wraps as `{root: OrgNode}`; TR-37's `deriveUnitDepartments` was
    // handed the wrapper and walked `undefined.children`, silently returning empty against all real
    // data. The unwrap lives INSIDE this function so no call site can reintroduce it.
    expect(collectUnitSubtree(ORG, "d-web").sort()).toEqual(collectUnitSubtree(ORG.root, "d-web").sort());
    expect(unwrapOrgRoot(ORG)?.id).toBe("co");
    expect(unwrapOrgRoot(ORG.root)?.id).toBe("co");
    expect(unwrapOrgRoot(null)).toBeNull();
  });
});

describe("TR-25 sliceRowsToUnitScope — listing surfaces slice, never re-derive", () => {
  const rows = [{ userId: "a" }, { userId: "b" }, { userId: "c" }, { userId: "d" }];
  const unitByUser = new Map<string, string | null>([["a", "dv-frontend"], ["b", "d-web"], ["c", "d-seo"], ["d", null]]);

  it("keeps only users inside the led subtree", () => {
    const scope = new Set(collectUnitSubtree(ORG, "d-web"));
    expect(sliceRowsToUnitScope(rows, unitByUser, scope, (r) => r.userId).map((r) => r.userId)).toEqual(["a", "b"]);
  });

  it("an unplaceable user (no as-of membership) is in NOBODY's scope — fail-closed", () => {
    const scope = new Set(collectUnitSubtree(ORG, "d-web"));
    expect(sliceRowsToUnitScope(rows, unitByUser, scope, (r) => r.userId).map((r) => r.userId)).not.toContain("d");
  });

  it("an EMPTY scope yields NO rows — never all rows", () => {
    // The catastrophic failure mode for a filter: "no filter" silently meaning "no restriction".
    expect(sliceRowsToUnitScope(rows, unitByUser, new Set(), (r) => r.userId)).toEqual([]);
  });
});

describe("TR-25 todayIsoInTz — the as-of anchor", () => {
  it("formats YYYY-MM-DD and honours the zone", () => {
    const instant = new Date("2026-07-31T20:30:00.000Z");
    expect(todayIsoInTz("UTC", instant)).toBe("2026-07-31");
    expect(todayIsoInTz("Asia/Jakarta", instant)).toBe("2026-08-01"); // UTC+7 has rolled over
    expect(todayIsoInTz("America/Los_Angeles", instant)).toBe("2026-07-31");
  });
});
