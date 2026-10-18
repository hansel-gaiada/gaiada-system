// DW-4e-1 (docs/FRONTEND-BFF-CONTRACT.md §40.2) — Cerbos matrix for the NEW `dept_kpi_target` kind (module reports).
//
// THE CLAIMS UNDER TEST
//   1. read: company_admin / manager / member / viewer, and the HR read tier (hr_people_reader = hr_staff/hr_manager).
//      Tenant-wide on purpose: the per-unit narrowing is the handler's (placement as of today is not a Cerbos fact).
//   2. propose: company_admin, and an org_unit_lead of the unit or an enclosing one (its own rule, `unitAncestors`).
//      Never manager, member, viewer or the HR tier.
//   3. approve and reject: company_admin only. `manager` (every head's company-wide role) never decides.
//   4. Each attribute-dependent rule stands alone (HIER-2 authoring rule): org_unit_lead is never beside a scope role.
//   5. The permission arm covers read, approve and reject and NOT propose (the mirror-reach invariant).
//   6. `owner` (permission-native, zero rules) holds the same keys as company_admin in its bundle, and reaches
//      read/approve/reject (and appraisal_assess) through the mirrors but not propose or appraisal_comment.
//   7. DW-4e-3 (FRONTEND-BFF-CONTRACT §41.3), two more actions on the SAME kind:
//      appraisal_comment: company_admin, and an org_unit_lead of the unit or an enclosing one (its own rule,
//        `unitAncestors`), never manager/member/viewer/the HR tier; NO permission mirror (the lead rule is
//        attribute-dependent), exactly as propose.
//      appraisal_assess: company_admin only (the approver tier), with a permission mirror (owner reaches it); a head
//        never assesses.
//
// Two layers:
//   A. STATIC (always runs): re-parses cerbos/policies/*.yaml and pins the structure.
//   B. LIVE (needs CERBOS_URL, same convention as cerbos-work-request.test.ts): the decision matrix against the real
//      engine loaded with the CURRENT policy files (restart `gaiada-test-cerbos` after the policy edit; a skip is not a
//      pass).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { check, type Resource } from "./cerbos";
import type { Principal, RoleGrant, PermissionGrant } from "./principal";

const POLICIES_DIR = join(__dirname, "../../cerbos/policies");
const ACTIONS = ["read", "propose", "approve", "reject", "appraisal_comment", "appraisal_assess"] as const;
const MIRRORED = ["read", "approve", "reject", "appraisal_assess"] as const;

interface ParsedRule {
  actions: string[];
  effect: string;
  derivedRoles: string[];
  roles: string[];
  condition: string;
}
function parseKind(file: string): ParsedRule[] {
  const text = readFileSync(join(POLICIES_DIR, file), "utf8");
  const docs = (yaml.loadAll(text) as any[]).filter((d) => d?.resourcePolicy);
  expect(docs.length, `${file} must hold exactly one resourcePolicy`).toBe(1);
  expect(docs[0].resourcePolicy.resource).toBe("dept_kpi_target");
  return (docs[0].resourcePolicy.rules ?? []).map((r: any) => ({
    actions: r.actions ?? [],
    effect: r.effect ?? "EFFECT_ALLOW",
    derivedRoles: r.derivedRoles ?? [],
    roles: r.roles ?? [],
    condition: (r.condition?.match?.expr ?? "").replace(/\s+/g, " ").trim(),
  }));
}
function derivedRoleExprs(): Map<string, string> {
  const text = readFileSync(join(POLICIES_DIR, "derived_roles.yaml"), "utf8");
  const out = new Map<string, string>();
  for (const doc of yaml.loadAll(text) as any[]) {
    for (const d of doc?.derivedRoles?.definitions ?? []) {
      const expr = d?.condition?.match?.expr;
      if (expr) out.set(d.name, expr);
    }
  }
  return out;
}

describe("DW-4e-1 static pin — resource_dept_kpi_target.yaml", () => {
  const rules = parseKind("resource_dept_kpi_target.yaml");
  const roleExprs = derivedRoleExprs();
  const allows = rules.filter((r) => r.effect === "EFFECT_ALLOW");
  const roleArm = allows.filter((r) => !r.derivedRoles.some((d) => d.startsWith("perm_") || d === "platform_admin"));
  const reach = (action: string) => roleArm.filter((r) => r.actions.includes(action));

  it("platform_admin holds the wildcard; there is no DENY rule", () => {
    expect(allows.filter((r) => r.derivedRoles.includes("platform_admin")).map((r) => r.actions)).toEqual([["*"]]);
    expect(rules.filter((r) => r.effect === "EFFECT_DENY")).toEqual([]);
  });

  it("read = company_admin/manager/member/viewer in one rule, plus the HR read tier in its own", () => {
    const rs = reach("read");
    expect(rs.length).toBe(2);
    expect(rs.flatMap((r) => r.derivedRoles).sort()).toEqual(["company_admin", "hr_people_reader", "manager", "member", "viewer"]);
    expect(rs.find((r) => r.derivedRoles.includes("hr_people_reader"))!.derivedRoles).toEqual(["hr_people_reader"]);
    for (const r of rs) expect(r.condition).toBe("variables.inTenant && variables.notLow");
  });

  it("propose has TWO rules: company_admin, and org_unit_lead on its own", () => {
    const rs = reach("propose");
    expect(rs.length).toBe(2);
    expect(rs.find((r) => r.derivedRoles.includes("company_admin"))!.derivedRoles).toEqual(["company_admin"]);
    const lead = rs.find((r) => r.derivedRoles.includes("org_unit_lead"))!;
    expect(lead.derivedRoles, "org_unit_lead is never mixed with a scope role (HIER-2 §1.4)").toEqual(["org_unit_lead"]);
    expect(lead.actions).toEqual(["propose"]);
  });

  it("approve and reject: company_admin only — never manager, member, viewer, the HR tier or org_unit_lead", () => {
    for (const a of ["approve", "reject"]) {
      expect(reach(a).flatMap((r) => r.derivedRoles), a).toEqual(["company_admin"]);
    }
  });

  it("appraisal_comment has TWO rules (DW-4e-3): company_admin, and org_unit_lead on its own", () => {
    const rs = reach("appraisal_comment");
    expect(rs.length).toBe(2);
    expect(rs.find((r) => r.derivedRoles.includes("company_admin"))!.derivedRoles).toEqual(["company_admin"]);
    const lead = rs.find((r) => r.derivedRoles.includes("org_unit_lead"))!;
    expect(lead.derivedRoles, "org_unit_lead is never mixed with a scope role (HIER-2 §1.4)").toEqual(["org_unit_lead"]);
    expect(lead.actions).toEqual(["appraisal_comment"]);
  });

  it("appraisal_assess: company_admin only — never manager, member, viewer, the HR tier or org_unit_lead", () => {
    expect(reach("appraisal_assess").flatMap((r) => r.derivedRoles)).toEqual(["company_admin"]);
  });

  it("org_unit_lead appears only on propose and appraisal_comment, and always alone", () => {
    const leadActions: string[] = [];
    for (const r of roleArm) {
      if (r.derivedRoles.includes("org_unit_lead")) {
        expect(r.derivedRoles).toEqual(["org_unit_lead"]);
        expect(r.actions.length).toBe(1);
        leadActions.push(...r.actions);
      }
    }
    expect(leadActions.sort()).toEqual(["appraisal_comment", "propose"]);
  });

  it("every role-arm rule is gated by inTenant && notLow", () => {
    for (const r of roleArm) expect(r.condition).toBe("variables.inTenant && variables.notLow");
  });

  it("the permission arm mirrors read, approve, reject and appraisal_assess exactly once each, under inTenant && notLow && inRoot, and NOT propose or appraisal_comment", () => {
    for (const a of MIRRORED) {
      const mirrors = rules.filter((r) => r.derivedRoles.some((d) => d.startsWith("perm_")) && r.actions.includes(a));
      expect(mirrors.length, `perm mirror rules for ${a}`).toBe(1);
      expect(mirrors[0].derivedRoles).toEqual([`perm_dept_kpi_target_${a}`]);
      expect(mirrors[0].actions).toEqual([a]);
      expect(mirrors[0].condition).toBe("variables.inTenant && variables.notLow && variables.inRoot");
      const expr = roleExprs.get(`perm_dept_kpi_target_${a}`);
      expect(expr, `perm_dept_kpi_target_${a} must exist in derived_roles.yaml`).toBeTruthy();
      expect(expr).toContain(`g.key == "reports.dept_kpi_target.${a}"`);
      expect(expr).toContain('g.scopeType == "global"');
      expect(expr).toContain('g.scopeType == "company" && g.scopeId == request.resource.attr.tenantId');
    }
    for (const a of ["propose", "appraisal_comment"]) {
      expect(rules.filter((r) => r.derivedRoles.some((d) => d.startsWith("perm_")) && r.actions.includes(a)), a).toEqual([]);
      expect(roleExprs.has(`perm_dept_kpi_target_${a}`), a).toBe(false);
    }
  });

  it("the `client` role is named by no rule", () => {
    for (const r of rules) {
      expect(r.derivedRoles).not.toContain("client");
      expect(r.roles).not.toContain("client");
    }
  });

  it("unitAncestors reaches the policy: the resourcePayload() allow-list carries it, failing closed", () => {
    const src = readFileSync(join(__dirname, "cerbos.ts"), "utf8");
    expect(src).toContain("unitAncestors?: string[];");
    expect(src).toContain("unitAncestors: r.unitAncestors ?? []");
  });

  it("the bundle JSON: owner == company_admin (all six), manager/member/viewer/hr_staff/hr_manager read, org_unit_lead propose + appraisal_comment, client none, no self-scoped pair", () => {
    const doc = JSON.parse(readFileSync(join(__dirname, "role-permission-bundles.json"), "utf8")) as {
      roles: Record<string, string[]>;
      selfScoped: Record<string, string[]>;
    };
    const keys = (role: string) => doc.roles[role].filter((k) => k.startsWith("reports.dept_kpi_target.")).sort();
    const all = ACTIONS.map((a) => `reports.dept_kpi_target.${a}`).sort();
    expect(keys("company_admin")).toEqual(all);
    expect(keys("owner")).toEqual(all);
    expect(keys("platform_admin")).toEqual(all);
    for (const role of ["manager", "member", "viewer", "hr_staff", "hr_manager"]) {
      expect(keys(role), role).toEqual(["reports.dept_kpi_target.read"]);
    }
    expect(keys("org_unit_lead")).toEqual(["reports.dept_kpi_target.appraisal_comment", "reports.dept_kpi_target.propose"]);
    for (const role of ["client", "reports_staff", "reports_manager", "webdev_manager", "agency_approver"]) {
      expect(keys(role), role).toEqual([]);
    }
    for (const list of Object.values(doc.selfScoped)) {
      expect(list.filter((k) => k.startsWith("reports.dept_kpi_target."))).toEqual([]);
    }
  });
});

// ─── B. LIVE matrix ───────────────────────────────────────────────────────────────────────────────────────────
const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const T1 = "aaaaaaaa-4e4e-0000-0000-000000000001";
const T2 = "aaaaaaaa-4e4e-0000-0000-000000000002";

function principal(
  roles: RoleGrant[],
  opts: { perms?: PermissionGrant[]; companies?: string[]; assurance?: Principal["assurance"] } = {},
): Principal {
  const companies = opts.companies ?? [T1];
  return {
    userId: "u-dw4e", assurance: opts.assurance ?? "high", companies,
    rootCompanies: companies, roles, perms: opts.perms ?? [], sessionVersion: 1,
  } as Principal;
}
const co = (role: string, scopeId = T1): RoleGrant => ({ role, scopeType: "company", scopeId });
const glob = (role: string): RoleGrant => ({ role, scopeType: "global", scopeId: null });
// DW-10g-2 Part B: an org_unit_lead grant carries the companies whose own lead seat backs it (assemblePrincipal() resolves
// them); the derived role requires the resource's company to be one. Default: the matrix's own company.
const lead = (unit: string, tenantIds: string[] = [T1]): RoleGrant => ({ role: "org_unit_lead", scopeType: "org_unit", scopeId: unit, tenantIds });

// A target of department d-web, which sits under d-corp; d-seo is its sibling.
const WEB_ANCESTORS = ["d-web", "d-corp"];
const target = (extra: Partial<Resource> = {}, tenantId = T1): Resource => ({
  kind: "dept_kpi_target", tenantId, module: "reports", id: "33333333-3333-3333-3333-333333333333",
  unitAncestors: WEB_ANCESTORS, ...extra,
});
const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;

type Cell = Record<(typeof ACTIONS)[number], boolean>;
const ALL: Cell = { read: true, propose: true, approve: true, reject: true, appraisal_comment: true, appraisal_assess: true };
const NONE: Cell = { read: false, propose: false, approve: false, reject: false, appraisal_comment: false, appraisal_assess: false };
const READ_ONLY: Cell = { ...NONE, read: true };

describe.skipIf(!live)("DW-4e-1 Cerbos matrix — dept_kpi_target (role x action)", () => {
  const table: Array<[string, Principal, Cell]> = [
    ["platform_admin (global)", principal([glob("platform_admin")]), ALL],
    ["company_admin @T1: the approver", principal([co("company_admin")]), ALL],
    ["manager @T1: reads only (every head carries it, so it never proposes or decides)", principal([co("manager")]), READ_ONLY],
    ["member @T1: reads only", principal([co("member")]), READ_ONLY],
    ["viewer @T1: reads only", principal([co("viewer")]), READ_ONLY],
    ["hr_staff @T1: reads only", principal([co("hr_staff")]), READ_ONLY],
    ["hr_manager @T1: reads only", principal([co("hr_manager")]), READ_ONLY],
    ["org_unit_lead of d-web alone: proposes and comments, nothing else (no read either, never assesses)", principal([lead("d-web")]), { ...NONE, propose: true, appraisal_comment: true }],
    ["org_unit_lead of d-corp (an ANCESTOR unit): proposes and comments", principal([lead("d-corp")]), { ...NONE, propose: true, appraisal_comment: true }],
    ["org_unit_lead of d-seo (a SIBLING unit): nothing", principal([lead("d-seo")]), NONE],
    ["org_unit_lead of d-web + manager (the real head shape): reads, proposes and comments, never decides or assesses", principal([lead("d-web"), co("manager")]), { ...READ_ONLY, propose: true, appraisal_comment: true }],
    ["company-scoped org_unit_lead grant (mis-scoped): nothing", principal([co("org_unit_lead")]), NONE],
    ["client @T1", principal([co("client")]), NONE],
    ["reports_manager @T1 (a module tier)", principal([co("reports_manager")]), NONE],
    ["company_admin of T2 only (cross-tenant)", principal([co("company_admin", T2)], { companies: [T2] }), NONE],
    ["company_admin @T1 at LOW assurance (notLow)", principal([co("company_admin")], { assurance: "low" }), NONE],
    ["no grants at all", principal([]), NONE],
  ];

  for (const [label, p, expected] of table) {
    it(`${label}`, async () => {
      for (const action of ACTIONS) {
        expect(await allow(p, target(), action), `${label}: dept_kpi_target · ${action}`).toBe(expected[action]);
      }
    });
  }

  it("the lead rule fails closed: an unfed unitAncestors ([]) denies, and the cascade is one-directional (down, never up)", async () => {
    for (const action of ["propose", "appraisal_comment"]) {
      expect(await allow(principal([lead("d-web")]), target({ unitAncestors: undefined }), action), action).toBe(false);
      expect(await allow(principal([lead("d-web")]), target({ unitAncestors: ["d-corp"] }), action), action).toBe(false);
      // a unit that is not in the org tree has no closure rows: the head is refused before existence is revealed
      expect(await allow(principal([lead("d-web")]), target({ unitAncestors: [] }), action), action).toBe(false);
    }
  });

  it("an unlisted action is a deny (only platform_admin holds '*')", async () => {
    expect(await allow(principal([co("company_admin")]), target(), "delete")).toBe(false);
    expect(await allow(principal([glob("platform_admin")]), target(), "delete")).toBe(true);
  });
});

describe.skipIf(!live)("DW-4e-1 Cerbos matrix — dept_kpi_target, the permission arm (roles: [])", () => {
  const permP = (key: string, scopeType: "company" | "global" = "company", opts: { assurance?: Principal["assurance"] } = {}) =>
    principal([], { perms: [{ key, scopeType, scopeId: scopeType === "company" ? T1 : null }], ...opts });

  for (const action of MIRRORED) {
    const key = `reports.dept_kpi_target.${action}`;
    it(`permission ${key} ALONE allows ${action} and no sibling action; no cross-tenant, no low assurance`, async () => {
      expect(await allow(permP(key), target(), action)).toBe(true);
      for (const other of ACTIONS.filter((a) => a !== action)) {
        expect(await allow(permP(key), target(), other), `${key} must not allow ${other}`).toBe(false);
      }
      expect(await allow(permP(key), target({}, T2), action)).toBe(false);
      expect(await allow(permP(key, "company", { assurance: "low" }), target(), action)).toBe(false);
    });
  }

  it("the bare propose and appraisal_comment permissions allow NOTHING (there is deliberately no mirror)", async () => {
    expect(await allow(permP("reports.dept_kpi_target.propose"), target(), "propose")).toBe(false);
    expect(await allow(permP("reports.dept_kpi_target.appraisal_comment"), target(), "appraisal_comment")).toBe(false);
  });

  it("a permission-native OWNER (the bundle's keys, zero rules) reads, approves, rejects and assesses, but its propose and appraisal_comment keys have no arm", async () => {
    const bundles = JSON.parse(readFileSync(join(__dirname, "role-permission-bundles.json"), "utf8")) as { roles: Record<string, string[]> };
    const ownerP = principal([co("owner")], {
      perms: bundles.roles.owner.map((key) => ({ key, scopeType: "company" as const, scopeId: T1 })),
    });
    for (const a of MIRRORED) expect(await allow(ownerP, target(), a), `owner · ${a}`).toBe(true);
    expect(await allow(ownerP, target(), "propose"), "owner · propose").toBe(false);
    expect(await allow(ownerP, target(), "appraisal_comment"), "owner · appraisal_comment").toBe(false);
  });
});
