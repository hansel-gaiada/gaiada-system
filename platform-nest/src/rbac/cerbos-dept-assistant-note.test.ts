// AIP-23b (docs/PERMISSION-CONTRACT.md §59, docs/FRONTEND-BFF-CONTRACT.md §67; plan docs/plans/2026-10-31-aip-23-department-notes.md §4.2 and §4.8;
// owner rulings AIP-D20 to AIP-D24) — Cerbos matrix for the NEW core `dept_assistant_note` kind.
//
// THE CLAIMS UNDER TEST
//   1. read and propose: staff whose HOME placement is the note's unit or inside its subtree (`unitNodeId in homeAncestors`, one rule per action
//      over the scope roles). read for company_admin, manager, member, viewer; propose not for viewer. A person placed in a sibling unit, or ABOVE
//      the unit (the root), is not in the department.
//   2. withdraw: the author only (`proposedBy == principal.id`), wherever they now work; self-scoped.
//   3. read, decide, delete, pin: the `org_unit_lead` of the unit or of an enclosing unit (its own rule per action, over `unitAncestors`), and the GM
//      (the seat `dept_note_gm_seat` over `gmIds`, its own rule per action) in every department of the company. A head is no proposer unless placed
//      in the unit.
//   4. manage: the OWNER ONLY (OWNER_EXTENSION + the one mirror) and the superadmin (wildcard). company_admin is not an approver (AIP-D21).
//   5. THE TENANT TRAP: every rule keeps `inTenant`; another company's head (same node id) and GM reach nothing.
//   6. EFFECT_DENY on every action for automation, bot, contributor and client accounts (beats the wildcard, the lead rule and the mirror).
//   7. Low assurance: nothing. An unfed resource fails closed for the home, author, head and GM rules.
//
// Two layers:
//   A. STATIC (always runs): re-parses cerbos/policies/*.yaml and the JSON artifacts and pins the structure.
//   B. LIVE (needs CERBOS_URL): the decision matrix against the real engine loaded with the CURRENT policy files (restart `gaiada-test-cerbos`
//      after the policy edit; a skip is not a pass).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { check, type Resource } from "./cerbos";
import type { Principal, RoleGrant, PermissionGrant } from "./principal";
import { OWNER_EXTENSION } from "../../scripts/generate-role-bundles.mjs";

const POLICIES_DIR = join(__dirname, "../../cerbos/policies");
const ACTIONS = ["read", "propose", "withdraw", "decide", "delete", "pin", "manage"] as const;
type Action = (typeof ACTIONS)[number];
const KEY = (a: Action) => `core.dept_assistant_note.${a}`;

interface ParsedRule {
  actions: string[];
  effect: string;
  derivedRoles: string[];
  roles: string[];
  condition: string;
}
function parseKind(): ParsedRule[] {
  const text = readFileSync(join(POLICIES_DIR, "resource_dept_assistant_note.yaml"), "utf8");
  const docs = (yaml.loadAll(text) as any[]).filter((d) => d?.resourcePolicy);
  expect(docs.length).toBe(1);
  expect(docs[0].resourcePolicy.resource).toBe("dept_assistant_note");
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

const GATE = "variables.inTenant && variables.notLow";
const HOME_COND =
  'variables.inTenant && variables.notLow && has(request.resource.attr.unitNodeId) && request.resource.attr.unitNodeId != "" && ' +
  "has(request.resource.attr.homeAncestors) && request.resource.attr.unitNodeId in request.resource.attr.homeAncestors";
const AUTHOR_COND =
  'variables.inTenant && variables.notLow && has(request.resource.attr.proposedBy) && request.resource.attr.proposedBy != "" && ' +
  "request.resource.attr.proposedBy == request.principal.id";

describe("AIP-23b static pin — resource_dept_assistant_note.yaml", () => {
  const rules = parseKind();
  const roleExprs = derivedRoleExprs();
  const allows = rules.filter((r) => r.effect === "EFFECT_ALLOW");
  const rulesFor = (role: string) => allows.filter((r) => r.derivedRoles.includes(role));

  it("the roles named are exactly the wildcard, the four scope roles, the lead, the GM seat and the manage mirror", () => {
    const named = new Set(allows.flatMap((r) => r.derivedRoles));
    expect([...named].sort()).toEqual([
      "company_admin", "dept_note_gm_seat", "manager", "member", "org_unit_lead", "perm_dept_assistant_note_manage", "platform_admin", "viewer",
    ]);
    for (const r of rules) for (const role of ["owner", "hr_people_reader", "client", "it_staff", "module_staff", "module_manager"]) expect(r.derivedRoles).not.toContain(role);
  });

  it("platform_admin holds '*' alone, with no condition", () => {
    const pa = rulesFor("platform_admin");
    expect(pa.length).toBe(1);
    expect(pa[0]).toMatchObject({ actions: ["*"], derivedRoles: ["platform_admin"], condition: "" });
  });

  it("read by HOME placement: ONE rule for company_admin, manager, member, viewer, with the containment written inline", () => {
    const home = allows.filter((r) => r.condition.includes("homeAncestors"));
    const read = home.filter((r) => r.actions.includes("read"));
    expect(read.length).toBe(1);
    expect(read[0].actions).toEqual(["read"]);
    expect([...read[0].derivedRoles].sort()).toEqual(["company_admin", "manager", "member", "viewer"]);
    expect(read[0].condition).toBe(HOME_COND);
  });

  it("propose by HOME placement: ONE rule for company_admin, manager, member (NOT viewer), the same condition", () => {
    const prop = allows.filter((r) => r.actions.includes("propose") && !r.derivedRoles.includes("platform_admin"));
    expect(prop.length).toBe(1);
    expect(prop[0].actions).toEqual(["propose"]);
    expect([...prop[0].derivedRoles].sort()).toEqual(["company_admin", "manager", "member"]);
    expect(prop[0].condition).toBe(HOME_COND);
  });

  it("withdraw: ONE author rule (self-scoped, inline `proposedBy == principal.id`) for the four scope roles; nobody else", () => {
    const w = allows.filter((r) => r.actions.includes("withdraw") && !r.derivedRoles.includes("platform_admin"));
    expect(w.length).toBe(1);
    expect(w[0].actions).toEqual(["withdraw"]);
    expect([...w[0].derivedRoles].sort()).toEqual(["company_admin", "manager", "member", "viewer"]);
    expect(w[0].condition).toBe(AUTHOR_COND);
    expect(w[0].condition).toMatch(/request\.resource\.attr\.\w+\s*==\s*request\.principal\.id/); // the generator's self-scope predicate
  });

  it("the scope roles hold read, propose and withdraw ONLY (company_admin is not an approver: AIP-D21)", () => {
    for (const role of ["company_admin", "manager", "member"]) {
      expect([...new Set(rulesFor(role).flatMap((r) => r.actions))].sort(), role).toEqual(["propose", "read", "withdraw"]);
    }
    expect([...new Set(rulesFor("viewer").flatMap((r) => r.actions))].sort()).toEqual(["read", "withdraw"]);
  });

  it("the head: org_unit_lead ALONE in its own rule per action (read, decide, delete, pin), inTenant && notLow; never propose, withdraw or manage", () => {
    const heads = rulesFor("org_unit_lead");
    expect(heads.length).toBe(4);
    for (const a of ["read", "decide", "delete", "pin"]) {
      const h = heads.filter((r) => r.actions.includes(a));
      expect(h.length, a).toBe(1);
      expect(h[0].derivedRoles).toEqual(["org_unit_lead"]);
      expect(h[0].actions).toEqual([a]);
      expect(h[0].condition).toBe(GATE);
    }
  });

  it("the GM seat: its own rule per action (read, decide, delete, pin), inTenant && notLow; the derived role reads gmIds in the ai_usage_gm_seat shape", () => {
    const gm = rulesFor("dept_note_gm_seat");
    expect(gm.length).toBe(4);
    for (const a of ["read", "decide", "delete", "pin"]) {
      const g = gm.filter((r) => r.actions.includes(a));
      expect(g.length, a).toBe(1);
      expect(g[0]).toMatchObject({ actions: [a], derivedRoles: ["dept_note_gm_seat"], condition: GATE });
    }
    const expr = roleExprs.get("dept_note_gm_seat")!;
    expect(expr).toBe("has(request.resource.attr.gmIds) && request.resource.attr.gmIds.exists(id, id == request.principal.id)");
    expect(expr).toBe(roleExprs.get("ai_usage_gm_seat"));
    expect(expr).not.toMatch(/g\.role\s*==/);
  });

  it("manage is named by NO role rule: only the wildcard and the mirror reach it", () => {
    const m = allows.filter((r) => r.actions.includes("manage"));
    expect(m.length).toBe(1);
    expect(m[0].derivedRoles).toEqual(["perm_dept_assistant_note_manage"]);
  });

  it("every ALLOW but the wildcard keeps inTenant and notLow", () => {
    for (const r of allows.filter((x) => !x.derivedRoles.includes("platform_admin"))) {
      expect(r.condition, JSON.stringify(r)).toContain("variables.inTenant");
      expect(r.condition).toContain("variables.notLow");
    }
  });

  it("one EFFECT_DENY, on roles [user]: EVERY action, listed (not '*'), for automation, bot, contributor and client accounts", () => {
    const denies = rules.filter((r) => r.effect === "EFFECT_DENY");
    expect(denies.length).toBe(1);
    expect(denies[0].roles).toEqual(["user"]);
    expect([...denies[0].actions].sort()).toEqual([...ACTIONS].sort());
    expect(denies[0].condition).toBe(
      'has(request.principal.attr.kind) && request.principal.attr.kind in ["automation", "bot", "contributor", "client"]',
    );
  });

  it("the permission arm: ONE mirror, manage, under inTenant && notLow && inRoot; no mirror for any other action", () => {
    const mirrors = allows.filter((r) => r.derivedRoles.some((d) => d.startsWith("perm_")));
    expect(mirrors.length).toBe(1);
    expect(mirrors[0]).toMatchObject({ actions: ["manage"], derivedRoles: ["perm_dept_assistant_note_manage"], condition: `${GATE} && variables.inRoot` });
    const expr = roleExprs.get("perm_dept_assistant_note_manage")!;
    expect(expr).toContain('g.key == "core.dept_assistant_note.manage"');
    expect(expr).toContain('g.scopeType == "global"');
    expect(expr).toContain('(g.scopeType == "company" && g.scopeId == request.resource.attr.tenantId)');
    for (const a of ACTIONS.filter((x) => x !== "manage")) expect(roleExprs.has(`perm_dept_assistant_note_${a}`), a).toBe(false);
  });

  it("the attributes reach the policy: Resource type AND the resourcePayload() allow-list carry homeAncestors, proposedBy, unitNodeId, unitAncestors, gmIds", () => {
    const src = readFileSync(join(__dirname, "cerbos.ts"), "utf8");
    for (const t of ["homeAncestors?: string[];", "proposedBy?: string;", "unitNodeId?: string;", "unitAncestors?: string[];", "gmIds?: string[];"]) expect(src).toContain(t);
    for (const p of [
      "homeAncestors: r.homeAncestors ?? []", 'proposedBy: r.proposedBy ?? ""', 'unitNodeId: r.unitNodeId ?? ""',
      "unitAncestors: r.unitAncestors ?? []", "gmIds: r.gmIds ?? []",
    ]) expect(src).toContain(p);
  });

  it("the bundle JSON: exactly the holders the policy names; owner == company_admin's three + manage; withdraw self-scoped for the four scope roles", () => {
    const doc = JSON.parse(readFileSync(join(__dirname, "role-permission-bundles.json"), "utf8")) as {
      roles: Record<string, string[]>;
      selfScoped: Record<string, string[]>;
    };
    const keys = (role: string) => (doc.roles[role] ?? []).filter((k) => k.startsWith("core.dept_assistant_note.")).sort();
    expect(keys("platform_admin")).toEqual(ACTIONS.map(KEY).sort());
    for (const role of ["company_admin", "manager", "member"]) expect(keys(role), role).toEqual([KEY("propose"), KEY("read"), KEY("withdraw")]);
    expect(keys("viewer")).toEqual([KEY("read"), KEY("withdraw")]);
    expect(keys("org_unit_lead")).toEqual([KEY("decide"), KEY("delete"), KEY("pin"), KEY("read")]);
    expect(keys("owner")).toEqual([KEY("manage"), KEY("propose"), KEY("read"), KEY("withdraw")]);
    const named = ["platform_admin", "company_admin", "owner", "manager", "member", "viewer", "org_unit_lead"];
    for (const role of Object.keys(doc.roles)) if (!named.includes(role)) expect(keys(role), role).toEqual([]);
    const marked = Object.entries(doc.selfScoped ?? {})
      .flatMap(([role, ks]) => ks.filter((k) => k.startsWith("core.dept_assistant_note.")).map((k) => `${role} ${k}`))
      .sort();
    expect(marked).toEqual(["company_admin", "manager", "member", "viewer"].map((r) => `${r} ${KEY("withdraw")}`));
    expect(Object.keys(doc.roles).filter((r) => doc.roles[r].includes(KEY("manage"))).sort()).toEqual(["owner", "platform_admin"]);
  });

  it("OWNER_EXTENSION carries manage and no other key of the kind; manage is not in company_admin's bundle", () => {
    expect(OWNER_EXTENSION).toContain(KEY("manage"));
    for (const a of ACTIONS.filter((x) => x !== "manage")) expect(OWNER_EXTENSION).not.toContain(KEY(a));
    const doc = JSON.parse(readFileSync(join(__dirname, "role-permission-bundles.json"), "utf8")) as { roles: Record<string, string[]> };
    expect(doc.roles.company_admin).not.toContain(KEY("manage"));
  });

  it("DIRECT maps dept_note_gm_seat to no real role, byte-aligned across the generator and the parity suite", () => {
    const gen = readFileSync(join(__dirname, "../../scripts/generate-role-bundles.mjs"), "utf8");
    const parity = readFileSync(join(__dirname, "role-permission-parity.db.test.ts"), "utf8");
    expect(gen).toContain("dept_note_gm_seat: [],");
    expect(parity).toContain("dept_note_gm_seat: [],");
  });

  it("the catalog: seven grantable, non-sensitive keys in domain core; manage uiGrantable false, the rest true", () => {
    const cat = JSON.parse(readFileSync(join(__dirname, "permission-catalog.json"), "utf8")) as { permissions: any[] };
    const mine = cat.permissions.filter((p) => p.cerbosKind === "dept_assistant_note");
    expect(mine.map((p) => p.key).sort()).toEqual(ACTIONS.map(KEY).sort());
    for (const p of mine) {
      expect(p).toMatchObject({ domain: "core", resource: "dept_assistant_note", class: "grantable", sensitive: false });
      expect(p.cerbosAction).toBe(p.action);
      expect(p.uiGrantable, p.key).toBe(p.action !== "manage");
    }
    const groups = JSON.parse(readFileSync(join(__dirname, "permission-groups.json"), "utf8")) as { groups: Array<{ key: string; permissions: string[]; sensitive: boolean }> };
    const g = groups.groups.find((x) => x.key === "assistant_dept_notes");
    expect(g?.permissions.slice().sort()).toEqual(ACTIONS.map(KEY).sort());
    expect(g?.sensitive).toBe(false);
  });

  it("the IAM migration seeds what the bundle JSON says (the 26 pairs, by role) and marks exactly the JSON's self-scoped pairs", () => {
    const sql = readFileSync(join(__dirname, "../../migrations/202610311710_iam_dept_assistant_note_permissions.sql"), "utf8");
    const doc = JSON.parse(readFileSync(join(__dirname, "role-permission-bundles.json"), "utf8")) as {
      roles: Record<string, string[]>;
      selfScoped: Record<string, string[]>;
    };
    const block = sql.slice(sql.indexOf("INSERT INTO role_permissions"), sql.indexOf(") AS bundle(role_name, perm_key, self_scoped)"));
    const rows = [...block.matchAll(/\('([a-z_]+)', '(core\.dept_assistant_note\.[a-z_]+)', (true|false)\)/g)];
    const pairs = rows.map((m) => `${m[1]} ${m[2]}`).sort();
    const want = Object.entries(doc.roles).flatMap(([r, ks]) => ks.filter((k) => k.startsWith("core.dept_assistant_note.")).map((k) => `${r} ${k}`)).sort();
    expect(pairs).toEqual(want);
    expect(pairs.length).toBe(26);
    const markedSql = rows.filter((m) => m[3] === "true").map((m) => `${m[1]} ${m[2]}`).sort();
    const markedJson = Object.entries(doc.selfScoped).flatMap(([r, ks]) => ks.filter((k) => k.startsWith("core.dept_assistant_note.")).map((k) => `${r} ${k}`)).sort();
    expect(markedSql).toEqual(markedJson);
    expect(sql).not.toMatch(/\r/);
  });
});

// ─── B. LIVE matrix ───────────────────────────────────────────────────────────────────────────────────────────
const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const T1 = "aaaaaaaa-9999-0000-0000-0000000000c1";
const T2 = "aaaaaaaa-9999-0000-0000-0000000000c2";
const ME = "u-me";
const GM = "u-gm";
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
// DW-10g-2 Part B: an org_unit_lead grant carries the companies whose own lead seat backs it.
const unitGrant = (unit: string, tenantIds: string[] = [T1]): RoleGrant => ({ role: "org_unit_lead", scopeType: "org_unit", scopeId: unit, tenantIds });

// The tree: d-corp (root) > d-web > dv-fe; d-corp > d-seo; d-corp > d-gm. The closure is self-inclusive, nearest first.
const WEB = ["d-web", "d-corp"];
const FE = ["dv-fe", "d-web", "d-corp"];
const SEO = ["d-seo", "d-corp"];
const GMU = ["d-gm", "d-corp"];
const ROOT = ["d-corp"];
/** A note of d-web (or the department as a whole) as the handler builds it: the route's unit, its ancestry, the caller's home ancestry, the GM. */
const webNote = (home: string[], extra: Partial<Resource> = {}, tenantId = T1): Resource => ({
  kind: "dept_assistant_note", tenantId, unitNodeId: "d-web", unitAncestors: WEB, homeAncestors: home, gmIds: [GM], proposedBy: OTHER, ...extra,
});
const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;

type Cell = Record<Action, boolean>;
const NONE: Cell = { read: false, propose: false, withdraw: false, decide: false, delete: false, pin: false, manage: false };
const cell = (...on: Action[]): Cell => ({ ...NONE, ...Object.fromEntries(on.map((a) => [a, true])) });
const ALL = cell(...ACTIONS);
const MEMBER = cell("read", "propose");
const APPROVER = cell("read", "decide", "delete", "pin");

function ownerPrincipal(opts: { assurance?: Principal["assurance"]; kind?: string; tenant?: string; userId?: string } = {}): Principal {
  const bundles = JSON.parse(readFileSync(join(__dirname, "role-permission-bundles.json"), "utf8")) as { roles: Record<string, string[]> };
  const t = opts.tenant ?? T1;
  return principal([co("owner", t)], {
    companies: [t],
    assurance: opts.assurance,
    kind: opts.kind,
    userId: opts.userId,
    perms: bundles.roles.owner.map((key) => ({ key, scopeType: "company" as const, scopeId: t })),
  });
}

describe.skipIf(!live)("AIP-23b Cerbos matrix — dept_assistant_note (principal x action)", () => {
  const table: Array<[string, Principal, Resource, Cell]> = [
    // the superadmin and the owner
    ["platform_admin (global)", principal([glob("platform_admin")]), webNote([]), ALL],
    ["owner with its LIVE bundle (permission-native), not placed in the unit: manage only (the handler maps it to every per-unit route)", ownerPrincipal(), webNote([]), cell("manage")],
    ["owner with its LIVE bundle, placed IN the unit: still manage only (no role rule names the owner)", ownerPrincipal(), webNote(WEB), cell("manage")],
    ["owner of T2 only, a T1 note", ownerPrincipal({ tenant: T2 }), webNote([]), NONE],
    // the people of the department (home placement)
    ["member placed in the unit", principal([co("member")]), webNote(WEB), MEMBER],
    ["member placed in a CHILD unit (dv-fe)", principal([co("member")]), webNote(FE), MEMBER],
    ["member placed in a SIBLING unit (d-seo)", principal([co("member")]), webNote(SEO), NONE],
    ["member placed ABOVE the unit (the root): not in the department", principal([co("member")]), webNote(ROOT), NONE],
    ["member with NO placement", principal([co("member")]), webNote([]), NONE],
    ["manager placed in the unit", principal([co("manager")]), webNote(WEB), MEMBER],
    ["viewer placed in the unit: reads, never suggests", principal([co("viewer")]), webNote(WEB), cell("read")],
    ["company_admin placed in the unit: a colleague like any other", principal([co("company_admin")]), webNote(WEB), MEMBER],
    ["company_admin of ANOTHER department (placed in d-seo): nothing (not an approver, AIP-D21)", principal([co("company_admin")]), webNote(SEO), NONE],
    ["company_admin with no placement", principal([co("company_admin")]), webNote([]), NONE],
    ["member placed in the unit, a T2 note with the SAME node ids", principal([co("member")]), webNote(WEB, {}, T2), NONE],
    // heads
    ["head of the unit (+ member + manager, placed there): suggests and approves", principal([co("member"), co("manager"), unitGrant("d-web")]), webNote(WEB), cell("read", "propose", "decide", "delete", "pin")],
    ["head of the unit as org_unit_lead ALONE", principal([unitGrant("d-web")]), webNote([]), APPROVER],
    ["head of the ENCLOSING unit d-corp (+ member, placed at the root): approves, does not suggest", principal([co("member"), unitGrant("d-corp")]), webNote(ROOT), APPROVER],
    ["head of a unit BELOW (dv-fe, placed there): nothing on d-web", principal([co("member"), unitGrant("dv-fe")]), webNote(FE), MEMBER],
    ["head of the SIBLING d-seo (+ member, placed there)", principal([co("member"), unitGrant("d-seo")]), webNote(SEO), NONE],
    ["head of d-web whose companies are [T1], T2's d-web with the SAME node ids", principal([co("member"), unitGrant("d-web")]), webNote(WEB, {}, T2), NONE],
    ["head of T2's d-web (seat in T2), member of T1 and T2, T1's d-web (not placed in T1)", principal([co("member"), unitGrant("d-web", [T2])], { companies: [T1, T2] }), webNote([]), NONE],
    ["another company's head (companies [T2]) on a T1 note", principal([co("member", T2), unitGrant("d-web", [T2])], { companies: [T2] }), webNote([]), NONE],
    // the GM seat
    ["the GM (+ member, placed in d-gm): approves in every department, does not suggest outside its own", principal([co("member")], { userId: GM }), webNote(GMU), APPROVER],
    ["the GM ALONE (no scope role)", principal([], { userId: GM }), webNote([]), APPROVER],
    ["the GM on an UNFED resource (gmIds not sent)", principal([co("member")], { userId: GM }), webNote(GMU, { gmIds: undefined }), NONE],
    ["a GM of ANOTHER company (companies [T2]) whose id is in T1's list", principal([co("member", T2)], { userId: GM, companies: [T2] }), webNote([]), NONE],
    ["the GM of T1 on T2's note listing other seats", principal([co("member")], { userId: GM }), webNote(GMU, { gmIds: ["u-other-gm"] }, T2), NONE],
    // nobody else
    ["hr_staff placed in the unit (the HR read tier, no staff role)", principal([co("hr_staff")]), webNote(WEB), NONE],
    ["webdev_manager placed in the unit (a module tier, no staff role)", principal([co("webdev_manager")]), webNote(WEB), NONE],
    ["a client-only principal (the client role)", principal([co("client")]), webNote(WEB), NONE],
    ["no grants at all", principal([]), webNote(WEB), NONE],
    // the DENY: automation, bots, contributors, client accounts reach nothing, whatever they hold
    ["a BOT member placed in the unit", principal([co("member")], { kind: "bot" }), webNote(WEB), NONE],
    ["an AUTOMATION member placed in the unit", principal([co("member")], { kind: "automation" }), webNote(WEB), NONE],
    ["a CONTRIBUTOR holding member, placed in the unit", principal([co("member")], { kind: "contributor" }), webNote(WEB), NONE],
    ["a CLIENT account holding member, placed in the unit", principal([co("member")], { kind: "client" }), webNote(WEB), NONE],
    ["a BOT head of d-web", principal([co("member"), unitGrant("d-web")], { kind: "bot" }), webNote(WEB), NONE],
    ["a BOT GM", principal([co("member")], { userId: GM, kind: "bot" }), webNote(GMU), NONE],
    ["a BOT owner", ownerPrincipal({ kind: "bot" }), webNote([]), NONE],
    ["a BOT platform_admin: the DENY beats the wildcard", principal([glob("platform_admin")], { kind: "bot" }), webNote([]), NONE],
    ["an AUTOMATION platform_admin", principal([glob("platform_admin")], { kind: "automation" }), webNote([]), NONE],
    ["an employee-kind member is unaffected by the DENY", principal([co("member")], { kind: "employee" }), webNote(WEB), MEMBER],
    // low assurance
    ["member placed in the unit at LOW assurance", principal([co("member")], { assurance: "low" }), webNote(WEB), NONE],
    ["head of d-web at LOW assurance", principal([co("member"), unitGrant("d-web")], { assurance: "low" }), webNote(WEB), NONE],
    ["the GM at LOW assurance", principal([co("member")], { userId: GM, assurance: "low" }), webNote(GMU), NONE],
    ["owner at LOW assurance", ownerPrincipal({ assurance: "low" }), webNote([]), NONE],
  ];

  for (const [label, p, r, expected] of table) {
    it(label, async () => {
      for (const action of ACTIONS) {
        expect(await allow(p, r, action), `${label}: dept_assistant_note · ${action}`).toBe(expected[action]);
      }
    });
  }

  it("withdraw is the AUTHOR's: allowed on their own note wherever they now work (a member moved to d-seo, a viewer), refused on another's", async () => {
    const mine = { proposedBy: ME };
    expect(await allow(principal([co("member")]), webNote(WEB, mine), "withdraw")).toBe(true);
    expect(await allow(principal([co("member")]), webNote(SEO, mine), "withdraw"), "moved to a sibling unit").toBe(true);
    expect(await allow(principal([co("member")]), webNote([], mine), "withdraw"), "no placement at all").toBe(true);
    expect(await allow(principal([co("viewer")]), webNote(WEB, mine), "withdraw"), "a viewer now").toBe(true);
    expect(await allow(principal([co("company_admin")]), webNote(SEO, mine), "withdraw")).toBe(true);
    expect(await allow(principal([co("member")]), webNote(WEB), "withdraw"), "another's note").toBe(false);
    expect(await allow(principal([co("member"), unitGrant("d-web")]), webNote(WEB), "withdraw"), "a head, another's note").toBe(false);
    expect(await allow(principal([co("member")], { userId: GM }), webNote(GMU), "withdraw"), "the GM, another's note").toBe(false);
    expect(await allow(ownerPrincipal(), webNote([]), "withdraw"), "the owner, another's note").toBe(false);
    // fail closed on an unfed author (an erased author's note: an approver deletes it)
    expect(await allow(principal([co("member")]), webNote(WEB, { proposedBy: "" }), "withdraw")).toBe(false);
    expect(await allow(principal([co("member")]), webNote(WEB, { proposedBy: undefined }), "withdraw")).toBe(false);
    // the author in ANOTHER company: nothing (inTenant)
    expect(await allow(principal([co("member", T2)], { companies: [T2] }), webNote([], mine), "withdraw")).toBe(false);
    // the author at low assurance, or as a bot
    expect(await allow(principal([co("member")], { assurance: "low" }), webNote(WEB, mine), "withdraw")).toBe(false);
    expect(await allow(principal([co("member")], { kind: "bot" }), webNote(WEB, mine), "withdraw")).toBe(false);
  });

  it("the home rules need BOTH the unit and the home ancestry: an unfed unit, an unfed or empty home, or another branch denies", async () => {
    const m = principal([co("member")]);
    for (const a of ["read", "propose"]) {
      expect(await allow(m, webNote(WEB, { unitNodeId: "" }), a), `"" unit · ${a}`).toBe(false);
      expect(await allow(m, webNote(WEB, { unitNodeId: undefined }), a), `unfed unit · ${a}`).toBe(false);
      expect(await allow(m, webNote([]), a), `[] home · ${a}`).toBe(false);
      expect(await allow(m, webNote(WEB, { homeAncestors: undefined }), a), `unfed home · ${a}`).toBe(false);
      expect(await allow(m, webNote(SEO), a), `other branch · ${a}`).toBe(false);
      expect(await allow(m, webNote(WEB), a), `own unit · ${a}`).toBe(true);
    }
  });

  it("the head's rules need the ancestry: [] and an unfed list deny, another branch denies, the unit allows", async () => {
    const head = principal([unitGrant("d-web")]);
    for (const a of ["read", "decide", "delete", "pin"]) {
      expect(await allow(head, webNote([], { unitAncestors: [] }), a), `[] · ${a}`).toBe(false);
      expect(await allow(head, webNote([], { unitAncestors: undefined }), a), `unfed · ${a}`).toBe(false);
      expect(await allow(head, webNote([], { unitAncestors: SEO, unitNodeId: "d-seo" }), a), `other branch · ${a}`).toBe(false);
      expect(await allow(head, webNote([]), a), `own unit · ${a}`).toBe(true);
    }
  });

  it("an unlisted action is a deny (only platform_admin holds '*')", async () => {
    expect(await allow(ownerPrincipal(), webNote([]), "edit")).toBe(false);
    expect(await allow(principal([co("member"), unitGrant("d-web")]), webNote(WEB), "edit")).toBe(false);
    expect(await allow(principal([glob("platform_admin")]), webNote([]), "edit")).toBe(true);
  });
});

describe.skipIf(!live)("AIP-23b Cerbos matrix — dept_assistant_note, the permission arm (roles: [])", () => {
  const permP = (key: string, scopeType: "company" | "global" = "company", opts: { assurance?: Principal["assurance"]; kind?: string } = {}) =>
    principal([], { perms: [{ key, scopeType, scopeId: scopeType === "company" ? T1 : null }], ...opts });

  it("the manage key ALONE allows manage in every department and no sibling action; never cross-tenant or at low assurance", async () => {
    const k = KEY("manage");
    expect(await allow(permP(k), webNote([]), "manage")).toBe(true);
    expect(await allow(permP(k), webNote([], { unitNodeId: "d-seo", unitAncestors: SEO }), "manage")).toBe(true);
    expect(await allow(permP(k, "global"), webNote([]), "manage")).toBe(true);
    for (const other of ACTIONS.filter((x) => x !== "manage")) expect(await allow(permP(k), webNote(WEB), other), `manage -> ${other}`).toBe(false);
    expect(await allow(permP(k), webNote([], {}, T2), "manage")).toBe(false);
    expect(await allow(permP(k, "company", { assurance: "low" }), webNote([]), "manage")).toBe(false);
  });

  it("every other key ALONE allows NOTHING (no mirror: a holder would reach every department)", async () => {
    for (const a of ACTIONS.filter((x) => x !== "manage")) {
      expect(await allow(permP(KEY(a)), webNote(WEB, { proposedBy: ME }), a), a).toBe(false);
      expect(await allow(permP(KEY(a), "global"), webNote(WEB, { proposedBy: ME }), a), `${a} global`).toBe(false);
    }
  });

  it("a bot, a contributor or a client account holding the manage key is denied it (the DENY lists every action)", async () => {
    for (const kind of ["bot", "automation", "contributor", "client"]) {
      expect(await allow(permP(KEY("manage"), "company", { kind }), webNote([]), "manage"), kind).toBe(false);
    }
  });
});
