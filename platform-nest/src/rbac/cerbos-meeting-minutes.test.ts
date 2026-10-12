// PV4-05 — Cerbos matrix for the NEW `share_minutes` action on the EXISTING `meeting_recording` kind (sharing a meeting's
// minutes with its client). Design decision 9; owner ruling PV-D23: nothing an agent writes reaches a client until a staff
// member approves it.
//
// THE CLAIMS UNDER TEST
//   1. `share_minutes` reaches EXACTLY the roles that hold `update` on this kind today (company_admin, manager, member),
//      under the same `inTenant && notLow` condition; a viewer holds neither.
//   2. NO automation or bot principal shares minutes: kind in [automation, bot] is DENIED `share_minutes` even when it holds
//      company_admin, platform_admin or the permission mirror, but keeps `update` (an agent MAY draft minutes) and `read`.
//   3. `share_minutes` has its own perm mirror (`perm_meeting_recording_share_minutes`, key core.meeting_recording.share_minutes)
//      which does not bleed into `update`, and `update` does not bleed into it.
//   4. Nothing that existed before moved: create/ingest/sync_drive stay on the three staff roles, relink on company_admin.
//
// Two layers (same convention as cerbos-conversation.test.ts):
//   A. STATIC (always runs): re-parses cerbos/policies/*.yaml and pins the structure, so removing the agent DENY fails on a
//      laptop and in any CI shard without a Cerbos container.
//   B. LIVE (needs CERBOS_URL): the decision matrix against the real engine loaded with the CURRENT policy files. Runs on the
//      Linux gate; skipped otherwise, and a skip is not a pass.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { check, type Resource } from "./cerbos";
import type { Principal, RoleGrant, PermissionGrant } from "./principal";

const POLICIES_DIR = join(__dirname, "../../cerbos/policies");
const ACTIONS = ["read", "create", "update", "ingest", "sync_drive", "relink", "share_minutes"] as const;

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

describe("PV4-05 static pin — resource_meeting_recording.yaml `share_minutes`", () => {
  const rules = parseKind("resource_meeting_recording.yaml");
  const roleExprs = derivedRoleExprs();
  const roleArm = rules.filter((r) => r.effect === "EFFECT_ALLOW" && r.derivedRoles.every((d) => !d.startsWith("perm_") && d !== "platform_admin"));
  const reach = (action: string) => roleArm.filter((r) => r.actions.includes(action)).flatMap((r) => r.derivedRoles).sort();

  it("the agent DENY exists: exactly share_minutes, on roles:[user], reading principal.attr.kind in [automation, bot]", () => {
    const denies = rules.filter((r) => r.effect === "EFFECT_DENY");
    expect(denies.length, "exactly one DENY rule").toBe(1);
    const [d] = denies;
    expect(d.actions).toEqual(["share_minutes"]);
    expect(d.roles).toEqual(["user"]);
    expect(d.condition).toContain("request.principal.attr.kind");
    expect(d.condition).toContain('["automation", "bot"]');
    expect(d.condition, "has() guards a raw caller that omits the attribute").toContain("has(request.principal.attr.kind)");
  });

  it("`update` and `read` are NOT denied to agents (an agent may draft minutes)", () => {
    for (const r of rules.filter((x) => x.effect === "EFFECT_DENY")) {
      for (const a of ["update", "read", "create", "ingest", "sync_drive", "relink", "*"]) expect(r.actions).not.toContain(a);
    }
  });

  it("share_minutes reaches exactly the roles that hold update, under inTenant && notLow", () => {
    expect(reach("share_minutes")).toEqual(["company_admin", "manager", "member"]);
    expect(reach("share_minutes")).toEqual(reach("update"));
    for (const r of roleArm.filter((x) => x.actions.includes("share_minutes"))) expect(r.condition).toBe("variables.inTenant && variables.notLow");
  });

  it("nothing that existed before moved: create/ingest/sync_drive on the three staff roles, relink on company_admin, read on four", () => {
    for (const a of ["create", "ingest", "sync_drive"]) expect(reach(a), a).toEqual(["company_admin", "manager", "member"]);
    expect(reach("relink")).toEqual(["company_admin"]);
    expect(reach("read")).toEqual(["company_admin", "manager", "member", "viewer"]);
  });

  it("share_minutes has exactly one perm mirror under inTenant && notLow && inRoot, keyed core.meeting_recording.share_minutes", () => {
    const mirrors = rules.filter((r) => r.derivedRoles.some((d) => d.startsWith("perm_")) && r.actions.includes("share_minutes"));
    expect(mirrors.length).toBe(1);
    expect(mirrors[0].derivedRoles).toEqual(["perm_meeting_recording_share_minutes"]);
    expect(mirrors[0].effect).toBe("EFFECT_ALLOW");
    expect(mirrors[0].condition).toBe("variables.inTenant && variables.notLow && variables.inRoot");
    const expr = roleExprs.get("perm_meeting_recording_share_minutes");
    expect(expr, "perm_meeting_recording_share_minutes must exist in derived_roles.yaml").toBeTruthy();
    expect(expr).toContain('g.key == "core.meeting_recording.share_minutes"');
    expect(expr).toContain('g.scopeType == "global"');
    expect(expr).toContain('g.scopeType == "company" && g.scopeId == request.resource.attr.tenantId');
  });

  it("the `client` role is named by no rule of the meeting_recording policy (the client reads minutes through `portal`)", () => {
    for (const r of rules) {
      expect(r.derivedRoles, JSON.stringify(r.actions)).not.toContain("client");
      expect(r.roles, JSON.stringify(r.actions)).not.toContain("client");
    }
  });

  it("the bundle JSON gives share_minutes to exactly the roles that hold update, owner exactly company_admin's, and never viewer or client", () => {
    const bundles = JSON.parse(readFileSync(join(__dirname, "role-permission-bundles.json"), "utf8")) as { roles: Record<string, string[]> };
    const holders = (key: string) => Object.entries(bundles.roles).filter(([, keys]) => keys.includes(key)).map(([role]) => role).sort();
    expect(holders("core.meeting_recording.share_minutes")).toEqual(holders("core.meeting_recording.update"));
    expect(holders("core.meeting_recording.share_minutes")).toEqual(["company_admin", "manager", "member", "owner", "platform_admin"]);
    const kind = (role: string) => bundles.roles[role].filter((k) => k.startsWith("core.meeting_recording.")).sort();
    expect(kind("owner")).toEqual(kind("company_admin"));
  });

  it("the catalog marks the key grantable, sensitive and ui-grantable", () => {
    const catalog = JSON.parse(readFileSync(join(__dirname, "permission-catalog.json"), "utf8")) as { permissions: Array<Record<string, unknown>> };
    const e = catalog.permissions.find((p) => p.key === "core.meeting_recording.share_minutes");
    expect(e).toMatchObject({ cerbosKind: "meeting_recording", cerbosAction: "share_minutes", class: "grantable", sensitive: true, uiGrantable: true });
  });
});

// ─── B. LIVE matrix ───────────────────────────────────────────────────────────────────────────────────────────
const live = process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0;
const T1 = "aaaaaaaa-5555-0000-0000-000000000001"; // home tenant
const T2 = "aaaaaaaa-5555-0000-0000-000000000002"; // rival tenant

function principal(
  roles: RoleGrant[],
  opts: { perms?: PermissionGrant[]; companies?: string[]; assurance?: Principal["assurance"]; kind?: Principal["kind"] } = {},
): Principal {
  const companies = opts.companies ?? [T1];
  return {
    userId: "u-min", assurance: opts.assurance ?? "high", companies,
    rootCompanies: companies, roles, perms: opts.perms ?? [], sessionVersion: 1,
    ...(opts.kind ? { kind: opts.kind } : {}),
  };
}
const co = (role: string, scopeId = T1): RoleGrant => ({ role, scopeType: "company", scopeId });
const glob = (role: string): RoleGrant => ({ role, scopeType: "global", scopeId: null });
const meeting = (tenantId = T1): Resource => ({ kind: "meeting_recording", tenantId });
const allow = async (p: Principal, r: Resource, a: string) => (await check(p, r, a)).allow;

type Cell = Record<(typeof ACTIONS)[number], boolean>;
const STAFF_ALL: Cell = { read: true, create: true, update: true, ingest: true, sync_drive: true, relink: false, share_minutes: true };
const ADMIN_ALL: Cell = { ...STAFF_ALL, relink: true };
const NONE: Cell = { read: false, create: false, update: false, ingest: false, sync_drive: false, relink: false, share_minutes: false };
const READ_ONLY: Cell = { ...NONE, read: true };
const NO_SHARE = (c: Cell): Cell => ({ ...c, share_minutes: false });

describe.skipIf(!live)("PV4-05 Cerbos matrix — meeting_recording (role x action)", () => {
  const table: Array<[string, Principal, Cell]> = [
    ["platform_admin (global)", principal([glob("platform_admin")]), ADMIN_ALL],
    ["company_admin @T1", principal([co("company_admin")]), ADMIN_ALL],
    ["manager @T1: a member who may update a meeting may share its minutes", principal([co("manager")]), STAFF_ALL],
    ["member @T1: same", principal([co("member")]), STAFF_ALL],
    ["viewer @T1: read only", principal([co("viewer")]), READ_ONLY],
    ["client @T1 — the client grant appears nowhere in this policy", principal([co("client")]), NONE],
    ["company_admin of T2 only (cross-tenant)", principal([co("company_admin", T2)], { companies: [T2] }), NONE],
    ["company_admin @T1 at LOW assurance (notLow)", principal([co("company_admin")], { assurance: "low" }), NONE],
    ["member @T1 at LOW assurance", principal([co("member")], { assurance: "low" }), NONE],
    ["no grants at all", principal([]), NONE],
    // ── PV-D23: agents and automation draft minutes (update) but never share them ──
    ["bot holding company_admin: ALLOWED update, DENIED share_minutes", principal([co("company_admin")], { kind: "bot" }), NO_SHARE(ADMIN_ALL)],
    ["automation holding company_admin: same", principal([co("company_admin")], { kind: "automation" }), NO_SHARE(ADMIN_ALL)],
    ["bot holding member: same", principal([co("member")], { kind: "bot" }), NO_SHARE(STAFF_ALL)],
    ["bot holding manager: same", principal([co("manager")], { kind: "bot" }), NO_SHARE(STAFF_ALL)],
    ["bot holding platform_admin: the wildcard does not beat the DENY", principal([glob("platform_admin")], { kind: "bot" }), NO_SHARE(ADMIN_ALL)],
    ["bot holding viewer: read only, as any viewer", principal([co("viewer")], { kind: "bot" }), READ_ONLY],
    // a human is unaffected by the new attribute
    ["employee holding company_admin (kind=employee)", principal([co("company_admin")], { kind: "employee" }), ADMIN_ALL],
  ];

  for (const [label, p, expected] of table) {
    it(`${label}`, async () => {
      for (const action of ACTIONS) {
        expect(await allow(p, meeting(), action), `${label}: meeting_recording · ${action}`).toBe(expected[action]);
      }
    });
  }

  it("an unlisted action is a deny, never a wildcard leak (only platform_admin holds '*')", async () => {
    expect(await allow(principal([co("company_admin")]), meeting(), "unshare_minutes")).toBe(false);
    expect(await allow(principal([glob("platform_admin")]), meeting(), "unshare_minutes")).toBe(true);
  });

  it("OWNER == company_admin: a permission-native owner (zero rules, bundle only) decides share_minutes exactly as company_admin does, and a bot owner is denied", async () => {
    const bundles = JSON.parse(readFileSync(join(__dirname, "role-permission-bundles.json"), "utf8")) as { roles: Record<string, string[]> };
    const ownerP = principal([co("owner")], { perms: bundles.roles.owner.map((key) => ({ key, scopeType: "company" as const, scopeId: T1 })) });
    const adminP = principal([co("company_admin")]);
    for (const action of ACTIONS) {
      expect(await allow(ownerP, meeting(), action), `owner · ${action}`).toBe(await allow(adminP, meeting(), action));
    }
    expect(await allow(ownerP, meeting(), "share_minutes")).toBe(true);
    const ownerBot = principal([co("owner")], { kind: "bot", perms: ownerP.perms });
    expect(await allow(ownerBot, meeting(), "share_minutes")).toBe(false);
    expect(await allow(ownerBot, meeting(), "update")).toBe(true);
  });

  it("an instance id on the resource does not change any decision (row-level reach is the controller's)", async () => {
    for (const [label, p] of table) {
      for (const action of ACTIONS) {
        expect(await allow(p, { ...meeting(), id: "11111111-1111-1111-1111-111111111111" }, action), `${label} · ${action}`)
          .toBe(await allow(p, meeting(), action));
      }
    }
  });
});

describe.skipIf(!live)("PV4-05 Cerbos matrix — meeting_recording share_minutes, the permission-mirror arm (roles: [])", () => {
  const permP = (
    key: string,
    scopeType: "company" | "global" = "company",
    opts: { assurance?: Principal["assurance"]; companies?: string[]; kind?: Principal["kind"] } = {},
  ) => principal([], { perms: [{ key, scopeType, scopeId: scopeType === "company" ? T1 : null }], ...opts });
  const SHARE = "core.meeting_recording.share_minutes";

  it(`permission ${SHARE} ALONE allows share_minutes, and bleeds into no sibling action`, async () => {
    expect(await allow(permP(SHARE), meeting(), "share_minutes")).toBe(true);
    for (const other of ACTIONS.filter((a) => a !== "share_minutes")) {
      expect(await allow(permP(SHARE), meeting(), other), `${SHARE} must not allow ${other}`).toBe(false);
    }
  });

  it("core.meeting_recording.update ALONE does not allow share_minutes (editing a meeting is not publishing to a client)", async () => {
    expect(await allow(permP("core.meeting_recording.update"), meeting(), "update")).toBe(true);
    expect(await allow(permP("core.meeting_recording.update"), meeting(), "share_minutes")).toBe(false);
  });

  it("no cross-tenant reach, no low-assurance reach", async () => {
    expect(await allow(permP(SHARE), meeting(T2), "share_minutes")).toBe(false);
    expect(await allow(permP(SHARE, "company", { assurance: "low" }), meeting(), "share_minutes")).toBe(false);
  });

  it("the agent DENY beats the permission mirror too: a bot or automation holding the key ALONE is denied", async () => {
    expect(await allow(permP(SHARE, "company", { kind: "bot" }), meeting(), "share_minutes")).toBe(false);
    expect(await allow(permP(SHARE, "company", { kind: "automation" }), meeting(), "share_minutes")).toBe(false);
    expect(await allow(permP(SHARE, "global", { kind: "bot" }), meeting(), "share_minutes")).toBe(false);
  });
});
