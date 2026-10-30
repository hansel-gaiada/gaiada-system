// AIP-15 (docs/PERMISSION-CONTRACT.md §58, docs/FRONTEND-BFF-CONTRACT.md §66; owner rulings AIP-D6, AIP-D18 and the AIP-D16 owner-only
// pattern) — Cerbos matrix for the NEW core `ai_usage` kind.
//
// THE CLAIMS UNDER TEST
//   1. read_own: every staff member (company_admin, manager, member, viewer: one scope-only rule) and the owner (mirror). Nothing narrower is
//      needed: the ROUTE reads only `user_id = caller`.
//   2. read_unit and lift_stop: an `org_unit_lead` whose grant's unit is in `unitAncestors` (the unit itself or an enclosing one), each its
//      own rule, never mixed. A sibling's head, a head below, a head of the same node id in ANOTHER company: nothing.
//   3. read_company: company_admin (rule), the GM (the seat `ai_usage_gm_seat` over `gmIds`, its own rule), the owner (mirror). The GM of
//      another company never reaches it, even if its id were in this company's list (inTenant).
//   4. read_people and manage: the OWNER ONLY (OWNER_EXTENSION + mirror) and the superadmin (wildcard). company_admin reaches neither.
//   5. EFFECT_DENY on manage and lift_stop for automation and bot principals (beats the wildcard, the lead rule and the mirror); reads stay.
//   6. No read_unit / lift_stop mirror (a head would reach every unit). An unfed resource fails closed for the head and the GM.
//   7. Low assurance: nothing (notLow on every rule but the wildcard).
//
// Two layers:
//   A. STATIC (always runs): re-parses cerbos/policies/*.yaml and the JSON artifacts and pins the structure.
//   B. LIVE (needs CERBOS_URL): the decision matrix against the real engine loaded with the CURRENT policy files (restart
//      `gaiada-test-cerbos` after the policy edit; a skip is not a pass).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { check, type Resource } from "./cerbos";
import type { Principal, RoleGrant, PermissionGrant } from "./principal";
import { OWNER_EXTENSION } from "../../scripts/generate-role-bundles.mjs";

const POLICIES_DIR = join(__dirname, "../../cerbos/policies");
const ACTIONS = ["read_own", "read_unit", "read_company", "read_people", "manage", "lift_stop"] as const;
type Action = (typeof ACTIONS)[number];
const KEY = (a: Action) => `core.ai_usage.${a}`;

interface ParsedRule {
  actions: string[];
  effect: string;
  derivedRoles: string[];
  roles: string[];
  condition: string;
}
function parseKind(): ParsedRule[] {
  const text = readFileSync(join(POLICIES_DIR, "resource_ai_usage.yaml"), "utf8");
  const docs = (yaml.loadAll(text) as any[]).filter((d) => d?.resourcePolicy);
  expect(docs.length).toBe(1);
  expect(docs[0].resourcePolicy.resource).toBe("ai_usage");
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
      if (expr) out.set(d.name, expr.replace(/\s+/g, " ").trim());
    }
  }
  return out;
}

describe("AIP-15 static pin — resource_ai_usage.yaml", () => {
  const rules = parseKind();
  const roleExprs = derivedRoleExprs();
  const allows = rules.filter((r) => r.effect === "EFFECT_ALLOW");
  const gate = "variables.inTenant && variables.notLow";
  const rulesFor = (role: string) => allows.filter((r) => r.derivedRoles.includes(role));

  it("the roles named are exactly the wildcard, the four scope roles, the lead, the GM seat and four mirrors", () => {
    const named = new Set(allows.flatMap((r) => r.derivedRoles));
    expect([...named].sort()).toEqual([
      "ai_usage_gm_seat", "company_admin", "manager", "member", "org_unit_lead",
      "perm_ai_usage_manage", "perm_ai_usage_read_company", "perm_ai_usage_read_own", "perm_ai_usage_read_people",
      "platform_admin", "viewer",
    ]);
    for (const r of rules) for (const role of ["owner", "hr_people_reader", "client", "it_staff"]) expect(r.derivedRoles).not.toContain(role);
  });

  it("platform_admin holds '*' alone, with no condition", () => {
    const pa = rulesFor("platform_admin");
    expect(pa.length).toBe(1);
    expect(pa[0]).toMatchObject({ actions: ["*"], derivedRoles: ["platform_admin"], condition: "" });
  });

  it("read_own: ONE rule for company_admin, manager, member, viewer, inTenant && notLow", () => {
    const own = allows.filter((r) => r.actions.includes("read_own") && !r.derivedRoles.some((d) => d.startsWith("perm_") || d === "platform_admin"));
    expect(own.length).toBe(1);
    expect(own[0].actions).toEqual(["read_own"]);
    expect([...own[0].derivedRoles].sort()).toEqual(["company_admin", "manager", "member", "viewer"]);
    expect(own[0].condition).toBe(gate);
  });

  it("company_admin: read_own and read_company ONLY (never read_people, manage, read_unit or lift_stop)", () => {
    const acts = new Set(rulesFor("company_admin").flatMap((r) => r.actions));
    expect([...acts].sort()).toEqual(["read_company", "read_own"]);
  });

  it("manager, member and viewer: read_own only", () => {
    for (const role of ["manager", "member", "viewer"]) expect(rulesFor(role).flatMap((r) => r.actions), role).toEqual(["read_own"]);
  });

  it("the head: org_unit_lead ALONE in its own rule per action (read_unit, lift_stop), inTenant && notLow", () => {
    const heads = rulesFor("org_unit_lead");
    expect(heads.length).toBe(2);
    for (const a of ["read_unit", "lift_stop"]) {
      const h = heads.filter((r) => r.actions.includes(a));
      expect(h.length, a).toBe(1);
      expect(h[0].derivedRoles).toEqual(["org_unit_lead"]);
      expect(h[0].actions).toEqual([a]);
      expect(h[0].condition).toBe(gate);
    }
  });

  it("the GM seat: its own rule, read_company ONLY, inTenant && notLow; the derived role reads gmIds in the social_approver_seat shape", () => {
    const gm = rulesFor("ai_usage_gm_seat");
    expect(gm.length).toBe(1);
    expect(gm[0]).toMatchObject({ actions: ["read_company"], derivedRoles: ["ai_usage_gm_seat"], condition: gate });
    const expr = roleExprs.get("ai_usage_gm_seat")!;
    expect(expr).toBe("has(request.resource.attr.gmIds) && request.resource.attr.gmIds.exists(id, id == request.principal.id)");
    expect(expr).not.toMatch(/g\.role\s*==/);
  });

  it("every ALLOW but the wildcard keeps inTenant and notLow", () => {
    for (const r of allows.filter((x) => !x.derivedRoles.includes("platform_admin"))) {
      expect(r.condition, JSON.stringify(r.derivedRoles)).toContain("variables.inTenant");
      expect(r.condition).toContain("variables.notLow");
    }
  });

  it("one EFFECT_DENY, on roles [user]: manage and lift_stop for automation and bot (no read)", () => {
    const denies = rules.filter((r) => r.effect === "EFFECT_DENY");
    expect(denies.length).toBe(1);
    expect(denies[0].roles).toEqual(["user"]);
    expect([...denies[0].actions].sort()).toEqual(["lift_stop", "manage"]);
    expect(denies[0].condition).toBe('has(request.principal.attr.kind) && request.principal.attr.kind in ["automation", "bot"]');
  });

  it("four mirrors, one per action (read_own, read_company, read_people, manage), each its own rule under inTenant && notLow && inRoot; none for read_unit or lift_stop", () => {
    const mirrors = allows.filter((r) => r.derivedRoles.some((d) => d.startsWith("perm_")));
    expect(mirrors.length).toBe(4);
    for (const a of ["read_own", "read_company", "read_people", "manage"] as const) {
      const m = mirrors.filter((r) => r.actions.includes(a));
      expect(m.length, a).toBe(1);
      expect(m[0].actions).toEqual([a]);
      expect(m[0].derivedRoles).toEqual([`perm_ai_usage_${a}`]);
      expect(m[0].condition).toBe("variables.inTenant && variables.notLow && variables.inRoot");
      const expr = roleExprs.get(`perm_ai_usage_${a}`)!;
      expect(expr).toContain(`g.key == "${KEY(a)}"`);
      expect(expr).toContain('g.scopeType == "global"');
      expect(expr).toContain('(g.scopeType == "company" && g.scopeId == request.resource.attr.tenantId)');
    }
    for (const a of ["read_unit", "lift_stop"]) expect(roleExprs.has(`perm_ai_usage_${a}`), a).toBe(false);
  });

  it("gmIds and unitAncestors reach the policy: Resource type AND the resourcePayload() allow-list carry both, fail closed", () => {
    const src = readFileSync(join(__dirname, "cerbos.ts"), "utf8");
    expect(src).toContain("gmIds?: string[];");
    expect(src).toContain("gmIds: r.gmIds ?? []");
    expect(src).toContain("unitAncestors: r.unitAncestors ?? []");
  });

  it("the bundle JSON: exactly the holders the policy names; owner == company_admin's two + OWNER_EXTENSION's two; nothing self-scoped", () => {
    const doc = JSON.parse(readFileSync(join(__dirname, "role-permission-bundles.json"), "utf8")) as {
      roles: Record<string, string[]>;
      selfScoped: Record<string, string[]>;
    };
    const keys = (role: string) => (doc.roles[role] ?? []).filter((k) => k.startsWith("core.ai_usage.")).sort();
    expect(keys("platform_admin")).toEqual(ACTIONS.map(KEY).sort());
    expect(keys("company_admin")).toEqual([KEY("read_company"), KEY("read_own")]);
    expect(keys("owner")).toEqual([KEY("manage"), KEY("read_company"), KEY("read_own"), KEY("read_people")]);
    for (const role of ["manager", "member", "viewer"]) expect(keys(role), role).toEqual([KEY("read_own")]);
    expect(keys("org_unit_lead")).toEqual([KEY("lift_stop"), KEY("read_unit")]);
    const named = ["platform_admin", "company_admin", "owner", "manager", "member", "viewer", "org_unit_lead"];
    for (const role of Object.keys(doc.roles)) if (!named.includes(role)) expect(keys(role), role).toEqual([]);
    for (const role of Object.keys(doc.selfScoped ?? {})) {
      expect((doc.selfScoped[role] ?? []).filter((k) => k.startsWith("core.ai_usage.")), role).toEqual([]);
    }
    // read_people and manage: the owner and the wildcard only
    for (const k of [KEY("read_people"), KEY("manage")]) {
      expect(Object.keys(doc.roles).filter((r) => doc.roles[r].includes(k)).sort(), k).toEqual(["owner", "platform_admin"]);
    }
  });

  it("OWNER_EXTENSION carries read_people and manage; neither is in company_admin's bundle", () => {
    expect(OWNER_EXTENSION).toContain(KEY("read_people"));
    expect(OWNER_EXTENSION).toContain(KEY("manage"));
    for (const a of ["read_own", "read_unit", "read_company", "lift_stop"] as const) expect(OWNER_EXTENSION).not.toContain(KEY(a));
  });

  it("DIRECT maps ai_usage_gm_seat to no real role, byte-aligned across the generator and the parity suite", () => {
    const gen = readFileSync(join(__dirname, "../../scripts/generate-role-bundles.mjs"), "utf8");
    const parity = readFileSync(join(__dirname, "role-permission-parity.db.test.ts"), "utf8");
    expect(gen).toContain("ai_usage_gm_seat: [],");
    expect(parity).toContain("ai_usage_gm_seat: [],");
  });

  it("the catalog: six grantable, non-sensitive keys in domain core; read_people and manage uiGrantable false, the rest true", () => {
    const cat = JSON.parse(readFileSync(join(__dirname, "permission-catalog.json"), "utf8")) as { permissions: any[] };
    const mine = cat.permissions.filter((p) => p.cerbosKind === "ai_usage");
    expect(mine.map((p) => p.key).sort()).toEqual(ACTIONS.map(KEY).sort());
    for (const p of mine) {
      expect(p).toMatchObject({ domain: "core", resource: "ai_usage", class: "grantable", sensitive: false });
      expect(p.cerbosAction).toBe(p.action);
      expect(p.uiGrantable, p.key).toBe(!["read_people", "manage"].includes(p.action));
    }
  });

  it("the IAM migration seeds what the bundle JSON says (the 17 pairs, by role)", () => {
    const sql = readFileSync(join(__dirname, "../../migrations/202610300310_iam_ai_usage_permissions.sql"), "utf8");
    const doc = JSON.parse(readFileSync(join(__dirname, "role-permission-bundles.json"), "utf8")) as { roles: Record<string, string[]> };
    const block = sql.slice(sql.indexOf("INSERT INTO role_permissions"), sql.indexOf(") AS bundle(role_name, perm_key)"));
    const pairs = [...block.matchAll(/\('([a-z_]+)', '(core\.ai_usage\.[a-z_]+)'\)/g)].map((m) => `${m[1]} ${m[2]}`).sort();
    const want = Object.entries(doc.roles).flatMap(([r, ks]) => ks.filter((k) => k.startsWith("core.ai_usage.")).map((k) => `${r} ${k}`)).sort();
    expect(pairs).toEqual(want);
    expect(pairs.length).toBe(17);
    expect(sql).not.toMatch(/\r/);
  });
});

// ─── B. LIVE matrix ───────────────────────────────────────────────────────────────────────────────────────────
const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const T1 = "aaaaaaaa-9999-0000-0000-0000000000b1";
const T2 = "aaaaaaaa-9999-0000-0000-0000000000b2";
const ME = "u-me";
const GM = "u-gm";

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
const unitGrant = (unit: string, tenantIds: string[] = [T1]): RoleGrant => ({ role: "org_unit_lead", scopeType: "org_unit", scopeId: unit, tenantIds });

// The unit `d-web` under the root `d-corp` (the closure's self-inclusive ancestry, nearest first); the GM is u-gm.
const WEB_CHAIN = ["d-web", "d-corp"];
const unitRes = (extra: Partial<Resource> = {}, tenantId = T1): Resource => ({ kind: "ai_usage", tenantId, unitAncestors: WEB_CHAIN, gmIds: [GM], ...extra });
const companyRes = (extra: Partial<Resource> = {}, tenantId = T1): Resource => ({ kind: "ai_usage", tenantId, gmIds: [GM], ...extra });
const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;

type Cell = Record<Action, boolean>;
const NONE: Cell = { read_own: false, read_unit: false, read_company: false, read_people: false, manage: false, lift_stop: false };
const cell = (...on: Action[]): Cell => ({ ...NONE, ...Object.fromEntries(on.map((a) => [a, true])) });
const ALL = cell(...ACTIONS);

function ownerPrincipal(opts: { assurance?: Principal["assurance"]; kind?: string; tenant?: string } = {}): Principal {
  const bundles = JSON.parse(readFileSync(join(__dirname, "role-permission-bundles.json"), "utf8")) as { roles: Record<string, string[]> };
  const t = opts.tenant ?? T1;
  return principal([co("owner", t)], {
    companies: [t],
    assurance: opts.assurance,
    kind: opts.kind,
    perms: bundles.roles.owner.map((key) => ({ key, scopeType: "company" as const, scopeId: t })),
  });
}

describe.skipIf(!live)("AIP-15 Cerbos matrix — ai_usage (principal x action)", () => {
  const table: Array<[string, Principal, Resource, Cell]> = [
    // the superadmin and the owner
    ["platform_admin (global), a unit", principal([glob("platform_admin")]), unitRes(), ALL],
    ["platform_admin (global), the company", principal([glob("platform_admin")]), companyRes(), ALL],
    ["owner with its LIVE bundle (permission-native), a unit", ownerPrincipal(), unitRes(), cell("read_own", "read_company", "read_people", "manage")],
    ["owner with its LIVE bundle, the company", ownerPrincipal(), companyRes(), cell("read_own", "read_company", "read_people", "manage")],
    ["owner of T2 only, a T1 resource", ownerPrincipal({ tenant: T2 }), unitRes(), NONE],
    // company admins: own line and totals, never people, never manage
    ["company_admin @T1, a unit", principal([co("company_admin")]), unitRes(), cell("read_own", "read_company")],
    ["company_admin @T1, the company", principal([co("company_admin")]), companyRes(), cell("read_own", "read_company")],
    ["company_admin of T2 only, a T1 resource", principal([co("company_admin", T2)], { companies: [T2] }), unitRes(), NONE],
    ["company_admin @T1, a T2 resource", principal([co("company_admin")]), unitRes({}, T2), NONE],
    // staff: their own line only
    ["manager @T1", principal([co("manager")]), unitRes(), cell("read_own")],
    ["member @T1", principal([co("member")]), unitRes(), cell("read_own")],
    ["viewer @T1", principal([co("viewer")]), unitRes(), cell("read_own")],
    ["member @T1, a T2 resource", principal([co("member")]), unitRes({}, T2), NONE],
    // heads
    ["head of d-web (+ member + manager): the unit's totals and people, and its stop", principal([co("member"), co("manager"), unitGrant("d-web")]), unitRes(), cell("read_own", "read_unit", "lift_stop")],
    ["head of d-web as org_unit_lead ALONE", principal([unitGrant("d-web")]), unitRes(), cell("read_unit", "lift_stop")],
    ["head of the enclosing d-corp (+ member)", principal([co("member"), unitGrant("d-corp")]), unitRes(), cell("read_own", "read_unit", "lift_stop")],
    ["head of a division BELOW d-web (dv-fe), d-web's resource", principal([co("member"), unitGrant("dv-fe")]), unitRes(), cell("read_own")],
    ["head of the SIBLING d-seo (+ member)", principal([co("member"), unitGrant("d-seo")]), unitRes(), cell("read_own")],
    ["head of d-web whose companies are [T1], T2's resource with the SAME node ids", principal([co("member"), unitGrant("d-web")]), unitRes({}, T2), NONE],
    ["head of T2's d-web (seat in T2), member of T1 and T2, T1's d-web", principal([co("member"), unitGrant("d-web", [T2])], { companies: [T1, T2] }), unitRes(), cell("read_own")],
    ["the same head on T2's own d-web", principal([co("member", T2), unitGrant("d-web", [T2])], { companies: [T1, T2] }), unitRes({}, T2), cell("read_own", "read_unit", "lift_stop")],
    ["head of d-web on the COMPANY resource (no ancestry fed)", principal([co("member"), unitGrant("d-web")]), companyRes(), cell("read_own")],
    // the GM seat
    ["the GM (+ member), the company", principal([co("member")], { userId: GM }), companyRes(), cell("read_own", "read_company")],
    ["the GM (+ member), a unit", principal([co("member")], { userId: GM }), unitRes(), cell("read_own", "read_company")],
    ["the GM ALONE (no scope role)", principal([], { userId: GM }), companyRes(), cell("read_company")],
    ["the GM on an UNFED resource (gmIds not sent): nothing but their own line", principal([co("member")], { userId: GM }), { kind: "ai_usage", tenantId: T1 }, cell("read_own")],
    ["a GM seat holder of ANOTHER company (companies [T2]) whose id is in T1's list", principal([co("member", T2)], { userId: GM, companies: [T2] }), companyRes(), NONE],
    ["the GM of T1 on T2's resource listing other seats", principal([co("member")], { userId: GM }), companyRes({ gmIds: ["u-other"] }, T2), NONE],
    // nobody else
    ["hr_staff @T1", principal([co("hr_staff")]), unitRes(), NONE],
    ["client @T1", principal([co("client")]), unitRes(), NONE],
    ["webdev_manager @T1", principal([co("webdev_manager")]), unitRes(), NONE],
    ["no grants at all", principal([]), unitRes(), NONE],
    // low assurance
    ["company_admin at LOW assurance", principal([co("company_admin")], { assurance: "low" }), unitRes(), NONE],
    ["owner at LOW assurance", ownerPrincipal({ assurance: "low" }), unitRes(), NONE],
    ["head of d-web at LOW assurance", principal([co("member"), unitGrant("d-web")], { assurance: "low" }), unitRes(), NONE],
    ["the GM at LOW assurance", principal([co("member")], { userId: GM, assurance: "low" }), companyRes(), NONE],
    ["member at LOW assurance", principal([co("member")], { assurance: "low" }), unitRes(), NONE],
    // the DENY: agents and automation never manage or lift a stop; they still read
    ["a BOT owner: reads, never manages", ownerPrincipal({ kind: "bot" }), unitRes(), cell("read_own", "read_company", "read_people")],
    ["an AUTOMATION owner: reads, never manages", ownerPrincipal({ kind: "automation" }), unitRes(), cell("read_own", "read_company", "read_people")],
    ["a BOT head of d-web: reads the unit, never lifts its stop", principal([co("member"), unitGrant("d-web")], { kind: "bot" }), unitRes(), cell("read_own", "read_unit")],
    ["an AUTOMATION head of d-web", principal([co("member"), unitGrant("d-web")], { kind: "automation" }), unitRes(), cell("read_own", "read_unit")],
    ["a BOT platform_admin: the DENY beats the wildcard", principal([glob("platform_admin")], { kind: "bot" }), unitRes(), cell("read_own", "read_unit", "read_company", "read_people")],
    ["an employee-kind owner is unaffected by the DENY", ownerPrincipal({ kind: "employee" }), unitRes(), cell("read_own", "read_company", "read_people", "manage")],
  ];

  for (const [label, p, r, expected] of table) {
    it(label, async () => {
      for (const action of ACTIONS) {
        expect(await allow(p, r, action), `${label}: ai_usage · ${action}`).toBe(expected[action]);
      }
    });
  }

  it("the head's rules need the ancestry: [] and an unfed list deny, another branch denies, the unit allows", async () => {
    const head = principal([co("member"), unitGrant("d-web")]);
    for (const a of ["read_unit", "lift_stop"]) {
      expect(await allow(head, unitRes({ unitAncestors: [] }), a), `[] · ${a}`).toBe(false);
      expect(await allow(head, unitRes({ unitAncestors: undefined }), a), `unfed · ${a}`).toBe(false);
      expect(await allow(head, unitRes({ unitAncestors: ["d-seo", "d-corp"] }), a), `other branch · ${a}`).toBe(false);
      expect(await allow(head, unitRes(), a), `own unit · ${a}`).toBe(true);
    }
  });

  it("an unlisted action is a deny (only platform_admin holds '*')", async () => {
    expect(await allow(ownerPrincipal(), unitRes(), "delete")).toBe(false);
    expect(await allow(principal([glob("platform_admin")]), unitRes(), "delete")).toBe(true);
  });
});

describe.skipIf(!live)("AIP-15 Cerbos matrix — ai_usage, the permission arm (roles: [])", () => {
  const permP = (key: string, scopeType: "company" | "global" = "company", opts: { assurance?: Principal["assurance"]; kind?: string } = {}) =>
    principal([], { perms: [{ key, scopeType, scopeId: scopeType === "company" ? T1 : null }], ...opts });

  it("each mirrored key ALONE allows its own action and no sibling; never cross-tenant or at low assurance", async () => {
    for (const a of ["read_own", "read_company", "read_people", "manage"] as const) {
      expect(await allow(permP(KEY(a)), unitRes(), a), a).toBe(true);
      expect(await allow(permP(KEY(a), "global"), companyRes(), a), `${a} global`).toBe(true);
      for (const other of ACTIONS.filter((x) => x !== a)) expect(await allow(permP(KEY(a)), unitRes(), other), `${a} -> ${other}`).toBe(false);
      expect(await allow(permP(KEY(a)), unitRes({}, T2), a), `${a} T2`).toBe(false);
      expect(await allow(permP(KEY(a), "company", { assurance: "low" }), unitRes(), a), `${a} low`).toBe(false);
    }
  });

  it("the bare read_unit and lift_stop keys allow NOTHING (no mirror: a head would reach every unit)", async () => {
    for (const a of ["read_unit", "lift_stop"] as const) {
      expect(await allow(permP(KEY(a)), unitRes(), a), a).toBe(false);
      expect(await allow(permP(KEY(a), "global"), unitRes(), a), `${a} global`).toBe(false);
    }
  });

  it("a bot holding the manage key is denied it (the DENY lists manage)", async () => {
    expect(await allow(permP(KEY("manage"), "company", { kind: "bot" }), unitRes(), "manage")).toBe(false);
    expect(await allow(permP(KEY("read_people"), "company", { kind: "bot" }), unitRes(), "read_people")).toBe(true);
  });
});
