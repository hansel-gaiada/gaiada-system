// M5-W4 — the SQL of the writers' room briefs (docs/plans/2026-10-11-m5-writers-room-design.md §5, PERMISSION-CONTRACT §27.4).
// No authorization lives here: `webdesk-briefs.service.ts` decides who may call each function, and the controller's
// first statement is the phase-1 site gate. A brief is a row of `search_content_briefs` (migration 0046) carrying the
// WebDesk link added by 202610122300; there is no second brief table.
//
// EVERY query runs inside `withTenants([tenantId], fn, { modules: ["search"] })`: the table's FORCE RLS policy is the
// tenant wall AND `app_module_allowed('search')`, so a read with no tenant GUC or no `search` scope returns ZERO rows
// with no error (the silent-zero trap; the DB test proves it). The `search` module scope here is a property of the
// TABLE, not an authorization: whether a principal may see a brief is Cerbos's decision on the linked WebDesk item.
//
// Every statement also names `tenant_id` and `webdesk_site_id` itself (belt and braces behind RLS): a brief of another
// site, or another company, is "not found" however its id arrived.
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withTenants } from "../../db";

const MODULES = { modules: ["search"] };

/** One brief, as the BFF reads it. */
export interface BriefRecord {
  id: string;
  propertyId: string | null;
  topic: string;
  status: "draft" | "approved";
  outline: string[];
  body: string;
  geoNotes: string | null;
  grounding: unknown;
  draftedVia: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  webdeskTenantSlug: string | null;
  webdeskSiteId: string | null;
  collectionKey: string | null;
  locale: string | null;
  webdeskItemId: string | null;
  linkedAt: string | null;
  assigneeId: string | null;
  targetQuery: string | null;
  searchIntent: string | null;
  aiQuestions: string[];
  contentGaps: string[];
  sourceBriefId: string | null;
}

const COLUMNS = `id, property_id AS "propertyId", topic, status, outline, body, geo_notes AS "geoNotes", grounding,
  drafted_via AS "draftedVia", created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt",
  webdesk_tenant_slug AS "webdeskTenantSlug", webdesk_site_id AS "webdeskSiteId", collection_key AS "collectionKey",
  locale, webdesk_item_id AS "webdeskItemId", linked_at AS "linkedAt", assignee_id AS "assigneeId",
  target_query AS "targetQuery", search_intent AS "searchIntent", ai_questions AS "aiQuestions",
  content_gaps AS "contentGaps", source_brief_id AS "sourceBriefId"`;

function asRecord(r: Record<string, unknown>): BriefRecord {
  const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : typeof v === "string" ? v : null);
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    ...(r as unknown as BriefRecord),
    outline: list(r.outline),
    aiQuestions: list(r.aiQuestions),
    contentGaps: list(r.contentGaps),
    createdAt: iso(r.createdAt) as string,
    updatedAt: iso(r.updatedAt) as string,
    linkedAt: iso(r.linkedAt),
  };
}

export interface NewBrief {
  tenantId: string;
  webdeskTenantSlug: string;
  webdeskSiteId: string;
  collectionKey: string;
  locale: string;
  topic: string;
  outline: string[];
  body: string;
  geoNotes: string | null;
  targetQuery: string | null;
  searchIntent: string | null;
  aiQuestions: string[];
  contentGaps: string[];
  propertyId: string | null;
  sourceBriefId: string | null;
  grounding: Record<string, unknown>;
  createdBy: string | null;
  originSite: string;
}

export async function insertBrief(b: NewBrief): Promise<BriefRecord> {
  const id = randomUUID();
  return withTenants(
    [b.tenantId],
    async (c) => {
      const r = await c.query(
        `INSERT INTO search_content_briefs
           (id, tenant_id, property_id, topic, status, outline, body, geo_notes, grounding, created_by, origin_site,
            webdesk_tenant_slug, webdesk_site_id, collection_key, locale, target_query, search_intent, ai_questions, content_gaps, source_brief_id)
         VALUES ($1,$2,$3,$4,'draft',$5::jsonb,$6,$7,$8::jsonb,$9,$10,$11,$12::uuid,$13,$14,$15,$16,$17::jsonb,$18::jsonb,$19)
         RETURNING ${COLUMNS}`,
        [
          id, b.tenantId, b.propertyId, b.topic, JSON.stringify(b.outline), b.body, b.geoNotes, JSON.stringify(b.grounding),
          b.createdBy, b.originSite, b.webdeskTenantSlug, b.webdeskSiteId, b.collectionKey, b.locale, b.targetQuery, b.searchIntent,
          JSON.stringify(b.aiQuestions), JSON.stringify(b.contentGaps), b.sourceBriefId,
        ],
      );
      return asRecord(r.rows[0]);
    },
    MODULES,
  );
}

/** A writers' room brief of THIS site (tenant + site named in the statement, RLS behind it). null = not found. */
export async function getBrief(tenantId: string, siteId: string, briefId: string): Promise<BriefRecord | null> {
  return withTenants(
    [tenantId],
    async (c) => {
      const r = await c.query(
        `SELECT ${COLUMNS} FROM search_content_briefs
          WHERE id = $1 AND tenant_id = $2 AND webdesk_site_id = $3::uuid AND deleted_at IS NULL`,
        [briefId, tenantId, siteId],
      );
      return r.rows[0] ? asRecord(r.rows[0]) : null;
    },
    MODULES,
  );
}

export async function getBriefByItem(tenantId: string, siteId: string, itemId: string): Promise<BriefRecord | null> {
  return withTenants(
    [tenantId],
    async (c) => {
      const r = await c.query(
        `SELECT ${COLUMNS} FROM search_content_briefs
          WHERE tenant_id = $1 AND webdesk_site_id = $2::uuid AND webdesk_item_id = $3::uuid AND deleted_at IS NULL`,
        [tenantId, siteId, itemId],
      );
      return r.rows[0] ? asRecord(r.rows[0]) : null;
    },
    MODULES,
  );
}

export interface BriefListFilter {
  collectionKey?: string;
  locale?: string;
  status?: "draft" | "approved";
  /** true: only briefs linked to a draft; false: only the unlinked ones. */
  linked?: boolean;
  cursor?: { ts: string; id: string };
  limit: number;
}

/** One page, newest first. `cursorTs` is the row's created_at at full microsecond precision (a JS Date would lose it). */
export async function listBriefs(tenantId: string, siteId: string, f: BriefListFilter): Promise<{ rows: Array<BriefRecord & { cursorTs: string }>; hasMore: boolean }> {
  return withTenants(
    [tenantId],
    async (c) => {
      const params: unknown[] = [tenantId, siteId];
      const where = ["tenant_id = $1", "webdesk_site_id = $2::uuid", "deleted_at IS NULL"];
      const p = (v: unknown): string => {
        params.push(v);
        return `$${params.length}`;
      };
      if (f.collectionKey !== undefined) where.push(`collection_key = ${p(f.collectionKey)}`);
      if (f.locale !== undefined) where.push(`locale = ${p(f.locale)}`);
      if (f.status !== undefined) where.push(`status = ${p(f.status)}`);
      if (f.linked === true) where.push("webdesk_item_id IS NOT NULL");
      if (f.linked === false) where.push("webdesk_item_id IS NULL");
      if (f.cursor) where.push(`(created_at, id) < (${p(f.cursor.ts)}::timestamptz, ${p(f.cursor.id)}::uuid)`);
      const r = await c.query(
        `SELECT ${COLUMNS},
                to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTs"
           FROM search_content_briefs
          WHERE ${where.join(" AND ")}
          ORDER BY created_at DESC, id DESC
          LIMIT ${p(f.limit + 1)}`,
        params,
      );
      const hasMore = r.rows.length > f.limit;
      return { rows: r.rows.slice(0, f.limit).map((row) => ({ ...asRecord(row), cursorTs: String(row.cursorTs) })), hasMore };
    },
    MODULES,
  );
}

export interface BriefPatch {
  topic?: string;
  status?: "draft" | "approved";
  outline?: string[];
  body?: string;
  geoNotes?: string | null;
  targetQuery?: string | null;
  searchIntent?: string | null;
  aiQuestions?: string[];
  contentGaps?: string[];
}

const PATCH_COLUMNS: Record<keyof BriefPatch, { col: string; json?: boolean }> = {
  topic: { col: "topic" },
  status: { col: "status" },
  outline: { col: "outline", json: true },
  body: { col: "body" },
  geoNotes: { col: "geo_notes" },
  targetQuery: { col: "target_query" },
  searchIntent: { col: "search_intent" },
  aiQuestions: { col: "ai_questions", json: true },
  contentGaps: { col: "content_gaps", json: true },
};

export async function updateBrief(tenantId: string, siteId: string, briefId: string, patch: BriefPatch): Promise<BriefRecord | null> {
  const keys = (Object.keys(patch) as Array<keyof BriefPatch>).filter((k) => patch[k] !== undefined);
  return withTenants(
    [tenantId],
    async (c) => {
      const params: unknown[] = [briefId, tenantId, siteId];
      const sets = keys.map((k) => {
        const spec = PATCH_COLUMNS[k];
        params.push(spec.json ? JSON.stringify(patch[k]) : patch[k]);
        return `${spec.col} = $${params.length}${spec.json ? "::jsonb" : ""}`;
      });
      const r = await c.query(
        `UPDATE search_content_briefs SET ${[...sets, "updated_at = now()"].join(", ")}
          WHERE id = $1 AND tenant_id = $2 AND webdesk_site_id = $3::uuid AND deleted_at IS NULL
          RETURNING ${COLUMNS}`,
        params,
      );
      return r.rows[0] ? asRecord(r.rows[0]) : null;
    },
    MODULES,
  );
}

export type LinkOutcome = "linked" | "already-linked-here" | "brief-linked-elsewhere" | "item-has-another-brief" | "not-found";

/**
 * Link a brief to a WebDesk item (and, when given, record the assignee). Idempotent for the same pair. One brief per
 * item (the partial unique index) and one item per brief (checked here, under a row lock).
 */
export async function linkBrief(tenantId: string, siteId: string, briefId: string, itemId: string, assigneeId: string | null | undefined): Promise<LinkOutcome> {
  return withTenants(
    [tenantId],
    async (c: PoolClient) => {
      const cur = await c.query<{ webdesk_item_id: string | null }>(
        `SELECT webdesk_item_id FROM search_content_briefs
          WHERE id = $1 AND tenant_id = $2 AND webdesk_site_id = $3::uuid AND deleted_at IS NULL FOR UPDATE`,
        [briefId, tenantId, siteId],
      );
      if (!cur.rows[0]) return "not-found" as const;
      const linkedTo = cur.rows[0].webdesk_item_id;
      if (linkedTo !== null && linkedTo.toLowerCase() !== itemId.toLowerCase()) return "brief-linked-elsewhere" as const;
      const other = await c.query(
        `SELECT 1 FROM search_content_briefs
          WHERE tenant_id = $1 AND webdesk_item_id = $2::uuid AND id <> $3 AND deleted_at IS NULL`,
        [tenantId, itemId, briefId],
      );
      if (other.rows.length > 0) return "item-has-another-brief" as const;
      await c.query(
        `UPDATE search_content_briefs
            SET webdesk_item_id = $2::uuid, linked_at = COALESCE(linked_at, now()),
                assignee_id = CASE WHEN $4::boolean THEN $3::uuid ELSE assignee_id END, updated_at = now()
          WHERE id = $1`,
        [briefId, itemId, assigneeId ?? null, assigneeId !== undefined],
      );
      return linkedTo === null ? ("linked" as const) : ("already-linked-here" as const);
    },
    MODULES,
  );
}

/**
 * Keep `assignee_id` equal to the item's author after the generic `editorial.assign` route changed it. The column only
 * filters the board and picks a notification recipient; it never grants read access (Cerbos on the item does).
 * Returns the number of rows touched (0 or 1).
 */
export async function syncAssignee(tenantId: string, siteId: string, itemId: string, assigneeId: string | null): Promise<number> {
  return withTenants(
    [tenantId],
    async (c) => {
      const r = await c.query(
        `UPDATE search_content_briefs SET assignee_id = $4::uuid, updated_at = now()
          WHERE tenant_id = $1 AND webdesk_site_id = $2::uuid AND webdesk_item_id = $3::uuid AND deleted_at IS NULL
            AND assignee_id IS DISTINCT FROM $4::uuid`,
        [tenantId, siteId, itemId, assigneeId],
      );
      return r.rowCount ?? 0;
    },
    MODULES,
  );
}

/** A plain SEO brief (it has a search property) of this company, for "create from a search brief". */
export async function getSearchBrief(tenantId: string, briefId: string): Promise<BriefRecord | null> {
  return withTenants(
    [tenantId],
    async (c) => {
      const r = await c.query(
        `SELECT ${COLUMNS} FROM search_content_briefs
          WHERE id = $1 AND tenant_id = $2 AND property_id IS NOT NULL AND deleted_at IS NULL`,
        [briefId, tenantId],
      );
      return r.rows[0] ? asRecord(r.rows[0]) : null;
    },
    MODULES,
  );
}

export async function searchPropertyExists(tenantId: string, propertyId: string): Promise<boolean> {
  return withTenants(
    [tenantId],
    async (c) => (await c.query(`SELECT 1 FROM search_properties WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`, [propertyId, tenantId])).rows.length > 0,
    MODULES,
  );
}
