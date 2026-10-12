// M5-W2b (writers' room design 4.3) — the two editorial READ commands (read / webdesk:read, no editorial
// assertion, no audit row, like every control read of tenant data):
//   editorial.board    the site's review board: items that are in the flow, their review state, per-state counts
//                      and the site's policies. Keyset-paginated on (updated_at DESC, id DESC).
//   editorial.history  one item's review record: its state, the event history (oldest first) and its comments,
//                      plus the SEO/AEO snapshot taken at the sign-off.
// (item.get and item.list carry the `editorial` member from content-reads.service.ts.)
// One REPEATABLE READ, READ ONLY snapshot each. Review data lives only here: /v1 never reads these tables.
import { Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DbService } from "../../db/db.service";
import { ContentCommandsService } from "../content/content-commands.service";
import { problems } from "../content/content-problem";
import type { ReviewState } from "./editorial-model";
import { EDITORIAL_COLUMNS, countOpenComments, loadPolicy, viewOf, type EditorialRow } from "./editorial-store";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RAW_TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;
/** How many events and comments one history read returns (the newest, oldest first). */
export const HISTORY_CAP = 500;

export interface BoardQuery {
  state?: ReviewState;
  collection?: string;
  authorSub?: string;
  /** ISO instant: only items due at or before it. */
  dueBefore?: string;
  cursor?: string;
  limit: number;
}

const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString());

function cursorOf(raw: string): [string, string] {
  const bad = () => problems.invalidRequest("cursor is malformed; pass back the `page.cursor` of the previous response unchanged");
  let parts: unknown;
  try {
    parts = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw bad();
  }
  if (!Array.isArray(parts) || parts.length !== 2 || typeof parts[0] !== "string" || typeof parts[1] !== "string" || !RAW_TS_RE.test(parts[0]) || !UUID_RE.test(parts[1])) throw bad();
  return [parts[0], parts[1]];
}

@Injectable()
export class EditorialReadsService {
  constructor(
    private readonly db: DbService,
    private readonly commands: ContentCommandsService,
  ) {}

  private read<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.db.withTenant(tenantId, (db) =>
      db.transaction(async (client) => {
        await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        return fn(client);
      }),
    );
  }

  // ==============================================================================================
  // editorial.board
  // ==============================================================================================
  async board(tenantSlug: string, siteId: string, q: BoardQuery) {
    const { tenant } = await this.commands.resolveTenantSite(tenantSlug, siteId);
    const after = q.cursor ? cursorOf(q.cursor) : null;
    return this.read(tenant.id, async (c) => {
      const params: unknown[] = [siteId];
      const p = (v: unknown): string => {
        params.push(v);
        return `$${params.length}`;
      };
      const where = [`ei.site_id = $1`, `ci.deleted_at IS NULL`];
      if (q.state) where.push(`ei.state = ${p(q.state)}`);
      if (q.collection) where.push(`col.key = ${p(q.collection)}`);
      if (q.authorSub) where.push(`ei.author_sub = ${p(q.authorSub)}`);
      if (q.dueBefore) where.push(`ei.due_at <= ${p(q.dueBefore)}::timestamptz`);
      if (after) where.push(`(ei.updated_at, ci.id) < (${p(after[0])}::timestamp AT TIME ZONE 'UTC', ${p(after[1])}::uuid)`);
      const limit = p(q.limit + 1);
      const { rows } = await c.query<
        EditorialRow & {
          id: string;
          slug: string;
          locale: string;
          head_version: number;
          publish_state: string;
          collection_key: string;
          title: string | null;
          open_comments: string;
          raw_updated_at: string;
        }
      >(
        `SELECT ci.id, ci.slug, ci.locale, ci.head_version, ci.publish_state, col.key AS collection_key,
                NULLIF(hv.seo->>'title', '') AS title,
                (SELECT count(*) FROM editorial_comments k WHERE k.content_item_id = ci.id AND k.resolved_at IS NULL)::text AS open_comments,
                to_char(ei.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS raw_updated_at,
                ${EDITORIAL_COLUMNS}
           FROM editorial_items ei
           JOIN content_items ci ON ci.id = ei.content_item_id
           JOIN collections col ON col.id = ci.collection_id
           LEFT JOIN content_versions hv ON hv.content_item_id = ci.id AND hv.version = ci.head_version
          WHERE ${where.join(" AND ")}
          ORDER BY ei.updated_at DESC, ci.id DESC
          LIMIT ${limit}`,
        params,
      );
      const hasMore = rows.length > q.limit;
      const slice = hasMore ? rows.slice(0, q.limit) : rows;
      const policies = await c.query<{ collection_key: string; review_required: boolean; seo_signoff_required: boolean; updated_at: Date; updated_by: string | null }>(
        `SELECT collection_key, review_required, seo_signoff_required, updated_at, updated_by FROM editorial_policies WHERE site_id = $1 ORDER BY collection_key`,
        [siteId],
      );
      const policyByKey = new Map(policies.rows.map((r) => [r.collection_key, { reviewRequired: r.review_required, seoSignoffRequired: r.seo_signoff_required }]));
      const counts = await c.query<{ state: ReviewState; n: string }>(
        `SELECT ei.state, count(*)::text AS n FROM editorial_items ei JOIN content_items ci ON ci.id = ei.content_item_id
          WHERE ei.site_id = $1 AND ci.deleted_at IS NULL GROUP BY ei.state`,
        [siteId],
      );
      const byState: Record<ReviewState, number> = { draft: 0, in_review: 0, changes_requested: 0, approved: 0 };
      for (const r of counts.rows) byState[r.state] = Number(r.n);
      const last = slice[slice.length - 1];
      return {
        items: slice.map((r) => ({
          itemId: r.id,
          collectionKey: r.collection_key,
          locale: r.locale,
          slug: r.slug,
          title: r.title,
          headVersion: r.head_version,
          publishState: r.publish_state,
          editorial: viewOf(r, policyByKey.get(r.collection_key) ?? { reviewRequired: false, seoSignoffRequired: false }, r.head_version, Number(r.open_comments)),
        })),
        counts: byState,
        policies: policies.rows.map((r) => ({
          collectionKey: r.collection_key,
          reviewRequired: r.review_required,
          seoSignoffRequired: r.seo_signoff_required,
          updatedBy: r.updated_by,
          updatedAt: iso(r.updated_at) as string,
        })),
        page: { cursor: hasMore && last ? Buffer.from(JSON.stringify([last.raw_updated_at, last.id]), "utf8").toString("base64url") : null, hasMore, limit: q.limit },
      };
    });
  }

  // ==============================================================================================
  // editorial.history
  // ==============================================================================================
  async history(tenantSlug: string, siteId: string, itemId: string) {
    const { tenant } = await this.commands.resolveTenantSite(tenantSlug, siteId);
    return this.read(tenant.id, async (c) => {
      if (!UUID_RE.test(itemId)) throw problems.itemNotFound();
      const item = await c.query<{ id: string; head_version: number; collection_key: string; deleted_at: Date | null }>(
        `SELECT ci.id, ci.head_version, col.key AS collection_key, ci.deleted_at
           FROM content_items ci JOIN collections col ON col.id = ci.collection_id
          WHERE ci.id = $1 AND ci.site_id = $2`,
        [itemId, siteId],
      );
      if (!item.rows[0]) throw problems.itemNotFound();
      const policy = await loadPolicy(c, siteId, item.rows[0].collection_key);
      const row = await c.query<EditorialRow & { seo_snapshot: unknown }>(
        `SELECT ${EDITORIAL_COLUMNS}, ei.seo_snapshot FROM editorial_items ei WHERE ei.content_item_id = $1`,
        [itemId],
      );
      const events = await c.query<{ id: string; version: number | null; kind: string; actor_sub: string; note: string | null; created_at: Date }>(
        `SELECT id, version, kind, actor_sub, note, created_at FROM (
           SELECT id, version, kind, actor_sub, note, created_at FROM editorial_events WHERE content_item_id = $1
            ORDER BY created_at DESC, id DESC LIMIT ${HISTORY_CAP + 1}) newest
          ORDER BY created_at, id`,
        [itemId],
      );
      const comments = await c.query<{ id: string; version: number; anchor: string | null; body: string; author_sub: string; created_at: Date; resolved_at: Date | null; resolved_by: string | null }>(
        `SELECT id, version, anchor, body, author_sub, created_at, resolved_at, resolved_by FROM (
           SELECT * FROM editorial_comments WHERE content_item_id = $1 ORDER BY created_at DESC, id DESC LIMIT ${HISTORY_CAP + 1}) newest
          ORDER BY created_at, id`,
        [itemId],
      );
      const eventsTruncated = events.rows.length > HISTORY_CAP;
      const commentsTruncated = comments.rows.length > HISTORY_CAP;
      return {
        itemId,
        collectionKey: item.rows[0].collection_key,
        headVersion: item.rows[0].head_version,
        deleted: item.rows[0].deleted_at !== null,
        editorial: viewOf(row.rows[0] ?? null, policy, item.rows[0].head_version, await countOpenComments(c, itemId)),
        seoSnapshot: row.rows[0]?.seo_snapshot ?? null,
        events: (eventsTruncated ? events.rows.slice(1) : events.rows).map((e) => ({
          id: e.id,
          version: e.version,
          kind: e.kind,
          actorSub: e.actor_sub,
          note: e.note,
          createdAt: iso(e.created_at) as string,
        })),
        eventsTruncated,
        comments: (commentsTruncated ? comments.rows.slice(1) : comments.rows).map((k) => ({
          id: k.id,
          version: k.version,
          anchor: k.anchor,
          body: k.body,
          authorSub: k.author_sub,
          createdAt: iso(k.created_at) as string,
          resolvedAt: iso(k.resolved_at),
          resolvedBy: k.resolved_by,
        })),
        commentsTruncated,
      };
    });
  }
}
