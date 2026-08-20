// IAM-05c — tests for the effective-permissions BFF endpoint.
//
// Three tiers, deliberately split (same convention as `can.test.ts`):
//   1. `computeEffectivePermissions()` is PURE — no Cerbos, no DB, no Nest. Runs always.
//   2. The controller class's HTTP-facing behaviour (tenancy 403, caching/ETag/304, revocation)
//      is tested by direct instantiation with manufactured req/reply objects — same idiom as
//      `module-catalog.controller.test.ts` — no DB/Cerbos needed either.
//   3. A live-Cerbos parity sweep that proves `scopeLevelPermissions` for `platform_admin`
//      actually equals what `can()` (real Cerbos) grants across every one of the grantable
//      keys — the concrete verification behind this ticket's "must reflect their real reach"
//      requirement, not just an assertion about the bundle's shape.
//
// STALENESS TRAP (memory `cerbos-new-policy-needs-restart`): tier 3 proves nothing if the
// container serving CERBOS_URL predates the latest policy edits. Checked this session:
// `docker inspect gaiada-test-cerbos --format '{{.State.StartedAt}}'` → 2026-08-10T07:56:31Z,
// which postdates every `cerbos/policies/*.yaml` mtime as of this session (latest:
// resource_appraisal.yaml at 07:52:00Z) — confirmed by direct file-timestamp comparison, not
// assumed from "container is running".
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { ForbiddenException } from "@nestjs/common";
import {
  AuthzPermissionsController,
  computeEffectivePermissions,
  EFFECTIVE_PERMISSIONS_CAVEAT,
} from "./authz-permissions.controller";
import { can } from "../rbac/can";
import type { Principal, RoleGrant, PermissionGrant } from "../rbac/principal";
import permissionCatalog from "../rbac/permission-catalog.json";

/** Every `class: "grantable"` key in the catalog — the set superadmin's scope-level answer must
 *  cover in full. Derived, so retiring or adding a permission cannot leave this test asserting a
 *  number that no longer describes anything. */
const GRANTABLE_KEY_COUNT = (permissionCatalog.permissions as Array<{ class: string }>).filter(
  (p) => p.class === "grantable",
).length;
import roleBundles from "../rbac/role-permission-bundles.json";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";

const live = !!process.env.CERBOS_URL;
const T1 = "aaaaaaaa-0000-0000-0000-000000000001";
const T2 = "aaaaaaaa-0000-0000-0000-000000000002";

/** Tier 3 needs a principal whose `perms` matches what a REAL `assemblePrincipal()` would
 *  produce for a role that holds the Cerbos wildcard bypass — i.e. the migration-0094 bundle
 *  (`role-permission-bundles.json`, the same artifact IAM-02b's parity suite pins against live
 *  Cerbos), not just the bare role name. `can.scopeOnly()`/`computeEffectivePermissions()`
 *  answer PURELY from `perms` — a synthetic principal that sets only `roles` (as `can.test.ts`'s
 *  wildcard-bypass case correctly does for `can()`, which DOES consult the role arm) would report
 *  an empty `scopeLevelPermissions` here, which is correct for a principal that literally holds
 *  no permission rows — but does not exercise what this endpoint needs to prove for a REAL
 *  platform_admin/group_executive principal. */
function bundlePrincipal(role: "platform_admin" | "group_executive"): Principal {
  const keys = roleBundles.roles[role] as string[];
  return principal(
    [{ role, scopeType: "global", scopeId: null }],
    keys.map((key) => ({ key, scopeType: "global" as const, scopeId: null })),
    [],
  );
}

function principal(
  roles: RoleGrant[],
  perms: PermissionGrant[] = [],
  companies: string[] = [T1],
  sessionVersion = 1,
  userId = "u1",
): Principal {
  return { userId, assurance: "high", companies, roles, perms, sessionVersion };
}

function req(p: Principal, headers: Record<string, string> = {}): FastifyRequest {
  return { principal: p, headers } as unknown as FastifyRequest;
}

function mockReply() {
  const headers: Record<string, string> = {};
  let statusCode: number | undefined;
  const reply = {
    header: vi.fn((k: string, v: string) => {
      headers[k.toLowerCase()] = v;
      return reply;
    }),
    status: vi.fn((code: number) => {
      statusCode = code;
      return reply;
    }),
  } as unknown as FastifyReply;
  return { reply, headers, getStatus: () => statusCode };
}

// ───────────────────────────────────────────────────────────────────────────────────────────
// Tier 1 — pure computation, no Cerbos/DB/Nest.
// ───────────────────────────────────────────────────────────────────────────────────────────

describe("computeEffectivePermissions() — shape and scope correctness (no Cerbos needed)", () => {
  it("returns the requested scopeType/scopeId verbatim", () => {
    const body = computeEffectivePermissions(principal([]), { scopeType: "company", scopeId: T1 });
    expect(body.scopeType).toBe("company");
    expect(body.scopeId).toBe(T1);
  });

  it("names the field scopeLevelPermissions, not permissions/effectivePermissions, and carries the caveat verbatim", () => {
    const body = computeEffectivePermissions(principal([]), { scopeType: "company", scopeId: T1 });
    expect(body).toHaveProperty("scopeLevelPermissions");
    expect(body).not.toHaveProperty("permissions");
    expect(body).not.toHaveProperty("effectivePermissions");
    expect(body.caveat).toBe(EFFECTIVE_PERMISSIONS_CAVEAT);
    expect(body.caveat).toMatch(/may do X to any resource|OVER-report|can\(principal, key, resource\)/);
  });

  it("scopeLevelPermissions holds exactly the granted key at the exact scope, nothing else", () => {
    const p = principal([], [{ key: "pm.task.read", scopeType: "company", scopeId: T1 }]);
    const body = computeEffectivePermissions(p, { scopeType: "company", scopeId: T1 });
    expect(body.scopeLevelPermissions).toEqual(["pm.task.read"]);
  });

  it("excludes a grant held at a DIFFERENT company (no cross-tenant leak)", () => {
    const p = principal([], [{ key: "pm.task.read", scopeType: "company", scopeId: T1 }]);
    const body = computeEffectivePermissions(p, { scopeType: "company", scopeId: T2 });
    expect(body.scopeLevelPermissions).toEqual([]);
  });

  it("a global-scope grant is reported at every company scope asked about", () => {
    const p = principal([], [{ key: "pm.task.read", scopeType: "global", scopeId: null }]);
    expect(computeEffectivePermissions(p, { scopeType: "company", scopeId: T1 }).scopeLevelPermissions).toEqual([
      "pm.task.read",
    ]);
    expect(computeEffectivePermissions(p, { scopeType: "company", scopeId: T2 }).scopeLevelPermissions).toEqual([
      "pm.task.read",
    ]);
  });

  it("returns permission keys SORTED, for stable diffs/caching", () => {
    const p = principal(
      [],
      [
        { key: "pm.task.update", scopeType: "company", scopeId: T1 },
        { key: "core.task.read", scopeType: "company", scopeId: T1 },
      ],
    );
    const body = computeEffectivePermissions(p, { scopeType: "company", scopeId: T1 });
    expect(body.scopeLevelPermissions).toEqual(["core.task.read", "pm.task.update"]);
  });

  it("an empty principal (no roles, no perms) gets an empty scopeLevelPermissions — never throws", () => {
    const body = computeEffectivePermissions(principal([]), { scopeType: "company", scopeId: T1 });
    expect(body.scopeLevelPermissions).toEqual([]);
  });
});

describe("computeEffectivePermissions() — the 15 relationship-class permissions NEVER appear", () => {
  const relationshipKeys = (permissionCatalog.permissions as Array<{ key: string; class: string }>)
    .filter((p) => p.class === "relationship")
    .map((p) => p.key);

  it("the catalog carries exactly 15 relationship-class keys (sanity — this test's own premise)", () => {
    expect(relationshipKeys).toHaveLength(15);
  });

  it("excludedRelationshipClass lists exactly those 15 keys, sorted, regardless of principal", () => {
    const body = computeEffectivePermissions(principal([{ role: "platform_admin", scopeType: "global", scopeId: null }]), {
      scopeType: "global",
      scopeId: null,
    });
    expect(body.excludedRelationshipClass).toEqual([...relationshipKeys].sort());
  });

  it("scopeLevelPermissions never contains a relationship-class key — even if one were smuggled into perms", () => {
    // Defense-in-depth probe: principal.perms is structurally guaranteed (0093's trigger +
    // assemblePrincipal()'s own filter, IAM-03a) to never carry a relationship-class key, but this
    // handler does its OWN filtering (iterates only GRANTABLE_KEYS) rather than trusting that
    // upstream guarantee alone — so a synthetic principal that DOES carry one (simulating a future
    // regression upstream) must still not leak it through this endpoint.
    const smuggled: PermissionGrant = { key: "assistant.agent_run.read", scopeType: "global", scopeId: null };
    const p = principal([], [smuggled]);
    const body = computeEffectivePermissions(p, { scopeType: "company", scopeId: T1 });
    expect(body.scopeLevelPermissions).not.toContain("assistant.agent_run.read");
    for (const key of relationshipKeys) expect(body.scopeLevelPermissions).not.toContain(key);
  });
});

describe("computeEffectivePermissions() — wildcard bypass role disclosure", () => {
  it("flags platform_admin in wildcardBypassRoles", () => {
    const p = principal([{ role: "platform_admin", scopeType: "global", scopeId: null }]);
    const body = computeEffectivePermissions(p, { scopeType: "global", scopeId: null });
    expect(body.wildcardBypassRoles).toEqual(["platform_admin"]);
  });

  it("flags group_executive in wildcardBypassRoles", () => {
    const p = principal([{ role: "group_executive", scopeType: "global", scopeId: null }]);
    const body = computeEffectivePermissions(p, { scopeType: "global", scopeId: null });
    expect(body.wildcardBypassRoles).toEqual(["group_executive"]);
  });

  it("an ordinary role (manager) is NOT flagged", () => {
    const p = principal([{ role: "manager", scopeType: "company", scopeId: T1 }]);
    const body = computeEffectivePermissions(p, { scopeType: "company", scopeId: T1 });
    expect(body.wildcardBypassRoles).toEqual([]);
  });

  it("holding both bypass roles reports both, deduplicated and sorted", () => {
    const p = principal([
      { role: "platform_admin", scopeType: "global", scopeId: null },
      { role: "group_executive", scopeType: "global", scopeId: null },
      { role: "platform_admin", scopeType: "global", scopeId: null }, // duplicate grant row (Finding F shape)
    ]);
    const body = computeEffectivePermissions(p, { scopeType: "global", scopeId: null });
    expect(body.wildcardBypassRoles).toEqual(["group_executive", "platform_admin"]);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────
// Tier 2 — controller HTTP-facing behaviour: tenancy 403, caching/ETag/304, revocation.
// Direct instantiation + manufactured req/reply, no DB/Cerbos (same idiom as
// module-catalog.controller.test.ts / mcp-tools.controller.test.ts).
// ───────────────────────────────────────────────────────────────────────────────────────────

describe("AuthzPermissionsController.companyScoped — tenancy gate (403, never 404)", () => {
  it("403s a caller with no membership in tenantId and no global-admin bypass", () => {
    const p = principal([], [], [T2]); // member of T2 only
    const { reply } = mockReply();
    expect(() => new AuthzPermissionsController().companyScoped(req(p), reply, T1)).toThrow(ForbiddenException);
  });

  it("allows a member of tenantId through", () => {
    const p = principal([], [{ key: "pm.task.read", scopeType: "company", scopeId: T1 }], [T1]);
    const { reply } = mockReply();
    const body = new AuthzPermissionsController().companyScoped(req(p), reply, T1);
    expect(body?.scopeId).toBe(T1);
  });

  it("a global platform_admin (no membership anywhere) is NOT 403'd", () => {
    const p = principal([{ role: "platform_admin", scopeType: "global", scopeId: null }], [], []);
    const { reply } = mockReply();
    const body = new AuthzPermissionsController().companyScoped(req(p), reply, T1);
    expect(body?.scopeId).toBe(T1);
  });
});

describe("AuthzPermissionsController — caching: Cache-Control + ETag set; ETag is stable for an unchanged principal", () => {
  it("sets a private, revalidate-required Cache-Control and a quoted ETag", () => {
    const p = principal([], [{ key: "pm.task.read", scopeType: "company", scopeId: T1 }], [T1]);
    const { reply, headers } = mockReply();
    new AuthzPermissionsController().companyScoped(req(p), reply, T1);
    expect(headers["cache-control"]).toMatch(/private/);
    expect(headers["cache-control"]).toMatch(/must-revalidate/);
    expect(headers["etag"]).toMatch(/^"[0-9a-f]{64}"$/);
  });

  it("the SAME principal/scope produces the SAME ETag across two independent calls", () => {
    const p = principal([], [{ key: "pm.task.read", scopeType: "company", scopeId: T1 }], [T1]);
    const r1 = mockReply();
    const r2 = mockReply();
    new AuthzPermissionsController().companyScoped(req(p), r1.reply, T1);
    new AuthzPermissionsController().companyScoped(req(p), r2.reply, T1);
    expect(r1.headers["etag"]).toBe(r2.headers["etag"]);
  });

  it("a matching If-None-Match short-circuits to a bodyless 304", () => {
    const p = principal([], [{ key: "pm.task.read", scopeType: "company", scopeId: T1 }], [T1]);
    const first = mockReply();
    new AuthzPermissionsController().companyScoped(req(p), first.reply, T1);
    const etag = first.headers["etag"];

    const second = mockReply();
    const body = new AuthzPermissionsController().companyScoped(req(p, { "if-none-match": etag }), second.reply, T1);
    expect(second.getStatus()).toBe(304);
    expect(body).toBeUndefined();
  });

  it("a STALE If-None-Match (from before a permission change) does NOT 304 — the caller gets the fresh body", () => {
    const before = principal([], [{ key: "pm.task.read", scopeType: "company", scopeId: T1 }], [T1]);
    const first = mockReply();
    new AuthzPermissionsController().companyScoped(req(before), first.reply, T1);
    const staleEtag = first.headers["etag"];

    const after = principal(
      [],
      [
        { key: "pm.task.read", scopeType: "company", scopeId: T1 },
        { key: "pm.task.update", scopeType: "company", scopeId: T1 }, // gained a permission
      ],
      [T1],
    );
    const second = mockReply();
    const body = new AuthzPermissionsController().companyScoped(req(after, { "if-none-match": staleEtag }), second.reply, T1);
    expect(second.getStatus()).toBeUndefined(); // no 304 forced
    expect(body?.scopeLevelPermissions).toEqual(["pm.task.read", "pm.task.update"]);
  });
});

describe("AuthzPermissionsController — revocation (D11 session_version): a bumped session_version is never served a stale cache hit", () => {
  it("bumping sessionVersion alone (identical roles/perms/scope) changes the ETag", () => {
    const v1 = principal([], [{ key: "pm.task.read", scopeType: "company", scopeId: T1 }], [T1], 1);
    const v2 = principal([], [{ key: "pm.task.read", scopeType: "company", scopeId: T1 }], [T1], 2);
    const r1 = mockReply();
    const r2 = mockReply();
    new AuthzPermissionsController().companyScoped(req(v1), r1.reply, T1);
    new AuthzPermissionsController().companyScoped(req(v2), r2.reply, T1);
    expect(r1.headers["etag"]).not.toBe(r2.headers["etag"]);
  });

  it("an ETag minted under the OLD session_version does not 304 a request carrying the NEW one — a revoked/downgraded principal's cached tag is worthless", () => {
    const before = principal([], [{ key: "pm.task.read", scopeType: "company", scopeId: T1 }], [T1], 1);
    const first = mockReply();
    new AuthzPermissionsController().companyScoped(req(before), first.reply, T1);
    const oldEtag = first.headers["etag"];

    // Session revoked/re-issued (D11 bump) — same roles/perms, only session_version changed.
    const after = principal([], [{ key: "pm.task.read", scopeType: "company", scopeId: T1 }], [T1], 2);
    const second = mockReply();
    const body = new AuthzPermissionsController().companyScoped(req(after, { "if-none-match": oldEtag }), second.reply, T1);
    expect(second.getStatus()).toBeUndefined();
    expect(body).toBeDefined();
  });
});

describe("AuthzPermissionsController.globalScoped — no tenancy gate, answers the principal's global-scope grants", () => {
  it("a principal with zero company memberships still gets a body (group_executive shape)", () => {
    const p = principal([{ role: "group_executive", scopeType: "global", scopeId: null }], [], []);
    const { reply } = mockReply();
    const body = new AuthzPermissionsController().globalScoped(req(p), reply);
    expect(body?.scopeType).toBe("global");
    expect(body?.scopeId).toBeNull();
    expect(body?.wildcardBypassRoles).toEqual(["group_executive"]);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────
// Tier 3 — live Cerbos: proves scopeLevelPermissions actually reflects real reach, not just
// bundle shape. Full sweep for platform_admin (the ticket's #2 requirement, verified concretely
// rather than asserted from the bundle's known counts).
// ───────────────────────────────────────────────────────────────────────────────────────────

describe.skipIf(!live)("scopeLevelPermissions vs can() — live parity sweep (superadmin reach)", () => {
  it("platform_admin: EVERY grantable key that scopeLevelPermissions lists is ALSO granted by can() at the same scope", async () => {
    const p = bundlePrincipal("platform_admin");
    const body = computeEffectivePermissions(p, { scopeType: "company", scopeId: T1 });
    // DERIVED from the catalog, never written down. This was a literal `215` and went stale the
    // same day HIER-3 retired the `team` kind (4 `core.team.*` keys -> 211). A hardcoded count of a
    // deliberately-moving set is a tripwire that fires on CORRECT work, which trains readers to bump
    // the number without looking — and it does not even test what it appears to, since it passes
    // whenever the endpoint and the expectation are wrong by the same amount. The real property is
    // "superadmin's scope-level answer covers the WHOLE grantable catalog", so the catalog IS the
    // expected value.
    expect(body.scopeLevelPermissions).toHaveLength(GRANTABLE_KEY_COUNT);

    const mismatches: string[] = [];
    for (const key of body.scopeLevelPermissions) {
      // ⚠ `creatorId` is part of the PROBE, not decoration (added 2026-08-19 after this sweep went red).
      // `resource_automation_approval.yaml`'s `decide_override` / `decide_assignment` carry a
      // fail-closed DENY: a request whose creator is unknown ("" or absent) may not be decided by
      // anyone, platform_admin's wildcard included, because deny-overrides beats every ALLOW. And
      // `resourcePayload()` defaults an omitted `creatorId` to `""` — so the old probe tripped that
      // DENY by construction and the two keys reported as mismatches. The policy was right; the PROBE
      // was unsatisfiable, which is the same shape as positions.controller.ts's "rule a handler can
      // never satisfy" note. A creator who is somebody ELSE is the case this sweep means to ask about;
      // the requester-is-decider refusal has its own dedicated tests.
      const allowed = await can(p, key, {
        id: "probe-1", tenantId: T1, ownerId: "u1", subjectUserId: "u1", module: "hr", creatorId: "someone-else",
      });
      if (!allowed) mismatches.push(key);
    }
    expect(mismatches).toEqual([]);
  }, 60_000);

  it("platform_admin does NOT reach the 15 relationship-class keys even via can() — the bypass is correctly absent there (no wildcard rule on those kinds)", async () => {
    const p = bundlePrincipal("platform_admin");
    const denied: string[] = [];
    for (const key of computeEffectivePermissions(p, { scopeType: "global", scopeId: null }).excludedRelationshipClass) {
      const allowed = await can(p, key, { id: "probe-1", tenantId: T1, ownerId: "someone-else", origin: "assistant_handoff" });
      if (allowed) denied.push(key); // name collected on an unexpected ALLOW
    }
    expect(denied).toEqual([]);
  }, 30_000);

  it("group_executive: scopeLevelPermissions is a SUBSET of what can() would grant (no over-report) — spot-checked across its bundle", async () => {
    const p = bundlePrincipal("group_executive");
    const body = computeEffectivePermissions(p, { scopeType: "company", scopeId: T1 });
    expect(body.wildcardBypassRoles).toEqual(["group_executive"]);
    // Spot check (not exhaustive — 118 keys, sampled) rather than the full sweep the platform_admin
    // test does, to keep runtime bounded; the exhaustive guarantee for this role already lives in
    // IAM-02b's parity suite (22/22, teeth-proven) which this endpoint's computation reuses via
    // can.scopeOnly() -> principal.perms, the same data that suite pins.
    const sample = body.scopeLevelPermissions.filter((_, i) => i % 12 === 0);
    for (const key of sample) {
      // Same `creatorId` reasoning as the platform_admin sweep above — and it matters here even though
      // the sample is strided, because which keys the stride lands on moves with the catalog.
      expect(
        await can(p, key, {
          id: "probe-1", tenantId: T1, ownerId: "u1", subjectUserId: "u1", module: "hr", creatorId: "someone-else",
        }),
      ).toBe(true);
    }
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────────────────────
// Tier 4 — the REAL HTTP surface, through the actual Nest+Fastify stack (buildApp() +
// app.inject(), same idiom as tasks-mine.test.ts / webdev-change-requests.controller.test.ts).
// Closes the gap Tier 2's mocked-reply tests cannot: does @Res({passthrough:true}) really
// produce a bodyless 304 with the ETag header set, over the wire, once app.module.ts's
// registration of AuthzPermissionsController goes through Nest's real bootstrap?
// ───────────────────────────────────────────────────────────────────────────────────────────

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("AuthzPermissionsController — real HTTP surface (buildApp + inject)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let coOther: string;
  let member: string;
  let outsider: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("IAM-05c Co");
    coOther = await createCompany("IAM-05c Co (unrelated)");
    member = await createUser("iam05c-member@a.test");
    outsider = await createUser("iam05c-outsider@a.test");
    await addMembership(co, member);
    await addMembership(coOther, outsider);
    const roleMember = await createRole("member");
    await grantRole(member, roleMember, "company", co);
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  it("GET /api/:tenantId/authz/permissions — 200, real body shape, real Cache-Control/ETag headers over the wire", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/authz/permissions`, headers: asUser(member) });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.scopeType).toBe("company");
    expect(body.scopeId).toBe(co);
    expect(Array.isArray(body.scopeLevelPermissions)).toBe(true);
    expect(body.excludedRelationshipClass).toHaveLength(15);
    expect(body.caveat).toBe(EFFECTIVE_PERMISSIONS_CAVEAT);
    expect(r.headers["cache-control"]).toMatch(/private/);
    expect(r.headers["etag"]).toMatch(/^"[0-9a-f]{64}"$/);
  });

  it("a repeat GET with If-None-Match: <etag from the prior response> gets a REAL bodyless 304 from Fastify", async () => {
    const first = await app.inject({ method: "GET", url: `/api/${co}/authz/permissions`, headers: asUser(member) });
    const etag = first.headers["etag"] as string;

    const second = await app.inject({
      method: "GET",
      url: `/api/${co}/authz/permissions`,
      headers: { ...asUser(member), "if-none-match": etag },
    });
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe("");
  });

  it("a non-member gets a REAL 403, never a 404, over the wire", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${coOther}/authz/permissions`, headers: asUser(member) });
    expect(r.statusCode).toBe(403);
    expect(r.statusCode).not.toBe(404);
  });

  it("GET /api/authz/permissions (global scope) — 200 with no tenancy gate", async () => {
    const r = await app.inject({ method: "GET", url: `/api/authz/permissions`, headers: asUser(outsider) });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.scopeType).toBe("global");
    expect(body.scopeId).toBeNull();
  });
});
