// IAM-DR5 — pins the owner's 2026-08-10 decision literally: `company_admin` gains `read` on
// `appraisal`, and ONLY `read`. This is a real authorization WIDENING (not a drift-neutral bundle
// fix like 0091/0094/0095/0096/0097/0098) — the IAM drift register's finding #6 / IAM-05b-3's
// confirmed over-claim (9 live holders of rbac.ts's `appraisal.read` capability with no matching
// Cerbos rule; docs/superpowers/plans/2026-08-10-iam-05b-3-report.md §3, and the phase-1 ticket
// doc's DR-5 entry). Offered "strip the UI claim" or "grant it in Cerbos", the owner chose to
// grant it: a company's own administrator may read appraisals within their own company — nothing
// else. This file's entire job is to make any future attempt to widen that grant fail loudly.
//
// Needs a running Cerbos loaded with the CURRENT policy files (CERBOS_URL; skips otherwise) —
// and remember the staleness trap this program has hit repeatedly: `docker inspect
// gaiada-test-cerbos --format '{{.State.StartedAt}}'` must postdate resource_appraisal.yaml's own
// edit, or every check below silently reads EFFECT_DENY and looks exactly like a real regression.
// Probed directly against the live decision API before writing this file (own-company read ->
// EFFECT_ALLOW, every other action -> EFFECT_DENY, other-company read -> EFFECT_DENY) — this test
// pins that same, already-confirmed-live shape as a permanent regression guard.
import { describe, it, expect } from "vitest";
import { check, type Resource } from "./cerbos";
import type { Principal, RoleGrant } from "./principal";
import bundles from "./role-permission-bundles.json";

const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const T1 = "cccccccc-dd55-0000-0000-000000000001"; // the company company_admin administers
const T2 = "cccccccc-dd55-0000-0000-000000000002"; // a DIFFERENT company — not administered by it
const SUBJECT = "11111111-dd55-0000-0000-000000000009";

function principal(roles: RoleGrant[], companies: string[]): Principal {
  return { userId: "admin-1", assurance: "high", companies, roles, sessionVersion: 1 };
}
const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;

const adminOwnCompany = principal([{ role: "company_admin", scopeType: "company", scopeId: T1 }], [T1]);
// A company_admin grant SCOPED TO T1 attempting T2's appraisal — companies[] deliberately
// includes T2 too (the principal is a legitimate MEMBER of T2, e.g. via a separate `member`
// grant elsewhere) so this isolates "does the company_admin grant itself cascade" from "is the
// resource's tenant even in the authorized set", matching wrongCompanyLead's shape in
// reports-cerbos.test.ts.
const adminOtherCompanyResource = principal([{ role: "company_admin", scopeType: "company", scopeId: T1 }], [T1, T2]);

const appraisalOwnCompany: Resource = { kind: "appraisal", tenantId: T1, subjectUserId: SUBJECT };
const appraisalOtherCompany: Resource = { kind: "appraisal", tenantId: T2, subjectUserId: SUBJECT };

describe.skipIf(!live)("IAM-DR5 — company_admin gains appraisal READ, and nothing else", () => {
  it("DR-5: company_admin CAN read an appraisal in its OWN company", async () => {
    expect(await allow(adminOwnCompany, appraisalOwnCompany, "read")).toBe(true);
  });

  it("DR-5's whole point: company_admin still CANNOT write/submit/finalize/cycle_admin/confirm_evidence/ack", async () => {
    for (const action of ["write", "submit", "finalize", "cycle_admin", "confirm_evidence", "ack"]) {
      expect(await allow(adminOwnCompany, appraisalOwnCompany, action), `action=${action}`).toBe(false);
    }
  });

  it("does NOT cascade to a company this admin does not administer — a company_admin grant scoped to T1 never reaches T2's appraisals", async () => {
    expect(await allow(adminOtherCompanyResource, appraisalOtherCompany, "read")).toBe(false);
    // ...even though T2 IS in the principal's authorized company set (inTenant alone is never
    // sufficient — every rule also needs a matching derived role at the RIGHT scope).
    for (const action of ["write", "submit", "finalize", "cycle_admin", "confirm_evidence", "ack"]) {
      expect(await allow(adminOtherCompanyResource, appraisalOtherCompany, action), `action=${action}`).toBe(false);
    }
  });

  it("a GLOBAL-scope company_admin grant (D1's platform-managed shape) covers every company's appraisals — read only, matching the scope-cascade every other company_admin rule already uses", async () => {
    const globalAdmin = principal([{ role: "company_admin", scopeType: "global", scopeId: null }], [T1, T2]);
    expect(await allow(globalAdmin, appraisalOwnCompany, "read")).toBe(true);
    expect(await allow(globalAdmin, appraisalOtherCompany, "read")).toBe(true);
    expect(await allow(globalAdmin, appraisalOtherCompany, "write")).toBe(false);
  });
});

// ── The bundle-artifact half: regenerable proof that role-permission-bundles.json (0099's DB
// mirror) agrees with the policy above, and NEVER drifts wider than "read only" even if someone
// re-runs `npm run gen:role-bundles` after touching this policy for an unrelated reason. Needs no
// live Cerbos or DB — runs unconditionally. ──
describe("IAM-DR5 — role-permission-bundles.json mirrors the read-only grant exactly", () => {
  const companyAdminPerms: string[] = (bundles as any).roles.company_admin;

  it("company_admin's bundle contains reports.appraisal.read", () => {
    expect(companyAdminPerms).toContain("reports.appraisal.read");
  });

  it("company_admin's bundle contains EXACTLY ONE reports.appraisal.* key — read, and nothing wider", () => {
    const appraisalKeys = companyAdminPerms.filter((k) => k.startsWith("reports.appraisal."));
    expect(appraisalKeys).toEqual(["reports.appraisal.read"]);
  });

  // HIER-3 (2026-08-11): was 200 (199 + this one DR-5 grant). Two independent, concurrent changes
  // shifted it to 195 when this bundle was next regenerated: (a) HIER-3 itself retired
  // `core.team.{create,read,update,delete}` (4 keys) from company_admin's reach — the `team` kind
  // and `resource_team.yaml` are deleted entirely; (b) DR-12 (a concurrent, unrelated session)
  // deleted the dead staff-read rule on `resource_portal.yaml`, which had also granted
  // company_admin `portal.read` (1 key) — see that policy file's own header for the full finding.
  // 200 - 4 - 1 = 195. Verified directly against the regenerated bundle, not just arithmetic.
  it("company_admin's total bundle size is 195 (200 - 4 core.team.* (HIER-3) - 1 portal.read (DR-12, concurrent))", () => {
    expect(companyAdminPerms.length).toBe(195);
  });
});
