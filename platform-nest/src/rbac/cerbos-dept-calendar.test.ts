// DW-10c (docs/FRONTEND-BFF-CONTRACT.md §59.1; docs/PERMISSION-CONTRACT.md §48; owner ruling DW-D33) — the NEW action
// `org_structure · read_calendar` on the EXISTING core `org_structure` kind. It gates the department calendar, which shows colleagues'
// APPROVED leave and its leave type to the department's people.
//
// THE CLAIMS UNDER TEST
//   1. read_calendar: company_admin, manager, member, viewer in ONE rule, and the HR read tier (`hr_people_reader` = hr_staff or
//      hr_manager) in its OWN rule, both `inTenant && notLow`. TENANT-WIDE in Cerbos on purpose: the per-unit narrowing needs the
//      caller's placement as of today, which Cerbos cannot read, so the handler applies it (core/unit-reach.ts).
//   2. A distinct action, not plain `read`: holding `read` (the org chart) and holding `read_calendar` are separate keys, and a rule for
//      one never grants the other.
//   3. The permission arm mirrors read_calendar (`perm_org_structure_read_calendar`, `inTenant && notLow && inRoot`) and grants no more
//      than the role arm (the action is reached only through scope-only rules).
//   4. NO EFFECT_DENY on the kind: bots and automation may read the calendar (there is no write on it).
//   5. `client`, `org_unit_lead` and every module tier are named by no read_calendar rule; a head reads through `manager`.
//   6. The bundles: platform_admin, company_admin, owner, manager, member, viewer, hr_staff, hr_manager hold the key; nobody else; not
//      self-scoped.
//
// Two layers:
//   A. STATIC (always runs): re-parses cerbos/policies/*.yaml, the catalogue, the groups and the bundles.
//   B. LIVE (needs CERBOS_URL, same convention as cerbos-dept-notice.test.ts): the decision matrix against the real engine loaded with
//      the CURRENT policy files (restart `gaiada-test-cerbos` after the policy edit; a skip is not a pass).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { check, type Resource } from "./cerbos";
import type { Principal, RoleGrant, PermissionGrant } from "./principal";

const POLICIES_DIR = join(__dirname, "../../cerbos/policies");
const KEY = "core.org_structure.read_calendar";

interface ParsedRule {
  actions: string[];
  effect: string;
  derivedRoles: string[];
  roles: string[];
  condition: string;
}
function parseOrgStructure(): ParsedRule[] {
  const text = readFileSync(join(POLICIES_DIR, "resource_org_structure.yaml"), "utf8");
  const docs = (yaml.loadAll(text) as any[]).filter((d) => d?.resourcePolicy);
  expect(docs.length, "resource_org_structure.yaml must hold exactly one resourcePolicy").toBe(1);
  expect(docs[0].resourcePolicy.resource).toBe("org_structure");
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

describe("DW-10c static pin — resource_org_structure.yaml · read_calendar", () => {
  const rules = parseOrgStructure();
  const roleExprs = derivedRoleExprs();
  const forAction = (a: string) => rules.filter((r) => r.actions.includes(a));
  const tenantGate = "variables.inTenant && variables.notLow";
  const reach = forAction("read_calendar").filter((r) => !r.derivedRoles.some((d) => d.startsWith("perm_") || d === "platform_admin"));

  it("read_calendar: company_admin, manager, member, viewer in one rule, and the HR read tier (hr_people_reader) in its OWN rule", () => {
    expect(reach.length).toBe(2);
    const scopeRoles = reach.find((r) => r.derivedRoles.includes("company_admin"))!;
    expect([...scopeRoles.derivedRoles].sort()).toEqual(["company_admin", "manager", "member", "viewer"]);
    expect(scopeRoles.condition).toBe(tenantGate);
    const hr = reach.find((r) => r.derivedRoles.includes("hr_people_reader"))!;
    expect(hr.derivedRoles).toEqual(["hr_people_reader"]);
    expect(hr.condition).toBe(tenantGate);
    for (const r of reach) expect(r.actions, "no read_calendar rule carries another action").toEqual(["read_calendar"]);
  });

  it("a distinct action: no `read` rule names read_calendar, and the `read` rules are byte-for-byte the pre-DW-10c ones", () => {
    for (const r of forAction("read")) expect(r.actions).toEqual(["read"]);
    const readRoleRule = forAction("read").find((r) => r.derivedRoles.includes("company_admin"))!;
    expect(readRoleRule.condition).toBe(tenantGate);
    expect([...readRoleRule.derivedRoles].sort()).toEqual(["company_admin", "manager", "member", "viewer"]);
    // the HR tier reads the calendar and NOT the org chart through its own rule: `read` has no hr_people_reader rule
    expect(forAction("read").some((r) => r.derivedRoles.includes("hr_people_reader"))).toBe(false);
  });

  it("every read_calendar ALLOW but the platform_admin wildcard keeps `variables.inTenant` and `variables.notLow`", () => {
    for (const r of forAction("read_calendar")) {
      expect(r.condition, JSON.stringify(r.derivedRoles)).toContain("variables.inTenant");
      expect(r.condition).toContain("variables.notLow");
    }
  });

  it("no EFFECT_DENY reaches read_calendar (bots and automation may read the calendar), and the client role and org_unit_lead are named by no rule", () => {
    // SCP-1r (SCP-D7) added ONE DENY to the kind, the unit self-edit DENY, on `update` alone (pinned in
    // cerbos-org-structure-self-edit.test.ts). It is the only DENY there may be: nothing narrows `read` or `read_calendar`.
    const denies = rules.filter((r) => r.effect === "EFFECT_DENY");
    expect(denies.map((r) => r.actions)).toEqual([["update"]]);
    expect(denies.filter((r) => r.actions.includes("read_calendar") || r.actions.includes("*")).length).toBe(0);
    for (const r of rules) {
      expect(r.derivedRoles).not.toContain("client");
      expect(r.derivedRoles).not.toContain("org_unit_lead");
      expect(r.roles).not.toContain("client");
    }
  });

  it("the permission arm mirrors read_calendar exactly once, under inTenant && notLow && inRoot, and its derived role keys on core.org_structure.read_calendar only", () => {
    const mirrors = forAction("read_calendar").filter((r) => r.derivedRoles.some((d) => d.startsWith("perm_")));
    expect(mirrors.length).toBe(1);
    expect(mirrors[0].actions).toEqual(["read_calendar"]);
    expect(mirrors[0].derivedRoles).toEqual(["perm_org_structure_read_calendar"]);
    expect(mirrors[0].condition).toBe("variables.inTenant && variables.notLow && variables.inRoot");
    const expr = roleExprs.get("perm_org_structure_read_calendar");
    expect(expr, "perm_org_structure_read_calendar must exist in derived_roles.yaml").toBeTruthy();
    expect(expr).toContain(`g.key == "${KEY}"`);
    expect(expr).toContain('g.scopeType == "global"');
    expect(expr).toContain('g.scopeType == "company" && g.scopeId == request.resource.attr.tenantId');
    // the older mirrors are untouched and stay on their own keys
    expect(roleExprs.get("perm_org_structure_read")).toContain('g.key == "core.org_structure.read"');
    expect(roleExprs.get("perm_org_structure_read")).not.toContain("read_calendar");
  });

  it("the catalogue entry: grantable, not sensitive, uiGrantable, on kind org_structure / action read_calendar, in a group, and the counts add up", () => {
    const catalog = JSON.parse(readFileSync(join(__dirname, "permission-catalog.json"), "utf8")) as {
      _meta: { counts: { concretePairs: number; grantable: number; cerbosKinds: number } };
      permissions: Array<{ key: string; class: string; sensitive: boolean; uiGrantable: boolean; cerbosKind: string; cerbosAction: string }>;
    };
    const entry = catalog.permissions.find((p) => p.key === KEY)!;
    expect(entry).toMatchObject({ class: "grantable", sensitive: false, uiGrantable: true, cerbosKind: "org_structure", cerbosAction: "read_calendar" });
    expect(catalog._meta.counts.concretePairs).toBe(catalog.permissions.length);
    expect(catalog._meta.counts.grantable).toBe(catalog.permissions.filter((p) => p.class === "grantable").length);
    const groups = JSON.parse(readFileSync(join(__dirname, "permission-groups.json"), "utf8")) as { groups: Array<{ key: string; permissions: string[] }> };
    expect(groups.groups.filter((g) => g.permissions.includes(KEY)).map((g) => g.key)).toEqual(["company_overview"]);
  });

  it("the bundle JSON: exactly the eight holders, no one else, and no self-scoped marker", () => {
    const doc = JSON.parse(readFileSync(join(__dirname, "role-permission-bundles.json"), "utf8")) as {
      roles: Record<string, string[]>;
      selfScoped: Record<string, string[]>;
    };
    const holders = Object.keys(doc.roles).filter((r) => doc.roles[r].includes(KEY)).sort();
    expect(holders).toEqual(["company_admin", "hr_manager", "hr_staff", "manager", "member", "owner", "platform_admin", "viewer"]);
    for (const role of ["client", "org_unit_lead", "webdev_staff", "webdev_manager", "reports_staff", "reports_manager"]) {
      expect(doc.roles[role] ?? [], role).not.toContain(KEY);
    }
    for (const role of Object.keys(doc.selfScoped ?? {})) expect(doc.selfScoped[role], role).not.toContain(KEY);
    // owner mirrors company_admin on the whole org_structure kind
    const org = (role: string) => doc.roles[role].filter((k) => k.startsWith("core.org_structure.")).sort();
    expect(org("owner")).toEqual(org("company_admin"));
  });
});

// ─── B. LIVE matrix ───────────────────────────────────────────────────────────────────────────────────────────
const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const T1 = "aaaaaaaa-9999-0000-0000-0000000000c1";
const T2 = "aaaaaaaa-9999-0000-0000-0000000000c2";
const ME = "u-me";

function principal(
  roles: RoleGrant[],
  opts: { perms?: PermissionGrant[]; companies?: string[]; assurance?: Principal["assurance"]; kind?: string } = {},
): Principal {
  const companies = opts.companies ?? [T1];
  return {
    userId: ME, assurance: opts.assurance ?? "high", companies, rootCompanies: companies, roles, perms: opts.perms ?? [], sessionVersion: 1,
    ...(opts.kind ? { kind: opts.kind } : {}),
  } as Principal;
}
const co = (role: string, scopeId = T1): RoleGrant => ({ role, scopeType: "company", scopeId });
const glob = (role: string): RoleGrant => ({ role, scopeType: "global", scopeId: null });
// DW-10g-2 Part B: an org_unit_lead grant carries the companies whose own lead seat backs it (assemblePrincipal() resolves
// them); the derived role requires the resource's company to be one. Default: the matrix's own company.
const unitGrant = (unit: string, tenantIds: string[] = [T1]): RoleGrant => ({ role: "org_unit_lead", scopeType: "org_unit", scopeId: unit, tenantIds });
const org = (tenantId = T1): Resource => ({ kind: "org_structure", tenantId });
const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;

describe.skipIf(!live)("DW-10c Cerbos matrix — org_structure · read_calendar (role x tenant)", () => {
  const table: Array<[string, Principal, Resource, boolean]> = [
    ["platform_admin (global)", principal([glob("platform_admin")]), org(), true],
    ["company_admin @T1", principal([co("company_admin")]), org(), true],
    ["manager @T1 (every head carries it)", principal([co("manager")]), org(), true],
    ["member @T1 (a person placed in the unit)", principal([co("member")]), org(), true],
    ["viewer @T1", principal([co("viewer")]), org(), true],
    ["hr_staff @T1 ALONE (the HR read tier, its own rule)", principal([co("hr_staff")]), org(), true],
    ["hr_manager @T1 ALONE (the HR read tier)", principal([co("hr_manager")]), org(), true],
    ["hr_staff of T2 only, a T1 company", principal([co("hr_staff", T2)], { companies: [T2] }), org(), false],
    ["a BOT holding member: bots may read the calendar (no deny, no write)", principal([co("member")], { kind: "bot" }), org(), true],
    ["an AUTOMATION principal holding company_admin", principal([co("company_admin")], { kind: "automation" }), org(), true],
    ["a head as org_unit_lead ALONE (no manager): not a reader on its own, a head reads through manager", principal([unitGrant("d-web")]), org(), false],
    ["a head with the real shape (manager + org_unit_lead)", principal([co("manager"), unitGrant("d-web")]), org(), true],
    ["client @T1 (a portal contact)", principal([co("client")]), org(), false],
    ["a webdev_manager @T1 (a module tier)", principal([co("webdev_manager")]), org(), false],
    ["a reports_staff @T1 (a module tier)", principal([co("reports_staff")]), org(), false],
    ["no grants at all", principal([]), org(), false],
    ["company_admin of T2 only, a T1 company (cross-tenant)", principal([co("company_admin", T2)], { companies: [T2] }), org(), false],
    ["company_admin @T1, a T2 company", principal([co("company_admin")]), org(T2), false],
    ["company_admin @T1 at LOW assurance (notLow)", principal([co("company_admin")], { assurance: "low" }), org(), false],
    ["member @T1 at LOW assurance", principal([co("member")], { assurance: "low" }), org(), false],
    ["hr_staff @T1 at LOW assurance", principal([co("hr_staff")], { assurance: "low" }), org(), false],
  ];

  for (const [label, p, r, expected] of table) {
    it(`${label}: ${expected ? "allowed" : "denied"}`, async () => {
      expect(await allow(p, r, "read_calendar"), `${label}: org_structure · read_calendar`).toBe(expected);
    });
  }

  it("`read` (the org chart) is a separate decision: the HR tier reads the calendar and NOT the org chart, a member does both", async () => {
    const hr = principal([co("hr_staff")]);
    expect(await allow(hr, org(), "read_calendar")).toBe(true);
    expect(await allow(hr, org(), "read")).toBe(false);
    const member = principal([co("member")]);
    expect(await allow(member, org(), "read")).toBe(true);
    expect(await allow(member, org(), "read_calendar")).toBe(true);
  });

  it("read_calendar is never a write: update stays company_admin's, and a member, a viewer and the HR tier cannot update the structure", async () => {
    for (const r of ["member", "viewer", "manager", "hr_staff", "hr_manager"]) expect(await allow(principal([co(r)]), org(), "update"), r).toBe(false);
    expect(await allow(principal([co("company_admin")]), org(), "update")).toBe(true);
  });

  it("an unlisted action is a deny (only platform_admin holds '*')", async () => {
    expect(await allow(principal([co("company_admin")]), org(), "read_leave")).toBe(false);
    expect(await allow(principal([glob("platform_admin")]), org(), "read_leave")).toBe(true);
  });
});

describe.skipIf(!live)("DW-10c Cerbos matrix — org_structure · read_calendar, the permission arm (roles: [])", () => {
  const permP = (key: string, scopeType: "company" | "global" = "company", opts: { assurance?: Principal["assurance"]; kind?: string } = {}) =>
    principal([], { perms: [{ key, scopeType, scopeId: scopeType === "company" ? T1 : null }], ...opts });

  it(`permission ${KEY} ALONE allows read_calendar and no sibling action; no cross-tenant, no low assurance`, async () => {
    expect(await allow(permP(KEY), org(), "read_calendar")).toBe(true);
    expect(await allow(permP(KEY, "global"), org(), "read_calendar")).toBe(true);
    expect(await allow(permP(KEY), org(), "read")).toBe(false);
    expect(await allow(permP(KEY), org(), "update")).toBe(false);
    expect(await allow(permP(KEY), org(T2), "read_calendar")).toBe(false);
    expect(await allow(permP(KEY, "company", { assurance: "low" }), org(), "read_calendar")).toBe(false);
  });

  it("the older org_structure.read permission ALONE does not open the calendar (a distinct key)", async () => {
    expect(await allow(permP("core.org_structure.read"), org(), "read")).toBe(true);
    expect(await allow(permP("core.org_structure.read"), org(), "read_calendar")).toBe(false);
  });

  it("a bot holding the read_calendar permission still reads it (no DENY on the kind)", async () => {
    expect(await allow(permP(KEY, "company", { kind: "bot" }), org(), "read_calendar")).toBe(true);
  });

  it("a permission-native OWNER (the bundle's keys, zero rules) reads the calendar through the mirror", async () => {
    const bundles = JSON.parse(readFileSync(join(__dirname, "role-permission-bundles.json"), "utf8")) as { roles: Record<string, string[]> };
    const ownerP = principal([co("owner")], {
      perms: bundles.roles.owner.map((key) => ({ key, scopeType: "company" as const, scopeId: T1 })),
    });
    expect(await allow(ownerP, org(), "read_calendar")).toBe(true);
  });
});
