// DW-5c (docs/FRONTEND-BFF-CONTRACT.md §32.2) — Cerbos matrix for the NEW core `work_request` kind.
//
// THE CLAIMS UNDER TEST
//   1. read: company_admin / manager / member / viewer. create: company_admin / manager / member (a viewer cannot ask).
//   2. cancel, deliver, decline: company_admin and manager.
//   3. cancel is ALSO reachable by the REQUESTER (requestedBy == principal id, held as `member`), and by nobody else.
//   4. deliver is ALSO reachable by the work's ASSIGNEES (principal id in assigneeIds, held as `member`) and by an
//      org_unit_lead over the receiving unit (unitAncestors). decline is ALSO reachable by an org_unit_lead, only.
//      The requester and an assignee never reach decline; the lead never reaches cancel or create.
//   5. Each attribute-dependent rule stands alone (HIER-2 authoring rule): no rule names org_unit_lead beside a scope role.
//   6. EFFECT_DENY on create / cancel / deliver / decline for automation and bot principals (beats the platform_admin
//      wildcard and the permission mirrors); read stays allowed.
//   7. The permission arm covers read and create and NOT cancel / deliver / decline.
//   8. `owner` (permission-native, zero rules) holds the same five keys as company_admin in its bundle.
//
// Two layers:
//   A. STATIC (always runs): re-parses cerbos/policies/*.yaml and pins the structure.
//   B. LIVE (needs CERBOS_URL, same convention as cerbos-agency-campaign-part.test.ts): the decision matrix against the
//      real engine loaded with the CURRENT policy files (restart `gaiada-test-cerbos` after the policy edit; a skip is
//      not a pass).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { check, type Resource } from "./cerbos";
import type { Principal, RoleGrant, PermissionGrant } from "./principal";

const POLICIES_DIR = join(__dirname, "../../cerbos/policies");
const ACTIONS = ["read", "create", "cancel", "deliver", "decline"] as const;
const WRITES = ["create", "cancel", "deliver", "decline"] as const;

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

describe("DW-5c static pin — resource_work_request.yaml", () => {
  const rules = parseKind("resource_work_request.yaml");
  const roleExprs = derivedRoleExprs();
  const allows = rules.filter((r) => r.effect === "EFFECT_ALLOW");
  const roleArm = allows.filter((r) => !r.derivedRoles.some((d) => d.startsWith("perm_") || d === "platform_admin"));
  const reach = (action: string) => roleArm.filter((r) => r.actions.includes(action));

  it("read = company_admin/manager/member/viewer; create = company_admin/manager/member", () => {
    expect(reach("read").flatMap((r) => r.derivedRoles).sort()).toEqual(["company_admin", "manager", "member", "viewer"]);
    expect(reach("create").flatMap((r) => r.derivedRoles).sort()).toEqual(["company_admin", "manager", "member"]);
  });

  it("cancel has TWO rules: company_admin+manager, and the requester (member + requestedBy == principal.id) on its own", () => {
    const rs = reach("cancel");
    expect(rs.length).toBe(2);
    expect(rs.find((r) => r.derivedRoles.includes("company_admin"))!.derivedRoles.sort()).toEqual(["company_admin", "manager"]);
    const requester = rs.find((r) => r.derivedRoles.includes("member"))!;
    expect(requester.derivedRoles).toEqual(["member"]);
    expect(requester.actions).toEqual(["cancel"]);
    expect(requester.condition).toContain("request.resource.attr.requestedBy == request.principal.id");
    expect(requester.condition).toContain('request.resource.attr.requestedBy != ""');
    expect(requester.condition).toContain("variables.inTenant && variables.notLow");
  });

  it("deliver has THREE rules: company_admin+manager, the assignees (member) and org_unit_lead, each on its own", () => {
    const rs = reach("deliver");
    expect(rs.length).toBe(3);
    expect(rs.find((r) => r.derivedRoles.includes("company_admin"))!.derivedRoles.sort()).toEqual(["company_admin", "manager"]);
    const assignee = rs.find((r) => r.derivedRoles.includes("member"))!;
    expect(assignee.derivedRoles).toEqual(["member"]);
    expect(assignee.actions).toEqual(["deliver"]);
    expect(assignee.condition).toContain("request.principal.id in request.resource.attr.assigneeIds");
    const lead = rs.find((r) => r.derivedRoles.includes("org_unit_lead"))!;
    expect(lead.derivedRoles, "org_unit_lead is never mixed with a scope role (HIER-2 §1.4)").toEqual(["org_unit_lead"]);
  });

  it("decline has TWO rules: company_admin+manager, and org_unit_lead on its own; neither the requester nor an assignee reaches it", () => {
    const rs = reach("decline");
    expect(rs.length).toBe(2);
    expect(rs.find((r) => r.derivedRoles.includes("company_admin"))!.derivedRoles.sort()).toEqual(["company_admin", "manager"]);
    expect(rs.find((r) => r.derivedRoles.includes("org_unit_lead"))!.derivedRoles).toEqual(["org_unit_lead"]);
    expect(rs.some((r) => r.derivedRoles.includes("member"))).toBe(false);
  });

  it("org_unit_lead appears only on deliver and decline (never read, create or cancel), and always alone", () => {
    for (const r of roleArm) {
      if (r.derivedRoles.includes("org_unit_lead")) {
        expect(r.derivedRoles).toEqual(["org_unit_lead"]);
        expect(r.actions.length).toBe(1);
        expect(["deliver", "decline"]).toContain(r.actions[0]);
      }
    }
  });

  it("the requester and assignee rules are on `member` only and never carry another action", () => {
    for (const r of roleArm) {
      if (r.condition.includes("requestedBy") || r.condition.includes("assigneeIds")) {
        expect(r.derivedRoles).toEqual(["member"]);
        expect(r.actions.length).toBe(1);
      }
    }
  });

  it("an EFFECT_DENY on create/cancel/deliver/decline for automation and bot, on roles [user], and NOT on read", () => {
    const denies = rules.filter((r) => r.effect === "EFFECT_DENY");
    expect(denies.length).toBe(1);
    expect(denies[0].roles).toEqual(["user"]);
    expect(denies[0].actions.sort()).toEqual([...WRITES].sort());
    expect(denies[0].condition).toBe('has(request.principal.attr.kind) && request.principal.attr.kind in ["automation", "bot"]');
  });

  it("the permission arm mirrors read and create exactly once each, under inTenant && notLow && inRoot, and NOT cancel/deliver/decline", () => {
    for (const a of ["read", "create"]) {
      const mirrors = rules.filter((r) => r.derivedRoles.some((d) => d.startsWith("perm_")) && r.actions.includes(a));
      expect(mirrors.length, `perm mirror rules for ${a}`).toBe(1);
      expect(mirrors[0].derivedRoles).toEqual([`perm_work_request_${a}`]);
      expect(mirrors[0].condition).toBe("variables.inTenant && variables.notLow && variables.inRoot");
      const expr = roleExprs.get(`perm_work_request_${a}`);
      expect(expr, `perm_work_request_${a} must exist in derived_roles.yaml`).toBeTruthy();
      expect(expr).toContain(`g.key == "core.work_request.${a}"`);
      expect(expr).toContain('g.scopeType == "global"');
      expect(expr).toContain('g.scopeType == "company" && g.scopeId == request.resource.attr.tenantId');
    }
    for (const a of ["cancel", "deliver", "decline"]) {
      expect(rules.filter((r) => r.derivedRoles.some((d) => d.startsWith("perm_")) && r.actions.includes(a)), a).toEqual([]);
      expect(roleExprs.has(`perm_work_request_${a}`), a).toBe(false);
    }
  });

  it("the `client` role is named by no rule", () => {
    for (const r of rules) {
      expect(r.derivedRoles).not.toContain("client");
      expect(r.roles).not.toContain("client");
    }
  });

  it("requestedBy and assigneeIds reach the policy: Resource type AND the resourcePayload() allow-list carry both, fail closed", () => {
    const src = readFileSync(join(__dirname, "cerbos.ts"), "utf8");
    expect(src).toContain("requestedBy?: string;");
    expect(src).toContain("assigneeIds?: string[];");
    expect(src).toContain('requestedBy: r.requestedBy ?? ""');
    expect(src).toContain("assigneeIds: r.assigneeIds ?? []");
    expect(src).toContain("unitAncestors: r.unitAncestors ?? []");
  });

  it("the bundle JSON: owner == company_admin (all five), manager all five, member read/create/cancel/deliver (cancel and deliver self-scoped), viewer read, org_unit_lead deliver+decline, client none", () => {
    const doc = JSON.parse(readFileSync(join(__dirname, "role-permission-bundles.json"), "utf8")) as {
      roles: Record<string, string[]>;
      selfScoped: Record<string, string[]>;
    };
    const keys = (role: string) => doc.roles[role].filter((k) => k.startsWith("core.work_request.")).sort();
    const all = ACTIONS.map((a) => `core.work_request.${a}`).sort();
    expect(keys("company_admin")).toEqual(all);
    expect(keys("owner")).toEqual(all);
    expect(keys("manager")).toEqual(all);
    expect(keys("platform_admin")).toEqual(all);
    expect(keys("member")).toEqual(["core.work_request.cancel", "core.work_request.create", "core.work_request.deliver", "core.work_request.read"]);
    expect(keys("viewer")).toEqual(["core.work_request.read"]);
    expect(keys("org_unit_lead")).toEqual(["core.work_request.decline", "core.work_request.deliver"]);
    expect(keys("client")).toEqual([]);
    expect((doc.selfScoped.member ?? []).filter((k) => k.startsWith("core.work_request.")).sort()).toEqual([
      "core.work_request.cancel", "core.work_request.deliver",
    ]);
    expect((doc.selfScoped.org_unit_lead ?? []).filter((k) => k.startsWith("core.work_request."))).toEqual([]);
    // create, read and decline are never in a self-scoped pair
    for (const list of Object.values(doc.selfScoped)) {
      for (const k of ["create", "read", "decline"]) expect(list).not.toContain(`core.work_request.${k}`);
    }
  });
});

// ─── B. LIVE matrix ───────────────────────────────────────────────────────────────────────────────────────────
const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const T1 = "aaaaaaaa-5c5c-0000-0000-000000000001";
const T2 = "aaaaaaaa-5c5c-0000-0000-000000000002";
const ME = "u-requester";
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

// A request addressed to department d-creative, which sits under d-corp; d-seo is its sibling.
const CREATIVE_ANCESTORS = ["d-creative", "d-corp"];
const request = (extra: Partial<Resource> = {}, tenantId = T1): Resource => ({
  kind: "work_request", tenantId, id: "22222222-2222-2222-2222-222222222222",
  requestedBy: SOMEONE_ELSE, assigneeIds: [SOMEONE_ELSE], unitAncestors: CREATIVE_ANCESTORS, ...extra,
});
const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;

type Cell = Record<(typeof ACTIONS)[number], boolean>;
const ALL: Cell = { read: true, create: true, cancel: true, deliver: true, decline: true };
const NONE: Cell = { read: false, create: false, cancel: false, deliver: false, decline: false };
const READ_ONLY: Cell = { ...NONE, read: true };
const READ_CREATE: Cell = { ...NONE, read: true, create: true };

describe.skipIf(!live)("DW-5c Cerbos matrix — work_request (role x action)", () => {
  const table: Array<[string, Principal, Cell]> = [
    ["platform_admin (global)", principal([glob("platform_admin")]), ALL],
    ["company_admin @T1", principal([co("company_admin")]), ALL],
    ["manager @T1: does everything", principal([co("manager")]), ALL],
    ["member @T1 (neither requester nor assignee): reads and asks", principal([co("member")]), READ_CREATE],
    ["viewer @T1: reads only (cannot ask)", principal([co("viewer")]), READ_ONLY],
    ["org_unit_lead of d-creative alone: delivers and declines, nothing else (no read either)", principal([lead("d-creative")]), { ...NONE, deliver: true, decline: true }],
    ["org_unit_lead of d-corp (an ANCESTOR unit): delivers and declines", principal([lead("d-corp")]), { ...NONE, deliver: true, decline: true }],
    ["org_unit_lead of d-seo (a SIBLING unit): nothing", principal([lead("d-seo")]), NONE],
    ["org_unit_lead of d-creative + member: reads, asks, delivers, declines, but cannot cancel", principal([lead("d-creative"), co("member")]), { ...READ_CREATE, deliver: true, decline: true }],
    ["company-scoped org_unit_lead grant (mis-scoped): nothing", principal([co("org_unit_lead")]), NONE],
    ["client @T1", principal([co("client")]), NONE],
    ["webdev_manager @T1 (a module tier)", principal([co("webdev_manager")]), NONE],
    ["company_admin of T2 only (cross-tenant)", principal([co("company_admin", T2)], { companies: [T2] }), NONE],
    ["company_admin @T1 at LOW assurance (notLow)", principal([co("company_admin")], { assurance: "low" }), NONE],
    ["no grants at all", principal([]), NONE],
    // PV-4 precedent: the DENY beats every ALLOW, the platform_admin wildcard included; read is untouched.
    ["a BOT holding member: reads only", principal([co("member")], { kind: "bot" }), READ_ONLY],
    ["an AUTOMATION principal holding company_admin: reads only", principal([co("company_admin")], { kind: "automation" }), READ_ONLY],
    ["a bot holding manager AND org_unit_lead: reads only", principal([co("manager"), lead("d-creative")], { kind: "bot" }), READ_ONLY],
    ["platform_admin that is a bot: reads only (the DENY beats the wildcard)", principal([glob("platform_admin")], { kind: "bot" }), READ_ONLY],
    ["an employee-kind principal is unaffected by the DENY", principal([co("company_admin")], { kind: "employee" }), ALL],
  ];

  for (const [label, p, expected] of table) {
    it(`${label}`, async () => {
      for (const action of ACTIONS) {
        expect(await allow(p, request(), action), `${label}: work_request · ${action}`).toBe(expected[action]);
      }
    });
  }

  it("the REQUESTER (a member) cancels their own request, reads and asks, and can NEVER deliver or decline it", async () => {
    const me = principal([co("member")]);
    const mine = request({ requestedBy: ME });
    expect(await allow(me, mine, "cancel")).toBe(true);
    expect(await allow(me, mine, "read")).toBe(true);
    expect(await allow(me, mine, "create")).toBe(true);
    expect(await allow(me, mine, "deliver")).toBe(false);
    expect(await allow(me, mine, "decline")).toBe(false);
  });

  it("the requester rule fails closed: an unfed requestedBy (\"\") or someone else's request denies cancel", async () => {
    const me = principal([co("member")]);
    expect(await allow(me, request({ requestedBy: undefined }), "cancel")).toBe(false);
    expect(await allow(me, request({ requestedBy: SOMEONE_ELSE }), "cancel")).toBe(false);
  });

  it("being the requester does not help a VIEWER (the rule is on `member`), nor a bot", async () => {
    expect(await allow(principal([co("viewer")]), request({ requestedBy: ME }), "cancel")).toBe(false);
    expect(await allow(principal([co("member")], { kind: "bot" }), request({ requestedBy: ME }), "cancel")).toBe(false);
  });

  it("an ASSIGNEE (a member) delivers, and can NEVER decline or cancel someone else's request", async () => {
    const me = principal([co("member")]);
    const work = request({ assigneeIds: [SOMEONE_ELSE, ME] });
    expect(await allow(me, work, "deliver")).toBe(true);
    expect(await allow(me, work, "decline")).toBe(false);
    expect(await allow(me, work, "cancel")).toBe(false);
  });

  it("the assignee rule fails closed: an unfed assigneeIds ([]) or a list without the caller denies deliver", async () => {
    const me = principal([co("member")]);
    expect(await allow(me, request({ assigneeIds: undefined }), "deliver")).toBe(false);
    expect(await allow(me, request({ assigneeIds: [SOMEONE_ELSE] }), "deliver")).toBe(false);
  });

  it("the lead rule fails closed: an unfed unitAncestors ([]) denies, and the cascade is one-directional (down, never up)", async () => {
    expect(await allow(principal([lead("d-creative")]), request({ unitAncestors: undefined }), "deliver")).toBe(false);
    expect(await allow(principal([lead("d-creative")]), request({ unitAncestors: ["d-corp"] }), "decline")).toBe(false);
  });

  it("an unlisted action is a deny (only platform_admin holds '*')", async () => {
    expect(await allow(principal([co("company_admin")]), request(), "approve")).toBe(false);
    expect(await allow(principal([glob("platform_admin")]), request(), "approve")).toBe(true);
  });
});

describe.skipIf(!live)("DW-5c Cerbos matrix — work_request, the permission arm (roles: [])", () => {
  const permP = (key: string, scopeType: "company" | "global" = "company", opts: { assurance?: Principal["assurance"]; kind?: string } = {}) =>
    principal([], { perms: [{ key, scopeType, scopeId: scopeType === "company" ? T1 : null }], ...opts });

  for (const action of ["read", "create"] as const) {
    const key = `core.work_request.${action}`;
    it(`permission ${key} ALONE allows ${action} and no sibling action; no cross-tenant, no low assurance`, async () => {
      expect(await allow(permP(key), request(), action)).toBe(true);
      for (const other of ACTIONS.filter((a) => a !== action)) {
        expect(await allow(permP(key), request(), other), `${key} must not allow ${other}`).toBe(false);
      }
      expect(await allow(permP(key), request({}, T2), action)).toBe(false);
      expect(await allow(permP(key, "company", { assurance: "low" }), request(), action)).toBe(false);
    });
  }

  it("a bot holding the create permission is still denied (the DENY applies to the mirror too), but may read", async () => {
    expect(await allow(permP("core.work_request.create", "company", { kind: "bot" }), request(), "create")).toBe(false);
    expect(await allow(permP("core.work_request.read", "company", { kind: "bot" }), request(), "read")).toBe(true);
  });

  it("the bare cancel / deliver / decline permissions allow NOTHING (there is deliberately no mirror)", async () => {
    for (const a of ["cancel", "deliver", "decline"] as const) {
      expect(await allow(permP(`core.work_request.${a}`), request({ requestedBy: ME, assigneeIds: [ME] }), a), a).toBe(false);
    }
  });

  it("a permission-native OWNER (the bundle's keys, zero rules) reads and creates, but its cancel/deliver/decline keys have no arm", async () => {
    const bundles = JSON.parse(readFileSync(join(__dirname, "role-permission-bundles.json"), "utf8")) as { roles: Record<string, string[]> };
    const ownerP = principal([co("owner")], {
      perms: bundles.roles.owner.map((key) => ({ key, scopeType: "company" as const, scopeId: T1 })),
    });
    for (const a of ["read", "create"]) expect(await allow(ownerP, request(), a), `owner · ${a}`).toBe(true);
    for (const a of ["cancel", "deliver", "decline"]) expect(await allow(ownerP, request(), a), `owner · ${a}`).toBe(false);
  });
});
