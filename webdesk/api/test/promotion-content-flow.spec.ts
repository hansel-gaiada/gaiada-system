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
import { contentHash } from "../src/control/content/content-projection";

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
  return withTenant(tenantId, async (client) => {
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
    const { rows: item } = await client.query(
      `INSERT INTO content_items (id, tenant_id, site_id, collection_id, locale, slug, blocks, seo, publish_state)
       VALUES (gen_random_uuid(), $1, $2, $3, 'en-US', $4, '[]'::jsonb, $5::jsonb, 'published')
       RETURNING id, localization_group_id`,
      [tenantId, siteId, col[0].id, opts.slug, JSON.stringify({ title: opts.title })],
    );
    return { id: item[0].id as string, groupId: item[0].localization_group_id as string };
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

    // WSK-D51: "removed" is a SOFT delete (deleted_at), never a DELETE: content_versions keeps its FK
    // and its append-only history. The live set is exactly the pre-promotion state.
    const afterRollback = await withTenant(tenantId, async (client) => {
      const { rows } = await client.query(`SELECT slug, seo FROM content_items WHERE site_id = $1 AND deleted_at IS NULL ORDER BY slug`, [siteId]);
      return rows;
    });
    expect(afterRollback).toHaveLength(1);
    expect(afterRollback[0].slug).toBe("home");
    expect(afterRollback[0].seo.title).toBe("Original Home");
    const softDeleted = await withTenant(tenantId, async (client) => {
      const { rows } = await client.query(`SELECT slug FROM content_items WHERE site_id = $1 AND deleted_at IS NOT NULL ORDER BY slug`, [siteId]);
      return rows.map((r) => r.slug);
    });
    expect(softDeleted).toEqual(["about"]);
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

// ================================================================================================
// WSK-D51 / T4 — the promotion's content half fits the WRITE PLANE (migrations 0009 + 0010).
// Each test below was written and run RED against the pre-fix applyBundle first (see the ticket
// report for the failure each one showed), then the engine was fixed.
// ================================================================================================
const PRINCIPAL = "wsk25-content-flow-test";

type Provisioned = Awaited<ReturnType<typeof provisionTenantSiteEnvs>>;

const promoteUrl = (t: Provisioned) => `/control/v1/tenants/${t.slug}/sites/${t.siteId}/environments/${t.prodEnvId}/content-promote`;
const rollbackUrl = (t: Provisioned) => `/control/v1/tenants/${t.slug}/sites/${t.siteId}/environments/${t.prodEnvId}/content-rollback`;

function promoteReq(app: NestFastifyApplication, t: Provisioned, payload: Record<string, unknown>, opts: { ws4?: string; automation?: boolean } = {}) {
  const h = { ...headers({ scopes: ["webdesk:promote"], ws4: opts.ws4 ?? randomUUID(), subject: PRINCIPAL }), "idempotency-key": randomUUID() } as Record<string, string>;
  if (opts.automation) h["x-webdesk-control-automation"] = "true";
  return app.inject({ method: "POST", url: promoteUrl(t), headers: h, payload });
}

function rollbackReq(app: NestFastifyApplication, t: Provisioned, opts: { ws4?: string; automation?: boolean } = {}) {
  const h = { ...headers({ scopes: ["webdesk:promote"], ws4: opts.ws4 ?? randomUUID(), subject: PRINCIPAL }), "idempotency-key": randomUUID() } as Record<string, string>;
  if (opts.automation) h["x-webdesk-control-automation"] = "true";
  return app.inject({ method: "POST", url: rollbackUrl(t), headers: h, payload: {} });
}

async function exportBundleOf(app: NestFastifyApplication, t: Provisioned) {
  const res = await app.inject({
    method: "POST",
    url: `/control/v1/tenants/${t.slug}/sites/${t.siteId}/content-export`,
    headers: headers({ scopes: ["webdesk:read"] }),
  });
  expect(res.statusCode).toBe(201);
  return res.json().bundle as {
    siteId: string;
    exportedAt: string;
    collections: { key: string; schema: unknown }[];
    contentItems: Record<string, unknown>[];
    mediaAssets: unknown[];
  };
}

/** Everything the content half could have touched, as comparable JSON: every item row and every version row. */
async function dumpContent(t: Provisioned) {
  return withTenant(t.tenantId, async (client) => {
    const items = await client.query(`SELECT to_jsonb(ci) - 'search_vector' AS r FROM content_items ci WHERE ci.site_id = $1 ORDER BY ci.id`, [t.siteId]);
    const versions = await client.query(
      `SELECT to_jsonb(v) AS r FROM content_versions v JOIN content_items ci ON ci.id = v.content_item_id WHERE ci.site_id = $1 ORDER BY v.content_item_id, v.version`,
      [t.siteId],
    );
    return { items: items.rows.map((r) => r.r), versions: versions.rows.map((r) => r.r) };
  });
}

const q = <T = Record<string, unknown>>(t: Provisioned, sql: string, params: unknown[] = []) =>
  withTenant(t.tenantId, async (client) => (await client.query(sql, params)).rows as T[]);

function bundleItem(over: Record<string, unknown>) {
  return {
    collectionKey: "page",
    locale: "en-US",
    slug: "x",
    localizationGroupId: randomUUID(),
    blocks: [],
    seo: {},
    publishState: "published",
    publishAt: null,
    unpublishAt: null,
    previewToken: null,
    searchText: null,
    ...over,
  };
}

describe("promotion x write plane (WSK-D51, migrations 0009 + 0010)", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await buildApp(process.env.APP_DATABASE_URL!);
  });

  afterAll(async () => {
    await app.close();
  });

  it("content.export leaves out soft-deleted items (a promotion must not resurrect them as live)", async () => {
    const t = await provisionTenantSiteEnvs(app);
    await seedOneItem(t.tenantId, t.siteId, { collectionKey: "page", slug: "kept", title: "Kept" });
    const gone = await seedOneItem(t.tenantId, t.siteId, { collectionKey: "page", slug: "gone", title: "Gone" });
    await q(t, `UPDATE content_items SET deleted_at = now() WHERE id = $1`, [gone.id]);

    const bundle = await exportBundleOf(app, t);
    expect(bundle.contentItems.map((i) => i.slug)).toEqual(["kept"]);

    // ...and the snapshot a promotion takes is built from the same export.
    const promote = await promoteReq(app, t, { version: "v-export-live-only" });
    expect(promote.statusCode).toBe(201);
    expect(promote.json().snapshot.itemCount).toBe(1);
    // The soft-deleted row stays deleted: a self-promotion changed nothing.
    const rows = await q<{ slug: string; deleted: boolean }>(t, `SELECT slug, deleted_at IS NOT NULL AS deleted FROM content_items WHERE site_id = $1 ORDER BY slug`, [t.siteId]);
    expect(rows).toEqual([
      { slug: "gone", deleted: true },
      { slug: "kept", deleted: false },
    ]);
  });

  it("content.rollback after the promotion ADDED an item that has content_versions rows: no FK error; the item is soft-deleted and its versions are still there", async () => {
    const t = await provisionTenantSiteEnvs(app);
    await seedOneItem(t.tenantId, t.siteId, { collectionKey: "page", slug: "home", title: "Home" });

    const bundle = await exportBundleOf(app, t);
    bundle.contentItems.push(bundleItem({ slug: "about", seo: { title: "About" }, blocks: [{ type: "hero", props: { heading: "About" } }] }));
    const promote = await promoteReq(app, t, { version: "v-adds-about", bundle });
    expect(promote.statusCode).toBe(201);

    const [about] = await q<{ id: string }>(t, `SELECT id FROM content_items WHERE site_id = $1 AND slug = 'about'`, [t.siteId]);
    // An editor then saves a version of the added item. (The pre-fix engine wrote no version for it,
    // so seed the version here: this is what makes the old hard DELETE fail on content_versions' FK.)
    await q(
      t,
      `INSERT INTO content_versions (tenant_id, content_item_id, version, blocks, seo, publish_state, created_by)
       SELECT $1, $2, COALESCE(max(version), 0) + 1, '[]'::jsonb, '{}'::jsonb, 'draft', 'editor' FROM content_versions WHERE content_item_id = $2`,
      [t.tenantId, about.id],
    );
    const versionsBefore = await q(t, `SELECT version, blocks, seo, created_by FROM content_versions WHERE content_item_id = $1 ORDER BY version`, [about.id]);
    expect(versionsBefore.length).toBeGreaterThanOrEqual(1);

    const rollback = await rollbackReq(app, t);
    expect(rollback.statusCode).toBe(201);
    expect(rollback.json().status).toBe("rolled_back");
    expect(rollback.json().applyResult.itemsDeleted).toBe(1);

    const rows = await q<{ slug: string; deleted: boolean }>(t, `SELECT slug, deleted_at IS NOT NULL AS deleted FROM content_items WHERE site_id = $1 ORDER BY slug`, [t.siteId]);
    expect(rows).toEqual([
      { slug: "about", deleted: true },
      { slug: "home", deleted: false },
    ]);
    // Append-only history survives, byte for byte.
    const versionsAfter = await q(t, `SELECT version, blocks, seo, created_by FROM content_versions WHERE content_item_id = $1 ORDER BY version`, [about.id]);
    expect(versionsAfter).toEqual(versionsBefore);
  });

  it("content.rollback of an item renamed after the snapshot: the same item is back on the snapshot slug; no ux_content_items_group_locale error", async () => {
    const t = await provisionTenantSiteEnvs(app);
    const home = await seedOneItem(t.tenantId, t.siteId, { collectionKey: "page", slug: "home", title: "Home" });
    const promote = await promoteReq(app, t, { version: "v-before-rename" }); // snapshot = {home}
    expect(promote.statusCode).toBe(201);

    await q(t, `UPDATE content_items SET slug = 'home-renamed' WHERE id = $1`, [home.id]);

    const rollback = await rollbackReq(app, t);
    expect(rollback.statusCode).toBe(201);
    expect(rollback.json().applyResult).toMatchObject({ itemsWritten: 1, itemsDeleted: 0 });

    const rows = await q<{ id: string; slug: string; head_version: number; deleted: boolean }>(
      t,
      `SELECT id, slug, head_version, deleted_at IS NOT NULL AS deleted FROM content_items WHERE site_id = $1`,
      [t.siteId],
    );
    // Matched by (site, group, locale), so it is the SAME row: no second row, no resurrected duplicate.
    // Only the slug differed (content and publish fields equal), so no version was appended.
    expect(rows).toEqual([{ id: home.id, slug: "home", head_version: 0, deleted: false }]);
    expect(await q(t, `SELECT 1 FROM content_versions WHERE content_item_id = $1`, [home.id])).toHaveLength(0);
  });

  it("content.promote onto a slug a DIFFERENT live item holds: 409 slug-taken naming the bundle item, and NOTHING changed", async () => {
    const t = await provisionTenantSiteEnvs(app);
    await seedOneItem(t.tenantId, t.siteId, { collectionKey: "page", slug: "about", title: "Local About" });
    const before = await dumpContent(t);

    const bundle = {
      siteId: "x",
      exportedAt: new Date().toISOString(),
      collections: [{ key: "page", schema: {} }],
      contentItems: [bundleItem({ slug: "about", seo: { title: "Bundle About" } })], // a different group: a different item
      mediaAssets: [],
    };
    const res = await promoteReq(app, t, { version: "v-slug-collision", bundle });
    expect(res.statusCode).toBe(409);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(res.json()).toMatchObject({
      type: "https://webdesk.gaiada.online/errors/slug-taken",
      status: 409,
      collectionKey: "page",
      locale: "en-US",
      slug: "about",
    });

    expect(await dumpContent(t)).toEqual(before); // the local "about" was not overwritten, nothing was added
    const run = await q<{ status: string; error_detail: { step: string; message: string } }>(
      t,
      `SELECT status, error_detail FROM promotion_runs WHERE target_env_id = $1 AND version = 'v-slug-collision'`,
      [t.prodEnvId],
    );
    expect(run[0].status).toBe("failed");
    expect(run[0].error_detail.message).toContain("slug-taken");
  });

  it("content.rollback onto slugs that two described items have swapped: 409 slug-taken (a cycle no order can resolve), and NOTHING changed", async () => {
    const t = await provisionTenantSiteEnvs(app);
    const a = await seedOneItem(t.tenantId, t.siteId, { collectionKey: "page", slug: "x", title: "A" });
    const b = await seedOneItem(t.tenantId, t.siteId, { collectionKey: "page", slug: "y", title: "B" });
    expect((await promoteReq(app, t, { version: "v-before-swap" })).statusCode).toBe(201); // snapshot = {A:x, B:y}

    await q(t, `UPDATE content_items SET slug = 'tmp' WHERE id = $1`, [a.id]);
    await q(t, `UPDATE content_items SET slug = 'x' WHERE id = $1`, [b.id]);
    await q(t, `UPDATE content_items SET slug = 'y' WHERE id = $1`, [a.id]);
    const before = await dumpContent(t);

    const res = await rollbackReq(app, t);
    expect(res.statusCode).toBe(409);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(res.json().type).toBe("https://webdesk.gaiada.online/errors/slug-taken");
    expect(await dumpContent(t)).toEqual(before);
  });

  it("content.rollback resolves a slug CHAIN by ordering: B moves off the slug A needs first", async () => {
    const t = await provisionTenantSiteEnvs(app);
    const a = await seedOneItem(t.tenantId, t.siteId, { collectionKey: "page", slug: "x", title: "A" });
    const b = await seedOneItem(t.tenantId, t.siteId, { collectionKey: "page", slug: "y", title: "B" });
    expect((await promoteReq(app, t, { version: "v-before-chain" })).statusCode).toBe(201); // snapshot = {A:x, B:y}

    await q(t, `UPDATE content_items SET slug = 'x2' WHERE id = $1`, [a.id]);
    await q(t, `UPDATE content_items SET slug = 'x' WHERE id = $1`, [b.id]); // B now holds the slug A must return to

    const res = await rollbackReq(app, t);
    expect(res.statusCode).toBe(201);
    expect(res.json().applyResult).toMatchObject({ itemsWritten: 2, itemsDeleted: 0 });
    const rows = await q<{ id: string; slug: string }>(t, `SELECT id, slug FROM content_items WHERE site_id = $1 AND deleted_at IS NULL ORDER BY slug`, [t.siteId]);
    expect(rows).toEqual([
      { id: a.id, slug: "x" },
      { id: b.id, slug: "y" },
    ]);
  });

  it("a bundle item whose group+locale is live in ANOTHER collection: 409 bundle-group-collection-mismatch, nothing changed", async () => {
    const t = await provisionTenantSiteEnvs(app);
    const home = await seedOneItem(t.tenantId, t.siteId, { collectionKey: "page", slug: "home", title: "Home" });
    const before = await dumpContent(t);
    const bundle = {
      siteId: "x",
      exportedAt: new Date().toISOString(),
      collections: [{ key: "page", schema: {} }, { key: "post", schema: {} }],
      contentItems: [bundleItem({ collectionKey: "post", slug: "home", localizationGroupId: home.groupId })],
      mediaAssets: [],
    };
    const res = await promoteReq(app, t, { version: "v-mismatch", bundle });
    expect(res.statusCode).toBe(409);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(res.json()).toMatchObject({ type: "https://webdesk.gaiada.online/errors/bundle-group-collection-mismatch", collectionKey: "post", locale: "en-US", slug: "home" });
    // The `post` collection definition the bundle declares was written inside the same rolled-back transaction.
    expect(await dumpContent(t)).toEqual(before);
    expect(await q(t, `SELECT 1 FROM collections WHERE site_id = $1 AND key = 'post'`, [t.siteId])).toHaveLength(0);
  });

  it("after a promotion each changed item's head/published version is a version whose blocks+seo equal the projection; an unchanged item gets none; attribution carries the approval id; rollback appends too", async () => {
    const t = await provisionTenantSiteEnvs(app);
    const u = await seedOneItem(t.tenantId, t.siteId, { collectionKey: "page", slug: "unchanged", title: "U" });
    const v = await seedOneItem(t.tenantId, t.siteId, { collectionKey: "page", slug: "changing", title: "V before" });
    const uBefore = (await q<{ updated_at: Date }>(t, `SELECT updated_at FROM content_items WHERE id = $1`, [u.id]))[0];

    const bundle = await exportBundleOf(app, t); // U and V exactly as they are
    const vItem = bundle.contentItems.find((i) => i.slug === "changing")!;
    vItem.seo = { title: "V after" };
    vItem.blocks = [{ type: "hero", props: { heading: "V after" } }];
    bundle.contentItems.push(
      bundleItem({ slug: "new-live", seo: { title: "N" }, blocks: [{ type: "richText", props: { content: "n" } }] }),
      bundleItem({ slug: "new-draft", publishState: "draft", seo: { title: "D" } }),
      bundleItem({ slug: "new-scheduled", publishState: "scheduled", publishAt: "2031-01-01T00:00:00.000Z", seo: { title: "S" } }),
    );

    const approval = randomUUID();
    const promote = await promoteReq(app, t, { version: "v-versions", bundle }, { ws4: approval, automation: true });
    expect(promote.statusCode).toBe(201);
    const body = promote.json();
    expect(body.applyResult).toMatchObject({ itemsWritten: 4, itemsUnchanged: 1, itemsDeleted: 0 });

    const rows = await q<{
      slug: string;
      state: string;
      head_version: number;
      published_version: number | null;
      last_published_by: string | null;
      last_published_at: Date | null;
      versions: number;
      same: boolean | null;
      hash_ok: boolean | null;
      v_state: string | null;
      v_created_by: string | null;
      v_attr: Record<string, string> | null;
      v_note: string | null;
    }>(
      t,
      `SELECT ci.slug, ci.publish_state AS state, ci.head_version, ci.published_version, ci.last_published_by, ci.last_published_at,
              (SELECT count(*)::int FROM content_versions x WHERE x.content_item_id = ci.id) AS versions,
              (v.blocks = ci.blocks AND v.seo = ci.seo) AS same,
              (v.content_hash IS NOT NULL) AS hash_ok,
              v.publish_state AS v_state, v.created_by AS v_created_by, v.attribution AS v_attr, v.note AS v_note
         FROM content_items ci
         LEFT JOIN content_versions v ON v.content_item_id = ci.id AND v.version = ci.head_version
        WHERE ci.site_id = $1 AND ci.deleted_at IS NULL ORDER BY ci.slug`,
      [t.siteId],
    );
    const by = Object.fromEntries(rows.map((r) => [r.slug, r]));

    // unchanged: not touched at all
    expect(by.unchanged).toMatchObject({ head_version: 0, published_version: null, versions: 0 });
    const uAfter = (await q<{ updated_at: Date }>(t, `SELECT updated_at FROM content_items WHERE id = $1`, [u.id]))[0];
    expect(uAfter.updated_at).toEqual(uBefore.updated_at);

    const note = `promotion ${body.promotionRunId}`;
    const attribution = { pk: "automation", apr: approval };
    for (const slug of ["changing", "new-live", "new-draft", "new-scheduled"]) {
      const r = by[slug];
      expect(r.versions, slug).toBe(1);
      expect(r.head_version, slug).toBe(1);
      expect(r.same, `${slug}: the head version's blocks+seo equal the projection`).toBe(true);
      expect(r.hash_ok, slug).toBe(true);
      expect(r.v_created_by, slug).toBe(PRINCIPAL);
      expect(r.v_attr, slug).toEqual(attribution);
      expect(r.v_note, slug).toBe(note);
    }
    // published / scheduled: published_version points at the version, last_published_* set
    for (const slug of ["changing", "new-live", "new-scheduled"]) {
      expect(by[slug].published_version, slug).toBe(1);
      expect(by[slug].last_published_by, slug).toBe(PRINCIPAL);
      expect(by[slug].last_published_at, slug).not.toBeNull();
    }
    expect(by["new-scheduled"].state).toBe("scheduled");
    expect(by["new-scheduled"].last_published_at).toEqual(new Date("2031-01-01T00:00:00.000Z"));
    // draft: head moves, nothing is published
    expect(by["new-draft"]).toMatchObject({ state: "draft", published_version: null, last_published_by: null, v_state: "draft" });
    // the version's content hash is the write plane's (contentHash over {blocks, seo})
    const [vRow] = await q<{ blocks: unknown; seo: unknown; content_hash: string }>(
      t,
      `SELECT blocks, seo, content_hash FROM content_versions WHERE content_item_id = $1 AND version = 1`,
      [v.id],
    );
    expect(vRow.content_hash).toBe(contentHash(vRow.blocks, vRow.seo));

    // The rollback appends too: V goes back to its snapshot content as version 2, and the three
    // added items are soft-deleted (their versions stay).
    const rollApproval = randomUUID();
    const rb = await rollbackReq(app, t, { ws4: rollApproval, automation: true });
    expect(rb.statusCode).toBe(201);
    expect(rb.json().applyResult).toMatchObject({ itemsWritten: 1, itemsDeleted: 3, itemsUnchanged: 1 });
    const [vAfter] = await q<{
      head_version: number;
      published_version: number | null;
      same: boolean;
      note: string;
      attr: Record<string, string>;
      title: string;
    }>(
      t,
      `SELECT ci.head_version, ci.published_version, (ver.blocks = ci.blocks AND ver.seo = ci.seo) AS same,
              ver.note, ver.attribution AS attr, ci.seo ->> 'title' AS title
         FROM content_items ci JOIN content_versions ver ON ver.content_item_id = ci.id AND ver.version = ci.head_version
        WHERE ci.id = $1`,
      [v.id],
    );
    expect(vAfter).toMatchObject({ head_version: 2, published_version: 2, same: true, title: "V before", note: `rollback ${rb.json().promotionRunId}`, attr: { pk: "automation", apr: rollApproval } });
    const kept = await q<{ slug: string }>(t, `SELECT slug FROM content_items WHERE site_id = $1 AND deleted_at IS NULL ORDER BY slug`, [t.siteId]);
    expect(kept.map((r) => r.slug)).toEqual(["changing", "unchanged"]);
    expect(await q(t, `SELECT 1 FROM content_versions cv JOIN content_items ci ON ci.id = cv.content_item_id WHERE ci.site_id = $1 AND ci.slug LIKE 'new-%'`, [t.siteId])).toHaveLength(3);
  });
});

// Sanity: prove the skip guard above is reachable (documents the honest limit rather than hiding it).
if (!TARGET_MIGRATOR_URL || !TARGET_APP_URL) {
  // eslint-disable-next-line no-console
  console.log(
    "[promotion-content-flow] cross-instance test SKIPPED — WSK25_TARGET_MIGRATE_DATABASE_URL/WSK25_TARGET_APP_DATABASE_URL not set. See README.md's WSK-25 runbook for the second-database setup.",
  );
}
