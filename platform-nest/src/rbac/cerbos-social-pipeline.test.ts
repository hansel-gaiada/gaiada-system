// SCP-1b (docs/PERMISSION-CONTRACT.md §53, §53.14) — the Social Media content pipeline's Cerbos proof.
//
// THE CLAIMS UNDER TEST
//   1. Eight new social_post actions: author, schedule (the officer, `member` + ownerId == principal.id, inline); proofread
//      (social_copywriter); approve (the four approvers: social_approver_seat, perm_social_post_approve, the wildcard);
//      design (the month request's assignee on a `creatives` post; social_designer on an `in_team` post); manage,
//      record_client, boost (the officer and the seats). `read` gains the two new roles.
//   2. social_engagement gains plan and budget (the four approvers), and `read` for the two roles.
//   3. social_report approve and deliver narrow to the four approvers; read gains a mirror.
//   4. portal gains approve_spend (client role arm + mirror).
//   5. Two DENY rules on roles ["user"]: maker/checker on proofread and approve (the author and the officer, even as owner or
//      platform_admin); unattended automations and bots on every new action, plan, budget, report approve and deliver. The
//      automation DENY names exactly ["automation", "bot"]: a `contributor` is a human and is NOT in it.
//   6. company_admin, manager, module_manager (social_manager) hold none of the approver actions or the eight; `client` is in
//      no social_* policy; the owner reaches exactly the five approver actions and report read, none of the team's steps.
//   7. The tenant trap: the seat list is per company, every ALLOW keeps inTenant, and an owner grant on another company does
//      not reach this one.
//
// Two layers:
//   A. STATIC (always runs): re-parses cerbos/policies/*.yaml, derived_roles.yaml, the catalog, the bundles, the generator.
//   B. LIVE (needs CERBOS_URL; CI has it, a skip is not a pass): the decision matrix against the real engine.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { check, type Resource } from "./cerbos";
import type { Principal, RoleGrant, PermissionGrant } from "./principal";
import { OWNER_EXTENSION } from "../../scripts/generate-role-bundles.mjs";
import scopeConstrainedRolesDoc from "./scope-constrained-roles.json";

const POLICIES_DIR = join(__dirname, "../../cerbos/policies");
const PIPELINE_ACTIONS = ["author", "proofread", "approve", "design", "schedule", "manage", "record_client", "boost"] as const;
const SELF_OR_ATTR_ACTIONS = ["author", "design", "schedule", "manage", "record_client", "boost"] as const;
const TEAM_STEPS = ["manage", "record_client", "boost"] as const;
/** The five approver-only (kind, action) pairs (§53.4). */
const APPROVER_ONLY: ReadonlyArray<[string, string]> = [
  ["social_post", "approve"], ["social_engagement", "plan"], ["social_engagement", "budget"],
  ["social_report", "approve"], ["social_report", "deliver"],
];

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
      if (expr) out.set(d.name, String(expr).replace(/\s+/g, " ").trim());
    }
  }
  return out;
}
const FILE_OF: Record<string, string> = {
  social_post: "resource_social_post.yaml",
  social_engagement: "resource_social_engagement.yaml",
  social_report: "resource_social_report.yaml",
  portal: "resource_portal.yaml",
};
const isWildcardAdmin = (r: ParsedRule) => r.actions.includes("*") && r.derivedRoles.length === 1 && r.derivedRoles[0] === "platform_admin";
/** Every role name an ALLOW rule names for `action` on `kind`, the wildcard included. */
function allowRoles(kind: string, action: string): Set<string> {
  const out = new Set<string>();
  for (const r of parseKind(FILE_OF[kind])) {
    if (r.effect !== "EFFECT_ALLOW") continue;
    if (!(r.actions.includes(action) || r.actions.includes("*"))) continue;
    for (const d of r.derivedRoles) out.add(d);
  }
  return out;
}

interface CatalogEntry { key: string; cerbosKind: string; cerbosAction: string; uiGrantable: boolean; sensitive: boolean; class: string }
const catalog = (JSON.parse(readFileSync(join(__dirname, "permission-catalog.json"), "utf8")) as { permissions: CatalogEntry[] }).permissions;
const bundles = JSON.parse(readFileSync(join(__dirname, "role-permission-bundles.json"), "utf8")) as {
  roles: Record<string, string[]>;
  selfScoped: Record<string, string[]>;
};

// ═══════════════════════════════════════════════ A. STATIC ═══════════════════════════════════════════════
describe("SCP-1b static pins — the content pipeline's policies (PERMISSION-CONTRACT §53.14)", () => {
  const roleExprs = derivedRoleExprs();

  it("the five approver-only actions name exactly social_approver_seat, their own perm_* mirror and the platform_admin wildcard", () => {
    for (const [kind, action] of APPROVER_ONLY) {
      expect([...allowRoles(kind, action)].sort(), `${kind} · ${action}`).toEqual(
        ["perm_" + kind + "_" + action, "platform_admin", "social_approver_seat"].sort(),
      );
      expect(roleExprs.has(`perm_${kind}_${action}`), `derived role perm_${kind}_${action}`).toBe(true);
    }
  });

  it("no perm_* rule for author, design, schedule, manage, record_client or boost; proofread and approve are mirrored", () => {
    const rules = parseKind(FILE_OF.social_post);
    for (const a of SELF_OR_ATTR_ACTIONS) {
      const perm = rules.filter((r) => r.actions.includes(a) && r.derivedRoles.some((d) => d.startsWith("perm_")));
      expect(perm, `social_post · ${a}`).toEqual([]);
      expect(roleExprs.has(`perm_social_post_${a}`), `perm_social_post_${a} must not exist`).toBe(false);
    }
    expect([...allowRoles("social_post", "proofread")].sort()).toEqual(["perm_social_post_proofread", "platform_admin", "social_copywriter"]);
  });

  it("each pipeline action's role arm is exactly what §53.2 names", () => {
    expect([...allowRoles("social_post", "author")].sort()).toEqual(["member", "platform_admin"]);
    expect([...allowRoles("social_post", "schedule")].sort()).toEqual(["member", "platform_admin"]);
    expect([...allowRoles("social_post", "design")].sort()).toEqual(["member", "platform_admin", "social_designer"]);
    for (const a of TEAM_STEPS) expect([...allowRoles("social_post", a)].sort(), a).toEqual(["member", "platform_admin", "social_approver_seat"]);
    expect([...allowRoles("portal", "approve_spend")].sort()).toEqual(["client", "perm_portal_approve_spend", "platform_admin"]);
    // read gains the two roles, in a scope-only rule of their own
    const readRule = parseKind(FILE_OF.social_post).find((r) => r.actions.join() === "read" && r.derivedRoles.includes("social_copywriter"));
    expect(readRule?.derivedRoles.sort()).toEqual(["social_copywriter", "social_designer"]);
    expect(readRule?.condition).toBe("variables.inTenant && variables.notLow");
    expect(allowRoles("social_engagement", "read").has("social_copywriter")).toBe(true);
    expect(allowRoles("social_engagement", "read").has("social_designer")).toBe(true);
  });

  it("the officer and designer relationship conditions are INLINE (no policy variable), and every designer rule tests creativeSource", () => {
    const rules = parseKind(FILE_OF.social_post).filter((r) => r.effect === "EFFECT_ALLOW" && r.actions.some((a) => (PIPELINE_ACTIONS as readonly string[]).includes(a)));
    const officer = rules.find((r) => r.actions.includes("author"))!;
    expect(officer.derivedRoles).toEqual(["member"]);
    expect(officer.condition).toContain('request.resource.attr.ownerId != ""');
    expect(officer.condition).toContain("request.resource.attr.ownerId == request.principal.id");
    for (const r of rules) expect(r.condition, JSON.stringify(r.actions)).not.toMatch(/variables\.(owns|local)/);
    const design = rules.filter((r) => r.actions.includes("design"));
    expect(design).toHaveLength(2);
    expect(design.find((r) => r.derivedRoles[0] === "member")!.condition).toContain('creativeSource == "creatives"');
    expect(design.find((r) => r.derivedRoles[0] === "member")!.condition).toContain("request.principal.id in request.resource.attr.assigneeIds");
    expect(design.find((r) => r.derivedRoles[0] === "social_designer")!.condition).toContain('creativeSource == "in_team"');
    // each attribute-dependent rule stands alone: one derived role per pipeline rule
    for (const r of rules) expect(r.derivedRoles.length, JSON.stringify(r)).toBe(1);
  });

  it("both DENY rules are present, on roles [\"user\"]; the automation DENY names exactly automation and bot (a contributor is human)", () => {
    const post = parseKind(FILE_OF.social_post).filter((r) => r.effect === "EFFECT_DENY");
    const maker = post.find((r) => r.actions.includes("proofread") && r.actions.includes("approve") && r.condition.includes("creatorId"));
    expect(maker, "maker/checker DENY").toBeDefined();
    expect(maker!.roles).toEqual(["user"]);
    expect(maker!.derivedRoles).toEqual([]);
    expect([...maker!.actions].sort()).toEqual(["approve", "proofread"]);
    expect(maker!.condition).toContain('request.resource.attr.creatorId != ""');
    expect(maker!.condition).toContain('request.resource.attr.ownerId != ""');
    const autoPost = post.find((r) => r.condition.includes("principal.attr.kind"));
    expect([...autoPost!.actions].sort()).toEqual([...PIPELINE_ACTIONS].sort());
    const autoEng = parseKind(FILE_OF.social_engagement).find((r) => r.effect === "EFFECT_DENY")!;
    expect([...autoEng.actions].sort()).toEqual(["budget", "plan"]);
    const autoRep = parseKind(FILE_OF.social_report).find((r) => r.effect === "EFFECT_DENY")!;
    expect([...autoRep.actions].sort()).toEqual(["approve", "deliver"]);
    for (const r of [autoPost!, autoEng, autoRep]) {
      expect(r.roles).toEqual(["user"]);
      expect(r.condition).toBe('has(request.principal.attr.kind) && request.principal.attr.kind in ["automation", "bot"]');
      expect(r.condition).not.toContain("contributor");
      expect(r.actions).not.toContain("read");
    }
  });

  it("every ALLOW keeps variables.inTenant (and notLow on the social kinds)", () => {
    for (const kind of ["social_post", "social_engagement", "social_report", "portal"]) {
      for (const r of parseKind(FILE_OF[kind])) {
        if (r.effect !== "EFFECT_ALLOW" || isWildcardAdmin(r)) continue;
        expect(r.condition, `${kind} ${JSON.stringify(r.actions)} ${r.derivedRoles}`).toContain("variables.inTenant");
        if (kind !== "portal") expect(r.condition, `${kind} ${JSON.stringify(r.actions)}`).toContain("variables.notLow");
      }
    }
  });

  it("company_admin, manager and module_manager are named in no rule of the eight actions, plan, budget, or report approve and deliver", () => {
    const targets: Array<[string, string]> = [
      ...PIPELINE_ACTIONS.map((a) => ["social_post", a] as [string, string]),
      ["social_engagement", "plan"], ["social_engagement", "budget"], ["social_report", "approve"], ["social_report", "deliver"],
    ];
    for (const [kind, action] of targets) {
      const named = allowRoles(kind, action);
      for (const forbidden of ["company_admin", "manager", "module_manager", "module_staff", "viewer", "org_unit_lead", "client"]) {
        expect(named.has(forbidden), `${kind} · ${action} must not name ${forbidden}`).toBe(false);
      }
    }
  });

  it("client is named in no social_* policy", () => {
    for (const file of ["resource_social_post.yaml", "resource_social_engagement.yaml", "resource_social_report.yaml",
      "resource_social_account.yaml", "resource_social_client_review.yaml", "resource_social_inbox.yaml",
      "resource_social_ledger.yaml", "resource_social_platform_app.yaml"]) {
      for (const r of parseKind(file)) {
        expect(r.derivedRoles, file).not.toContain("client");
        expect(r.roles, file).not.toContain("client");
      }
    }
  });

  // AIP-D5 holders (2026-10-29, §55.1) added a sixth key, assistant.brain.choose_provider, on the same four terms; the loop below
  // holds it to them too, and cerbos-assistant-brain.test.ts pins its own kind.
  // AIP-15 (2026-10-30, §58) added core.ai_usage.read_people and core.ai_usage.manage on the same four terms; cerbos-ai-usage.test.ts
  // pins their kind.
  it("the generator's OWNER_EXTENSION is exactly the five keys (+ AIP-D5's one, + AIP-15's two), each mirrored, uiGrantable:false and absent from company_admin's bundle", () => {
    expect([...OWNER_EXTENSION].sort()).toEqual([
      "assistant.brain.choose_provider",
      "core.ai_usage.manage", "core.ai_usage.read_people",
      "social.engagement.budget", "social.engagement.plan", "social.post.approve", "social.report.approve", "social.report.deliver",
    ]);
    for (const key of OWNER_EXTENSION) {
      const e = catalog.find((p) => p.key === key)!;
      expect(e, key).toBeDefined();
      expect(e.uiGrantable, key).toBe(false);
      expect(roleExprs.get(`perm_${e.cerbosKind}_${e.cerbosAction}`), `mirror of ${key}`).toContain(`g.key == "${key}"`);
      expect(bundles.roles.company_admin, key).not.toContain(key);
      expect(bundles.roles.owner, key).toContain(key);
      // held by no real role but the wildcard: platform_admin and the permission-native owner only
      const holders = Object.keys(bundles.roles).filter((r) => bundles.roles[r].includes(key)).sort();
      expect(holders, key).toEqual(["owner", "platform_admin"]);
    }
    expect(bundles.roles.owner).toEqual([...new Set([...bundles.roles.company_admin, ...OWNER_EXTENSION])].sort());
  });

  it("the bundles follow §53.11", () => {
    const social = (role: string) => (bundles.roles[role] ?? []).filter((k) => /^(social\.(post|engagement|report)\.|portal\.approve_spend)/.test(k));
    const newKeys = [...PIPELINE_ACTIONS.map((a) => `social.post.${a}`), "social.engagement.plan", "social.engagement.budget", "portal.approve_spend"];
    for (const k of newKeys) expect(bundles.roles.platform_admin, k).toContain(k);
    expect(bundles.roles.social_copywriter).toEqual(["social.engagement.read", "social.post.proofread", "social.post.read"]);
    expect(bundles.roles.social_designer).toEqual(["social.engagement.read", "social.post.design", "social.post.read"]);
    expect((bundles.selfScoped.member ?? []).filter((k) => k.startsWith("social.")).sort()).toEqual(
      SELF_OR_ATTR_ACTIONS.map((a) => `social.post.${a}`).sort(),
    );
    for (const role of ["company_admin", "manager", "social_manager", "social_staff", "viewer", "org_unit_lead"]) {
      for (const k of [...newKeys, "social.report.approve", "social.report.deliver"]) expect(social(role), `${role} ${k}`).not.toContain(k);
    }
    expect(bundles.roles.client).toContain("portal.approve_spend");
    expect(bundles.roles.client.every((k) => k.startsWith("portal."))).toBe(true);
    for (const k of ["social.post.manage", "social.post.record_client", "social.post.boost", "social.post.author", "social.post.design", "social.post.schedule", "social.post.proofread"]) {
      expect(bundles.roles.owner, `owner must not hold ${k}`).not.toContain(k);
    }
    expect(bundles.roles.owner).toContain("social.report.read");
  });

  it("the hazard scan classes social_approver_seat on the attribute-gate axis (no Pattern C); the two roles are the SAFE shape", () => {
    const seat = roleExprs.get("social_approver_seat")!;
    const before = seat.slice(0, seat.indexOf(".exists("));
    // the client_contact_admin shape: a top-level resource-attribute gate BEFORE the .exists, no g.role literal, no scopeType
    expect(before).toContain("request.resource.attr.approverIds");
    expect(seat).not.toMatch(/g\.role\s*==/);
    expect(seat).not.toMatch(/scopeType/);
    expect(Object.keys((scopeConstrainedRolesDoc as { roles: Record<string, string[]> }).roles)).not.toContain("social_approver_seat");
    for (const name of ["social_copywriter", "social_designer"]) {
      const e = roleExprs.get(name)!;
      expect(e.slice(0, e.indexOf(".exists("))).not.toContain("request.resource.attr");
      expect(e).toContain('g.scopeType == "global"');
      expect(e).toContain('(g.scopeType == "company" && g.scopeId == request.resource.attr.tenantId)');
      // the SAFE shape reaches both plain scopes, so the derived scope set is never narrower than {company, global}
      expect((scopeConstrainedRolesDoc as { roles: Record<string, string[]> }).roles[name]).toEqual(["company", "global"]);
    }
  });

  it("approverIds and creativeSource reach the policy: Resource type AND the resourcePayload() allow-list carry both, fail closed", () => {
    const src = readFileSync(join(__dirname, "cerbos.ts"), "utf8");
    expect(src).toContain("approverIds?: string[];");
    expect(src).toContain("creativeSource?: string;");
    expect(src).toContain("approverIds: r.approverIds ?? []");
    expect(src).toContain('creativeSource: r.creativeSource ?? ""');
  });

  it("DIRECT maps social_approver_seat to no real role, byte-aligned across the generator and the parity suite", () => {
    const gen = readFileSync(join(__dirname, "../../scripts/generate-role-bundles.mjs"), "utf8");
    const parity = readFileSync(join(__dirname, "role-permission-parity.db.test.ts"), "utf8");
    for (const line of ["social_copywriter: [\"social_copywriter\"],", "social_designer: [\"social_designer\"],", "social_approver_seat: [],"]) {
      expect(gen, line).toContain(line);
      expect(parity, line).toContain(line);
    }
  });

  it("the catalog carries the eleven keys with §53.11's sensitive and uiGrantable flags", () => {
    const want: Record<string, [boolean, boolean]> = {
      "social.post.author": [false, true], "social.post.proofread": [false, true], "social.post.approve": [true, false],
      "social.post.design": [false, true], "social.post.schedule": [false, true], "social.post.manage": [false, true],
      "social.post.record_client": [true, true], "social.post.boost": [true, true],
      "social.engagement.plan": [false, false], "social.engagement.budget": [true, false], "portal.approve_spend": [true, false],
      "social.report.approve": [true, false], "social.report.deliver": [true, false],
    };
    for (const [key, [sensitive, ui]] of Object.entries(want)) {
      const e = catalog.find((p) => p.key === key);
      expect(e, key).toBeDefined();
      expect([e!.sensitive, e!.uiGrantable, e!.class], key).toEqual([sensitive, ui, "grantable"]);
    }
  });
});

// ═══════════════════════════════════════════════ B. LIVE matrix ═══════════════════════════════════════════════
const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const T1 = "aaaaaaaa-5c9b-0000-0000-000000000001";
const T2 = "aaaaaaaa-5c9b-0000-0000-000000000002";
const U = {
  officer: "11111111-0000-0000-0000-000000000001",
  otherOfficer: "11111111-0000-0000-0000-000000000002",
  author: "11111111-0000-0000-0000-000000000003",
  copy: "11111111-0000-0000-0000-000000000004",
  hod: "11111111-0000-0000-0000-000000000005",
  gm: "11111111-0000-0000-0000-000000000006",
  owner: "11111111-0000-0000-0000-000000000007",
  admin: "11111111-0000-0000-0000-000000000008",
  webdevHead: "11111111-0000-0000-0000-000000000009",
  smgr: "11111111-0000-0000-0000-00000000000a",
  assignee: "11111111-0000-0000-0000-00000000000b",
  designer: "11111111-0000-0000-0000-00000000000c",
  viewer: "11111111-0000-0000-0000-00000000000d",
  client: "11111111-0000-0000-0000-00000000000e",
  pa: "11111111-0000-0000-0000-00000000000f",
  hodB: "11111111-0000-0000-0000-000000000010",
  bot: "11111111-0000-0000-0000-000000000011",
  contributor: "11111111-0000-0000-0000-000000000012",
};

function principal(
  userId: string,
  roles: RoleGrant[],
  opts: { perms?: PermissionGrant[]; companies?: string[]; assurance?: Principal["assurance"]; kind?: string; via?: Principal["via"] } = {},
): Principal {
  const companies = opts.companies ?? [T1];
  return {
    userId, assurance: opts.assurance ?? "high", companies,
    rootCompanies: companies, roles, perms: opts.perms ?? [], sessionVersion: 1,
    ...(opts.kind ? { kind: opts.kind as unknown as Principal["kind"] } : {}),
    ...(opts.via ? { via: opts.via } : {}),
  } as Principal;
}
const co = (role: string, scopeId = T1): RoleGrant => ({ role, scopeType: "company", scopeId });
const glob = (role: string): RoleGrant => ({ role, scopeType: "global", scopeId: null });
/** The permission-native owner: its bundle as perms at the company scope (what assemblePrincipal resolves). */
const ownerPerms = (scopeId = T1): PermissionGrant[] => bundles.roles.owner.map((key) => ({ key, scopeType: "company" as const, scopeId }));
const clientPerms = (scopeId = T1): PermissionGrant[] => bundles.roles.client.map((key) => ({ key, scopeType: "company" as const, scopeId }));

const SEATS_T1 = [U.hod, U.gm];
const post = (extra: Partial<Resource> = {}, tenantId = T1): Resource => ({
  kind: "social_post", id: "22222222-2222-2222-2222-222222222222", tenantId, module: "social",
  ownerId: U.officer, creatorId: U.author, approverIds: tenantId === T1 ? SEATS_T1 : [U.hodB],
  assigneeIds: [U.assignee], creativeSource: "creatives", ...extra,
});
const engagement = (extra: Partial<Resource> = {}, tenantId = T1): Resource => ({
  kind: "social_engagement", id: "33333333-3333-3333-3333-333333333333", tenantId, module: "social",
  approverIds: tenantId === T1 ? SEATS_T1 : [U.hodB], ...extra,
});
const report = (extra: Partial<Resource> = {}, tenantId = T1): Resource => ({
  kind: "social_report", id: "44444444-4444-4444-4444-444444444444", tenantId, module: "social",
  approverIds: tenantId === T1 ? SEATS_T1 : [U.hodB], ...extra,
});
const portal = (tenantId = T1): Resource => ({ kind: "portal", tenantId });
const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;

const P = {
  officer: principal(U.officer, [co("member"), co("social_staff")]),
  copy: principal(U.copy, [co("member"), co("social_copywriter")]),
  hod: principal(U.hod, [co("member"), co("social_staff")]),
  gm: principal(U.gm, [co("member")]),
  owner: principal(U.owner, [co("owner")], { perms: ownerPerms() }),
  pa: principal(U.pa, [glob("platform_admin")]),
  admin: principal(U.admin, [co("company_admin")]),
  webdevHead: principal(U.webdevHead, [co("manager"), co("member")]),
  smgr: principal(U.smgr, [co("social_manager"), co("member")]),
  assignee: principal(U.assignee, [co("member")]),
  designer: principal(U.designer, [co("member"), co("social_designer")]),
  viewer: principal(U.viewer, [co("viewer")]),
  client: principal(U.client, [co("client")], { perms: clientPerms() }),
};

describe.skipIf(!live)("SCP-1b Cerbos matrix — allowed (§53.14)", () => {
  it("the officer: author, schedule and the team's steps on their own client's post; report create, update and submit", async () => {
    for (const a of ["author", "schedule", ...TEAM_STEPS]) expect(await allow(P.officer, post(), a), a).toBe(true);
    for (const a of ["read", "create", "update"]) expect(await allow(P.officer, report(), a), `report ${a}`).toBe(true);
  });

  it("the copywriter proofreads; reads posts and the brand book", async () => {
    expect(await allow(P.copy, post(), "proofread")).toBe(true);
    expect(await allow(P.copy, post(), "read")).toBe(true);
    expect(await allow(P.copy, engagement(), "read")).toBe(true);
  });

  it("a Social Media seat holder and a GM-unit seat holder: approve, plan, budget, report approve and deliver, manage, record_client, boost", async () => {
    for (const p of [P.hod, P.gm]) {
      for (const a of ["approve", ...TEAM_STEPS]) expect(await allow(p, post(), a), `${p.userId} post ${a}`).toBe(true);
      for (const a of ["plan", "budget"]) expect(await allow(p, engagement(), a), `${p.userId} ${a}`).toBe(true);
      for (const a of ["approve", "deliver"]) expect(await allow(p, report(), a), `${p.userId} report ${a}`).toBe(true);
      // planning a company-level action (no engagement id) works the same
      expect(await allow(p, engagement({ id: undefined }), "plan")).toBe(true);
    }
  });

  it("an owner: approve, plan, budget, and report read, approve and deliver, through the mirrors", async () => {
    expect(await allow(P.owner, post(), "approve")).toBe(true);
    for (const a of ["plan", "budget"]) expect(await allow(P.owner, engagement(), a), a).toBe(true);
    for (const a of ["read", "approve", "deliver"]) expect(await allow(P.owner, report(), a), `report ${a}`).toBe(true);
  });

  it("the request assignee designs a creatives post; the social_designer designs an in_team post", async () => {
    expect(await allow(P.assignee, post(), "design")).toBe(true);
    expect(await allow(P.designer, post({ creativeSource: "in_team" }), "design")).toBe(true);
    expect(await allow(P.designer, post({ creativeSource: "in_team" }), "read")).toBe(true);
  });

  it("a client contact may attempt approve_spend", async () => {
    expect(await allow(P.client, portal(), "approve_spend")).toBe(true);
    // the role arm alone, and the mirror alone
    expect(await allow(principal(U.client, [co("client")]), portal(), "approve_spend")).toBe(true);
    expect(await allow(principal(U.client, [], { perms: [{ key: "portal.approve_spend", scopeType: "company", scopeId: T1 }] }), portal(), "approve_spend")).toBe(true);
  });

  it("platform_admin on every new action where it is not the maker", async () => {
    for (const a of PIPELINE_ACTIONS) expect(await allow(P.pa, post(), a), a).toBe(true);
    for (const a of ["plan", "budget"]) expect(await allow(P.pa, engagement(), a), a).toBe(true);
    for (const a of ["approve", "deliver"]) expect(await allow(P.pa, report(), a), a).toBe(true);
    expect(await allow(P.pa, portal(), "approve_spend")).toBe(true);
  });

  it("the same person's decisions are unchanged when the call arrives through the OBO envelope with an agent set", async () => {
    const via = { provider: "platform", externalId: "hub", agent: "hermes" };
    const officerObo = principal(U.officer, [co("member"), co("social_staff")], { via });
    const hodObo = principal(U.hod, [co("member"), co("social_staff")], { via });
    for (const a of PIPELINE_ACTIONS) {
      expect(await allow(officerObo, post(), a), `officer ${a}`).toBe(await allow(P.officer, post(), a));
      expect(await allow(hodObo, post(), a), `hod ${a}`).toBe(await allow(P.hod, post(), a));
    }
    expect(await allow(officerObo, post(), "approve")).toBe(false); // the maker/checker DENY decides on the person
    expect(await allow(hodObo, post(), "approve")).toBe(true);
  });
});

describe.skipIf(!live)("SCP-1b Cerbos matrix — denied (§53.14)", () => {
  it("another officer's author, schedule and team steps", async () => {
    const other = principal(U.otherOfficer, [co("member"), co("social_staff")]);
    for (const a of ["author", "schedule", ...TEAM_STEPS]) expect(await allow(other, post(), a), a).toBe(false);
  });

  it("a company_admin, a Web Dev head holding only manager, and a social_manager holder: approve, plan, budget, report approve, deliver and send-back, and creating a pipeline post", async () => {
    for (const p of [P.admin, P.webdevHead, P.smgr]) {
      expect(await allow(p, post(), "approve"), `${p.userId} approve`).toBe(false);
      for (const a of ["plan", "budget"]) expect(await allow(p, engagement(), a), `${p.userId} ${a}`).toBe(false);
      // report approve also gates sending back (in_review -> draft)
      for (const a of ["approve", "deliver"]) expect(await allow(p, report(), a), `${p.userId} report ${a}`).toBe(false);
      // creating a pipeline post: create alone is not enough, author or approve is also asked, and both refuse
      const wouldBe = post({ id: undefined, creatorId: "", creativeSource: "" });
      expect(await allow(p, wouldBe, "author"), `${p.userId} author`).toBe(false);
      expect(await allow(p, wouldBe, "approve"), `${p.userId} approve on the would-be post`).toBe(false);
      for (const a of PIPELINE_ACTIONS) expect(await allow(p, post(), a), `${p.userId} ${a}`).toBe(false);
    }
    // the existing create stays theirs (unchanged), which is why the second check exists
    expect(await allow(P.admin, post({ id: undefined }), "create")).toBe(true);
  });

  it("the officer never delivers a report (SCP-Q20) and never approves it", async () => {
    expect(await allow(P.officer, report(), "deliver")).toBe(false);
    expect(await allow(P.officer, report(), "approve")).toBe(false);
  });

  it("the owner's manage, record_client and boost (and every other team or officer step)", async () => {
    for (const a of ["author", "schedule", "design", "proofread", ...TEAM_STEPS]) expect(await allow(P.owner, post(), a), a).toBe(false);
  });

  it("THE TENANT TRAP: a seat on another company's same-id unit, an org_unit_lead grant there, and an owner of another company", async () => {
    // HoD-B holds the seat of company T2's Social Media unit. In T1 the handler feeds T1's own seats, which do not name them.
    const hodB = principal(U.hodB, [co("member", T1), co("member", T2), { role: "org_unit_lead", scopeType: "org_unit", scopeId: "d-social-media", tenantIds: [T2] }], { companies: [T1, T2] });
    expect(await allow(hodB, post(), "approve")).toBe(false);
    expect(await allow(hodB, engagement(), "plan")).toBe(false);
    expect(await allow(hodB, report(), "deliver")).toBe(false);
    // ... and in T2 (their own company) they are allowed, so the denial above is the tenant, not the rule
    expect(await allow(hodB, post({}, T2), "approve")).toBe(true);
    // A forged T2 resource cannot carry a T1 seat holder into T2 without membership: inTenant refuses.
    const hodNoT2 = principal(U.hod, [co("member")]);
    expect(await allow(hodNoT2, post({ approverIds: [U.hod] }, T2), "approve")).toBe(false);
    // An owner of another company (grant and perms on T2), even when also a member of T1.
    const otherOwner = principal(U.owner, [co("owner", T2), co("member", T1)], { perms: ownerPerms(T2), companies: [T1, T2] });
    expect(await allow(otherOwner, post(), "approve")).toBe(false);
    for (const a of ["plan", "budget"]) expect(await allow(otherOwner, engagement(), a), a).toBe(false);
    for (const a of ["approve", "deliver"]) expect(await allow(otherOwner, report(), a), a).toBe(false);
  });

  it("the request assignee on an in_team post, and the social_designer on a creatives post", async () => {
    expect(await allow(P.assignee, post({ creativeSource: "in_team" }), "design")).toBe(false);
    expect(await allow(P.designer, post({ creativeSource: "creatives" }), "design")).toBe(false);
  });

  it("approve and proofread for the author and for the officer, also as owner and as platform_admin", async () => {
    const author = (roles: RoleGrant[], perms: PermissionGrant[] = []) => principal(U.author, roles, { perms });
    const officer = (roles: RoleGrant[], perms: PermissionGrant[] = []) => principal(U.officer, roles, { perms });
    for (const p of [
      author([co("member"), co("social_copywriter")]),
      author([co("owner")], ownerPerms()),
      author([glob("platform_admin")]),
      officer([co("member"), co("social_copywriter")]),
      officer([co("owner")], ownerPerms()),
      officer([glob("platform_admin")]),
    ]) {
      expect(await allow(p, post(), "approve"), `${p.userId} approve`).toBe(false);
      expect(await allow(p, post(), "proofread"), `${p.userId} proofread`).toBe(false);
    }
    // A seat approver who drafted the post is refused too; another of the four takes it.
    expect(await allow(P.hod, post({ creatorId: U.hod }), "approve")).toBe(false);
    expect(await allow(P.gm, post({ creatorId: U.hod }), "approve")).toBe(true);
    // A seat approver who is the client's officer is refused.
    expect(await allow(P.gm, post({ ownerId: U.gm }), "approve")).toBe(false);
  });

  it("every new action, and report approve and deliver, for automation and bot principals, also when they hold company_admin or platform_admin", async () => {
    for (const kind of ["automation", "bot"]) {
      for (const roles of [[co("company_admin")], [glob("platform_admin")], [co("member"), co("social_copywriter"), co("social_designer")]]) {
        const p = principal(U.bot, roles, { kind });
        const seatBot = principal(U.hod, roles, { kind });
        for (const a of PIPELINE_ACTIONS) {
          expect(await allow(p, post({ ownerId: U.bot, assigneeIds: [U.bot] }), a), `${kind} ${a}`).toBe(false);
          expect(await allow(seatBot, post(), a), `${kind} seat ${a}`).toBe(false);
        }
        for (const a of ["plan", "budget"]) expect(await allow(seatBot, engagement(), a), `${kind} ${a}`).toBe(false);
        for (const a of ["approve", "deliver"]) expect(await allow(seatBot, report(), a), `${kind} report ${a}`).toBe(false);
      }
      // read stays allowed
      expect(await allow(principal(U.bot, [co("company_admin")], { kind }), post(), "read")).toBe(true);
    }
  });

  it("a contributor principal with no grants is denied the eight actions, plan and budget (and is not in the automation DENY)", async () => {
    const contributor = principal(U.contributor, [], { kind: "contributor" });
    for (const a of PIPELINE_ACTIONS) expect(await allow(contributor, post({ ownerId: U.contributor, assigneeIds: [U.contributor] }), a), a).toBe(false);
    for (const a of ["plan", "budget"]) expect(await allow(contributor, engagement(), a), a).toBe(false);
    // the refusal is the absence of a grant, not a DENY: the same kind holding the seat would pass
    const contributorSeat = principal(U.hod, [co("member")], { kind: "contributor" });
    expect(await allow(contributorSeat, post(), "approve")).toBe(true);
  });

  it("a viewer, a low-assurance session, and a portal contact on every social_post action", async () => {
    const lowHod = principal(U.hod, [co("member"), co("social_staff")], { assurance: "low" });
    const lowOfficer = principal(U.officer, [co("member"), co("social_staff")], { assurance: "low" });
    for (const a of [...PIPELINE_ACTIONS, "read"]) {
      expect(await allow(P.viewer, post({ ownerId: U.viewer }), a), `viewer ${a}`).toBe(false);
      expect(await allow(lowHod, post(), a), `low hod ${a}`).toBe(false);
      expect(await allow(lowOfficer, post(), a), `low officer ${a}`).toBe(false);
      expect(await allow(P.client, post({ ownerId: U.client }), a), `client ${a}`).toBe(false);
    }
    for (const a of ["plan", "budget", "read"]) expect(await allow(P.client, engagement(), a), `client ${a}`).toBe(false);
  });

  it("approve_spend for staff", async () => {
    for (const p of [P.admin, P.owner, P.officer, P.hod, P.webdevHead]) expect(await allow(p, portal(), "approve_spend"), p.userId!).toBe(false);
    // a contact of another company
    expect(await allow(principal(U.client, [co("client", T2)], { companies: [T2] }), portal(T1), "approve_spend")).toBe(false);
  });

  it("an unfed creativeSource or approverIds denies", async () => {
    expect(await allow(P.assignee, post({ creativeSource: undefined }), "design")).toBe(false);
    expect(await allow(P.designer, post({ creativeSource: undefined }), "design")).toBe(false);
    expect(await allow(P.hod, post({ approverIds: undefined }), "approve")).toBe(false);
    expect(await allow(P.hod, engagement({ approverIds: undefined }), "plan")).toBe(false);
    expect(await allow(P.hod, report({ approverIds: undefined }), "deliver")).toBe(false);
    // an unfed ownerId: no officer
    expect(await allow(P.officer, post({ ownerId: undefined }), "author")).toBe(false);
  });
});

describe.skipIf(!live)("SCP-1b Cerbos matrix — replay of the existing decisions (§53.14)", () => {
  it("existing social_post and social_engagement actions keep their holders", async () => {
    for (const a of ["read", "create", "update", "delete", "submit", "publish", "cancel", "delete_published", "import_native"]) {
      expect(await allow(P.admin, post(), a), `company_admin ${a}`).toBe(true);
      expect(await allow(P.webdevHead, post(), a), `manager ${a}`).toBe(true);
      expect(await allow(P.smgr, post(), a), `social_manager ${a}`).toBe(true);
    }
    for (const a of ["read", "create", "update", "submit", "import_native"]) expect(await allow(P.officer, post(), a), `social_staff ${a}`).toBe(true);
    for (const a of ["delete", "publish", "cancel", "delete_published"]) expect(await allow(P.officer, post(), a), `social_staff ${a}`).toBe(false);
    for (const a of ["read", "create", "update", "delete", "set_scope"]) {
      expect(await allow(P.admin, engagement(), a), `company_admin engagement ${a}`).toBe(true);
      expect(await allow(P.smgr, engagement(), a), `social_manager engagement ${a}`).toBe(true);
    }
  });

  it("social_report: read/create/update/delete unchanged; approve/deliver narrowed", async () => {
    for (const a of ["read", "create", "update", "delete"]) {
      expect(await allow(P.admin, report(), a), `company_admin ${a}`).toBe(true);
      expect(await allow(P.webdevHead, report(), a), `manager ${a}`).toBe(true);
      expect(await allow(P.smgr, report(), a), `social_manager ${a}`).toBe(true);
    }
    expect(await allow(P.officer, report(), "delete")).toBe(false);
    expect(await allow(P.viewer, report(), "read")).toBe(false);
  });
});
