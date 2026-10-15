// DW-8j (docs/FRONTEND-BFF-CONTRACT.md §48, docs/PERMISSION-CONTRACT.md §40) — Cerbos matrix for the NEW core `personal_mailbox` kind.
//
// THE CLAIMS UNDER TEST
//   1. connect / read / send: ONE allow rule, the SELF rule — `ownerId == principal.id` on member, manager and company_admin. Nothing else
//      allows (bar the platform_admin wildcard, which the deny below narrows).
//   2. NOBODY reads or sends as anyone else: an EFFECT_DENY on `roles: ["user"]` for anyone who is not the owner beats EVERY allow, the
//      platform_admin wildcard included. An unfed `ownerId` is not the caller, so it denies for every role.
//   3. NO automation or bot principal connects, reads or sends (a second EFFECT_DENY), even on its own mailbox, even as platform_admin.
//   4. No permission arm: no perm_* rule, no derived role for this kind. A viewer, a client and every module tier reach nothing.
//   5. The bundles: company_admin, owner, platform_admin, manager, member hold all three keys; company_admin, manager, member as
//      self-scoped pairs; nobody else holds any.
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
const ACTIONS = ["connect", "read", "send"] as const;
const KEYS = ACTIONS.map((a) => `core.personal_mailbox.${a}`);

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

describe("DW-8j static pin — resource_personal_mailbox.yaml", () => {
  const rules = parseKind("resource_personal_mailbox.yaml");
  const allows = rules.filter((r) => r.effect === "EFFECT_ALLOW");
  const denies = rules.filter((r) => r.effect === "EFFECT_DENY");

  it("has exactly two ALLOW rules: the platform_admin wildcard and the SELF rule on member, manager and company_admin", () => {
    expect(allows.length).toBe(2);
    const wildcard = allows.find((r) => r.derivedRoles.includes("platform_admin"))!;
    expect(wildcard.actions).toEqual(["*"]);
    expect(wildcard.derivedRoles).toEqual(["platform_admin"]);
    const self = allows.find((r) => !r.derivedRoles.includes("platform_admin"))!;
    expect([...self.actions].sort()).toEqual([...ACTIONS].sort());
    expect([...self.derivedRoles].sort()).toEqual(["company_admin", "manager", "member"]);
    expect(self.condition).toBe(
      'variables.inTenant && variables.notLow && has(request.resource.attr.ownerId) && request.resource.attr.ownerId != "" && request.resource.attr.ownerId == request.principal.id',
    );
  });

  it("has exactly two EFFECT_DENY rules, both on roles [user] and every action: any non-owner (platform_admin included), and automation or bot", () => {
    expect(denies.length).toBe(2);
    for (const d of denies) {
      expect(d.roles).toEqual(["user"]);
      expect(d.derivedRoles).toEqual([]);
      expect(d.actions, "written as * so an action added later can never be left reachable through the platform_admin wildcard").toEqual(["*"]);
    }
    const notOwner = denies.find((d) => d.condition.includes("ownerId"))!;
    expect(notOwner.condition).toBe(
      '!(has(request.resource.attr.ownerId) && request.resource.attr.ownerId != "" && request.resource.attr.ownerId == request.principal.id)',
    );
    const agents = denies.find((d) => d.condition.includes("principal.attr.kind"))!;
    expect(agents.condition).toBe('has(request.principal.attr.kind) && request.principal.attr.kind in ["automation", "bot"]');
  });

  it("has NO permission arm: no perm_* rule, no derived role for this kind, and no viewer, client, org_unit_lead or module tier named anywhere", () => {
    for (const r of rules) {
      for (const d of r.derivedRoles) {
        expect(d.startsWith("perm_"), `${d} is a permission-arm role`).toBe(false);
        expect(["viewer", "client", "org_unit_lead", "hr_staff", "hr_manager", "module_staff", "module_manager"]).not.toContain(d);
      }
      expect(r.roles.filter((x) => x !== "user")).toEqual([]);
    }
    const derived = readFileSync(join(POLICIES_DIR, "derived_roles.yaml"), "utf8");
    expect(derived).not.toContain("perm_personal_mailbox");
  });

  it("ownerId is already in the Resource type and the resourcePayload() allow-list (cerbos.ts needs no change), defaulting to empty", () => {
    const src = readFileSync(join(__dirname, "cerbos.ts"), "utf8");
    expect(src).toContain("ownerId?: string;");
    expect(src).toContain('ownerId: r.ownerId ?? ""');
  });

  it("the platform_admin parity sweep names its probe as the owner (ownerId and the principal are both u1), so the sweep still passes", () => {
    const sweep = readFileSync(join(__dirname, "..", "core", "authz-permissions.controller.test.ts"), "utf8");
    expect(sweep).toMatch(/"u1",\s*\n\s*\/\/ MON-00c/); // bundlePrincipal's user id
    expect(sweep).toContain('ownerId: "u1"'); // the sweep's probe
  });

  it("the bundle JSON: owner == company_admin == platform_admin == manager == member hold all three, self-scoped for company_admin, manager, member; nobody else holds any", () => {
    const doc = JSON.parse(readFileSync(join(__dirname, "role-permission-bundles.json"), "utf8")) as {
      roles: Record<string, string[]>;
      selfScoped: Record<string, string[]>;
    };
    const keys = (role: string) => doc.roles[role].filter((k) => k.startsWith("core.personal_mailbox.")).sort();
    for (const r of ["company_admin", "owner", "platform_admin", "manager", "member"]) expect(keys(r), r).toEqual([...KEYS].sort());
    for (const role of Object.keys(doc.roles)) {
      if (!["company_admin", "owner", "platform_admin", "manager", "member"].includes(role)) expect(keys(role), `${role} must hold no personal_mailbox key`).toEqual([]);
    }
    expect(keys("viewer")).toEqual([]);
    const marked = (role: string) => (doc.selfScoped[role] ?? []).filter((k) => k.startsWith("core.personal_mailbox.")).sort();
    for (const r of ["company_admin", "manager", "member"]) expect(marked(r), r).toEqual([...KEYS].sort());
    // the generator marks a pair from the rule shape: the wildcard and the rule-less owner are not marked (the deny makes them personal)
    for (const r of ["platform_admin", "owner", "viewer", "org_unit_lead"]) expect(marked(r), r).toEqual([]);
  });

  it("the catalog: three grantable, non-sensitive, UI-grantable core keys on the personal_mailbox kind", () => {
    const cat = JSON.parse(readFileSync(join(__dirname, "permission-catalog.json"), "utf8")) as {
      permissions?: Array<Record<string, unknown>>;
      keys?: Array<Record<string, unknown>>;
    };
    const all = (cat.permissions ?? cat.keys ?? []) as Array<Record<string, unknown>>;
    const mine = all.filter((p) => p.cerbosKind === "personal_mailbox");
    expect(mine.map((p) => p.key).sort()).toEqual([...KEYS].sort());
    for (const p of mine) expect(p).toMatchObject({ domain: "core", class: "grantable", sensitive: false, uiGrantable: true });
  });
});

// ─── B. LIVE matrix ───────────────────────────────────────────────────────────────────────────────────────────
const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const T1 = "aaaaaaaa-8888-0000-0000-0000000000a1";
const T2 = "aaaaaaaa-8888-0000-0000-0000000000a2";
const ME = "u-me";
const OTHER = "u-other";

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

const mailbox = (ownerId: string | undefined, tenantId = T1): Resource => ({ kind: "personal_mailbox", tenantId, ...(ownerId !== undefined ? { ownerId } : {}) });
const own = (tenantId = T1) => mailbox(ME, tenantId);
const theirs = () => mailbox(OTHER);
const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;

type Cell = Record<(typeof ACTIONS)[number], boolean>;
const NONE: Cell = { connect: false, read: false, send: false };
const ALL: Cell = { connect: true, read: true, send: true };

describe.skipIf(!live)("DW-8j Cerbos matrix — personal_mailbox (role x owner)", () => {
  const table: Array<[string, Principal, Resource, Cell]> = [
    // the owner, by role
    ["member @T1, own mailbox: all three", principal([co("member")]), own(), ALL],
    ["manager @T1, own mailbox: all three", principal([co("manager")]), own(), ALL],
    ["company_admin @T1, own mailbox: all three", principal([co("company_admin")]), own(), ALL],
    ["platform_admin (global), own mailbox: all three", principal([glob("platform_admin")]), own(), ALL],
    ["viewer @T1, own mailbox: nothing (a read-only seat)", principal([co("viewer")]), own(), NONE],
    ["client @T1, own mailbox: nothing", principal([co("client")]), own(), NONE],
    ["a webdev_manager @T1 (a module tier), own mailbox: nothing", principal([co("webdev_manager")]), own(), NONE],
    ["an org_unit_lead @T1, own mailbox: nothing", principal([co("org_unit_lead")]), own(), NONE],
    ["no grants at all, own mailbox: nothing", principal([]), own(), NONE],
    // NOBODY reaches someone else's mailbox, whatever they hold
    ["member @T1, someone else's mailbox: nothing", principal([co("member")]), theirs(), NONE],
    ["manager @T1, someone else's mailbox: nothing", principal([co("manager")]), theirs(), NONE],
    ["company_admin @T1, someone else's mailbox: nothing (no role reads another person's mail)", principal([co("company_admin")]), theirs(), NONE],
    ["platform_admin (global), someone else's mailbox: nothing (the DENY beats the wildcard)", principal([glob("platform_admin")]), theirs(), NONE],
    ["company_admin AND platform_admin together, someone else's mailbox: nothing", principal([co("company_admin"), glob("platform_admin")]), theirs(), NONE],
    // an UNFED resource fails closed: an unnamed owner is not the caller
    ["member @T1, an UNFED mailbox (no ownerId sent): nothing", principal([co("member")]), mailbox(undefined), NONE],
    ["company_admin @T1, an UNFED mailbox: nothing", principal([co("company_admin")]), mailbox(undefined), NONE],
    ["platform_admin, an UNFED mailbox: nothing (the sweep probe must name its owner)", principal([glob("platform_admin")]), mailbox(undefined), NONE],
    ["member @T1, an empty-string owner: nothing", principal([co("member")]), mailbox(""), NONE],
    // the boundary
    ["company_admin of T2 only, own mailbox probed in T1 (cross-tenant)", principal([co("company_admin", T2)], { companies: [T2] }), own(), NONE],
    ["member @T1 at LOW assurance, own mailbox: nothing", principal([co("member")], { assurance: "low" }), own(), NONE],
    ["company_admin @T1 at LOW assurance, own mailbox: nothing", principal([co("company_admin")], { assurance: "low" }), own(), NONE],
    // the agent DENY: even on its own mailbox, even with every role
    ["a BOT holding member, own mailbox: nothing", principal([co("member")], { kind: "bot" }), own(), NONE],
    ["a BOT holding manager, own mailbox: nothing", principal([co("manager")], { kind: "bot" }), own(), NONE],
    ["an AUTOMATION principal holding company_admin, own mailbox: nothing", principal([co("company_admin")], { kind: "automation" }), own(), NONE],
    ["platform_admin that is a bot, own mailbox: nothing (the DENY beats the wildcard)", principal([glob("platform_admin")], { kind: "bot" }), own(), NONE],
    ["an employee-kind principal is unaffected by the agent DENY", principal([co("member")], { kind: "employee" }), own(), ALL],
  ];

  for (const [label, p, r, expected] of table) {
    it(`${label}`, async () => {
      for (const action of ACTIONS) {
        expect(await allow(p, r, action), `${label}: personal_mailbox · ${action}`).toBe(expected[action]);
      }
    });
  }

  it("an unlisted action is a deny on ANOTHER person's mailbox for everyone, platform_admin included (the non-owner deny is written as *)", async () => {
    for (const a of ["delete", "approve", "export", "read_all"]) {
      expect(await allow(principal([co("company_admin")]), own(), a), a).toBe(false);
      expect(await allow(principal([glob("platform_admin")]), theirs(), a), a).toBe(false);
      // On its OWN mailbox the house platform_admin wildcard still answers an unlisted action; no route asks one, and the
      // owner-only deny is about other people's mail, which is the rule that matters (CI found the earlier expectation).
    }
  });

  it("the owner id is compared as an exact string: another person whose id merely contains or prefixes the owner's gets nothing", async () => {
    for (const other of ["u-me-2", "U-ME", "u-m", " u-me", "u-me "]) {
      expect(await allow(principal([co("company_admin")], { userId: other }), own(), "read"), JSON.stringify(other)).toBe(false);
    }
  });
});

describe.skipIf(!live)("DW-8j Cerbos matrix — personal_mailbox, the permission arm does not exist (roles: [])", () => {
  const permP = (key: string, opts: { kind?: string } = {}) =>
    principal([], { perms: [{ key, scopeType: "company", scopeId: T1 }], ...opts });

  it("holding a personal_mailbox permission ALONE (no role) allows nothing: there is no perm_* mirror", async () => {
    for (const key of KEYS) {
      for (const action of ACTIONS) expect(await allow(permP(key), own(), action), `${key} -> ${action}`).toBe(false);
    }
  });

  it("a permission-native OWNER (the bundle's keys, zero rules) reaches nothing through Cerbos unless it also holds company_admin, manager or member", async () => {
    const bundles = JSON.parse(readFileSync(join(__dirname, "role-permission-bundles.json"), "utf8")) as { roles: Record<string, string[]> };
    const ownerP = principal([co("owner")], { perms: bundles.roles.owner.map((key) => ({ key, scopeType: "company" as const, scopeId: T1 })) });
    for (const action of ACTIONS) expect(await allow(ownerP, own(), action), `owner · ${action}`).toBe(false);
    const ownerAndMember = principal([co("owner"), co("member")]);
    for (const action of ACTIONS) expect(await allow(ownerAndMember, own(), action), `owner+member · ${action}`).toBe(true);
  });
});
