// WSK-51 — the control plane's live read commands for the content editor (write-plane design §4).
//
//   collection.list · collection.get · item.list · item.get · item.versions · item.versionGet · media.list · media.usage
//   (media.list and media.usage are the WSK-43a media LIBRARY reads: see listMedia / mediaUsage below)
//
// (tenant.list is the platform-level read and lives in ../tenants/tenant-reads.service.ts.)
//
// WHAT THESE ARE. Editor projections, not /v1 envelopes: the editor needs the state the envelope
// hides (the HEAD version, drafts, scheduled and unpublished items, version history, lint). Every
// one is a live SELECT, so "stale" is impossible by construction. Every one is read / webdesk:read,
// needs no editorial assertion (nothing here is a write, and `sub` is not needed to read) and is
// NOT audited: the precedent is WSK-21's job polls, and a poll-heavy editor would otherwise flood
// audit_entries with rows that carry no information.
//
// TENANCY. The route's tenant slug and site id are resolved first, by the same function the write
// plane uses (ContentCommandsService.resolveTenantSite): any miss (unknown or archived tenant, a
// site of another tenant, a malformed id) is the SAME 404 site-not-found, so there is no existence
// oracle across tenants. Every query then runs under that tenant's `webdesk.tenant_ctx` (RLS is the
// wall) AND filters on the route's site id (the query is the second wall). A tenant B item id fetched
// through tenant A's slug therefore matches zero rows: a uniform 404 item-not-found.
//
// CONSISTENCY. Each read runs in ONE REPEATABLE READ, READ ONLY transaction, so `item.get`'s item,
// head, live version and group are one snapshot, and a read can never write.
//
// PAGINATION is keyset, on columns an update never changes:
//   item.list     (slug, locale, id)   - editor order, ASC. update/publish/unpublish/delete never
//                                        touch any of the three, so a row keeps its position whatever
//                                        happens to it (or to any other row) between two pages.
//   item.versions version DESC          - versions are append-only; a new write lands above the cursor.
//   media.list    (created_at, id) DESC  - immutable; a new upload lands above the cursor.
// OFFSET pagination would skip or repeat rows when a concurrent write moved one across a page edge;
// the tests drive exactly that.
//
// DELETED ITEMS (decision, design §12 WSK-51 done-when 8). `item.list` and the collection counts HIDE
// soft-deleted items by default. `?includeDeleted=true` includes them (history), and `?state=deleted`
// lists only them. `item.get` by id still returns a deleted item (with `deletedAt` set) so the editor
// can open its history and an operator can reverse the delete; the version reads work too.
import { Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DbService } from "../../db/db.service";
import { validateCollectionComposition, type CollectionComposition } from "../../delivery/vocabulary/composition";
import { VOCABULARY_VERSION } from "../../delivery/vocabulary/version";
import { fieldsBlockOf } from "../../delivery/vocabulary/item-fields";
import { ContentCommandsService } from "./content-commands.service";
import { contentHash, isPlainObject } from "./content-projection";
import { computeContentLint, lintPlaceholders, type LintReport } from "./content-lint";
import { ControlProblem, problems } from "./content-problem";
import { findMediaUsage } from "./media-usage";
import { canonicalAssetPath, toLibraryAsset } from "../../media/library-asset";
import { MEDIA_ASSET_COLUMNS } from "../../media/media.service";
import type { MediaAssetRow } from "../../media/dto";
import { EDITORIAL_COLUMNS, countOpenComments, loadPolicy, viewOf, type EditorialRow, type EditorialView } from "../editorial/editorial-store";
import type { ReviewState } from "../editorial/editorial-model";

// ------------------------------------------------------------------------------------------------
// Public shapes (design §4)
// ------------------------------------------------------------------------------------------------
export const ITEM_STATES = ["draft", "live", "scheduled", "unpublished", "deleted", "pending"] as const;
export type ItemListState = (typeof ITEM_STATES)[number];

export interface ItemListQuery {
  locale?: string;
  state?: ItemListState;
  /** M5-W2b: only items in this review state (an item the flow never touched reads as `draft`). */
  reviewState?: ReviewState;
  q?: string;
  includeDeleted: boolean;
  cursor?: string;
  limit: number;
}

export interface Page {
  /** The cursor for the next page; null when there is none. */
  cursor: string | null;
  hasMore: boolean;
  limit: number;
}

export interface CollectionCounts {
  /** Non-deleted items. */
  items: number;
  byLocale: Record<string, number>;
  /** Items a production key sees right now. */
  live: number;
  /** Items whose head version is newer than what is published (a never-published draft counts). */
  pendingChanges: number;
}

export interface ItemSummary {
  itemId: string;
  slug: string;
  locale: string;
  localizationGroupId: string;
  title: string | null;
  headVersion: number;
  publishedVersion: number | null;
  publishState: string;
  publishAt: string | null;
  unpublishAt: string | null;
  deletedAt: string | null;
  updatedAt: string;
  headCreatedAt: string | null;
  headCreatedBy: string | null;
  pendingChanges: boolean;
  /** M5-W2b: the review state (control plane only; /v1 never sees it). */
  editorial: EditorialView;
}

// ------------------------------------------------------------------------------------------------
// Internals
// ------------------------------------------------------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `to_char(created_at AT TIME ZONE 'UTC', ...)` output: microsecond precision survives the cursor round trip. */
const RAW_TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;
const RAW_TS_SQL = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US')`;

/**
 * The read path's visibility rule (delivery/content-read.ts EFFECTIVE_PUBLISHED_SQL, restated: that
 * file's SQL is frozen by WSK-48a's byte gate and does not export it; the write service restates it
 * the same way). "Live" means exactly "a production key sees this row right now".
 */
const LIVE_SQL = `(
  (ci.publish_state = 'published' AND (ci.unpublish_at IS NULL OR ci.unpublish_at > now()))
  OR (ci.publish_state = 'scheduled' AND ci.publish_at IS NOT NULL AND ci.publish_at <= now()
      AND (ci.unpublish_at IS NULL OR ci.unpublish_at > now()))
)`;
/** Newer head than published. A pre-0009 row (head 0) has no version history, so it is never pending. */
const PENDING_SQL = `(ci.head_version > COALESCE(ci.published_version, 0))`;

const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString());

function encodeCursor(parts: (string | number)[]): string {
  return Buffer.from(JSON.stringify(parts), "utf8").toString("base64url");
}

function decodeCursor(raw: string, shape: Array<"string" | "uuid" | "int" | "ts">): (string | number)[] {
  const bad = () => problems.invalidRequest("cursor is malformed; pass back the `page.cursor` of the previous response unchanged");
  let parts: unknown;
  try {
    parts = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw bad();
  }
  if (!Array.isArray(parts) || parts.length !== shape.length) throw bad();
  shape.forEach((kind, i) => {
    const v = parts[i] as unknown;
    const ok =
      kind === "int"
        ? typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 2_147_483_647
        : typeof v === "string" &&
          v.length <= 2048 &&
          (kind === "uuid" ? UUID_RE.test(v) : kind === "ts" ? RAW_TS_RE.test(v) : true);
    if (!ok) throw bad();
  });
  return parts as (string | number)[];
}

/** `title` comes from seo.title, else fields[ui.titleField] (design §4). Mirrors the SQL in listItems. */
function titleOf(seo: unknown, blocks: unknown, titleField: string | undefined): string | null {
  if (isPlainObject(seo) && typeof seo.title === "string" && seo.title !== "") return seo.title;
  if (!titleField || !Array.isArray(blocks)) return null;
  const first = blocks[0];
  if (!isPlainObject(first) || first.type !== "fields" || !isPlainObject(first.props)) return null;
  const v = first.props[titleField];
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : null;
}

function titleFieldOf(schema: unknown): string | undefined {
  if (!isPlainObject(schema) || !isPlainObject(schema.ui)) return undefined;
  const t = schema.ui.titleField;
  return typeof t === "string" && t !== "" ? t : undefined;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

interface ItemRow {
  id: string;
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
  blocks: unknown;
  seo: Record<string, unknown> | null;
  collection_key: string;
  composition: unknown;
}

interface VersionRow {
  version: number;
  blocks: unknown;
  seo: Record<string, unknown>;
  content_hash: string | null;
  note: string | null;
  attribution: Record<string, unknown>;
  created_by: string;
  created_at: Date;
}

/** A version as `item.get` and `item.versionGet` return it. `n` is design §4's name; `version` is the write plane's and the list's. */
interface VersionView {
  n: number;
  version: number;
  contentHash: string;
  createdAt: string;
  createdBy: string | null;
  attribution: Record<string, unknown>;
  note: string | null;
  blocks: unknown;
  seo: Record<string, unknown>;
}

function versionView(v: VersionRow): VersionView {
  return {
    n: v.version,
    version: v.version,
    contentHash: v.content_hash ?? contentHash(v.blocks, v.seo),
    createdAt: iso(v.created_at) as string,
    createdBy: v.created_by,
    attribution: v.attribution ?? {},
    note: v.note,
    blocks: v.blocks,
    seo: v.seo ?? {},
  };
}

/** A pre-0009 row has no version row: its projection IS its content. Version 0, the write plane's own convention (headRef). */
function projectionView(item: ItemRow): VersionView {
  const seo = item.seo ?? {};
  return {
    n: 0,
    version: 0,
    contentHash: contentHash(item.blocks ?? [], seo),
    createdAt: iso(item.updated_at) as string,
    createdBy: null,
    attribution: {},
    note: null,
    blocks: item.blocks ?? [],
    seo,
  };
}

@Injectable()
export class ContentReadsService {
  constructor(
    private readonly db: DbService,
    private readonly commands: ContentCommandsService,
  ) {}

  /** One snapshot, read only, under the tenant's RLS context. */
  private read<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.db.withTenant(tenantId, (db) =>
      db.transaction(async (client) => {
        await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        return fn(client);
      }),
    );
  }

  // ==============================================================================================
  // collection.list / collection.get
  // ==============================================================================================
  async listCollections(tenantSlug: string, siteId: string) {
    const { tenant } = await this.commands.resolveTenantSite(tenantSlug, siteId);
    return this.read(tenant.id, async (c) => {
      const { rows: cols } = await c.query<{ id: string; key: string; schema: unknown; updated_at: Date }>(
        `SELECT id, key, schema, updated_at FROM collections WHERE site_id = $1 ORDER BY key`,
        [siteId],
      );
      const { rows: agg } = await c.query<{ collection_id: string; items: string; live: string; pending: string }>(
        `SELECT ci.collection_id, count(*) AS items,
                count(*) FILTER (WHERE ${LIVE_SQL}) AS live,
                count(*) FILTER (WHERE ${PENDING_SQL}) AS pending
           FROM content_items ci
          WHERE ci.site_id = $1 AND ci.deleted_at IS NULL
          GROUP BY ci.collection_id`,
        [siteId],
      );
      const { rows: loc } = await c.query<{ collection_id: string; locale: string; n: string }>(
        `SELECT ci.collection_id, ci.locale, count(*) AS n
           FROM content_items ci
          WHERE ci.site_id = $1 AND ci.deleted_at IS NULL
          GROUP BY ci.collection_id, ci.locale
          ORDER BY ci.locale`,
        [siteId],
      );
      const byCollection = new Map(agg.map((a) => [a.collection_id, a]));
      const locales = new Map<string, Record<string, number>>();
      for (const l of loc) {
        const m = locales.get(l.collection_id) ?? {};
        m[l.locale] = Number(l.n);
        locales.set(l.collection_id, m);
      }
      return {
        collections: cols.map((col) => {
          const a = byCollection.get(col.id);
          const counts: CollectionCounts = {
            items: a ? Number(a.items) : 0,
            byLocale: locales.get(col.id) ?? {},
            live: a ? Number(a.live) : 0,
            pendingChanges: a ? Number(a.pending) : 0,
          };
          return {
            key: col.key,
            composition: col.schema,
            vocabularyVersion: VOCABULARY_VERSION,
            counts,
            updatedAt: iso(col.updated_at) as string,
          };
        }),
      };
    });
  }

  async getCollection(tenantSlug: string, siteId: string, key: string) {
    const { tenant } = await this.commands.resolveTenantSite(tenantSlug, siteId);
    return this.read(tenant.id, async (c) => {
      const { rows } = await c.query<{ key: string; schema: unknown; updated_at: Date }>(
        `SELECT key, schema, updated_at FROM collections WHERE site_id = $1 AND key = $2`,
        [siteId, key],
      );
      if (!rows[0]) throw problems.collectionNotFound();
      return { key: rows[0].key, composition: rows[0].schema, vocabularyVersion: VOCABULARY_VERSION, updatedAt: iso(rows[0].updated_at) as string };
    });
  }

  // ==============================================================================================
  // item.list
  // ==============================================================================================
  async listItems(tenantSlug: string, siteId: string, collectionKey: string, query: ItemListQuery) {
    const { tenant } = await this.commands.resolveTenantSite(tenantSlug, siteId);
    // Decode before any query: a malformed cursor is the caller's 400 whatever the data is.
    const after = query.cursor ? decodeCursor(query.cursor, ["string", "string", "uuid"]) : null;
    return this.read(tenant.id, async (c) => {
      const { rows: cols } = await c.query<{ id: string; schema: unknown }>(
        `SELECT id, schema FROM collections WHERE site_id = $1 AND key = $2`,
        [siteId, collectionKey],
      );
      if (!cols[0]) throw problems.collectionNotFound();
      const titleField = titleFieldOf(cols[0].schema);

      const params: unknown[] = [siteId, cols[0].id, titleField ?? null];
      const p = (v: unknown): string => {
        params.push(v);
        return `$${params.length}`;
      };
      // The head's content: its version row, or (a pre-0009 row, head 0) the projection.
      const headSeo = `COALESCE(hv.seo, ci.seo)`;
      const headBlocks = `COALESCE(hv.blocks, ci.blocks)`;
      const titleSql = `COALESCE(NULLIF(${headSeo}->>'title', ''),
        CASE WHEN ${headBlocks}->0->>'type' = 'fields' THEN ${headBlocks}->0->'props'->>$3::text END)`;

      const where: string[] = [`ci.site_id = $1`, `ci.collection_id = $2`];
      // Deleted items: hidden unless asked for (decision at the top of this file).
      if (query.state === "deleted") where.push(`ci.deleted_at IS NOT NULL`);
      else if (!query.includeDeleted) where.push(`ci.deleted_at IS NULL`);
      switch (query.state) {
        case "draft":
          where.push(`ci.publish_state = 'draft'`);
          break;
        case "live":
          where.push(LIVE_SQL);
          break;
        case "scheduled":
          where.push(`ci.publish_state = 'scheduled'`);
          break;
        case "unpublished":
          where.push(`ci.publish_state = 'unpublished'`);
          break;
        case "pending":
          where.push(PENDING_SQL);
          break;
        default:
          break;
      }
      if (query.reviewState) {
        where.push(`COALESCE((SELECT e.state FROM editorial_items e WHERE e.content_item_id = ci.id), 'draft') = ${p(query.reviewState)}`);
      }
      if (query.locale) where.push(`ci.locale = ${p(query.locale)}`);
      if (query.q) {
        const like = p(`%${escapeLike(query.q)}%`);
        where.push(`(ci.slug ILIKE ${like} OR ${titleSql} ILIKE ${like})`);
      }
      if (after) where.push(`(ci.slug, ci.locale, ci.id) > (${p(after[0])}, ${p(after[1])}, ${p(after[2])}::uuid)`);
      const limit = p(query.limit + 1);

      const { rows } = await c.query<{
        id: string;
        slug: string;
        locale: string;
        localization_group_id: string;
        head_version: number;
        published_version: number | null;
        publish_state: string;
        publish_at: Date | null;
        unpublish_at: Date | null;
        deleted_at: Date | null;
        updated_at: Date;
        head_created_at: Date | null;
        head_created_by: string | null;
        title: string | null;
        pending_changes: boolean;
      }>(
        `SELECT ci.id, ci.slug, ci.locale, ci.localization_group_id, ci.head_version, ci.published_version,
                ci.publish_state, ci.publish_at, ci.unpublish_at, ci.deleted_at, ci.updated_at,
                hv.created_at AS head_created_at, hv.created_by AS head_created_by,
                ${titleSql} AS title,
                (ci.deleted_at IS NULL AND ${PENDING_SQL}) AS pending_changes
           FROM content_items ci
           LEFT JOIN content_versions hv ON hv.content_item_id = ci.id AND hv.version = ci.head_version
          WHERE ${where.join(" AND ")}
          ORDER BY ci.slug, ci.locale, ci.id
          LIMIT ${limit}`,
        params,
      );
      const hasMore = rows.length > query.limit;
      const slice = hasMore ? rows.slice(0, query.limit) : rows;
      // M5-W2b: the `editorial` member of each row, from one extra read for the page.
      const policy = await loadPolicy(c, siteId, collectionKey);
      const pageIds = slice.map((r) => r.id);
      const reviewRows = new Map<string, EditorialRow>();
      const openByItem = new Map<string, number>();
      if (pageIds.length > 0) {
        const er = await c.query<EditorialRow & { content_item_id: string }>(
          `SELECT ei.content_item_id, ${EDITORIAL_COLUMNS} FROM editorial_items ei WHERE ei.content_item_id = ANY($1::uuid[])`,
          [pageIds],
        );
        for (const r of er.rows) reviewRows.set(r.content_item_id, r);
        const oc = await c.query<{ content_item_id: string; n: string }>(
          `SELECT content_item_id, count(*)::text AS n FROM editorial_comments WHERE content_item_id = ANY($1::uuid[]) AND resolved_at IS NULL GROUP BY content_item_id`,
          [pageIds],
        );
        for (const r of oc.rows) openByItem.set(r.content_item_id, Number(r.n));
      }
      const items: ItemSummary[] = slice.map((r) => ({
        itemId: r.id,
        slug: r.slug,
        locale: r.locale,
        localizationGroupId: r.localization_group_id,
        title: r.title,
        headVersion: r.head_version,
        publishedVersion: r.published_version,
        publishState: r.publish_state,
        publishAt: iso(r.publish_at),
        unpublishAt: iso(r.unpublish_at),
        deletedAt: iso(r.deleted_at),
        updatedAt: iso(r.updated_at) as string,
        headCreatedAt: iso(r.head_created_at),
        headCreatedBy: r.head_created_by,
        pendingChanges: r.pending_changes,
        editorial: viewOf(reviewRows.get(r.id) ?? null, policy, r.head_version, openByItem.get(r.id) ?? 0),
      }));
      const last = slice[slice.length - 1];
      const page: Page = { cursor: hasMore && last ? encodeCursor([last.slug, last.locale, last.id]) : null, hasMore, limit: query.limit };
      return { items, page };
    });
  }

  // ==============================================================================================
  // item.get
  // ==============================================================================================

  /** One item of this site (404 item-not-found for any miss, including another tenant's id). */
  private async itemRow(c: PoolClient, siteId: string, itemId: string): Promise<ItemRow> {
    if (!UUID_RE.test(itemId)) throw problems.itemNotFound();
    const { rows } = await c.query<ItemRow>(
      `SELECT ci.id, ci.locale, ci.slug, ci.localization_group_id, ci.head_version, ci.published_version,
              ci.publish_state, ci.publish_at, ci.unpublish_at, ci.deleted_at, ci.updated_at, ci.blocks, ci.seo,
              c.key AS collection_key, c.schema AS composition
         FROM content_items ci
         JOIN collections c ON c.id = ci.collection_id
        WHERE ci.id = $1 AND ci.site_id = $2`,
      [itemId, siteId],
    );
    if (!rows[0]) throw problems.itemNotFound();
    return rows[0];
  }

  private async loadVersion(c: PoolClient, itemId: string, version: number): Promise<VersionRow | null> {
    const { rows } = await c.query<VersionRow>(
      `SELECT version, blocks, seo, content_hash, note, attribution, created_by, created_at
         FROM content_versions WHERE content_item_id = $1 AND version = $2`,
      [itemId, version],
    );
    return rows[0] ?? null;
  }

  /**
   * Advisory placeholder lint of `blocks` (design §3.3), computed live. Same rules and the same token
   * registry lookup as the write plane's own lint (ContentCommandsService.lint, private to it), so an
   * item reads back the lint its last save returned. When the collection's stored composition is
   * itself invalid the lint cannot run: say so (`unavailable`) rather than report a clean `[]`.
   */
  private async lint(
    c: PoolClient,
    siteId: string,
    defaultLocale: string,
    collectionKey: string,
    rawComposition: unknown,
    blocks: unknown,
    locale: string,
    seo: unknown,
    groupId: string,
  ): Promise<LintReport & { unavailable?: string }> {
    const empty: LintReport = { placeholders: { unresolvedTokens: [], markers: {} } };
    const valid = validateCollectionComposition(collectionKey, rawComposition);
    if (!valid.valid) return { ...empty, unavailable: "the collection's stored composition is invalid" };
    const rules = (rawComposition as CollectionComposition).lint?.placeholders ?? [];
    const withContent = async (report: LintReport): Promise<LintReport> => {
      const content = await computeContentLint(c, siteId, groupId, { blocks, seo, composition: rawComposition as CollectionComposition, locale });
      return content ? { ...report, content } : report;
    };
    if (rules.length === 0) return withContent(empty);
    let registry: Map<string, string | null> | null = null;
    const withRegistry = rules.find((r) => r.kind === "token" && r.registry);
    if (withRegistry && withRegistry.kind === "token" && withRegistry.registry) {
      const reg = withRegistry.registry;
      const { rows } = await c.query<{ blocks: unknown }>(
        `SELECT ci.blocks FROM content_items ci
           JOIN collections c ON c.id = ci.collection_id
          WHERE c.site_id = $1 AND c.key = $2 AND ci.deleted_at IS NULL AND ci.locale IN ($3, $4)
          ORDER BY (ci.locale = $3) DESC, ci.created_at ASC
          LIMIT 1`,
        [siteId, reg.collection, locale, defaultLocale],
      );
      registry = new Map();
      const list = rows[0] ? fieldsBlockOf(rows[0].blocks)?.[reg.listField] : undefined;
      if (Array.isArray(list)) {
        for (const entry of list) {
          if (!isPlainObject(entry) || typeof entry[reg.keyField] !== "string") continue;
          const value = entry[reg.valueField];
          registry.set(entry[reg.keyField] as string, typeof value === "string" ? value : null);
        }
      }
    }
    return withContent(lintPlaceholders(rules, blocks, registry));
  }

  /**
   * `version` selects which version `version` carries: `head` (default: what the editor is editing),
   * `live` (the published version; 404 when nothing is published) or an integer n >= 1 (404 when the
   * item has no such version). `live` is always returned alongside, null when nothing is published.
   *
   * `item` is the write plane's ItemState (the exact field names and meanings WSK-66's reconcile
   * reads: publishedVersion, publishAt, unpublishAt) plus the editor's ItemSummary extras
   * (title, pendingChanges, headCreatedAt, headCreatedBy).
   */
  async getItem(tenantSlug: string, siteId: string, itemId: string, select: "head" | "live" | number) {
    const { tenant } = await this.commands.resolveTenantSite(tenantSlug, siteId);
    return this.read(tenant.id, async (c) => {
      const row = await this.itemRow(c, siteId, itemId);

      let head: VersionView;
      let headRow: VersionRow | null = null;
      if (row.head_version === 0) {
        head = projectionView(row);
      } else {
        headRow = await this.loadVersion(c, row.id, row.head_version);
        if (!headRow) throw new Error(`content item ${row.id} has head_version ${row.head_version} but no such version row`);
        head = versionView(headRow);
      }

      let live: VersionView | null = null;
      if (row.published_version !== null) {
        const liveRow = row.published_version === row.head_version && headRow ? headRow : await this.loadVersion(c, row.id, row.published_version);
        if (!liveRow) throw new Error(`content item ${row.id} has published_version ${row.published_version} but no such version row`);
        live = versionView(liveRow);
      } else if (row.head_version === 0 && (row.publish_state === "published" || row.publish_state === "scheduled")) {
        live = head; // a pre-0009 row: the projection is what is served
      }

      let selected: VersionView;
      if (select === "head") {
        selected = head;
      } else if (select === "live") {
        if (!live) throw new ControlProblem(404, "version-not-found", "Version not found", "This item has no published version.");
        selected = live;
      } else {
        const v = await this.loadVersion(c, row.id, select);
        if (!v) throw new ControlProblem(404, "version-not-found", "Version not found", `Item ${row.id} has no version ${select}.`);
        selected = versionView(v);
      }

      const { rows: group } = await c.query<{
        id: string;
        locale: string;
        slug: string;
        head_version: number;
        published_version: number | null;
        publish_state: string;
      }>(
        `SELECT id, locale, slug, head_version, published_version, publish_state
           FROM content_items
          WHERE site_id = $1 AND localization_group_id = $2 AND deleted_at IS NULL
          ORDER BY locale`,
        [siteId, row.localization_group_id],
      );

      const lint = await this.lint(c, siteId, tenant.defaultLocale, row.collection_key, row.composition, selected.blocks, row.locale, selected.seo, row.localization_group_id);

      // M5-W2b: the review state of the item (control plane only; /v1 never sees it).
      const reviewPolicy = await loadPolicy(c, siteId, row.collection_key);
      const reviewRow = await c.query<EditorialRow>(`SELECT ${EDITORIAL_COLUMNS} FROM editorial_items ei WHERE ei.content_item_id = $1`, [row.id]);
      const editorial = viewOf(reviewRow.rows[0] ?? null, reviewPolicy, row.head_version, await countOpenComments(c, row.id));

      return {
        item: {
          itemId: row.id,
          collectionKey: row.collection_key,
          locale: row.locale,
          slug: row.slug,
          localizationGroupId: row.localization_group_id,
          headVersion: row.head_version,
          publishedVersion: row.published_version,
          publishState: row.publish_state,
          publishAt: iso(row.publish_at),
          unpublishAt: iso(row.unpublish_at),
          deletedAt: iso(row.deleted_at),
          updatedAt: iso(row.updated_at) as string,
          title: titleOf(head.seo, head.blocks, titleFieldOf(row.composition)),
          pendingChanges: row.deleted_at === null && row.head_version > (row.published_version ?? 0),
          headCreatedAt: headRow ? head.createdAt : null,
          headCreatedBy: headRow ? head.createdBy : null,
        },
        version: selected,
        live,
        group: group.map((g) => ({
          locale: g.locale,
          itemId: g.id,
          slug: g.slug,
          headVersion: g.head_version,
          publishedVersion: g.published_version,
          publishState: g.publish_state,
        })),
        lint,
        editorial,
      };
    });
  }

  // ==============================================================================================
  // item.versions / item.versionGet
  // ==============================================================================================
  async listVersions(tenantSlug: string, siteId: string, itemId: string, cursor: string | undefined, limit: number) {
    const { tenant } = await this.commands.resolveTenantSite(tenantSlug, siteId);
    const after = cursor ? decodeCursor(cursor, ["int"]) : null;
    return this.read(tenant.id, async (c) => {
      const item = await this.itemRow(c, siteId, itemId);
      const params: unknown[] = [item.id, limit + 1];
      if (after) params.push(after[0]);
      const { rows } = await c.query<{
        version: number;
        content_hash: string | null;
        created_at: Date;
        created_by: string;
        attribution: Record<string, unknown>;
        note: string | null;
        hash_blocks: unknown;
        hash_seo: Record<string, unknown> | null;
      }>(
        `SELECT version, content_hash, created_at, created_by, attribution, note,
                CASE WHEN content_hash IS NULL THEN blocks END AS hash_blocks,
                CASE WHEN content_hash IS NULL THEN seo END AS hash_seo
           FROM content_versions
          WHERE content_item_id = $1 ${after ? "AND version < $3" : ""}
          ORDER BY version DESC
          LIMIT $2`,
        params,
      );
      const hasMore = rows.length > limit;
      const slice = hasMore ? rows.slice(0, limit) : rows;
      const last = slice[slice.length - 1];
      return {
        versions: slice.map((v) => ({
          version: v.version,
          contentHash: v.content_hash ?? contentHash(v.hash_blocks, v.hash_seo ?? {}),
          createdAt: iso(v.created_at) as string,
          createdBy: v.created_by,
          attribution: v.attribution ?? {},
          note: v.note,
        })),
        page: { cursor: hasMore && last ? encodeCursor([last.version]) : null, hasMore, limit } satisfies Page,
      };
    });
  }

  async getVersion(tenantSlug: string, siteId: string, itemId: string, n: number) {
    const { tenant } = await this.commands.resolveTenantSite(tenantSlug, siteId);
    return this.read(tenant.id, async (c) => {
      const item = await this.itemRow(c, siteId, itemId);
      const v = await this.loadVersion(c, item.id, n);
      if (!v) throw new ControlProblem(404, "version-not-found", "Version not found", `Item ${item.id} has no version ${n}.`);
      return versionView(v);
    });
  }

  // ==============================================================================================
  // media.list
  // ==============================================================================================
  // WSK-43a: the media LIBRARY read. Filters: `mime` (exact, or an `image/*` type prefix), `q` (a substring of
  // the title, the original filename or any tag, case-insensitive), `tag` (exactly one normalised tag),
  // `includeDeleted` (default false: soft-deleted and purged assets are hidden, as the library hides them),
  // `reviewState` (M5-W1q: accepted by default; quarantined = the review queue; rejected; all).
  // The cursor is unchanged: (created_at, id) DESC, immutable columns, so an edit, a delete or a purge
  // between two pages can never move a row across a page edge.
  async listMedia(
    tenantSlug: string,
    siteId: string,
    query: { assetId?: string; reviewState?: "accepted" | "quarantined" | "rejected" | "all"; mime?: string; q?: string; tag?: string; includeDeleted?: boolean; cursor?: string; limit: number },
  ) {
    const { tenant } = await this.commands.resolveTenantSite(tenantSlug, siteId);
    const after = query.cursor ? decodeCursor(query.cursor, ["ts", "uuid"]) : null;
    return this.read(tenant.id, async (c) => {
      const params: unknown[] = [siteId];
      const p = (v: unknown): string => {
        params.push(v);
        return `$${params.length}`;
      };
      const where = [`ma.site_id = $1`];
      if (!query.includeDeleted) where.push(`ma.deleted_at IS NULL`);
      // M5-W1q (WSK-D84): the library is the ACCEPTED assets unless the caller asks for the review queue. A quarantined or
      // rejected asset never appears in the picker an editor embeds from. (`rejected` rows are soft-deleted, so they also need includeDeleted.)
      if ((query.reviewState ?? "accepted") !== "all") where.push(`ma.review_state = ${p(query.reviewState ?? "accepted")}`);
      if (query.assetId) where.push(`ma.id = ${p(query.assetId)}::uuid`); // M5-W1q: the ERP's review route reads ONE asset's real uploader
      if (query.mime) {
        // `image/png` is exact; `image/*` is a type prefix (validated by the controller).
        where.push(
          query.mime.endsWith("/*")
            ? `ma.mime LIKE ${p(`${escapeLike(query.mime.slice(0, -1))}%`)}`
            : `ma.mime = ${p(query.mime)}`,
        );
      }
      if (query.tag) where.push(`ma.tags @> ARRAY[${p(query.tag)}]::text[]`);
      if (query.q) {
        const like = p(`%${escapeLike(query.q)}%`);
        where.push(
          `(ma.title ILIKE ${like} OR ma.original_filename ILIKE ${like} OR EXISTS (SELECT 1 FROM unnest(ma.tags) AS tg WHERE tg ILIKE ${like}))`,
        );
      }
      if (after) {
        where.push(`(ma.created_at, ma.id) < (${p(after[0])}::timestamp AT TIME ZONE 'UTC', ${p(after[1])}::uuid)`);
      }
      const limit = p(query.limit + 1);
      const { rows } = await c.query<MediaAssetRow & { deleted_at: Date | null; purge_after: Date | null; purged_at: Date | null; created_raw: string }>(
        `SELECT ${MEDIA_ASSET_COLUMNS.split(", ").map((col) => `ma.${col}`).join(", ")},
                ma.deleted_at, ma.purge_after, ma.purged_at,
                ${RAW_TS_SQL("ma.created_at")} AS created_raw
           FROM media_assets ma
          WHERE ${where.join(" AND ")}
          ORDER BY ma.created_at DESC, ma.id DESC
          LIMIT ${limit}`,
        params,
      );
      const hasMore = rows.length > query.limit;
      const slice = hasMore ? rows.slice(0, query.limit) : rows;
      const last = slice[slice.length - 1];
      return {
        assets: slice.map((m) => ({
          ...toLibraryAsset(m, tenant.slug),
          deletedAt: iso(m.deleted_at),
          purgeAfter: iso(m.purge_after),
          purgedAt: iso(m.purged_at),
        })),
        page: { cursor: hasMore && last ? encodeCursor([last.created_raw, last.id]) : null, hasMore, limit: query.limit } satisfies Page,
      };
    });
  }

  // ==============================================================================================
  // media.usage
  // ==============================================================================================
  // WSK-43a (D54): where an asset is used, by the SAME scan media.delete is judged by (media-usage.ts). A
  // deleted asset answers too (an empty or stale list is information, and the editor can open its history);
  // an unknown, malformed or other-site asset is one 404.
  async mediaUsage(tenantSlug: string, siteId: string, assetId: string) {
    const { tenant } = await this.commands.resolveTenantSite(tenantSlug, siteId);
    if (!UUID_RE.test(assetId)) throw mediaAssetNotFound();
    return this.read(tenant.id, async (c) => {
      const found = await c.query(`SELECT 1 FROM media_assets WHERE id = $1 AND site_id = $2 AND tenant_id = $3`, [assetId, siteId, tenant.id]);
      if (found.rows.length === 0) throw mediaAssetNotFound();
      const usage = await findMediaUsage(c, { tenantId: tenant.id, siteId, assetId });
      return { assetId, url: canonicalAssetPath(tenant.slug, assetId), total: usage.total, items: usage.items };
    });
  }
}

function mediaAssetNotFound(): ControlProblem {
  return new ControlProblem(404, "media-asset-not-found", "Media asset not found", "No such media asset on this site.");
}
