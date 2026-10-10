// WSK-41 — shared harness for test/content-*.spec.ts (not a spec itself: vitest only collects
// *.spec.ts). Real Postgres (migrations 0001-0009, webdesk_app NOBYPASSRLS), real Redis (the
// tenant-webhook queue), the real AppModule as shipped, and — the WSK-22 pattern — the REAL
// PolicyDecisionPoint forced in place of the NODE_ENV=test stub, so Layer 3 scopes and Layer 4 WS4
// (HMAC + commandHash + single-use) are the production code. Layers 1/2 (mTLS, Keycloak) and 2e
// (editorial) stay the NODE_ENV=test header stubs, per the WSK-41 done-when.
//
// Env: the same names the CI webdesk-api job sets (APP_DATABASE_URL / MIGRATE_DATABASE_URL /
// REDIS_URL / WEBDESK_APPROVAL_ASSERTION_KEY ...), each with a localhost fallback.
process.env.NODE_ENV = "test";
process.env.APP_DATABASE_URL =
  process.env.WSK41_TEST_DATABASE_URL || process.env.APP_DATABASE_URL || "postgres://webdesk_app:throwaway_app@localhost:5432/webdesk";
process.env.API_KEY_PEPPER = process.env.API_KEY_PEPPER || "wsk41-test-pepper";
process.env.WEBDESK_READ_QUOTA_PER_MIN = process.env.WEBDESK_READ_QUOTA_PER_MIN || "100000";
process.env.WEBDESK_APPROVAL_ASSERTION_KEY = process.env.WEBDESK_APPROVAL_ASSERTION_KEY || "wsk41-test-ws4-assertion-key";

import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { Test, type TestingModuleBuilder } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "../src/app.module";
import { POLICY_DECISION_POINT } from "../src/control/policy/policy-decision-point";
import { RealPolicyDecisionPoint } from "../src/control/policy/real-policy-decision-point";
import { mintWs4Assertion, computeCommandHash } from "../src/control/auth/ws4-assertion";
import { ApiKeysService } from "../src/api-keys/api-keys.service";

export const MIGRATOR_URL =
  process.env.WSK41_MIGRATE_DATABASE_URL ||
  process.env.MIGRATE_DATABASE_URL ||
  "postgres://webdesk_migrator:throwaway_migrator@localhost:5432/webdesk";

/** The real AppModule with the real Layer-3/4 PDP. `extra` can override more providers. */
export async function buildContentApp(extra?: (b: TestingModuleBuilder) => TestingModuleBuilder): Promise<NestFastifyApplication> {
  let builder = Test.createTestingModule({ imports: [AppModule] }).overrideProvider(POLICY_DECISION_POINT).useClass(RealPolicyDecisionPoint);
  if (extra) builder = extra(builder);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: ["error"] });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

// ------------------------------------------------------------------------------------------------
// Compositions used by the fixtures (vocabulary 1.1.0, write-plane design §2.4)
// ------------------------------------------------------------------------------------------------
export const SERVICE_COMPOSITION = {
  fields: [
    { name: "url", primitive: "text", required: true },
    { name: "h1", primitive: "text" },
    { name: "publish_ready", primitive: "boolean" },
    { name: "body", primitive: "markdown" },
    {
      name: "faq",
      primitive: "group",
      multiple: true,
      itemKey: "key",
      fields: [
        { name: "key", primitive: "text", required: true },
        { name: "q", primitive: "text" },
        { name: "a", primitive: "text" },
      ],
    },
  ],
  blocks: ["richText"],
  ui: { label: "Service pages", group: "Pages", titleField: "h1" },
  lint: {
    placeholders: [
      { kind: "token", open: "{{", close: "}}", registry: { collection: "token-registry", listField: "tokens", keyField: "key", valueField: "value" } },
      { kind: "marker", open: "[CONFIRM:", close: "]", label: "CONFIRM" },
      { kind: "marker", open: "[CLIENT:", close: "]", label: "CLIENT" },
    ],
  },
};
export const NAVIGATION_COMPOSITION = { fields: [{ name: "cta", primitive: "text" }], blocks: [], singleton: true };
export const COMPANY_COMPOSITION = { fields: [{ name: "name", primitive: "text", required: true }], blocks: [], singleton: true, localized: false };
export const REDIRECT_COMPOSITION = {
  fields: [
    { name: "toPath", primitive: "text", required: true },
    { name: "status", primitive: "select", options: ["301", "302", "307", "308"] },
    { name: "active", primitive: "select", options: ["true", "false"] },
  ],
};
export const TOKEN_REGISTRY_COMPOSITION = {
  fields: [
    {
      name: "tokens",
      primitive: "group",
      multiple: true,
      itemKey: "key",
      fields: [
        { name: "key", primitive: "text", required: true },
        { name: "value", primitive: "text" },
      ],
    },
  ],
  blocks: [],
  singleton: true,
  localized: false,
};

export interface ContentFixture {
  tenantId: string;
  slug: string;
  siteId: string;
  stagingEnvId: string;
  productionEnvId: string;
  collections: Record<string, string>;
}

/** A tenant (locales en+id, default en), one site with staging+production, and the five collections. */
export async function createContentFixture(label: string): Promise<ContentFixture> {
  const client = new Client({ connectionString: MIGRATOR_URL });
  await client.connect();
  try {
    const slug = `wsk41-${label}-${randomUUID().slice(0, 8)}`;
    const tenantId = randomUUID();
    const siteId = randomUUID();
    const stagingEnvId = randomUUID();
    const productionEnvId = randomUUID();
    const collections: Record<string, string> = {};
    await client.query("BEGIN");
    await client.query("SET LOCAL webdesk.platform_ctx = 'true'");
    await client.query(
      `INSERT INTO tenants (id, slug, company_ref, status, default_locale, locales) VALUES ($1, $2, $3, 'active', 'en', ARRAY['en','id'])`,
      [tenantId, slug, randomUUID()],
    );
    await client.query("SET LOCAL webdesk.platform_ctx = ''");
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenantId]);
    await client.query(`INSERT INTO sites (id, tenant_id, kind, name) VALUES ($1, $2, 'astro', $3)`, [siteId, tenantId, `${label} site`]);
    await client.query(`INSERT INTO environments (id, site_id, tenant_id, name, status) VALUES ($1, $2, $3, 'staging', 'active')`, [
      stagingEnvId,
      siteId,
      tenantId,
    ]);
    await client.query(`INSERT INTO environments (id, site_id, tenant_id, name, status) VALUES ($1, $2, $3, 'production', 'active')`, [
      productionEnvId,
      siteId,
      tenantId,
    ]);
    const defs: Record<string, unknown> = {
      service: SERVICE_COMPOSITION,
      navigation: NAVIGATION_COMPOSITION,
      company: COMPANY_COMPOSITION,
      redirect: REDIRECT_COMPOSITION,
      "token-registry": TOKEN_REGISTRY_COMPOSITION,
    };
    for (const [key, schema] of Object.entries(defs)) {
      const id = randomUUID();
      await client.query(`INSERT INTO collections (id, tenant_id, site_id, key, schema) VALUES ($1, $2, $3, $4, $5::jsonb)`, [
        id,
        tenantId,
        siteId,
        key,
        JSON.stringify(schema),
      ]);
      collections[key] = id;
    }
    await client.query("COMMIT");
    return { tenantId, slug, siteId, stagingEnvId, productionEnvId, collections };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

/** Raw SQL as the migrator under one tenant's context — proves the app's writes without the app's reads. */
export async function asTenant<T>(tenantId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: MIGRATOR_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenantId]);
    const r = await fn(client);
    await client.query("COMMIT");
    return r;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

export async function asPlatform<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: MIGRATOR_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL webdesk.platform_ctx = 'true'");
    const r = await fn(client);
    await client.query("COMMIT");
    return r;
  } finally {
    await client.end();
  }
}

export async function mintReadKeys(app: NestFastifyApplication, fx: ContentFixture): Promise<{ production: string; staging: string }> {
  const keys = app.get(ApiKeysService);
  const production = (await keys.mint(fx.tenantId, fx.productionEnvId, "read", "wsk41-test")).key;
  const staging = (await keys.mint(fx.tenantId, fx.stagingEnvId, "read", "wsk41-test")).key;
  return { production, staging };
}

// ------------------------------------------------------------------------------------------------
// Request helpers
// ------------------------------------------------------------------------------------------------
export const ALL_SCOPES = ["webdesk:read", "webdesk:operate", "webdesk:promote", "webdesk:keys"];

export interface HeaderOpts {
  scopes?: string[];
  /** `null` omits the editorial principal header entirely. */
  editorial?: string | null;
  idem?: string | null;
  ws4?: string;
}

export function hdr(opts: HeaderOpts = {}): Record<string, string> {
  const h: Record<string, string> = {
    "x-webdesk-control-principal": "erp-webdesk-control",
    "x-webdesk-control-scopes": (opts.scopes ?? ALL_SCOPES).join(","),
    "content-type": "application/json",
  };
  if (opts.editorial !== null) h["x-webdesk-editorial-principal"] = opts.editorial ?? "user-editor-1";
  if (opts.idem !== null) h["idempotency-key"] = opts.idem ?? `idem-${randomUUID()}`;
  if (opts.ws4) h["x-ws4-assertion"] = opts.ws4;
  return h;
}

/** A real WS4 assertion for `command` over route params ∪ body, exactly what CommandAuthorizationGuard hashes. */
export function ws4For(command: string, params: Record<string, unknown>, body: Record<string, unknown>, approvalId = `apr-${randomUUID()}`): string {
  return mintWs4Assertion(
    { approvalId, commandHash: computeCommandHash(command, { ...params, ...body }), exp: Math.floor(Date.now() / 1000) + 120 },
    process.env.WEBDESK_APPROVAL_ASSERTION_KEY as string,
  );
}

export function base(fx: ContentFixture): string {
  return `/control/v1/tenants/${fx.slug}/sites/${fx.siteId}/content`;
}

export function serviceFields(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: "/services/seo/",
    h1: "SEO Agency Bali",
    publish_ready: false,
    body: "# SEO Agency Bali\n\nGaia Digital Agency is an SEO agency in Bali.",
    faq: [
      { key: "q1", q: "How long?", a: "Three months." },
      { key: "q2", q: "How much?", a: "It depends." },
    ],
    ...over,
  };
}

export async function createItem(
  app: NestFastifyApplication,
  fx: ContentFixture,
  body: Record<string, unknown>,
  opts: HeaderOpts = {},
) {
  return app.inject({ method: "POST", url: `${base(fx)}/items`, headers: hdr(opts), payload: body });
}

export async function publishItems(
  app: NestFastifyApplication,
  fx: ContentFixture,
  items: { itemId: string; version: number }[],
  opts: { approvalId?: string; idem?: string; editorial?: string | null } = {},
) {
  const body = { items };
  const ws4 = ws4For("content.publish", { tenantSlug: fx.slug, siteId: fx.siteId }, body, opts.approvalId);
  return app.inject({
    method: "POST",
    url: `${base(fx)}/publish`,
    headers: hdr({ ws4, idem: opts.idem, editorial: opts.editorial }),
    payload: body,
  });
}

export async function v1Get(app: NestFastifyApplication, fx: ContentFixture, key: string, collection: string, slug: string, locale = "en") {
  return app.inject({
    method: "GET",
    url: `/v1/t/${fx.slug}/${collection}/${encodeURIComponent(slug)}?locale=${locale}`,
    headers: { authorization: `Bearer ${key}` },
  });
}

export async function waitFor<T>(check: () => Promise<T | null | undefined | false>, timeoutMs: number, intervalMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
