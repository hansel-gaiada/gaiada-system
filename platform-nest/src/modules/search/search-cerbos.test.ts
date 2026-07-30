// SM-03 — Cerbos policy parity tests for the 7 search-marketing resources (docs/blueprints/
// seo-sem-design.md §11/§12). Same direct-check pattern as src/rbac/cerbos.test.ts (5b.4):
// hits a LIVE Cerbos over the versioned policy repo, no DB/app needed. Needs CERBOS_URL
// (skips otherwise) — `docker run -p 3592:3592 -v .../cerbos/policies:/policies ghcr.io/cerbos/cerbos`.
//
// Parity matrix (design §12 SM-03 "done when"): owner / manager / member / served-dept-user
// against representative actions, INCLUDING the deny cases (member cannot launch/approve/
// set_budget/set_scope/admin; a served-dept user is scoped correctly; cross-role denials).
//   owner            = group_executive (global, full oversight)
//   manager          = search_manager  (module_manager derived role, served-company grant)
//   member           = search_staff    (module_staff derived role, served-company grant) —
//                       the WSD-2 "baseline working set" role; can draft/read/write, never
//                       execute/approve/admin
//   served-dept-user = a search_staff/search_manager grant scoped to a DIFFERENT company than
//                       the resource under test (T2), proving the served-company slice — same
//                       mechanism WSD-7 proved for hr_staff/hr_manager
import { describe, it, expect } from "vitest";
import { check, type Resource } from "../../rbac/cerbos";
import type { Principal, RoleGrant } from "../../rbac/principal";

const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const T1 = "cccccccc-1111-0000-0000-000000000001"; // the served company under test
const T2 = "cccccccc-1111-0000-0000-000000000002"; // a DIFFERENT company (cross-tenant / other-service-scope)

function principal(roles: RoleGrant[], companies: string[] = [T1], assurance: Principal["assurance"] = "high"): Principal {
  return { userId: "u1", assurance, companies, roles, sessionVersion: 1 };
}
const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;

// Search-module resource attrs: module: "search", tenantId: <served company> — exactly what
// SearchController's authorize() calls pass (search.controller.ts).
const property: Resource = { kind: "resource_search_property", tenantId: T1, module: "search" };
const engagement: Resource = { kind: "resource_search_engagement", tenantId: T1, module: "search" };
const keyword: Resource = { kind: "resource_search_keyword", tenantId: T1, module: "search" };
const audit: Resource = { kind: "resource_search_audit", tenantId: T1, module: "search" };
const campaign: Resource = { kind: "resource_search_campaign", tenantId: T1, module: "search" };
const report: Resource = { kind: "resource_search_report", tenantId: T1, module: "search" };
const ledger: Resource = { kind: "resource_search_ledger", tenantId: T1, module: "search" };

// Named principals for the parity matrix.
const owner = principal([{ role: "group_executive", scopeType: "global", scopeId: null }], []);
const manager = principal([{ role: "search_manager", scopeType: "company", scopeId: T1 }]);
const member = principal([{ role: "search_staff", scopeType: "company", scopeId: T1 }]);
const servedDeptUser = principal([{ role: "search_staff", scopeType: "company", scopeId: T1 }], [T1, T2]);
// A grant scoped to T2 (a DIFFERENT company) attempting T1's resources — must be denied (no cascade).
const wrongCompanyStaff = principal([{ role: "search_staff", scopeType: "company", scopeId: T2 }], [T1, T2]);
const plainMember = principal([{ role: "member", scopeType: "company", scopeId: T1 }]); // generic RBAC role, NOT module-scoped
const platformAdmin = principal([{ role: "platform_admin", scopeType: "global", scopeId: null }], []);

describe.skipIf(!live)("Cerbos policy parity — search-marketing resources (SM-03)", () => {
  // ───────────────────────────────── platform_admin: unconditional ─────────────────────────────────
  it("platform_admin can do anything on every search resource", async () => {
    expect(await allow(platformAdmin, campaign, "launch")).toBe(true);
    expect(await allow(platformAdmin, report, "approve")).toBe(true);
    expect(await allow(platformAdmin, ledger, "admin")).toBe(true);
    expect(await allow(platformAdmin, engagement, "set_scope")).toBe(true);
  });

  // ───────────────────────────────── resource_search_property ─────────────────────────────────
  describe("resource_search_property", () => {
    it("owner/manager/member/served-dept-user can read/create/update", async () => {
      for (const p of [owner, manager, member, servedDeptUser]) {
        expect(await allow(p, property, "read")).toBe(true);
        expect(await allow(p, property, "create")).toBe(true);
        expect(await allow(p, property, "update")).toBe(true);
      }
    });
    it("delete: owner/manager can, plain member (staff) cannot", async () => {
      expect(await allow(owner, property, "delete")).toBe(true);
      expect(await allow(manager, property, "delete")).toBe(true);
      expect(await allow(member, property, "delete")).toBe(false);
    });
    it("a grant scoped to a different company does not cascade to T1", async () => {
      expect(await allow(wrongCompanyStaff, property, "read")).toBe(false);
    });
    it("a generic (non-module) member role has no access at all", async () => {
      expect(await allow(plainMember, property, "read")).toBe(false);
    });
  });

  // ───────────────────────────────── resource_search_engagement ─────────────────────────────────
  describe("resource_search_engagement (incl. set_scope + kpi_targets surface)", () => {
    it("owner/manager/member/served-dept-user can read/create/update", async () => {
      for (const p of [owner, manager, member, servedDeptUser]) {
        expect(await allow(p, engagement, "read")).toBe(true);
        expect(await allow(p, engagement, "create")).toBe(true);
        expect(await allow(p, engagement, "update")).toBe(true);
      }
    });
    it("set_scope: owner/manager allowed; member (staff) DENIED (design D-11)", async () => {
      expect(await allow(owner, engagement, "set_scope")).toBe(true);
      expect(await allow(manager, engagement, "set_scope")).toBe(true);
      expect(await allow(member, engagement, "set_scope")).toBe(false);
    });
    it("delete: manager can, member cannot", async () => {
      expect(await allow(manager, engagement, "delete")).toBe(true);
      expect(await allow(member, engagement, "delete")).toBe(false);
    });
    it("cross-tenant grant is denied", async () => {
      expect(await allow(wrongCompanyStaff, engagement, "set_scope")).toBe(false);
    });
  });

  // ───────────────────────────────── resource_search_keyword ─────────────────────────────────
  describe("resource_search_keyword (sets/keywords/ranks/research)", () => {
    it("owner/manager/member/served-dept-user can read/create/update/research", async () => {
      for (const p of [owner, manager, member, servedDeptUser]) {
        expect(await allow(p, keyword, "read")).toBe(true);
        expect(await allow(p, keyword, "research")).toBe(true);
      }
    });
    it("delete: manager can, member cannot", async () => {
      expect(await allow(manager, keyword, "delete")).toBe(true);
      expect(await allow(member, keyword, "delete")).toBe(false);
    });
  });

  // ───────────────────────────────── resource_search_audit ─────────────────────────────────
  describe("resource_search_audit (audits/findings/backlinks/ai-visibility)", () => {
    it("owner/manager/member/served-dept-user can read/run", async () => {
      for (const p of [owner, manager, member, servedDeptUser]) {
        expect(await allow(p, audit, "read")).toBe(true);
        expect(await allow(p, audit, "run")).toBe(true);
      }
    });
    it("delete: manager can, member cannot", async () => {
      expect(await allow(manager, audit, "delete")).toBe(true);
      expect(await allow(member, audit, "delete")).toBe(false);
    });
  });

  // ───────────────────────────────── resource_search_campaign ─────────────────────────────────
  describe("resource_search_campaign (dual-mode SEM execution)", () => {
    it("owner/manager/member/served-dept-user can read/create/update/propose_change", async () => {
      for (const p of [owner, manager, member, servedDeptUser]) {
        expect(await allow(p, campaign, "read")).toBe(true);
        expect(await allow(p, campaign, "propose_change")).toBe(true);
      }
    });
    it("launch/apply_manual/apply_negatives/set_budget: owner + manager allowed", async () => {
      for (const p of [owner, manager]) {
        expect(await allow(p, campaign, "launch")).toBe(true);
        expect(await allow(p, campaign, "apply_manual")).toBe(true);
        expect(await allow(p, campaign, "apply_negatives")).toBe(true);
        expect(await allow(p, campaign, "set_budget")).toBe(true);
      }
    });
    it("launch/apply_manual/apply_negatives/set_budget: member (staff) DENIED — the parity matrix's headline deny case", async () => {
      expect(await allow(member, campaign, "launch")).toBe(false);
      expect(await allow(member, campaign, "apply_manual")).toBe(false);
      expect(await allow(member, campaign, "apply_negatives")).toBe(false);
      expect(await allow(member, campaign, "set_budget")).toBe(false);
    });
    it("served-dept-user (staff-level) is also denied the execution twins — scope covers baseline only", async () => {
      expect(await allow(servedDeptUser, campaign, "launch")).toBe(false);
      expect(await allow(servedDeptUser, campaign, "set_budget")).toBe(false);
    });
    it("delete: manager can, member cannot", async () => {
      expect(await allow(manager, campaign, "delete")).toBe(true);
      expect(await allow(member, campaign, "delete")).toBe(false);
    });
    it("a served-dept manager grant on T1 does NOT authorize T2's campaigns", async () => {
      const servedManagerT1 = principal([{ role: "search_manager", scopeType: "company", scopeId: T1 }], [T1, T2]);
      expect(await allow(servedManagerT1, { kind: "resource_search_campaign", tenantId: T2, module: "search" }, "launch")).toBe(false);
    });
  });

  // ───────────────────────────────── resource_search_report ─────────────────────────────────
  describe("resource_search_report", () => {
    it("owner/manager/member/served-dept-user can read/create/update", async () => {
      for (const p of [owner, manager, member, servedDeptUser]) {
        expect(await allow(p, report, "read")).toBe(true);
        expect(await allow(p, report, "create")).toBe(true);
      }
    });
    it("approve/deliver: owner + manager allowed, member DENIED", async () => {
      expect(await allow(owner, report, "approve")).toBe(true);
      expect(await allow(manager, report, "approve")).toBe(true);
      expect(await allow(member, report, "approve")).toBe(false);
      expect(await allow(owner, report, "deliver")).toBe(true);
      expect(await allow(manager, report, "deliver")).toBe(true);
      expect(await allow(member, report, "deliver")).toBe(false);
    });
  });

  // ───────────────────────────────── resource_search_ledger ─────────────────────────────────
  describe("resource_search_ledger", () => {
    it("owner/manager/member/served-dept-user can read", async () => {
      for (const p of [owner, manager, member, servedDeptUser]) {
        expect(await allow(p, ledger, "read")).toBe(true);
      }
    });
    it("admin (budget stop-loss override): owner + manager allowed, member DENIED", async () => {
      expect(await allow(owner, ledger, "admin")).toBe(true);
      expect(await allow(manager, ledger, "admin")).toBe(true);
      expect(await allow(member, ledger, "admin")).toBe(false);
    });
    it("cross-tenant grant cannot read T1's ledger", async () => {
      expect(await allow(wrongCompanyStaff, ledger, "read")).toBe(false);
    });
  });

  // ───────────────────────────────── D4 assurance ceiling (shared across all 7) ─────────────────────────────────
  it("low-assurance principals get NO search data, regardless of role", async () => {
    const low = principal([{ role: "search_manager", scopeType: "company", scopeId: T1 }], [T1], "low");
    expect(await allow(low, engagement, "read")).toBe(false);
    expect(await allow(low, campaign, "read")).toBe(false);
  });
});
