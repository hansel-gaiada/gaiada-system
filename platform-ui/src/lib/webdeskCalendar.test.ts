import { describe, it, expect, vi, beforeEach } from "vitest";

// The calendar reader (webdeskCalendar.ts): every 2xx body is validated, a refusal is a typed result and never an empty list, and the
// withheld/not-withheld counts are one fact.

vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return { ...actual, platformFetch: vi.fn() };
});

import { platformFetch, PlatformError } from "./platform";
import { WireDrift } from "./webdeskContent";
import { getBrief, getEditorialCalendar, parseBriefDetail, parseCalendar } from "./webdeskCalendar";

const fetchMock = vi.mocked(platformFetch);
const BASE = "/api/co-1/modules/webdev/content/sites/gaiada/site-1";

const entry = (over: Record<string, unknown> = {}) => ({
  itemId: "i1", collectionKey: "post", locale: "en", slug: "villa", title: "Villa", headVersion: 2, publishState: "draft", publishAt: null, unpublishAt: null,
  reviewState: "in_review", reviewRequired: true, inFlow: true, authorSub: "u1", dueAt: "2026-10-10T00:00:00.000Z", plannedPublishAt: null, submittedVersion: 2, approvedVersion: null,
  openComments: 1, briefRef: null, brief: null, briefHidden: false, requests: [], placement: { kind: "due", at: "2026-10-10T00:00:00.000Z" }, ...over,
});
const body = (over: Record<string, unknown> = {}) => ({
  tenantSlug: "gaiada", siteId: "site-1", from: "2026-09-28", to: "2026-11-01", truncated: false, entries: [entry()],
  policies: [{ collectionKey: "post", reviewRequired: true, seoSignoffRequired: false }],
  counts: { draft: 1, in_review: 1, changes_requested: 0, approved: 0 }, ...over,
});

beforeEach(() => fetchMock.mockReset());

describe("parseCalendar", () => {
  it("reads the BFF's answer", () => {
    const b = parseCalendar(body());
    expect(b.entries[0]).toMatchObject({ itemId: "i1", reviewState: "in_review", inFlow: true, placement: { kind: "due" } });
    expect(b.counts).toEqual({ draft: 1, in_review: 1, changes_requested: 0, approved: 0 });
    expect(b.countsWithheld).toBe(false);
  });
  it("withheld counts are null, never zeros; a body with both, or neither, is drift", () => {
    const { counts: _c, ...rest } = body();
    void _c;
    const w = parseCalendar({ ...rest, countsWithheld: true });
    expect(w.counts).toBeNull();
    expect(w.countsWithheld).toBe(true);
    expect(() => parseCalendar({ ...body(), countsWithheld: true })).toThrow(WireDrift);
    expect(() => parseCalendar(rest)).toThrow(WireDrift);
  });
  it("a pending request, a brief and a placement are checked", () => {
    const req = { approvalId: "a1", command: "content.schedule", status: "pending", publishAt: "2026-11-05T09:00:00.000Z", unpublishAt: null, createdAt: "2026-10-01T00:00:00.000Z", requestedByMe: true };
    const ok = parseCalendar(body({ entries: [entry({ requests: [req], briefRef: "b1", brief: { id: "b1", topic: "Villa", status: "draft", assigneeId: null } })] }));
    expect(ok.entries[0].requests[0].requestedByMe).toBe(true);
    expect(ok.entries[0].brief?.topic).toBe("Villa");
    expect(() => parseCalendar(body({ entries: [entry({ requests: [{ ...req, status: "approved" }] })] }))).toThrow(/pending/);
    expect(() => parseCalendar(body({ entries: [entry({ requests: [{ ...req, command: "content.delete" }] })] }))).toThrow(/content.publish/);
    expect(() => parseCalendar(body({ entries: [entry({ placement: { kind: "whenever", at: "x" } })] }))).toThrow(/publish_at/);
  });
  it("a missing member is drift, never a default", () => {
    const { entries: _e, ...rest } = body();
    void _e;
    expect(() => parseCalendar(rest)).toThrow(WireDrift);
    const { briefHidden: _b, ...noHidden } = entry();
    void _b;
    expect(() => parseCalendar(body({ entries: [noHidden] }))).toThrow(WireDrift);
    expect(() => parseCalendar("nope")).toThrow(WireDrift);
  });
});

describe("getEditorialCalendar", () => {
  it("sends the window and the filters, and parses", async () => {
    fetchMock.mockResolvedValue(body());
    const r = await getEditorialCalendar("u1", "co-1", "gaiada", "site-1", { from: "2026-09-28", to: "2026-11-01", collection: "post", locale: "en", authorSub: "u1" });
    expect(r.kind).toBe("ok");
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/editorial/calendar?from=2026-09-28&to=2026-11-01&collection=post&locale=en&authorSub=u1`);
  });
  it("sends no query for no window and no filters, and never half a window", async () => {
    fetchMock.mockResolvedValue(body());
    await getEditorialCalendar("u1", "co-1", "gaiada", "site-1");
    await getEditorialCalendar("u1", "co-1", "gaiada", "site-1", { from: "2026-09-28" });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([`${BASE}/editorial/calendar`, `${BASE}/editorial/calendar`]);
  });
  it("a 503 that names a part is an unavailable result carrying the reason, never an empty calendar", async () => {
    fetchMock.mockRejectedValueOnce(new PlatformError(503, "calendar_unavailable", undefined, undefined, "briefs_unreadable", { error: "calendar_unavailable", reason: "briefs_unreadable", part: "briefs" }));
    const r = await getEditorialCalendar("u1", "co-1", "gaiada", "site-1");
    expect(r).toMatchObject({ kind: "unavailable", code: "editorial_unavailable", reason: "briefs_unreadable" });
  });
  it("403 is forbidden, a drifted body is contract_drift", async () => {
    fetchMock.mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect((await getEditorialCalendar("u1", "co-1", "gaiada", "site-1")).kind).toBe("forbidden");
    fetchMock.mockResolvedValueOnce({ entries: "nope" });
    expect(await getEditorialCalendar("u1", "co-1", "gaiada", "site-1")).toMatchObject({ kind: "unavailable", code: "contract_drift" });
  });
});

describe("getBrief", () => {
  const brief = { id: "b1", status: "draft", topic: "Villa", targetQuery: "villa bali", searchIntent: "commercial", aiQuestions: ["q"], contentGaps: [], outline: ["Intro"], body: "", geoNotes: null, collectionKey: "post", locale: "en", itemId: "i1", assigneeId: "u1", updatedAt: "2026-10-12T00:00:00.000Z" };
  it("reads the brief the BFF answers with", async () => {
    fetchMock.mockResolvedValue({ ...brief, siteId: "x", provenance: { propertyId: "p" } });
    const r = await getBrief("u1", "co-1", "gaiada", "site-1", "b/1");
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/briefs/b%2F1`);
    expect(r.kind === "ok" && r.data.topic).toBe("Villa");
    expect(r.kind === "ok" && JSON.stringify(r.data)).not.toContain("provenance");
  });
  it("a missing member is drift", () => {
    const { topic: _t, ...rest } = brief;
    void _t;
    expect(() => parseBriefDetail(rest)).toThrow(WireDrift);
  });
});
