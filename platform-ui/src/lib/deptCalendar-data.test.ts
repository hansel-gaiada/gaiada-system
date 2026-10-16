import { describe, it, expect, vi, beforeEach } from "vitest";

// DW-10c-3 (BFF section 59.1): the department calendar's reader. A refusal or a failure is data the page can word; it is never an empty calendar.
vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return { ...actual, platformFetch: vi.fn() };
});

import { platformFetch, PlatformError } from "./platform";
import { getDeptCalendar } from "./deptCalendar-data";

const fetchMock = vi.mocked(platformFetch);
const answer = {
  unit: { id: "dept-1", name: "Web Dev" }, from: "2026-09-28", to: "2026-11-08",
  holidays: { included: true, items: [] }, away: { included: false, reason: "module_off" },
  deadlines: { included: true, items: [] }, events: { included: true, items: [] },
};
const W = { from: "2026-09-28", to: "2026-11-08" };

beforeEach(() => fetchMock.mockReset());

describe("getDeptCalendar", () => {
  it("asks for the unit's calendar over the window, as the signed-in person", async () => {
    fetchMock.mockResolvedValue(answer);
    const r = await getDeptCalendar("u1", "co-a", "dept-1", W);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-a/departments/dept-1/calendar?from=2026-09-28&to=2026-11-08");
    expect(fetchMock.mock.calls[0][1]).toBe("u1");
    expect(r).toEqual({ kind: "ok", data: answer });
  });

  it("encodes the tenant and the unit", async () => {
    fetchMock.mockResolvedValue(answer);
    await getDeptCalendar("u1", "co a", "d/1", W);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co%20a/departments/d%2F1/calendar?from=2026-09-28&to=2026-11-08");
  });

  it("keeps a leg that was not read as it came: module_off is not an empty leg", async () => {
    fetchMock.mockResolvedValue(answer);
    const r = await getDeptCalendar("u1", "co-a", "dept-1", W);
    expect(r.kind === "ok" && r.data.away).toEqual({ included: false, reason: "module_off" });
    expect(r.kind === "ok" && r.data.holidays).toEqual({ included: true, items: [] });
  });

  it("a 403 is forbidden, never an empty calendar", async () => {
    fetchMock.mockRejectedValueOnce(new PlatformError(403, "outside your reporting line"));
    expect(await getDeptCalendar("u1", "co-a", "dept-9", W)).toEqual({ kind: "forbidden" });
  });

  it("a 404 (an unknown unit), a 400, a 500 and a network failure are unavailable with their words", async () => {
    fetchMock.mockRejectedValueOnce(new PlatformError(404, "unit_not_found", "unitNodeId"));
    expect(await getDeptCalendar("u1", "co-a", "gone", W)).toEqual({ kind: "unavailable", reason: "unit_not_found" });
    fetchMock.mockRejectedValueOnce(new PlatformError(400, "the window is at most 42 days", "to"));
    expect(await getDeptCalendar("u1", "co-a", "dept-1", W)).toEqual({ kind: "unavailable", reason: "the window is at most 42 days" });
    fetchMock.mockRejectedValueOnce(new PlatformError(500, "boom"));
    expect(await getDeptCalendar("u1", "co-a", "dept-1", W)).toEqual({ kind: "unavailable", reason: "boom" });
    fetchMock.mockRejectedValueOnce(new Error("socket hang up"));
    expect(await getDeptCalendar("u1", "co-a", "dept-1", W)).toEqual({ kind: "unavailable", reason: "socket hang up" });
  });

  it("an answer with no unit or window is a failed read, not an empty calendar", async () => {
    for (const bad of [{}, [], null, { holidays: answer.holidays }]) {
      fetchMock.mockResolvedValueOnce(bad);
      expect((await getDeptCalendar("u1", "co-a", "dept-1", W)).kind).toBe("unavailable");
    }
  });
});
