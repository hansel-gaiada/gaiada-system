// M5-V3-f — who may `read_visitors` and `view_replay` on `resource_search_property`, checked directly against a
// LIVE Cerbos (no DB, no app). Same direct-check pattern as pv5-billing-actions-cerbos.test.ts. Needs CERBOS_URL
// (skips otherwise; "needs the Linux gate") and a Cerbos RESTARTED after the policy change: a stale policy denies every
// allowed case and reads exactly like a logic bug (memory: Cerbos running != current).
//
// Design: docs/plans/2026-10-12-m5-phase5-design.md §4.8 / §8 V3-f / O5. The matrix pins:
//   * plain search staff (module_staff) is DENIED both, though it keeps aggregate `read`;
//   * search manager (module_manager) and the company admin are ALLOWED both, in their own tenant only;
//   * platform_admin is allowed (the wildcard); the generic `manager`, member, viewer, client and webdev tiers are denied;
//   * a granted PERMISSION grants exactly its own action: read_visitors does not give view_replay, view_replay does not give
//     read_visitors, and neither `search.property.read` nor `.attest` gives either;
//   * the permission arm is bounded by tenant, root and assurance like every other mirror on the kind;
//   * the role arm is module-mediated: a resource that does not say module "search" is not reached by the role arm.
// The static twin is cerbos/tests/search_visitors_test.yaml (cerbos compile --tests).
import { describe, it, expect } from "vitest";
import { check, type Resource } from "./cerbos";
import type { Principal, RoleGrant, PermissionGrant } from "./principal";

const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const T1 = "dddddddd-7030-0000-0000-000000000001"; // the served company under test
const T2 = "dddddddd-7030-0000-0000-000000000002"; // another company in the same root
const OTHER_ROOT = "dddddddd-7030-0000-0000-0000000000ff";

function principal(
  roles: RoleGrant[],
  opts: { perms?: PermissionGrant[]; companies?: string[]; rootCompanies?: string[]; assurance?: Principal["assurance"] } = {},
): Principal {
  const companies = opts.companies ?? [T1, T2];
  return {
    userId: "u-7030",
    assurance: opts.assurance ?? "high",
    companies,
    rootCompanies: opts.rootCompanies ?? companies,
    roles,
    perms: opts.perms ?? [],
    sessionVersion: 1,
  };
}
const co = (role: string, scopeId: string = T1): RoleGrant => ({ role, scopeType: "company", scopeId });
const glob = (role: string): RoleGrant => ({ role, scopeType: "global", scopeId: null });
const key = (k: string, scopeId: string = T1): PermissionGrant => ({ key: k, scopeType: "company", scopeId });
const gkey = (k: string): PermissionGrant => ({ key: k, scopeType: "global", scopeId: null });

const property = (tenantId: string = T1, module: string | undefined = "search"): Resource => ({
  kind: "resource_search_property",
  id: "p-1",
  tenantId,
  ...(module !== undefined ? { module } : {}),
});
const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;

const RV = "search.property.read_visitors";
const VR = "search.property.view_replay";
const BOTH = ["read_visitors", "view_replay"] as const;

describe.skipIf(!live)("M5-V3-f · resource_search_property read_visitors + view_replay (live Cerbos)", () => {
  it("plain search staff is DENIED both, and keeps aggregate read", async () => {
    const staff = principal([co("search_staff")]);
    expect(await allow(staff, property(), "read")).toBe(true);
    for (const a of BOTH) expect(await allow(staff, property(), a), a).toBe(false);
  });

  it("search manager and company admin are ALLOWED both in their own tenant", async () => {
    for (const p of [principal([co("search_manager")]), principal([co("company_admin")])]) {
      for (const a of BOTH) expect(await allow(p, property(), a), a).toBe(true);
    }
  });

  it("another tenant is denied, even for a principal who belongs to both companies", async () => {
    // grants are scoped to T1; the resource is T2's
    for (const p of [principal([co("search_manager")]), principal([co("company_admin")])]) {
      for (const a of BOTH) expect(await allow(p, property(T2), a), a).toBe(false);
    }
    // a tenant outside the principal's companies is denied outright
    const out = principal([co("company_admin", OTHER_ROOT)], { companies: [T1] });
    for (const a of BOTH) expect(await allow(out, property(OTHER_ROOT), a), a).toBe(false);
  });

  it("platform_admin is allowed (the wildcard)", async () => {
    const pa = principal([glob("platform_admin")]);
    for (const a of BOTH) expect(await allow(pa, property(), a), a).toBe(true);
  });

  it("the generic manager, member, viewer, client and the webdev tiers are DENIED both", async () => {
    for (const role of ["manager", "member", "viewer", "client", "org_unit_lead", "webdev_staff", "webdev_manager", "hr_manager", "finance_manager"]) {
      const p = principal([co(role)]);
      for (const a of BOTH) expect(await allow(p, property(), a), `${role} ${a}`).toBe(false);
    }
  });

  it("low assurance is denied for every arm", async () => {
    for (const p of [
      principal([co("search_manager")], { assurance: "low" }),
      principal([co("company_admin")], { assurance: "low" }),
      principal([], { perms: [key(RV), key(VR)], assurance: "low" }),
    ]) {
      for (const a of BOTH) expect(await allow(p, property(), a), a).toBe(false);
    }
  });

  it("the role arm is module-mediated: a resource that does not name module search is not reached by search_manager", async () => {
    const mgr = principal([co("search_manager")]);
    for (const a of BOTH) {
      expect(await allow(mgr, property(T1, ""), a), `${a} module ""`).toBe(false);
      expect(await allow(mgr, property(T1, "webdev"), a), `${a} module webdev`).toBe(false);
      // Built by hand: `property(T1, undefined)` would take the default parameter ("search"), not drop the attribute.
      const noModule: Resource = { kind: "resource_search_property", id: "p-1", tenantId: T1 };
      expect(await allow(mgr, noModule, a), `${a} module absent`).toBe(false);
    }
  });

  describe("the permission arm grants exactly its own action", () => {
    it("read_visitors alone: allows read_visitors, denies view_replay, read and attest", async () => {
      const p = principal([], { perms: [key(RV)] });
      expect(await allow(p, property(), "read_visitors")).toBe(true);
      expect(await allow(p, property(), "view_replay")).toBe(false);
      expect(await allow(p, property(), "read")).toBe(false);
      expect(await allow(p, property(), "attest")).toBe(false);
      expect(await allow(p, property(), "delete")).toBe(false);
    });

    it("view_replay alone: allows view_replay, denies read_visitors, read and attest", async () => {
      const p = principal([], { perms: [key(VR)] });
      expect(await allow(p, property(), "view_replay")).toBe(true);
      expect(await allow(p, property(), "read_visitors")).toBe(false);
      expect(await allow(p, property(), "read")).toBe(false);
      expect(await allow(p, property(), "attest")).toBe(false);
    });

    it("the neighbouring search.property.* keys do not give either action", async () => {
      for (const k of ["search.property.read", "search.property.create", "search.property.update", "search.property.delete", "search.property.attest"]) {
        const p = principal([], { perms: [key(k)] });
        for (const a of BOTH) expect(await allow(p, property(), a), `${k} -> ${a}`).toBe(false);
      }
    });

    it("an unrelated kind's key (search.report.read, search.finding.accept_risk) gives neither", async () => {
      for (const k of ["search.report.read", "search.finding.accept_risk", "search.ledger.admin"]) {
        const p = principal([], { perms: [key(k)] });
        for (const a of BOTH) expect(await allow(p, property(), a), `${k} -> ${a}`).toBe(false);
      }
    });

    it("plain search staff who is GRANTED a key reaches that action only", async () => {
      const staff = principal([co("search_staff")], { perms: [key(RV)] });
      expect(await allow(staff, property(), "read_visitors")).toBe(true);
      expect(await allow(staff, property(), "view_replay")).toBe(false);
    });

    it("the owner (a permission-native role) reaches both through its key bundle, and no further", async () => {
      const owner = principal([co("owner")], { perms: [key(RV), key(VR)] });
      for (const a of BOTH) expect(await allow(owner, property(), a), a).toBe(true);
      expect(await allow(owner, property(), "attest")).toBe(false);
    });

    it("is bounded to the grant's company, not the principal's other companies", async () => {
      const p = principal([], { perms: [key(RV)] });
      expect(await allow(p, property(T1), "read_visitors")).toBe(true);
      expect(await allow(p, property(T2), "read_visitors")).toBe(false);
    });

    it("a global grant works inside the principal's root and is refused outside it", async () => {
      const inRoot = principal([], { perms: [gkey(RV)] });
      expect(await allow(inRoot, property(T1), "read_visitors")).toBe(true);
      // companies includes the tenant, but the root gate does not: fail closed
      const outsideRoot = principal([], { perms: [gkey(RV)], companies: [T1], rootCompanies: [OTHER_ROOT] });
      expect(await allow(outsideRoot, property(T1), "read_visitors")).toBe(false);
      // an empty root denies everything
      const noRoot = principal([], { perms: [gkey(RV)], rootCompanies: [] });
      expect(await allow(noRoot, property(T1), "read_visitors")).toBe(false);
    });

    it("a permission arm is not reached when the principal is not a member of the company", async () => {
      const p = principal([], { perms: [key(RV, T2)], companies: [T1] });
      expect(await allow(p, property(T2), "read_visitors")).toBe(false);
    });
  });
});
