import { describe, it, expect } from "vitest";
import {
  addDays, anchorFrom, bucketByDay, dayOf, filterChoices, filtersFrom, gridFor, isDay, mondayOf, otherDates, outsideGrid, partFailureWords, placementInfo,
  PLACEMENT_LEGEND, queryFor, requestBadge, toWorkflowBoard, unscheduled,
  type CalendarBody, type CalendarEntry, type CalendarRequest,
} from "./webdeskCalendarModel";

const entry = (id: string, over: Partial<CalendarEntry> = {}): CalendarEntry => ({
  itemId: id, collectionKey: "post", locale: "en", slug: `s-${id}`, title: `T ${id}`, headVersion: 1, publishState: "draft", publishAt: null, unpublishAt: null,
  reviewState: "draft", reviewRequired: true, inFlow: true, authorSub: "u1", dueAt: null, plannedPublishAt: null, submittedVersion: null, approvedVersion: null,
  openComments: 0, briefRef: null, brief: null, briefHidden: false, requests: [], placement: null, ...over,
});
const req = (over: Partial<CalendarRequest> = {}): CalendarRequest => ({ approvalId: "a1", command: "content.schedule", status: "pending", publishAt: "2026-11-05T09:00:00.000Z", unpublishAt: null, createdAt: "2026-10-01T00:00:00.000Z", requestedByMe: false, ...over });
const body = (entries: CalendarEntry[], over: Partial<CalendarBody> = {}): CalendarBody => ({
  tenantSlug: "gaiada", siteId: "s1", from: null, to: null, truncated: false, entries, policies: [{ collectionKey: "post", reviewRequired: true, seoSignoffRequired: false }],
  counts: { draft: 1, in_review: 0, changes_requested: 0, approved: 0 }, countsWithheld: false, ...over,
});

describe("UTC days", () => {
  it("validates real days only, and does day arithmetic across month and year ends", () => {
    expect(isDay("2026-02-28")).toBe(true);
    expect(isDay("2026-02-29")).toBe(false);
    expect(isDay("2028-02-29")).toBe(true);
    expect(isDay("2026-13-01")).toBe(false);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(dayOf("2026-10-12T23:59:59.999Z")).toBe("2026-10-12");
  });
  it("weeks start on Monday", () => {
    expect(mondayOf("2026-10-12")).toBe("2026-10-12"); // a Monday
    expect(mondayOf("2026-10-18")).toBe("2026-10-12"); // the Sunday before the next Monday
    expect(mondayOf("2026-10-01")).toBe("2026-09-28");
  });
  it("anchorFrom takes a real day and falls back to today for anything else", () => {
    expect(anchorFrom("2026-10-05", "2026-10-12")).toBe("2026-10-05");
    expect(anchorFrom("nope", "2026-10-12")).toBe("2026-10-12");
    expect(anchorFrom("2026-02-30", "2026-10-12")).toBe("2026-10-12");
    expect(anchorFrom(undefined, "2026-10-12")).toBe("2026-10-12");
  });
});

describe("gridFor", () => {
  it("October 2026 is five whole weeks, Monday 28 Sep to Sunday 1 Nov, window at most 42 days", () => {
    const g = gridFor("month", "2026-10-15");
    expect(g.title).toBe("October 2026");
    expect(g.from).toBe("2026-09-28");
    expect(g.to).toBe("2026-11-01");
    expect(g.weeks).toHaveLength(5);
    expect(g.weeks.every((w) => w.length === 7)).toBe(true);
    expect(g.prev).toBe("2026-09-01");
    expect(g.next).toBe("2026-11-01");
    expect(g.month).toBe("2026-10");
  });
  it("a month can need six rows, and February can need four", () => {
    expect(gridFor("month", "2027-05-10").weeks).toHaveLength(6); // 1 May 2027 is a Saturday
    expect(gridFor("month", "2027-02-10").weeks).toHaveLength(4); // 1 Feb 2027 is a Monday, 28 days
    expect(gridFor("month", "2028-02-10").to >= "2028-02-29").toBe(true);
    for (const a of ["2026-01-15", "2026-02-15", "2026-12-15", "2027-05-10"]) {
      const g = gridFor("month", a);
      expect((Date.parse(g.to) - Date.parse(g.from)) / 86_400_000 + 1).toBeLessThanOrEqual(42);
    }
  });
  it("the week view is one Monday to Sunday row and steps by seven days", () => {
    const g = gridFor("week", "2026-10-15");
    expect(g.weeks).toEqual([["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"]]);
    expect(g.from).toBe("2026-10-12");
    expect(g.to).toBe("2026-10-18");
    expect(g.prev).toBe("2026-10-08");
    expect(g.next).toBe("2026-10-22");
    expect(g.title).toBe("12 Oct – 18 Oct 2026");
  });
  it("December steps into the next year", () => {
    expect(gridFor("month", "2026-12-20").next).toBe("2027-01-01");
    expect(gridFor("month", "2026-01-20").prev).toBe("2025-12-01");
  });
});

describe("placing entries", () => {
  it("buckets by the UTC day of the placement, in time order, and leaves unplaced ones out", () => {
    const a = entry("a", { placement: { kind: "due", at: "2026-10-12T15:00:00.000Z" } });
    const b = entry("b", { placement: { kind: "planned", at: "2026-10-12T01:00:00.000Z" } });
    const c = entry("c", { placement: { kind: "publish_at", at: "2026-10-13T00:00:00.000Z" } });
    const d = entry("d");
    const m = bucketByDay([a, b, c, d]);
    expect(m.get("2026-10-12")!.map((e) => e.itemId)).toEqual(["b", "a"]);
    expect(m.get("2026-10-13")!.map((e) => e.itemId)).toEqual(["c"]);
    expect([...m.keys()]).toHaveLength(2);
    expect(unscheduled([a, b, c, d]).map((e) => e.itemId)).toEqual(["d"]);
  });
  it("an instant just before UTC midnight stays on its UTC day", () => {
    const m = bucketByDay([entry("a", { placement: { kind: "due", at: "2026-10-12T23:59:59.999Z" } })]);
    expect([...m.keys()]).toEqual(["2026-10-12"]);
  });
  it("outsideGrid reports a dated entry the grid does not draw", () => {
    const g = gridFor("week", "2026-10-15");
    expect(outsideGrid([entry("a", { placement: { kind: "due", at: "2026-10-30T00:00:00.000Z" } }), entry("b", { placement: { kind: "due", at: "2026-10-13T00:00:00.000Z" } }), entry("c")], g.from, g.to).map((e) => e.itemId)).toEqual(["a"]);
  });
  it("every placement kind has a distinct word and glyph, and the legend lists all four in rule order", () => {
    expect(new Set(PLACEMENT_LEGEND.map((l) => l.glyph)).size).toBe(4);
    expect(new Set(PLACEMENT_LEGEND.map((l) => l.label)).size).toBe(4);
    expect(PLACEMENT_LEGEND.map((l) => l.kind)).toEqual(["publish_at", "requested_publish", "planned", "due"]);
    expect(placementInfo("due").label).toBe("Due");
  });
  it("otherDates names the dates an entry carries besides the one it sits on", () => {
    const e = entry("a", { placement: { kind: "planned", at: "2026-10-20T00:00:00.000Z" }, plannedPublishAt: "2026-10-20T00:00:00.000Z", dueAt: "2026-10-10T00:00:00.000Z", publishState: "scheduled", publishAt: "2026-10-25T00:00:00.000Z" });
    expect(otherDates(e)).toEqual(["Publishes 25 Oct", "Due 10 Oct"]);
    expect(otherDates(entry("b", { placement: { kind: "due", at: "2026-10-10T00:00:00.000Z" }, dueAt: "2026-10-10T00:00:00.000Z" }))).toEqual([]);
  });
});

describe("requestBadge", () => {
  it("nothing pending is no badge", () => expect(requestBadge([])).toBeNull());
  it("says pending, the requested day, and whether it is yours", () => {
    expect(requestBadge([req()])).toBe("Publish request pending for 5 Nov");
    expect(requestBadge([req({ requestedByMe: true })])).toBe("Publish request pending for 5 Nov (yours)");
    expect(requestBadge([req({ command: "content.publish", publishAt: null })])).toBe("Publish request pending");
    expect(requestBadge([req(), req({ approvalId: "a2", publishAt: "2026-11-02T00:00:00.000Z" })])).toBe("2 publish requests pending for 2 Nov");
  });
});

describe("filters", () => {
  it("'me' becomes the caller's own id; the window rides along", () => {
    expect(queryFor({ collection: "post", locale: "id", assignee: "me" }, "u9", { from: "2026-09-28", to: "2026-11-01" })).toEqual({ from: "2026-09-28", to: "2026-11-01", collection: "post", locale: "id", authorSub: "u9" });
    expect(queryFor({}, "u9")).toEqual({});
  });
  it("filtersFrom keeps only what it understands", () => {
    expect(filtersFrom({ collection: "post", assignee: "someone-else", locale: "" })).toEqual({ collection: "post" });
    expect(filtersFrom({ assignee: "me" })).toEqual({ assignee: "me" });
  });
  it("choices are the policies, the rows and the site's locales, sorted and unique", () => {
    const c = filterChoices(body([entry("a", { collectionKey: "guide", locale: "id" })]), ["en", "id"]);
    expect(c).toEqual({ collections: ["guide", "post"], locales: ["en", "id"] });
  });
});

describe("toWorkflowBoard", () => {
  it("is the in-flow entries only, with the brief, requests and placement carried on each card", () => {
    const inFlow = entry("a", { reviewState: "in_review", briefRef: "b1", brief: { id: "b1", topic: "Villa", status: "draft", assigneeId: "u1" }, requests: [req()], dueAt: "2026-10-10T00:00:00.000Z" });
    const calendarOnly = entry("b", { inFlow: false, publishState: "scheduled" });
    const w = toWorkflowBoard(body([inFlow, calendarOnly]));
    expect(w.items.map((i) => i.itemId)).toEqual(["a"]);
    expect(w.items[0]).toMatchObject({ editorial: { state: "in_review", dueAt: "2026-10-10T00:00:00.000Z", briefRef: "b1" }, brief: { topic: "Villa" }, requests: [{ approvalId: "a1" }] });
    expect(w.page).toMatchObject({ hasMore: false, cursor: null });
  });
  it("filters by review state", () => {
    const w = toWorkflowBoard(body([entry("a", { reviewState: "draft" }), entry("b", { reviewState: "approved" })]), "approved");
    expect(w.items.map((i) => i.itemId)).toEqual(["b"]);
  });
  it("withheld counts stay null (never zeros) and truncation is carried", () => {
    const w = toWorkflowBoard(body([], { counts: null, countsWithheld: true, truncated: true }));
    expect(w.counts).toBeNull();
    expect(w.countsWithheld).toBe(true);
    expect(w.truncated).toBe(true);
  });
});

describe("partFailureWords", () => {
  const un = (reason: string, code: "editorial_unavailable" | "network" = "editorial_unavailable") => ({ kind: "unavailable" as const, code, reason });
  it("names each part that could not be read, and says nothing is shown", () => {
    expect(partFailureWords(un("board_unreadable"))).toMatch(/review board/);
    expect(partFailureWords(un("scheduled_unreadable"))).toMatch(/scheduled publish dates/);
    expect(partFailureWords(un("requests_unreadable"))).toMatch(/pending publish requests/);
    expect(partFailureWords(un("briefs_unreadable"))).toMatch(/briefs/);
    expect(partFailureWords(un("authorization_unreadable"))).toMatch(/permissions/);
    expect(partFailureWords(un("board_unreadable"))).toMatch(/Nothing is shown/);
  });
  it("is null for any other failure, so the shared refusal handles it", () => {
    expect(partFailureWords(un("circuit_open"))).toBeNull();
    expect(partFailureWords(un("board_unreadable", "network"))).toBeNull();
    expect(partFailureWords({ kind: "forbidden", reason: "no" })).toBeNull();
  });
});
