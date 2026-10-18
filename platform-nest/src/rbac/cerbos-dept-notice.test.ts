// DW-10a (docs/FRONTEND-BFF-CONTRACT.md §57, docs/PERMISSION-CONTRACT.md §47; owner ruling DW-D32: heads post, the department reads) —
// Cerbos matrix for the NEW core `dept_notice` kind.
//
// THE CLAIMS UNDER TEST
//   1. read: company_admin, manager, member, viewer and the HR read tier (hr_people_reader), all `inTenant && notLow`. TENANT-WIDE in
//      Cerbos on purpose: the per-unit narrowing is the handler's (core/unit-reach.ts), because Cerbos cannot read a placement.
//   2. post / edit / withdraw: company_admin (a unit notice AND a company-wide one); and an `org_unit_lead` whose grant's unit is in the
//      notice's `unitAncestors`, for a UNIT notice only (`scope == "unit"`), each action its own rule (HIER-2). manager, member, viewer
//      and the HR tier write nothing; a company-wide notice is company_admin only.
//   3. THE TENANT TRAP: an `org_unit` grant carries no tenant and node ids repeat across companies, so every rule keeps `inTenant`: the
//      head of company A's `d-webdev` is refused company B's `d-webdev` even with identical ancestors.
//   4. `scope` is a real attribute: in the Resource type AND the resourcePayload() allow-list. The same ancestors with `scope: "company"`
//      deny the head, with `scope: "unit"` allow it: a dropped attribute would deny both (`has()`), never allow.
//   5. EFFECT_DENY on post / edit / withdraw for automation and bot principals (beats the platform_admin wildcard and the lead rules);
//      read stays allowed (agents read notices).
//   6. The permission arm covers `read` ONLY; there is no post / edit / withdraw mirror (it would let a head post to EVERY unit).
//   7. `owner` (permission-native, zero rules) holds the same four keys as company_admin in its bundle, and Cerbos honours only `read`.
//   8. An unfed resource fails closed.
//
// Two layers:
//   A. STATIC (always runs): re-parses cerbos/policies/*.yaml and pins the structure.
//   B. LIVE (needs CERBOS_URL, same convention as cerbos-calendar-event.test.ts): the decision matrix against the real engine loaded with
//      the CURRENT policy files (restart `gaiada-test-cerbos` after the policy edit; a skip is not a pass).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { check, type Resource } from "./cerbos";
import type { Principal, RoleGrant, PermissionGrant } from "./principal";

const POLICIES_DIR = join(__dirname, "../../cerbos/policies");
const ACTIONS = ["read", "post", "edit", "withdraw"] as const;
const WRITES = ["post", "edit", "withdraw"] as const;

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
  expect(docs[0].resourcePolicy.resource).toBe("dept_notice");
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

describe("DW-10a static pin — resource_dept_notice.yaml", () => {
  const rules = parseKind("resource_dept_notice.yaml");
  const roleExprs = derivedRoleExprs();
  const allows = rules.filter((r) => r.effect === "EFFECT_ALLOW");
  const roleArm = allows.filter((r) => !r.derivedRoles.some((d) => d.startsWith("perm_") || d === "platform_admin"));
  const reach = (action: string) => roleArm.filter((r) => r.actions.includes(action));
  const tenantGate = "variables.inTenant && variables.notLow";
  const leadCond = `${tenantGate} && has(request.resource.attr.scope) && request.resource.attr.scope == "unit"`;

  it("read: company_admin, manager, member, viewer in one rule, and the HR read tier (hr_people_reader) in its OWN rule", () => {
    const rs = reach("read");
    expect(rs.length).toBe(2);
    const scopeRoles = rs.find((r) => r.derivedRoles.includes("company_admin"))!;
    expect([...scopeRoles.derivedRoles].sort()).toEqual(["company_admin", "manager", "member", "viewer"]);
    expect(scopeRoles.condition).toBe(tenantGate);
    const hr = rs.find((r) => r.derivedRoles.includes("hr_people_reader"))!;
    expect(hr.derivedRoles).toEqual(["hr_people_reader"]);
    expect(hr.condition).toBe(tenantGate);
    for (const r of rs) expect(r.actions, "no read rule carries another action").toEqual(["read"]);
  });

  it("post, edit and withdraw: company_admin in one rule, and the head on its OWN rule per action (never mixed, never beside another action)", () => {
    const admin = allows.filter((r) => r.derivedRoles.includes("company_admin") && r.actions.some((a) => (WRITES as readonly string[]).includes(a)));
    expect(admin.length).toBe(1);
    expect(admin[0].derivedRoles).toEqual(["company_admin"]);
    expect([...admin[0].actions].sort()).toEqual([...WRITES].sort());
    expect(admin[0].condition).toBe(tenantGate);
    for (const a of WRITES) {
      const heads = roleArm.filter((r) => r.derivedRoles.includes("org_unit_lead") && r.actions.includes(a));
      expect(heads.length, a).toBe(1);
      expect(heads[0].derivedRoles, `${a}: org_unit_lead stands alone`).toEqual(["org_unit_lead"]);
      expect(heads[0].actions, `${a}: one action per lead rule`).toEqual([a]);
      expect(heads[0].condition, a).toBe(leadCond);
    }
  });

  it("every ALLOW but the platform_admin wildcard keeps `variables.inTenant` (the tenant trap: an org_unit grant carries no tenant)", () => {
    for (const r of allows.filter((x) => !x.derivedRoles.includes("platform_admin"))) {
      expect(r.condition, JSON.stringify(r.actions)).toContain("variables.inTenant");
      expect(r.condition).toContain("variables.notLow");
    }
  });

  it("manager, member, viewer and the HR tier hold no write rule; the `client` role is named by no rule", () => {
    for (const r of roleArm.filter((x) => x.actions.some((a) => (WRITES as readonly string[]).includes(a)))) {
      for (const role of ["manager", "member", "viewer", "hr_people_reader", "client"]) expect(r.derivedRoles, JSON.stringify(r.actions)).not.toContain(role);
    }
    for (const r of rules) {
      expect(r.derivedRoles).not.toContain("client");
      expect(r.roles).not.toContain("client");
    }
  });

  it("one EFFECT_DENY, on roles [user]: post, edit and withdraw for automation and bot (NOT read)", () => {
    const denies = rules.filter((r) => r.effect === "EFFECT_DENY");
    expect(denies.length).toBe(1);
    expect(denies[0].roles).toEqual(["user"]);
    expect([...denies[0].actions].sort()).toEqual([...WRITES].sort());
    expect(denies[0].actions).not.toContain("read");
    expect(denies[0].condition).toBe('has(request.principal.attr.kind) && request.principal.attr.kind in ["automation", "bot"]');
  });

  it("the permission arm mirrors read exactly once, under inTenant && notLow && inRoot, and NOT post / edit / withdraw", () => {
    const mirrors = rules.filter((r) => r.derivedRoles.some((d) => d.startsWith("perm_")));
    expect(mirrors.length).toBe(1);
    expect(mirrors[0].actions).toEqual(["read"]);
    expect(mirrors[0].derivedRoles).toEqual(["perm_dept_notice_read"]);
    expect(mirrors[0].condition).toBe("variables.inTenant && variables.notLow && variables.inRoot");
    const expr = roleExprs.get("perm_dept_notice_read");
    expect(expr, "perm_dept_notice_read must exist in derived_roles.yaml").toBeTruthy();
    expect(expr).toContain('g.key == "core.dept_notice.read"');
    expect(expr).toContain('g.scopeType == "global"');
    expect(expr).toContain('g.scopeType == "company" && g.scopeId == request.resource.attr.tenantId');
    for (const a of WRITES) expect(roleExprs.has(`perm_dept_notice_${a}`), a).toBe(false);
  });

  it("`scope` reaches the policy: the Resource type AND the resourcePayload() allow-list carry it (default unit), and so does unitAncestors", () => {
    const src = readFileSync(join(__dirname, "cerbos.ts"), "utf8");
    expect(src).toContain("scope?: string;");
    expect(src).toContain('scope: r.scope ?? "unit"');
    expect(src).toContain("unitAncestors: r.unitAncestors ?? []");
  });

  it("the bundle JSON: company_admin == owner == platform_admin (all four), manager/member/viewer/hr_staff/hr_manager read, org_unit_lead the three writes, nobody else", () => {
    const doc = JSON.parse(readFileSync(join(__dirname, "role-permission-bundles.json"), "utf8")) as {
      roles: Record<string, string[]>;
      selfScoped: Record<string, string[]>;
    };
    const keys = (role: string) => doc.roles[role].filter((k) => k.startsWith("core.dept_notice.")).sort();
    const all = ACTIONS.map((a) => `core.dept_notice.${a}`).sort();
    const read = ["core.dept_notice.read"];
    expect(keys("company_admin")).toEqual(all);
    expect(keys("owner")).toEqual(all);
    expect(keys("platform_admin")).toEqual(all);
    for (const role of ["manager", "member", "viewer", "hr_staff", "hr_manager"]) expect(keys(role), role).toEqual(read);
    expect(keys("org_unit_lead")).toEqual(WRITES.map((a) => `core.dept_notice.${a}`).sort());
    for (const role of Object.keys(doc.roles)) {
      if (!["company_admin", "owner", "platform_admin", "manager", "member", "viewer", "hr_staff", "hr_manager", "org_unit_lead"].includes(role)) {
        expect(keys(role), role).toEqual([]);
      }
    }
    for (const role of Object.keys(doc.selfScoped ?? {})) {
      expect((doc.selfScoped[role] ?? []).filter((k) => k.startsWith("core.dept_notice.")), `${role}: no self-scoped dept_notice pair`).toEqual([]);
    }
  });
});

// ─── B. LIVE matrix ───────────────────────────────────────────────────────────────────────────────────────────
const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const T1 = "aaaaaaaa-9999-0000-0000-000000000001";
const T2 = "aaaaaaaa-9999-0000-0000-000000000002";
const ME = "u-me";

function principal(
  roles: RoleGrant[],
  opts: { perms?: PermissionGrant[]; companies?: string[]; assurance?: Principal["assurance"]; userId?: string; kind?: string } = {},
): Principal {
  const companies = opts.companies ?? [T1];
  return {
    userId: opts.userId ?? ME, assurance: opts.assurance ?? "high", companies,
    rootCompanies: companies, roles, perms: opts.perms ?? [], sessionVersion: 1,
    ...(opts.kind ? { kind: opts.kind } : {}),
  } as Principal;
}
const co = (role: string, scopeId = T1): RoleGrant => ({ role, scopeType: "company", scopeId });
const glob = (role: string): RoleGrant => ({ role, scopeType: "global", scopeId: null });
// DW-10g-2 Part B: an org_unit_lead grant carries the companies whose own lead seat backs it (assemblePrincipal() resolves
// them); the derived role requires the resource's company to be one. Default: the matrix's own company.
const unitGrant = (unit: string, tenantIds: string[] = [T1]): RoleGrant => ({ role: "org_unit_lead", scopeType: "org_unit", scopeId: unit, tenantIds });

// A notice of the division `dv-fe`, in department `d-web`, under the root `d-corp`: the closure's self-inclusive ancestry, nearest first.
const WEB_CHAIN = ["dv-fe", "d-web", "d-corp"];
const unitNotice = (extra: Partial<Resource> = {}, tenantId = T1): Resource => ({
  kind: "dept_notice", tenantId, id: "44444444-4444-4444-4444-444444444444", scope: "unit", unitAncestors: WEB_CHAIN, ...extra,
});
// A notice of a sibling department (`d-seo`): the same root, a different branch.
const seoNotice = (extra: Partial<Resource> = {}): Resource => unitNotice({ unitAncestors: ["d-seo", "d-corp"], ...extra });
// A company-wide notice: no unit, so no ancestry.
const companyNotice = (extra: Partial<Resource> = {}): Resource => unitNotice({ scope: "company", unitAncestors: [], ...extra });
const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;

type Cell = Record<(typeof ACTIONS)[number], boolean>;
const NONE: Cell = { read: false, post: false, edit: false, withdraw: false };
const cell = (over: Partial<Cell>): Cell => ({ ...NONE, ...over });
const READ = cell({ read: true });
const ALL = cell({ read: true, post: true, edit: true, withdraw: true });
const WRITE_ONLY = cell({ post: true, edit: true, withdraw: true });

describe.skipIf(!live)("DW-10a Cerbos matrix — dept_notice (role x action)", () => {
  const table: Array<[string, Principal, Resource, Cell]> = [
    // the full-reach tier: a unit notice and a company-wide one
    ["platform_admin (global), a unit notice", principal([glob("platform_admin")]), unitNotice(), ALL],
    ["platform_admin (global), a company-wide notice", principal([glob("platform_admin")]), companyNotice(), ALL],
    ["company_admin @T1, a unit notice", principal([co("company_admin")]), unitNotice(), ALL],
    ["company_admin @T1, a company-wide notice (only company_admin posts there)", principal([co("company_admin")]), companyNotice(), ALL],
    // the read tier writes nothing
    ["manager @T1, a unit notice: read only (every head carries manager, so manager cannot mean 'the head of this department')", principal([co("manager")]), unitNotice(), READ],
    ["manager @T1, a company-wide notice: read only", principal([co("manager")]), companyNotice(), READ],
    ["member @T1, a unit notice: read only (a member of the unit cannot post)", principal([co("member")]), unitNotice(), READ],
    ["member @T1, a company-wide notice: read only", principal([co("member")]), companyNotice(), READ],
    ["viewer @T1: read only", principal([co("viewer")]), unitNotice(), READ],
    ["hr_staff @T1 (the HR read tier): read only", principal([co("hr_staff")]), unitNotice(), READ],
    ["hr_manager @T1 (the HR read tier): read only", principal([co("hr_manager")]), companyNotice(), READ],
    // the head: its own rule, its own unit's subtree, UNIT notices only
    ["head of d-web (+ member), a notice of dv-fe below it: reads and posts, edits, withdraws", principal([co("member"), unitGrant("d-web")]), unitNotice(), ALL],
    ["head of dv-fe itself (+ member), a notice of dv-fe: the unit itself is in its own ancestry", principal([co("member"), unitGrant("dv-fe")]), unitNotice(), ALL],
    ["head of d-corp's root (+ member): a head ABOVE reaches every unit under it", principal([co("member"), unitGrant("d-corp")]), unitNotice(), ALL],
    ["head of d-seo (+ member), a notice of the SIBLING department d-web: reads, cannot post, edit or withdraw", principal([co("member"), unitGrant("d-seo")]), unitNotice(), READ],
    ["head of dv-fe (+ member), a notice of the department ABOVE it (d-web): a head below does not manage what is above", principal([co("member"), unitGrant("dv-fe")]), unitNotice({ unitAncestors: ["d-web", "d-corp"] }), READ],
    ["head of d-web (+ member), a COMPANY-WIDE notice: reads, never writes (the lead rule carries scope == unit)", principal([co("member"), unitGrant("d-web")]), companyNotice(), READ],
    ["head of d-corp's root (+ member), a COMPANY-WIDE notice: still no write", principal([co("member"), unitGrant("d-corp")]), companyNotice(), READ],
    ["head of d-web as org_unit_lead ALONE (no scope role): the three writes, and no read (read has no lead rule)", principal([unitGrant("d-web")]), unitNotice(), WRITE_ONLY],
    ["a head with a manager grant too (the real head shape): the manager part reads, the lead part writes its unit only", principal([co("manager"), unitGrant("d-web")]), seoNotice(), READ],
    // the tenant trap
    ["head of d-web whose companies are [T1], a notice of T2 with the SAME node ids: nothing (inTenant)", principal([co("member"), unitGrant("d-web")]), unitNotice({}, T2), NONE],
    // DW-10g-2 Part B: a member of BOTH companies whose lead seat is in T2 only: in T1 a plain member (reads), never the lead writes
    ["DW-10g-2: head of T2's d-web (seat in T2), member of T1 and T2, a T1 notice on the SAME node: reads only", principal([co("member"), unitGrant("d-web", [T2])], { companies: [T1, T2] }), unitNotice(), READ],
    ["DW-10g-2: the same head on T2's own notice: the lead writes there", principal([co("member", T2), unitGrant("d-web", [T2])], { companies: [T1, T2] }), unitNotice({}, T2), ALL],
    ["company_admin of T2 only, a T1 notice", principal([co("company_admin", T2)], { companies: [T2] }), unitNotice(), NONE],
    ["company_admin @T1, a T2 notice", principal([co("company_admin")]), unitNotice({}, T2), NONE],
    // the boundary
    ["company_admin @T1 at LOW assurance (notLow)", principal([co("company_admin")], { assurance: "low" }), unitNotice(), NONE],
    ["head of d-web at LOW assurance", principal([co("member"), unitGrant("d-web")], { assurance: "low" }), unitNotice(), NONE],
    ["client @T1 (a portal contact never reads a notice)", principal([co("client")]), unitNotice(), NONE],
    ["a webdev_manager @T1 (a module tier)", principal([co("webdev_manager")]), unitNotice(), NONE],
    ["no grants at all", principal([]), unitNotice(), NONE],
    // the DENY: agents read, never post, edit or withdraw
    ["a BOT holding manager: reads only", principal([co("manager")], { kind: "bot" }), unitNotice(), READ],
    ["a BOT holding member: reads only", principal([co("member")], { kind: "bot" }), unitNotice(), READ],
    ["an AUTOMATION principal holding company_admin: reads only", principal([co("company_admin")], { kind: "automation" }), unitNotice(), READ],
    ["a BOT that is the head of d-web: reads, cannot post (the DENY beats the lead rule)", principal([co("member"), unitGrant("d-web")], { kind: "bot" }), unitNotice(), READ],
    ["platform_admin that is a bot: reads only (the DENY beats the wildcard)", principal([glob("platform_admin")], { kind: "bot" }), unitNotice(), READ],
    ["an employee-kind principal is unaffected by the DENY", principal([co("company_admin")], { kind: "employee" }), unitNotice(), ALL],
    // an UNFED resource fails closed
    ["company_admin on an UNFED notice (no attributes sent): everything (no attribute-dependent rule to fail)", principal([co("company_admin")]), { kind: "dept_notice", tenantId: T1 }, ALL],
    ["member on an UNFED notice: read only", principal([co("member")]), { kind: "dept_notice", tenantId: T1 }, READ],
    ["head of d-web on an UNFED notice: no ancestry, so no write", principal([co("member"), unitGrant("d-web")]), { kind: "dept_notice", tenantId: T1 }, READ],
  ];

  for (const [label, p, r, expected] of table) {
    it(`${label}`, async () => {
      for (const action of ACTIONS) {
        expect(await allow(p, r, action), `${label}: dept_notice · ${action}`).toBe(expected[action]);
      }
    });
  }

  it("`scope` is read by the lead rule: the SAME ancestry with scope unit allows, with scope company denies, and an unfed scope (the default unit) allows (a dropped attribute could only deny)", async () => {
    const head = principal([co("member"), unitGrant("d-web")]);
    for (const a of WRITES) {
      expect(await allow(head, unitNotice({ scope: "unit" }), a), `unit · ${a}`).toBe(true);
      expect(await allow(head, unitNotice({ scope: "company" }), a), `company · ${a}`).toBe(false);
      expect(await allow(head, unitNotice({ scope: undefined }), a), `unfed (default unit) · ${a}`).toBe(true);
      expect(await allow(head, unitNotice({ scope: "everything" }), a), `any other word · ${a}`).toBe(false);
    }
  });

  it("the head's rule needs the ancestry: an empty list denies, and so does a list holding other units only", async () => {
    const head = principal([co("member"), unitGrant("d-web")]);
    for (const a of WRITES) {
      expect(await allow(head, unitNotice({ unitAncestors: [] }), a), `[] · ${a}`).toBe(false);
      expect(await allow(head, unitNotice({ unitAncestors: undefined }), a), `unfed · ${a}`).toBe(false);
      expect(await allow(head, unitNotice({ unitAncestors: ["d-seo", "d-corp"] }), a), `other branch · ${a}`).toBe(false);
    }
  });

  it("each head action is its own rule: a head holding the grant of ONE unit is allowed on that unit's notice for all three, and none on another's", async () => {
    const head = principal([unitGrant("dv-fe")]);
    for (const a of WRITES) {
      expect(await allow(head, unitNotice(), a), a).toBe(true);
      expect(await allow(head, seoNotice(), a), a).toBe(false);
    }
  });

  it("an unlisted action is a deny (only platform_admin holds '*')", async () => {
    expect(await allow(principal([co("company_admin")]), unitNotice(), "delete")).toBe(false);
    expect(await allow(principal([glob("platform_admin")]), unitNotice(), "delete")).toBe(true);
  });
});

describe.skipIf(!live)("DW-10a Cerbos matrix — dept_notice, the permission arm (roles: [])", () => {
  const permP = (key: string, scopeType: "company" | "global" = "company", opts: { assurance?: Principal["assurance"]; kind?: string } = {}) =>
    principal([], { perms: [{ key, scopeType, scopeId: scopeType === "company" ? T1 : null }], ...opts });

  it("permission core.dept_notice.read ALONE allows read and no sibling action; no cross-tenant, no low assurance", async () => {
    const key = "core.dept_notice.read";
    expect(await allow(permP(key), unitNotice(), "read")).toBe(true);
    expect(await allow(permP(key), companyNotice(), "read")).toBe(true);
    expect(await allow(permP(key, "global"), unitNotice(), "read")).toBe(true);
    for (const other of WRITES) expect(await allow(permP(key), unitNotice(), other), `${key} must not allow ${other}`).toBe(false);
    expect(await allow(permP(key), unitNotice({}, T2), "read")).toBe(false);
    expect(await allow(permP(key, "company", { assurance: "low" }), unitNotice(), "read")).toBe(false);
  });

  it("a bot holding the read permission still reads (the DENY lists the writes only)", async () => {
    expect(await allow(permP("core.dept_notice.read", "company", { kind: "bot" }), unitNotice(), "read")).toBe(true);
  });

  it("the bare post / edit / withdraw permissions allow NOTHING (there is deliberately no mirror: it would let a head post to every unit)", async () => {
    for (const a of WRITES) {
      expect(await allow(permP(`core.dept_notice.${a}`), unitNotice(), a), a).toBe(false);
      expect(await allow(permP(`core.dept_notice.${a}`, "global"), companyNotice(), a), `${a} global`).toBe(false);
    }
  });

  it("a permission-native OWNER (the bundle's four keys, zero rules) reads, but its post / edit / withdraw keys have no arm", async () => {
    const bundles = JSON.parse(readFileSync(join(__dirname, "role-permission-bundles.json"), "utf8")) as { roles: Record<string, string[]> };
    const ownerP = principal([co("owner")], {
      perms: bundles.roles.owner.map((key) => ({ key, scopeType: "company" as const, scopeId: T1 })),
    });
    expect(await allow(ownerP, unitNotice(), "read")).toBe(true);
    for (const a of WRITES) expect(await allow(ownerP, unitNotice(), a), `owner · ${a}`).toBe(false);
  });
});
