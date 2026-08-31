// WSK-25 — THE property this ticket must prove, isolated in its own file: the snapshot is durable
// BEFORE anything mutates, proven by injecting a REAL failure (a Postgres CHECK-constraint
// violation, not a mock) into the step immediately AFTER the snapshot commits, then reading the
// snapshot back on a FRESH connection while the mutation's own transaction has rolled back.
//
// This is deliberately not "assert the happy path wrote a snapshot row" — that would prove
// nothing about ORDERING. The proof here is: (1) a promotion_snapshots row exists, with the
// PRE-failure item count, (2) the target's content is byte-for-byte what it was before the call
// (the failed transaction changed nothing), (3) the promotion_runs row is marked 'failed' and
// still references the snapshot that survived it.
//
// Verification runbook: see ../README.md's "WSK-25 — Promotion engine" section (same Postgres as
// promotion-content-flow.spec.ts).
process.env.NODE_ENV = "test";
process.env.APP_DATABASE_URL =
  process.env.WSK25_TEST_DATABASE_URL || "postgres://webdesk_app:throwaway_app@localhost:55495/webdesk";
process.env.API_KEY_PEPPER = "wsk25-test-pepper-never-used-outside-this-suite";
process.env.WEBDESK_READ_QUOTA_PER_MIN = process.env.WEBDESK_READ_QUOTA_PER_MIN || "1000";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { ControlModule } from "../src/control/control.module";
import { PromotionModule } from "../src/promotion/promotion.module";

const MIGRATOR_URL =
  process.env.WSK25_MIGRATE_DATABASE_URL || "postgres://webdesk_migrator:throwaway_migrator@localhost:55495/webdesk";

async function buildApp(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [ControlModule, PromotionModule] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: ["error"] });
  await app.init();
  // WSK-25 FIX — Fastify registers routes during `ready()`, NOT during `app.init()`. Without this
  // line every `app.inject()` in the file hit an unregistered route and came back 404, so
  // `t.json().tenant` was undefined and all seven tests died in the provisioning helper with
  // "Cannot read properties of undefined (reading 'id')" — which reads like a broken promotion
  // engine and is really a half-started server. Every other suite in this project that uses
  // `inject()` awaits ready (see test/control-jobs.spec.ts).
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

function headers(opts: { scopes: string[]; ws4?: string }) {
  const h: Record<string, string> = {
    "x-webdesk-control-principal": "wsk25-snapshot-first-test",
    "x-webdesk-control-scopes": opts.scopes.join(","),
    "idempotency-key": randomUUID(),
  };
  if (opts.ws4) h["x-webdesk-ws4-approval-id"] = opts.ws4;
  return h;
}

function freshSlug() {
  return `wsk25-snap-${randomUUID().slice(0, 8)}`;
}

/** A FRESH connection every time — never the app's own pool — so a read against it genuinely proves durability independent of whatever the failed request's connection is doing. */
async function withTenantFresh<T>(tenantId: string, fn: (client: Client) => Promise<T>): Promise<T> {
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

async function provisionTenantSiteEnvs(app: NestFastifyApplication) {
  const slug = freshSlug();
  const t = await app.inject({ method: "POST", url: "/control/v1/tenants", headers: headers({ scopes: ["webdesk:operate"] }), payload: { slug, companyRef: randomUUID() } });
  const tenantId = t.json().tenant.id as string;
  const s = await app.inject({ method: "POST", url: `/control/v1/tenants/${slug}/sites`, headers: headers({ scopes: ["webdesk:operate"] }), payload: { kind: "astro", name: "site-a" } });
  const siteId = s.json().site.id as string;
  const prodEnv = await app.inject({ method: "POST", url: `/control/v1/tenants/${slug}/sites/${siteId}/environments`, headers: headers({ scopes: ["webdesk:operate"] }), payload: { name: "production" } });
  return { slug, tenantId, siteId, prodEnvId: prodEnv.json().environment.id as string };
}

async function seedOneItem(tenantId: string, siteId: string, opts: { collectionKey: string; slug: string; title: string }) {
  await withTenantFresh(tenantId, async (client) => {
    const { rows: col } = await client.query(
      `INSERT INTO collections (id, tenant_id, site_id, key, schema) VALUES (gen_random_uuid(), $1, $2, $3, '{}'::jsonb) RETURNING id`,
      [tenantId, siteId, opts.collectionKey],
    );
    await client.query(
      `INSERT INTO content_items (id, tenant_id, site_id, collection_id, locale, slug, blocks, seo, publish_state)
       VALUES (gen_random_uuid(), $1, $2, $3, 'en-US', $4, '[]'::jsonb, $5::jsonb, 'published')`,
      [tenantId, siteId, col[0].id, opts.slug, JSON.stringify({ title: opts.title })],
    );
  });
}

/** A bundle that WILL make Postgres reject the INSERT for real: content_items' own CHECK
 * (unpublish_at IS NULL OR publish_at IS NULL OR unpublish_at > publish_at), violated by putting
 * unpublishAt BEFORE publishAt. Nothing about this is mocked — it is a genuine constraint
 * violation surfacing from the real schema, the same class of defect a corrupt or hostile bundle
 * arriving from a compromised source box could produce. */
function poisonedBundle(collectionKey: string) {
  return {
    siteId: "unused-informational-only",
    exportedAt: new Date().toISOString(),
    collections: [{ key: collectionKey, schema: {} }],
    contentItems: [
      {
        collectionKey,
        locale: "en-US",
        slug: "poisoned",
        localizationGroupId: randomUUID(),
        blocks: [],
        seo: {},
        publishState: "scheduled",
        publishAt: "2030-01-02T00:00:00.000Z",
        unpublishAt: "2030-01-01T00:00:00.000Z", // BEFORE publishAt — violates the real CHECK constraint
        previewToken: null,
        searchText: null,
      },
    ],
    mediaAssets: [],
  };
}

describe("promotion engine — snapshot-first ordering (WSK-25)", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("a REAL failure injected after the snapshot commits leaves the snapshot durable and the target's content untouched", async () => {
    const { slug, tenantId, siteId, prodEnvId } = await provisionTenantSiteEnvs(app);
    await seedOneItem(tenantId, siteId, { collectionKey: "page", slug: "home", title: "Pre-existing Home" });

    const preFailureItems = await withTenantFresh(tenantId, async (client) => {
      const { rows } = await client.query(`SELECT id, slug FROM content_items WHERE site_id = $1`, [siteId]);
      return rows;
    });
    expect(preFailureItems).toHaveLength(1);

    const res = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${slug}/sites/${siteId}/environments/${prodEnvId}/content-promote`,
      headers: { ...headers({ scopes: ["webdesk:promote"], ws4: randomUUID() }), "idempotency-key": randomUUID() },
      payload: { version: "v-poisoned", bundle: poisonedBundle("page") },
    });

    // The request itself fails — Nest's default filter surfaces the unwrapped Postgres error as
    // a 500 (this is not a caller-input-validation 400: the bundle is STRUCTURALLY valid, its
    // VALUES are what the database's own domain rule refuses).
    expect(res.statusCode).toBe(500);

    // --- 1. The target's content is EXACTLY what it was before the call — the failed transaction
    //        rolled back completely, not partially. ---------------------------------------------
    const postFailureItems = await withTenantFresh(tenantId, async (client) => {
      const { rows } = await client.query(`SELECT id, slug FROM content_items WHERE site_id = $1 ORDER BY slug`, [siteId]);
      return rows;
    });
    expect(postFailureItems).toEqual(preFailureItems);
    // The poisoned item was never persisted.
    const poisoned = await withTenantFresh(tenantId, async (client) => {
      const { rows } = await client.query(`SELECT 1 FROM content_items WHERE slug = 'poisoned'`);
      return rows;
    });
    expect(poisoned).toHaveLength(0);

    // --- 2. The promotion_runs row exists, is marked 'failed', and points at a snapshot. -------
    const run = await withTenantFresh(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, status, current_step, snapshot_id, error_detail FROM promotion_runs WHERE target_env_id = $1 AND version = 'v-poisoned'`,
        [prodEnvId],
      );
      return rows[0];
    });
    expect(run).toBeTruthy();
    expect(run.status).toBe("failed");
    expect(run.current_step).toBe("migrate_import");
    expect(run.snapshot_id).toBeTruthy();
    expect(run.error_detail.step).toBe("migrate_import");

    // --- 3. THE PROOF: the snapshot this run took BEFORE the poisoned bundle was ever applied is
    //        durable, readable on a BRAND NEW connection, and holds the PRE-failure item count —
    //        it was committed and closed before the doomed transaction even opened. -------------
    const snapshot = await withTenantFresh(tenantId, async (client) => {
      const { rows } = await client.query(`SELECT item_count, checksum, bundle FROM promotion_snapshots WHERE id = $1`, [run.snapshot_id]);
      return rows[0];
    });
    expect(snapshot).toBeTruthy();
    expect(snapshot.item_count).toBe(1);
    expect(snapshot.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.bundle.contentItems).toHaveLength(1);
    expect(snapshot.bundle.contentItems[0].slug).toBe("home");
    expect(snapshot.bundle.contentItems[0].seo.title).toBe("Pre-existing Home");

    // --- 4. A rollback using this very snapshot still works AFTER the failure — the failure did
    //        not corrupt or consume the restore point. ------------------------------------------
    const rollback = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${slug}/sites/${siteId}/environments/${prodEnvId}/content-rollback`,
      headers: { ...headers({ scopes: ["webdesk:promote"], ws4: randomUUID() }), "idempotency-key": randomUUID() },
      payload: {},
    });
    expect(rollback.statusCode).toBe(201);
    expect(rollback.json().status).toBe("rolled_back");
    expect(rollback.json().restoredFromSnapshotId).toBe(run.snapshot_id);
  });

  it("promotion_snapshots is genuinely append-only — the app role cannot UPDATE or DELETE a restore point", async () => {
    const { tenantId, siteId, prodEnvId } = await provisionTenantSiteEnvs(app);
    await seedOneItem(tenantId, siteId, { collectionKey: "page", slug: "home", title: "Home" });

    const snapshotId = await withTenantFresh(tenantId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO promotion_runs (id, tenant_id, site_id, target_env_id, kind, version, status, created_by)
         VALUES (gen_random_uuid(), $1, $2, $3, 'promote', 'v-immutability-probe', 'pending', 'test')
         RETURNING id`,
        [tenantId, siteId, prodEnvId],
      );
      const runId = rows[0].id;
      const { rows: snap } = await client.query(
        `INSERT INTO promotion_snapshots (id, tenant_id, promotion_run_id, env_id, bundle, checksum, item_count)
         VALUES (gen_random_uuid(), $1, $2, $3, '{}'::jsonb, 'deadbeef', 0) RETURNING id`,
        [tenantId, runId, prodEnvId],
      );
      return snap[0].id as string;
    });

    const appRoleUrl = process.env.APP_DATABASE_URL!;
    const appClient = new Client({ connectionString: appRoleUrl });
    await appClient.connect();
    try {
      await appClient.query("BEGIN");
      await appClient.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenantId]);
      await expect(appClient.query(`UPDATE promotion_snapshots SET checksum = 'tampered' WHERE id = $1`, [snapshotId])).rejects.toThrow(/permission denied/i);
      await appClient.query("ROLLBACK");
      await appClient.query("BEGIN");
      await appClient.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenantId]);
      await expect(appClient.query(`DELETE FROM promotion_snapshots WHERE id = $1`, [snapshotId])).rejects.toThrow(/permission denied/i);
      await appClient.query("ROLLBACK");
    } finally {
      await appClient.end();
    }
  });
});
