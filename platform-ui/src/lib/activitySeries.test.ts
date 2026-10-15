import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/platform", async () => {
  const actual = await vi.importActual<typeof import("@/lib/platform")>("@/lib/platform");
  return { ...actual, platformFetch: vi.fn() };
});

import { PlatformError, platformFetch } from "@/lib/platform";
import { getActivityDay, getActivitySeries, parseActivityDay, parseActivitySeries } from "./activitySeries";

const fetchMock = vi.mocked(platformFetch);

const U = "u-1";
const SERIES = {
  userId: U, from: "2026-10-13", to: "2026-10-15", timezone: "Asia/Makassar",
  kinds: [{ key: "github.commits", label: "Commits", source: "github" }, { key: "webdesk.edits", label: "Site edits", source: "webdesk" }],
  days: [
    { date: "2026-10-13", counts: {} },
    { date: "2026-10-14", counts: { "github.commits": 2, "webdesk.edits": 1 } },
    { date: "2026-10-15", counts: {} },
  ],
  totals: { "github.commits": 2, "webdesk.edits": 1 },
};
const DAY = { userId: U, date: "2026-10-14", items: [{ kind: "github.commits", title: "Fix header", at: "2026-10-14T09:00:00.000Z", link: "/tasks/t-1" }, { kind: "webdesk.edits", title: "Edited: Home", at: "2026-10-14T08:00:00.000Z" }] };

beforeEach(() => { fetchMock.mockReset(); });

describe("getActivitySeries", () => {
  it("asks for the person's series, with no from and no to unless given, and returns it as ok", async () => {
    fetchMock.mockResolvedValue(SERIES);
    const r = await getActivitySeries("viewer", "co-a", { subjectUserId: U });
    expect(fetchMock).toHaveBeenCalledWith(`/api/co-a/activity/series?userId=${U}`, "viewer");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.data.to).toBe("2026-10-15");
      expect(r.data.kinds.map((k) => k.label)).toEqual(["Commits", "Site edits"]);
      expect(r.data.days).toHaveLength(3);
    }
  });

  it("sends from and to when given", async () => {
    fetchMock.mockResolvedValue(SERIES);
    await getActivitySeries("viewer", "co-a", { subjectUserId: U, from: "2026-07-01", to: "2026-10-15" });
    expect(fetchMock).toHaveBeenCalledWith(`/api/co-a/activity/series?userId=${U}&from=2026-07-01&to=2026-10-15`, "viewer");
  });

  it("is forbidden on a 403, and says nothing else", async () => {
    fetchMock.mockRejectedValue(new PlatformError(403, "outside your reporting line"));
    expect(await getActivitySeries("viewer", "co-a", { subjectUserId: U })).toEqual({ kind: "forbidden" });
  });

  it("is an error on a 404 (the route is not served), never an empty series", async () => {
    fetchMock.mockRejectedValue(new PlatformError(404, "not found"));
    expect(await getActivitySeries("viewer", "co-a", { subjectUserId: U })).toEqual({ kind: "error", reason: "not found" });
  });

  it("is an error on a 400, a 5xx and a timeout", async () => {
    for (const failure of [new PlatformError(400, "to must be a YYYY-MM-DD date"), new PlatformError(500, "boom"), new Error("socket hang up")]) {
      fetchMock.mockReset();
      fetchMock.mockRejectedValue(failure);
      const r = await getActivitySeries("viewer", "co-a", { subjectUserId: U });
      expect(r.kind).toBe("error");
    }
  });

  it("is an error when the answer has the wrong shape", async () => {
    for (const wrong of [null, [], "ok", { days: [] }, { ...SERIES, days: [] }, { ...SERIES, kinds: "x" }]) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(wrong);
      expect(await getActivitySeries("viewer", "co-a", { subjectUserId: U })).toEqual({ kind: "error", reason: "unexpected answer from the activity endpoint" });
    }
  });

  it("is an error when the answer is for somebody else", async () => {
    fetchMock.mockResolvedValue({ ...SERIES, userId: "u-2" });
    expect((await getActivitySeries("viewer", "co-a", { subjectUserId: U })).kind).toBe("error");
  });
});

describe("parseActivitySeries", () => {
  it("keeps the known fields only: a stray total or score never travels on", () => {
    const parsed = parseActivitySeries({ ...SERIES, total: 3, score: 430 }, U);
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed!).sort()).toEqual(["days", "from", "kinds", "timezone", "to", "totals", "userId"]);
  });

  it("refuses a count that is negative, fractional or not a number", () => {
    for (const bad of [-1, 1.5, "2", null]) {
      const days = [{ date: "2026-10-14", counts: { "github.commits": bad } }];
      expect(parseActivitySeries({ ...SERIES, days }, U)).toBeNull();
    }
  });

  it("refuses a bad date, a kind without a label and totals of the wrong kind", () => {
    expect(parseActivitySeries({ ...SERIES, to: "15/10/2026" }, U)).toBeNull();
    expect(parseActivitySeries({ ...SERIES, kinds: [{ key: "a", source: "x" }] }, U)).toBeNull();
    expect(parseActivitySeries({ ...SERIES, totals: [] }, U)).toBeNull();
  });
});

describe("getActivityDay", () => {
  it("asks for the person's day and returns the items", async () => {
    fetchMock.mockResolvedValue(DAY);
    const r = await getActivityDay("viewer", "co-a", { subjectUserId: U, date: "2026-10-14" });
    expect(fetchMock).toHaveBeenCalledWith(`/api/co-a/activity/day?userId=${U}&date=2026-10-14`, "viewer");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.data.items.map((i) => i.title)).toEqual(["Fix header", "Edited: Home"]);
  });

  it("is forbidden on a 403, an error on a 404 or a failure, and an empty day is ok, not an error", async () => {
    fetchMock.mockRejectedValue(new PlatformError(403, "outside your reporting line"));
    expect(await getActivityDay("viewer", "co-a", { subjectUserId: U, date: "2026-10-14" })).toEqual({ kind: "forbidden" });
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new PlatformError(404, "not found"));
    expect((await getActivityDay("viewer", "co-a", { subjectUserId: U, date: "2026-10-14" })).kind).toBe("error");
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ userId: U, date: "2026-10-14", items: [] });
    expect(await getActivityDay("viewer", "co-a", { subjectUserId: U, date: "2026-10-14" })).toEqual({ kind: "ok", data: { userId: U, date: "2026-10-14", items: [] } });
  });

  it("is an error when the answer is for another day or has the wrong shape", async () => {
    fetchMock.mockResolvedValue({ ...DAY, date: "2026-10-13" });
    expect((await getActivityDay("viewer", "co-a", { subjectUserId: U, date: "2026-10-14" })).kind).toBe("error");
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ userId: U, date: "2026-10-14", items: [{ kind: "x" }] });
    expect((await getActivityDay("viewer", "co-a", { subjectUserId: U, date: "2026-10-14" })).kind).toBe("error");
  });
});

describe("parseActivityDay", () => {
  it("keeps a link only when there is one", () => {
    const parsed = parseActivityDay(DAY, U, "2026-10-14");
    expect(parsed?.items[0].link).toBe("/tasks/t-1");
    expect("link" in parsed!.items[1]).toBe(false);
  });
});
