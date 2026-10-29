// AIP-13b (docs/PERMISSION-CONTRACT.md §56, docs/FRONTEND-BFF-CONTRACT.md §65; owner ruling AIP-D10: each department head edits their own
// department's assistant preamble) — Cerbos matrix for the NEW core `dept_assistant_preamble` kind.
//
// THE CLAIMS UNDER TEST
//   1. read and edit: company_admin; and an `org_unit_lead` whose grant's unit is in the resource's `unitAncestors` (the unit itself or an
//      enclosing one), each action its own rule (HIER-2). Nobody else: manager, member, viewer, the HR tier and the module tiers hold NOTHING
//      (a member needs nothing: the assistant applies the text on the server).
//   2. `manage` is the company tier's own action (IAM-14c's key split): company_admin by role rule, the permission-native `owner` by the one
//      permission arm on the kind. A head holds neither the `manage` key nor a mirror to it, so a head never reaches a unit outside its subtree.
//   3. THE TENANT TRAP: an `org_unit` grant carries no tenant and node ids repeat across companies, so every rule keeps `inTenant`: the head
//      of company A's `d-web` is refused company B's `d-web` even with identical ancestors.
//   4. EFFECT_DENY on edit and manage for automation and bot principals (beats the platform_admin wildcard, the lead rule and the mirror);
//      read stays allowed.
//   5. The permission arm covers `manage` ONLY; there is no read / edit mirror (it would let a head reach EVERY unit).
//   6. An unfed resource fails closed.
//
// Two layers:
//   A. STATIC (always runs): re-parses cerbos/policies/*.yaml and pins the structure.
//   B. LIVE (needs CERBOS_URL, same convention as cerbos-dept-notice.test.ts): the decision matrix against the real engine loaded with the
//      CURRENT policy files (restart `gaiada-test-cerbos` after the policy edit; a skip is not a pass).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { check, type Resource } from "./cerbos";
import type { Principal, RoleGrant, PermissionGrant } from "./principal";

const POLICIES_DIR = join(__dirname, "../../cerbos/policies");
const ACTIONS = ["read", "edit", "manage"] as const;
const WRITES = ["edit", "manage"] as const;

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
  expect(docs[0].resourcePolicy.resource).toBe("dept_assistant_preamble");
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

describe("AIP-13b static pin — resource_dept_assistant_preamble.yaml", () => {
  const rules = parseKind("resource_dept_assistant_preamble.yaml");
  const roleExprs = derivedRoleExprs();
  const allows = rules.filter((r) => r.effect === "EFFECT_ALLOW");
  const roleArm = allows.filter((r) => !r.derivedRoles.some((d) => d.startsWith("perm_") || d === "platform_admin"));
  const tenantGate = "variables.inTenant && variables.notLow";

  it("the roles named anywhere in the policy are exactly platform_admin, company_admin, org_unit_lead and the manage mirror", () => {
    const named = new Set(allows.flatMap((r) => r.derivedRoles));
    expect([...named].sort()).toEqual(["company_admin", "org_unit_lead", "perm_dept_assistant_preamble_manage", "platform_admin"]);
    for (const r of rules) {
      for (const role of ["manager", "member", "viewer", "hr_people_reader", "client"]) {
        expect(r.derivedRoles, `${role} must hold nothing on this kind`).not.toContain(role);
        expect(r.roles).not.toContain(role);
      }
    }
  });

  it("company_admin: read, edit and manage in ONE rule, inTenant && notLow", () => {
    const admin = roleArm.filter((r) => r.derivedRoles.includes("company_admin"));
    expect(admin.length).toBe(1);
    expect(admin[0].derivedRoles).toEqual(["company_admin"]);
    expect([...admin[0].actions].sort()).toEqual([...ACTIONS].sort());
    expect(admin[0].condition).toBe(tenantGate);
  });

  it("the head: org_unit_lead stands ALONE in its own rule per action (read, edit), never mixed, never beside another action, never `manage`", () => {
    const heads = roleArm.filter((r) => r.derivedRoles.includes("org_unit_lead"));
    expect(heads.length).toBe(2);
    for (const a of ["read", "edit"]) {
      const h = heads.filter((r) => r.actions.includes(a));
      expect(h.length, a).toBe(1);
      expect(h[0].derivedRoles, `${a}: org_unit_lead stands alone`).toEqual(["org_unit_lead"]);
      expect(h[0].actions, `${a}: one action per lead rule`).toEqual([a]);
      expect(h[0].condition, a).toBe(tenantGate);
    }
    expect(heads.flatMap((r) => r.actions)).not.toContain("manage");
    expect(heads.flatMap((r) => r.actions)).not.toContain("*");
  });

  it("every ALLOW but the platform_admin wildcard keeps `variables.inTenant` (the tenant trap: an org_unit grant carries no tenant)", () => {
    for (const r of allows.filter((x) => !x.derivedRoles.includes("platform_admin"))) {
      expect(r.condition, JSON.stringify(r.actions)).toContain("variables.inTenant");
      expect(r.condition).toContain("variables.notLow");
    }
  });

  it("one EFFECT_DENY, on roles [user]: edit and manage for automation and bot (NOT read)", () => {
    const denies = rules.filter((r) => r.effect === "EFFECT_DENY");
    expect(denies.length).toBe(1);
    expect(denies[0].roles).toEqual(["user"]);
    expect([...denies[0].actions].sort()).toEqual([...WRITES].sort());
    expect(denies[0].actions).not.toContain("read");
    expect(denies[0].condition).toBe('has(request.principal.attr.kind) && request.principal.attr.kind in ["automation", "bot"]');
  });

  it("the permission arm mirrors `manage` exactly once, under inTenant && notLow && inRoot, and NOT read / edit (a mirror there would let a head reach every unit)", () => {
    const mirrors = rules.filter((r) => r.derivedRoles.some((d) => d.startsWith("perm_")));
    expect(mirrors.length).toBe(1);
    expect(mirrors[0].actions).toEqual(["manage"]);
    expect(mirrors[0].derivedRoles).toEqual(["perm_dept_assistant_preamble_manage"]);
    expect(mirrors[0].condition).toBe("variables.inTenant && variables.notLow && variables.inRoot");
    const expr = roleExprs.get("perm_dept_assistant_preamble_manage");
    expect(expr, "perm_dept_assistant_preamble_manage must exist in derived_roles.yaml").toBeTruthy();
    expect(expr).toContain('g.key == "core.dept_assistant_preamble.manage"');
    expect(expr).toContain('g.scopeType == "global"');
    expect(expr).toContain('g.scopeType == "company" && g.scopeId == request.resource.attr.tenantId');
    for (const a of ["read", "edit"]) expect(roleExprs.has(`perm_dept_assistant_preamble_${a}`), a).toBe(false);
  });

  it("`unitAncestors` reaches the policy: the Resource type and the resourcePayload() allow-list carry it (no new attribute was needed)", () => {
    const src = readFileSync(join(__dirname, "cerbos.ts"), "utf8");
    expect(src).toContain("unitAncestors?: string[];");
    expect(src).toContain("unitAncestors: r.unitAncestors ?? []");
  });

  it("the bundle JSON: company_admin == owner == platform_admin (read, edit, manage), org_unit_lead read and edit but NOT manage, nobody else", () => {
    const doc = JSON.parse(readFileSync(join(__dirname, "role-permission-bundles.json"), "utf8")) as {
      roles: Record<string, string[]>;
      selfScoped: Record<string, string[]>;
    };
    const keys = (role: string) => doc.roles[role].filter((k) => k.startsWith("core.dept_assistant_preamble.")).sort();
    const all = ACTIONS.map((a) => `core.dept_assistant_preamble.${a}`).sort();
    expect(keys("company_admin")).toEqual(all);
    expect(keys("owner")).toEqual(all);
    expect(keys("platform_admin")).toEqual(all);
    expect(keys("org_unit_lead")).toEqual(["core.dept_assistant_preamble.edit", "core.dept_assistant_preamble.read"]);
    for (const role of Object.keys(doc.roles)) {
      if (!["company_admin", "owner", "platform_admin", "org_unit_lead"].includes(role)) expect(keys(role), role).toEqual([]);
    }
    for (const role of Object.keys(doc.selfScoped ?? {})) {
      expect((doc.selfScoped[role] ?? []).filter((k) => k.startsWith("core.dept_assistant_preamble.")), `${role}: no self-scoped pair`).toEqual([]);
    }
  });

  it("the catalog entries: three grantable, non-sensitive, uiGrantable keys in domain core", () => {
    const cat = JSON.parse(readFileSync(join(__dirname, "permission-catalog.json"), "utf8")) as { permissions: any[] };
    const mine = cat.permissions.filter((p) => p.cerbosKind === "dept_assistant_preamble");
    expect(mine.map((p) => p.key).sort()).toEqual(ACTIONS.map((a) => `core.dept_assistant_preamble.${a}`).sort());
    for (const p of mine) {
      expect(p).toMatchObject({ domain: "core", class: "grantable", sensitive: false, uiGrantable: true });
      expect(p.cerbosAction).toBe(p.action);
    }
  });
});

// ─── B. LIVE matrix ───────────────────────────────────────────────────────────────────────────────────────────
const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const T1 = "aaaaaaaa-9999-0000-0000-0000000000a1";
const T2 = "aaaaaaaa-9999-0000-0000-0000000000a2";
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
// DW-10g-2 Part B: an org_unit_lead grant carries the companies whose own lead seat backs it (assemblePrincipal() resolves them); the derived
// role requires the resource's company to be one. Default: the matrix's own company.
const unitGrant = (unit: string, tenantIds: string[] = [T1]): RoleGrant => ({ role: "org_unit_lead", scopeType: "org_unit", scopeId: unit, tenantIds });

// The preamble of the department `d-web`, under the root `d-corp`: the closure's self-inclusive ancestry, nearest first. (A division
// `dv-fe` below it would carry ["dv-fe", "d-web", "d-corp"].)
const WEB_CHAIN = ["d-web", "d-corp"];
const webPreamble = (extra: Partial<Resource> = {}, tenantId = T1): Resource => ({ kind: "dept_assistant_preamble", tenantId, unitAncestors: WEB_CHAIN, ...extra });
const seoPreamble = (extra: Partial<Resource> = {}): Resource => webPreamble({ unitAncestors: ["d-seo", "d-corp"], ...extra });
const feChain = (extra: Partial<Resource> = {}): Resource => webPreamble({ unitAncestors: ["dv-fe", "d-web", "d-corp"], ...extra });
const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;

type Cell = Record<(typeof ACTIONS)[number], boolean>;
const NONE: Cell = { read: false, edit: false, manage: false };
const cell = (over: Partial<Cell>): Cell => ({ ...NONE, ...over });
const ALL = cell({ read: true, edit: true, manage: true });
const HEAD = cell({ read: true, edit: true }); // the head's reach: read and edit, never the company tier
const READ = cell({ read: true });

describe.skipIf(!live)("AIP-13b Cerbos matrix — dept_assistant_preamble (role x action)", () => {
  const table: Array<[string, Principal, Resource, Cell]> = [
    // the full-reach tier
    ["platform_admin (global)", principal([glob("platform_admin")]), webPreamble(), ALL],
    ["company_admin @T1", principal([co("company_admin")]), webPreamble(), ALL],
    ["company_admin @T1, another department (no ancestry fed for it): the company tier needs no unit", principal([co("company_admin")]), seoPreamble(), ALL],
    // the head: its own rules, its own unit's subtree
    ["head of d-web (+ member + manager): reads and edits its own department's preamble, not manage", principal([co("member"), co("manager"), unitGrant("d-web")]), webPreamble(), HEAD],
    ["head of d-web as org_unit_lead ALONE (no scope role): read and edit, not manage", principal([unitGrant("d-web")]), webPreamble(), HEAD],
    ["head of d-corp's root (+ member): a head ABOVE reaches every unit under it", principal([co("member"), unitGrant("d-corp")]), webPreamble(), HEAD],
    ["head of d-corp's root (+ member), the ROOT's own preamble: the unit itself is in its own ancestry", principal([co("member"), unitGrant("d-corp")]), webPreamble({ unitAncestors: ["d-corp"] }), HEAD],
    ["head of d-web (+ member), a preamble of the division dv-fe BELOW it (ancestry holds d-web): reads and edits", principal([co("member"), unitGrant("d-web")]), feChain(), HEAD],
    ["head of dv-fe (+ member), the department ABOVE it (d-web): a head below does not manage what is above", principal([co("member"), unitGrant("dv-fe")]), webPreamble(), NONE],
    ["head of d-seo (+ member), the SIBLING department d-web: nothing", principal([co("member"), unitGrant("d-seo")]), webPreamble(), NONE],
    ["head of d-web (+ manager), the sibling d-seo's preamble: nothing", principal([co("manager"), unitGrant("d-web")]), seoPreamble(), NONE],
    // the tenant trap
    ["head of d-web whose companies are [T1], a preamble of T2 with the SAME node ids: nothing (inTenant)", principal([co("member"), unitGrant("d-web")]), webPreamble({}, T2), NONE],
    // DW-10g-2 Part B: a member of BOTH companies whose lead seat is in T2 only: in T1 nothing, never the lead rules
    ["DW-10g-2: head of T2's d-web (seat in T2), member of T1 and T2, a T1 preamble on the SAME node: nothing", principal([co("member"), unitGrant("d-web", [T2])], { companies: [T1, T2] }), webPreamble(), NONE],
    ["DW-10g-2: the same head on T2's own preamble: read and edit there", principal([co("member", T2), unitGrant("d-web", [T2])], { companies: [T1, T2] }), webPreamble({}, T2), HEAD],
    ["company_admin of T2 only, a T1 preamble", principal([co("company_admin", T2)], { companies: [T2] }), webPreamble(), NONE],
    ["company_admin @T1, a T2 preamble", principal([co("company_admin")]), webPreamble({}, T2), NONE],
    // nobody else: members do not need the screen
    ["manager @T1: nothing (every head carries manager company-wide, so manager cannot mean 'the head of this department')", principal([co("manager")]), webPreamble(), NONE],
    ["member @T1 (a member of the unit): nothing", principal([co("member")]), webPreamble(), NONE],
    ["viewer @T1: nothing", principal([co("viewer")]), webPreamble(), NONE],
    ["hr_staff @T1 (the HR read tier): nothing", principal([co("hr_staff")]), webPreamble(), NONE],
    ["hr_manager @T1: nothing", principal([co("hr_manager")]), webPreamble(), NONE],
    ["client @T1 (a portal contact)", principal([co("client")]), webPreamble(), NONE],
    ["a webdev_manager @T1 (a module tier)", principal([co("webdev_manager")]), webPreamble(), NONE],
    ["no grants at all", principal([]), webPreamble(), NONE],
    // the boundary
    ["company_admin @T1 at LOW assurance (notLow)", principal([co("company_admin")], { assurance: "low" }), webPreamble(), NONE],
    ["head of d-web at LOW assurance", principal([co("member"), unitGrant("d-web")], { assurance: "low" }), webPreamble(), NONE],
    // the DENY: agents read, never edit
    ["a BOT holding company_admin: reads only", principal([co("company_admin")], { kind: "bot" }), webPreamble(), READ],
    ["an AUTOMATION principal holding company_admin: reads only", principal([co("company_admin")], { kind: "automation" }), webPreamble(), READ],
    ["a BOT that is the head of d-web: reads, cannot edit (the DENY beats the lead rule)", principal([co("member"), unitGrant("d-web")], { kind: "bot" }), webPreamble(), READ],
    ["platform_admin that is a bot: reads only (the DENY beats the wildcard)", principal([glob("platform_admin")], { kind: "bot" }), webPreamble(), READ],
    ["an employee-kind principal is unaffected by the DENY", principal([co("company_admin")], { kind: "employee" }), webPreamble(), ALL],
    // an UNFED resource fails closed
    ["company_admin on an UNFED preamble (no ancestry sent): everything (no attribute-dependent rule to fail)", principal([co("company_admin")]), { kind: "dept_assistant_preamble", tenantId: T1 }, ALL],
    ["head of d-web on an UNFED preamble: no ancestry, so nothing", principal([co("member"), unitGrant("d-web")]), { kind: "dept_assistant_preamble", tenantId: T1 }, NONE],
  ];

  for (const [label, p, r, expected] of table) {
    it(`${label}`, async () => {
      for (const action of ACTIONS) {
        expect(await allow(p, r, action), `${label}: dept_assistant_preamble · ${action}`).toBe(expected[action]);
      }
    });
  }

  it("the head's rules need the ancestry: an empty list denies, and so does a list holding other units only", async () => {
    const head = principal([co("member"), unitGrant("d-web")]);
    for (const a of ["read", "edit"]) {
      expect(await allow(head, webPreamble({ unitAncestors: [] }), a), `[] · ${a}`).toBe(false);
      expect(await allow(head, webPreamble({ unitAncestors: undefined }), a), `unfed · ${a}`).toBe(false);
      expect(await allow(head, webPreamble({ unitAncestors: ["d-seo", "d-corp"] }), a), `other branch · ${a}`).toBe(false);
      expect(await allow(head, webPreamble(), a), `own unit · ${a}`).toBe(true);
    }
  });

  it("each head action is its own rule: a head holding the grant of ONE unit is allowed read and edit on that unit, and neither on another's", async () => {
    const head = principal([unitGrant("d-web")]);
    for (const a of ["read", "edit"]) {
      expect(await allow(head, webPreamble(), a), a).toBe(true);
      expect(await allow(head, seoPreamble(), a), a).toBe(false);
    }
  });

  it("an unlisted action is a deny (only platform_admin holds '*')", async () => {
    expect(await allow(principal([co("company_admin")]), webPreamble(), "delete")).toBe(false);
    expect(await allow(principal([glob("platform_admin")]), webPreamble(), "delete")).toBe(true);
  });
});

describe.skipIf(!live)("AIP-13b Cerbos matrix — dept_assistant_preamble, the permission arm and the owner (roles: [])", () => {
  const permP = (key: string, scopeType: "company" | "global" = "company", opts: { assurance?: Principal["assurance"]; kind?: string } = {}) =>
    principal([], { perms: [{ key, scopeType, scopeId: scopeType === "company" ? T1 : null }], ...opts });

  it("permission core.dept_assistant_preamble.manage ALONE allows `manage` on every unit and no sibling action; no cross-tenant, no low assurance", async () => {
    const key = "core.dept_assistant_preamble.manage";
    expect(await allow(permP(key), webPreamble(), "manage")).toBe(true);
    expect(await allow(permP(key), seoPreamble(), "manage")).toBe(true);
    expect(await allow(permP(key, "global"), webPreamble(), "manage")).toBe(true);
    for (const other of ["read", "edit"]) expect(await allow(permP(key), webPreamble(), other), `${key} must not allow ${other}`).toBe(false);
    expect(await allow(permP(key), webPreamble({}, T2), "manage")).toBe(false);
    expect(await allow(permP(key, "company", { assurance: "low" }), webPreamble(), "manage")).toBe(false);
  });

  it("a bot holding the manage permission is denied (the DENY lists manage)", async () => {
    expect(await allow(permP("core.dept_assistant_preamble.manage", "company", { kind: "bot" }), webPreamble(), "manage")).toBe(false);
  });

  it("the bare read and edit permissions allow NOTHING (there is deliberately no mirror: it would let a head reach every unit)", async () => {
    for (const a of ["read", "edit"]) {
      expect(await allow(permP(`core.dept_assistant_preamble.${a}`), webPreamble(), a), a).toBe(false);
      expect(await allow(permP(`core.dept_assistant_preamble.${a}`, "global"), seoPreamble(), a), `${a} global`).toBe(false);
    }
  });

  it("a permission-native OWNER (the bundle's keys, zero role rules) holds `manage` through the mirror on every unit: the owner edits every department's preamble", async () => {
    const bundles = JSON.parse(readFileSync(join(__dirname, "role-permission-bundles.json"), "utf8")) as { roles: Record<string, string[]> };
    const ownerP = principal([co("owner")], {
      perms: bundles.roles.owner.map((key) => ({ key, scopeType: "company" as const, scopeId: T1 })),
    });
    for (const r of [webPreamble(), seoPreamble(), feChain()]) expect(await allow(ownerP, r, "manage"), "owner · manage").toBe(true);
    // not another company's, and not at low assurance
    expect(await allow(ownerP, webPreamble({}, T2), "manage")).toBe(false);
    const lowOwner = principal([co("owner")], {
      assurance: "low",
      perms: bundles.roles.owner.map((key) => ({ key, scopeType: "company" as const, scopeId: T1 })),
    });
    expect(await allow(lowOwner, webPreamble(), "manage")).toBe(false);
    // an owner who is a bot is denied
    const botOwner = principal([co("owner")], {
      kind: "bot",
      perms: bundles.roles.owner.map((key) => ({ key, scopeType: "company" as const, scopeId: T1 })),
    });
    expect(await allow(botOwner, webPreamble(), "manage")).toBe(false);
  });
});
