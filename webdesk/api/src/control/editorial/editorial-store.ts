// M5-W2b — the SQL every editorial code path shares: the item's review row, the collection's policy, the
// event writer, the `editorial` view the reads and the commands return, and the two hooks the version writer
// calls (at the bottom). Nothing here is reachable from /v1 (delivery/** never imports control/editorial,
// and a static spec holds it to that).
import type { PoolClient } from "pg";
import { stateAfterNewVersion, type EditorialEventKind, type ReviewState } from "./editorial-model";

const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString());

export interface PolicyRow {
  reviewRequired: boolean;
  seoSignoffRequired: boolean;
}

/** No policy row is exactly "review off" (the default). */
export const REVIEW_OFF: PolicyRow = Object.freeze({ reviewRequired: false, seoSignoffRequired: false });

export async function loadPolicy(client: PoolClient, siteId: string, collectionKey: string): Promise<PolicyRow> {
  const { rows } = await client.query<{ review_required: boolean; seo_signoff_required: boolean }>(
    `SELECT review_required, seo_signoff_required FROM editorial_policies WHERE site_id = $1 AND collection_key = $2`,
    [siteId, collectionKey],
  );
  return rows[0] ? { reviewRequired: rows[0].review_required, seoSignoffRequired: rows[0].seo_signoff_required } : REVIEW_OFF;
}

export interface EditorialRow {
  state: ReviewState;
  author_sub: string | null;
  submitted_version: number | null;
  seo_signed_version: number | null;
  seo_signed_by: string | null;
  approved_version: number | null;
  approved_by: string | null;
  approved_at: Date | null;
  due_at: Date | null;
  planned_publish_at: Date | null;
  brief_ref: string | null;
  updated_at: Date;
}

export const EDITORIAL_COLUMNS = `ei.state, ei.author_sub, ei.submitted_version, ei.seo_signed_version, ei.seo_signed_by,
  ei.approved_version, ei.approved_by, ei.approved_at, ei.due_at, ei.planned_publish_at, ei.brief_ref, ei.updated_at`;

/** The review state of an item the flow has never touched: a draft with no author (fail closed). */
export const UNTOUCHED: EditorialRow = Object.freeze({
  state: "draft",
  author_sub: null,
  submitted_version: null,
  seo_signed_version: null,
  seo_signed_by: null,
  approved_version: null,
  approved_by: null,
  approved_at: null,
  due_at: null,
  planned_publish_at: null,
  brief_ref: null,
  updated_at: new Date(0),
}) as EditorialRow;

/** The `editorial` member: item.get / item.list / the commands' results. Review data, never /v1. */
export interface EditorialView {
  reviewRequired: boolean;
  seoSignoffRequired: boolean;
  state: ReviewState;
  authorSub: string | null;
  submittedVersion: number | null;
  seoSignedVersion: number | null;
  seoSignedBy: string | null;
  /** The signed version is the one in review (a new version after the sign-off makes it stale). */
  seoSignedCurrent: boolean;
  approvedVersion: number | null;
  approvedBy: string | null;
  approvedAt: string | null;
  /** The approved version is the head right now (false once the item was edited after approval). */
  approvedIsHead: boolean;
  dueAt: string | null;
  plannedPublishAt: string | null;
  briefRef: string | null;
  openComments: number;
  /** null for an item the flow has never touched. */
  updatedAt: string | null;
}

export function viewOf(row: EditorialRow | null, policy: PolicyRow, headVersion: number, openComments: number): EditorialView {
  const r = row ?? UNTOUCHED;
  return {
    reviewRequired: policy.reviewRequired,
    seoSignoffRequired: policy.seoSignoffRequired,
    state: r.state,
    authorSub: r.author_sub,
    submittedVersion: r.submitted_version,
    seoSignedVersion: r.seo_signed_version,
    seoSignedBy: r.seo_signed_by,
    seoSignedCurrent: r.seo_signed_version !== null && r.seo_signed_version === r.submitted_version,
    approvedVersion: r.approved_version,
    approvedBy: r.approved_by,
    approvedAt: iso(r.approved_at),
    approvedIsHead: r.approved_version !== null && r.approved_version === headVersion,
    dueAt: iso(r.due_at),
    plannedPublishAt: iso(r.planned_publish_at),
    briefRef: r.brief_ref,
    openComments,
    updatedAt: row ? iso(r.updated_at) : null,
  };
}

export async function countOpenComments(client: PoolClient, itemId: string): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM editorial_comments WHERE content_item_id = $1 AND resolved_at IS NULL`,
    [itemId],
  );
  return Number(rows[0].n);
}

/**
 * One history row. created_at is the column default clock_timestamp(), so several events written in one
 * transaction still order; the history read sorts by (created_at, id).
 */
export async function insertEvent(
  client: PoolClient,
  e: { tenantId: string; itemId: string; version: number | null; kind: EditorialEventKind; actor: string; note?: string | null },
): Promise<void> {
  await client.query(
    `INSERT INTO editorial_events (tenant_id, content_item_id, version, kind, actor_sub, note) VALUES ($1, $2, $3, $4, $5, $6)`,
    [e.tenantId, e.itemId, e.version, e.kind, e.actor, e.note ?? null],
  );
}

// ================================================================================================
// Hooks called by the version writer (content-commands.service.ts). They run inside the content
// command's own transaction, after its version row exists, so the composite foreign keys hold.
// ================================================================================================

/**
 * content.create: on a review-required collection the item enters the flow at once, as a draft with the
 * creator as author. On a review-off collection NOTHING is written (the importer, deck sections and client
 * sites behave exactly as before); the first review command touches such an item instead.
 */
export async function onItemCreated(
  client: PoolClient,
  a: { tenantId: string; siteId: string; itemId: string; collectionKey: string; actor: string },
): Promise<void> {
  const policy = await loadPolicy(client, a.siteId, a.collectionKey);
  if (!policy.reviewRequired) return;
  await client.query(
    `INSERT INTO editorial_items (content_item_id, tenant_id, site_id, state, author_sub) VALUES ($1, $2, $3, 'draft', $4)
     ON CONFLICT (content_item_id) DO NOTHING`,
    [a.itemId, a.tenantId, a.siteId, a.actor],
  );
  await insertEvent(client, { tenantId: a.tenantId, itemId: a.itemId, version: 1, kind: "review.created", actor: a.actor });
}

/**
 * A new head version was appended (content.update / restoreVersion): in_review follows the new head, approved
 * returns to draft (design 4.1). Only an item that already has a review row is touched, so review-off items,
 * and items the flow never saw, are unaffected. The content item row is already locked by the caller.
 */
export async function onVersionAppended(
  client: PoolClient,
  a: { tenantId: string; itemId: string; version: number; actor: string },
): Promise<void> {
  const { rows } = await client.query<{ state: ReviewState }>(
    `SELECT state FROM editorial_items WHERE content_item_id = $1 FOR UPDATE`,
    [a.itemId],
  );
  if (!rows[0]) return;
  const next = stateAfterNewVersion(rows[0].state);
  if (!next.event) return;
  await client.query(
    `UPDATE editorial_items
        SET state = $2,
            submitted_version = CASE WHEN $3::boolean THEN $4::integer ELSE submitted_version END,
            updated_at = now()
      WHERE content_item_id = $1`,
    [a.itemId, next.state, next.followHead, a.version],
  );
  await insertEvent(client, { tenantId: a.tenantId, itemId: a.itemId, version: a.version, kind: next.event, actor: a.actor });
}
