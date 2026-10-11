// WSK-46 — shared helpers for test/preview-token-*.spec.ts and test/delivery/preview-endpoint.spec.ts
// (not a spec itself: vitest only collects *.spec.ts). Builds on content-test-kit.ts (real Postgres,
// the real AppModule, the real Layer-3/4 PDP, dev-mode Layer 1/2/2e header stubs).
import { createHash, randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import {
  asTenant,
  base,
  createItem,
  hdr,
  publishItems,
  serviceFields,
  type ContentFixture,
  type HeaderOpts,
} from "./content-test-kit";

export const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

export const itemBase = (fx: ContentFixture, itemId: string): string => `${base(fx)}/items/${itemId}`;

export interface MintBody {
  version?: number | null;
  ttlSeconds?: number | null;
}

export interface MintedPreview {
  tokenId: string;
  token: string;
  expiresAt: string;
  version: number;
  previewPath: string;
  replayed: boolean;
}

export function mintPreview(
  app: NestFastifyApplication,
  fx: ContentFixture,
  itemId: string,
  body: Record<string, unknown> = {},
  opts: HeaderOpts = {},
) {
  return app.inject({ method: "POST", url: `${itemBase(fx, itemId)}/preview-token`, headers: hdr(opts), payload: body });
}

export function revokePreview(app: NestFastifyApplication, fx: ContentFixture, itemId: string, tokenId: string, opts: HeaderOpts = {}) {
  return app.inject({ method: "DELETE", url: `${itemBase(fx, itemId)}/preview-tokens/${tokenId}`, headers: hdr(opts) });
}

/** An unpublished item with ONE version (draft). Returns its id and slug. */
export async function draftItem(app: NestFastifyApplication, fx: ContentFixture, h1: string, label = "pv") {
  const slug = `service.${label}-${randomUUID().slice(0, 6)}`;
  const r = await createItem(app, fx, { collectionKey: "service", locale: "en", slug, fields: serviceFields({ h1 }) });
  if (r.statusCode !== 201) throw new Error(`draftItem: create answered ${r.statusCode} ${r.body}`);
  return { itemId: r.json().item.itemId as string, slug };
}

/** Appends a version (a new head) to an item, returns the new head version. */
export async function appendVersion(app: NestFastifyApplication, fx: ContentFixture, itemId: string, baseVersion: number, h1: string): Promise<number> {
  const r = await app.inject({
    method: "PUT",
    url: itemBase(fx, itemId),
    headers: hdr(),
    payload: { baseVersion, fields: serviceFields({ h1 }) },
  });
  if (r.statusCode !== 200) throw new Error(`appendVersion: update answered ${r.statusCode} ${r.body}`);
  return r.json().version.version as number;
}

/**
 * An item whose LIVE version (1, h1 = `live`) differs from its HEAD (2, h1 = `draft`): the exact shape
 * a draft preview exists for. Version 1 is published; version 2 is only a working copy.
 */
export async function liveItemWithNewerDraft(app: NestFastifyApplication, fx: ContentFixture, live: string, draft: string, label = "pv") {
  const { itemId, slug } = await draftItem(app, fx, live, label);
  const pub = await publishItems(app, fx, [{ itemId, version: 1 }]);
  if (pub.statusCode !== 200) throw new Error(`liveItemWithNewerDraft: publish answered ${pub.statusCode} ${pub.body}`);
  const head = await appendVersion(app, fx, itemId, 1, draft);
  return { itemId, slug, liveVersion: 1, headVersion: head };
}

/** Sets environments.domain for the fixture's two environments (the CORS allow-list source). */
export async function setDomains(fx: ContentFixture, domains: { staging?: string | null; production?: string | null }): Promise<void> {
  await asTenant(fx.tenantId, async (db) => {
    if (domains.staging !== undefined) await db.query(`UPDATE environments SET domain = $1 WHERE id = $2`, [domains.staging, fx.stagingEnvId]);
    if (domains.production !== undefined) await db.query(`UPDATE environments SET domain = $1 WHERE id = $2`, [domains.production, fx.productionEnvId]);
  });
}

/** Every column of every preview_tokens row of the tenant, as text — for "the plaintext is nowhere at rest" greps. */
export async function dumpPreviewTokens(fx: ContentFixture): Promise<Record<string, unknown>[]> {
  return asTenant(fx.tenantId, async (db) => (await db.query(`SELECT * FROM preview_tokens WHERE tenant_id = $1 ORDER BY created_at`, [fx.tenantId])).rows);
}

/** Every control_idempotency_keys row of the tenant (the stored replay records). */
export async function dumpIdempotency(fx: ContentFixture): Promise<Record<string, unknown>[]> {
  return asTenant(fx.tenantId, async (db) => (await db.query(`SELECT * FROM control_idempotency_keys WHERE tenant_id = $1`, [fx.tenantId])).rows);
}

export async function dumpAudit(fx: ContentFixture): Promise<Record<string, unknown>[]> {
  return asTenant(fx.tenantId, async (db) => (await db.query(`SELECT * FROM audit_entries WHERE tenant_id = $1`, [fx.tenantId])).rows);
}

/** Forces a token past its expiry without touching anything else (the CHECK needs created_at moved too). */
export async function expireToken(fx: ContentFixture, tokenId: string): Promise<void> {
  await asTenant(fx.tenantId, async (db) => {
    await db.query(
      `UPDATE preview_tokens SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute' WHERE id = $1`,
      [tokenId],
    );
  });
}
