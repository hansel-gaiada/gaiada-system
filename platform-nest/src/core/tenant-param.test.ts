// A malformed `:tenantId` is a BAD REQUEST, not a server fault. Before this hook, both
// `/api/undefined/projects` and its PM-module sibling answered 500 `[unhandled-exception]` — the
// raw segment travelled all the way to a uuid cast inside RLS. See tenant-param.ts's header.
//
// ⚠ DO NOT WRITE A REAL MODULE'S ROUTE PATH IN THIS FILE — not in a route, not in a URL, NOT IN A
// COMMENT. `capability-inventory.test.ts` counts "suites driving the real endpoint" by scanning
// every `*.test.ts` as PLAIN TEXT for `app.inject` plus `/api/…/<family>`, so a path written
// anywhere in here makes this suite — which stands up a bare Fastify app and drives no module at
// all — count as a driver for that module. It inflated the PM row by one on first write, and the
// prose mention of the incident path inflated it again after the route itself was renamed. An
// over-count in that table is not cosmetic: the table exists to be believed about coverage.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerTenantParamValidation, isTenantIdShaped, TENANT_PARAM } from "./tenant-param";

const REAL_UUID = "0197f3a0-1c2d-7f00-8a3b-9c1d2e3f4a5b";

describe("isTenantIdShaped", () => {
  it("accepts a uuid and nothing else", () => {
    expect(isTenantIdShaped(REAL_UUID)).toBe(true);
    expect(isTenantIdShaped(REAL_UUID.toUpperCase())).toBe(true);
    expect(isTenantIdShaped("undefined")).toBe(false);
    expect(isTenantIdShaped("not-a-uuid")).toBe(false);
    expect(isTenantIdShaped("")).toBe(false);
    expect(isTenantIdShaped(`${REAL_UUID}x`)).toBe(false);
    expect(isTenantIdShaped(undefined)).toBe(false);
    expect(isTenantIdShaped(123)).toBe(false);
  });

  it("names the parameter the controllers actually declare", () => {
    expect(TENANT_PARAM).toBe("tenantId");
  });
});

// Driven against a real Fastify instance rather than the Nest app: the hook is registered on the
// root Fastify instance (main.ts) and its whole contract is a router-level one — which routes carry
// a `tenantId` param, and what the lifecycle does when one is malformed.
describe("the :tenantId preValidation hook", () => {
  let app: FastifyInstance;
  let reachedHandler: string[] = [];

  beforeAll(async () => {
    app = Fastify();
    // Registered BEFORE the routes, exactly as main.ts registers it before app.init(): Fastify
    // snapshots the root hook list into each route's context at registration time.
    registerTenantParamValidation(app);
    app.get("/api/:tenantId/projects", async (req) => {
      reachedHandler.push((req.params as { tenantId: string }).tenantId);
      return { ok: true };
    });
    // A second tenant-scoped route, under an INVENTED family — see the file header for why a real
    // module's name must never appear here. Two routes rather than one because the hook's contract
    // is "every route that declares the param", not "the one route we happened to test".
    app.get("/api/:tenantId/widgets/items", async () => ({ ok: true }));
    // A STATIC segment in the same position — Fastify's router prefers it, so `params.tenantId`
    // is undefined here and the hook must stay out of the way entirely.
    app.get("/api/admin/companies", async () => ({ ok: true }));
    // A route with no tenant param at all.
    app.get("/health", async () => ({ ok: true }));
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const get = (url: string) => app.inject({ method: "GET", url });

  it("400s the literal string 'undefined' — the value a client sends when its id was missing", async () => {
    reachedHandler = [];
    const res = await get("/api/undefined/projects");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("invalid tenantId");
    expect(res.json().error).toContain("undefined");
    expect(reachedHandler).toEqual([]); // never reached a handler, so never reached a uuid cast
  });

  it("400s any other non-uuid segment, on every tenant-scoped route", async () => {
    expect((await get("/api/not-a-uuid/widgets/items")).statusCode).toBe(400);
    expect((await get("/api/null/projects")).statusCode).toBe(400);
    expect((await get("/api/1/projects")).statusCode).toBe(400);
  });

  it("returns the { error } body shape the UI and bot read", async () => {
    const body = (await get("/api/nope/projects")).json();
    expect(Object.keys(body)).toEqual(["error"]);
    expect(typeof body.error).toBe("string");
  });

  it("bounds the echoed value — it is attacker-controlled and lands in a log line", async () => {
    // 80 chars: past the 64-char clip, but under Fastify's default `maxParamLength` of 100, which
    // rejects anything longer with a 404 before a hook ever runs.
    const res = await get(`/api/${"a".repeat(80)}/projects`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("…");
    expect(res.json().error).not.toContain("a".repeat(80));
  });

  it("lets a well-formed uuid through untouched — this is a SHAPE check, not authorization", async () => {
    reachedHandler = [];
    const res = await get(`/api/${REAL_UUID}/projects`);
    expect(res.statusCode).toBe(200);
    expect(reachedHandler).toEqual([REAL_UUID]);
  });

  it("never fires on a route whose matching segment is static, or which has no tenant param", async () => {
    expect((await get("/api/admin/companies")).statusCode).toBe(200);
    expect((await get("/health")).statusCode).toBe(200);
  });
});
