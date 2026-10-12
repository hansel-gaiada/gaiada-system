// M5-W5 — the parts of the editorial calendar that need no services: the pure rules (query, placement, window, join, requests) and the
// service against stubs (Cerbos filtering in single-resource asks over more than 50 pairs, a failing upstream is a 503 naming its part, the
// board's pages, brief visibility). The HTTP + real Cerbos + Postgres behaviour is `webdesk-calendar.test.ts` (the Linux gate).
import { describe, it, expect, vi } from "vitest";
import { ForbiddenException, ServiceUnavailableException } from "@nestjs/common";
import {
  CERBOS_BATCH_MAX, MAX_BOARD_PAGES, calendarUnavailable, chunks, earliestRequested, entryOf, inCalendar, inWindow, matchesFilters, mergeRows,
  parseCalendarQuery, parseSourceRow, placementOf, readPart, requestsByItem, sortEntries, type CalendarRequest, type SourceRow,
} from "./webdesk-calendar";
import { WebdeskCalendarService, type CalendarDeps } from "./webdesk-calendar.service";
import { webdevModule } from "./index";
import type { BriefRecord } from "./webdesk-brief-store";

const SITE = "0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4";
const U1 = "11111111-2222-4333-8444-555555555555";
const U2 = "22222222-2222-4333-8444-555555555555";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const req = (over: Partial<CalendarRequest> = {}): CalendarRequest => ({
  approvalId: "a1", command: "content.schedule", status: "pending", publishAt: "2026-11-05T09:00:00.000Z", unpublishAt: null, createdAt: "2026-10-01T00:00:00.000Z", requestedByMe: false, ...over,
});

function row(n: number, over: Partial<SourceRow> = {}): SourceRow {
  return {
    itemId: id(n), collectionKey: "post", locale: "en", slug: `s${n}`, title: `T${n}`, headVersion: 1, publishState: "draft", publishAt: null, unpublishAt: null,
    editorial: { reviewRequired: true, state: "draft", authorSub: U1, dueAt: null, plannedPublishAt: null, briefRef: null, openComments: 0 }, inFlow: true, ...over,
  };
}
const wire = (r: SourceRow) => ({ itemId: r.itemId, collectionKey: r.collectionKey, locale: r.locale, slug: r.slug, title: r.title, headVersion: r.headVersion, publishState: r.publishState, publishAt: r.publishAt, unpublishAt: r.unpublishAt, editorial: r.editorial });

describe("parseCalendarQuery", () => {
  it("takes a window, filters and nothing else", () => {
    expect(parseCalendarQuery({ from: "2026-10-01", to: "2026-10-31", collection: "post", locale: "en", authorSub: U1.toUpperCase() })).toEqual({ from: "2026-10-01", to: "2026-10-31", collection: "post", locale: "en", authorSub: U1 });
    expect(parseCalendarQuery(undefined)).toEqual({});
  });
  it("from and to come together, are real days, in order, and at most 100 days apart", () => {
    expect(() => parseCalendarQuery({ from: "2026-10-01" })).toThrow(/together/);
    expect(() => parseCalendarQuery({ from: "2026-02-30", to: "2026-03-02" })).toThrow(/real date/);
    expect(() => parseCalendarQuery({ from: "2026-10-05", to: "2026-10-01" })).toThrow(/before/);
    expect(() => parseCalendarQuery({ from: "2026-01-01", to: "2026-04-11" })).toThrow(/at most 100/);
    expect(parseCalendarQuery({ from: "2026-01-01", to: "2026-04-10" }).to).toBe("2026-04-10");
  });
  it("refuses an unknown key and a non-uuid author", () => {
    expect(() => parseCalendarQuery({ siteId: "x" })).toThrow(/unknown query parameter/);
    expect(() => parseCalendarQuery({ authorSub: "me" })).toThrow(/uuid/);
  });
});

describe("placement", () => {
  const base = { publishState: "draft", publishAt: null, plannedPublishAt: null, dueAt: null, requests: [] as CalendarRequest[] };
  it("publish_at beats a request, a request beats planned, planned beats due", () => {
    expect(placementOf({ ...base, publishState: "scheduled", publishAt: "2026-11-01T00:00:00.000Z", requests: [req()], plannedPublishAt: "2026-11-09T00:00:00.000Z", dueAt: "2026-11-10T00:00:00.000Z" })?.kind).toBe("publish_at");
    expect(placementOf({ ...base, requests: [req()], plannedPublishAt: "2026-11-09T00:00:00.000Z" })).toEqual({ kind: "requested_publish", at: "2026-11-05T09:00:00.000Z" });
    expect(placementOf({ ...base, plannedPublishAt: "2026-11-09T00:00:00.000Z", dueAt: "2026-11-10T00:00:00.000Z" })?.kind).toBe("planned");
    expect(placementOf({ ...base, dueAt: "2026-11-10T00:00:00.000Z" })).toEqual({ kind: "due", at: "2026-11-10T00:00:00.000Z" });
    expect(placementOf(base)).toBeNull();
  });
  it("a publish_at on a draft is not a date (only a scheduled or published item has one); a publish request with no time has no date", () => {
    expect(placementOf({ ...base, publishAt: "2026-11-01T00:00:00.000Z" })).toBeNull();
    expect(placementOf({ ...base, requests: [req({ command: "content.publish", publishAt: null })] })).toBeNull();
  });
  it("the earliest requested time wins", () => {
    expect(earliestRequested([req({ publishAt: "2026-12-01T00:00:00.000Z" }), req({ approvalId: "a2", publishAt: "2026-11-02T00:00:00.000Z" })])).toBe("2026-11-02T00:00:00.000Z");
  });
});

describe("the window", () => {
  it("from is inclusive, to is the whole last UTC day", () => {
    expect(inWindow("2026-10-01T00:00:00.000Z", "2026-10-01", "2026-10-31")).toBe(true);
    expect(inWindow("2026-09-30T23:59:59.999Z", "2026-10-01", "2026-10-31")).toBe(false);
    expect(inWindow("2026-10-31T23:59:59.999Z", "2026-10-01", "2026-10-31")).toBe(true);
    expect(inWindow("2026-11-01T00:00:00.000Z", "2026-10-01", "2026-10-31")).toBe(false);
  });
  it("an unplaced item is listed unless it is live; no window lists everything", () => {
    const win = { from: "2026-10-01", to: "2026-10-31" };
    expect(inCalendar({ placement: null, publishState: "draft" }, win)).toBe(true);
    expect(inCalendar({ placement: null, publishState: "published" }, win)).toBe(false);
    expect(inCalendar({ placement: { kind: "due", at: "2026-12-01T00:00:00.000Z" }, publishState: "draft" }, win)).toBe(false);
    expect(inCalendar({ placement: { kind: "due", at: "2026-12-01T00:00:00.000Z" }, publishState: "draft" }, null)).toBe(true);
  });
});

describe("the join", () => {
  it("a scheduled row fills publish_at into the board row and adds items the board never lists", () => {
    const b = row(1, { publishState: "scheduled" });
    const s1 = row(1, { publishState: "scheduled", publishAt: "2026-11-01T00:00:00.000Z", inFlow: false });
    const s2 = row(2, { inFlow: false, publishState: "scheduled", publishAt: "2026-11-02T00:00:00.000Z" });
    const m = mergeRows([b], [s1, s2]);
    expect(m).toHaveLength(2);
    expect(m.find((r) => r.itemId === id(1))).toMatchObject({ inFlow: true, publishAt: "2026-11-01T00:00:00.000Z" });
    expect(m.find((r) => r.itemId === id(2))?.inFlow).toBe(false);
  });
  it("parseSourceRow refuses a row that is not the shape", () => {
    expect(parseSourceRow({ itemId: "x" }, true)).toBeNull();
    expect(parseSourceRow(wire(row(1)), true)?.slug).toBe("s1");
    expect(parseSourceRow({ ...wire(row(1)), collectionKey: undefined }, false, "guide")?.collectionKey).toBe("guide");
  });
  it("requests attach to each item they name; the filer is a flag, never an id; a malformed row is skipped", () => {
    const m = requestsByItem([
      { id: "a1", created_at: "2026-10-02T00:00:00Z", requested_by: U1, workflow_id: "content.schedule", tool_args: { items: [{ itemId: id(1).toUpperCase(), version: 1 }, { itemId: id(2), version: 1 }], publishAt: "2026-11-05T09:00:00Z" } },
      { id: "a2", created_at: "2026-10-01T00:00:00Z", requested_by: U2, workflow_id: "content.publish", tool_args: { items: [{ itemId: id(1), version: 2 }] } },
      { id: "a3", created_at: "2026-10-01T00:00:00Z", requested_by: U2, workflow_id: "content.publish", tool_args: null },
      { id: "a4", created_at: "2026-10-01T00:00:00Z", requested_by: U2, workflow_id: "other", tool_args: { items: [{ itemId: id(3) }] } },
    ], U1);
    expect(m.get(id(1))!.map((r) => r.approvalId)).toEqual(["a2", "a1"]);
    expect(m.get(id(1))!.map((r) => r.requestedByMe)).toEqual([false, true]);
    expect(JSON.stringify([...m.values()])).not.toContain(U2);
    expect(m.has(id(3))).toBe(false);
  });
  it("matchesFilters and sortEntries", () => {
    expect(matchesFilters(row(1), { authorSub: U1 })).toBe(true);
    expect(matchesFilters(row(1), { authorSub: U2 })).toBe(false);
    expect(matchesFilters(row(1), { collection: "guide" })).toBe(false);
    const a = entryOf(row(1, { editorial: { ...row(1).editorial, dueAt: "2026-11-09T00:00:00Z" } }), [], null, false);
    const b = entryOf(row(2, { editorial: { ...row(2).editorial, dueAt: "2026-11-02T00:00:00Z" } }), [], null, false);
    const c = entryOf(row(3), [], null, false);
    expect(sortEntries([c, a, b]).map((e) => e.slug)).toEqual(["s2", "s1", "s3"]);
  });
  it("chunks never exceed the size", () => {
    expect(chunks(Array.from({ length: 120 }, (_, i) => i), CERBOS_BATCH_MAX).map((c) => c.length)).toEqual([50, 50, 20]);
  });
});

describe("readPart", () => {
  it("any failure is the 503 that names the part", async () => {
    await expect(readPart("requests", async () => { throw new Error("db down"); })).rejects.toMatchObject({ response: { message: "calendar_unavailable", reason: "requests_unreadable", part: "requests" } });
    expect(calendarUnavailable("board")).toBeInstanceOf(ServiceUnavailableException);
  });
});

// ── the service against stubs ────────────────────────────────────────────────────────────────────

const gate = (userId = U1) => ({
  require: () => undefined, tenantId: "t1", principal: { userId }, clientAttr: () => ({}),
  resolveSite: async () => ({ site: { siteId: SITE }, tenant: { slug: "gaiada", locales: ["en", "id"] } }),
}) as never;
const SITE_REF = { tenantSlug: "gaiada", siteId: SITE };

interface Stub {
  board?: SourceRow[]; pageSize?: number; scheduled?: Record<string, SourceRow[]>; counts?: unknown;
  requests?: unknown[]; briefs?: Array<Record<string, unknown>>;
  probe?: (resource: { collectionKey?: string; locale?: string; ownerId?: string; kind: string }, action: string) => boolean;
  fail?: "board" | "scheduled" | "requests" | "briefs" | "probe";
  neverMore?: boolean;
}

function make(s: Stub) {
  const calls: Array<{ command: string; query?: Record<string, string> }> = [];
  const boardRows = s.board ?? [];
  const size = s.pageSize ?? 100;
  const zoneB = {
    read: vi.fn(async (r: { command: string; params: Record<string, string>; query?: Record<string, string> }) => {
      calls.push({ command: r.command, query: r.query });
      if (r.command === "editorial.board") {
        if (s.fail === "board") throw new ServiceUnavailableException({ message: "editorial_unavailable", reason: "webdesk_unreachable" });
        const at = r.query?.cursor ? Number(r.query.cursor) : 0;
        const slice = boardRows.slice(at, at + size);
        const more = s.neverMore ? true : at + size < boardRows.length;
        return { status: 200, body: { items: slice.map(wire), counts: s.counts ?? { draft: boardRows.length, in_review: 0, changes_requested: 0, approved: 0 }, policies: [{ collectionKey: "post", reviewRequired: true, seoSignoffRequired: false, updatedBy: null, updatedAt: "x" }], page: { cursor: more ? String(at + size) : null, hasMore: more, limit: size } } };
      }
      if (r.command === "collection.list") return { status: 200, body: { collections: Object.keys(s.scheduled ?? { post: [] }).map((key) => ({ key })) } };
      if (r.command === "item.list") {
        if (s.fail === "scheduled") throw new ServiceUnavailableException({ message: "editorial_unavailable", reason: "circuit_open" });
        const rows = (s.scheduled ?? {})[r.params.key] ?? [];
        return { status: 200, body: { items: rows.map((x) => ({ ...wire(x), collectionKey: undefined })), page: { cursor: null, hasMore: false, limit: 100 } } };
      }
      throw new Error(`unexpected ${r.command}`);
    }),
  };
  let inflight = 0;
  let maxInflight = 0;
  const probeCalls: Array<{ resource: Record<string, unknown>; action: string }> = [];
  const deps: CalendarDeps = {
    zoneB: zoneB as never,
    pendingRequests: vi.fn(async () => { if (s.fail === "requests") throw new Error("db"); return (s.requests ?? []) as never; }),
    briefsByIds: vi.fn(async () => { if (s.fail === "briefs") throw new Error("db"); return (s.briefs ?? []) as unknown as BriefRecord[]; }),
    probe: vi.fn(async (_p, resource, action) => {
      probeCalls.push({ resource: resource as never, action });
      inflight++; maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 0));
      inflight--;
      if (s.fail === "probe") throw new Error("cerbos 500");
      return (s.probe ?? (() => true))(resource as never, action);
    }) as never,
    authorize: vi.fn(async () => undefined) as never,
  };
  return { svc: new WebdeskCalendarService(deps), deps, calls, probeCalls, maxInflight: () => maxInflight };
}

const siteLevel = (r: { collectionKey?: string }) => r.collectionKey === undefined;
const body = async (m: ReturnType<typeof make>, q: unknown = {}) => (await m.svc.calendar(gate(), SITE_REF, q)).body as Record<string, any>;

describe("the service: Cerbos filtering", () => {
  it("a company-level reader gets every row, WebDesk's counts, and one site question", async () => {
    const m = make({ board: [row(1), row(2, { collectionKey: "guide" })], probe: (r) => siteLevel(r) });
    const b = await body(m);
    expect(b.entries).toHaveLength(2);
    expect(b.counts).toBeDefined();
    expect(b.countsWithheld).toBeUndefined();
    expect(m.probeCalls).toHaveLength(1);
    expect(m.deps.authorize).toHaveBeenCalledTimes(1);
  });

  it("a scoped caller gets its pairs only, no counts, and countsWithheld", async () => {
    const m = make({ board: [row(1), row(2, { collectionKey: "guide" })], probe: (r) => !siteLevel(r) && r.collectionKey === "post" });
    const b = await body(m);
    expect(b.entries.map((e: { collectionKey: string }) => e.collectionKey)).toEqual(["post"]);
    expect(b.counts).toBeUndefined();
    expect(b.countsWithheld).toBe(true);
    expect(b.policies).toHaveLength(1);
  });

  it("more than 50 distinct pairs: every pair is asked, ONE resource per request, never more than 8 in flight", async () => {
    const rows = Array.from({ length: 130 }, (_, i) => row(i + 1, { collectionKey: `c${i}` }));
    const m = make({ board: rows, probe: (r) => !siteLevel(r) && Number(String(r.collectionKey).slice(1)) % 2 === 0 });
    const b = await body(m);
    const pairAsks = m.probeCalls.filter((c) => c.action === "read" && c.resource.collectionKey !== undefined);
    expect(pairAsks).toHaveLength(130);
    expect(new Set(pairAsks.map((c) => c.resource.collectionKey)).size).toBe(130);
    expect(Array.isArray(pairAsks[0].resource)).toBe(false); // a single resource object per request, so the 50 limit cannot be crossed
    expect(m.maxInflight()).toBeLessThanOrEqual(8);
    expect(b.entries).toHaveLength(65);
  });

  it("nothing readable is the ordinary denial, and no request or brief is read", async () => {
    const m = make({ board: [row(1)], probe: () => false });
    (m.deps.authorize as ReturnType<typeof vi.fn>).mockRejectedValue(new ForbiddenException("denied"));
    await expect(m.svc.calendar(gate(), SITE_REF, {})).rejects.toBeInstanceOf(ForbiddenException);
    expect(m.deps.pendingRequests).not.toHaveBeenCalled();
    expect(m.deps.briefsByIds).not.toHaveBeenCalled();
  });

  it("a request on a row the caller may not read never reaches the answer", async () => {
    const m = make({
      board: [row(1), row(2, { collectionKey: "guide" })],
      requests: [{ id: "a1", created_at: "2026-10-02T00:00:00Z", requested_by: U2, workflow_id: "content.schedule", tool_args: { items: [{ itemId: id(2), version: 1 }], publishAt: "2026-11-05T09:00:00Z" } }],
      probe: (r) => !siteLevel(r) && r.collectionKey === "post",
    });
    const b = await body(m);
    expect(JSON.stringify(b)).not.toContain("a1");
  });
});

describe("the service: a failed read is a 503 that names the part", () => {
  for (const part of ["board", "scheduled", "requests", "briefs"] as const) {
    it(part, async () => {
      const m = make({
        board: [row(1, { editorial: { ...row(1).editorial, briefRef: id(90) } })],
        briefs: [{ id: id(90), webdeskItemId: id(1), topic: "t", status: "draft", assigneeId: null }],
        fail: part, probe: () => true,
      });
      await expect(m.svc.calendar(gate(), SITE_REF, {})).rejects.toMatchObject({ response: { message: "calendar_unavailable", part, reason: `${part}_unreadable` } });
    });
  }
  it("authorization (Cerbos itself failing)", async () => {
    const m = make({ board: [row(1)], fail: "probe" });
    await expect(m.svc.calendar(gate(), SITE_REF, {})).rejects.toMatchObject({ response: { part: "authorization" } });
  });
  it("a board that says there is more but gives no cursor, and a row that is not the shape", async () => {
    const m = make({ board: [row(1)] });
    (m.deps.zoneB.read as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ status: 200, body: { items: [], page: { cursor: null, hasMore: true, limit: 100 } } });
    await expect(m.svc.calendar(gate(), SITE_REF, {})).rejects.toMatchObject({ response: { part: "board" } });
    const m2 = make({ board: [row(1)] });
    (m2.deps.zoneB.read as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ status: 200, body: { items: [{ nope: 1 }], page: { cursor: null, hasMore: false, limit: 100 } } });
    await expect(m2.svc.calendar(gate(), SITE_REF, {})).rejects.toMatchObject({ response: { part: "board" } });
  });
  it("a company-level reader whose board has no counts is a 503, not 'withheld'", async () => {
    const m = make({ board: [row(1)], probe: (r) => siteLevel(r) });
    (m.deps.zoneB.read as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => ({ status: 200, body: { items: [wire(row(1))], policies: [], page: { cursor: null, hasMore: false, limit: 100 } } }));
    await expect(m.svc.calendar(gate(), SITE_REF, {})).rejects.toMatchObject({ response: { part: "board", cause: "counts_missing" } });
  });
});

describe("the service: paging and caps", () => {
  it("follows every board page", async () => {
    const m = make({ board: Array.from({ length: 250 }, (_, i) => row(i + 1)), pageSize: 100, probe: (r) => siteLevel(r) });
    const b = await body(m);
    expect(b.entries).toHaveLength(250);
    expect(b.truncated).toBe(false);
    expect(m.calls.filter((c) => c.command === "editorial.board")).toHaveLength(3);
  });
  it("a board longer than the page cap says truncated", async () => {
    const m = make({ board: [row(1)], neverMore: true, probe: (r) => siteLevel(r) });
    const b = await body(m);
    expect(b.truncated).toBe(true);
    expect(m.calls.filter((c) => c.command === "editorial.board")).toHaveLength(MAX_BOARD_PAGES);
  });
});

describe("the service: the window, requests and briefs", () => {
  it("lists placed items in the window and the unscheduled drafts, and drops the rest", async () => {
    const dated = (n: number, due: string | null) => row(n, { editorial: { ...row(n).editorial, dueAt: due } });
    const m = make({ board: [dated(1, "2026-10-10T00:00:00Z"), dated(2, "2026-12-10T00:00:00Z"), dated(3, null), dated(4, null)].map((r, i) => (i === 3 ? { ...r, publishState: "published" } : r)), probe: (r) => siteLevel(r) });
    const b = await body(m, { from: "2026-10-01", to: "2026-10-31" });
    expect(b.entries.map((e: { slug: string }) => e.slug).sort()).toEqual(["s1", "s3"]);
    expect(b.entries.find((e: { slug: string }) => e.slug === "s1").placement.kind).toBe("due");
  });
  it("a pending schedule request puts the item on its requested day and badges it", async () => {
    const m = make({
      board: [row(1)],
      requests: [{ id: "a1", created_at: "2026-10-02T00:00:00Z", requested_by: U1, workflow_id: "content.schedule", tool_args: { items: [{ itemId: id(1), version: 1 }], publishAt: "2026-11-05T09:00:00Z" } }],
      probe: (r) => siteLevel(r),
    });
    const b = await body(m, { from: "2026-11-01", to: "2026-11-30" });
    expect(b.entries[0].placement).toEqual({ kind: "requested_publish", at: "2026-11-05T09:00:00.000Z" });
    expect(b.entries[0].requests).toEqual([expect.objectContaining({ approvalId: "a1", requestedByMe: true, status: "pending" })]);
  });
  it("a scheduled item of a review-off collection is listed with inFlow false and its publish_at", async () => {
    const sched = row(7, { collectionKey: "page", publishState: "scheduled", publishAt: "2026-10-20T08:00:00.000Z", inFlow: false, editorial: { reviewRequired: false, state: "draft" } });
    const m = make({ board: [], scheduled: { page: [sched] }, probe: (r) => siteLevel(r) });
    const b = await body(m, { from: "2026-10-01", to: "2026-10-31" });
    expect(b.entries[0]).toMatchObject({ slug: "s7", collectionKey: "page", inFlow: false, placement: { kind: "publish_at", at: "2026-10-20T08:00:00.000Z" } });
  });
  it("a brief shows to a manager, to someone who may comment, and is hidden (said so) from anyone else; another item's brief never attaches", async () => {
    const withRef = (n: number, ref: string, author = U1) => row(n, { collectionKey: n === 3 ? "guide" : "post", editorial: { ...row(n).editorial, briefRef: ref, authorSub: author } });
    const briefs = [
      { id: id(91), webdeskItemId: id(1), topic: "Villa guide", status: "draft", assigneeId: U1 },
      { id: id(92), webdeskItemId: id(2), topic: "Hidden one", status: "draft", assigneeId: U2 },
      { id: id(93), webdeskItemId: id(99), topic: "Wrong item", status: "draft", assigneeId: null },
    ];
    const m = make({
      board: [withRef(1, id(91)), withRef(2, id(92), U2), withRef(3, id(93))], briefs,
      // manager of guide only; a commenter only on items it owns (U1)
      probe: (r, a) => (siteLevel(r) ? false : a === "read" ? true : a === "assign" ? r.collectionKey === "guide" : a === "comment" ? r.ownerId === U1 : false),
    });
    const b = await body(m);
    const by = (slug: string) => b.entries.find((e: { slug: string }) => e.slug === slug);
    expect(by("s1")).toMatchObject({ brief: { id: id(91), topic: "Villa guide" }, briefHidden: false });
    expect(by("s2")).toMatchObject({ brief: null, briefHidden: true });
    expect(JSON.stringify(by("s2"))).not.toContain("Hidden one");
    expect(by("s3")).toMatchObject({ brief: null, briefHidden: false }); // the brief names another item
  });
});

describe("MCP tool", () => {
  it("webdesk.editorial.calendar is a read on the route the content controller declares", () => {
    const t = webdevModule.mcpTools.find((x) => x.name === "webdesk.editorial.calendar")!;
    expect(t).toMatchObject({ method: "GET", minAssurance: "low" });
    expect(t.write).toBeFalsy();
    expect(t.impact).toBeUndefined();
    expect(t.pathTemplate).toMatch(/\/editorial\/calendar$/);
  });
});
