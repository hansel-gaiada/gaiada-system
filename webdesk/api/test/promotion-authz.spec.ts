// WSK-25 unification (owner ruling 2026-08-27) — proves the swap from this module's own
// assertPromotionCommandAuthorized() to the registry-driven CommandAuthorizationGuard did NOT
// loosen enforcement.
//
// This file exists because the existing promotion suites always send a valid scope AND a valid WS4
// assertion, so they would pass even if the guard were disarmed entirely. That is exactly how the
// `schema.aiDraft` hole stayed invisible: a route with no @Command metadata leaves
// CommandAuthorizationGuard listed in @UseGuards and enforcing nothing. Every assertion below is a
// REFUSAL, plus positive controls so the suite cannot pass by refusing everything.
process.env.NODE_ENV = "test";
process.env.APP_DATABASE_URL =
  process.env.WSK25_TEST_DATABASE_URL || "postgres://webdesk_app:throwaway_app@localhost:55495/webdesk";
process.env.API_KEY_PEPPER = "wsk25-authz-test-pepper-never-used-outside-this-suite";
process.env.WEBDESK_READ_QUOTA_PER_MIN = process.env.WEBDESK_READ_QUOTA_PER_MIN || "1000";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ControlModule } from "../src/control/control.module";
import { PromotionModule } from "../src/promotion/promotion.module";
import { PromotionController } from "../src/promotion/promotion.controller";
import { COMMAND_META_KEY } from "../src/control/command.decorator";
import { COMMAND_REGISTRY } from "../src/control/command-types";

let app: NestFastifyApplication;

function headers(opts: { scopes: string[]; ws4?: string }) {
  const h: Record<string, string> = {
    "x-webdesk-control-principal": "wsk25-authz-test",
    "x-webdesk-control-scopes": opts.scopes.join(","),
    "idempotency-key": randomUUID(),
  };
  if (opts.ws4) h["x-webdesk-ws4-approval-id"] = opts.ws4;
  return h;
}

async function provision() {
  const slug = `wsk25authz-${randomUUID().slice(0, 8)}`;
  const t = await app.inject({
    method: "POST",
    url: "/control/v1/tenants",
    headers: headers({ scopes: ["webdesk:operate"] }),
    payload: { slug, companyRef: randomUUID() },
  });
  expect(t.statusCode, `tenant provision failed: ${t.body.slice(0, 200)}`).toBe(201);
  const s = await app.inject({
    method: "POST",
    url: `/control/v1/tenants/${slug}/sites`,
    headers: headers({ scopes: ["webdesk:operate"] }),
    payload: { kind: "astro", name: "site-a" },
  });
  const siteId = s.json().site.id as string;
  const e = await app.inject({
    method: "POST",
    url: `/control/v1/tenants/${slug}/sites/${siteId}/environments`,
    headers: headers({ scopes: ["webdesk:operate"] }),
    payload: { name: "production" },
  });
  return { slug, siteId, envId: e.json().environment.id as string };
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [ControlModule, PromotionModule] }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: ["error"] });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app.close();
});

describe("promotion authorization is registry-driven, and still refuses", () => {
  it("all three routes carry @Command metadata — without it the guard is DISARMED, not absent", () => {
    const reflector = new Reflector();
    const expected: Array<[string, string]> = [
      ["exportContent", "content.export"],
      ["promote", "content.promote"],
      ["rollback", "content.rollback"],
    ];
    for (const [method, command] of expected) {
      const handler = (PromotionController.prototype as unknown as Record<string, unknown>)[method];
      expect(handler, `PromotionController.${method} does not exist — update this list`).toBeTypeOf("function");
      expect(reflector.get(COMMAND_META_KEY, handler as () => unknown), `${method} lost its @Command`).toBe(command);
    }
  });

  it("the registry classifies them exactly as the old imperative check did", () => {
    // export: webdesk:read, no WS4. promote/rollback: webdesk:promote AND always WS4, which is
    // what impactClass "high" means to the PolicyDecisionPoint. If someone downgrades promote to
    // "medium" to make a test pass, the WS4 requirement silently disappears — hence this assertion.
    expect(COMMAND_REGISTRY["content.export"]).toMatchObject({ impactClass: "read", scope: "webdesk:read" });
    expect(COMMAND_REGISTRY["content.promote"]).toMatchObject({ impactClass: "high", scope: "webdesk:promote" });
    expect(COMMAND_REGISTRY["content.rollback"]).toMatchObject({ impactClass: "high", scope: "webdesk:promote" });
  });

  it("REFUSES content.promote with the right scope but NO WS4 assertion", async () => {
    const { slug, siteId, envId } = await provision();
    const res = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${slug}/sites/${siteId}/environments/${envId}/content-promote`,
      headers: headers({ scopes: ["webdesk:promote"] }), // deliberately no ws4
      payload: { version: "v1", bundle: { collections: [], contentItems: [], mediaAssets: [] } },
    });
    expect(res.statusCode).toBe(403);
  });

  it("REFUSES content.rollback with the right scope but NO WS4 assertion", async () => {
    const { slug, siteId, envId } = await provision();
    const res = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${slug}/sites/${siteId}/environments/${envId}/content-rollback`,
      headers: headers({ scopes: ["webdesk:promote"] }), // deliberately no ws4
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it("REFUSES content.promote presented with a READ-only scope, even WITH a WS4 assertion", async () => {
    const { slug, siteId, envId } = await provision();
    const res = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${slug}/sites/${siteId}/environments/${envId}/content-promote`,
      headers: headers({ scopes: ["webdesk:read"], ws4: randomUUID() }),
      payload: { version: "v1", bundle: { collections: [], contentItems: [], mediaAssets: [] } },
    });
    expect(res.statusCode).toBe(403);
  });

  it("REFUSES content.export presented with ZERO scopes", async () => {
    const { slug, siteId } = await provision();
    const res = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${slug}/sites/${siteId}/content-export`,
      headers: headers({ scopes: [] }),
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it("POSITIVE CONTROL: content.export with webdesk:read succeeds — the guard is not always-refuse", async () => {
    const { slug, siteId } = await provision();
    const res = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${slug}/sites/${siteId}/content-export`,
      headers: headers({ scopes: ["webdesk:read"] }),
      payload: {},
    });
    expect(res.statusCode, res.body.slice(0, 300)).toBeLessThan(300);
  });

  it("POSITIVE CONTROL: content.promote with webdesk:promote AND a WS4 assertion succeeds", async () => {
    const { slug, siteId, envId } = await provision();
    const res = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${slug}/sites/${siteId}/environments/${envId}/content-promote`,
      headers: headers({ scopes: ["webdesk:promote"], ws4: randomUUID() }),
      payload: { version: "v1", bundle: { collections: [], contentItems: [], mediaAssets: [] } },
    });
    expect(res.statusCode, res.body.slice(0, 300)).toBeLessThan(300);
  });
});
