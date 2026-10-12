// M5-W5 — `GET …/editorial/calendar`: the writers' room calendar and workflow board, one read (docs/plans/2026-10-11-m5-writers-room-design.md
// §5 W5; FRONTEND-BFF-CONTRACT §27 "Writers' room calendar"). Routes are in `webdesk-calendar.controller.ts`; the MCP tool is
// `webdesk.editorial.calendar`. The pure rules (query, placement, window, join) are in `webdesk-calendar.ts`.
//
// WHAT IT JOINS. (1) WebDesk's `editorial.board` (every page, up to MAX_BOARD_PAGES): state, author, due and planned dates, submitted
// and approved versions, open comments, brief reference. (2) WebDesk's `item.list state=scheduled` for each collection: the items that
// have a `publish_at`, including those of review-off collections the board never lists. (3) the site's PENDING WS4 publish/schedule
// approvals (`automation_approvals`, origin webdesk): the requested publish time and whether the caller filed it. (4) the W4 briefs
// (`search_content_briefs`) the rows point at.
//
// THE ORDER (the two-phase gate of webdesk-content.service.ts, as W2d's board): the controller's `authorizeSite` (phase 1) -> the
// cross-company wall -> the query is validated -> WebDesk is read -> Cerbos filters the rows -> only the rows the caller may read are
// joined to briefs and requests, so nothing about a row the caller may not read leaves.
//   * a COMPANY-LEVEL reader (a staff tier: `read` on the site) gets every row and WebDesk's per-state `counts`;
//   * a scoped writers' room grant gets only the rows whose (collection, locale) Cerbos lets it read, and `countsWithheld: true`
//     (the counts would disclose the size of what it may not see); none readable is the ordinary 403, never an empty list.
//   * a brief is shown only to someone who could read it through `GET …/briefs` (`assign` on the pair, or `comment` on the item with
//     WebDesk's own facts); otherwise the entry says `briefHidden: true`. A request is shown on a readable item only, and never names its filer.
//
// CERBOS BATCH LIMIT (50 resources per CheckResources request). Every question here is ONE resource per request (`probeAllowed`), asked
// per distinct (collection, locale) pair, or per distinct (collection, locale, author, state, published) tuple for `comment`, with a
// ceiling of PROBE_CONCURRENCY in flight, so no request can exceed the limit however many rows there are. The test sends more than 50
// distinct pairs and proves every one was asked, one resource each.
//
// A FAILED READ IS A 503, NEVER A SHORTER LIST: each upstream read runs under `readPart`; any failure becomes
// `503 {message:"calendar_unavailable", reason:"<part>_unreadable", part}` and nothing assembled so far is returned. A full read that is
// cut by a cap says `truncated: true`.
import { withTenants } from "../../db";
import { authorize } from "../../core/http";
import type { Principal } from "../../rbac/principal";
import {
  ItemGate,
  isPlainObject,
  mapPool,
  probeAllowed,
  webdeskZoneB,
  type ContentGate,
  type SiteRef,
  type WebdeskZoneB,
  type ZoneBResult,
} from "./webdesk-content.service";
import { getBriefsByIds, type BriefRecord } from "./webdesk-brief-store";
import {
  BOARD_PAGE_LIMIT,
  MAX_BOARD_PAGES,
  SCHEDULED_PAGE_LIMIT,
  calendarUnavailable,
  entryOf,
  inCalendar,
  matchesFilters,
  mergeRows,
  parseCalendarQuery,
  parseSourceRow,
  readPart,
  requestsByItem,
  sortEntries,
  type CalendarBrief,
  type CalendarEntry,
  type CalendarQuery,
  type RequestRow,
  type SourceRow,
} from "./webdesk-calendar";

const PROBE_CONCURRENCY = 8;
const SCHEDULED_CONCURRENCY = 4;
/** The most pending requests read for one site (a pending queue longer than this is not a calendar's problem; it says so). */
const REQUESTS_LIMIT = 500;

export interface CalendarDeps {
  zoneB: Pick<WebdeskZoneB, "read">;
  briefsByIds: (tenantId: string, siteId: string, ids: readonly string[]) => Promise<BriefRecord[]>;
  pendingRequests: (tenantId: string, tenantSlug: string, siteId: string) => Promise<RequestRow[]>;
  probe: typeof probeAllowed;
  authorize: typeof authorize;
}

async function pendingRequestRows(tenantId: string, tenantSlug: string, siteId: string): Promise<RequestRow[]> {
  const found = await withTenants([tenantId], (c) =>
    c.query<RequestRow>(
      `SELECT id, created_at, requested_by, workflow_id, tool_args FROM automation_approvals
        WHERE origin = 'webdesk' AND deleted_at IS NULL AND status = 'pending'
          AND workflow_id IN ('content.publish', 'content.schedule')
          AND tool_args->>'tenantSlug' = $1 AND tool_args->>'siteId' = $2
        ORDER BY created_at DESC, id DESC LIMIT ${REQUESTS_LIMIT + 1}`,
      [tenantSlug, siteId],
    ),
  );
  return found.rows;
}

const REAL_DEPS: CalendarDeps = { zoneB: webdeskZoneB, briefsByIds: getBriefsByIds, pendingRequests: pendingRequestRows, probe: probeAllowed, authorize };

const pairKey = (collectionKey: string, locale: string): string => `${collectionKey}\u0000${locale}`;

export class WebdeskCalendarService {
  constructor(private readonly deps: CalendarDeps = REAL_DEPS) {}

  /** WebDesk's board, every page. Counts and policies are the first page's (they are site-wide on every page). */
  private async readBoard(site: SiteRef, q: CalendarQuery) {
    const rows: SourceRow[] = [];
    let counts: Record<string, unknown> | null = null;
    let policies: Array<{ collectionKey: string; reviewRequired: boolean; seoSignoffRequired: boolean }> = [];
    let cursor: string | undefined;
    let truncated = false;
    for (let page = 0; page < MAX_BOARD_PAGES; page++) {
      const res = await this.deps.zoneB.read({
        command: "editorial.board",
        path: "/control/v1/tenants/:tenantSlug/sites/:siteId/editorial/board",
        params: { tenantSlug: site.tenantSlug, siteId: site.siteId },
        query: {
          limit: String(BOARD_PAGE_LIMIT),
          ...(q.collection !== undefined ? { collection: q.collection } : {}),
          ...(q.authorSub !== undefined ? { authorSub: q.authorSub } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
        },
      });
      const body = res.body;
      if (!isPlainObject(body) || !Array.isArray(body.items) || !isPlainObject(body.page)) throw new Error("board answer is not the contract shape");
      for (const it of body.items) {
        const row = parseSourceRow(it, true);
        if (!row) throw new Error("board row is not the contract shape");
        rows.push(row);
      }
      if (page === 0) {
        counts = isPlainObject(body.counts) ? body.counts : null;
        policies = (Array.isArray(body.policies) ? body.policies : []).flatMap((p) =>
          isPlainObject(p) && typeof p.collectionKey === "string"
            ? [{ collectionKey: p.collectionKey, reviewRequired: p.reviewRequired === true, seoSignoffRequired: p.seoSignoffRequired === true }]
            : [],
        );
      }
      const next = typeof body.page.cursor === "string" ? body.page.cursor : null;
      if (body.page.hasMore !== true) return { rows, counts, policies, truncated };
      if (next === null) throw new Error("board says there is another page but gives no cursor");
      cursor = next;
    }
    truncated = true;
    return { rows, counts, policies, truncated };
  }

  /** The scheduled items of every collection (or the asked one): the only place `publish_at` is read from. */
  private async readScheduled(site: SiteRef, q: CalendarQuery) {
    const listed = await this.deps.zoneB.read({
      command: "collection.list",
      path: "/control/v1/tenants/:tenantSlug/sites/:siteId/collections",
      params: { tenantSlug: site.tenantSlug, siteId: site.siteId },
    });
    if (!isPlainObject(listed.body) || !Array.isArray(listed.body.collections)) throw new Error("collection list is not the contract shape");
    const keys = listed.body.collections.flatMap((c) => {
      if (!isPlainObject(c) || typeof c.key !== "string") throw new Error("collection row is not the contract shape");
      return q.collection === undefined || c.key === q.collection ? [c.key] : [];
    });
    const pages = await mapPool(keys, SCHEDULED_CONCURRENCY, async (key): Promise<{ rows: SourceRow[]; more: boolean }> => {
      const res: ZoneBResult = await this.deps.zoneB.read({
        command: "item.list",
        path: "/control/v1/tenants/:tenantSlug/sites/:siteId/collections/:key/items",
        params: { tenantSlug: site.tenantSlug, siteId: site.siteId, key },
        query: { state: "scheduled", limit: String(SCHEDULED_PAGE_LIMIT), ...(q.locale !== undefined ? { locale: q.locale } : {}) },
      });
      if (!isPlainObject(res.body) || !Array.isArray(res.body.items)) throw new Error("item list is not the contract shape");
      const rows = res.body.items.map((it) => {
        const row = parseSourceRow(it, false, key);
        if (!row) throw new Error("item row is not the contract shape");
        return row;
      });
      return { rows, more: isPlainObject(res.body.page) && res.body.page.hasMore === true };
    });
    return { rows: pages.flatMap((p) => p.rows), truncated: pages.some((p) => p.more) };
  }

  /** The set of keys (of `asks`) Cerbos allows. One resource per request; a Cerbos failure is the 503 `authorization_unreadable`. */
  private async allowedKeys<T>(asks: Map<string, T>, ask: (v: T) => Promise<boolean>): Promise<Set<string>> {
    const verdicts = await readPart("authorization", () => mapPool([...asks.entries()], PROBE_CONCURRENCY, async ([k, v]) => ({ k, ok: await ask(v) })));
    return new Set(verdicts.filter((v) => v.ok).map((v) => v.k));
  }

  async calendar(gate: ContentGate, site: SiteRef, rawQuery: unknown): Promise<ZoneBResult> {
    gate.require("webdesk_content_item", "read");
    const editable = await gate.resolveSite(this.deps.zoneB as WebdeskZoneB, site);
    const siteId = editable.site.siteId;
    const q = parseCalendarQuery(rawQuery);
    const principal: Principal = gate.principal;
    const resource = (collectionKey: string, locale: string) => ItemGate.resourceOf(gate, siteId, null, { collectionKey, locale });

    const [board, scheduled] = await Promise.all([
      readPart("board", () => this.readBoard(site, q)),
      readPart("scheduled", () => this.readScheduled(site, q)),
    ]);
    const merged = mergeRows(board.rows, scheduled.rows).filter((r) => matchesFilters(r, q));

    // ── Cerbos filters the rows (the W2d board's rule: a company-level reader keeps all, a scoped grant keeps its pairs) ──
    const siteResource = { kind: "webdesk_content_item", tenantId: gate.tenantId, module: "webdev", siteId } as const;
    const companyLevel = await readPart("authorization", () => this.deps.probe(principal, siteResource, "read"));
    let readable: SourceRow[] = merged;
    if (companyLevel) {
      await this.deps.authorize(principal, siteResource, "read"); // the real check: session (D11), delegation, audit
    } else {
      const pairs = new Map<string, { collectionKey: string; locale: string }>();
      for (const r of merged) pairs.set(pairKey(r.collectionKey, r.locale), { collectionKey: r.collectionKey, locale: r.locale });
      const ok = await this.allowedKeys(pairs, (p) => this.deps.probe(principal, resource(p.collectionKey, p.locale), "read"));
      if (pairs.size > 0 && ok.size === 0) {
        // Nothing readable: the ordinary denial (and its audit row), never an empty calendar for a caller that may read nothing.
        const first = [...pairs.values()][0];
        await this.deps.authorize(principal, resource(first.collectionKey, first.locale), "read");
      }
      readable = merged.filter((r) => ok.has(pairKey(r.collectionKey, r.locale)));
    }
    // A company-level reader is owed WebDesk's counts: an answer without them is a WebDesk that does not match the contract (503), and
    // must not read as "withheld for your access".
    if (companyLevel && !board.counts) throw calendarUnavailable("board", "counts_missing");
    const readableCollections = new Set(readable.map((r) => r.collectionKey));

    // ── pending requests, then the window ──
    const requestRows = readable.length > 0 ? await readPart("requests", () => this.deps.pendingRequests(gate.tenantId, site.tenantSlug, siteId)) : [];
    const requestsTruncated = requestRows.length > REQUESTS_LIMIT;
    const byItem = requestsByItem(requestRows.slice(0, REQUESTS_LIMIT), principal.userId ?? null);
    const win = q.from !== undefined && q.to !== undefined ? { from: q.from, to: q.to } : null;
    const draft = readable
      .map((r) => entryOf(r, byItem.get(r.itemId.toLowerCase()) ?? [], null, false))
      .filter((e) => inCalendar(e, win));

    // ── briefs, for the rows that stay ──
    const ids = [...new Set(draft.flatMap((e) => (e.briefRef ? [e.briefRef.toLowerCase()] : [])))];
    let briefs = new Map<string, BriefRecord>();
    if (ids.length > 0) {
      const found = await readPart("briefs", () => this.deps.briefsByIds(gate.tenantId, siteId, ids));
      briefs = new Map(found.map((b) => [b.id.toLowerCase(), b]));
    }
    const withBrief = draft.filter((e) => e.briefRef && briefs.has(e.briefRef.toLowerCase()));
    const managerPairs = new Map<string, { collectionKey: string; locale: string }>();
    for (const e of withBrief) managerPairs.set(pairKey(e.collectionKey, e.locale), { collectionKey: e.collectionKey, locale: e.locale });
    const manages = await this.allowedKeys(managerPairs, (p) => this.deps.probe(principal, resource(p.collectionKey, p.locale), "assign"));
    // `comment` on the item with WebDesk's facts, once per distinct tuple (a month of one author's items is one question).
    const tuples = new Map<string, CalendarEntry>();
    const tupleOf = (e: CalendarEntry) => JSON.stringify([e.collectionKey, e.locale, e.authorSub ?? "", e.reviewState, e.publishState === "published"]);
    for (const e of withBrief) if (!manages.has(pairKey(e.collectionKey, e.locale))) tuples.set(tupleOf(e), e);
    const mayComment = await this.allowedKeys(tuples, (e) =>
      this.deps.probe(
        principal,
        ItemGate.resourceOf(gate, siteId, e.itemId, { collectionKey: e.collectionKey, locale: e.locale, ownerId: e.authorSub ?? "", reviewState: e.reviewState, published: e.publishState === "published" }),
        "comment",
      ),
    );

    const entries = sortEntries(
      draft.map((e): CalendarEntry => {
        if (!e.briefRef) return e;
        const b = briefs.get(e.briefRef.toLowerCase());
        // A brief row that does not name THIS item is not this item's brief (WebDesk's `briefRef` alone is not trusted for a join).
        if (!b || (b.webdeskItemId ?? "").toLowerCase() !== e.itemId.toLowerCase()) return e;
        const visible = manages.has(pairKey(e.collectionKey, e.locale)) || mayComment.has(tupleOf(e));
        const brief: CalendarBrief | null = visible ? { id: b.id, topic: b.topic, status: b.status, assigneeId: b.assigneeId } : null;
        return { ...e, brief, briefHidden: !visible };
      }),
    );

    return {
      status: 200,
      body: {
        tenantSlug: site.tenantSlug,
        siteId,
        from: q.from ?? null,
        to: q.to ?? null,
        // True when a cap cut a read (board pages, scheduled page per collection, pending requests): the list may be missing rows, and says so.
        truncated: board.truncated || scheduled.truncated || requestsTruncated,
        entries,
        policies: board.policies.filter((p) => companyLevel || readableCollections.has(p.collectionKey)),
        ...(companyLevel && board.counts ? { counts: board.counts } : { countsWithheld: true }),
      },
    };
  }
}

export const webdeskCalendar = new WebdeskCalendarService();
