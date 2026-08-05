// D14-06 — the `automation_approval` decider set, against LIVE Cerbos.
//
// OQ-1 locked: "approval is RBAC-role-based; superadmin approves for now and as the fallback", and
// D14-07 adds a `retry` action (re-executing an already-approved row whose execution FAILED). Both
// carry the same real-world consequence as the original decision — a medium+/unclassified write
// actually happening — so `retry` gets the decide set, not a weaker one.
//
// TWO FINDINGS THIS SUITE PINS, both of which change what the ticket asked for:
//
//  1. Superadmin needed NO policy addition. `resource_automation_approval.yaml` already opens with
//     `actions: ["*"] / derivedRoles: ["platform_admin"]`, so the platform superadmin could always
//     decide every origin and now covers `retry` for free. Adding a second explicit rule would have
//     been redundant, and two rules granting one thing is how a later "tidy-up" silently changes
//     authorization. The tests below prove the wildcard really does cover `retry` rather than
//     assuming it — a wildcard that failed to cover a new action would otherwise be discovered in
//     production, as a superadmin who cannot use the retry button.
//
//  2. `retry` is deliberately NOT granted to the WSD-2 `module_manager` (hr) rule. Constraint 7 says
//     superadmin must ADD to the existing rules rather than replace them, and that is honoured — the
//     hr rule is untouched for `read`/`decide`. But `retry` is meaningless for hr: hr rows keep
//     `execution_status='not_applicable'` (their decision is applied by
//     `modules/hr/leave-decision.ts`, not by the D14 executor), so there is never a failed execution
//     to retry. Granting an inert permission would imply hr retry is supported and invite someone to
//     wire it. The final test pins the asymmetry so it reads as intentional, not as an omission.
//
// Level: `check()` directly against Cerbos with a principal assembled from real DB grants. `retry`
// has no HTTP endpoint until D14-07, so an endpoint test cannot cover it yet — and the policy is the
// thing under test here, not the controller.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";
import { assemblePrincipal } from "../rbac/principal";
import { check } from "../rbac/cerbos";
import type { Principal } from "../rbac/principal";
import type { Decision } from "../rbac/cerbos";

/** `Decision` is a union — `reason` exists only on the deny arm. Narrow instead of reaching in, so a
 *  failure message stays useful without a cast. */
const why = (d: Decision) => (d.allow ? "(allowed)" : d.reason);

describe.skipIf(!TEST_URL)("D14-06 — automation_approval decide/retry decider set (live Cerbos)", () => {
  let co: string;
  let superadmin: Principal;
  let companyAdmin: Principal;
  let owner: Principal;
  let hrManager: Principal;
  let plainManager: Principal;

  /** The resource as the decide/retry paths present it. `module` mirrors the controller: "hr" only
   *  for hr-origin rows (WSD-4), undefined otherwise. */
  const row = (module?: string) => ({ kind: "automation_approval", tenantId: co, id: "row-1", module });

  const principalFor = async (email: string, roleName: string, scope: "global" | "company") => {
    const userId = await createUser(email);
    await addMembership(co, userId);
    const roleId = await createRole(roleName);
    await grantRole(userId, roleId, scope, scope === "global" ? null : co);
    // Assurance on the PLATFORM is "low" | "linked" | "high" — there is no "verified" (that is the
    // mcp-hub's separate vocabulary: anonymous | low | verified). Two enums, same word for neither.
    // "high" is what the policies' `notLow` condition wants; passing "verified" type-errored and only
    // appeared to work because any non-"low" string satisfies `notLow`.
    const p = await assemblePrincipal(userId, "high");
    if (!p) throw new Error(`could not assemble principal for ${email}`);
    return p;
  };

  beforeAll(async () => {
    await initTestDb();
    co = await createCompany("D14-06 Co", ["hr"]);
    superadmin = await principalFor("d1406-super@a.test", "platform_admin", "global");
    companyAdmin = await principalFor("d1406-admin@a.test", "company_admin", "company");
    // `group_executive` derives ONLY from a global-scope grant (derived_roles.yaml) — a company-scoped
    // grant of the same role name derives nothing. The owner is a group-level principal by definition,
    // so this is correct rather than a test convenience; company membership still supplies `companies`
    // for the `inTenant` condition.
    owner = await principalFor("d1406-owner@a.test", "group_executive", "global");
    hrManager = await principalFor("d1406-hrmgr@a.test", "hr_manager", "company");
    plainManager = await principalFor("d1406-mgr@a.test", "manager", "company");
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  it("superadmin decides AND retries every origin — via the pre-existing wildcard rule", async () => {
    for (const module of [undefined, "hr"]) {
      for (const action of ["decide", "retry"]) {
        const d = await check(superadmin, row(module), action);
        expect(d.allow, `superadmin ${action} module=${String(module)}: ${why(d)}`).toBe(true);
      }
    }
  });

  it("company_admin and group_executive still decide, and now retry (constraint 7: added to, not replaced)", async () => {
    for (const [name, p] of [["company_admin", companyAdmin], ["group_executive", owner]] as const) {
      for (const action of ["decide", "retry"]) {
        const d = await check(p, row(), action);
        expect(d.allow, `${name} ${action}: ${why(d)}`).toBe(true);
      }
    }
  });

  it("a plain manager can read the inbox but can neither decide nor retry", async () => {
    expect((await check(plainManager, row(), "read")).allow).toBe(true);
    expect((await check(plainManager, row(), "decide")).allow).toBe(false);
    expect((await check(plainManager, row(), "retry")).allow).toBe(false);
  });

  it("hr_manager decides ONLY hr-origin rows — the WSD-2 scoping is intact", async () => {
    expect((await check(hrManager, row("hr"), "decide")).allow).toBe(true);
    // The regression this pins: widening the module_manager rule (or dropping its module=="hr"
    // condition) would let a stray "<x>_manager" grant decide deploy.production.
    expect((await check(hrManager, row(), "decide")).allow).toBe(false);
    expect((await check(hrManager, row("some-other-module"), "decide")).allow).toBe(false);
  });

  it("hr_manager gets NO retry, by design — hr rows never have an execution to retry", async () => {
    // Intentional asymmetry, not an oversight: see this file's header, finding 2. If hr rows ever
    // become executor-driven, THIS test is the one to revisit first.
    expect((await check(hrManager, row("hr"), "retry")).allow).toBe(false);
  });
});
