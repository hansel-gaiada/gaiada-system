// WSK-21 — idempotency + audit proof for the lifecycle/schema/keys quarters of the C-05 command
// set. "Every command double-fired must produce one effect" (ticket AC) is proven three ways
// here: (1) a double-fire with the SAME idempotency key returns the SAME domain result and
// leaves exactly one row in the underlying table; (2) reusing an idempotency key with DIFFERENT
// arguments is refused (409), not silently executed as a fresh command; (3) the domain table's
// own natural uniqueness constraint is a second, independent backstop, proven by clearing the
// in-memory idempotency store between two calls to simulate a cross-process double-fire.
//
// Verification runbook: see ../README.md's "WSK-21 — Control-plane API v1" section.
process.env.NODE_ENV = "test";
process.env.APP_DATABASE_URL =
  process.env.WSK21_TEST_DATABASE_URL || "postgres://webdesk_app:throwaway_app@localhost:55490/webdesk";
process.env.API_KEY_PEPPER = "wsk21-test-pepper-never-used-outside-this-suite";
process.env.WEBDESK_READ_QUOTA_PER_MIN = process.env.WEBDESK_READ_QUOTA_PER_MIN || "1000";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ControlModule } from "../src/control/control.module";
import { IdempotencyStore } from "../src/control/idempotency/idempotency-store";

const MIGRATOR_URL =
  process.env.WSK21_MIGRATE_DATABASE_URL || "postgres://webdesk_migrator:throwaway_migrator@localhost:55490/webdesk";

async function buildControlApp(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [ControlModule] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: ["error"] });
  await app.init();
  return app;
}

function headers(opts: { scopes: string[]; ws4?: string; idempotencyKey?: string; subject?: string }) {
  const h: Record<string, string> = {
    "x-webdesk-control-principal": opts.subject ?? "wsk21-commands-test",
    "x-webdesk-control-scopes": opts.scopes.join(","),
  };
  if (opts.ws4) h["x-webdesk-ws4-approval-id"] = opts.ws4;
  if (opts.idempotencyKey) h["idempotency-key"] = opts.idempotencyKey;
  return h;
}

function freshSlug() {
  return `wsk21-cmd-${randomUUID().slice(0, 8)}`;
}

/** Raw-SQL verification helper — connects as the migrator role (never trusts the app's own read path to prove the app's own write path). */
async function withPlatform<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: MIGRATOR_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL webdesk.platform_ctx = 'true'");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } finally {
    await client.end();
  }
}

async function withTenant<T>(tenantId: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: MIGRATOR_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } finally {
    await client.end();
  }
}

describe("control-plane commands — idempotency + audit (lifecycle / schema / keys)", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await buildControlApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("tenant.provision: double-fire with the SAME idempotency key produces exactly one tenant row", async () => {
    const slug = freshSlug();
    const companyRef = randomUUID();
    const idempotencyKey = randomUUID();
    const payload = { slug, companyRef };
    const hdrs = headers({ scopes: ["webdesk:operate"], idempotencyKey });

    const first = await app.inject({ method: "POST", url: "/control/v1/tenants", headers: hdrs, payload });
    const second = await app.inject({ method: "POST", url: "/control/v1/tenants", headers: hdrs, payload });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    const firstBody = first.json();
    const secondBody = second.json();
    expect(firstBody.replayed).toBe(false);
    expect(secondBody.replayed).toBe(true);
    expect(secondBody.tenant.id).toBe(firstBody.tenant.id);

    const count = await withPlatform(async (client) => {
      const { rows } = await client.query("SELECT count(*)::int AS n FROM tenants WHERE slug = $1", [slug]);
      return rows[0].n as number;
    });
    expect(count).toBe(1);

    // Both the real command and its replay each write their own (differently-named) audit row —
    // the replay is traced, not silently absorbed.
    const actionCounts = await withPlatform(async (client) => {
      const { rows } = await client.query(
        `SELECT action, count(*)::int AS n FROM audit_entries WHERE ws4_approval_id IS NULL
           AND action IN ('control.tenant.provision', 'control.tenant.provision.replay')
           AND args_hash IS NOT NULL
         GROUP BY action`,
      );
      return Object.fromEntries(rows.map((r) => [r.action, r.n]));
    });
    // A relative (>=1) check rather than an exact total, since other it()s in this file also
    // provision tenants against the same throwaway database — the earlier per-slug/per-tenant-id
    // checks above are what actually pin this test's own two rows.
    expect(actionCounts["control.tenant.provision"]).toBeGreaterThanOrEqual(1);
    expect(actionCounts["control.tenant.provision.replay"]).toBeGreaterThanOrEqual(1);
  });

  it("tenant.provision: reusing an idempotency key with DIFFERENT arguments is refused, not silently executed", async () => {
    const idempotencyKey = randomUUID();
    const hdrs = headers({ scopes: ["webdesk:operate"], idempotencyKey });

    const first = await app.inject({
      method: "POST",
      url: "/control/v1/tenants",
      headers: hdrs,
      payload: { slug: freshSlug(), companyRef: randomUUID() },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: "/control/v1/tenants",
      headers: hdrs,
      payload: { slug: freshSlug(), companyRef: randomUUID() }, // same key, different body
    });
    expect(second.statusCode).toBe(409);
  });

  it("site.provision: double-fire is idempotent; environment.provision's UNIQUE(site_id,name) is an independent cross-process backstop", async () => {
    const slug = freshSlug();
    const provision = await app.inject({
      method: "POST",
      url: "/control/v1/tenants",
      headers: headers({ scopes: ["webdesk:operate"], idempotencyKey: randomUUID() }),
      payload: { slug, companyRef: randomUUID() },
    });
    const tenantId = provision.json().tenant.id as string;

    const siteIdemKey = randomUUID();
    const siteHeaders = headers({ scopes: ["webdesk:operate"], idempotencyKey: siteIdemKey });
    const site1 = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${slug}/sites`,
      headers: siteHeaders,
      payload: { kind: "astro", name: "site-a" },
    });
    const site2 = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${slug}/sites`,
      headers: siteHeaders,
      payload: { kind: "astro", name: "site-a" },
    });
    expect(site1.statusCode).toBe(201);
    expect(site2.json().site.id).toBe(site1.json().site.id);

    const siteCount = await withTenant(tenantId, async (client) => {
      const { rows } = await client.query("SELECT count(*)::int AS n FROM sites WHERE tenant_id = $1", [tenantId]);
      return rows[0].n as number;
    });
    expect(siteCount).toBe(1);

    // Exactly one non-replay + one replay audit row scoped to THIS tenant (tenant-scoped commands
    // set tenant_id for real, unlike the platform-level tenant.provision above — so this can be an
    // exact assertion, not a >= one).
    const auditCounts = await withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT action, count(*)::int AS n FROM audit_entries
           WHERE tenant_id = $1 AND action IN ('control.site.provision', 'control.site.provision.replay')
         GROUP BY action`,
        [tenantId],
      );
      return Object.fromEntries(rows.map((r) => [r.action, r.n]));
    });
    expect(auditCounts["control.site.provision"]).toBe(1);
    expect(auditCounts["control.site.provision.replay"]).toBe(1);

    const siteId = site1.json().site.id as string;

    // Now prove the DB-level UNIQUE(site_id,name) constraint is a REAL, independent backstop —
    // not just decoration — by clearing the in-memory idempotency store between two calls (the
    // cheapest honest simulation of "a second api process, which would not share this store").
    const idempotency = app.get(IdempotencyStore);
    const env1 = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${slug}/sites/${siteId}/environments`,
      headers: headers({ scopes: ["webdesk:operate"], idempotencyKey: randomUUID() }),
      payload: { name: "staging" },
    });
    expect(env1.statusCode).toBe(201);

    idempotency.clear(); // simulate "a different process" — the next call gets NO in-memory dedup

    const env2 = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${slug}/sites/${siteId}/environments`,
      headers: headers({ scopes: ["webdesk:operate"], idempotencyKey: randomUUID() }), // different key too
      payload: { name: "staging" }, // same site + same name as env1
    });
    expect(env2.statusCode).toBe(409); // refused by UNIQUE(site_id,name), not the idempotency store

    const envCount = await withTenant(tenantId, async (client) => {
      const { rows } = await client.query("SELECT count(*)::int AS n FROM environments WHERE site_id = $1", [siteId]);
      return rows[0].n as number;
    });
    expect(envCount).toBe(1);
  });

  it("schema.propose never persists; schema.apply is idempotent and upserts collections.schema", async () => {
    const slug = freshSlug();
    const provision = await app.inject({
      method: "POST",
      url: "/control/v1/tenants",
      headers: headers({ scopes: ["webdesk:operate"], idempotencyKey: randomUUID() }),
      payload: { slug, companyRef: randomUUID() },
    });
    const tenantId = provision.json().tenant.id as string;

    const site = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${slug}/sites`,
      headers: headers({ scopes: ["webdesk:operate"], idempotencyKey: randomUUID() }),
      payload: { kind: "astro", name: "schema-test-site" },
    });
    const siteId = site.json().site.id as string;

    const propose = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${slug}/sites/${siteId}/collections/case-study/schema/propose`,
      headers: headers({ scopes: ["webdesk:read"] }),
      payload: { proposedSchema: { title: { type: "text" } } },
    });
    expect(propose.statusCode).toBe(201);
    expect(propose.json().persisted).toBe(false);

    const collectionCountBefore = await withTenant(tenantId, async (client) => {
      const { rows } = await client.query("SELECT count(*)::int AS n FROM collections WHERE site_id = $1", [siteId]);
      return rows[0].n as number;
    });
    expect(collectionCountBefore).toBe(0); // propose wrote nothing

    const applyKey = randomUUID();
    const applyHeaders = headers({ scopes: ["webdesk:operate"], idempotencyKey: applyKey });
    const apply1 = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${slug}/sites/${siteId}/collections/case-study/schema/apply`,
      headers: applyHeaders,
      payload: { schema: { title: { type: "text" } } },
    });
    const apply2 = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${slug}/sites/${siteId}/collections/case-study/schema/apply`,
      headers: applyHeaders,
      payload: { schema: { title: { type: "text" } } },
    });
    expect(apply1.statusCode).toBe(201);
    expect(apply2.json().collection.id).toBe(apply1.json().collection.id);

    const collectionRows = await withTenant(tenantId, async (client) => {
      const { rows } = await client.query("SELECT schema FROM collections WHERE site_id = $1 AND key = $2", [
        siteId,
        "case-study",
      ]);
      return rows;
    });
    expect(collectionRows).toHaveLength(1);
    expect(collectionRows[0].schema).toEqual({ title: { type: "text" } });
  });

  it("key.mint requires WS4 (HIGH), delegates to ApiKeysService, and is idempotent under double-fire", async () => {
    const slug = freshSlug();
    const provision = await app.inject({
      method: "POST",
      url: "/control/v1/tenants",
      headers: headers({ scopes: ["webdesk:operate"], idempotencyKey: randomUUID() }),
      payload: { slug, companyRef: randomUUID() },
    });
    const tenantId = provision.json().tenant.id as string;

    const site = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${slug}/sites`,
      headers: headers({ scopes: ["webdesk:operate"], idempotencyKey: randomUUID() }),
      payload: { kind: "astro", name: "keys-test-site" },
    });
    const siteId = site.json().site.id as string;

    const env = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${slug}/sites/${siteId}/environments`,
      headers: headers({ scopes: ["webdesk:operate"], idempotencyKey: randomUUID() }),
      payload: { name: "staging" },
    });
    const envId = env.json().environment.id as string;

    const noWs4 = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${slug}/keys`,
      headers: headers({ scopes: ["webdesk:keys"], idempotencyKey: randomUUID() }), // no ws4
      payload: { envId, scope: "read" },
    });
    expect(noWs4.statusCode).toBe(403);

    const mintKey = randomUUID();
    const mintHeaders = headers({ scopes: ["webdesk:keys"], ws4: randomUUID(), idempotencyKey: mintKey });
    const mint1 = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${slug}/keys`,
      headers: mintHeaders,
      payload: { envId, scope: "read" },
    });
    const mint2 = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${slug}/keys`,
      headers: mintHeaders,
      payload: { envId, scope: "read" },
    });
    expect(mint1.statusCode).toBe(201);
    expect(mint2.json().id).toBe(mint1.json().id);
    expect(mint2.json().key).toBe(mint1.json().key); // same plaintext returned — proves NO second mint happened

    const keyCount = await withTenant(tenantId, async (client) => {
      const { rows } = await client.query("SELECT count(*)::int AS n FROM api_keys WHERE env_id = $1", [envId]);
      return rows[0].n as number;
    });
    expect(keyCount).toBe(1);
  });
});
