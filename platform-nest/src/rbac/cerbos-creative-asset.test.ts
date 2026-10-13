// DW-6h (docs/FRONTEND-BFF-CONTRACT.md §35.4) — Cerbos matrix for the NEW core `creative_asset` kind: the review rounds of
// an Asset Library asset. (The asset routes themselves stay on the `file` kind; nothing here touches them.)
//
// THE CLAIMS UNDER TEST
//   1. read: company_admin / manager / member / viewer. request_review: company_admin / manager / member.
//   2. decide_review and withdraw_review: company_admin and manager.
//   3. decide_review is ALSO reachable by an org_unit_lead over the asset's department (unitAncestors) and by a REQUESTER of
//      a linked work request (principal id in requesterIds, held as `member`). withdraw_review is ALSO reachable by the
//      round's OPENER (reviewRequestedBy == principal id, held as `member`).
//   4. NOBODY decides a round they opened, whatever their role (EFFECT_DENY, platform_admin included). The DENY is shaped
//      like invoice `approve`'s: it fires on a KNOWN opener; the handler always feeds one from the round row.
//   5. EFFECT_DENY on decide_review for automation and bot principals (beats the wildcard and every ALLOW).
//   6. Each attribute-dependent rule stands alone; the relationship conditions are INLINE, never behind a variable.
//   7. The permission arm covers read and request_review and NOT decide_review / withdraw_review.
//   8. `owner` (permission-native, zero rules) holds the same four keys as company_admin in its bundle.
//
// Two layers:
//   A. STATIC (always runs): re-parses cerbos/policies/*.yaml and pins the structure.
//   B. LIVE (needs CERBOS_URL, same convention as cerbos-work-request.test.ts): the decision matrix against the real engine
//      loaded with the CURRENT policy files (restart `gaiada-test-cerbos` after the policy edit; a skip is not a pass).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { check, type Resource } from "./cerbos";
import type { Principal, RoleGrant, PermissionGrant } from "./principal";

const POLICIES_DIR = join(__dirname, "../../cerbos/policies");
const ACTIONS = ["read", "request_review", "decide_review", "withdraw_review"] as const;

interface ParsedRule {
  actions: string[];
  effect: string;
  derivedRoles: string[];
  roles: string[];
  condition: string;
}
function parseKind(file: string): { rules: ParsedRule[]; raw: any } {
  const text = readFileSync(join(POLICIES_DIR, file), "utf8");
  const docs = (yaml.loadAll(text) as any[]).filter((d) => d?.resourcePolicy);
  expect(docs.length, `${file} must hold exactly one resourcePolicy`).toBe(1);
  const rules = (docs[0].resourcePolicy.rules ?? []).map((r: any) => ({
    actions: r.actions ?? [],
    effect: r.effect ?? "EFFECT_ALLOW",
    derivedRoles: r.derivedRoles ?? [],
    roles: r.roles ?? [],
    condition: (r.condition?.match?.expr ?? "").replace(/\s+/g, " ").trim(),
  }));
  return { rules, raw: docs[0].resourcePolicy };
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

describe("DW-6h static pin — resource_creative_asset.yaml", () => {
  const { rules, raw } = parseKind("resource_creative_asset.yaml");
  const roleExprs = derivedRoleExprs();
  const allows = rules.filter((r) => r.effect === "EFFECT_ALLOW");
  const roleArm = allows.filter((r) => !r.derivedRoles.some((d) => d.startsWith("perm_") || d === "platform_admin"));
  const reach = (action: string) => roleArm.filter((r) => r.actions.includes(action));

  it("is the `creative_asset` kind, importing gaiada_scopes and only the shared gaiada_common variables (no local variables)", () => {
    expect(raw.resource).toBe("creative_asset");
    expect(raw.importDerivedRoles).toEqual(["gaiada_scopes"]);
    expect(raw.variables?.import).toEqual(["gaiada_common"]);
    expect(raw.variables?.local, "a local variable could hide a self-scope from the bundle generator").toBeUndefined();
  });

  it("read = company_admin/manager/member/viewer; request_review = company_admin/manager/member", () => {
    expect(reach("read").flatMap((r) => r.derivedRoles).sort()).toEqual(["company_admin", "manager", "member", "viewer"]);
    expect(reach("request_review").flatMap((r) => r.derivedRoles).sort()).toEqual(["company_admin", "manager", "member"]);
  });

  it("decide_review has THREE rules: company_admin+manager, org_unit_lead alone, and the requester (member, inline `principal.id in requesterIds`) alone", () => {
    const rs = reach("decide_review");
    expect(rs.length).toBe(3);
    expect(rs.find((r) => r.derivedRoles.includes("company_admin"))!.derivedRoles.sort()).toEqual(["company_admin", "manager"]);
    const lead = rs.find((r) => r.derivedRoles.includes("org_unit_lead"))!;
    expect(lead.derivedRoles, "org_unit_lead is never mixed with a scope role (HIER-2 §1.4)").toEqual(["org_unit_lead"]);
    expect(lead.actions).toEqual(["decide_review"]);
    const requester = rs.find((r) => r.derivedRoles.includes("member"))!;
    expect(requester.derivedRoles).toEqual(["member"]);
    expect(requester.actions).toEqual(["decide_review"]);
    expect(requester.condition).toContain("request.principal.id in request.resource.attr.requesterIds");
    expect(requester.condition).toContain("variables.inTenant && variables.notLow");
  });

  it("withdraw_review has TWO rules: company_admin+manager, and the opener (member, inline `reviewRequestedBy == principal.id`) alone", () => {
    const rs = reach("withdraw_review");
    expect(rs.length).toBe(2);
    expect(rs.find((r) => r.derivedRoles.includes("company_admin"))!.derivedRoles.sort()).toEqual(["company_admin", "manager"]);
    const opener = rs.find((r) => r.derivedRoles.includes("member"))!;
    expect(opener.derivedRoles).toEqual(["member"]);
    expect(opener.actions).toEqual(["withdraw_review"]);
    expect(opener.condition).toContain("request.resource.attr.reviewRequestedBy == request.principal.id");
    expect(opener.condition).toContain('request.resource.attr.reviewRequestedBy != ""');
    expect(rs.some((r) => r.derivedRoles.includes("org_unit_lead")), "a lead does not withdraw").toBe(false);
  });

  it("org_unit_lead appears only on decide_review, and always alone", () => {
    for (const r of roleArm) {
      if (r.derivedRoles.includes("org_unit_lead")) {
        expect(r.derivedRoles).toEqual(["org_unit_lead"]);
        expect(r.actions).toEqual(["decide_review"]);
      }
    }
  });

  it("every relationship condition is on `member` only, carries one action, and is written inline (no `variables.` self-scope)", () => {
    for (const r of roleArm) {
      if (r.condition.includes("requesterIds") || r.condition.includes("reviewRequestedBy")) {
        expect(r.derivedRoles).toEqual(["member"]);
        expect(r.actions.length).toBe(1);
        expect(r.condition).not.toMatch(/variables\.(owns|is[A-Z]\w*|requester|opener)/);
      }
    }
  });

  it("EXACTLY two EFFECT_DENY rules, both on decide_review only and on roles [user]: the maker/checker self-approval DENY (invoice-approve shape) and the automation/bot DENY", () => {
    const denies = rules.filter((r) => r.effect === "EFFECT_DENY");
    expect(denies.length).toBe(2);
    for (const d of denies) {
      expect(d.roles).toEqual(["user"]);
      expect(d.derivedRoles).toEqual([]);
      expect(d.actions).toEqual(["decide_review"]);
    }
    const self = denies.find((d) => d.condition.includes("reviewRequestedBy"))!;
    expect(self.condition).toBe(
      'has(request.resource.attr.reviewRequestedBy) && request.resource.attr.reviewRequestedBy != "" && ' +
        "request.resource.attr.reviewRequestedBy == request.principal.id",
    );
    const bot = denies.find((d) => d.condition.includes("principal.attr.kind"))!;
    expect(bot.condition).toBe('has(request.principal.attr.kind) && request.principal.attr.kind in ["automation", "bot"]');
  });

  it("the permission arm mirrors read and request_review exactly once each, under inTenant && notLow && inRoot, and NOT decide_review/withdraw_review", () => {
    for (const a of ["read", "request_review"]) {
      const mirrors = rules.filter((r) => r.derivedRoles.some((d) => d.startsWith("perm_")) && r.actions.includes(a));
      expect(mirrors.length, `perm mirror rules for ${a}`).toBe(1);
      expect(mirrors[0].derivedRoles).toEqual([`perm_creative_asset_${a}`]);
      expect(mirrors[0].condition).toBe("variables.inTenant && variables.notLow && variables.inRoot");
      const expr = roleExprs.get(`perm_creative_asset_${a}`);
      expect(expr, `perm_creative_asset_${a} must exist in derived_roles.yaml`).toBeTruthy();
      expect(expr).toContain(`g.key == "core.creative_asset.${a}"`);
      expect(expr).toContain('g.scopeType == "global"');
      expect(expr).toContain('g.scopeType == "company" && g.scopeId == request.resource.attr.tenantId');
    }
    for (const a of ["decide_review", "withdraw_review"]) {
      expect(rules.filter((r) => r.derivedRoles.some((d) => d.startsWith("perm_")) && r.actions.includes(a)), a).toEqual([]);
      expect(roleExprs.has(`perm_creative_asset_${a}`), a).toBe(false);
    }
  });

  it("the `client` role is named by no rule", () => {
    for (const r of rules) {
      expect(r.derivedRoles).not.toContain("client");
      expect(r.roles).not.toContain("client");
    }
  });

  it("the existing asset routes still authorise as `file` (no creative_asset check on list/save/read/stream/delete)", () => {
    const src = readFileSync(join(__dirname, "../core/creative.controller.ts"), "utf8");
    // Every `kind: "creative_asset"` resource is built by reviewResource(); the five original routes name `file`.
    expect(src.match(/\{ kind: "file", tenantId \}/g)?.length).toBe(7);
    expect(src.match(/kind: "creative_asset"/g)?.length).toBe(1);
  });

  it("requesterIds and reviewRequestedBy reach the policy: Resource type AND the resourcePayload() allow-list carry both, fail closed", () => {
    const src = readFileSync(join(__dirname, "cerbos.ts"), "utf8");
    expect(src).toContain("requesterIds?: string[];");
    expect(src).toContain("reviewRequestedBy?: string;");
    expect(src).toContain("requesterIds: r.requesterIds ?? []");
    expect(src).toContain('reviewRequestedBy: r.reviewRequestedBy ?? ""');
    expect(src).toContain("unitAncestors: r.unitAncestors ?? []");
  });

  it("the bundle JSON: owner == company_admin (all four), manager all four, member all four (decide/withdraw self-scoped), viewer read, org_unit_lead decide_review, client none", () => {
    const doc = JSON.parse(readFileSync(join(__dirname, "role-permission-bundles.json"), "utf8")) as {
      roles: Record<string, string[]>;
      selfScoped: Record<string, string[]>;
    };
    const keys = (role: string) => doc.roles[role].filter((k) => k.startsWith("core.creative_asset.")).sort();
    const all = ACTIONS.map((a) => `core.creative_asset.${a}`).sort();
    expect(keys("company_admin")).toEqual(all);
    expect(keys("owner")).toEqual(all);
    expect(keys("manager")).toEqual(all);
    expect(keys("platform_admin")).toEqual(all);
    expect(keys("member")).toEqual(all);
    expect(keys("viewer")).toEqual(["core.creative_asset.read"]);
    expect(keys("org_unit_lead")).toEqual(["core.creative_asset.decide_review"]);
    expect(keys("client")).toEqual([]);
    expect((doc.selfScoped.member ?? []).filter((k) => k.startsWith("core.creative_asset.")).sort()).toEqual([
      "core.creative_asset.decide_review", "core.creative_asset.withdraw_review",
    ]);
    expect((doc.selfScoped.org_unit_lead ?? []).filter((k) => k.startsWith("core.creative_asset."))).toEqual([]);
    for (const list of Object.values(doc.selfScoped)) {
      for (const k of ["read", "request_review"]) expect(list).not.toContain(`core.creative_asset.${k}`);
    }
  });
});

// ─── B. LIVE matrix ───────────────────────────────────────────────────────────────────────────────────────────
const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const T1 = "aaaaaaaa-6b6b-0000-0000-000000000001";
const T2 = "aaaaaaaa-6b6b-0000-0000-000000000002";
const ME = "u-caller";
const OPENER = "u-opener";
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
const lead = (unit: string): RoleGrant => ({ role: "org_unit_lead", scopeType: "org_unit", scopeId: unit });

// An asset of department d-creative, which sits under d-corp; d-seo is its sibling. The round was opened by OPENER, and the
// asset was delivered against a request SOMEONE_ELSE made.
const CREATIVE_ANCESTORS = ["d-creative", "d-corp"];
const asset = (extra: Partial<Resource> = {}, tenantId = T1): Resource => ({
  kind: "creative_asset", tenantId, id: "33333333-3333-3333-3333-333333333333",
  unitAncestors: CREATIVE_ANCESTORS, requesterIds: [SOMEONE_ELSE], reviewRequestedBy: OPENER, ...extra,
});
const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;

type Cell = Record<(typeof ACTIONS)[number], boolean>;
const ALL: Cell = { read: true, request_review: true, decide_review: true, withdraw_review: true };
const NONE: Cell = { read: false, request_review: false, decide_review: false, withdraw_review: false };
const READ_ONLY: Cell = { ...NONE, read: true };
const READ_REQUEST: Cell = { ...NONE, read: true, request_review: true };
const ALL_BUT_DECIDE: Cell = { ...ALL, decide_review: false };

describe.skipIf(!live)("DW-6h Cerbos matrix — creative_asset (role x action)", () => {
  const table: Array<[string, Principal, Cell]> = [
    ["platform_admin (global)", principal([glob("platform_admin")]), ALL],
    ["company_admin @T1", principal([co("company_admin")]), ALL],
    ["manager @T1", principal([co("manager")]), ALL],
    ["member @T1 (neither requester nor opener): may REQUEST but not decide or withdraw", principal([co("member")]), READ_REQUEST],
    ["viewer @T1: reads only", principal([co("viewer")]), READ_ONLY],
    ["org_unit_lead of d-creative alone: decides, nothing else", principal([lead("d-creative")]), { ...NONE, decide_review: true }],
    ["org_unit_lead of d-corp (an ANCESTOR unit): decides", principal([lead("d-corp")]), { ...NONE, decide_review: true }],
    ["org_unit_lead of d-seo (a SIBLING unit): nothing", principal([lead("d-seo")]), NONE],
    ["org_unit_lead of d-seo + member: reads and requests, never decides another department's asset", principal([lead("d-seo"), co("member")]), READ_REQUEST],
    ["org_unit_lead of d-creative + member: reads, requests, decides, but cannot withdraw others' rounds", principal([lead("d-creative"), co("member")]), { ...READ_REQUEST, decide_review: true }],
    ["company-scoped org_unit_lead grant (mis-scoped): nothing", principal([co("org_unit_lead")]), NONE],
    ["client @T1", principal([co("client")]), NONE],
    ["webdev_manager @T1 (a module tier)", principal([co("webdev_manager")]), NONE],
    ["company_admin of T2 only (cross-tenant)", principal([co("company_admin", T2)], { companies: [T2] }), NONE],
    ["company_admin @T1 at LOW assurance (notLow)", principal([co("company_admin")], { assurance: "low" }), NONE],
    ["no grants at all", principal([]), NONE],
    // A bot never DECIDES; the DENY beats every ALLOW, the platform_admin wildcard included.
    ["a BOT holding manager: everything but decide", principal([co("manager")], { kind: "bot" }), ALL_BUT_DECIDE],
    ["an AUTOMATION principal holding company_admin: everything but decide", principal([co("company_admin")], { kind: "automation" }), ALL_BUT_DECIDE],
    ["a bot holding org_unit_lead of d-creative: nothing (its one action is denied)", principal([lead("d-creative")], { kind: "bot" }), NONE],
    ["platform_admin that is a bot: everything but decide (the DENY beats the wildcard)", principal([glob("platform_admin")], { kind: "bot" }), ALL_BUT_DECIDE],
    ["an employee-kind principal is unaffected by the bot DENY", principal([co("company_admin")], { kind: "employee" }), ALL],
  ];

  for (const [label, p, expected] of table) {
    it(`${label}`, async () => {
      for (const action of ACTIONS) {
        expect(await allow(p, asset(), action), `${label}: creative_asset · ${action}`).toBe(expected[action]);
      }
    });
  }

  it("the person who OPENED a round can never decide it, whatever their role (company_admin, manager, lead, requester, platform_admin)", async () => {
    const mine = asset({ reviewRequestedBy: ME, requesterIds: [ME] });
    for (const [label, p] of [
      ["company_admin", principal([co("company_admin")])],
      ["manager", principal([co("manager")])],
      ["org_unit_lead of d-creative", principal([lead("d-creative")])],
      ["requester (member)", principal([co("member")])],
      ["platform_admin", principal([glob("platform_admin")])],
    ] as Array<[string, Principal]>) {
      expect(await allow(p, mine, "decide_review"), `${label} deciding a round they opened`).toBe(false);
    }
    // ...but the same company_admin still decides somebody else's round, and withdraws their own.
    expect(await allow(principal([co("company_admin")]), asset(), "decide_review")).toBe(true);
    expect(await allow(principal([co("company_admin")]), mine, "withdraw_review")).toBe(true);
  });

  it("the self-approval DENY fires only on a KNOWN opener (invoice-approve shape): an unfed opener leaves the ALLOW rules to decide, and adds no reach to a member", async () => {
    // The handler always feeds the opener from the round row; an unfed resource is a scope-level probe (`can()`).
    expect(await allow(principal([co("company_admin")]), asset({ reviewRequestedBy: undefined }), "decide_review")).toBe(true);
    expect(await allow(principal([glob("platform_admin")]), asset({ reviewRequestedBy: "" }), "decide_review")).toBe(true);
    expect(await allow(principal([co("member")]), asset({ reviewRequestedBy: undefined }), "decide_review")).toBe(false);
    expect(await allow(principal([co("viewer")]), asset({ reviewRequestedBy: "" }), "decide_review")).toBe(false);
  });

  it("a REQUESTER of a linked request (a member) decides, and nothing else beyond a member's reach", async () => {
    const me = principal([co("member")]);
    const linked = asset({ requesterIds: [SOMEONE_ELSE, ME] });
    expect(await allow(me, linked, "decide_review")).toBe(true);
    expect(await allow(me, linked, "withdraw_review")).toBe(false);
    expect(await allow(me, linked, "read")).toBe(true);
    expect(await allow(me, linked, "request_review")).toBe(true);
  });

  it("the requester rule fails closed and is on `member` only: an unfed list, a list without the caller, a viewer or a bot requester all deny", async () => {
    const me = principal([co("member")]);
    expect(await allow(me, asset({ requesterIds: undefined }), "decide_review")).toBe(false);
    expect(await allow(me, asset({ requesterIds: [SOMEONE_ELSE] }), "decide_review")).toBe(false);
    expect(await allow(principal([co("viewer")]), asset({ requesterIds: [ME] }), "decide_review")).toBe(false);
    expect(await allow(principal([co("member")], { kind: "bot" }), asset({ requesterIds: [ME] }), "decide_review")).toBe(false);
  });

  it("withdraw: the OPENER (a member) withdraws their own round; another member cannot; a manager can; a viewer opener cannot", async () => {
    expect(await allow(principal([co("member")]), asset({ reviewRequestedBy: ME }), "withdraw_review")).toBe(true);
    expect(await allow(principal([co("member")]), asset({ reviewRequestedBy: OPENER }), "withdraw_review")).toBe(false);
    expect(await allow(principal([co("manager")]), asset({ reviewRequestedBy: OPENER }), "withdraw_review")).toBe(true);
    expect(await allow(principal([co("viewer")]), asset({ reviewRequestedBy: ME }), "withdraw_review")).toBe(false);
    expect(await allow(principal([co("member")]), asset({ reviewRequestedBy: undefined }), "withdraw_review")).toBe(false);
  });

  it("the lead rule fails closed: an unfed unitAncestors ([]) denies, and the cascade is one-directional (down, never up)", async () => {
    expect(await allow(principal([lead("d-creative")]), asset({ unitAncestors: undefined }), "decide_review")).toBe(false);
    expect(await allow(principal([lead("d-creative")]), asset({ unitAncestors: ["d-corp"] }), "decide_review")).toBe(false);
  });

  it("an unlisted action is a deny (only platform_admin holds '*')", async () => {
    expect(await allow(principal([co("company_admin")]), asset(), "delete")).toBe(false);
    expect(await allow(principal([glob("platform_admin")]), asset(), "delete")).toBe(true);
  });
});

describe.skipIf(!live)("DW-6h Cerbos matrix — creative_asset, the permission arm (roles: [])", () => {
  const permP = (key: string, scopeType: "company" | "global" = "company", opts: { assurance?: Principal["assurance"]; kind?: string } = {}) =>
    principal([], { perms: [{ key, scopeType, scopeId: scopeType === "company" ? T1 : null }], ...opts });

  for (const action of ["read", "request_review"] as const) {
    const key = `core.creative_asset.${action}`;
    it(`permission ${key} ALONE allows ${action} and no sibling action; no cross-tenant, no low assurance`, async () => {
      expect(await allow(permP(key), asset(), action)).toBe(true);
      for (const other of ACTIONS.filter((a) => a !== action)) {
        expect(await allow(permP(key), asset(), other), `${key} must not allow ${other}`).toBe(false);
      }
      expect(await allow(permP(key), asset({}, T2), action)).toBe(false);
      expect(await allow(permP(key, "company", { assurance: "low" }), asset(), action)).toBe(false);
    });
  }

  it("the bare decide_review / withdraw_review permissions allow NOTHING (there is deliberately no mirror)", async () => {
    for (const a of ["decide_review", "withdraw_review"] as const) {
      expect(await allow(permP(`core.creative_asset.${a}`), asset({ reviewRequestedBy: ME, requesterIds: [ME] }), a), a).toBe(false);
      expect(await allow(permP(`core.creative_asset.${a}`), asset(), a), a).toBe(false);
    }
  });

  it("a permission-native OWNER (the bundle's keys, zero rules) reads and requests, but its decide/withdraw keys have no arm", async () => {
    const bundles = JSON.parse(readFileSync(join(__dirname, "role-permission-bundles.json"), "utf8")) as { roles: Record<string, string[]> };
    const ownerP = principal([co("owner")], {
      perms: bundles.roles.owner.map((key) => ({ key, scopeType: "company" as const, scopeId: T1 })),
    });
    for (const a of ["read", "request_review"]) expect(await allow(ownerP, asset(), a), `owner · ${a}`).toBe(true);
    for (const a of ["decide_review", "withdraw_review"]) expect(await allow(ownerP, asset(), a), `owner · ${a}`).toBe(false);
  });
});
