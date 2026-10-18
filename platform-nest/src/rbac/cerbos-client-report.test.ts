// PV7-04a (docs/FRONTEND-BFF-CONTRACT.md §55, docs/PERMISSION-CONTRACT.md §46) — Cerbos matrix for the NEW core
// `client_report` kind.
//
// THE CLAIMS UNDER TEST
//   1. read: company_admin / manager / member / viewer (the `client` kind's read tiers).
//   2. draft, publish, withdraw: company_admin and manager.
//   3. draft, publish and withdraw are ALSO reachable by the CLIENT'S OWNER (ownerUserId == principal id, held as
//      `member`), and by no other member. The owner rule stands alone (HIER-2 authoring rule) and is self-scoped.
//   4. EFFECT_DENY on publish and withdraw for automation and bot principals (L6: agents draft, staff publish). It beats
//      the platform_admin wildcard and the permission mirror; read and draft stay allowed.
//   5. The permission arm covers read only.
//   6. The `client` derived role is named by no rule: portal reads go through `portal` and the scope builder.
//   7. `owner` (permission-native) holds the same four keys as company_admin in its bundle; member holds read plus the
//      three self-scoped pairs; viewer holds read.
//
// Two layers:
//   A. STATIC (always runs): re-parses cerbos/policies/*.yaml and pins the structure.
//   B. LIVE (needs CERBOS_URL): the decision matrix against the real engine loaded with the CURRENT policy files
//      (restart `gaiada-test-cerbos` after the policy edit; a skip is not a pass).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { check, type Resource } from "./cerbos";
import type { Principal, RoleGrant, PermissionGrant } from "./principal";

const POLICIES_DIR = join(__dirname, "../../cerbos/policies");
const ACTIONS = ["read", "draft", "publish", "withdraw"] as const;
const WRITES = ["draft", "publish", "withdraw"] as const;

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

describe("PV7-04a static pin — resource_client_report.yaml", () => {
  const rules = parseKind("resource_client_report.yaml");
  const roleExprs = derivedRoleExprs();
  const allows = rules.filter((r) => r.effect === "EFFECT_ALLOW");
  const roleArm = allows.filter((r) => !r.derivedRoles.some((d) => d.startsWith("perm_") || d === "platform_admin"));
  const reach = (action: string) => roleArm.filter((r) => r.actions.includes(action));

  it("read = company_admin/manager/member/viewer, the same tiers as the `client` kind's read", () => {
    expect(reach("read").flatMap((r) => r.derivedRoles).sort()).toEqual(["company_admin", "manager", "member", "viewer"]);
    const clientRead = parseKind("resource_client.yaml")
      .filter((r) => r.effect === "EFFECT_ALLOW" && r.actions.includes("read"))
      .flatMap((r) => r.derivedRoles)
      .filter((d) => !d.startsWith("perm_") && d !== "platform_admin")
      .sort();
    expect(reach("read").flatMap((r) => r.derivedRoles).sort()).toEqual(clientRead);
  });

  it("draft, publish and withdraw each have TWO rules: company_admin+manager, and the client's owner (member) on its own", () => {
    for (const a of WRITES) {
      const rs = reach(a);
      expect(rs.length, a).toBe(2);
      expect(rs.find((r) => r.derivedRoles.includes("company_admin"))!.derivedRoles.sort()).toEqual(["company_admin", "manager"]);
      const owner = rs.find((r) => r.derivedRoles.includes("member"))!;
      expect(owner.derivedRoles).toEqual(["member"]);
      expect(owner.condition).toContain("request.resource.attr.ownerUserId == request.principal.id");
      expect(owner.condition).toContain('request.resource.attr.ownerUserId != ""');
      expect(owner.condition).toContain("has(request.resource.attr.ownerUserId)");
      expect(owner.condition).toContain("variables.inTenant && variables.notLow");
    }
  });

  it("the owner rule names `member` only and never carries `read`", () => {
    for (const r of roleArm) {
      if (r.condition.includes("ownerUserId")) {
        expect(r.derivedRoles).toEqual(["member"]);
        expect(r.actions).not.toContain("read");
      }
    }
  });

  it("an EFFECT_DENY on publish/withdraw for automation and bot, on roles [user], and NOT on read or draft (L6)", () => {
    const denies = rules.filter((r) => r.effect === "EFFECT_DENY");
    expect(denies.length).toBe(1);
    expect(denies[0].roles).toEqual(["user"]);
    expect(denies[0].actions.sort()).toEqual(["publish", "withdraw"]);
    expect(denies[0].condition).toBe('has(request.principal.attr.kind) && request.principal.attr.kind in ["automation", "bot"]');
  });

  it("the permission arm mirrors read exactly once, under inTenant && notLow && inRoot, and NOT draft/publish/withdraw", () => {
    const mirrors = rules.filter((r) => r.derivedRoles.some((d) => d.startsWith("perm_")) && r.actions.includes("read"));
    expect(mirrors.length).toBe(1);
    expect(mirrors[0].derivedRoles).toEqual(["perm_client_report_read"]);
    expect(mirrors[0].condition).toBe("variables.inTenant && variables.notLow && variables.inRoot");
    const expr = roleExprs.get("perm_client_report_read");
    expect(expr, "perm_client_report_read must exist in derived_roles.yaml").toBeTruthy();
    expect(expr).toContain('g.key == "core.client_report.read"');
    expect(expr).toContain('g.scopeType == "global"');
    expect(expr).toContain('g.scopeType == "company" && g.scopeId == request.resource.attr.tenantId');
    for (const a of WRITES) {
      expect(rules.filter((r) => r.derivedRoles.some((d) => d.startsWith("perm_")) && r.actions.includes(a)), a).toEqual([]);
      expect(roleExprs.has(`perm_client_report_${a}`), a).toBe(false);
    }
  });

  it("the `client` role is named by no rule (portal reads go through `portal` and clientReportInPortalScope)", () => {
    for (const r of rules) {
      expect(r.derivedRoles).not.toContain("client");
      expect(r.roles).not.toContain("client");
    }
  });

  it("ownerUserId reaches the policy: the Resource type AND the resourcePayload() allow-list carry it, failing closed", () => {
    const src = readFileSync(join(__dirname, "cerbos.ts"), "utf8");
    expect(src).toContain("ownerUserId?: string;");
    expect(src).toContain('ownerUserId: r.ownerUserId ?? ""');
  });

  it("the bundle JSON: owner == company_admin == manager == platform_admin (all four), member read + three self-scoped pairs, viewer read, client none", () => {
    const doc = JSON.parse(readFileSync(join(__dirname, "role-permission-bundles.json"), "utf8")) as {
      roles: Record<string, string[]>;
      selfScoped: Record<string, string[]>;
    };
    const keys = (role: string) => (doc.roles[role] ?? []).filter((k) => k.startsWith("core.client_report.")).sort();
    const all = ACTIONS.map((a) => `core.client_report.${a}`).sort();
    for (const role of ["company_admin", "owner", "manager", "platform_admin", "member"]) expect(keys(role), role).toEqual(all);
    expect(keys("viewer")).toEqual(["core.client_report.read"]);
    expect(keys("client")).toEqual([]);
    expect(keys("org_unit_lead")).toEqual([]);
    expect((doc.selfScoped.member ?? []).filter((k) => k.startsWith("core.client_report.")).sort()).toEqual(
      WRITES.map((a) => `core.client_report.${a}`).sort(),
    );
    for (const list of Object.values(doc.selfScoped)) expect(list).not.toContain("core.client_report.read");
  });

  it("the catalog: four grantable keys, publish and withdraw sensitive, all in one authoring group that is not advancedOnly", () => {
    const cat = JSON.parse(readFileSync(join(__dirname, "permission-catalog.json"), "utf8")) as {
      permissions: Array<{ key: string; cerbosKind: string; cerbosAction: string; class: string; sensitive: boolean; uiGrantable: boolean }>;
    };
    const mine = cat.permissions.filter((p) => p.cerbosKind === "client_report");
    expect(mine.map((p) => p.cerbosAction).sort()).toEqual([...ACTIONS].sort());
    for (const p of mine) {
      expect(p.class).toBe("grantable");
      expect(p.uiGrantable).toBe(true);
      expect(p.sensitive, p.key).toBe(p.cerbosAction === "publish" || p.cerbosAction === "withdraw");
    }
    const groups = JSON.parse(readFileSync(join(__dirname, "permission-groups.json"), "utf8")) as {
      groups: Array<{ key: string; permissions: string[]; sensitive: boolean }>;
      advancedOnly: string[];
    };
    const g = groups.groups.find((x) => x.key === "client_reports");
    expect(g?.permissions.sort()).toEqual(mine.map((p) => p.key).sort());
    expect(g?.sensitive).toBe(true);
    for (const p of mine) expect(groups.advancedOnly).not.toContain(p.key);
  });
});

// ─── B. LIVE matrix ───────────────────────────────────────────────────────────────────────────────────────────
const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const T1 = "aaaaaaaa-7047-0000-0000-000000000001";
const T2 = "aaaaaaaa-7047-0000-0000-000000000002";
const ME = "u-client-owner";
const SOMEONE_ELSE = "u-someone-else";

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

/** A report of a client owned by SOMEONE_ELSE (unless overridden). */
const report = (extra: Partial<Resource> = {}, tenantId = T1): Resource => ({
  kind: "client_report", tenantId, id: "33333333-3333-3333-3333-333333333333",
  clientId: "44444444-4444-4444-4444-444444444444", ownerUserId: SOMEONE_ELSE, ...extra,
});
const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;

type Cell = Record<(typeof ACTIONS)[number], boolean>;
const ALL: Cell = { read: true, draft: true, publish: true, withdraw: true };
const NONE: Cell = { read: false, draft: false, publish: false, withdraw: false };
const READ_ONLY: Cell = { ...NONE, read: true };
const READ_DRAFT: Cell = { ...NONE, read: true, draft: true };

describe.skipIf(!live)("PV7-04a Cerbos matrix — client_report (role x action)", () => {
  const table: Array<[string, Principal, Cell]> = [
    ["platform_admin (global)", principal([glob("platform_admin")]), ALL],
    ["company_admin @T1", principal([co("company_admin")]), ALL],
    ["manager @T1", principal([co("manager")]), ALL],
    ["member @T1 who does not own the client: reads only", principal([co("member")]), READ_ONLY],
    ["viewer @T1: reads only", principal([co("viewer")]), READ_ONLY],
    ["client @T1 (a portal contact): nothing (portal reads go through `portal`)", principal([co("client")]), NONE],
    ["org_unit_lead (unit-scoped): nothing", principal([{ role: "org_unit_lead", scopeType: "org_unit", scopeId: "d-x", tenantIds: [T1] }]), NONE],
    ["webdev_manager @T1 (a module tier)", principal([co("webdev_manager")]), NONE],
    ["company_admin of T2 only (cross-tenant)", principal([co("company_admin", T2)], { companies: [T2] }), NONE],
    ["company_admin @T1 at LOW assurance (notLow)", principal([co("company_admin")], { assurance: "low" }), NONE],
    ["no grants at all", principal([]), NONE],
    // L6: agents draft, staff publish. The DENY beats every ALLOW, the platform_admin wildcard included.
    ["an AUTOMATION principal holding manager: reads and drafts, never publishes or withdraws", principal([co("manager")], { kind: "automation" }), READ_DRAFT],
    ["an AUTOMATION principal holding company_admin: reads and drafts", principal([co("company_admin")], { kind: "automation" }), READ_DRAFT],
    ["a BOT holding company_admin: reads and drafts", principal([co("company_admin")], { kind: "bot" }), READ_DRAFT],
    ["platform_admin that is a bot: reads and drafts (the DENY beats the wildcard)", principal([glob("platform_admin")], { kind: "bot" }), READ_DRAFT],
    ["an employee-kind principal is unaffected by the DENY", principal([co("company_admin")], { kind: "employee" }), ALL],
  ];

  for (const [label, p, expected] of table) {
    it(`${label}`, async () => {
      for (const action of ACTIONS) {
        expect(await allow(p, report(), action), `${label}: client_report · ${action}`).toBe(expected[action]);
      }
    });
  }

  it("the CLIENT'S OWNER (a member) drafts, publishes and withdraws their own client's reports", async () => {
    const me = principal([co("member")]);
    const mine = report({ ownerUserId: ME });
    for (const a of ACTIONS) expect(await allow(me, mine, a), a).toBe(true);
  });

  it("the owner rule fails closed: an unfed ownerUserId (\"\") or another person's client denies the writes", async () => {
    const me = principal([co("member")]);
    for (const a of WRITES) {
      expect(await allow(me, report({ ownerUserId: undefined }), a), `unfed · ${a}`).toBe(false);
      expect(await allow(me, report({ ownerUserId: SOMEONE_ELSE }), a), `other · ${a}`).toBe(false);
    }
  });

  it("owning the client does not help a VIEWER (the rule is on `member`), and an owner that is a BOT may draft but never publish or withdraw", async () => {
    for (const a of WRITES) expect(await allow(principal([co("viewer")]), report({ ownerUserId: ME }), a), `viewer · ${a}`).toBe(false);
    const botOwner = principal([co("member")], { kind: "bot" });
    expect(await allow(botOwner, report({ ownerUserId: ME }), "draft")).toBe(true);
    expect(await allow(botOwner, report({ ownerUserId: ME }), "publish")).toBe(false);
    expect(await allow(botOwner, report({ ownerUserId: ME }), "withdraw")).toBe(false);
  });

  it("an unlisted action is a deny (only platform_admin holds '*')", async () => {
    expect(await allow(principal([co("company_admin")]), report(), "delete")).toBe(false);
    expect(await allow(principal([glob("platform_admin")]), report(), "delete")).toBe(true);
  });
});

describe.skipIf(!live)("PV7-04a Cerbos matrix — client_report, the permission arm (roles: [])", () => {
  const permP = (key: string, scopeType: "company" | "global" = "company", opts: { assurance?: Principal["assurance"]; kind?: string } = {}) =>
    principal([], { perms: [{ key, scopeType, scopeId: scopeType === "company" ? T1 : null }], ...opts });

  it("permission core.client_report.read ALONE allows read and nothing else; no cross-tenant, no low assurance", async () => {
    const key = "core.client_report.read";
    expect(await allow(permP(key), report(), "read")).toBe(true);
    for (const other of WRITES) expect(await allow(permP(key), report(), other), other).toBe(false);
    expect(await allow(permP(key), report({}, T2), "read")).toBe(false);
    expect(await allow(permP(key, "company", { assurance: "low" }), report(), "read")).toBe(false);
  });

  it("the bare draft / publish / withdraw permissions allow NOTHING (there is deliberately no mirror)", async () => {
    for (const a of WRITES) {
      expect(await allow(permP(`core.client_report.${a}`), report({ ownerUserId: ME }), a), a).toBe(false);
    }
  });

  it("a permission-native OWNER (the bundle's keys, zero rules) reads, but its write keys have no arm", async () => {
    const bundles = JSON.parse(readFileSync(join(__dirname, "role-permission-bundles.json"), "utf8")) as { roles: Record<string, string[]> };
    const ownerP = principal([co("owner")], {
      perms: bundles.roles.owner.map((key) => ({ key, scopeType: "company" as const, scopeId: T1 })),
    });
    expect(await allow(ownerP, report(), "read")).toBe(true);
    for (const a of WRITES) expect(await allow(ownerP, report(), a), `owner · ${a}`).toBe(false);
  });
});
