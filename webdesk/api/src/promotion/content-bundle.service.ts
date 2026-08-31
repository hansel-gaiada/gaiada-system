// WSK-25 — content export/import, the actual D-4 mechanism ("tenant-scoped logical export ...
// import on the target"). `exportBundle` is a plain read under the caller's own tenant context
// (no transaction needed — nothing mutates). `applyBundle` is the one function BOTH the
// migrate+import step and the rollback-restore step call — 'merge' mode never deletes anything
// outside the bundle (import should never destroy content the bundle doesn't know about); 'restore'
// mode additionally deletes local content_items that are NOT part of the bundle, within collections
// the bundle actually describes, so a rollback lands on EXACTLY the snapshotted state rather than a
// merge of it (see promotion-command.service.ts's rollback() for why that distinction matters: an
// item ADDED by the promotion being undone must not survive the rollback).
import { BadRequestException, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { DbService } from "../db/db.service";
import type { ApplyBundleResult, BundleContentItem, ContentBundle } from "./content-bundle.types";

/** Deterministic key ordering so the same logical bundle always hashes identically regardless of SQL row order or JS object key insertion order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function bundleChecksum(bundle: ContentBundle): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(bundle))).digest("hex");
}

interface ContentItemRow {
  collection_key: string;
  locale: string;
  slug: string;
  localization_group_id: string;
  blocks: unknown;
  seo: unknown;
  publish_state: BundleContentItem["publishState"];
  publish_at: string | null;
  unpublish_at: string | null;
  preview_token: string | null;
  search_text: string | null;
}

@Injectable()
export class ContentBundleService {
  constructor(private readonly db: DbService) {}

  /** Read-only. Must run under an already-active tenant context (`db.withTenant`). */
  async exportBundle(tenantId: string, siteId: string): Promise<ContentBundle> {
    return this.db.withTenant(tenantId, async (db) => {
      const { rows: collectionRows } = await db.query<{ key: string; schema: unknown }>(
        `SELECT key, schema FROM collections WHERE site_id = $1 ORDER BY key`,
        [siteId],
      );

      const { rows: itemRows } = await db.query<ContentItemRow>(
        `SELECT c.key AS collection_key, ci.locale, ci.slug, ci.localization_group_id,
                ci.blocks, ci.seo, ci.publish_state, ci.publish_at, ci.unpublish_at,
                ci.preview_token, ci.search_text
           FROM content_items ci
           JOIN collections c ON c.id = ci.collection_id
          WHERE ci.site_id = $1
          ORDER BY c.key, ci.locale, ci.slug`,
        [siteId],
      );

      const { rows: mediaRows } = await db.query<{ bucket_key: string; mime: string; size_bytes: string; scan_status: string }>(
        `SELECT bucket_key, mime, size_bytes, scan_status FROM media_assets WHERE site_id = $1 ORDER BY bucket_key`,
        [siteId],
      );

      const bundle: ContentBundle = {
        siteId,
        exportedAt: new Date().toISOString(),
        collections: collectionRows.map((r) => ({ key: r.key, schema: r.schema })),
        contentItems: itemRows.map((r) => ({
          collectionKey: r.collection_key,
          locale: r.locale,
          slug: r.slug,
          localizationGroupId: r.localization_group_id,
          blocks: r.blocks,
          seo: r.seo,
          publishState: r.publish_state,
          publishAt: r.publish_at,
          unpublishAt: r.unpublish_at,
          previewToken: r.preview_token,
          searchText: r.search_text,
        })),
        mediaAssets: mediaRows.map((r) => ({
          bucketKey: r.bucket_key,
          mime: r.mime,
          sizeBytes: Number(r.size_bytes),
          scanStatus: r.scan_status as "pending" | "clean" | "infected" | "error",
        })),
      };
      return bundle;
    });
  }

  /**
   * Writes `bundle` into the LOCAL `collections`/`content_items` for `targetSiteId`, resolving
   * every reference by natural key (never by the source database's own row ids — see
   * content-bundle.types.ts's header). Must run on a `client` that already has BEGIN issued and
   * the right tenant GUC set (i.e. inside `db.withTenant(tenantId, db => db.transaction(client =>
   * ...))`) — this function never opens or closes a transaction itself, so the caller controls
   * atomicity (the snapshot-first ordering this ticket must prove depends on that: the snapshot
   * commits in ITS OWN, already-closed transaction before this one even begins).
   */
  async applyBundle(
    client: PoolClient,
    tenantId: string,
    targetSiteId: string,
    bundle: ContentBundle,
    mode: "merge" | "restore",
  ): Promise<ApplyBundleResult> {
    const bundleKeys = bundle.collections.map((c) => c.key);
    const knownKeys = new Set(bundleKeys);
    for (const item of bundle.contentItems) {
      if (!knownKeys.has(item.collectionKey)) {
        throw new BadRequestException(
          `bundle content item references collection '${item.collectionKey}', which is not listed in bundle.collections — refusing a bundle that cannot resolve its own references`,
        );
      }
    }

    // --- 1. "migrate": upsert collection definitions (Layer-2 composition, WSK-14) -------------
    let collectionsWritten = 0;
    for (const col of bundle.collections) {
      await client.query(
        `INSERT INTO collections (id, tenant_id, site_id, key, schema)
         VALUES (gen_random_uuid(), $1, $2, $3, $4::jsonb)
         ON CONFLICT (site_id, key) DO UPDATE SET schema = EXCLUDED.schema, updated_at = now()`,
        [tenantId, targetSiteId, col.key, JSON.stringify(col.schema ?? {})],
      );
      collectionsWritten++;
    }

    const { rows: collectionIdRows } = await client.query<{ id: string; key: string }>(
      `SELECT id, key FROM collections WHERE site_id = $1 AND key = ANY($2::text[])`,
      [targetSiteId, bundleKeys],
    );
    const collectionIdByKey = new Map(collectionIdRows.map((r) => [r.key, r.id]));

    // --- 2. "import": upsert content items -----------------------------------------------------
    let itemsWritten = 0;
    for (const item of bundle.contentItems) {
      const collectionId = collectionIdByKey.get(item.collectionKey);
      if (!collectionId) {
        // Cannot happen given the pre-check above unless a concurrent writer removed the
        // collection between the upsert and this SELECT — fail loud rather than silently skip.
        throw new BadRequestException(`collection '${item.collectionKey}' could not be resolved on the target after migrate`);
      }
      await client.query(
        `INSERT INTO content_items
           (id, tenant_id, site_id, collection_id, locale, slug, localization_group_id, blocks, seo,
            publish_state, publish_at, unpublish_at, preview_token, search_text)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13)
         ON CONFLICT (collection_id, locale, slug) DO UPDATE SET
           blocks = EXCLUDED.blocks,
           seo = EXCLUDED.seo,
           publish_state = EXCLUDED.publish_state,
           publish_at = EXCLUDED.publish_at,
           unpublish_at = EXCLUDED.unpublish_at,
           preview_token = EXCLUDED.preview_token,
           search_text = EXCLUDED.search_text,
           updated_at = now()`,
        [
          tenantId,
          targetSiteId,
          collectionId,
          item.locale,
          item.slug,
          item.localizationGroupId,
          JSON.stringify(item.blocks ?? []),
          JSON.stringify(item.seo ?? {}),
          item.publishState,
          item.publishAt,
          item.unpublishAt,
          item.previewToken,
          item.searchText,
        ],
      );
      itemsWritten++;
    }

    // --- 3. 'restore' only: delete local items the bundle does NOT describe, within collections --
    //        the bundle DOES describe — an exact restore, not a merge (see this file's header).
    let itemsDeleted = 0;
    if (mode === "restore" && collectionIdRows.length > 0) {
      const bundleItemKeys = new Set(bundle.contentItems.map((i) => `${i.collectionKey} ${i.locale} ${i.slug}`));
      const collectionIds = collectionIdRows.map((r) => r.id);
      const { rows: existing } = await client.query<{ id: string; collection_key: string; locale: string; slug: string }>(
        `SELECT ci.id, c.key AS collection_key, ci.locale, ci.slug
           FROM content_items ci JOIN collections c ON c.id = ci.collection_id
          WHERE ci.collection_id = ANY($1::uuid[])`,
        [collectionIds],
      );
      const toDelete = existing.filter((r) => !bundleItemKeys.has(`${r.collection_key} ${r.locale} ${r.slug}`));
      if (toDelete.length > 0) {
        await client.query(
          `DELETE FROM content_items WHERE id = ANY($1::uuid[])`,
          [toDelete.map((r) => r.id)],
        );
        itemsDeleted = toDelete.length;
      }
    }

    // --- 4. media metadata — HONEST gap, never fabricated (see content-bundle.types.ts) ---------
    const bundleMediaKeys = bundle.mediaAssets.map((m) => m.bucketKey);
    let mediaAssetKeysNotTransferred: string[] = [];
    if (bundleMediaKeys.length > 0) {
      const { rows: presentRows } = await client.query<{ bucket_key: string }>(
        `SELECT bucket_key FROM media_assets WHERE tenant_id = $1 AND bucket_key = ANY($2::text[])`,
        [tenantId, bundleMediaKeys],
      );
      const present = new Set(presentRows.map((r) => r.bucket_key));
      mediaAssetKeysNotTransferred = bundleMediaKeys.filter((k) => !present.has(k));
    }

    return { collectionsWritten, itemsWritten, itemsDeleted, mediaAssetKeysNotTransferred };
  }
}
