import { describe, it, expect, vi, beforeEach } from "vitest";

// AIP-16 and AIP-05 (BFF section 66): the readers. A refusal is data, never an empty month: 403 is "forbidden"; on the unit route a 404 is a real
// answer ("not_found"); anything else, a malformed answer included, is "unavailable" with the reason.
vi.mock("@/lib/platform", async () => {
  const actual = await vi.importActual<typeof import("@/lib/platform")>("@/lib/platform");
  return { ...actual, platformFetch: vi.fn() };
});

import { PlatformError, platformFetch } from "@/lib/platform";
import { getAllowances, getCompanyAiUsage, getMyAiUsage, getUnitAiUsage } from "./aiUsage-data";
import { allowances, companyUsage, myUsage, unitUsage } from "./aiUsageFixtures";

const fetchMock = vi.mocked(platformFetch);

// `mockClear`, not `mockReset`: in this vitest (2.1) a reset mock that then throws through `mockImplementation` is reported as an unhandled error
// even when the reader caught it. Every case sets its own implementation, so nothing leaks.
beforeEach(() => { fetchMock.mockClear(); });
const failWith = (make: () => Error) => fetchMock.mockImplementation(async () => { throw make(); });

describe("the three readers", () => {
  it("ask the three routes, under the tenant, with the month", async () => {
    fetchMock.mockResolvedValue(myUsage());
    await getMyAiUsage("u-1", "co-a", "2026-10");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/co-a/ai-usage/me?month=2026-10", "u-1");
    fetchMock.mockResolvedValue(unitUsage());
    await getUnitAiUsage("u-1", "co-a", "d-web", "2026-09");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/co-a/ai-usage/units/d-web?month=2026-09", "u-1");
    fetchMock.mockResolvedValue(companyUsage());
    await getCompanyAiUsage("u-1", "co-a", "2026-10");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/co-a/ai-usage/company?month=2026-10", "u-1");
  });

  it("return the checked answer, with a cost still a string and an absent `people` still absent", async () => {
    const { people: _p, ...noPeople } = unitUsage();
    fetchMock.mockResolvedValue(noPeople);
    const r = await getUnitAiUsage("u-1", "co-a", "d-web", "2026-10");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.data.people).toBeNull();
      expect(r.data.totals.costUsd).toBe("0.00110100");
    }
  });

  const readers: [string, () => Promise<{ kind: string }>][] = [
    ["me", () => getMyAiUsage("u-1", "co-a", "2026-10")],
    ["unit", () => getUnitAiUsage("u-1", "co-a", "d-web", "2026-10")],
    ["company", () => getCompanyAiUsage("u-1", "co-a", "2026-10")],
  ];
  it.each(readers)("turns a 403 into forbidden on the %s route", async (_n, read) => {
    failWith(() => new PlatformError(403, "Forbidden"));
    expect(await read()).toEqual({ kind: "forbidden" });
  });
  it("turns a 404 into not_found on the unit route (`unit_not_found`)", async () => {
    failWith(() => new PlatformError(404, "unit_not_found"));
    expect(await getUnitAiUsage("u-1", "co-a", "d-gone", "2026-10")).toEqual({ kind: "not_found" });
  });
  it.each([readers[0], readers[2]])("turns a 404 into unavailable on the %s route, which has no unit to be missing", async (_n, read) => {
    failWith(() => new PlatformError(404, "unit_not_found"));
    expect(await read()).toEqual({ kind: "unavailable", reason: "unit_not_found" });
  });

  it("turn any other failure, and a malformed answer, into unavailable with the reason: never a month of nothing", async () => {
    failWith(() => new PlatformError(502, "bad gateway"));
    expect(await getMyAiUsage("u-1", "co-a", "2026-10")).toEqual({ kind: "unavailable", reason: "bad gateway" });
    failWith(() => new Error("socket hang up"));
    expect(await getMyAiUsage("u-1", "co-a", "2026-10")).toEqual({ kind: "unavailable", reason: "socket hang up" });
    fetchMock.mockResolvedValue({ month: "2026-10", totals: { calls: 1 }, bySurface: [], byDay: [] });
    const r = await getMyAiUsage("u-1", "co-a", "2026-10");
    expect(r.kind).toBe("unavailable");
    fetchMock.mockResolvedValue({});
    expect((await getCompanyAiUsage("u-1", "co-a", "2026-10")).kind).toBe("unavailable");
  });
});

describe("the allowances reader (AIP-17b, §66.9)", () => {
  it("asks `GET allowances` under the tenant and returns the checked answer", async () => {
    fetchMock.mockResolvedValue(allowances());
    const r = await getAllowances("u-1", "co-a");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/co-a/ai-usage/allowances", "u-1");
    expect(r).toEqual({ kind: "ok", data: allowances() });
  });
  it("is forbidden for anyone but `manage` (403), and unavailable for a failure or a malformed answer", async () => {
    failWith(() => new PlatformError(403, "Forbidden"));
    expect(await getAllowances("u-1", "co-a")).toEqual({ kind: "forbidden" });
    failWith(() => new PlatformError(500, "boom"));
    expect(await getAllowances("u-1", "co-a")).toEqual({ kind: "unavailable", reason: "boom" });
    fetchMock.mockResolvedValue({ defaultDailyReplies: "200", overrides: [] });
    expect((await getAllowances("u-1", "co-a")).kind).toBe("unavailable");
  });
});
