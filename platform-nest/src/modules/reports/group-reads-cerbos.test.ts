// PV1-06a — the two owner rules (resource_rollup.yaml, resource_report_document.yaml), checked
// directly against a LIVE Cerbos, no DB or app. Same direct-check pattern as reports-cerbos.test.ts.
// Needs CERBOS_URL (skips otherwise) and a Cerbos restarted after the policy change — a stale
// policy denies every owner case and reads exactly like a logic bug.
//
// The HTTP half (the root check, the real principals, the 404s) is group-report.db.test.ts. This
// file pins the edges of the RULES: which grant shape matches, and what does not widen.
import { describe, it, expect } from "vitest";
import { check, type Resource } from "../../rbac/cerbos";
import type { Principal, RoleGrant } from "../../rbac/principal";

const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const ROOT = "dddddddd-6a6a-0000-0000-000000000001";
const CHILD = "dddddddd-6a6a-0000-0000-000000000002";
const OTHER_ROOT = "dddddddd-6a6a-0000-0000-000000000003";
const USER = "11111111-6a6a-0000-0000-000000000001";

function principal(
  roles: RoleGrant[],
  opts: { companies?: string[]; rootCompanies?: string[]; assurance?: Principal["assurance"] } = {},
): Principal {
  return {
    userId: USER,
    assurance: opts.assurance ?? "high",
    companies: opts.companies ?? [ROOT, CHILD],
    rootCompanies: opts.rootCompanies ?? [ROOT, CHILD],
    roles,
    sessionVersion: 1,
  };
}
const owner = (scopeId: string | null, scopeType: RoleGrant["scopeType"] = "company"): RoleGrant => ({ role: "owner", scopeType, scopeId });
const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;
const rollup = (tenantId: string): Resource => ({ kind: "rollup", tenantId });
const companyDoc = (tenantId: string): Resource => ({ kind: "report_document", tenantId, module: "reports" });

describe.skipIf(!live)("PV1-06a · owner rules on rollup + report_document (live Cerbos)", () => {
  const rootOwner = principal([owner(ROOT), owner(CHILD)]);
  const childOwner = principal([owner(CHILD)]);

  it("an owner of the root reads that root's rollups and each owned company's Company Report", async () => {
    expect(await allow(rootOwner, rollup(ROOT), "read")).toBe(true);
    expect(await allow(rootOwner, companyDoc(ROOT), "read_company")).toBe(true);
    expect(await allow(rootOwner, companyDoc(CHILD), "read_company")).toBe(true);
  });

  it("🔴 an owner of a CHILD only is refused the root's rollups (the grant must be ON the tenant)", async () => {
    expect(await allow(childOwner, rollup(ROOT), "read")).toBe(false);
    expect(await allow(childOwner, companyDoc(ROOT), "read_company")).toBe(false);
    // Its own company's Company Report it may read.
    expect(await allow(childOwner, companyDoc(CHILD), "read_company")).toBe(true);
  });

  it("🔴 a GLOBAL owner grant matches nothing — owner is a per-company grant", async () => {
    const globalOwner = principal([owner(null, "global")]);
    expect(await allow(globalOwner, rollup(ROOT), "read")).toBe(false);
    expect(await allow(globalOwner, companyDoc(ROOT), "read_company")).toBe(false);
  });

  it("🔴 never across roots: a grant on a foreign root does not pass inRoot / inTenant", async () => {
    const foreign = principal([owner(OTHER_ROOT)]);
    expect(await allow(foreign, rollup(OTHER_ROOT), "read")).toBe(false);
    expect(await allow(foreign, companyDoc(OTHER_ROOT), "read_company")).toBe(false);
    // An unanchored principal (empty rootCompanies) is refused rollups even on its own grant.
    expect(await allow(principal([owner(ROOT)], { rootCompanies: [] }), rollup(ROOT), "read")).toBe(false);
    // No membership in the tenant: no Company Report.
    expect(await allow(principal([owner(ROOT)], { companies: [] }), companyDoc(ROOT), "read_company")).toBe(false);
  });

  it("🔴 a low-assurance session gets neither (D4)", async () => {
    const low = principal([owner(ROOT)], { assurance: "low" });
    expect(await allow(low, rollup(ROOT), "read")).toBe(false);
    expect(await allow(low, companyDoc(ROOT), "read_company")).toBe(false);
  });

  it("🔴 the owner rule is company-grain ONLY: no person/project/department documents", async () => {
    for (const action of ["read_person", "read_project", "read_department"]) {
      expect(await allow(rootOwner, companyDoc(ROOT), action), action).toBe(false);
    }
  });

  it("nobody else gains: company_admin and member still cannot read rollups", async () => {
    expect(await allow(principal([{ role: "company_admin", scopeType: "company", scopeId: ROOT }]), rollup(ROOT), "read")).toBe(false);
    expect(await allow(principal([{ role: "member", scopeType: "company", scopeId: ROOT }]), rollup(ROOT), "read")).toBe(false);
  });
});
