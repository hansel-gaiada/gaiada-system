// DW-5a (docs/FRONTEND-BFF-CONTRACT.md §31.2) — Cerbos matrix for the NEW `agency_campaign_part` kind (module agency).
//
// THE CLAIMS UNDER TEST
//   1. read: company_admin / manager / member / viewer (mirrors agency_campaign read).
//   2. create, delete, allocate: company_admin and manager ONLY.
//   3. update: company_admin and manager; PLUS the part's OWNER (ownerId == principal id, held as `member`), PLUS an
//      org_unit_lead whose grant's unit is in the part's `unitAncestors`. The owner and the lead NEVER reach `allocate`
//      (a part's owner or head can never move money), `create` or `delete`.
//   4. Each attribute-dependent update rule stands alone (HIER-2 authoring rule): no rule names org_unit_lead beside a
//      scope role, and the owner rule names `member` only.
//   5. The permission arm covers read/create/delete/allocate and NOT update (Pattern B), so a bare perm key can never
//      reach every part.
//   6. `owner` (permission-native, zero rules) holds the same five keys as company_admin in its bundle.
//
// Two layers:
//   A. STATIC (always runs): re-parses cerbos/policies/*.yaml and pins the structure.
//   B. LIVE (needs CERBOS_URL, same convention as cerbos-conversation.test.ts): the decision matrix against the real
//      engine loaded with the CURRENT policy files (restart `gaiada-test-cerbos` after the policy edit; a skip is not a pass).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { check, type Resource } from "./cerbos";
import type { Principal, RoleGrant, PermissionGrant } from "./principal";

const POLICIES_DIR = join(__dirname, "../../cerbos/policies");
const ACTIONS = ["read", "create", "update", "delete", "allocate"] as const;

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
  return (docs[0].resourcePolicy.rules ?? []).map((r: any) => ({
    actions: r.actions ?? [],
    effect: r.effect ?? "EFFECT_ALLOW",
    derivedRoles: r.derivedRoles ?? [],
    roles: r.roles ?? [],
    condition: r.condition?.match?.expr ?? "",
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

describe("DW-5a static pin — resource_agency_campaign_part.yaml", () => {
  const rules = parseKind("resource_agency_campaign_part.yaml");
  const roleExprs = derivedRoleExprs();
  const roleArm = rules.filter((r) => r.effect === "EFFECT_ALLOW" && !r.derivedRoles.some((d) => d.startsWith("perm_") || d === "platform_admin"));
  const reach = (action: string) => roleArm.filter((r) => r.actions.includes(action));

  it("read = company_admin/manager/member/viewer; create/delete/allocate = company_admin/manager", () => {
    expect(reach("read").flatMap((r) => r.derivedRoles).sort()).toEqual(["company_admin", "manager", "member", "viewer"]);
    for (const a of ["create", "delete", "allocate"]) {
      expect(reach(a).flatMap((r) => r.derivedRoles).sort(), a).toEqual(["company_admin", "manager"]);
    }
  });

  it("update has THREE separate rules: company_admin+manager, the owner (member + owns), and org_unit_lead on its own", () => {
    const upd = reach("update");
    expect(upd.length).toBe(3);
    const scopeRule = upd.find((r) => r.derivedRoles.includes("company_admin"))!;
    expect(scopeRule.derivedRoles.sort()).toEqual(["company_admin", "manager"]);
    const ownerRule = upd.find((r) => r.derivedRoles.includes("member"))!;
    expect(ownerRule.derivedRoles).toEqual(["member"]);
    expect(ownerRule.condition).toContain("variables.owns");
    const leadRule = upd.find((r) => r.derivedRoles.includes("org_unit_lead"))!;
    expect(leadRule.derivedRoles, "org_unit_lead is never mixed with a scope role (HIER-2 §1.4)").toEqual(["org_unit_lead"]);
  });

  it("the owner rule and the lead rule are NEVER on create, delete or allocate", () => {
    for (const r of roleArm) {
      if (r.derivedRoles.includes("org_unit_lead") || r.derivedRoles.includes("member") && r.condition.includes("owns")) {
        expect(r.actions).toEqual(["update"]);
      }
    }
    for (const a of ["create", "delete", "allocate"]) {
      for (const r of reach(a)) expect(r.derivedRoles).not.toContain("org_unit_lead");
    }
  });

  it("the permission arm mirrors read/create/delete/allocate exactly once each, under inTenant && notLow && inRoot, and NOT update", () => {
    for (const a of ["read", "create", "delete", "allocate"]) {
      const mirrors = rules.filter((r) => r.derivedRoles.some((d) => d.startsWith("perm_")) && r.actions.includes(a));
      expect(mirrors.length, `perm mirror rules for ${a}`).toBe(1);
      expect(mirrors[0].derivedRoles).toEqual([`perm_agency_campaign_part_${a}`]);
      expect(mirrors[0].condition).toBe("variables.inTenant && variables.notLow && variables.inRoot");
      const expr = roleExprs.get(`perm_agency_campaign_part_${a}`);
      expect(expr, `perm_agency_campaign_part_${a} must exist in derived_roles.yaml`).toBeTruthy();
      expect(expr).toContain(`g.key == "agency.campaign_part.${a}"`);
      expect(expr).toContain('g.scopeType == "global"');
      expect(expr).toContain('g.scopeType == "company" && g.scopeId == request.resource.attr.tenantId');
    }
    expect(rules.filter((r) => r.derivedRoles.some((d) => d.startsWith("perm_")) && r.actions.includes("update"))).toEqual([]);
    expect(roleExprs.has("perm_agency_campaign_part_update")).toBe(false);
  });

  it("the `client` role is named by no rule", () => {
    for (const r of rules) {
      expect(r.derivedRoles).not.toContain("client");
      expect(r.roles).not.toContain("client");
    }
  });

  it("ownerId and unitAncestors reach the policy: Resource type AND the resourcePayload() allow-list carry both (cerbos.ts needs no change)", () => {
    const src = readFileSync(join(__dirname, "cerbos.ts"), "utf8");
    expect(src).toContain("ownerId?: string;");
    expect(src).toContain("unitAncestors?: string[];");
    expect(src).toContain('ownerId: r.ownerId ?? ""');
    expect(src).toContain("unitAncestors: r.unitAncestors ?? []");
  });

  it("the bundle JSON: owner == company_admin (all five), manager all five, member read + update(self-scoped), viewer read, org_unit_lead update, client none", () => {
    const doc = JSON.parse(readFileSync(join(__dirname, "role-permission-bundles.json"), "utf8")) as {
      roles: Record<string, string[]>;
      selfScoped: Record<string, string[]>;
    };
    const keys = (role: string) => doc.roles[role].filter((k) => k.startsWith("agency.campaign_part.")).sort();
    const all = ACTIONS.map((a) => `agency.campaign_part.${a}`).sort();
    expect(keys("company_admin")).toEqual(all);
    expect(keys("owner")).toEqual(all);
    expect(keys("manager")).toEqual(all);
    expect(keys("platform_admin")).toEqual(all);
    expect(keys("member")).toEqual(["agency.campaign_part.read", "agency.campaign_part.update"]);
    expect(keys("viewer")).toEqual(["agency.campaign_part.read"]);
    expect(keys("org_unit_lead")).toEqual(["agency.campaign_part.update"]);
    expect(keys("client")).toEqual([]);
    expect(doc.selfScoped.member).toContain("agency.campaign_part.update");
    expect(doc.selfScoped.org_unit_lead ?? []).not.toContain("agency.campaign_part.update");
    // the money key and create/delete are never in a self-scoped pair
    for (const list of Object.values(doc.selfScoped)) {
      for (const k of ["allocate", "create", "delete"]) expect(list).not.toContain(`agency.campaign_part.${k}`);
    }
  });
});

// ─── B. LIVE matrix ───────────────────────────────────────────────────────────────────────────────────────────
const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const T1 = "aaaaaaaa-5555-0000-0000-000000000001";
const T2 = "aaaaaaaa-5555-0000-0000-000000000002";
const ME = "u-part-owner";
const SOMEONE_ELSE = "u-someone-else";

function principal(
  roles: RoleGrant[],
  opts: { perms?: PermissionGrant[]; companies?: string[]; assurance?: Principal["assurance"]; userId?: string } = {},
): Principal {
  const companies = opts.companies ?? [T1];
  return {
    userId: opts.userId ?? ME, assurance: opts.assurance ?? "high", companies,
    rootCompanies: companies, roles, perms: opts.perms ?? [], sessionVersion: 1,
  };
}
const co = (role: string, scopeId = T1): RoleGrant => ({ role, scopeType: "company", scopeId });
const glob = (role: string): RoleGrant => ({ role, scopeType: "global", scopeId: null });
// DW-10g-2 Part B: an org_unit_lead grant carries the companies whose own lead seat backs it (assemblePrincipal() resolves
// them); the derived role requires the resource's company to be one. Default: the matrix's own company.
const lead = (unit: string, tenantIds: string[] = [T1]): RoleGrant => ({ role: "org_unit_lead", scopeType: "org_unit", scopeId: unit, tenantIds });

// A part of department d-seo, which sits under d-corp; d-social is its sibling.
const SEO_ANCESTORS = ["d-seo", "d-corp"];
const part = (extra: Partial<Resource> = {}, tenantId = T1): Resource => ({
  kind: "agency_campaign_part", tenantId, module: "agency", id: "11111111-1111-1111-1111-111111111111",
  ownerId: SOMEONE_ELSE, unitAncestors: SEO_ANCESTORS, ...extra,
});
const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;

type Cell = Record<(typeof ACTIONS)[number], boolean>;
const ALL: Cell = { read: true, create: true, update: true, delete: true, allocate: true };
const NONE: Cell = { read: false, create: false, update: false, delete: false, allocate: false };
const READ_ONLY: Cell = { ...NONE, read: true };

describe.skipIf(!live)("DW-5a Cerbos matrix — agency_campaign_part (role x action)", () => {
  const table: Array<[string, Principal, Cell]> = [
    ["platform_admin (global)", principal([glob("platform_admin")]), ALL],
    ["company_admin @T1", principal([co("company_admin")]), ALL],
    ["manager @T1: does everything", principal([co("manager")]), ALL],
    ["member @T1 (not the owner): reads only", principal([co("member")]), READ_ONLY],
    ["viewer @T1: reads only", principal([co("viewer")]), READ_ONLY],
    ["org_unit_lead of d-seo alone: updates, nothing else (no read either)", principal([lead("d-seo")]), { ...NONE, update: true }],
    ["org_unit_lead of d-corp (an ANCESTOR unit): updates", principal([lead("d-corp")]), { ...NONE, update: true }],
    ["org_unit_lead of d-social (a SIBLING unit): nothing", principal([lead("d-social")]), NONE],
    ["org_unit_lead of d-seo + member: reads and updates, never creates/deletes/allocates", principal([lead("d-seo"), co("member")]), { ...READ_ONLY, update: true }],
    ["company-scoped org_unit_lead grant (mis-scoped): nothing", principal([co("org_unit_lead")]), NONE],
    ["client @T1", principal([co("client")]), NONE],
    ["webdev_manager @T1 (a module tier)", principal([co("webdev_manager")]), NONE],
    ["company_admin of T2 only (cross-tenant)", principal([co("company_admin", T2)], { companies: [T2] }), NONE],
    ["company_admin @T1 at LOW assurance (notLow)", principal([co("company_admin")], { assurance: "low" }), NONE],
    ["no grants at all", principal([]), NONE],
  ];

  for (const [label, p, expected] of table) {
    it(`${label}`, async () => {
      for (const action of ACTIONS) {
        expect(await allow(p, part(), action), `${label}: agency_campaign_part · ${action}`).toBe(expected[action]);
      }
    });
  }

  it("the part's OWNER (a member) updates their own part, reads it, and can NEVER allocate, create or delete", async () => {
    const owner = principal([co("member")]);
    const mine = part({ ownerId: ME });
    expect(await allow(owner, mine, "update")).toBe(true);
    expect(await allow(owner, mine, "read")).toBe(true);
    expect(await allow(owner, mine, "allocate")).toBe(false);
    expect(await allow(owner, mine, "create")).toBe(false);
    expect(await allow(owner, mine, "delete")).toBe(false);
  });

  it("the owner rule fails closed: an unfed ownerId (\"\") or someone else's part denies update", async () => {
    const owner = principal([co("member")]);
    expect(await allow(owner, part({ ownerId: undefined }), "update")).toBe(false);
    expect(await allow(owner, part({ ownerId: SOMEONE_ELSE }), "update")).toBe(false);
  });

  it("owner-ship does not help a VIEWER (the owner rule is on `member`)", async () => {
    expect(await allow(principal([co("viewer")]), part({ ownerId: ME }), "update")).toBe(false);
  });

  it("the lead rule fails closed: an unfed unitAncestors ([]) denies, and the cascade is one-directional (down, never up)", async () => {
    expect(await allow(principal([lead("d-seo")]), part({ unitAncestors: undefined }), "update")).toBe(false);
    expect(await allow(principal([lead("d-seo")]), part({ unitAncestors: ["d-corp"] }), "update")).toBe(false);
  });

  it("a lead who is also the part's owner still cannot allocate", async () => {
    const p = principal([lead("d-seo"), co("member")]);
    expect(await allow(p, part({ ownerId: ME }), "allocate")).toBe(false);
  });

  it("an unlisted action is a deny (only platform_admin holds '*')", async () => {
    expect(await allow(principal([co("company_admin")]), part(), "approve")).toBe(false);
    expect(await allow(principal([glob("platform_admin")]), part(), "approve")).toBe(true);
  });
});

describe.skipIf(!live)("DW-5a Cerbos matrix — agency_campaign_part, the permission arm (roles: [])", () => {
  const permP = (key: string, scopeType: "company" | "global" = "company", opts: { assurance?: Principal["assurance"] } = {}) =>
    principal([], { perms: [{ key, scopeType, scopeId: scopeType === "company" ? T1 : null }], ...opts });

  for (const action of ["read", "create", "delete", "allocate"] as const) {
    const key = `agency.campaign_part.${action}`;
    it(`permission ${key} ALONE allows ${action} and no sibling action; no cross-tenant, no low assurance`, async () => {
      expect(await allow(permP(key), part(), action)).toBe(true);
      for (const other of ACTIONS.filter((a) => a !== action)) {
        expect(await allow(permP(key), part(), other), `${key} must not allow ${other}`).toBe(false);
      }
      expect(await allow(permP(key), part({}, T2), action)).toBe(false);
      expect(await allow(permP(key, "company", { assurance: "low" }), part(), action)).toBe(false);
    });
  }

  it("the bare update permission allows NOTHING (there is deliberately no update mirror)", async () => {
    expect(await allow(permP("agency.campaign_part.update"), part(), "update")).toBe(false);
  });

  it("a permission-native OWNER (the bundle's keys, zero rules) reads, creates, deletes and allocates, but its update key has no arm", async () => {
    const bundles = JSON.parse(readFileSync(join(__dirname, "role-permission-bundles.json"), "utf8")) as { roles: Record<string, string[]> };
    const ownerP = principal([co("owner")], {
      perms: bundles.roles.owner.map((key) => ({ key, scopeType: "company" as const, scopeId: T1 })),
    });
    for (const a of ["read", "create", "delete", "allocate"]) expect(await allow(ownerP, part(), a), `owner · ${a}`).toBe(true);
    expect(await allow(ownerP, part(), "update")).toBe(false);
  });
});
