// M5-W1b — the writers' room grant path, the parts that need NO service: body/param validation, the MCP tool defs and
// their impact classes, the D14 pairing (registry entries + the Cerbos executable list), the site proof read from
// WebDesk (against a stub), and every refusal the choke point makes BEFORE it touches the database (a client that
// throws on any query proves "before"). The DB + Cerbos + HTTP half is webdesk-editorial-grants.test.ts and
// src/admin/editorial-grant.db.test.ts (the Linux gate).
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { webdevModule } from "./index";
import {
  EDITORIAL_GRANT_BODY_KEYS, parseEditorialGrantBody, parseEditorialRevokeParams, verifyEditorialSite,
} from "./webdesk-editorial-grants.service";
import type { WebdeskZoneB } from "./webdesk-content.service";
import { EDITORIAL_ROLES } from "../../rbac/editorial-roles";
import {
  assertGrantAllowed, grantEditorialRole, revokeEditorialRole, type GrantOrigin, type VerifiedEditorialSite,
} from "../../admin/grant-write.service";
import {
  getExecutable, registerExecutableApproval, resetExecutableApprovals, registerWebdeskExecutableApprovals,
  WEBDESK_EDITORIAL_REGISTRY_TOOLS,
} from "../../core/approval-executables";

const T = "0f1e2d3c-4b5a-4968-8776-655443322110";
const SITE = "0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4";
const USER = "9c8b7a65-4d3e-4f21-8a0b-1c2d3e4f5a6b";
const ACTOR = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const NOW = Date.parse("2026-10-12T00:00:00Z");
const status = (fn: () => unknown): number | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as { getStatus?: () => number }).getStatus?.();
  }
  return undefined;
};

describe("parseEditorialGrantBody (strict, after authorization)", () => {
  const good = { userId: USER, role: "webdesk_writer", collections: ["post"], locales: ["en"] };

  it("accepts a valid body and normalises the scope; expiresAt defaults to null", () => {
    expect(parseEditorialGrantBody(good, NOW)).toEqual({
      userId: USER, role: "webdesk_writer",
      scope: { allCollections: false, collections: ["post"], allLocales: false, locales: ["en"] },
      expiresAt: null,
    });
    expect(parseEditorialGrantBody({ userId: USER, role: "webdesk_editor", allCollections: true, allLocales: true, expiresAt: "2026-12-01T00:00:00Z" }, NOW))
      .toEqual({
        userId: USER, role: "webdesk_editor",
        scope: { allCollections: true, collections: [], allLocales: true, locales: [] },
        expiresAt: "2026-12-01T00:00:00.000Z",
      });
    expect(parseEditorialGrantBody({ ...good, expiresAt: null }, NOW).expiresAt).toBeNull();
  });

  it.each([
    ["an unknown key", { ...good, scopeType: "global" }],
    ["a role outside the four", { ...good, role: "webdev_manager" }],
    ["client_website_editor", { ...good, role: "client_website_editor" }],
    ["a missing userId", { role: "webdesk_writer", collections: ["post"], locales: ["en"] }],
    ["a non-uuid userId", { ...good, userId: "bob" }],
    ["an empty collection list", { ...good, collections: [] }],
    ["no locales", { userId: USER, role: "webdesk_writer", collections: ["post"] }],
    ["an expiry in the past", { ...good, expiresAt: "2026-01-01T00:00:00Z" }],
    ["an unparsable expiry", { ...good, expiresAt: "soon" }],
    ["a non-object body", ["webdesk_writer"]],
  ])("refuses %s with 400", (_l, body) => {
    expect(status(() => parseEditorialGrantBody(body, NOW))).toBe(400);
  });

  it("the allowed keys are exactly the documented ones (no scope type, no tenant, no position, no permission)", () => {
    expect([...EDITORIAL_GRANT_BODY_KEYS].sort()).toEqual(["allCollections", "allLocales", "collections", "expiresAt", "locales", "role", "userId"]);
  });

  it("parseEditorialRevokeParams: a uuid and one of the four roles", () => {
    expect(parseEditorialRevokeParams(USER, "webdesk_seo_reviewer")).toEqual({ userId: USER, role: "webdesk_seo_reviewer" });
    expect(status(() => parseEditorialRevokeParams("x", "webdesk_writer"))).toBe(400);
    expect(status(() => parseEditorialRevokeParams(USER, "manager"))).toBe(400);
  });
});

describe("the MCP tools and their impact classes (agentic-native: every capability is an endpoint AND a tool)", () => {
  // M5-W2d added the review-flow tools under the same prefix; this block is the W1b grant tools only.
  const defs = () => webdevModule.mcpTools.filter((t) => /^webdesk.editorial.(listGrants|grantRole|revokeRole)$/.test(t.name));
  const BASE = "/api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/editorial/grants";

  it("three tools: listGrants (read), grantRole (HIGH write), revokeRole (MEDIUM write), on the BFF routes", () => {
    const byName = new Map(defs().map((d) => [d.name, d]));
    expect([...byName.keys()].sort()).toEqual(["webdesk.editorial.grantRole", "webdesk.editorial.listGrants", "webdesk.editorial.revokeRole"]);
    const list = byName.get("webdesk.editorial.listGrants")!;
    expect([list.method ?? "GET", list.write ?? false, list.impact, list.pathTemplate]).toEqual(["GET", false, undefined, BASE]);
    const grant = byName.get("webdesk.editorial.grantRole")!;
    expect([grant.method, grant.write, grant.impact, grant.pathTemplate]).toEqual(["POST", true, "high", BASE]);
    const revoke = byName.get("webdesk.editorial.revokeRole")!;
    expect([revoke.method, revoke.write, revoke.impact, revoke.pathTemplate]).toEqual(["DELETE", true, "medium", `${BASE}/:userId/:role`]);
    for (const d of defs()) expect(d.minAssurance, d.name).toBe("verified");
  });

  it("the role enum the tools advertise is exactly the four, and grantRole sends exactly the BFF's body keys", () => {
    for (const d of defs().filter((x) => x.write)) {
      const props = (d.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties;
      expect(props.role.enum, d.name).toEqual([...EDITORIAL_ROLES]);
    }
    const grant = defs().find((d) => d.name === "webdesk.editorial.grantRole")!;
    const props = Object.keys((grant.inputSchema as { properties: Record<string, unknown> }).properties);
    const pathArgs = ["tenantId", "tenantSlug", "siteId"];
    expect(props.filter((p) => !pathArgs.includes(p)).sort()).toEqual([...EDITORIAL_GRANT_BODY_KEYS].sort());
  });
});

describe("the D14 pairing: registry entries AND the Cerbos executable list, both", () => {
  beforeEach(() => {
    resetExecutableApprovals();
    registerWebdeskExecutableApprovals();
  });

  it("both write tools are registered (real lockKey + precondition), the read is not", () => {
    expect([...WEBDESK_EDITORIAL_REGISTRY_TOOLS]).toEqual(["webdesk.editorial.grantRole", "webdesk.editorial.revokeRole"]);
    for (const n of WEBDESK_EDITORIAL_REGISTRY_TOOLS) {
      expect(getExecutable(n), n).toBeDefined();
      expect(() => registerExecutableApproval({ toolName: n })).toThrow(/already registered/i);
    }
    expect(getExecutable("webdesk.editorial.listGrants")).toBeUndefined();
  });

  it("resource_mcp_tool.yaml's executable list names both (an entry without it would be denied at the hub's door)", () => {
    const yaml = readFileSync(join(__dirname, "../../../cerbos/policies/resource_mcp_tool.yaml"), "utf8");
    const list = yaml.slice(yaml.indexOf('request.resource.attr.name in ["deploy.staging"'));
    const bracket = list.slice(0, list.indexOf("])"));
    for (const n of WEBDESK_EDITORIAL_REGISTRY_TOOLS) expect(bracket).toContain(`"${n}"`);
    expect(bracket).not.toContain('"webdesk.editorial.listGrants"');
  });

  it("grantRole precondition: structural (ids, role, scope shape, an expiry that has not passed)", async () => {
    const e = getExecutable("webdesk.editorial.grantRole")!;
    const ok = { tenantId: T, tenantSlug: "gaiada", siteId: SITE, userId: USER, role: "webdesk_writer", collections: ["post"], locales: ["en"] };
    const c = {} as never;
    expect(await e.precondition(c, ok)).toEqual({ ok: true });
    expect(await e.precondition(c, { ...ok, role: "manager" })).toEqual({ ok: false, reason: "role_invalid" });
    expect(await e.precondition(c, { ...ok, userId: "x" })).toEqual({ ok: false, reason: "user_id_invalid" });
    expect(await e.precondition(c, { ...ok, siteId: "x" })).toEqual({ ok: false, reason: "site_id_invalid" });
    expect(await e.precondition(c, { ...ok, tenantSlug: "" })).toEqual({ ok: false, reason: "tenant_slug_invalid" });
    expect(await e.precondition(c, { ...ok, collections: [] })).toEqual({ ok: false, reason: "scope_invalid" });
    expect(await e.precondition(c, { ...ok, expiresAt: "2020-01-01T00:00:00Z" })).toEqual({ ok: false, reason: "expires_at_passed" });
    expect(await e.precondition(c, { ...ok, expiresAt: "never" })).toEqual({ ok: false, reason: "expires_at_invalid" });
  });

  it("revokeRole precondition: structural; lockKey is (person, site) for both tools, malformed args never collide", async () => {
    const g = getExecutable("webdesk.editorial.grantRole")!;
    const r = getExecutable("webdesk.editorial.revokeRole")!;
    const ok = { tenantId: T, tenantSlug: "gaiada", siteId: SITE, userId: USER, role: "webdesk_editor" };
    expect(await r.precondition({} as never, ok)).toEqual({ ok: true });
    expect(await r.precondition({} as never, { ...ok, role: "client_website_editor" })).toEqual({ ok: false, reason: "role_invalid" });
    expect(g.lockKey(ok)).toBe(`webdesk:editorial:${USER}:${SITE}`);
    expect(r.lockKey(ok)).toBe(g.lockKey(ok));
    expect(new Set([g.lockKey({}), g.lockKey({ userId: USER }), g.lockKey({ siteId: SITE })]).size).toBe(3);
  });
});

describe("verifyEditorialSite: the proof comes from WebDesk (the wall, then collection.list), never from the caller", () => {
  it("returns the site's collection keys and the tenant's locales", async () => {
    const calls: string[] = [];
    const zb = {
      async resolveEditableSite(companyId: string, slug: string, siteId: string) {
        calls.push(`wall:${companyId}:${slug}:${siteId}`);
        return { tenant: { slug, status: "active", defaultLocale: "en", locales: ["en", "id"], sites: [] }, site: { siteId, name: "Main", kind: "astro", environments: [] } };
      },
      async read(req: { command: string }) {
        calls.push(req.command);
        return { status: 200, body: { collections: [{ key: "post" }, { key: "guide" }, { nokey: true }] } };
      },
    } as unknown as WebdeskZoneB;
    expect(await verifyEditorialSite(zb, T, { tenantSlug: "gaiada", siteId: SITE })).toEqual({
      tenantSlug: "gaiada", siteId: SITE, collectionKeys: ["post", "guide"], locales: ["en", "id"],
    });
    expect(calls).toEqual([`wall:${T}:gaiada:${SITE}`, "collection.list"]); // the wall FIRST
  });

  it("a malformed collection.list answer is a 502, never an empty proof", async () => {
    const zb = {
      async resolveEditableSite() { return { tenant: { locales: ["en"] }, site: {} }; },
      async read() { return { status: 200, body: { nope: [] } }; },
    } as unknown as WebdeskZoneB;
    await expect(verifyEditorialSite(zb, T, { tenantSlug: "gaiada", siteId: SITE })).rejects.toMatchObject({ status: 502 });
  });
});

describe("the choke point refuses BEFORE any database read", () => {
  // Any query is a test failure: these refusals must not depend on (or cost) a database round trip.
  const noDb = { query: async () => { throw new Error("the database was touched"); } } as unknown as PoolClient;
  const site: VerifiedEditorialSite = { tenantSlug: "gaiada", siteId: SITE, collectionKeys: ["post", "guide"], locales: ["en", "id"] };
  const spec = {
    tenantId: T, tenantSlug: "gaiada", siteId: SITE, targetUserId: USER, role: "webdesk_writer",
    scope: { collections: ["post"], locales: ["en"] }, expiresAt: null, actorUserId: ACTOR,
  };
  const reason = async (p: Promise<unknown>) => {
    try {
      await p;
      return "resolved";
    } catch (e) {
      const r = (e as { getResponse?: () => unknown }).getResponse?.();
      return typeof r === "object" && r && "message" in r ? String((r as { message: unknown }).message) : (e as Error).message;
    }
  };

  it.each([
    ["a role outside the four", { role: "manager" }, /role must be one of/],
    ["a non-uuid target", { targetUserId: "bob" }, /must be uuids/],
    ["an unknown collection", { scope: { collections: ["case-study"], locales: ["en"] } }, /unknown_collection/],
    ["an unknown locale", { scope: { collections: ["post"], locales: ["fr"] } }, /unknown_locale/],
    ["an empty scope list", { scope: { collections: [], locales: ["en"] } }, /invalid_request/],
    ["an expiry in the past", { expiresAt: "2020-01-01T00:00:00Z" }, /expiresAt/],
    ["a self-grant", { actorUserId: USER }, /self_grant_forbidden/],
  ])("grant: %s", async (_l, over, re) => {
    expect(await reason(grantEditorialRole(noDb, { ...spec, ...over }, site))).toMatch(re);
  });

  it("grant: a proof for ANOTHER site is a programming error, never a grant", async () => {
    expect(await reason(grantEditorialRole(noDb, spec, { ...site, siteId: "5d6e7f80-91a2-4b3c-8d4e-5f6a7b8c9d0e" }))).toMatch(/verified site does not match/);
  });

  it("revoke: a role outside the four and a non-uuid id are refused before any read", async () => {
    expect(await reason(revokeEditorialRole(noDb, { tenantId: T, siteId: SITE, targetUserId: USER, role: "client_website_editor" }))).toMatch(/role must be one of/);
    expect(await reason(revokeEditorialRole(noDb, { tenantId: T, siteId: "x", targetUserId: USER, role: "webdesk_writer" }))).toMatch(/must be uuids/);
  });

  it("assertGrantAllowed refuses the four roles by name on every generic origin (editorial_role_dedicated_path)", async () => {
    for (const role of EDITORIAL_ROLES) {
      for (const origin of ["legacy_admin", "ui", "two_person_appointment"] as GrantOrigin[]) {
        const queries: string[] = [];
        const c = {
          query: async (sql: string) => {
            queries.push(sql);
            return { rows: [{ name: role }], rowCount: 1 };
          },
        } as unknown as PoolClient;
        const r = await reason(assertGrantAllowed(c, {
          origin, targetUserId: USER, roleId: "11111111-2222-4333-8444-555555555555", scopeType: "company", scopeId: T,
          actorUserId: ACTOR, tenantId: T, onConflict: "unique_columns",
        }));
        expect(r, `${origin} ${role}`).toMatch(/^editorial_role_dedicated_path/);
        // M5-W1d: the target's `users.kind` is read first (a contributor target is refused on every generic origin),
        // then the role name; nothing else is read before the refusal.
        expect(queries.length, `${origin} ${role}: only the target-kind read and the role-name read`).toBe(2);
        expect(queries[0], `${origin} ${role}`).toMatch(/SELECT kind FROM users/);
      }
    }
  });
});
