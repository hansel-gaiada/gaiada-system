// DW-8g (docs/FRONTEND-BFF-CONTRACT.md §47.2, docs/PERMISSION-CONTRACT.md §39) — Cerbos matrix for the NEW core `calendar_event`
// kind.
//
// THE CLAIMS UNDER TEST
//   1. read: company_admin; the ORGANIZER (member or manager, ownerId == principal id); an ATTENDEE (member, viewer or manager,
//      principal id in attendeeIds); and every member, viewer and manager when visibility == "company". Nobody reads every calendar.
//   2. create: company_admin, manager, member (a viewer cannot).
//   3. update and cancel: company_admin, and the organizer (member or manager). An attendee and a viewer never edit or cancel.
//   4. respond: an attendee (member, viewer or manager) for themselves; company_admin holds the key. A deny-overrides rule makes it hold
//      for EVERY role: nobody answers for someone else, company_admin and platform_admin included.
//   5. Each attribute-dependent rule stands alone (HIER-2 authoring rule).
//   6. EFFECT_DENY on create / update / cancel / respond for automation and bot principals (beats the platform_admin wildcard and
//      the permission mirror); read stays allowed.
//   7. The permission arm covers `create` and NOT read / update / cancel / respond.
//   8. `owner` (permission-native, zero rules) holds the same five keys as company_admin in its bundle.
//   9. An unfed resource fails closed: nothing is read through an attribute rule, nobody responds.
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
const ACTIONS = ["read", "create", "update", "cancel", "respond"] as const;
const AGENT_DENIED = ["create", "update", "cancel", "respond"] as const;

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

describe("DW-8g static pin — resource_calendar_event.yaml", () => {
  const rules = parseKind("resource_calendar_event.yaml");
  const roleExprs = derivedRoleExprs();
  const allows = rules.filter((r) => r.effect === "EFFECT_ALLOW");
  const roleArm = allows.filter((r) => !r.derivedRoles.some((d) => d.startsWith("perm_") || d === "platform_admin"));
  const reach = (action: string) => roleArm.filter((r) => r.actions.includes(action));
  const attendeeCond = "request.principal.id in request.resource.attr.attendeeIds";
  const organizerCond = "request.resource.attr.ownerId == request.principal.id";

  it("read has FOUR rules, each on its own: company_admin, the organizer, an attendee, company visibility (the last three on member and manager, viewers on the attendee and visibility rules)", () => {
    const rs = reach("read");
    expect(rs.length).toBe(4);
    const admin = rs.find((r) => r.derivedRoles.includes("company_admin"))!;
    expect(admin.derivedRoles).toEqual(["company_admin"]);
    expect(admin.condition).toBe("variables.inTenant && variables.notLow");
    const organizer = rs.find((r) => r.condition.includes(organizerCond))!;
    expect([...organizer.derivedRoles].sort()).toEqual(["manager", "member"]);
    expect(organizer.condition).toContain('request.resource.attr.ownerId != ""');
    const attendee = rs.find((r) => r.condition.includes(attendeeCond))!;
    expect([...attendee.derivedRoles].sort()).toEqual(["manager", "member", "viewer"]);
    const visible = rs.find((r) => r.condition.includes('request.resource.attr.visibility == "company"'))!;
    expect([...visible.derivedRoles].sort()).toEqual(["manager", "member", "viewer"]);
    // manager only through the three attribute rules, never beside company_admin's unconditional one
    expect(rs.filter((r) => r.derivedRoles.includes("manager")).length).toBe(3);
    for (const r of rs) expect(r.actions, "no read rule carries another action").toEqual(["read"]);
  });

  it("create = company_admin/manager/member, in one unconditional rule (a viewer cannot schedule)", () => {
    const rs = reach("create");
    expect(rs.length).toBe(1);
    expect([...rs[0].derivedRoles].sort()).toEqual(["company_admin", "manager", "member"]);
    expect(rs[0].condition).toBe("variables.inTenant && variables.notLow");
  });

  it("update and cancel: company_admin in one rule, and the organizer (member and manager, ownerId == principal.id) on its own rule per action", () => {
    for (const a of ["update", "cancel"]) {
      const rs = reach(a);
      expect(rs.length, a).toBe(2);
      expect(rs.find((r) => r.derivedRoles.includes("company_admin"))!.derivedRoles).toEqual(["company_admin"]);
      const organizer = rs.find((r) => r.derivedRoles.includes("member"))!;
      expect([...organizer.derivedRoles].sort()).toEqual(["manager", "member"]);
      expect(organizer.actions).toEqual([a]);
      expect(organizer.condition).toContain(organizerCond);
      expect(organizer.condition).toContain("variables.inTenant && variables.notLow");
      expect(rs.some((r) => r.derivedRoles.includes("viewer")), a).toBe(false);
    }
  });

  it("respond: company_admin (broad, narrowed by the DENY) and the attendee rule (member, viewer and manager)", () => {
    const rs = reach("respond");
    expect(rs.length).toBe(2);
    expect(rs.find((r) => r.derivedRoles.includes("company_admin"))!.derivedRoles).toEqual(["company_admin"]);
    const attendee = rs.find((r) => r.derivedRoles.includes("member"))!;
    expect([...attendee.derivedRoles].sort()).toEqual(["manager", "member", "viewer"]);
    expect(attendee.condition).toContain(attendeeCond);
  });

  it("the organizer, attendee and visibility rules are on member/viewer/manager only, one action each, never beside company_admin", () => {
    for (const r of roleArm) {
      if (r.condition.includes("ownerId") || r.condition.includes("attendeeIds") || r.condition.includes("visibility")) {
        expect(r.derivedRoles.every((d) => d === "member" || d === "viewer" || d === "manager"), r.condition).toBe(true);
        expect(r.actions.length).toBe(1);
      }
    }
  });

  it("two EFFECT_DENY rules, both on roles [user]: respond for any non-attendee (every role), and create/update/cancel/respond for automation and bot (NOT read)", () => {
    const denies = rules.filter((r) => r.effect === "EFFECT_DENY");
    expect(denies.length).toBe(2);
    for (const d of denies) expect(d.roles).toEqual(["user"]);
    const notAttendee = denies.find((d) => d.actions.length === 1 && d.actions[0] === "respond")!;
    expect(notAttendee.condition).toBe("!has(request.resource.attr.attendeeIds) || !(request.principal.id in request.resource.attr.attendeeIds)");
    const agents = denies.find((d) => d.actions.length === 4)!;
    expect([...agents.actions].sort()).toEqual([...AGENT_DENIED].sort());
    expect(agents.condition).toBe('has(request.principal.attr.kind) && request.principal.attr.kind in ["automation", "bot"]');
  });

  it("the permission arm mirrors create exactly once, under inTenant && notLow && inRoot, and NOT read/update/cancel/respond", () => {
    const mirrors = rules.filter((r) => r.derivedRoles.some((d) => d.startsWith("perm_")));
    expect(mirrors.length).toBe(1);
    expect(mirrors[0].actions).toEqual(["create"]);
    expect(mirrors[0].derivedRoles).toEqual(["perm_calendar_event_create"]);
    expect(mirrors[0].condition).toBe("variables.inTenant && variables.notLow && variables.inRoot");
    const expr = roleExprs.get("perm_calendar_event_create");
    expect(expr, "perm_calendar_event_create must exist in derived_roles.yaml").toBeTruthy();
    expect(expr).toContain('g.key == "core.calendar_event.create"');
    expect(expr).toContain('g.scopeType == "global"');
    expect(expr).toContain('g.scopeType == "company" && g.scopeId == request.resource.attr.tenantId');
    for (const a of ["read", "update", "cancel", "respond"]) expect(roleExprs.has(`perm_calendar_event_${a}`), a).toBe(false);
  });

  it("the `client` role and org_unit_lead are named by no rule", () => {
    for (const r of rules) {
      expect(r.derivedRoles).not.toContain("client");
      expect(r.derivedRoles).not.toContain("org_unit_lead");
      expect(r.roles).not.toContain("client");
    }
  });

  it("attendeeIds and visibility reach the policy: Resource type AND the resourcePayload() allow-list carry both, fail closed", () => {
    const src = readFileSync(join(__dirname, "cerbos.ts"), "utf8");
    expect(src).toContain("attendeeIds?: string[];");
    expect(src).toContain("visibility?: string;");
    expect(src).toContain("attendeeIds: r.attendeeIds ?? []");
    expect(src).toContain('visibility: r.visibility ?? "attendees"');
    expect(src).toContain('ownerId: r.ownerId ?? ""');
  });

  it("the bundle JSON: owner == company_admin == platform_admin (all five), manager and member all five (update/cancel/respond self-scoped), viewer read+respond (respond self-scoped), nobody else", () => {
    const doc = JSON.parse(readFileSync(join(__dirname, "role-permission-bundles.json"), "utf8")) as {
      roles: Record<string, string[]>;
      selfScoped: Record<string, string[]>;
    };
    const keys = (role: string) => doc.roles[role].filter((k) => k.startsWith("core.calendar_event.")).sort();
    const all = ACTIONS.map((a) => `core.calendar_event.${a}`).sort();
    expect(keys("company_admin")).toEqual(all);
    expect(keys("owner")).toEqual(all);
    expect(keys("platform_admin")).toEqual(all);
    expect(keys("manager")).toEqual(all);
    expect(keys("member")).toEqual(all);
    expect(keys("viewer")).toEqual(["core.calendar_event.read", "core.calendar_event.respond"]);
    for (const role of Object.keys(doc.roles)) {
      if (!["company_admin", "owner", "platform_admin", "manager", "member", "viewer"].includes(role)) expect(keys(role), role).toEqual([]);
    }
    const marked = (role: string) => (doc.selfScoped[role] ?? []).filter((k) => k.startsWith("core.calendar_event.")).sort();
    expect(marked("member")).toEqual(["core.calendar_event.cancel", "core.calendar_event.respond", "core.calendar_event.update"]);
    expect(marked("manager")).toEqual(["core.calendar_event.cancel", "core.calendar_event.respond", "core.calendar_event.update"]);
    expect(marked("viewer")).toEqual(["core.calendar_event.respond"]);
    for (const role of ["company_admin", "platform_admin", "org_unit_lead"]) expect(marked(role), role).toEqual([]);
  });
});

// ─── B. LIVE matrix ───────────────────────────────────────────────────────────────────────────────────────────
const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const T1 = "aaaaaaaa-8888-0000-0000-000000000001";
const T2 = "aaaaaaaa-8888-0000-0000-000000000002";
const ME = "u-me";
const ORGANIZER = "u-organizer";
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

// An event organized by someone else, with one other attendee: ME is neither organizer nor attendee unless the case says so.
const event = (extra: Partial<Resource> = {}, tenantId = T1): Resource => ({
  kind: "calendar_event", tenantId, id: "33333333-3333-3333-3333-333333333333",
  ownerId: ORGANIZER, attendeeIds: [ORGANIZER, OTHER], visibility: "attendees", ...extra,
});
const asAttendee = (extra: Partial<Resource> = {}) => event({ attendeeIds: [ORGANIZER, OTHER, ME], ...extra });
const asOrganizer = (extra: Partial<Resource> = {}) => event({ ownerId: ME, attendeeIds: [ME, OTHER], ...extra });
const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;

type Cell = Record<(typeof ACTIONS)[number], boolean>;
const NONE: Cell = { read: false, create: false, update: false, cancel: false, respond: false };
const cell = (over: Partial<Cell>): Cell => ({ ...NONE, ...over });

describe.skipIf(!live)("DW-8g Cerbos matrix — calendar_event (role x action)", () => {
  const table: Array<[string, Principal, Resource, Cell]> = [
    // a stranger to the event (not organizer, not attendee, attendees-only visibility)
    ["platform_admin (global), not an attendee: everything but respond", principal([glob("platform_admin")]), event(), cell({ read: true, create: true, update: true, cancel: true })],
    ["company_admin @T1, not an attendee: everything but respond (nobody answers for someone else)", principal([co("company_admin")]), event(), cell({ read: true, create: true, update: true, cancel: true })],
    ["manager @T1, not involved, attendees-only: create only (a manager does not read every calendar)", principal([co("manager")]), event(), cell({ create: true })],
    ["member @T1, not involved, attendees-only: create only", principal([co("member")]), event(), cell({ create: true })],
    ["viewer @T1, not involved, attendees-only: nothing", principal([co("viewer")]), event(), NONE],
    // company visibility opens READ to every member and viewer, and nothing else
    ["member @T1, company-visible event: reads, schedules, but cannot edit, cancel or answer", principal([co("member")]), event({ visibility: "company" }), cell({ read: true, create: true })],
    ["viewer @T1, company-visible event: reads only", principal([co("viewer")]), event({ visibility: "company" }), cell({ read: true })],
    ["manager @T1, company-visible event: reads and schedules, but cannot edit, cancel or answer", principal([co("manager")]), event({ visibility: "company" }), cell({ read: true, create: true })],
    // the organizer
    ["member @T1, the ORGANIZER: reads, schedules, edits, cancels and answers (they are an attendee too)", principal([co("member")]), asOrganizer(), cell({ read: true, create: true, update: true, cancel: true, respond: true })],
    ["viewer @T1 who is the ORGANIZER by attribute: the organizer rules are on member; the attendee rule still reads and answers", principal([co("viewer")]), asOrganizer(), cell({ read: true, respond: true })],
    ["manager @T1, the ORGANIZER (a manager-only login): reads, schedules, edits, cancels and answers its own event", principal([co("manager")]), asOrganizer(), cell({ read: true, create: true, update: true, cancel: true, respond: true })],
    // an attendee
    ["member @T1, an ATTENDEE: reads, schedules and answers; cannot edit or cancel", principal([co("member")]), asAttendee(), cell({ read: true, create: true, respond: true })],
    ["viewer @T1, an ATTENDEE: reads and answers", principal([co("viewer")]), asAttendee(), cell({ read: true, respond: true })],
    ["manager @T1, an ATTENDEE: reads, schedules and answers; cannot edit or cancel", principal([co("manager")]), asAttendee(), cell({ read: true, create: true, respond: true })],
    ["company_admin @T1, an ATTENDEE: everything, answering included", principal([co("company_admin")]), asAttendee(), cell({ read: true, create: true, update: true, cancel: true, respond: true })],
    ["platform_admin, an ATTENDEE: everything, answering included", principal([glob("platform_admin")]), asAttendee(), cell({ read: true, create: true, update: true, cancel: true, respond: true })],
    // the boundary
    ["company_admin of T2 only (cross-tenant)", principal([co("company_admin", T2)], { companies: [T2] }), event(), NONE],
    ["company_admin @T1 at LOW assurance (notLow)", principal([co("company_admin")], { assurance: "low" }), asAttendee(), NONE],
    ["member @T1 at LOW assurance, organizer and attendee: nothing", principal([co("member")], { assurance: "low" }), asOrganizer(), NONE],
    ["client @T1", principal([co("client")]), asAttendee(), NONE],
    ["a webdev_manager @T1 (a module tier)", principal([co("webdev_manager")]), asAttendee(), NONE],
    ["no grants at all", principal([]), asAttendee(), NONE],
    // the DENY: agents read, never schedule, edit, cancel or answer
    ["a BOT holding manager, organizer and attendee: reads only", principal([co("manager")], { kind: "bot" }), asOrganizer(), cell({ read: true })],
    ["a BOT holding member, organizer and attendee: reads only", principal([co("member")], { kind: "bot" }), asOrganizer(), cell({ read: true })],
    ["an AUTOMATION principal holding company_admin: reads only", principal([co("company_admin")], { kind: "automation" }), event(), cell({ read: true })],
    ["platform_admin that is a bot: reads only (the DENY beats the wildcard)", principal([glob("platform_admin")], { kind: "bot" }), asAttendee(), cell({ read: true })],
    ["an employee-kind principal is unaffected by the DENY", principal([co("company_admin")], { kind: "employee" }), asAttendee(), cell({ read: true, create: true, update: true, cancel: true, respond: true })],
    // an UNFED resource fails closed
    ["member @T1 on an UNFED event (no attributes sent): create only", principal([co("member")]), { kind: "calendar_event", tenantId: T1 }, cell({ create: true })],
    ["company_admin @T1 on an UNFED event: everything but respond (an empty attendee list contains nobody)", principal([co("company_admin")]), { kind: "calendar_event", tenantId: T1 }, cell({ read: true, create: true, update: true, cancel: true })],
    ["platform_admin on an UNFED event: everything but respond", principal([glob("platform_admin")]), { kind: "calendar_event", tenantId: T1 }, cell({ read: true, create: true, update: true, cancel: true })],
  ];

  for (const [label, p, r, expected] of table) {
    it(`${label}`, async () => {
      for (const action of ACTIONS) {
        expect(await allow(p, r, action), `${label}: calendar_event · ${action}`).toBe(expected[action]);
      }
    });
  }

  it("the organizer rule fails closed: an unfed ownerId (empty) or someone else's event denies update and cancel", async () => {
    const me = principal([co("member")]);
    expect(await allow(me, event({ ownerId: undefined }), "update")).toBe(false);
    expect(await allow(me, event({ ownerId: undefined }), "cancel")).toBe(false);
    expect(await allow(me, event({ ownerId: ORGANIZER }), "update")).toBe(false);
  });

  it("the attendee rule fails closed: an unfed attendeeIds ([]) or a list without the caller denies read and respond", async () => {
    const me = principal([co("member")]);
    expect(await allow(me, event({ attendeeIds: undefined }), "read")).toBe(false);
    expect(await allow(me, event({ attendeeIds: undefined }), "respond")).toBe(false);
    expect(await allow(me, event({ attendeeIds: [OTHER] }), "respond")).toBe(false);
  });

  it("the visibility rule is exactly company: an unfed visibility (the default attendees) or any other word never opens read", async () => {
    const me = principal([co("viewer")]);
    expect(await allow(me, event({ visibility: undefined }), "read")).toBe(false);
    expect(await allow(me, event({ visibility: "everyone" }), "read")).toBe(false);
    expect(await allow(me, event({ visibility: "company" }), "read")).toBe(true);
  });

  it("answering for someone else is refused for EVERY role, whatever it holds", async () => {
    const strangerEvent = event();
    for (const p of [
      principal([glob("platform_admin")]), principal([co("company_admin")]), principal([co("manager")]), principal([co("member")]),
      principal([co("viewer")]), principal([co("company_admin"), co("member")]),
    ]) {
      expect(await allow(p, strangerEvent, "respond")).toBe(false);
    }
  });

  it("an unlisted action is a deny (only platform_admin holds '*')", async () => {
    expect(await allow(principal([co("company_admin")]), event(), "approve")).toBe(false);
    expect(await allow(principal([glob("platform_admin")]), event(), "approve")).toBe(true);
  });
});

describe.skipIf(!live)("DW-8g Cerbos matrix — calendar_event, the permission arm (roles: [])", () => {
  const permP = (key: string, scopeType: "company" | "global" = "company", opts: { assurance?: Principal["assurance"]; kind?: string } = {}) =>
    principal([], { perms: [{ key, scopeType, scopeId: scopeType === "company" ? T1 : null }], ...opts });

  it("permission core.calendar_event.create ALONE allows create and no sibling action; no cross-tenant, no low assurance", async () => {
    const key = "core.calendar_event.create";
    expect(await allow(permP(key), event(), "create")).toBe(true);
    expect(await allow(permP(key, "global"), event(), "create")).toBe(true);
    for (const other of ACTIONS.filter((a) => a !== "create")) {
      expect(await allow(permP(key), asOrganizer(), other), `${key} must not allow ${other}`).toBe(false);
    }
    expect(await allow(permP(key), event({}, T2), "create")).toBe(false);
    expect(await allow(permP(key, "company", { assurance: "low" }), event(), "create")).toBe(false);
  });

  it("a bot holding the create permission is still denied (the DENY applies to the mirror too)", async () => {
    expect(await allow(permP("core.calendar_event.create", "company", { kind: "bot" }), event(), "create")).toBe(false);
  });

  it("the bare read / update / cancel / respond permissions allow NOTHING (there is deliberately no mirror)", async () => {
    for (const a of ["read", "update", "cancel", "respond"] as const) {
      expect(await allow(permP(`core.calendar_event.${a}`), asOrganizer(), a), a).toBe(false);
    }
  });

  it("a permission-native OWNER (the bundle's keys, zero rules) schedules, but its read/update/cancel/respond keys have no arm", async () => {
    const bundles = JSON.parse(readFileSync(join(__dirname, "role-permission-bundles.json"), "utf8")) as { roles: Record<string, string[]> };
    const ownerP = principal([co("owner")], {
      perms: bundles.roles.owner.map((key) => ({ key, scopeType: "company" as const, scopeId: T1 })),
    });
    expect(await allow(ownerP, asOrganizer(), "create")).toBe(true);
    for (const a of ["read", "update", "cancel", "respond"]) expect(await allow(ownerP, asOrganizer(), a), `owner · ${a}`).toBe(false);
  });
});
