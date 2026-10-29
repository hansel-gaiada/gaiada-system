// AIP-08b (owner ruling AIP-D5, docs/PERMISSION-CONTRACT.md §55) — Cerbos matrix for the NEW `assistant_brain` kind: who may pin their
// own assistant thread to a NAMED AI provider instead of Auto, Fast or Strong.
//
// AIP-D5 holders (owner ruling 2026-10-29: "only superadmin and owner", §55.1, migration 202610291200): company_admin's rule and bundle
// row are gone, the key is uiGrantable:false and rides OWNER_EXTENSION, as SCP-1b's five social approver keys do.
//
// THE CLAIMS UNDER TEST
//   1. One action, `choose_provider`. ALLOW: the platform_admin wildcard (the superadmin); the permission arm
//      (`perm_assistant_brain_choose_provider`, `inTenant && notLow && inRoot`). No other role rule, no DENY rule.
//   2. `owner` (permission-native, zero rules) reaches it through its bundle (OWNER_EXTENSION) and the permission arm. The key is
//      uiGrantable:false, so no role edit or position can give it to anyone else; the arm still decides on the key alone.
//   3. DENY for company_admin, for a plain staff member (manager, member, viewer, a module tier, client), for a low-assurance session,
//      and for a permission held at another company.
//   4. The resource is the company: id = tenantId. No attribute beyond `tenantId` is read, so an unfed resource is still decided.
//   5. resource_assistant_thread.yaml is untouched: still no platform_admin / company_admin rule there.
//
// Two layers:
//   A. STATIC (always runs): re-parses cerbos/policies/*.yaml and the generated bundle, and pins the structure.
//   B. LIVE (needs CERBOS_URL, as cerbos-dept-notice.test.ts): the decision matrix against the real engine loaded with the CURRENT policy
//      files (restart `gaiada-test-cerbos` after adding the policy; a skip is not a pass). Its first case is an ALLOW smoke test, so a
//      matrix of denials can never pass because the kind failed to load.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { check, type Resource } from "./cerbos";
import type { Principal, RoleGrant, PermissionGrant } from "./principal";
import { OWNER_EXTENSION } from "../../scripts/generate-role-bundles.mjs";

const POLICIES_DIR = join(__dirname, "../../cerbos/policies");
const KEY = "assistant.brain.choose_provider";

interface ParsedRule {
  actions: string[];
  effect: string;
  derivedRoles: string[];
  roles: string[];
  condition: string;
}
function parsePolicy(file: string, kind: string): ParsedRule[] {
  const text = readFileSync(join(POLICIES_DIR, file), "utf8");
  const docs = (yaml.loadAll(text) as any[]).filter((d) => d?.resourcePolicy);
  expect(docs.length, `${file} must hold exactly one resourcePolicy`).toBe(1);
  expect(docs[0].resourcePolicy.resource).toBe(kind);
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

describe("AIP-08b static pin — resource_assistant_brain.yaml", () => {
  const rules = parsePolicy("resource_assistant_brain.yaml", "assistant_brain");

  it("exactly two rules, both ALLOW: the platform_admin wildcard and the permission arm", () => {
    expect(rules.length).toBe(2);
    expect(rules.every((r) => r.effect === "EFFECT_ALLOW")).toBe(true);
    expect(rules.every((r) => r.roles.length === 0), "no base-role (`user`) rule: nobody gets it by merely existing").toBe(true);
  });

  it("the platform_admin wildcard opens the file, unconditional", () => {
    expect(rules[0]).toEqual({ actions: ["*"], effect: "EFFECT_ALLOW", derivedRoles: ["platform_admin"], roles: [], condition: "" });
  });

  it("no role rule beyond the wildcard: company_admin (AIP-D5 holders), manager, member, viewer, client, org_unit_lead and every module tier are named nowhere", () => {
    const named = new Set(rules.flatMap((r) => r.derivedRoles));
    expect([...named].sort()).toEqual(["perm_assistant_brain_choose_provider", "platform_admin"]);
  });

  it("the permission arm: choose_provider under inTenant && notLow && inRoot, and its derived role matches the catalog key at global or company scope", () => {
    const mirrors = rules.filter((r) => r.derivedRoles.some((d) => d.startsWith("perm_")));
    expect(mirrors.length).toBe(1);
    expect(mirrors[0].derivedRoles).toEqual(["perm_assistant_brain_choose_provider"]);
    expect(mirrors[0].actions).toEqual(["choose_provider"]);
    expect(mirrors[0].condition).toBe("variables.inTenant && variables.notLow && variables.inRoot");
    const expr = derivedRoleExprs().get("perm_assistant_brain_choose_provider");
    expect(expr, "perm_assistant_brain_choose_provider must exist in derived_roles.yaml").toBeTruthy();
    expect(expr).toContain(`g.key == "${KEY}"`);
    expect(expr).toContain('g.scopeType == "global"');
    expect(expr).toContain('g.scopeType == "company" && g.scopeId == request.resource.attr.tenantId');
  });

  it("the catalog: one grantable, NOT uiGrantable (AIP-D5 holders), not sensitive entry mapping to (assistant_brain, choose_provider)", () => {
    const catalog = JSON.parse(readFileSync(join(__dirname, "permission-catalog.json"), "utf8")) as {
      permissions: Array<{ key: string; cerbosKind: string; cerbosAction: string; class: string; sensitive: boolean; uiGrantable: boolean; domain: string }>;
    };
    const kind = catalog.permissions.filter((p) => p.cerbosKind === "assistant_brain");
    expect(kind.length).toBe(1);
    expect(kind[0]).toMatchObject({ key: KEY, domain: "assistant", cerbosAction: "choose_provider", class: "grantable", sensitive: false, uiGrantable: false });
  });

  it("the bundle JSON: platform_admin and owner hold the key (owner through OWNER_EXTENSION), and no other role; nothing self-scoped", () => {
    const doc = JSON.parse(readFileSync(join(__dirname, "role-permission-bundles.json"), "utf8")) as {
      roles: Record<string, string[]>;
      selfScoped: Record<string, string[]>;
    };
    const holders = Object.keys(doc.roles).filter((r) => doc.roles[r].includes(KEY)).sort();
    expect(holders).toEqual(["owner", "platform_admin"]);
    expect(OWNER_EXTENSION).toContain(KEY);
    for (const role of Object.keys(doc.selfScoped ?? {})) expect(doc.selfScoped[role] ?? [], role).not.toContain(KEY);
  });

  it("the resource needs nothing new from resourcePayload(): id and tenantId are already carried", () => {
    const src = readFileSync(join(__dirname, "cerbos.ts"), "utf8");
    expect(src).toContain('id: r.id ?? ""');
    expect(src).toContain('tenantId: r.tenantId ?? ""');
  });

  it("resource_assistant_thread.yaml stays owner-private: still no platform_admin or company_admin rule, and it never names this kind", () => {
    const threadRules = parsePolicy("resource_assistant_thread.yaml", "assistant_thread");
    for (const r of threadRules) {
      expect(r.derivedRoles).not.toContain("platform_admin");
      expect(r.derivedRoles).not.toContain("company_admin");
      expect(r.derivedRoles.some((d) => d.startsWith("perm_assistant_brain"))).toBe(false);
    }
  });
});

// ─── B. LIVE matrix ───────────────────────────────────────────────────────────────────────────────────────────
const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const T1 = "aaaaaaaa-0828-0000-0000-000000000001";
const T2 = "aaaaaaaa-0828-0000-0000-000000000002";

function principal(
  roles: RoleGrant[],
  opts: { perms?: PermissionGrant[]; companies?: string[]; rootCompanies?: string[]; assurance?: Principal["assurance"]; kind?: string } = {},
): Principal {
  const companies = opts.companies ?? [T1];
  return {
    userId: "u-me", assurance: opts.assurance ?? "high", companies,
    rootCompanies: opts.rootCompanies ?? companies, roles, perms: opts.perms ?? [], sessionVersion: 1,
    ...(opts.kind ? { kind: opts.kind } : {}),
  } as Principal;
}
const co = (role: string, scopeId = T1): RoleGrant => ({ role, scopeType: "company", scopeId });
const glob = (role: string): RoleGrant => ({ role, scopeType: "global", scopeId: null });
const perm = (scopeType: "company" | "global" = "company", scopeId: string | null = T1): PermissionGrant => ({ key: KEY, scopeType, scopeId });
// The company's brain setting: id = tenantId = the route's company.
const brain = (tenantId = T1): Resource => ({ kind: "assistant_brain", id: tenantId, tenantId });
const allow = async (p: Principal, r: Resource = brain()) => (await check(p, r, "choose_provider")).allow;

describe.skipIf(!live)("AIP-08b Cerbos matrix — assistant_brain · choose_provider", () => {
  it("SMOKE: the kind is loaded and the ALLOW path really allows (the owner, through the permission arm)", async () => {
    // If this fails, every deny below proves nothing: restart gaiada-test-cerbos so it loads the CURRENT policy file.
    expect(await allow(principal([co("owner")], { perms: [perm()] }))).toBe(true);
  });

  const table: Array<[string, Principal, Resource, boolean]> = [
    // ALLOW
    ["platform_admin (global)", principal([glob("platform_admin")]), brain(), true],
    ["platform_admin (global) on another company (the operator tier's wildcard)", principal([glob("platform_admin")]), brain(T2), true],
    ["owner @T1 (permission-native: the key at company scope, zero rules)", principal([co("owner")], { perms: [perm()] }), brain(), true],
    // the arm decides on the key alone: only the owner's bundle carries it (uiGrantable:false), but a holder is a holder
    ["the key held at T1 by any principal (the permission arm)", principal([co("member")], { perms: [perm()] }), brain(), true],
    ["the key held globally, a company in the principal's tenants and root", principal([co("owner")], { perms: [perm("global", null)] }), brain(), true],
    // DENY: everyone else sees Auto, Fast and Strong only
    ["company_admin @T1 (AIP-D5 holders: no rule, no bundle key)", principal([co("company_admin")]), brain(), false],
    ["a plain member @T1", principal([co("member")]), brain(), false],
    ["a manager @T1", principal([co("manager")]), brain(), false],
    ["a viewer @T1", principal([co("viewer")]), brain(), false],
    ["a client @T1", principal([co("client")]), brain(), false],
    ["a module tier (social_manager @T1)", principal([co("social_manager")]), brain(), false],
    ["owner @T1 WITHOUT the bundle key (owner has no rule of its own)", principal([co("owner")]), brain(), false],
    ["no grants at all", principal([]), brain(), false],
    // the tenant boundary
    ["owner @T2 holding the key at T2, T1's brain", principal([co("owner", T2)], { perms: [perm("company", T2)], companies: [T1, T2] }), brain(), false],
    ["owner @T1 holding the key at T1, T2's brain", principal([co("owner")], { perms: [perm()] }), brain(T2), false],
    ["the key held at T1 but T1 outside the principal's root (inRoot)", principal([co("owner")], { perms: [perm()], rootCompanies: [T2] }), brain(), false],
    // the assurance floor
    ["owner @T1 with the key at LOW assurance (notLow)", principal([co("owner")], { perms: [perm()], assurance: "low" }), brain(), false],
  ];

  for (const [label, p, r, expected] of table) {
    it(label, async () => {
      expect(await allow(p, r), `${label}: assistant_brain · choose_provider`).toBe(expected);
    });
  }

  it("an unlisted action is a deny (only platform_admin holds '*')", async () => {
    expect((await check(principal([co("owner")], { perms: [perm()] }), brain(), "read")).allow).toBe(false);
    expect((await check(principal([glob("platform_admin")]), brain(), "read")).allow).toBe(true);
  });

  it("the generated owner bundle, as assemblePrincipal() would hand it over, allows choose_provider", async () => {
    const bundles = JSON.parse(readFileSync(join(__dirname, "role-permission-bundles.json"), "utf8")) as { roles: Record<string, string[]> };
    const ownerP = principal([co("owner")], {
      perms: bundles.roles.owner.map((key) => ({ key, scopeType: "company" as const, scopeId: T1 })),
    });
    expect(await allow(ownerP)).toBe(true);
    expect(await allow(ownerP, brain(T2))).toBe(false);
  });

  it("the generated company_admin bundle, as assemblePrincipal() would hand it over, does NOT allow choose_provider (AIP-D5 holders)", async () => {
    const bundles = JSON.parse(readFileSync(join(__dirname, "role-permission-bundles.json"), "utf8")) as { roles: Record<string, string[]> };
    const adminP = principal([co("company_admin")], {
      perms: bundles.roles.company_admin.map((key) => ({ key, scopeType: "company" as const, scopeId: T1 })),
    });
    expect(await allow(adminP)).toBe(false);
  });
});
