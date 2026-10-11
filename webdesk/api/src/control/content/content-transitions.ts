// WSK-61 — the projection transitions the authoring commands and the scheduler SHARE.
//
// content_items is the LIVE PROJECTION the frozen /v1 read path serves (content-commands.service.ts
// header). Three things change it in a way production can see: publishing a version, taking an item
// down, and (WSK-61) the scheduler doing either of those later, plus swapping a new version into a
// live item at a scheduled time. The scheduler must produce EXACTLY the row state the command would
// have, so the SQL lives here once and both callers run it; neither carries a private copy.
//
//   applyPublishEffect    content.publish(v), and the scheduler's version swap
//   applyUnpublishEffect  content.unpublish, and the scheduler's due takedown
//   adoptLegacyItem       the pre-0009 first-write adoption both of them may need
//   cancelPendingSwap     publish / unpublish / delete / schedule / a due takedown cancel the item's
//                         pending content_schedules row, in the SAME transaction as their own effect
//   announceContentEvent  the post-commit, fail-soft webhook fan-out + cache-tag log line
//
// Every function takes the caller's transaction client (under the tenant's webdesk.tenant_ctx) and
// expects the item row to be LOCKED (FOR UPDATE) by the caller. None of them opens a transaction.
import type { Logger } from "@nestjs/common";
import type { PoolClient } from "pg";
import { buildCacheTags } from "../../delivery/vocabulary/cache-tags";
import type { TenantWebhookDispatcherService } from "../../tenant-webhooks/tenant-webhook-dispatcher.service";
import type {
  TenantWebhookContentEventKind,
  TenantWebhookContentItemRef,
} from "../../tenant-webhooks/tenant-webhook-event.types";
import { extractSearchText } from "./search-text";
import { insertContentVersion, nextVersionNumber } from "./content-versions";

/** The content_items columns every command and the scheduler read back (aliased `ci`). */
export const ITEM_COLUMNS = `ci.id, ci.collection_id, ci.locale, ci.slug, ci.localization_group_id, ci.head_version,
  ci.published_version, ci.publish_state, ci.publish_at, ci.unpublish_at, ci.deleted_at, ci.updated_at`;

export interface ItemColumnsRow {
  id: string;
  collection_id: string;
  locale: string;
  slug: string;
  localization_group_id: string;
  head_version: number;
  published_version: number | null;
  publish_state: string;
  publish_at: Date | null;
  unpublish_at: Date | null;
  deleted_at: Date | null;
  updated_at: Date;
}

export interface VersionRow {
  version: number;
  blocks: unknown;
  seo: Record<string, unknown>;
  content_hash: string | null;
  created_at: Date;
}

/**
 * The read path's visibility rule (delivery/content-read.ts EFFECTIVE_PUBLISHED_SQL, restated: that
 * file's SQL is frozen by WSK-48a's byte gate and does not export it). "Live" means exactly "a
 * production key sees this row" at the instant `nowExpr` names. The commands pass `now()`; the
 * scheduler passes the tick's injected clock (`$1::timestamptz`) so a test can drive time.
 */
export function effectivePublishedSql(nowExpr: string): string {
  return `(
  (ci.publish_state = 'published' AND (ci.unpublish_at IS NULL OR ci.unpublish_at > ${nowExpr}))
  OR (ci.publish_state = 'scheduled' AND ci.publish_at IS NOT NULL AND ci.publish_at <= ${nowExpr}
      AND (ci.unpublish_at IS NULL OR ci.unpublish_at > ${nowExpr}))
)`;
}

export async function loadVersionRow(client: PoolClient, itemId: string, version: number): Promise<VersionRow | null> {
  const { rows } = await client.query<VersionRow>(
    `SELECT version, blocks, seo, content_hash, created_at FROM content_versions
      WHERE content_item_id = $1 AND version = $2`,
    [itemId, version],
  );
  return rows[0] ?? null;
}

// ------------------------------------------------------------------------------------------------
// Adoption of a pre-0009 row
// ------------------------------------------------------------------------------------------------

/** Who a system-written version row is attributed to (the command's principal, or the scheduler). */
export interface VersionActor {
  tenantId: string;
  createdBy: string;
  attribution: Record<string, string>;
}

export interface AdoptableItem {
  id: string;
  head_version: number;
  published_version: number | null;
  publish_state: string;
  blocks: unknown;
  seo: Record<string, unknown> | null;
}

/**
 * First write to a pre-0009 row: writes its current projection as a version and points head_version
 * (and published_version, when the row is published/scheduled) at it. Returns the row with the new
 * pointers. A no-op for any row already on the write plane.
 */
export async function adoptLegacyItem<T extends AdoptableItem>(client: PoolClient, actor: VersionActor, item: T): Promise<T> {
  if (item.head_version > 0) return item;
  const seo = item.seo ?? {};
  const v = await nextVersionNumber(client, item.id);
  await insertContentVersion(client, {
    tenantId: actor.tenantId,
    itemId: item.id,
    version: v,
    blocks: item.blocks ?? [],
    seo,
    publishState: item.publish_state,
    createdBy: actor.createdBy,
    note: "adopted: the projection as it stood before the write plane",
    attribution: actor.attribution,
  });
  const isPublishedState = item.publish_state === "published" || item.publish_state === "scheduled";
  await client.query(`UPDATE content_items SET head_version = $2, published_version = $3 WHERE id = $1`, [
    item.id,
    v,
    isPublishedState ? v : null,
  ]);
  return { ...item, head_version: v, published_version: isPublishedState ? v : null };
}

// ------------------------------------------------------------------------------------------------
// Publish
// ------------------------------------------------------------------------------------------------

export interface PublishEffect {
  itemId: string;
  /** The version's content: becomes the projection. */
  source: { blocks: unknown; seo: Record<string, unknown> };
  version: number;
  publishedBy: string;
  /**
   * When the publish took effect. null = now (a command run now). The scheduler passes the swap's
   * publish_at, so last_published_at records when the version went live, not when the worker ran;
   * updated_at then moves to that instant unless it is already later (sitemap lastmod stays honest
   * and never goes backwards).
   */
  publishedAt: Date | null;
  /**
   * What happens to the item's unpublish_at. `keep`: an unpublish_at still in the future survives, a
   * past one is cleared (content.publish). `set`: the swap's own takedown time, which may be null.
   */
  unpublishAt: { mode: "keep" } | { mode: "set"; at: Date | null };
}

/**
 * Puts a version in front of production: the projection takes the version's content, the item
 * becomes `published` at that version. THE one place that statement lives (publish and the swap).
 * Returns the stored last_published_at.
 */
export async function applyPublishEffect(client: PoolClient, e: PublishEffect): Promise<Date> {
  const { rows } = await client.query<{ last_published_at: Date }>(
    `UPDATE content_items SET
        blocks = $2::jsonb, seo = $3::jsonb, search_text = $4,
        published_version = $5, publish_state = 'published', publish_at = NULL,
        unpublish_at = CASE WHEN $6::boolean THEN $7::timestamptz
                            WHEN unpublish_at > now() THEN unpublish_at
                            ELSE NULL END,
        last_published_at = COALESCE($8::timestamptz, now()), last_published_by = $9,
        updated_at = CASE WHEN $8::timestamptz IS NULL THEN now() ELSE greatest(updated_at, $8::timestamptz) END
      WHERE id = $1
      RETURNING last_published_at`,
    [
      e.itemId,
      JSON.stringify(e.source.blocks),
      JSON.stringify(e.source.seo),
      extractSearchText(e.source.blocks),
      e.version,
      e.unpublishAt.mode === "set",
      e.unpublishAt.mode === "set" ? e.unpublishAt.at : null,
      e.publishedAt,
      e.publishedBy,
    ],
  );
  return rows[0].last_published_at;
}

// ------------------------------------------------------------------------------------------------
// Unpublish
// ------------------------------------------------------------------------------------------------

/**
 * Back to the draft model: the projection serves the HEAD version again (staging sees it,
 * production does not), published_version and both schedule columns are cleared. The item must be
 * adopted already (head_version >= 1). Returns the updated row's ITEM_COLUMNS.
 */
export async function applyUnpublishEffect(client: PoolClient, item: { id: string; head_version: number }): Promise<ItemColumnsRow> {
  const head = await loadVersionRow(client, item.id, item.head_version);
  if (!head) throw new Error(`content item ${item.id} has head_version ${item.head_version} but no such version row`);
  const { rows } = await client.query<ItemColumnsRow>(
    `UPDATE content_items ci SET
        publish_state = 'unpublished', published_version = NULL, publish_at = NULL, unpublish_at = NULL,
        blocks = $2::jsonb, seo = $3::jsonb, search_text = $4, updated_at = now()
      WHERE ci.id = $1
      RETURNING ${ITEM_COLUMNS}`,
    [item.id, JSON.stringify(head.blocks), JSON.stringify(head.seo), extractSearchText(head.blocks)],
  );
  return rows[0];
}

// ------------------------------------------------------------------------------------------------
// Pending version swaps (content_schedules, migration 0012)
// ------------------------------------------------------------------------------------------------

/** The cancel reasons the commands write; the scheduler adds `item-deleted` and `item-not-live`. */
export type SwapCancelReason =
  | "superseded"
  | "superseded-by-publish"
  | "unpublished"
  | "deleted"
  | "item-deleted"
  | "item-not-live";

/**
 * Cancels the item's pending swap, if it has one (at most one can: ux_content_schedules_one_pending).
 * Must run under the item's row lock, inside the caller's transaction: every writer of a swap row
 * takes that lock first, so this can never race another writer. Returns how many rows it cancelled.
 */
export async function cancelPendingSwap(client: PoolClient, itemId: string, reason: SwapCancelReason): Promise<number> {
  const { rowCount } = await client.query(
    `UPDATE content_schedules SET cancelled_at = now(), cancel_reason = $2
      WHERE content_item_id = $1 AND executed_at IS NULL AND cancelled_at IS NULL AND failed_at IS NULL`,
    [itemId, reason],
  );
  return rowCount ?? 0;
}

// ------------------------------------------------------------------------------------------------
// After commit
// ------------------------------------------------------------------------------------------------

export interface AnnounceContext {
  tenantId: string;
  tenantSlug: string;
  siteId: string;
  /** The command (or scheduler job) that changed the projection; names the cache-invalidation line. */
  command: string;
}

/**
 * The post-commit side effects every projection-changing transition shares: the
 * `content.cache_invalidate` log line with the Cache-Tag set (no CDN fronts /v1 yet; WSK-70 wires the
 * purge, deferred by WSK-D50) and the tenant webhook (item refs only, never values). Returns a thunk the caller runs AFTER
 * its transaction committed; the dispatcher is fail-soft by contract, and callers catch the rest.
 */
export function announceContentEvent(
  deps: { logger: Logger; webhooks: TenantWebhookDispatcherService },
  ctx: AnnounceContext,
  kind: TenantWebhookContentEventKind,
  refs: TenantWebhookContentItemRef[],
  extra?: { publishAt?: string | null; unpublishAt?: string | null },
): () => Promise<void> {
  return async () => {
    const tags = new Set<string>();
    for (const r of refs) {
      for (const t of buildCacheTags({ tenantSlug: ctx.tenantSlug, collectionKey: r.collectionKey, itemId: r.itemId })) tags.add(t);
    }
    deps.logger.log(JSON.stringify({ event: "content.cache_invalidate", command: ctx.command, tenant: ctx.tenantSlug, tags: [...tags] }));
    await deps.webhooks.dispatchContentEvent(ctx.tenantId, kind, { siteId: ctx.siteId, items: refs, ...(extra ?? {}) });
  };
}
