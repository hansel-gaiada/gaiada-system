// PV4-02 — Cerbos matrix for the NEW `conversation` kind (the staff side of the client conversation) and the
// portal `converse` action (the client's door to it). Owner rulings PV-D22/D23/D24.
//
// THE CLAIMS UNDER TEST
//   1. Staff reach copies resource_client.yaml: read for company_admin/manager/member/viewer; post/draft/manage
//      for company_admin/manager/member. A viewer may only read.
//   2. NO automation or bot principal posts or manages (PV-D23): kind in [automation, bot] is DENIED `post` and
//      `manage` even when it holds company_admin, platform_admin or a permission mirror — but keeps `draft` and
//      `read` (drafting IS the agent's job; a human then sends).
//   3. The `client` grant is ALLOWED portal `converse` and DENIED every `conversation` action.
//   4. `owner` (permission-native, zero rules) reaches exactly what company_admin reaches.
//   5. `converse` is not conditioned on the contact's `capability` (PV-D24: viewers post). The capability is not a
//      Cerbos attribute; here we assert that no rule or derived role reads it. The HTTP-layer proof is PV4-03's.
//
// Two layers:
//   A. STATIC (always runs): re-parses cerbos/policies/*.yaml and pins the structure — so removing the agent DENY, or
//      reading `capability`, fails on a laptop and in any CI shard without a Cerbos container.
//   B. LIVE (needs CERBOS_URL, same convention as cerbos-webdev-site.test.ts): the decision matrix against the real
//      engine loaded with the CURRENT policy files (restart `gaiada-test-cerbos` after the policy edit). Run on the
//      Linux gate host; skipped otherwise, and a skip is not a pass.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { check, principalPayload, type Resource } from "./cerbos";
import type { Principal, RoleGrant, PermissionGrant } from "./principal";

const POLICIES_DIR = join(__dirname, "../../cerbos/policies");
const ACTIONS = ["read", "post", "draft", "manage"] as const;

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

describe("PV4-02 static pin — resource_conversation.yaml and the portal converse action", () => {
  const rules = parseKind("resource_conversation.yaml");
  const roleExprs = derivedRoleExprs();

  it("the agent DENY exists: exactly post + manage, on roles:[user], reading principal.attr.kind in [automation, bot]", () => {
    const denies = rules.filter((r) => r.effect === "EFFECT_DENY");
    expect(denies.length, "exactly one DENY rule").toBe(1);
    const [d] = denies;
    expect([...d.actions].sort()).toEqual(["manage", "post"]);
    expect(d.roles).toEqual(["user"]);
    expect(d.condition).toContain("request.principal.attr.kind");
    expect(d.condition).toContain('["automation", "bot"]');
    expect(d.condition, "has() guards a raw caller that omits the attribute").toContain("has(request.principal.attr.kind)");
  });

  it("`draft` and `read` are NOT denied to agents (drafting is the agent's job)", () => {
    for (const r of rules.filter((x) => x.effect === "EFFECT_DENY")) {
      expect(r.actions).not.toContain("draft");
      expect(r.actions).not.toContain("read");
      expect(r.actions).not.toContain("*");
    }
  });

  it("the role arms copy resource_client.yaml's shape: read = company_admin/manager/member/viewer; post/draft/manage = company_admin/manager/member", () => {
    const allow = rules.filter((r) => r.effect === "EFFECT_ALLOW" && r.derivedRoles.every((d) => !d.startsWith("perm_") && d !== "platform_admin"));
    const reach = (action: string) =>
      allow.filter((r) => r.actions.includes(action)).flatMap((r) => r.derivedRoles).sort();
    expect(reach("read")).toEqual(["company_admin", "manager", "member", "viewer"]);
    for (const a of ["post", "draft", "manage"]) expect(reach(a), a).toEqual(["company_admin", "manager", "member"]);
    for (const r of allow) expect(r.condition).toBe("variables.inTenant && variables.notLow");
  });

  it("every action has exactly one perm mirror under inTenant && notLow && inRoot, on a global-or-company derived role keyed core.conversation.<action>", () => {
    for (const a of ACTIONS) {
      const mirrors = rules.filter((r) => r.derivedRoles.some((d) => d.startsWith("perm_")) && r.actions.includes(a));
      expect(mirrors.length, `perm mirror rules for ${a}`).toBe(1);
      expect(mirrors[0].derivedRoles).toEqual([`perm_conversation_${a}`]);
      expect(mirrors[0].condition).toBe("variables.inTenant && variables.notLow && variables.inRoot");
      const expr = roleExprs.get(`perm_conversation_${a}`);
      expect(expr, `perm_conversation_${a} must exist in derived_roles.yaml`).toBeTruthy();
      expect(expr).toContain(`g.key == "core.conversation.${a}"`);
      expect(expr).toContain('g.scopeType == "global"');
      expect(expr).toContain('g.scopeType == "company" && g.scopeId == request.resource.attr.tenantId');
    }
  });

  it("the `client` role is named by no rule of the conversation policy", () => {
    for (const r of rules) {
      expect(r.derivedRoles, JSON.stringify(r.actions)).not.toContain("client");
      expect(r.roles, JSON.stringify(r.actions)).not.toContain("client");
    }
  });

  it("portal `converse` is on the client rule with the same condition as the other client actions, and has a perm mirror", () => {
    const portal = parseKind("resource_portal.yaml");
    const clientRule = portal.find((r) => r.derivedRoles.includes("client"))!;
    expect(clientRule.actions).toContain("converse");
    expect(clientRule.condition).toBe("variables.inTenant && variables.inRoot");
    const mirror = portal.find((r) => r.actions.includes("converse") && r.derivedRoles.includes("perm_portal_converse"));
    expect(mirror, "perm_portal_converse rule").toBeDefined();
    expect(mirror!.condition).toBe("variables.inTenant && variables.inRoot");
    const expr = roleExprs.get("perm_portal_converse")!;
    expect(expr).toContain('g.key == "portal.converse"');
    expect(expr).not.toContain('"global"');
  });

  it("the principal payload Cerbos sees carries no `capability` attribute and DOES carry `kind` (so the agent DENY can read it)", () => {
    const attr = principalPayload({
      userId: "u", assurance: "high", companies: [], rootCompanies: [], roles: [], perms: [], sessionVersion: 1, kind: "bot",
    }).attr as Record<string, unknown>;
    expect(Object.keys(attr)).not.toContain("capability");
    expect(attr.kind).toBe("bot");
    expect(
      (principalPayload({ userId: "u", assurance: "high", companies: [], rootCompanies: [], roles: [], perms: [], sessionVersion: 1 }).attr as Record<string, unknown>).kind,
      "an absent kind is sent as the empty string, which matches no DENY",
    ).toBe("");
  });

  it("the resource payload carries tenantId, clientId and projectId — all a conversation needs (cerbos.ts needs no change)", () => {
    // resourcePayload() is private; read the allow-list straight from the source so a removal is caught.
    const src = readFileSync(join(__dirname, "cerbos.ts"), "utf8");
    for (const field of ["tenantId", "clientId", "projectId"]) {
      expect(src, field).toContain(`${field}: r.${field} ?? ""`);
    }
  });

  it("the bundle JSON gives viewer read only, member/manager all four, owner exactly company_admin's, and the client role NO conversation key", () => {
    const bundles = JSON.parse(readFileSync(join(__dirname, "role-permission-bundles.json"), "utf8")) as {
      roles: Record<string, string[]>;
    };
    const keys = (role: string) => bundles.roles[role].filter((k) => k.startsWith("core.conversation.")).sort();
    expect(keys("viewer")).toEqual(["core.conversation.read"]);
    expect(keys("member")).toEqual(ACTIONS.map((a) => `core.conversation.${a}`).sort());
    expect(keys("manager")).toEqual(keys("member"));
    expect(keys("client")).toEqual([]);
    expect(keys("owner")).toEqual(keys("company_admin"));
    expect(keys("owner")).toEqual(ACTIONS.map((a) => `core.conversation.${a}`).sort());
    expect(bundles.roles.client).toContain("portal.converse");
  });

  it("no condition or derived role reads the contact's `capability` (PV-D24: viewers post, posting is not signing)", () => {
    const portal = parseKind("resource_portal.yaml");
    // Anything on the converse path: the conversation policy's every rule, the portal rules that name converse,
    // and the converse mirror's derived role.
    const exprs = [
      ...rules.map((r) => r.condition),
      ...portal.filter((r) => r.actions.includes("converse")).map((r) => r.condition),
      roleExprs.get("perm_portal_converse") ?? "",
      ...ACTIONS.map((a) => roleExprs.get(`perm_conversation_${a}`) ?? ""),
    ];
    for (const e of exprs) {
      expect(e).not.toMatch(/capability/i);
      expect(e).not.toMatch(/signer/i);
    }
  });
});

// ─── B. LIVE matrix ───────────────────────────────────────────────────────────────────────────────────────────
const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const T1 = "aaaaaaaa-4444-0000-0000-000000000001"; // home tenant
const T2 = "aaaaaaaa-4444-0000-0000-000000000002"; // rival tenant

function principal(
  roles: RoleGrant[],
  opts: {
    perms?: PermissionGrant[];
    companies?: string[];
    assurance?: Principal["assurance"];
    kind?: Principal["kind"];
  } = {},
): Principal {
  const companies = opts.companies ?? [T1];
  return {
    userId: "u-conv", assurance: opts.assurance ?? "high", companies,
    rootCompanies: companies, roles, perms: opts.perms ?? [], sessionVersion: 1,
    ...(opts.kind ? { kind: opts.kind } : {}),
  };
}
const co = (role: string, scopeId = T1): RoleGrant => ({ role, scopeType: "company", scopeId });
const glob = (role: string): RoleGrant => ({ role, scopeType: "global", scopeId: null });

const conv = (tenantId = T1): Resource => ({
  kind: "conversation", tenantId, clientId: "bbbbbbbb-0000-0000-0000-000000000001", projectId: "cccccccc-0000-0000-0000-000000000001",
});
const portal = (tenantId = T1): Resource => ({ kind: "portal", tenantId });
const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;

type Cell = Record<(typeof ACTIONS)[number], boolean>;
const ALL: Cell = { read: true, post: true, draft: true, manage: true };
const NONE: Cell = { read: false, post: false, draft: false, manage: false };
const READ_ONLY: Cell = { read: true, post: false, draft: false, manage: false };
const NO_POST_NO_MANAGE: Cell = { read: true, post: false, draft: true, manage: false };

describe.skipIf(!live)("PV4-02 Cerbos matrix — conversation (role x action)", () => {
  const table: Array<[string, Principal, Cell]> = [
    ["platform_admin (global)", principal([glob("platform_admin")]), ALL],
    ["company_admin @T1", principal([co("company_admin")]), ALL],
    ["manager @T1", principal([co("manager")]), ALL],
    ["member @T1: may post", principal([co("member")]), ALL],
    ["viewer @T1: read only", principal([co("viewer")]), READ_ONLY],
    ["client @T1 — the client grant appears nowhere in this policy", principal([co("client")]), NONE],
    ["webdev_manager @T1 (a module manager tier)", principal([co("webdev_manager")]), NONE],
    ["hr_manager @T1 (another module's manager tier)", principal([co("hr_manager")]), NONE],
    ["group_executive (global) — IAM-15 removed the role, nothing here", principal([glob("group_executive")]), NONE],
    ["company_admin of T2 only (cross-tenant)", principal([co("company_admin", T2)], { companies: [T2] }), NONE],
    ["company_admin @T1 at LOW assurance (notLow)", principal([co("company_admin")], { assurance: "low" }), NONE],
    ["member @T1 at LOW assurance", principal([co("member")], { assurance: "low" }), NONE],
    ["no grants at all", principal([]), NONE],
    // ── PV-D23: agents and automation ──
    ["bot holding company_admin: DENIED post and manage, ALLOWED draft and read", principal([co("company_admin")], { kind: "bot" }), NO_POST_NO_MANAGE],
    ["automation holding company_admin: same", principal([co("company_admin")], { kind: "automation" }), NO_POST_NO_MANAGE],
    ["bot holding member: same", principal([co("member")], { kind: "bot" }), NO_POST_NO_MANAGE],
    ["bot holding manager: same", principal([co("manager")], { kind: "bot" }), NO_POST_NO_MANAGE],
    ["bot holding platform_admin: the wildcard does not beat the DENY", principal([glob("platform_admin")], { kind: "bot" }), NO_POST_NO_MANAGE],
    ["bot holding viewer: read only, as any viewer", principal([co("viewer")], { kind: "bot" }), READ_ONLY],
    // a human is unaffected by the new attribute
    ["employee holding company_admin (kind=employee)", principal([co("company_admin")], { kind: "employee" }), ALL],
  ];

  for (const [label, p, expected] of table) {
    it(`${label}`, async () => {
      for (const action of ACTIONS) {
        expect(await allow(p, conv(), action), `${label}: conversation · ${action}`).toBe(expected[action]);
      }
    });
  }

  it("an unlisted action is a deny, never a wildcard leak (only platform_admin holds '*')", async () => {
    expect(await allow(principal([co("company_admin")]), conv(), "delete")).toBe(false);
    expect(await allow(principal([co("company_admin")]), conv(), "reopen")).toBe(false);
    expect(await allow(principal([glob("platform_admin")]), conv(), "delete")).toBe(true);
  });

  it("OWNER == company_admin: a permission-native owner (zero rules, bundle only) decides every action exactly as company_admin does", async () => {
    const bundles = JSON.parse(readFileSync(join(__dirname, "role-permission-bundles.json"), "utf8")) as {
      roles: Record<string, string[]>;
    };
    const keys = (role: string) => bundles.roles[role].filter((k) => k.startsWith("core.conversation.")).sort();
    expect(keys("owner")).toEqual(keys("company_admin"));
    expect(keys("owner")).toEqual(ACTIONS.map((a) => `core.conversation.${a}`).sort());
    const ownerP = principal([co("owner")], {
      perms: bundles.roles.owner.map((key) => ({ key, scopeType: "company" as const, scopeId: T1 })),
    });
    const adminP = principal([co("company_admin")]);
    for (const action of ACTIONS) {
      expect(await allow(ownerP, conv(), action), `owner · ${action}`).toBe(await allow(adminP, conv(), action));
      expect(await allow(ownerP, conv(), action), `owner · ${action}`).toBe(true);
    }
    // ... and the agent DENY applies to an owner-shaped bot as well
    const ownerBot = principal([co("owner")], { kind: "bot", perms: ownerP.perms });
    expect(await allow(ownerBot, conv(), "post")).toBe(false);
    expect(await allow(ownerBot, conv(), "manage")).toBe(false);
    expect(await allow(ownerBot, conv(), "draft")).toBe(true);
  });

  it("an instance id / projectId on the resource does not change any decision (row-level reach is the controller's)", async () => {
    for (const [label, p] of table) {
      for (const action of ACTIONS) {
        expect(await allow(p, { ...conv(), id: "11111111-1111-1111-1111-111111111111" }, action), `${label} · ${action}`)
          .toBe(await allow(p, conv(), action));
      }
    }
  });
});

describe.skipIf(!live)("PV4-02 Cerbos matrix — conversation, the B12 permission-mirror arm (roles: [])", () => {
  const permP = (
    key: string,
    scopeType: "company" | "global" = "company",
    opts: { assurance?: Principal["assurance"]; companies?: string[]; kind?: Principal["kind"] } = {},
  ) => principal([], { perms: [{ key, scopeType, scopeId: scopeType === "company" ? T1 : null }], ...opts });

  for (const action of ACTIONS) {
    const key = `core.conversation.${action}`;
    it(`permission ${key} ALONE allows ${action}`, async () => {
      expect(await allow(permP(key), conv(), action)).toBe(true);
    });
    it(`permission ${key} does not bleed into the sibling actions it was not granted`, async () => {
      for (const other of ACTIONS.filter((a) => a !== action)) {
        expect(await allow(permP(key), conv(), other), `${key} must not allow ${other}`).toBe(false);
      }
    });
    it(`permission ${key}: no cross-tenant reach, no low-assurance reach`, async () => {
      expect(await allow(permP(key), conv(T2), action)).toBe(false);
      expect(await allow(permP(key, "company", { assurance: "low" }), conv(), action)).toBe(false);
    });
  }

  it("a global-scope permission covers the tenant the principal is authorised for (same as the role arm)", async () => {
    expect(await allow(permP("core.conversation.read", "global"), conv(), "read")).toBe(true);
  });

  it("the agent DENY beats the permission mirror too: a bot holding core.conversation.post / .manage ALONE is denied; .draft and .read still allow", async () => {
    expect(await allow(permP("core.conversation.post", "company", { kind: "bot" }), conv(), "post")).toBe(false);
    expect(await allow(permP("core.conversation.manage", "company", { kind: "automation" }), conv(), "manage")).toBe(false);
    expect(await allow(permP("core.conversation.draft", "company", { kind: "bot" }), conv(), "draft")).toBe(true);
    expect(await allow(permP("core.conversation.read", "company", { kind: "bot" }), conv(), "read")).toBe(true);
  });
});

describe.skipIf(!live)("PV4-02 Cerbos matrix — portal `converse` (the client door)", () => {
  it("a client grant is ALLOWED portal converse in its own tenant and DENIED every conversation action", async () => {
    const p = principal([co("client")]);
    expect(await allow(p, portal(), "converse")).toBe(true);
    for (const action of ACTIONS) expect(await allow(p, conv(), action), `client · conversation · ${action}`).toBe(false);
  });

  it("converse is DENIED to a client of another tenant, and to a client at the wrong scope", async () => {
    expect(await allow(principal([co("client", T2)], { companies: [T2] }), portal(T1), "converse")).toBe(false);
    expect(await allow(principal([glob("client")]), portal(T1), "converse")).toBe(false);
  });

  it("staff have NO converse: company_admin / manager / member / viewer are denied (DR-12: staff never use the portal door)", async () => {
    for (const role of ["company_admin", "manager", "member", "viewer"]) {
      expect(await allow(principal([co(role)]), portal(), "converse"), role).toBe(false);
    }
  });

  it("the permission mirror alone allows converse in the grant's own company, never a global-scope grant, and does not bleed into sign/pay", async () => {
    const own = principal([], { perms: [{ key: "portal.converse", scopeType: "company", scopeId: T1 }] });
    expect(await allow(own, portal(), "converse")).toBe(true);
    expect(await allow(own, portal(T2), "converse")).toBe(false);
    for (const other of ["sign", "pay", "decide", "request_change"]) expect(await allow(own, portal(), other), other).toBe(false);
    const glb = principal([], { perms: [{ key: "portal.converse", scopeType: "global", scopeId: null }] });
    expect(await allow(glb, portal(), "converse")).toBe(false);
  });
});
