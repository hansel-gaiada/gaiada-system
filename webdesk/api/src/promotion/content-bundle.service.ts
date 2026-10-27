// WSK-25 — content export/import, the actual D-4 mechanism ("tenant-scoped logical export ...
// import on the target"). `exportBundle` is a plain read under the caller's own tenant context
// (no transaction needed — nothing mutates). `applyBundle` is the one function BOTH the
// migrate+import step and the rollback-restore step call.
//
// HOW THIS FITS THE WRITE PLANE (WSK-41, migrations 0009 + 0010, owner ruling WSK-D51). The write
// plane's storage model is: content_items is the live projection, content_versions is the append-only
// editorial history, head_version / published_version point at it, and deleting is a SOFT delete
// (deleted_at) that releases the item's slug. This module honours all four:
//   * IDENTITY. An item is identified by (site, localization group, locale), the key of 0009's
//     ux_content_items_group_locale; the slug is mutable and is NOT identity. Bundle items are matched
//     to local LIVE rows by that key (locked FOR UPDATE). Same collection: the row is updated, slug
//     included. A different collection: refused (409 bundle-group-collection-mismatch). No live match:
//     a NEW row is inserted. A soft-deleted row is never matched and never revived: bringing content
//     back onto a slug that a live item now holds is a 409 slug-taken, not an overwrite (WSK-D51).
//   * EXPORT leaves soft-deleted items out, so neither a snapshot nor a promotion can resurrect them.
//   * 'merge' mode never removes anything the bundle does not describe. 'restore' mode additionally
//     SOFT-deletes (deleted_at = now()) live local items that the bundle does not describe, by group +
//     locale identity, within the collections the bundle describes, BEFORE any item is written so their
//     slugs and group slots are free: a rollback lands on exactly the snapshotted live set, an item the
//     promotion added does not survive it, and its content_versions history (append-only, FK-protected)
//     is kept. Nothing here ever issues DELETE FROM content_items.
//   * VERSIONS. Every item this function actually changes gets ONE appended content_versions row (via
//     the write plane's own insertContentVersion: version = next number, content_hash over {blocks,
//     seo}, created_by = the promotion's principal, attribution {pk, apr} with the WS4 approval id, a
//     note naming the promotion run), and head_version / published_version / last_published_* are set to
//     match it, so the editor's working copy and production agree. An item whose content hash AND
//     publish fields already equal the bundle's is not touched (no version, no updated_at bump). An item
//     that differs ONLY in slug or preview token is updated in place without a version: a version holds
//     blocks and seo, and the write plane likewise writes no version for a no-op save.
//
// ATOMICITY. This function never opens or closes a transaction itself; the caller runs it inside one
// (`db.transaction`), so ANY refusal below (slug-taken, group-collection mismatch, a CHECK violation)
// rolls the whole import back, collection definitions included: nothing changed.
//
// SLUG ORDERING. A restore can legitimately need two renames in a chain (B moves off the slug A must
// return to). Items are written in rounds: an item whose target slug is currently held by another
// item that is itself still to be written waits for that item. Anything left in a cycle (a pure swap)
// is attempted anyway and the unique index refuses it: 409 slug-taken. A slug held by a live item the
// bundle does not describe is refused in 'merge' mode (that item is not ours to remove) and is
// soft-deleted first in 'restore' mode (that is the point of an exact restore).
import { BadRequestException, Injectable } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { DbService } from "../db/db.service";
import { contentHash } from "../control/content/content-projection";
import { extractSearchText } from "../control/content/search-text";
import { attributionOf, insertContentVersion, nextVersionNumber } from "../control/content/content-versions";
import { ControlProblem, problems } from "../control/content/content-problem";
import type { ApplyBundleResult, BundleContentItem, BundleWriter, ContentBundle } from "./content-bundle.types";

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

/** A live local row of the target site, locked FOR UPDATE for the duration of the import. */
interface LocalRow {
  id: string;
  collection_id: string;
  collection_key: string;
  localization_group_id: string;
  locale: string;
  slug: string;
  blocks: unknown;
  seo: unknown;
  publish_state: string;
  publish_at: Date | null;
  unpublish_at: Date | null;
  preview_token: string | null;
  head_version: number;
}

interface WorkItem {
  item: BundleContentItem;
  collectionId: string;
  local: LocalRow | null;
  /** Where the item must end up: its (collection, locale, slug). */
  targetKey: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** (localization group, locale): the item's identity (0009's ux_content_items_group_locale, within one site). */
const identityKey = (groupId: string, locale: string) => JSON.stringify([groupId.toLowerCase(), locale]);
const slugKey = (collectionId: string, locale: string, slug: string) => JSON.stringify([collectionId, locale, slug]);

/** Both null/absent, or the same instant. */
function sameInstant(local: Date | null, bundle: string | null | undefined): boolean {
  if (local === null) return bundle === null || bundle === undefined;
  if (bundle === null || bundle === undefined) return false;
  return local.getTime() === new Date(bundle).getTime();
}

const itemLabel = (i: Pick<BundleContentItem, "collectionKey" | "locale" | "slug">) => `${i.collectionKey}/${i.locale}/${i.slug}`;

function slugTaken(i: BundleContentItem): ControlProblem {
  return problems.conflict(
    "slug-taken",
    "Slug taken",
    `Bundle item ${itemLabel(i)} cannot be written: a live item already holds that slug in this collection and locale. A soft-deleted item releases its slug, a live one does not. Nothing was changed.`,
    { collectionKey: i.collectionKey, locale: i.locale, slug: i.slug },
  );
}

function twinLocaleTaken(i: BundleContentItem): ControlProblem {
  return problems.conflict(
    "twin-locale-taken",
    "Twin locale taken",
    `Bundle item ${itemLabel(i)} cannot be written: its localization group already has a live item in this locale (created concurrently). Nothing was changed.`,
    { collectionKey: i.collectionKey, locale: i.locale, slug: i.slug },
  );
}

/** Translates the unique indexes a bundle write can trip into the documented problems; everything else is rethrown as is. */
function mapWriteError(err: unknown, i: BundleContentItem): unknown {
  const e = err as { code?: string; constraint?: string };
  if (e?.code !== "23505") return err;
  if (e.constraint === "ux_content_items_slug_live") return slugTaken(i);
  if (e.constraint === "ux_content_items_group_locale") return twinLocaleTaken(i);
  return err;
}

@Injectable()
export class ContentBundleService {
  constructor(private readonly db: DbService) {}

  /** Read-only. Must run under an already-active tenant context (`db.withTenant`). Live (non-deleted) items only. */
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
          WHERE ci.site_id = $1 AND ci.deleted_at IS NULL
          ORDER BY c.key, ci.locale, ci.slug`,
        [siteId],
      );

      const { rows: mediaRows } = await db.query<{ bucket_key: string; mime: string; size_bytes: string; scan_status: string }>(
        `SELECT bucket_key, mime, size_bytes, scan_status FROM media_assets WHERE site_id = $1 AND deleted_at IS NULL AND review_state = 'accepted' ORDER BY bucket_key`,
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
   * Writes `bundle` into the LOCAL `collections`/`content_items`/`content_versions` for
   * `targetSiteId`, resolving every reference by natural key (never by the source database's own row
   * ids — see content-bundle.types.ts's header). Must run on a `client` that already has BEGIN issued
   * and the right tenant GUC set (i.e. inside `db.withTenant(tenantId, db => db.transaction(client =>
   * ...))`) — this function never opens or closes a transaction itself, so the caller controls
   * atomicity (the snapshot-first ordering this ticket must prove depends on that: the snapshot
   * commits in ITS OWN, already-closed transaction before this one even begins). See this file's
   * header for the identity, soft-delete, version and ordering rules.
   *
   * `writer` is the promotion's principal and approval: it becomes content_versions.created_by,
   * content_items.last_published_by and the version attribution {pk, apr}.
   */
  async applyBundle(
    client: PoolClient,
    tenantId: string,
    targetSiteId: string,
    bundle: ContentBundle,
    mode: "merge" | "restore",
    writer: BundleWriter,
  ): Promise<ApplyBundleResult> {
    this.assertWellFormed(bundle);
    const bundleKeys = bundle.collections.map((c) => c.key);

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

    // --- 2. match the bundle to the local LIVE rows by identity, locked ---------------------------
    const locals = await this.lockLiveRows(client, targetSiteId, bundle.contentItems, mode === "restore" ? collectionIdRows.map((r) => r.id) : []);
    const localByIdentity = new Map(locals.map((r) => [identityKey(r.localization_group_id, r.locale), r]));
    const describedIdentities = new Set(bundle.contentItems.map((i) => identityKey(i.localizationGroupId, i.locale)));

    const work: WorkItem[] = [];
    for (const item of bundle.contentItems) {
      const collectionId = collectionIdByKey.get(item.collectionKey);
      if (!collectionId) {
        // Cannot happen given the pre-check in assertWellFormed unless a concurrent writer removed the
        // collection between the upsert and this SELECT — fail loud rather than silently skip.
        throw new BadRequestException(`collection '${item.collectionKey}' could not be resolved on the target after migrate`);
      }
      const local = localByIdentity.get(identityKey(item.localizationGroupId, item.locale)) ?? null;
      if (local && local.collection_id !== collectionId) {
        throw problems.conflict(
          "bundle-group-collection-mismatch",
          "Bundle group collection mismatch",
          `Bundle item ${itemLabel(item)} belongs to localization group ${item.localizationGroupId}, whose ${item.locale} item is live in collection '${local.collection_key}' on this site, not in '${item.collectionKey}'. An item cannot change collection through a bundle. Nothing was changed.`,
          { collectionKey: item.collectionKey, locale: item.locale, slug: item.slug, localizationGroupId: item.localizationGroupId, liveCollectionKey: local.collection_key },
        );
      }
      work.push({ item, collectionId, local, targetKey: slugKey(collectionId, item.locale, item.slug) });
    }

    // --- 3. 'restore' only: SOFT-delete live local items the bundle does not describe ------------
    //        (within the collections it does describe), BEFORE any write below so their slugs and
    //        group slots are free. Never a DELETE: content_versions keeps its FK and its history.
    let itemsDeleted = 0;
    if (mode === "restore") {
      const toDelete = locals.filter((r) => !describedIdentities.has(identityKey(r.localization_group_id, r.locale)));
      if (toDelete.length > 0) {
        const res = await client.query(
          `UPDATE content_items SET deleted_at = now(), updated_at = now()
            WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
          [toDelete.map((r) => r.id)],
        );
        itemsDeleted = res.rowCount ?? 0;
      }
    }

    // --- 4. "import": write the items, in slug-safe rounds -----------------------------------------
    const counts = { itemsWritten: 0, itemsUnchanged: 0, versionsAppended: 0 };
    // Which matched local row currently holds each (collection, locale, slug) a work item targets.
    const holders = new Map<string, string>();
    for (const w of work) {
      if (w.local) holders.set(slugKey(w.local.collection_id, w.local.locale, w.local.slug), w.local.id);
    }
    let pending = work;
    while (pending.length > 0) {
      const ready = pending.filter((w) => {
        const holder = holders.get(w.targetKey);
        return holder === undefined || holder === w.local?.id;
      });
      // Nothing is ready: every pending item waits on another pending item (a cycle, e.g. a swap).
      // Attempt the first anyway; the unique index refuses it and the whole import rolls back.
      const batch = ready.length > 0 ? ready : [pending[0]];
      for (const w of batch) {
        try {
          await this.writeItem(client, tenantId, targetSiteId, w, writer, counts);
        } catch (err) {
          throw mapWriteError(err, w.item);
        }
        if (w.local) {
          const oldKey = slugKey(w.local.collection_id, w.local.locale, w.local.slug);
          if (holders.get(oldKey) === w.local.id) holders.delete(oldKey);
          holders.set(w.targetKey, w.local.id);
        }
      }
      const done = new Set(batch);
      pending = pending.filter((w) => !done.has(w));
    }

    // --- 5. media metadata — HONEST gap, never fabricated (see content-bundle.types.ts) ---------
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

    return { collectionsWritten, ...counts, itemsDeleted, mediaAssetKeysNotTransferred };
  }

  /** Refuses a bundle that cannot be applied unambiguously (400): unknown collection, bad group id, or two items for one identity or one slug. */
  private assertWellFormed(bundle: ContentBundle): void {
    const knownKeys = new Set(bundle.collections.map((c) => c.key));
    const identities = new Set<string>();
    const slugs = new Set<string>();
    for (const item of bundle.contentItems) {
      if (!knownKeys.has(item.collectionKey)) {
        throw new BadRequestException(
          `bundle content item references collection '${item.collectionKey}', which is not listed in bundle.collections — refusing a bundle that cannot resolve its own references`,
        );
      }
      if (typeof item.localizationGroupId !== "string" || !UUID_RE.test(item.localizationGroupId)) {
        throw new BadRequestException(`bundle content item ${itemLabel(item)} has no valid localizationGroupId (a uuid is its identity)`);
      }
      const identity = identityKey(item.localizationGroupId, item.locale);
      if (identities.has(identity)) {
        throw new BadRequestException(`bundle describes localization group ${item.localizationGroupId} in locale ${item.locale} more than once (at ${itemLabel(item)})`);
      }
      identities.add(identity);
      const slug = JSON.stringify([item.collectionKey, item.locale, item.slug]);
      if (slugs.has(slug)) {
        throw new BadRequestException(`bundle has two items at ${itemLabel(item)}`);
      }
      slugs.add(slug);
    }
  }

  /**
   * The live rows this import may touch, locked FOR UPDATE in id order (the write plane's own lock
   * order, so the two can never deadlock): every live row of the site whose (group, locale) the
   * bundle describes, plus — in restore mode — every live row of the described collections.
   */
  private async lockLiveRows(client: PoolClient, siteId: string, items: BundleContentItem[], restoreCollectionIds: string[]): Promise<LocalRow[]> {
    const { rows } = await client.query<LocalRow>(
      `SELECT ci.id, ci.collection_id, c.key AS collection_key, ci.localization_group_id, ci.locale, ci.slug,
              ci.blocks, ci.seo, ci.publish_state, ci.publish_at, ci.unpublish_at, ci.preview_token, ci.head_version
         FROM content_items ci
         JOIN collections c ON c.id = ci.collection_id
        WHERE ci.site_id = $1 AND ci.deleted_at IS NULL
          AND (
            (ci.localization_group_id, ci.locale) IN (SELECT g, l FROM unnest($2::uuid[], $3::text[]) AS t(g, l))
            OR ci.collection_id = ANY($4::uuid[])
          )
        ORDER BY ci.id
        FOR UPDATE OF ci`,
      [siteId, items.map((i) => i.localizationGroupId), items.map((i) => i.locale), restoreCollectionIds],
    );
    return rows;
  }

  /** Writes one bundle item: nothing, a slug-only update, or an update/insert plus ONE appended version. */
  private async writeItem(
    client: PoolClient,
    tenantId: string,
    siteId: string,
    w: WorkItem,
    writer: BundleWriter,
    counts: { itemsWritten: number; itemsUnchanged: number; versionsAppended: number },
  ): Promise<void> {
    const { item, local } = w;
    const blocks = item.blocks ?? [];
    const seo = (item.seo ?? {}) as Record<string, unknown>;
    const published = item.publishState === "published" || item.publishState === "scheduled";
    // A scheduled item's last_published_at is its publish_at (as the write plane's schedule does);
    // a published one's is now().
    const lastPublishedAt = item.publishState === "scheduled" ? (item.publishAt ?? null) : null;
    const attribution = attributionOf({ pk: writer.actorKind, ...(writer.ws4ApprovalId ? { apr: writer.ws4ApprovalId } : {}) });

    if (local) {
      const sameContent = contentHash(local.blocks, local.seo) === contentHash(blocks, seo);
      const samePublish =
        local.publish_state === item.publishState && sameInstant(local.publish_at, item.publishAt) && sameInstant(local.unpublish_at, item.unpublishAt);
      const sameOther = local.slug === item.slug && (local.preview_token ?? null) === (item.previewToken ?? null);
      if (sameContent && samePublish && sameOther) {
        counts.itemsUnchanged++;
        return;
      }
      if (sameContent && samePublish) {
        // Only the slug and/or preview token differ: no version (a version holds blocks + seo).
        await client.query(`UPDATE content_items SET slug = $2, preview_token = $3, updated_at = now() WHERE id = $1 AND deleted_at IS NULL`, [
          local.id,
          item.slug,
          item.previewToken ?? null,
        ]);
        counts.itemsWritten++;
        return;
      }
      const version = Math.max(local.head_version + 1, await nextVersionNumber(client, local.id));
      await client.query(
        `UPDATE content_items SET
            slug = $2, blocks = $3::jsonb, seo = $4::jsonb, publish_state = $5, publish_at = $6, unpublish_at = $7,
            preview_token = $8, search_text = $9, head_version = $10, published_version = $11,
            last_published_at = CASE WHEN $12::boolean THEN COALESCE($13::timestamptz, now()) ELSE last_published_at END,
            last_published_by = CASE WHEN $12::boolean THEN $14::text ELSE last_published_by END,
            updated_at = now()
          WHERE id = $1 AND deleted_at IS NULL`,
        [
          local.id,
          item.slug,
          JSON.stringify(blocks),
          JSON.stringify(seo),
          item.publishState,
          item.publishAt,
          item.unpublishAt,
          item.previewToken ?? null,
          item.searchText ?? extractSearchText(blocks),
          version,
          published ? version : null,
          published,
          lastPublishedAt,
          writer.actor,
        ],
      );
      await insertContentVersion(client, {
        tenantId,
        itemId: local.id,
        version,
        blocks,
        seo,
        publishState: item.publishState,
        createdBy: writer.actor,
        note: writer.note,
        attribution,
      });
      counts.itemsWritten++;
      counts.versionsAppended++;
      return;
    }

    // No live row has this identity: a NEW item (a soft-deleted one is never revived).
    const id = randomUUID();
    await client.query(
      `INSERT INTO content_items
         (id, tenant_id, site_id, collection_id, locale, slug, localization_group_id, blocks, seo,
          publish_state, publish_at, unpublish_at, preview_token, search_text,
          head_version, published_version, last_published_at, last_published_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14, 1, $15,
               CASE WHEN $16::boolean THEN COALESCE($17::timestamptz, now()) END,
               CASE WHEN $16::boolean THEN $18::text END)`,
      [
        id,
        tenantId,
        siteId,
        w.collectionId,
        item.locale,
        item.slug,
        item.localizationGroupId,
        JSON.stringify(blocks),
        JSON.stringify(seo),
        item.publishState,
        item.publishAt,
        item.unpublishAt,
        item.previewToken ?? null,
        item.searchText ?? extractSearchText(blocks),
        published ? 1 : null,
        published,
        lastPublishedAt,
        writer.actor,
      ],
    );
    await insertContentVersion(client, {
      tenantId,
      itemId: id,
      version: 1,
      blocks,
      seo,
      publishState: item.publishState,
      createdBy: writer.actor,
      note: writer.note,
      attribution,
    });
    counts.itemsWritten++;
    counts.versionsAppended++;
  }
}
