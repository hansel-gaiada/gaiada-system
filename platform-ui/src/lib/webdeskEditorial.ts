import "server-only";
// M5-W2e — the readers and the wire validation for the writers' room (server-only half; the types and copy are in
// `webdeskEditorialModel.ts`, the writes in `webdeskEditorialActions.ts`). Same rules as `webdeskContent.ts`, whose `wire` / `wdCall`
// / `siteBase` this reuses: EVERY 2xx body is validated before it is returned, a body that does not match is `contract_drift` (never
// rendered as data), and no path turns a refusal into an empty list.
//
//   GET …/items/:itemId/editorial        -> {itemId, collectionKey, headVersion, deleted, editorial, seoSnapshot, events[], eventsTruncated,
//                                            comments[], commentsTruncated}                                           (M5-W2d)
//   GET …/editorial/board[?state&collection&authorSub&dueBefore&cursor&limit] -> {items[], counts?, countsWithheld?, policies[], page}
//                                            `counts` is OMITTED and `countsWithheld: true` for a caller whose read is scoped (M5-W2d)
//   GET …/editorial/grants               -> {tenantSlug, siteId, grants[]}                                            (M5-W1b, publisher tier)
import { getItem, parseEditorial, siteBase, wdCall, wire, WireDrift } from "./webdeskContent";
import type { ItemDetail, Page, WdResult } from "./webdeskContentModel";
import {
  isReviewState, REVIEW_STATES,
  type BoardItem, type BoardPolicy, type EditorialBoard, type EditorialComment, type EditorialEvent, type EditorialGrant, type EditorialHistory,
  type EditorialInitial, type EditorialState, type GrantsBody, type ReviewState,
} from "./webdeskEditorialModel";

const { str, int, bool, nullable, arr, obj, key, opt } = wire;
const strN = nullable(str);
const enc = encodeURIComponent;

function parsePage(v: unknown, path: string): Page {
  const o = obj(v, path);
  return { cursor: key(o, "cursor", strN, path), hasMore: key(o, "hasMore", bool, path), limit: key(o, "limit", int, path) };
}

function parseEvent(v: unknown, path: string): EditorialEvent {
  const o = obj(v, path);
  return {
    id: key(o, "id", str, path), version: key(o, "version", nullable(int), path), kind: key(o, "kind", str, path),
    actorSub: key(o, "actorSub", str, path), note: key(o, "note", strN, path), createdAt: key(o, "createdAt", str, path),
  };
}

function parseComment(v: unknown, path: string): EditorialComment {
  const o = obj(v, path);
  return {
    id: key(o, "id", str, path), version: key(o, "version", int, path), anchor: key(o, "anchor", strN, path), body: key(o, "body", str, path),
    authorSub: key(o, "authorSub", str, path), createdAt: key(o, "createdAt", str, path),
    resolvedAt: key(o, "resolvedAt", strN, path), resolvedBy: key(o, "resolvedBy", strN, path),
  };
}

export function parseEditorialHistory(v: unknown): EditorialHistory {
  const o = obj(v, "editorial.history");
  const p = "editorial.history";
  return {
    itemId: key(o, "itemId", str, p), collectionKey: key(o, "collectionKey", str, p), headVersion: key(o, "headVersion", int, p),
    deleted: key(o, "deleted", bool, p),
    editorial: key(o, "editorial", parseEditorial, p),
    events: key(o, "events", arr(parseEvent), p), eventsTruncated: key(o, "eventsTruncated", bool, p),
    comments: key(o, "comments", arr(parseComment), p), commentsTruncated: key(o, "commentsTruncated", bool, p),
  };
}

function parseBoardItem(v: unknown, path: string): BoardItem {
  const o = obj(v, path);
  return {
    itemId: key(o, "itemId", str, path), collectionKey: key(o, "collectionKey", str, path), locale: key(o, "locale", str, path),
    slug: key(o, "slug", str, path), title: key(o, "title", strN, path), headVersion: key(o, "headVersion", int, path),
    publishState: key(o, "publishState", str, path), editorial: key(o, "editorial", parseEditorial, path),
  };
}

function parseBoardPolicy(v: unknown, path: string): BoardPolicy {
  const o = obj(v, path);
  return { collectionKey: key(o, "collectionKey", str, path), reviewRequired: key(o, "reviewRequired", bool, path), seoSignoffRequired: key(o, "seoSignoffRequired", bool, path) };
}

/** `counts` and `countsWithheld` are two halves of ONE fact: a body with neither, or with both, is drift. Withheld counts are `null`, never `{0,0,0,0}`. */
export function parseEditorialBoard(v: unknown): EditorialBoard {
  const o = obj(v, "board");
  const withheld = opt(o, "countsWithheld", bool, "board") === true;
  let counts: Record<ReviewState, number> | null = null;
  if (withheld) {
    // Withheld means "left out": a body that carries counts anyway contradicts itself, so it is drift, not a number to show.
    if ("counts" in o && o.counts !== undefined) throw new WireDrift("board.counts", "absent (countsWithheld is true)", o.counts);
  } else {
    const c = obj(key(o, "counts", obj, "board"), "board.counts");
    counts = { draft: 0, in_review: 0, changes_requested: 0, approved: 0 };
    for (const s of REVIEW_STATES) counts[s] = key(c, s, int, "board.counts");
  }
  return {
    items: key(o, "items", arr(parseBoardItem), "board"),
    counts, countsWithheld: withheld,
    policies: key(o, "policies", arr(parseBoardPolicy), "board"),
    page: key(o, "page", parsePage, "board"),
  };
}

function parseGrant(v: unknown, path: string): EditorialGrant {
  const o = obj(v, path);
  return {
    grantId: key(o, "grantId", str, path), userId: key(o, "userId", str, path), name: key(o, "name", strN, path), email: key(o, "email", strN, path),
    role: key(o, "role", str, path), tenantSlug: key(o, "tenantSlug", str, path), siteId: key(o, "siteId", str, path),
    allCollections: key(o, "allCollections", bool, path), collections: key(o, "collections", arr(str), path),
    allLocales: key(o, "allLocales", bool, path), locales: key(o, "locales", arr(str), path),
    expiresAt: key(o, "expiresAt", strN, path), grantedBy: key(o, "grantedBy", strN, path), updatedAt: key(o, "updatedAt", strN, path),
  };
}

export function parseGrants(v: unknown): GrantsBody {
  const o = obj(v, "grants");
  return { tenantSlug: key(o, "tenantSlug", str, "grants"), siteId: key(o, "siteId", str, "grants"), grants: key(o, "grants", arr(parseGrant), "grants") };
}

// ── Readers ──────────────────────────────────────────────────────────────────────────────────────

export function getEditorialHistory(userId: string, company: string, tenantSlug: string, siteId: string, itemId: string): Promise<WdResult<EditorialHistory>> {
  return wdCall(`${siteBase(company, tenantSlug, siteId)}/items/${enc(itemId)}/editorial`, userId, parseEditorialHistory);
}

export interface BoardQuery { state?: string; collection?: string; authorSub?: string; cursor?: string; limit?: number }

export function getEditorialBoard(userId: string, company: string, tenantSlug: string, siteId: string, q: BoardQuery = {}): Promise<WdResult<EditorialBoard>> {
  const p = new URLSearchParams();
  if (q.state && isReviewState(q.state)) p.set("state", q.state);
  if (q.collection) p.set("collection", q.collection);
  if (q.authorSub) p.set("authorSub", q.authorSub);
  if (q.cursor) p.set("cursor", q.cursor);
  p.set("limit", String(Math.min(q.limit ?? 100, 100)));
  return wdCall(`${siteBase(company, tenantSlug, siteId)}/editorial/board?${p.toString()}`, userId, parseEditorialBoard);
}

export function listEditorialGrants(userId: string, company: string, tenantSlug: string, siteId: string): Promise<WdResult<GrantsBody>> {
  return wdCall(`${siteBase(company, tenantSlug, siteId)}/editorial/grants`, userId, parseGrants);
}

/** One sentence for a failed secondary read (the history), so the panel can say why it has no comments to show. */
export function problemWords(r: Exclude<WdResult<unknown>, { kind: "ok" }>): string {
  switch (r.kind) {
    case "forbidden": return "You can't read this item's review history.";
    case "not_found": return "This item's review history no longer exists.";
    case "not_enabled": return "The review history isn't available on this deployment.";
    case "unavailable": return r.code === "contract_drift" ? `WebDesk answered with something unexpected (${r.reason}).` : "The review history couldn't be loaded because WebDesk can't be reached.";
    case "conflict": case "invalid": return r.message;
  }
}

/**
 * Everything the editorial panel needs, from two reads at once: the item head (`editorial`, `allowed`) and its review record.
 * The item read is the primary one: if it fails the whole state fails (the panel keeps what it had). The history is secondary: if
 * ONLY it fails, the state is still ok with `history: null` and the reason, so the actions keep working and the comments say why
 * they are missing, never "no comments".
 */
export async function loadEditorialState(userId: string, company: string, tenantSlug: string, siteId: string, itemId: string): Promise<WdResult<EditorialState>> {
  const [head, hist]: [WdResult<ItemDetail>, WdResult<EditorialHistory>] = await Promise.all([
    getItem(userId, company, tenantSlug, siteId, itemId, "head"),
    getEditorialHistory(userId, company, tenantSlug, siteId, itemId),
  ]);
  if (head.kind !== "ok") return head;
  return {
    kind: "ok",
    data: {
      headVersion: head.data.version.n,
      editorial: head.data.editorial,
      allowed: head.data.allowed,
      history: hist.kind === "ok" ? hist.data : null,
      historyProblem: hist.kind === "ok" ? null : problemWords(hist),
    },
  };
}

/** The page's two reads for the editor: the item head already read (`detail`) plus the review record. A failed history read is a
 *  sentence in `historyProblem`, never an empty history. Absent `editorial` (an older WebDesk) skips the second read. */
export async function loadEditorialInitial(userId: string, company: string, tenantSlug: string, siteId: string, detail: ItemDetail): Promise<EditorialInitial> {
  if (detail.editorial === undefined) return { editorial: undefined, allowed: detail.allowed, history: null, historyProblem: null };
  const hist = await getEditorialHistory(userId, company, tenantSlug, siteId, detail.item.itemId);
  return {
    editorial: detail.editorial, allowed: detail.allowed,
    history: hist.kind === "ok" ? hist.data : null, historyProblem: hist.kind === "ok" ? null : problemWords(hist),
  };
}
