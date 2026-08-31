// WSK-21 — the authorization-seam matrix: ControlAuthGuard (dev-mode principal stub) +
// CommandAuthorizationGuard (scope + WS4-presence check, design §03 Layers 3/4). Verification
// runbook: see ../README.md's "WSK-21 — Control-plane API v1" section (throwaway Postgres, own
// port block, exact env vars).
process.env.NODE_ENV = "test";
process.env.APP_DATABASE_URL =
  process.env.WSK21_TEST_DATABASE_URL || "postgres://webdesk_app:throwaway_app@localhost:55490/webdesk";
process.env.API_KEY_PEPPER = "wsk21-test-pepper-never-used-outside-this-suite";
process.env.WEBDESK_READ_QUOTA_PER_MIN = process.env.WEBDESK_READ_QUOTA_PER_MIN || "1000";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ControlModule } from "../src/control/control.module";

async function buildControlApp(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [ControlModule] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: ["error"] });
  await app.init();
  return app;
}

function headers(opts: { subject?: string | null; scopes?: string[]; ws4?: string; idempotencyKey?: string }) {
  const h: Record<string, string> = {};
  if (opts.subject !== null) h["x-webdesk-control-principal"] = opts.subject ?? "wsk21-authz-test";
  if (opts.scopes) h["x-webdesk-control-scopes"] = opts.scopes.join(",");
  if (opts.ws4) h["x-webdesk-ws4-approval-id"] = opts.ws4;
  if (opts.idempotencyKey) h["idempotency-key"] = opts.idempotencyKey;
  return h;
}

function freshSlug() {
  return `wsk21-authz-${randomUUID().slice(0, 8)}`;
}

describe("control-plane authorization seam (dev-mode stub) — ControlAuthGuard + CommandAuthorizationGuard", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await buildControlApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("refuses with no control-channel principal at all — fail closed (401)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/control/v1/tenants",
      headers: headers({ subject: null, scopes: ["webdesk:operate"], idempotencyKey: randomUUID() }),
      payload: { slug: freshSlug(), companyRef: randomUUID() },
    });
    expect(res.statusCode).toBe(401);
  });

  it("refuses a medium command when the principal lacks webdesk:operate (403)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/control/v1/tenants",
      headers: headers({ scopes: ["webdesk:read"], idempotencyKey: randomUUID() }),
      payload: { slug: freshSlug(), companyRef: randomUUID() },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/webdesk:operate/);
  });

  it("refuses a HIGH command with the right scope but no WS4 assertion (403, names §03 Layer 4)", async () => {
    // Provision a tenant first (medium, no WS4 needed) so archive has something real to refuse on.
    const slug = freshSlug();
    const provision = await app.inject({
      method: "POST",
      url: "/control/v1/tenants",
      headers: headers({ scopes: ["webdesk:operate"], idempotencyKey: randomUUID() }),
      payload: { slug, companyRef: randomUUID() },
    });
    expect(provision.statusCode).toBe(201);

    const archive = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${slug}/archive`,
      headers: headers({ scopes: ["webdesk:promote"], idempotencyKey: randomUUID() }), // no ws4
    });
    expect(archive.statusCode).toBe(403);
    expect(archive.json().message).toMatch(/WS4 assertion/);
  });

  it("succeeds when scope AND WS4 assertion are both present (design §03 Layer 4 satisfied)", async () => {
    const slug = freshSlug();
    await app.inject({
      method: "POST",
      url: "/control/v1/tenants",
      headers: headers({ scopes: ["webdesk:operate"], idempotencyKey: randomUUID() }),
      payload: { slug, companyRef: randomUUID() },
    });

    const archive = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${slug}/archive`,
      headers: headers({ scopes: ["webdesk:promote"], ws4: randomUUID(), idempotencyKey: randomUUID() }),
    });
    expect(archive.statusCode).toBe(201);
    expect(archive.json().tenant.status).toBe("archived");
  });

  it("a read command (schema.propose) needs only webdesk:read, no idempotency key, no WS4", async () => {
    const slug = freshSlug();
    const provision = await app.inject({
      method: "POST",
      url: "/control/v1/tenants",
      headers: headers({ scopes: ["webdesk:operate"], idempotencyKey: randomUUID() }),
      payload: { slug, companyRef: randomUUID() },
    });
    expect(provision.statusCode).toBe(201);

    const site = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${slug}/sites`,
      headers: headers({ scopes: ["webdesk:operate"], idempotencyKey: randomUUID() }),
      payload: { kind: "astro", name: "authz-test-site" },
    });
    expect(site.statusCode).toBe(201);
    const siteId = site.json().site.id as string;

    const propose = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${slug}/sites/${siteId}/collections/case-study/schema/propose`,
      headers: headers({ scopes: ["webdesk:read"] }), // no idempotency-key header, no ws4
      payload: { proposedSchema: { title: { type: "text" } } },
    });
    expect(propose.statusCode).toBe(201);
    expect(propose.json().persisted).toBe(false);
  });
});
