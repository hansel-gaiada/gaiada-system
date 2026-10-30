// SCP-5e (W5-B3) — Saved, each client's content bank: the reads and the writes (FRONTEND-BFF-CONTRACT §63.26). Every function takes the
// caller's client: the caller owns the transaction, and runs it inside `withTenants([tenantId], …, { modules: ["social"] })` (the bank is
// third-walled; the Asset Library's `creative_assets` keeps its plain wall and is read in the same transaction).
//
// WHAT IS READ FROM WHERE IT LIVES (never stored here):
//   photos     the asset groups on the live designs of this client's live posts (`social_post_designs`), joined with the bank's own `asset`
//              and `link` items of the category `photos`: one entry per group, whoever kept it ("without repeats").
//   posts      this client's pipeline posts from `approved` on (approved, scheduled, live) that have a stored design.
//   hashtags   the brand book's `hashtag_strategy.sets` (63.4); read-only here.
// "A live design of a live post" is a design not removed (`removed_at IS NULL`) of a post that is not deleted, not archived and in the
// pipeline. USED means such a design names the group; for a link (which has no design), `use_count > 0`; for a text, `use_count > 0`.
//
// THE USE COUNT (63.26.3). `lockSavedItemsForUse` and `countSavedUse` are called by the post edit INSIDE its transaction (pipeline.service.ts
// `applyStageInTx`): the first, before the machine decides, checks the items are this client's live ones and takes their row locks in id order
// (two edits that share items never deadlock); the second, after the machine has applied the edit, adds one to each. A refused edit returns
// before the second runs, so it counts nothing; a replayed edit (same `actionId`) never reaches the transaction.
import type { PoolClient } from "pg";
import { newId } from "../../../db";
import { config } from "../../../config";
import { hashtagSetsOf } from "./brand-book";
import { resolveAssetGroup, userNames, type EngagementRow } from "./pipeline-data";
import { ScpRouteError } from "./pipeline-effects";
import { SAVED_HOLDS, savedCategories, type RulesDoc, type SavedHolds } from "./rules";
import {
  OTHER_COLLECTION, OTHER_LABEL, SAVED_LIMITS, decodeSavedCursor, encodeSavedCursor,
  type SavedCollection, type SavedCreate, type SavedHashtagSet, type SavedItem, type SavedListQuery, type SavedMedia, type SavedPatch,
  type SavedPerson, type SavedPhoto, type SavedPostEntry,
} from "./saved";

const ISO_US = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

interface Page<T> { items: T[]; nextCursor: string | null }

/** The post statuses "from `approved` on" (63.26.3): approved, then scheduled and live. */
const POSTS_FROM_APPROVED = ["approved", "scheduled", "live"];

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Stored items
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

interface ItemRow {
  id: string; category: string; holds: SavedHolds; title: string; body: string | null; url: string | null; media: SavedMedia | null;
  asset_group_id: string | null; pillar: string | null; source: string | null; ai_note: string | null; use_count: number;
  last_used_at: Date | null; created_by: string; created_at: Date; at_iso: string;
  version_id: string | null; version_no: number | null; version_content_type: string | null; used_in: number; used: boolean;
}

/** A design's live use of the asset group `s.asset_group_id` for the item's client (distinct live posts). */
const ASSET_USED_IN = `(SELECT count(DISTINCT d.post_id)::int
     FROM social_post_designs d JOIN social_posts p ON p.tenant_id = d.tenant_id AND p.id = d.post_id
    WHERE d.tenant_id = s.tenant_id AND d.asset_group_id = s.asset_group_id AND d.removed_at IS NULL
      AND p.engagement_id = s.engagement_id AND p.deleted_at IS NULL AND p.archived_at IS NULL AND p.pipeline_status IS NOT NULL)`;

/** The latest live version of a kept asset's group, with the source and AI note the Asset Library holds for it (63.6.6). */
const LATEST_VERSION = `LEFT JOIN LATERAL (
     SELECT ca.id, ca.version_no, ca.content_type, ca.source, ca.ai_note FROM creative_assets ca
      WHERE ca.tenant_id = s.tenant_id AND s.holds = 'asset' AND COALESCE(ca.version_group_id, ca.id) = s.asset_group_id AND ca.deleted_at IS NULL
      ORDER BY ca.version_no DESC LIMIT 1) ver ON true`;

const ITEM_SELECT = `
  SELECT s.id::text AS id, s.category, s.holds, s.title, s.body, s.url, s.media, s.asset_group_id::text AS asset_group_id, s.pillar,
         CASE WHEN s.holds = 'asset' THEN ver.source ELSE s.source END AS source,
         CASE WHEN s.holds = 'asset' THEN ver.ai_note ELSE s.ai_note END AS ai_note,
         s.use_count, s.last_used_at, s.created_by::text AS created_by, s.created_at,
         to_char(s.created_at AT TIME ZONE 'UTC', ${ISO_US}) AS at_iso,
         ver.id::text AS version_id, ver.version_no, ver.content_type AS version_content_type,
         CASE WHEN s.holds = 'asset' THEN ${ASSET_USED_IN} ELSE 0 END AS used_in,
         CASE WHEN s.holds = 'asset' THEN ${ASSET_USED_IN} > 0 ELSE s.use_count > 0 END AS used
    FROM social_saved_items s ${LATEST_VERSION}`;

function itemOf(r: ItemRow, names: Map<string, string>): SavedItem {
  return {
    id: r.id, category: r.category, holds: r.holds, title: r.title, body: r.body, url: r.url, media: r.media,
    asset: r.holds === "asset" && r.asset_group_id && r.version_id
      ? { groupId: r.asset_group_id, versionId: r.version_id, versionNo: Number(r.version_no), contentType: String(r.version_content_type) }
      : null,
    source: r.source, aiNote: r.ai_note, pillar: r.pillar, useCount: r.use_count,
    lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null, used: r.used,
    addedBy: personOf(r.created_by, names), addedAt: new Date(r.created_at).toISOString(),
  };
}

function personOf(id: string | null, names: Map<string, string>): SavedPerson | null {
  return id ? { id, name: names.get(id) ?? "Someone" } : null;
}

/** One stored item by id (live or not), or null. */
export async function readSavedItem(c: PoolClient, tenantId: string, itemId: string): Promise<SavedItem | null> {
  const { rows } = await c.query<ItemRow>(`${ITEM_SELECT} WHERE s.tenant_id = $1 AND s.id = $2 AND s.deleted_at IS NULL`, [tenantId, itemId]);
  if (!rows[0]) return null;
  return itemOf(rows[0], await userNames(c, [rows[0].created_by]));
}

/**
 * The stored items of `collection` (a category key, or `other` for the items whose category the company no longer has), newest first, with
 * the list's filters. `ruleKeys` are every category key the rules have (hidden ones included): `other` is what none of them names.
 */
async function readStored(c: PoolClient, tenantId: string, engagementId: string, collection: string, ruleKeys: string[], q: SavedListQuery): Promise<Page<SavedItem>> {
  const after = q.cursor ? decodeSavedCursor(q.cursor) : null;
  const other = collection === OTHER_COLLECTION;
  const { rows } = await c.query<ItemRow>(
    `SELECT * FROM (${ITEM_SELECT}
      WHERE s.tenant_id = $1 AND s.engagement_id = $2 AND s.deleted_at IS NULL
        AND (CASE WHEN $3::boolean THEN NOT (s.category = ANY($4::text[])) ELSE s.category = $5::text END)) t
      WHERE ($6::text IS NULL OR t.pillar = $6::text) AND ($7::boolean IS NULL OR t.used = $7::boolean) AND ($8::text IS NULL OR t.source = $8::text)
        AND ($9::timestamptz IS NULL OR (t.created_at, t.id) < ($9::timestamptz, $10::text))
      ORDER BY t.created_at DESC, t.id DESC LIMIT $11`,
    [tenantId, engagementId, other, ruleKeys, collection, q.pillar, q.used, q.source, after?.at ?? null, after?.key ?? null, q.limit + 1],
  );
  const more = rows.length > q.limit;
  const page = rows.slice(0, q.limit);
  const names = await userNames(c, page.map((r) => r.created_by));
  const last = page[page.length - 1];
  return { items: page.map((r) => itemOf(r, names)), nextCursor: more && last ? encodeSavedCursor({ at: last.at_iso, key: last.id }) : null };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Photos: design photos, kept assets, kept links
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

interface PhotoRow {
  key: string; saved_id: string | null; holds: "asset" | "link"; title: string; media: SavedMedia | null; gid: string | null;
  version_id: string | null; version_no: number | null; content_type: string | null; url: string | null; source: string | null;
  ai_note: string | null; pillar: string | null; used_in: number; used: boolean; added_by: string | null; added_at: Date; at_iso: string;
}

/** `$1` tenant, `$2` engagement, `$3` the category the kept items sit in (`photos`). The union is one entry per group: a group a design uses
 *  and the bank also keeps is one entry with `saved_id` set. */
const PHOTOS_CTE = `
  WITH live AS (
    SELECT d.asset_group_id AS gid, d.post_id, d.added_at, d.added_by, p.pillar
      FROM social_post_designs d JOIN social_posts p ON p.tenant_id = d.tenant_id AND p.id = d.post_id
     WHERE d.tenant_id = $1 AND p.engagement_id = $2 AND d.removed_at IS NULL AND d.asset_group_id IS NOT NULL
       AND p.deleted_at IS NULL AND p.archived_at IS NULL AND p.pipeline_status IS NOT NULL
  ), usage AS (
    SELECT gid, count(DISTINCT post_id)::int AS used_in, min(added_at) AS first_at,
           (array_agg(added_by ORDER BY added_at, post_id))[1] AS first_by,
           (array_agg(pillar ORDER BY added_at DESC, post_id) FILTER (WHERE pillar IS NOT NULL))[1] AS last_pillar
      FROM live GROUP BY gid
  ), kept AS (
    SELECT s.* FROM social_saved_items s
     WHERE s.tenant_id = $1 AND s.engagement_id = $2 AND s.category = $3::text AND s.deleted_at IS NULL
  ), groups AS (
    SELECT gid FROM usage UNION SELECT asset_group_id FROM kept WHERE holds = 'asset'
  ), assets AS (
    SELECT g.gid, ver.id AS version_id, ver.version_no, ver.content_type, ver.name, ver.source, ver.ai_note
      FROM groups g LEFT JOIN LATERAL (
        SELECT ca.id, ca.version_no, ca.content_type, ca.name, ca.source, ca.ai_note FROM creative_assets ca
         WHERE ca.tenant_id = $1 AND COALESCE(ca.version_group_id, ca.id) = g.gid AND ca.deleted_at IS NULL
         ORDER BY ca.version_no DESC LIMIT 1) ver ON true
  ), photos AS (
    SELECT 'asset:' || a.gid::text AS key, k.id::text AS saved_id, 'asset'::text AS holds, COALESCE(k.title, a.name) AS title,
           'photo'::text AS media, a.gid::text AS gid, a.version_id::text AS version_id, a.version_no, a.content_type, NULL::text AS url,
           a.source, a.ai_note, COALESCE(k.pillar, u.last_pillar) AS pillar, COALESCE(u.used_in, 0) AS used_in, COALESCE(u.used_in, 0) > 0 AS used,
           COALESCE(k.created_by, u.first_by)::text AS added_by, COALESCE(k.created_at, u.first_at) AS added_at
      FROM assets a LEFT JOIN usage u ON u.gid = a.gid LEFT JOIN kept k ON k.holds = 'asset' AND k.asset_group_id = a.gid
     WHERE a.version_id IS NOT NULL OR k.id IS NOT NULL
    UNION ALL
    SELECT 'link:' || k.id::text, k.id::text, 'link', k.title, k.media, NULL, NULL, NULL, NULL, k.url, k.source, k.ai_note, k.pillar,
           k.use_count, k.use_count > 0, k.created_by::text, k.created_at
      FROM kept k WHERE k.holds = 'link'
  )`;

function photoOf(r: PhotoRow, names: Map<string, string>): SavedPhoto {
  return {
    key: r.key, savedItemId: r.saved_id, holds: r.holds, title: r.title, media: r.media,
    asset: r.holds === "asset" && r.gid && r.version_id ? { groupId: r.gid, versionId: r.version_id, versionNo: Number(r.version_no), contentType: String(r.content_type) } : null,
    url: r.url, source: r.source, aiNote: r.ai_note, pillar: r.pillar, used: r.used, usedIn: r.used_in,
    addedBy: personOf(r.added_by, names), addedAt: new Date(r.added_at).toISOString(),
  };
}

async function readPhotos(c: PoolClient, tenantId: string, engagementId: string, category: string, q: SavedListQuery): Promise<Page<SavedPhoto>> {
  const after = q.cursor ? decodeSavedCursor(q.cursor) : null;
  const { rows } = await c.query<PhotoRow>(
    `${PHOTOS_CTE}
     SELECT t.*, to_char(t.added_at AT TIME ZONE 'UTC', ${ISO_US}) AS at_iso FROM photos t
      WHERE ($4::text IS NULL OR t.pillar = $4::text) AND ($5::boolean IS NULL OR t.used = $5::boolean) AND ($6::text IS NULL OR t.source = $6::text)
        AND ($7::timestamptz IS NULL OR (t.added_at, t.key) < ($7::timestamptz, $8::text))
      ORDER BY t.added_at DESC, t.key DESC LIMIT $9`,
    [tenantId, engagementId, category, q.pillar, q.used, q.source, after?.at ?? null, after?.key ?? null, q.limit + 1],
  );
  const more = rows.length > q.limit;
  const page = rows.slice(0, q.limit);
  const names = await userNames(c, page.map((r) => r.added_by));
  const last = page[page.length - 1];
  return { items: page.map((r) => photoOf(r, names)), nextCursor: more && last ? encodeSavedCursor({ at: last.at_iso, key: last.key }) : null };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Approved posts
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

interface PostRowOut {
  id: string; title: string; format: string | null; cycle_month: string | null; thumb_file_id: string | null; pipeline_status: string;
  simulated: boolean; at_iso: string; total: number;
}

async function readPosts(c: PoolClient, tenantId: string, engagementId: string, q: Pick<SavedListQuery, "pillar" | "cursor" | "limit">): Promise<Page<SavedPostEntry> & { total: number }> {
  const after = q.cursor ? decodeSavedCursor(q.cursor) : null;
  const { rows } = await c.query<PostRowOut>(
    `SELECT t.* FROM (
       SELECT p.id::text AS id, p.title, p.format, to_char(cy.month, 'YYYY-MM') AS cycle_month, p.pipeline_status, p.simulated,
              COALESCE(p.scheduled_at, p.created_at) AS sort_at, to_char(COALESCE(p.scheduled_at, p.created_at) AT TIME ZONE 'UTC', ${ISO_US}) AS at_iso,
              (SELECT COALESCE(d.thumb_file_id, d.file_id)::text FROM social_post_designs d
                WHERE d.tenant_id = p.tenant_id AND d.post_id = p.id AND d.removed_at IS NULL AND d.file_id IS NOT NULL
                ORDER BY d.position, d.added_at LIMIT 1) AS thumb_file_id,
              p.pillar, count(*) OVER ()::int AS total
         FROM social_posts p LEFT JOIN social_cycles cy ON cy.tenant_id = p.tenant_id AND cy.id = p.cycle_id
        WHERE p.tenant_id = $1 AND p.engagement_id = $2 AND p.pipeline_status = ANY($3::text[]) AND p.deleted_at IS NULL AND p.archived_at IS NULL
          AND EXISTS (SELECT 1 FROM social_post_designs d WHERE d.tenant_id = p.tenant_id AND d.post_id = p.id AND d.removed_at IS NULL AND d.file_id IS NOT NULL)
     ) t
      WHERE ($4::text IS NULL OR t.pillar = $4::text) AND ($5::timestamptz IS NULL OR (t.sort_at, t.id) < ($5::timestamptz, $6::text))
      ORDER BY t.sort_at DESC, t.id DESC LIMIT $7`,
    [tenantId, engagementId, POSTS_FROM_APPROVED, q.pillar, after?.at ?? null, after?.key ?? null, q.limit + 1],
  );
  const more = rows.length > q.limit;
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      postId: r.id, title: r.title, format: r.format, cycleMonth: r.cycle_month, thumbFileId: r.thumb_file_id,
      pipelineStatus: r.pipeline_status, simulated: r.simulated === true,
    })),
    nextCursor: more && last ? encodeSavedCursor({ at: last.at_iso, key: last.id }) : null,
    total: rows[0]?.total ?? 0,
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The collections and the items of one
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

const hashtagItems = (eng: EngagementRow): SavedHashtagSet[] =>
  hashtagSetsOf(eng.hashtag_strategy).map((s, i) => ({ key: `set-${i + 1}`, name: s.name, tags: s.tags.filter((t): t is string => typeof t === "string") }));

interface CollectionRow { category: string; holds: SavedHolds; title: string; version_id: string | null; n: number; rn_all: number; rn_img: number | null; at: Date }

/** `GET engagements/:engagementId/saved` without `collection`: the company's enabled categories in their order, with counts and previews. */
export async function readCollections(c: PoolClient, tenantId: string, eng: EngagementRow, rules: RulesDoc): Promise<SavedCollection[]> {
  const cats = savedCategories(rules, { enabledOnly: true });
  const lim = SAVED_LIMITS.previews;
  const { rows } = await c.query<CollectionRow>(
    `SELECT category, holds, title, version_id, n::int AS n, rn_all::int AS rn_all, rn_img::int AS rn_img, created_at AS at FROM (
       SELECT s.category, s.holds, s.title, ver.id::text AS version_id, s.created_at,
              count(*) OVER (PARTITION BY s.category) AS n,
              row_number() OVER (PARTITION BY s.category ORDER BY s.created_at DESC, s.id DESC) AS rn_all,
              CASE WHEN ver.id IS NOT NULL THEN row_number() OVER (PARTITION BY s.category, (ver.id IS NOT NULL) ORDER BY s.created_at DESC, s.id DESC) END AS rn_img
         FROM social_saved_items s ${LATEST_VERSION}
        WHERE s.tenant_id = $1 AND s.engagement_id = $2 AND s.deleted_at IS NULL) t
      WHERE rn_all <= $3 OR rn_img <= $3`,
    [tenantId, eng.id, lim],
  );
  const stored = (key: string) => rows.filter((r) => r.category === key);
  const out: SavedCollection[] = [];
  for (const cat of cats) {
    const base = { key: cat.key, label: cat.label, holds: cat.holds, derived: cat.derived };
    if (cat.key === "photos") {
      const n = await c.query<{ n: number }>(`${PHOTOS_CTE} SELECT count(*)::int AS n FROM photos`, [tenantId, eng.id, cat.key]);
      const p = await c.query<{ v: string }>(`${PHOTOS_CTE} SELECT version_id AS v FROM photos WHERE version_id IS NOT NULL ORDER BY added_at DESC, key DESC LIMIT ${lim}`, [tenantId, eng.id, cat.key]);
      out.push({ ...base, count: n.rows[0]?.n ?? 0, previews: p.rows.map((r) => r.v) });
    } else if (cat.key === "posts") {
      const p = await readPosts(c, tenantId, eng.id, { pillar: null, cursor: null, limit: lim });
      out.push({ ...base, count: p.total, previews: p.items.map((x) => x.thumbFileId).filter((x): x is string => x !== null) });
    } else if (cat.key === "hashtags") {
      const sets = hashtagItems(eng);
      out.push({ ...base, count: sets.length, previews: sets.slice(0, lim).map((s) => s.name) });
    } else {
      const mine = stored(cat.key);
      const images = cat.holds.includes("asset");
      out.push({
        ...base, count: mine[0]?.n ?? 0,
        previews: images
          ? mine.filter((r) => r.rn_img !== null && r.rn_img <= lim && r.version_id).sort((a, b) => Number(a.rn_img) - Number(b.rn_img)).map((r) => r.version_id as string)
          : mine.filter((r) => r.rn_all <= lim).sort((a, b) => a.rn_all - b.rn_all).map((r) => r.title),
      });
    }
  }
  // "Other": the items whose category the rules no longer have (a hidden category keeps its items hidden, they are not "Other").
  const known = new Set(rules.saved.categories.map((x) => x.key));
  const orphans = rows.filter((r) => !known.has(r.category));
  if (orphans.length > 0) {
    const perCategory = new Map<string, number>();
    for (const r of orphans) perCategory.set(r.category, r.n);
    out.push({
      key: OTHER_COLLECTION, label: OTHER_LABEL, holds: [...SAVED_HOLDS], derived: false,
      count: [...perCategory.values()].reduce((a, b) => a + b, 0),
      previews: orphans.filter((r) => r.rn_all <= lim).sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, lim).map((r) => r.title),
    });
  }
  return out;
}

export type SavedPage =
  | { collection: string; items: SavedPhoto[]; nextCursor: string | null }
  | { collection: string; items: SavedPostEntry[]; nextCursor: string | null }
  | { collection: string; items: SavedHashtagSet[]; nextCursor: null }
  | { collection: string; items: SavedItem[]; nextCursor: string | null };

/** `GET engagements/:engagementId/saved?collection=…`: `{items, nextCursor}` (the caller adds nothing else). `hashtags` is unpaged. */
export async function readCollectionItems(c: PoolClient, tenantId: string, eng: EngagementRow, rules: RulesDoc, q: SavedListQuery): Promise<SavedPage> {
  const collection = q.collection as string;
  if (collection === "photos") return { collection, ...(await readPhotos(c, tenantId, eng.id, collection, q)) };
  if (collection === "posts") {
    const p = await readPosts(c, tenantId, eng.id, q);
    return { collection, items: p.items, nextCursor: p.nextCursor };
  }
  if (collection === "hashtags") return { collection, items: hashtagItems(eng), nextCursor: null };
  const ruleKeys = rules.saved.categories.map((x) => x.key);
  return { collection, ...(await readStored(c, tenantId, eng.id, collection, ruleKeys, q)) };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Writes
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

export interface SavedRow { id: string; engagementId: string; created_by: string; holds: SavedHolds; source: string | null; aiNote: string | null; deleted: boolean }

/** A stored item row for the gate and the change (deleted or not), locked when `lock`. Null when absent or another company's. */
export async function loadSavedRow(c: PoolClient, tenantId: string, itemId: string, lock = false): Promise<SavedRow | null> {
  const { rows } = await c.query<{ id: string; engagement_id: string; created_by: string; holds: SavedHolds; source: string | null; ai_note: string | null; deleted_at: Date | null }>(
    `SELECT id::text AS id, engagement_id::text AS engagement_id, created_by::text AS created_by, holds, source, ai_note, deleted_at
       FROM social_saved_items WHERE tenant_id = $1 AND id = $2 ${lock ? "FOR UPDATE" : ""}`,
    [tenantId, itemId],
  );
  const r = rows[0];
  return r ? { id: r.id, engagementId: r.engagement_id, created_by: r.created_by, holds: r.holds, source: r.source, aiNote: r.ai_note, deleted: r.deleted_at !== null } : null;
}

/** The id of a stored row under `id` in this company, with its engagement and whether it is deleted: the replay of a create. */
export async function findSavedById(c: PoolClient, tenantId: string, id: string): Promise<{ id: string; engagementId: string; deleted: boolean } | null> {
  const { rows } = await c.query<{ id: string; engagement_id: string; deleted_at: Date | null }>(
    `SELECT id::text AS id, engagement_id::text AS engagement_id, deleted_at FROM social_saved_items WHERE tenant_id = $1 AND id = $2`, [tenantId, id],
  );
  return rows[0] ? { id: rows[0].id, engagementId: rows[0].engagement_id, deleted: rows[0].deleted_at !== null } : null;
}

/**
 * The create (63.26.3), in the caller's transaction. An `asset` names a group of THIS company (404 `asset_not_found` otherwise; any version's id
 * resolves to its group) and one kept per client answers the existing item. The insert is `ON CONFLICT DO NOTHING`: a replayed `id`, or a second
 * add of the same group that raced this one, finds the winner instead of failing; an `id` that is somebody else's is 400 `{field: 'id'}`.
 */
export async function addSavedItemInTx(
  c: PoolClient, a: { tenantId: string; engagementId: string; actorId: string; input: SavedCreate },
): Promise<{ id: string; created: boolean }> {
  const { tenantId, engagementId, actorId, input } = a;
  let group: string | null = null;
  if (input.holds === "asset") {
    group = await resolveAssetGroup(c, tenantId, input.assetGroupId as string);
    if (!group) throw new ScpRouteError(404, "asset_not_found");
    const kept = await c.query<{ id: string }>(
      `SELECT id::text AS id FROM social_saved_items WHERE tenant_id = $1 AND engagement_id = $2 AND holds = 'asset' AND asset_group_id = $3 AND deleted_at IS NULL`,
      [tenantId, engagementId, group],
    );
    if (kept.rows[0]) return { id: kept.rows[0].id, created: false };
  }
  const id = input.id ?? newId();
  const ins = await c.query<{ id: string }>(
    `INSERT INTO social_saved_items (id, tenant_id, engagement_id, holds, category, title, body, url, media, asset_group_id, pillar, source, ai_note, created_by, origin_site)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) ON CONFLICT DO NOTHING RETURNING id::text AS id`,
    [id, tenantId, engagementId, input.holds, input.category, input.title, input.body, input.url, input.media, group, input.pillar, input.source, input.aiNote, actorId, config.originSite],
  );
  if (ins.rows[0]) return { id: ins.rows[0].id, created: true };
  const mine = await findSavedById(c, tenantId, id);
  if (mine && mine.engagementId === engagementId && !mine.deleted) return { id: mine.id, created: false };
  if (group) {
    const kept = await c.query<{ id: string }>(
      `SELECT id::text AS id FROM social_saved_items WHERE tenant_id = $1 AND engagement_id = $2 AND holds = 'asset' AND asset_group_id = $3 AND deleted_at IS NULL`,
      [tenantId, engagementId, group],
    );
    if (kept.rows[0]) return { id: kept.rows[0].id, created: false };
  }
  throw new ScpRouteError(400, "invalid_field", { field: "id" });
}

/** The change (63.26.3), on the locked row. The caller has judged the patch against the row's shape. */
export async function patchSavedItemInTx(c: PoolClient, a: { tenantId: string; itemId: string; actorId: string; patch: SavedPatch }): Promise<void> {
  const { patch } = a;
  const sets: string[] = [];
  const vals: unknown[] = [a.tenantId, a.itemId, a.actorId];
  const put = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if (patch.title !== undefined) put("title", patch.title);
  if (patch.body !== undefined) put("body", patch.body);
  if (patch.pillar !== undefined) put("pillar", patch.pillar);
  if (patch.source !== undefined) put("source", patch.source);
  if (patch.aiNote !== undefined) put("ai_note", patch.aiNote);
  if (patch.category !== undefined) put("category", patch.category);
  await c.query(
    `UPDATE social_saved_items SET ${sets.join(", ")}, updated_by = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`, vals,
  );
}

export async function deleteSavedItemInTx(c: PoolClient, a: { tenantId: string; itemId: string; actorId: string }): Promise<void> {
  await c.query(
    `UPDATE social_saved_items SET deleted_at = now(), deleted_by = $3, updated_by = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [a.tenantId, a.itemId, a.actorId],
  );
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// The use count, riding the post edit's transaction
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Before the machine decides: are all of `ids` live items of THIS client? When so their rows are locked (`FOR UPDATE`, in id order, so two edits
 * that share items serialize instead of deadlocking) and the answer is true. False means at least one is unknown, deleted or another client's:
 * the edit is refused 400 `{field: 'savedItemIds'}` and nothing is counted.
 */
export async function lockSavedItemsForUse(c: PoolClient, a: { tenantId: string; engagementId: string; ids: string[] }): Promise<boolean> {
  const { rows } = await c.query<{ id: string }>(
    `SELECT id::text AS id FROM social_saved_items WHERE tenant_id = $1 AND engagement_id = $2 AND id = ANY($3::uuid[]) AND deleted_at IS NULL ORDER BY id FOR UPDATE`,
    [a.tenantId, a.engagementId, a.ids],
  );
  return rows.length === a.ids.length;
}

/** After the machine applied the edit, in the same transaction: one more use for each item, stamped with the post. `clock_timestamp()` is read
 *  under the lock, so `last_used_at` follows the order the edits took the items in. */
export async function countSavedUse(c: PoolClient, a: { tenantId: string; postId: string; ids: string[] }): Promise<void> {
  await c.query(
    `UPDATE social_saved_items SET use_count = use_count + 1, last_used_at = clock_timestamp(), last_used_post_id = $3
      WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL`,
    [a.tenantId, a.ids, a.postId],
  );
}
