// SCP-2 — what the client sees of a pipeline post in the portal (FRONTEND-BFF-CONTRACT §63.9): `PortalSocialPost`, the lists
// behind the approval page's tabs, the stories circle, the one post, and the visibility rule every portal route shares.
//
// THE RULE (`portalPostVisibleSql`). A post is visible to a portal contact when it is a pipeline post of one of the caller's
// clients (the scope is by client, as `postReviewInPortalScope`: a post belongs to a client, not a project), not deleted, not
// archived, and has reached the client at least once (`client_first_sent_at`). Anything else is "not found", never "not yours":
// the portal answers 404 for a post outside it, so it is no oracle for another client's posts or for a post still in production.
//
// WHAT THE CLIENT NEVER SEES. This file selects its own columns and never calls `buildPipelinePost` (the staff read). The
// answer has no internal status, holder, change note, check, copy log, suggestion, skipped check, creative state, task or
// officer: only the content, the date, the placement, the decision and the comments the team wrote FOR the client
// (`clientVisibleComments`, the one reader of the thread the portal uses). A staff-recorded decision shows the channel and the
// note, never the name of the member of staff who recorded it.
//
// Every read declares the social module scope (the posts, variants, designs and engagements are third-walled).
import type { PoolClient } from "pg";
import { config } from "../../../config";
import { todayIsoInTz } from "../../reports/person-scope";
import { declareSocialModuleScope } from "../module-scope";
import { clientVisibleComments } from "./post-comments";
import { reviewHashOf } from "./pipeline-data";
import { ScpRouteError } from "./pipeline-effects";
import { portalPostRowVisibleSql } from "./portal-post-sql";

export type PortalState = "to_review" | "changes_asked" | "approved" | "scheduled" | "live";

export interface PortalSocialPost {
  id: string;
  clientId: string;
  clientName: string;
  month: string;
  title: string;
  format: string | null;
  plannedAt: string | null;
  placement: string[];
  state: PortalState;
  caption: string;
  onAssetText: string | null;
  cta: string | null;
  hashtags: string[];
  images: Array<{ fileId: string; thumbFileId: string; position: number; alt: string }>;
  variants: Array<{
    id: string; network: string; handle: string; surface: "feed" | "carousel" | "reel" | "story";
    body: string; firstComment: string | null; scheduledAt: string | null;
  }>;
  reviewHash: string | null;
  decision: {
    decisionId: string; kind: "approved" | "changes"; changeKind?: string; note?: string; anchor?: { x: number; y: number; fileId?: string };
    decidedAt: string; decidedBy: { name: string } | null; recorded: boolean; channel?: string; undoUntil?: string;
  } | null;
  comments?: Array<{ id: string; body: string; author: { name: string }; anchor?: { x: number; y: number; fileId: string }; createdAt: string }>;
  liveUrl: string | null;
  simulated: boolean;
}

/** The state the client sees for a post's pipeline status: `client` waits on them, `approved`, `scheduled` and `live` are as they
 *  are, and every other status of a visible post (it reached the client before and is back with the team) is `changes_asked`. */
export function portalStateOf(status: string | null): PortalState {
  switch (status) {
    case "client": return "to_review";
    case "approved": return "approved";
    case "scheduled": return "scheduled";
    case "live": return "live";
    default: return "changes_asked";
  }
}

/**
 * The visibility predicate on a post `p` (social_posts) and its engagement `e` (social_engagements), with the caller's client
 * ids bound at `$clientsParam`. The one definition: the lists, the decisions, the undo and the portal file route all use it.
 */
export function portalPostVisibleSql(p: string, e: string, clientsParam: number): string {
  return `${portalPostRowVisibleSql(p)}
    AND ${e}.client_id = ANY($${clientsParam}::uuid[]) AND ${e}.deleted_at IS NULL`;
}

/** PURE, for a row already read: the same rule as `portalPostVisibleSql`, for the runner that holds the post locked. */
export function postVisibleTo(
  row: { deleted_at: Date | string | null; archived_at: Date | string | null; pipeline_status: string | null; client_first_sent_at: Date | string | null },
  clientId: string, clientIds: readonly string[],
): boolean {
  return row.deleted_at === null && row.archived_at === null && row.pipeline_status !== null && row.client_first_sent_at !== null
    && clientIds.includes(clientId);
}

/** Whether `fileId` is a file the caller may download as a pipeline post's image: named by a live design row of the post
 *  (`social_post_designs.file_id`, or its stored thumbnail `thumb_file_id`, SCP-2b; `removed_at` NULL), and the post visible
 *  to the caller. `postId` is the file's own
 *  `target_entity_id`. The caller's client holds the module scope on `c` (declared here). */
export async function portalImageVisible(c: PoolClient, tenantId: string, clientIds: string[], postId: string, fileId: string): Promise<boolean> {
  await declareSocialModuleScope(c);
  const r = await c.query(
    `SELECT 1
       FROM social_post_designs d
       JOIN social_posts p ON p.tenant_id = d.tenant_id AND p.id = d.post_id
       JOIN social_engagements e ON e.tenant_id = p.tenant_id AND e.id = p.engagement_id
      WHERE d.tenant_id = $1 AND d.post_id = $2 AND (d.file_id = $3::uuid OR d.thumb_file_id = $3::uuid) AND d.removed_at IS NULL AND ${portalPostVisibleSql("p", "e", 4)}
      LIMIT 1`,
    [tenantId, postId, fileId, clientIds],
  );
  return r.rows.length > 0;
}

// ── paging ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A timestamptz as Postgres prints it (`2027-03-10 10:00:00.5+00`), or `infinity`: the only text a cursor may carry into a cast. */
const SORT_KEY_RE = /^(-?infinity|\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}(:\d{2})?)?)$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const PORTAL_PAGE_DEFAULT = 30;
export const PORTAL_PAGE_MAX = 100;

const bad = (field: string) => new ScpRouteError(400, "invalid_field", { field });

/** `[sortKey (text, 'infinity' for none), id]`, base64url JSON: opaque to the caller. */
function encodeCursor(sk: string, id: string): string {
  return Buffer.from(JSON.stringify([sk, id]), "utf8").toString("base64url");
}
function decodeCursor(raw: string): [string, string] | null {
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== "string" || typeof v[1] !== "string" || !UUID_RE.test(v[1])) return null;
    if (!SORT_KEY_RE.test(v[0])) return null;
    return [v[0], v[1]];
  } catch {
    return null;
  }
}

export interface ListQuery {
  tab: "to_review" | "approved" | "grid";
  clientId?: string;
  month?: string;
  cursor?: string;
  limit?: string;
}

const single = (v: unknown): string | undefined => (Array.isArray(v) ? (typeof v[0] === "string" ? v[0] : undefined) : typeof v === "string" ? v : undefined);

/** The query string, validated: `tab` (default `to_review`), `clientId` (uuid), `month` (YYYY-MM), `cursor`, `limit` (1 to 100). */
export function parseListQuery(q: Record<string, unknown>): ListQuery & { limitN: number; cursorKey: [string, string] | null } {
  const tab = single(q.tab) ?? "to_review";
  if (tab !== "to_review" && tab !== "approved" && tab !== "grid") throw bad("tab");
  const clientId = single(q.clientId);
  if (clientId !== undefined && clientId !== "" && !UUID_RE.test(clientId)) throw bad("clientId");
  const month = single(q.month);
  if (month !== undefined && month !== "" && !MONTH_RE.test(month)) throw bad("month");
  const limitRaw = single(q.limit);
  let limitN = PORTAL_PAGE_DEFAULT;
  if (limitRaw !== undefined && limitRaw !== "") {
    limitN = Number(limitRaw);
    if (!Number.isInteger(limitN) || limitN < 1 || limitN > PORTAL_PAGE_MAX) throw bad("limit");
  }
  const cursor = single(q.cursor);
  const cursorKey = cursor !== undefined && cursor !== "" ? decodeCursor(cursor) : null;
  if (cursor !== undefined && cursor !== "" && cursorKey === null) throw bad("cursor");
  return { tab, clientId: clientId || undefined, month: month || undefined, cursor, limit: limitRaw, limitN, cursorKey };
}

// ── the rows ───────────────────────────────────────────────────────────────────────────────────────────────────────

interface PostRowP {
  id: string; client_id: string; client_name: string; month: string; title: string; format: string | null;
  scheduled_at: Date | null; placement: string[]; pipeline_status: string; caption: string | null; on_asset_text: string | null;
  cta: string | null; hashtags: string[] | null; live_url: string | null; simulated: boolean; sk: string;
}

/** The company's month for a post that has no cycle: its date (or creation) in the report time zone. */
const tz = () => config.reportsTz || "UTC";

/** The select list and joins shared by every read of posts. `$1` is the tenant, `$2` the caller's clients, `$3` the zone. */
const POST_SELECT = `
  SELECT p.id::text AS id, e.client_id::text AS client_id, cl.name AS client_name,
         COALESCE(to_char(cy.month, 'YYYY-MM'), to_char(p.scheduled_at AT TIME ZONE $3::text, 'YYYY-MM'), to_char(p.created_at AT TIME ZONE $3::text, 'YYYY-MM')) AS month,
         p.title, p.format, p.scheduled_at, p.placement, p.pipeline_status, p.caption, p.on_asset_text, p.cta, p.hashtags,
         p.live_url, p.simulated`;
/** A post's month as the portal files it: its cycle's month, else its date's (or its creation's) in the report zone (`$3`). */
const MONTH_OF_POST = `COALESCE(to_char(cy.month, 'YYYY-MM'), to_char(p.scheduled_at AT TIME ZONE $3::text, 'YYYY-MM'), to_char(p.created_at AT TIME ZONE $3::text, 'YYYY-MM'))`;

const POST_FROM = `
    FROM social_posts p
    JOIN social_engagements e ON e.tenant_id = p.tenant_id AND e.id = p.engagement_id
    JOIN clients cl ON cl.id = e.client_id AND cl.tenant_id = p.tenant_id
    LEFT JOIN social_cycles cy ON cy.tenant_id = p.tenant_id AND cy.id = p.cycle_id AND cy.deleted_at IS NULL`;

function surfaceOf(format: string | null, settings: Record<string, unknown> | null): "feed" | "carousel" | "reel" | "story" {
  const ig = typeof settings?.igType === "string" ? settings.igType : null;
  if (ig === "reel" || format === "reel") return "reel";
  if (ig === "story" || format === "story") return "story";
  if (format === "carousel") return "carousel";
  return "feed";
}

const iso = (v: Date | string | null | undefined) => (v === null || v === undefined ? null : new Date(v).toISOString());

/** Shape rows into `PortalSocialPost`s: the live variants, the stored designs and the latest decision of every post in one
 *  query each. `withComments` adds the client-visible thread (the one-post read). */
async function shape(c: PoolClient, tenantId: string, rows: PostRowP[], withComments: boolean): Promise<PortalSocialPost[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const variants = await c.query<{ id: string; post_id: string; network: string; handle: string; body: string; first_comment: string | null; scheduled_at: Date | null; settings: Record<string, unknown>; args_sha256: string | null }>(
    `SELECT v.id::text AS id, v.post_id::text AS post_id, a.network, a.handle, v.body, v.first_comment, v.scheduled_at, v.settings, v.args_sha256
       FROM social_post_variants v JOIN social_accounts a ON a.id = v.account_id AND a.tenant_id = v.tenant_id
      WHERE v.tenant_id = $1 AND v.post_id = ANY($2::uuid[]) AND v.deleted_at IS NULL
      ORDER BY a.network, v.id`,
    [tenantId, ids],
  );
  const designs = await c.query<{ post_id: string; file_id: string; thumb_file_id: string; position: number }>(
    `SELECT d.post_id::text AS post_id, d.file_id::text AS file_id, COALESCE(d.thumb_file_id, d.file_id)::text AS thumb_file_id, d.position
       FROM social_post_designs d
      WHERE d.tenant_id = $1 AND d.post_id = ANY($2::uuid[]) AND d.removed_at IS NULL AND d.file_id IS NOT NULL
      ORDER BY d.position, d.added_at`,
    [tenantId, ids],
  );
  // The latest decision of each post: the newest decided review that carries a decision id. Its decider is the contact (a
  // name), or nobody (staff recorded it: the channel stands in, never the staff member).
  const decisions = await c.query<{
    post_id: string; decision_id: string; status: string; change_kind: string | null; comment: string | null; anchor: { x: number; y: number; fileId?: string } | null;
    decided_at: Date; decided_by_name: string | null; recorded_by: string | null; channel: string | null; undo_live: boolean; undo_until: Date | null;
  }>(
    `SELECT DISTINCT ON (v.post_id) v.post_id::text AS post_id, r.decision_id::text AS decision_id, r.status, r.change_kind, r.comment, r.anchor,
            r.decided_at, u.name AS decided_by_name, r.recorded_by::text AS recorded_by, r.channel,
            (r.undo_until IS NOT NULL AND r.undo_until > clock_timestamp()) AS undo_live, r.undo_until
       FROM social_post_client_reviews r
       JOIN social_post_variants v ON v.id = r.variant_id AND v.tenant_id = r.tenant_id AND v.deleted_at IS NULL
       LEFT JOIN users u ON u.id = r.decided_by
      WHERE r.tenant_id = $1 AND v.post_id = ANY($2::uuid[]) AND r.decision_id IS NOT NULL AND r.status IN ('approved', 'changes_requested')
      ORDER BY v.post_id, r.decided_at DESC, r.id`,
    [tenantId, ids],
  );
  const byPost = <T extends { post_id: string }>(list: T[]) => {
    const m = new Map<string, T[]>();
    for (const x of list) (m.get(x.post_id) ?? m.set(x.post_id, []).get(x.post_id)!).push(x);
    return m;
  };
  const vBy = byPost(variants.rows);
  const dBy = byPost(designs.rows);
  const decBy = new Map(decisions.rows.map((d) => [d.post_id, d]));

  const out: PortalSocialPost[] = [];
  for (const r of rows) {
    const vs = vBy.get(r.id) ?? [];
    const dec = decBy.get(r.id);
    const recorded = dec ? dec.recorded_by !== null : false;
    const post: PortalSocialPost = {
      id: r.id, clientId: r.client_id, clientName: r.client_name, month: r.month, title: r.title, format: r.format,
      plannedAt: iso(r.scheduled_at), placement: r.placement ?? [], state: portalStateOf(r.pipeline_status),
      caption: r.caption ?? "", onAssetText: r.on_asset_text, cta: r.cta, hashtags: r.hashtags ?? [],
      // The stored thumbnail (SCP-2b), or the image itself until one is made (or for a design that keeps none, a video).
      images: (dBy.get(r.id) ?? []).map((d, i, all) => ({
        fileId: d.file_id, thumbFileId: d.thumb_file_id, position: d.position, alt: all.length > 1 ? `${r.title}, image ${i + 1} of ${all.length}` : r.title,
      })),
      variants: vs.map((v) => ({
        id: v.id, network: v.network, handle: v.handle, surface: surfaceOf(r.format, v.settings), body: v.body,
        firstComment: v.first_comment, scheduledAt: iso(v.scheduled_at),
      })),
      reviewHash: reviewHashOf(vs.map((v) => ({ id: v.id, args_sha256: v.args_sha256 }))),
      decision: dec
        ? {
            decisionId: dec.decision_id, kind: dec.status === "approved" ? "approved" : "changes",
            ...(dec.change_kind ? { changeKind: dec.change_kind } : {}),
            ...(dec.comment ? { note: dec.comment } : {}),
            ...(dec.anchor ? { anchor: dec.anchor } : {}),
            decidedAt: new Date(dec.decided_at).toISOString(),
            decidedBy: recorded ? null : { name: dec.decided_by_name ?? "A contact" },
            recorded,
            ...(recorded && dec.channel ? { channel: dec.channel } : {}),
            // The window is offered only while it is open: the server, not the client's clock, says when it has closed.
            ...(!recorded && dec.undo_live && dec.undo_until ? { undoUntil: new Date(dec.undo_until).toISOString() } : {}),
          }
        : null,
      liveUrl: r.pipeline_status === "live" ? r.live_url : null,
      simulated: r.simulated === true,
    };
    if (withComments) {
      const cs = await clientVisibleComments(c, tenantId, r.id);
      post.comments = cs.map((x) => ({
        id: x.id, body: x.body, author: { name: x.authorName ?? "Our team" },
        ...(x.anchor ? { anchor: x.anchor } : {}), createdAt: x.createdAt,
      }));
    }
    out.push(post);
  }
  return out;
}

/** The scope's clients narrowed by `clientId`: a client the caller is not a contact of narrows to nothing, so the answer reads as
 *  if that client had no posts (the portal never says whether another client's posts exist). */
function narrow(clientIds: string[], clientId: string | undefined): string[] {
  return clientId === undefined ? clientIds : clientIds.filter((id) => id === clientId);
}

export interface PortalListResult {
  items: PortalSocialPost[];
  nextCursor: string | null;
  counts: { toReview: number; approved: number; changesAsked: number };
}

/** `GET posts`: one tab of the approval page. The caller holds `c` from `withTenants([tenantId])` and has resolved the scope. */
export async function listPortalPosts(
  c: PoolClient, tenantId: string, clientIds: string[], q: ReturnType<typeof parseListQuery>,
): Promise<PortalListResult> {
  await declareSocialModuleScope(c);
  const clients = narrow(clientIds, q.clientId);
  const zone = tz();

  // The month (SCP-2a, "the month's approval page"; ruled at SCP-2's train): a chosen month narrows every tab and the counts. With
  // none, To review and Approved show every month (a post waiting on the client is often next month's) and the grid shows the
  // current month in the report zone.
  const month = q.tab === "grid" ? (q.month ?? todayIsoInTz(zone).slice(0, 7)) : q.month;
  const countRows = await c.query<{ pipeline_status: string; n: string }>(
    `SELECT p.pipeline_status, count(*)::text AS n
       FROM social_posts p JOIN social_engagements e ON e.tenant_id = p.tenant_id AND e.id = p.engagement_id
       LEFT JOIN social_cycles cy ON cy.tenant_id = p.tenant_id AND cy.id = p.cycle_id AND cy.deleted_at IS NULL
      WHERE p.tenant_id = $1 AND ${portalPostVisibleSql("p", "e", 2)} ${q.month ? `AND ${MONTH_OF_POST} = $4` : ""}
      GROUP BY p.pipeline_status`,
    q.month ? [tenantId, clients, zone, q.month] : [tenantId, clients],
  );
  const counts = { toReview: 0, approved: 0, changesAsked: 0 };
  for (const r of countRows.rows) {
    const s = portalStateOf(r.pipeline_status);
    if (s === "to_review") counts.toReview += Number(r.n);
    else if (s === "changes_asked") counts.changesAsked += Number(r.n);
    else counts.approved += Number(r.n);
  }

  // The tab: which posts, in which order. `sk` is the sort key as text so 'infinity' (no date) pages like any other.
  let where = "";
  let sk = "";
  let desc = false;
  const extra: unknown[] = [];
  if (q.tab === "to_review") {
    where = `AND p.pipeline_status = 'client'`;
    sk = `COALESCE(p.scheduled_at, 'infinity'::timestamptz)`;
  } else if (q.tab === "approved") {
    where = `AND p.pipeline_status IN ('approved', 'scheduled', 'live')`;
    sk = `COALESCE(p.status_since, p.updated_at)`;
    desc = true;
  } else {
    // The grid preview: every visible post of the month, newest first, as the account's own feed shows them.
    sk = `COALESCE(p.went_live_at, p.scheduled_at, '-infinity'::timestamptz)`;
    desc = true;
  }
  if (month) {
    extra.push(month);
    where += ` AND ${MONTH_OF_POST} = $4`;
  }
  const params: unknown[] = [tenantId, clients, zone, ...extra];
  let keyset = "";
  if (q.cursorKey) {
    params.push(q.cursorKey[0], q.cursorKey[1]);
    keyset = `AND (${sk}, p.id) ${desc ? "<" : ">"} ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  params.push(q.limitN + 1);
  const rows = await c.query<PostRowP>(
    `${POST_SELECT}, (${sk})::text AS sk ${POST_FROM}
      WHERE p.tenant_id = $1 AND ${portalPostVisibleSql("p", "e", 2)} ${where} ${keyset}
      ORDER BY ${sk} ${desc ? "DESC" : "ASC"}, p.id ${desc ? "DESC" : "ASC"}
      LIMIT $${params.length}`,
    params,
  );
  const page = rows.rows.slice(0, q.limitN);
  const last = page[page.length - 1];
  const nextCursor = rows.rows.length > q.limitN && last ? encodeCursor(last.sk, last.id) : null;
  return { items: await shape(c, tenantId, page, false), nextCursor, counts };
}

/** `GET stories`: the story-format posts waiting on the client, then the recently live ones (the last 30 days), newest first. */
export async function listPortalStories(c: PoolClient, tenantId: string, clientIds: string[], clientId: string | undefined): Promise<{ items: PortalSocialPost[] }> {
  await declareSocialModuleScope(c);
  const rows = await c.query<PostRowP>(
    `${POST_SELECT}, '' AS sk ${POST_FROM}
      WHERE p.tenant_id = $1 AND ${portalPostVisibleSql("p", "e", 2)} AND p.format = 'story'
        AND (p.pipeline_status = 'client' OR (p.pipeline_status = 'live' AND COALESCE(p.went_live_at, p.status_since) > now() - interval '30 days'))
      ORDER BY (p.pipeline_status = 'client') DESC, COALESCE(p.went_live_at, p.scheduled_at, p.updated_at) DESC, p.id
      LIMIT 50`,
    [tenantId, narrow(clientIds, clientId), tz()],
  );
  return { items: await shape(c, tenantId, rows.rows, false) };
}

/** `GET posts/:postId`: one visible post with its client-visible comments, or null (404 at the route). */
export async function readPortalPost(c: PoolClient, tenantId: string, clientIds: string[], postId: string): Promise<PortalSocialPost | null> {
  if (!UUID_RE.test(postId)) return null;
  await declareSocialModuleScope(c);
  const rows = await c.query<PostRowP>(
    `${POST_SELECT}, '' AS sk ${POST_FROM}
      WHERE p.tenant_id = $1 AND p.id = $4 AND ${portalPostVisibleSql("p", "e", 2)}`,
    [tenantId, clientIds, tz(), postId],
  );
  return (await shape(c, tenantId, rows.rows, true))[0] ?? null;
}
