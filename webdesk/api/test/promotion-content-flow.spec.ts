// WSK-25 — the promotion engine's content half, driven through the REAL HTTP surface
// (app.inject), same style as test/control-commands.spec.ts. Proves, against a real migrated
// Postgres:
//   1. content.export reads back exactly what was seeded (natural-key shape, not a fixture echo).
//   2. content.promote (self-export mode) writes a durable promotion_snapshots row of the
//      TARGET's pre-promotion state and a promotion_runs row landing in
//      'content_promoted_frontend_pending' (the honest status — the FE-deploy seam is
//      unavailable by design; see not-yet-available-frontend-deploy-driver.ts).
//   3. content.rollback restores EXACTLY the pre-promotion state — including deleting a content
//      item the promotion had added (a "restore", not a "merge") — and refuses outright when no
//      snapshot exists for the target environment.
//   4. Idempotency: a double-fired content.promote with the same key produces exactly one
//      promotion_runs row (the second call is a replay).
//   5. Cross-INSTANCE content movement: export from ONE Zone B database, promote into a SEPARATE
//      Zone B database (two databases on the one throwaway Postgres server this suite starts —
//      the honest "two compose projects, one box" shape this ticket's own AC describes; see
//      README.md's WSK-25 section for why two databases-on-one-server is the honest minimum here,
//      matching WSK-18's own "cross-machine = 2 containers, not 2 physical hosts" precedent).
//
// Verification runbook: see ../README.md's "WSK-25 — Promotion engine" section.
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
// Second, SEPARATE database on the same Postgres server — see this file's header. Skipped
// cleanly (not hung) when unset, matching mail-retry-backoff.spec.ts's own precedent for an
// optional piece of infrastructure a runbook may not always stand up.
const TARGET_MIGRATOR_URL = process.env.WSK25_TARGET_MIGRATE_DATABASE_URL;
const TARGET_APP_URL = process.env.WSK25_TARGET_APP_DATABASE_URL;

async function buildApp(appDatabaseUrl: string): Promise<NestFastifyApplication> {
  const previous = process.env.APP_DATABASE_URL;
  process.env.APP_DATABASE_URL = appDatabaseUrl;
  const moduleRef = await Test.createTestingModule({ imports: [ControlModule, PromotionModule] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: ["error"] });
  await app.init();
  // WSK-25 FIX — Fastify registers routes during `ready()`, NOT during `app.init()`. Without this,
  // every `app.inject()` in the file hit an unregistered route and returned 404, so
  // `t.json().tenant` was undefined and all seven tests died inside the provisioning helper with
  // "Cannot read properties of undefined (reading 'id')" — which reads like a broken promotion
  // engine and is really a half-started server. test/control-jobs.spec.ts awaits ready; these two
  // new files did not.
  await app.getHttpAdapter().getInstance().ready();
  process.env.APP_DATABASE_URL = previous;
  return app;
}

function headers(opts: { scopes: string[]; ws4?: string; subject?: string }) {
  const h: Record<string, string> = {
    "x-webdesk-control-principal": opts.subject ?? "wsk25-content-flow-test",
    "x-webdesk-control-scopes": opts.scopes.join(","),
    // Every mutating control-plane command requires this header (assertIdempotencyKey) — a fresh
    // one by default so callers of headers() for a read-only route (content-export) simply carry
    // an unused-but-harmless header, and callers that need a SPECIFIC key still override it via
    // `{ ...headers(...), "idempotency-key": theRealKey }` (object spread: later key wins).
    "idempotency-key": randomUUID(),
  };
  if (opts.ws4) h["x-webdesk-ws4-approval-id"] = opts.ws4;
  return h;
}

function freshSlug(prefix = "wsk25") {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

async function withRole<T>(url: string, guc: "webdesk.platform_ctx" | "webdesk.tenant_ctx", value: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT set_config('${guc}', $1, true)`, [value]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } finally {
    await client.end();
  }
}
const withPlatform = <T>(fn: (c: Client) => Promise<T>) => withRole(MIGRATOR_URL, "webdesk.platform_ctx", "true", fn);
const withTenant = <T>(tenantId: string, fn: (c: Client) => Promise<T>) => withRole(MIGRATOR_URL, "webdesk.tenant_ctx", tenantId, fn);

async function provisionTenantSiteEnvs(app: NestFastifyApplication) {
  const slug = freshSlug();
  const t = await app.inject({
    method: "POST",
    url: "/control/v1/tenants",
    headers: headers({ scopes: ["webdesk:operate"] }),
    payload: { slug, companyRef: randomUUID() },
  });
  expect(t.statusCode).toBe(201);
  const tenantId = t.json().tenant.id as string;

  const s = await app.inject({
    method: "POST",
    url: `/control/v1/tenants/${slug}/sites`,
    headers: headers({ scopes: ["webdesk:operate"] }),
    payload: { kind: "astro", name: "site-a" },
  });
  expect(s.statusCode).toBe(201);
  const siteId = s.json().site.id as string;

  const stagingEnv = await app.inject({
    method: "POST",
    url: `/control/v1/tenants/${slug}/sites/${siteId}/environments`,
    headers: headers({ scopes: ["webdesk:operate"] }),
    payload: { name: "staging" },
  });
  const prodEnv = await app.inject({
    method: "POST",
    url: `/control/v1/tenants/${slug}/sites/${siteId}/environments`,
    headers: headers({ scopes: ["webdesk:operate"] }),
    payload: { name: "production" },
  });
  expect(stagingEnv.statusCode).toBe(201);
  expect(prodEnv.statusCode).toBe(201);

  return { slug, tenantId, siteId, stagingEnvId: stagingEnv.json().environment.id as string, prodEnvId: prodEnv.json().environment.id as string };
}

/** Seeds one collection + one content item directly (no content-authoring command exists on the control plane — that's Payload's/`/v1`'s job, not this ticket's). */
async function seedOneItem(tenantId: string, siteId: string, opts: { collectionKey: string; slug: string; title: string }) {
  await withTenant(tenantId, async (client) => {
    // WSK-25 FIX — this helper is called more than once per site (the rollback test seeds a
    // second item into the SAME collection), and `collections` carries UNIQUE (site_id, key)
    // (migrations/0002_content.sql:55). The bare INSERT therefore failed the second time with
    // `duplicate key value violates unique constraint "collections_site_id_key_key"`, which
    // surfaced as the rollback test failing — a TEST-harness fault that read exactly like a
    // defect in the rollback engine. Idempotent on the natural key instead; DO UPDATE (not DO
    // NOTHING) so RETURNING still yields the existing row's id.
    const { rows: col } = await client.query(
      `INSERT INTO collections (id, tenant_id, site_id, key, schema)
       VALUES (gen_random_uuid(), $1, $2, $3, '{}'::jsonb)
       ON CONFLICT (site_id, key) DO UPDATE SET key = EXCLUDED.key
       RETURNING id`,
      [tenantId, siteId, opts.collectionKey],
    );
    await client.query(
      `INSERT INTO content_items (id, tenant_id, site_id, collection_id, locale, slug, blocks, seo, publish_state)
       VALUES (gen_random_uuid(), $1, $2, $3, 'en-US', $4, '[]'::jsonb, $5::jsonb, 'published')`,
      [tenantId, siteId, col[0].id, opts.slug, JSON.stringify({ title: opts.title })],
    );
  });
}

describe("promotion engine — content export / promote / rollback (WSK-25)", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await buildApp(process.env.APP_DATABASE_URL!);
  });

  afterAll(async () => {
    await app.close();
  });

  it("content.export returns exactly what was seeded, by natural key", async () => {
    const { slug, tenantId, siteId } = await provisionTenantSiteEnvs(app);
    await seedOneItem(tenantId, siteId, { collectionKey: "case-study", slug: "acme", title: "Acme" });

    const res = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${slug}/sites/${siteId}/content-export`,
      headers: headers({ scopes: ["webdesk:read"] }),
    });
    expect(res.statusCode).toBe(201);
    const bundle = res.json().bundle;
    expect(bundle.collections).toEqual([{ key: "case-study", schema: {} }]);
    expect(bundle.contentItems).toHaveLength(1);
    expect(bundle.contentItems[0]).toMatchObject({ collectionKey: "case-study", locale: "en-US", slug: "acme", publishState: "published" });
    expect(bundle.contentItems[0].seo.title).toBe("Acme");
  });

  it("content.promote takes a snapshot of the TARGET's pre-promotion state, then writes the promoted content", async () => {
    const { slug, tenantId, siteId, prodEnvId } = await provisionTenantSiteEnvs(app);
    // Pre-existing production content — this is what the snapshot must capture BEFORE promote mutates it.
    await seedOneItem(tenantId, siteId, { collectionKey: "page", slug: "home", title: "Old Home" });

    const res = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${slug}/sites/${siteId}/environments/${prodEnvId}/content-promote`,
      headers: { ...headers({ scopes: ["webdesk:promote"], ws4: randomUUID() }), "idempotency-key": randomUUID() },
      payload: { version: "v1" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    // Honest status: content committed, frontend deploy is the documented not-yet-available seam.
    expect(body.status).toBe("content_promoted_frontend_pending");
    expect(body.frontendDeploy.ok).toBe(false);
    expect(body.frontendDeploy.reason).toContain("not yet implemented");
    expect(body.snapshot.itemCount).toBe(1); // captured "Old Home" before promote's own self-export ran

    const run = await withTenant(tenantId, async (client) => {
      const { rows } = await client.query(`SELECT status, snapshot_id FROM promotion_runs WHERE id = $1`, [body.promotionRunId]);
      return rows[0];
    });
    expect(run.status).toBe("content_promoted_frontend_pending");
    expect(run.snapshot_id).toBeTruthy();

    const snapshotRow = await withTenant(tenantId, async (client) => {
      const { rows } = await client.query(`SELECT item_count, checksum FROM promotion_snapshots WHERE id = $1`, [run.snapshot_id]);
      return rows[0];
    });
    expect(snapshotRow.item_count).toBe(1);
    expect(snapshotRow.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("content.promote double-fired with the same idempotency key produces exactly one promotion_runs row", async () => {
    const { slug, tenantId, siteId, prodEnvId } = await provisionTenantSiteEnvs(app);
    await seedOneItem(tenantId, siteId, { collectionKey: "page", slug: "home", title: "Home" });
    const idempotencyKey = randomUUID();
    const hdrs = { ...headers({ scopes: ["webdesk:promote"], ws4: randomUUID() }), "idempotency-key": idempotencyKey };
    const payload = { version: "v-dup" };

    const first = await app.inject({ method: "POST", url: `/control/v1/tenants/${slug}/sites/${siteId}/environments/${prodEnvId}/content-promote`, headers: hdrs, payload });
    const second = await app.inject({ method: "POST", url: `/control/v1/tenants/${slug}/sites/${siteId}/environments/${prodEnvId}/content-promote`, headers: hdrs, payload });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().replayed).toBe(false);
    expect(second.json().replayed).toBe(true);
    expect(second.json().promotionRunId).toBe(first.json().promotionRunId);

    const count = await withTenant(tenantId, async (client) => {
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM promotion_runs WHERE target_env_id = $1 AND version = 'v-dup'`, [prodEnvId]);
      return rows[0].n as number;
    });
    expect(count).toBe(1);
  });

  it("content.rollback with NO prior snapshot REFUSES — never a silent no-op", async () => {
    const { slug, siteId, prodEnvId } = await provisionTenantSiteEnvs(app);

    const res = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${slug}/sites/${siteId}/environments/${prodEnvId}/content-rollback`,
      headers: { ...headers({ scopes: ["webdesk:promote"], ws4: randomUUID() }), "idempotency-key": randomUUID() },
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("no promotion_snapshots row exists");
  });

  it("content.rollback restores the EXACT pre-promotion state — including deleting an item the promotion added", async () => {
    const { slug, tenantId, siteId, prodEnvId } = await provisionTenantSiteEnvs(app);
    await seedOneItem(tenantId, siteId, { collectionKey: "page", slug: "home", title: "Original Home" });

    // Promote: this self-exports the site's CURRENT content (which, at promote time, still only
    // has "home") — after promote, add a SECOND item directly, simulating drift/an in-flight edit
    // that must NOT survive a rollback to the snapshot taken before this promote ran.
    const promote = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${slug}/sites/${siteId}/environments/${prodEnvId}/content-promote`,
      headers: { ...headers({ scopes: ["webdesk:promote"], ws4: randomUUID() }), "idempotency-key": randomUUID() },
      payload: { version: "v-restore" },
    });
    expect(promote.statusCode).toBe(201);

    // Mutate "home" AND add a new item "about" — both must be undone by rollback.
    await withTenant(tenantId, async (client) => {
      await client.query(`UPDATE content_items SET seo = '{"title":"Mutated Home"}'::jsonb WHERE slug = 'home' AND site_id = $1`, [siteId]);
    });
    await seedOneItem(tenantId, siteId, { collectionKey: "page", slug: "about", title: "About (added after promote)" });

    const beforeRollback = await withTenant(tenantId, async (client) => {
      const { rows } = await client.query(`SELECT slug FROM content_items WHERE site_id = $1 ORDER BY slug`, [siteId]);
      return rows.map((r) => r.slug);
    });
    expect(beforeRollback).toEqual(["about", "home"]);

    const rollback = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${slug}/sites/${siteId}/environments/${prodEnvId}/content-rollback`,
      headers: { ...headers({ scopes: ["webdesk:promote"], ws4: randomUUID() }), "idempotency-key": randomUUID() },
      payload: {},
    });
    expect(rollback.statusCode).toBe(201);
    expect(rollback.json().status).toBe("rolled_back");
    expect(rollback.json().applyResult.itemsDeleted).toBe(1); // "about" removed
    expect(rollback.json().applyResult.itemsWritten).toBe(1); // "home" restored to its pre-promote value

    const afterRollback = await withTenant(tenantId, async (client) => {
      const { rows } = await client.query(`SELECT slug, seo FROM content_items WHERE site_id = $1 ORDER BY slug`, [siteId]);
      return rows;
    });
    expect(afterRollback).toHaveLength(1);
    expect(afterRollback[0].slug).toBe("home");
    expect(afterRollback[0].seo.title).toBe("Original Home");
  });

  (TARGET_MIGRATOR_URL && TARGET_APP_URL ? it : it.skip)(
    "cross-INSTANCE: export from one Zone B database, promote into a SEPARATE Zone B database (the real D-4 mechanism)",
    async () => {
      const targetApp = await buildApp(TARGET_APP_URL!);
      try {
        const source = await provisionTenantSiteEnvs(app); // database #1 ("staging box")
        await seedOneItem(source.tenantId, source.siteId, { collectionKey: "case-study", slug: "cross-box", title: "Cross-box proof" });

        const exportRes = await app.inject({
          method: "POST",
          url: `/control/v1/tenants/${source.slug}/sites/${source.siteId}/content-export`,
          headers: headers({ scopes: ["webdesk:read"] }),
        });
        expect(exportRes.statusCode).toBe(201);
        const bundle = exportRes.json().bundle;

        // Provision an INDEPENDENT tenant/site/env graph on database #2 ("production box") — a
        // real second deployment has its own tenant/site rows, never a copy of database #1's ids.
        const target = await provisionTenantSiteEnvs(targetApp);

        const promoteRes = await targetApp.inject({
          method: "POST",
          url: `/control/v1/tenants/${target.slug}/sites/${target.siteId}/environments/${target.prodEnvId}/content-promote`,
          headers: { ...headers({ scopes: ["webdesk:promote"], ws4: randomUUID() }), "idempotency-key": randomUUID() },
          payload: { version: "v-cross-box", bundle },
        });
        expect(promoteRes.statusCode).toBe(201);
        expect(promoteRes.json().applyResult.itemsWritten).toBe(1);

        const landed = await withRole(TARGET_MIGRATOR_URL!, "webdesk.tenant_ctx", target.tenantId, async (client) => {
          const { rows } = await client.query(`SELECT slug, seo FROM content_items WHERE site_id = $1`, [target.siteId]);
          return rows;
        });
        expect(landed).toHaveLength(1);
        expect(landed[0].slug).toBe("cross-box");
        expect(landed[0].seo.title).toBe("Cross-box proof");
      } finally {
        await targetApp.close();
      }
    },
  );
});

// Sanity: prove the skip guard above is reachable (documents the honest limit rather than hiding it).
if (!TARGET_MIGRATOR_URL || !TARGET_APP_URL) {
  // eslint-disable-next-line no-console
  console.log(
    "[promotion-content-flow] cross-instance test SKIPPED — WSK25_TARGET_MIGRATE_DATABASE_URL/WSK25_TARGET_APP_DATABASE_URL not set. See README.md's WSK-25 runbook for the second-database setup.",
  );
}
