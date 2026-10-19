import { describe, it, expect, vi, beforeEach } from "vitest";

// DW-10f-4b — the three readers behind Finance > Payables > Freelancers. A refused read is `forbidden`, a failed one `unavailable`, and a 200 in
// the wrong shape is a broken read: never an empty list, because "no freelancers" and "nothing to bill" are claims about money.
vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return { ...actual, platformFetch: vi.fn() };
});

import { platformFetch, PlatformError } from "./platform";
import { getFreelancerPreviewResult, listFreelancerBillsResult, listFreelancersResult } from "./freelancers-data";

const fetchMock = vi.mocked(platformFetch);
beforeEach(() => fetchMock.mockReset());

describe("listFreelancersResult", () => {
  it("reads finance/freelancers and returns the rows", async () => {
    fetchMock.mockResolvedValue([{ user: { id: "u" } }]);
    expect(await listFreelancersResult("u1", "co-1")).toEqual({ kind: "ok", data: [{ user: { id: "u" } }] });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-1/finance/freelancers");
  });
  it("is forbidden on a 403, unavailable on a 404 or 500, and a real empty list is still ok", async () => {
    fetchMock.mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect(await listFreelancersResult("u1", "co-1")).toEqual({ kind: "forbidden" });
    fetchMock.mockRejectedValueOnce(new PlatformError(404, "not found"));
    expect(await listFreelancersResult("u1", "co-1")).toEqual({ kind: "unavailable", reason: "not found" });
    fetchMock.mockRejectedValueOnce(new PlatformError(500, "boom"));
    expect(await listFreelancersResult("u1", "co-1")).toEqual({ kind: "unavailable", reason: "boom" });
    fetchMock.mockResolvedValueOnce([]);
    expect(await listFreelancersResult("u1", "co-1")).toEqual({ kind: "ok", data: [] });
  });
  it("a 200 that is not a list is a broken read, never none", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    expect((await listFreelancersResult("u1", "co-1")).kind).toBe("unavailable");
  });
});

describe("getFreelancerPreviewResult", () => {
  it("asks for the period in the query and returns the preview", async () => {
    const p = { periodStart: "2026-09-01", periodEnd: "2026-09-30", freelancers: [] };
    fetchMock.mockResolvedValue(p);
    expect(await getFreelancerPreviewResult("u1", "co-1", "2026-09-01", "2026-09-30")).toEqual({ kind: "ok", data: p });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-1/finance/freelancer-bills/preview?periodStart=2026-09-01&periodEnd=2026-09-30");
  });
  it("a 200 without the freelancers list is a broken read", async () => {
    fetchMock.mockResolvedValue([]);
    expect((await getFreelancerPreviewResult("u1", "co-1", "2026-09-01", "2026-09-30")).kind).toBe("unavailable");
  });
  it("is forbidden on a 403 and carries the server's words on a 400", async () => {
    fetchMock.mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect(await getFreelancerPreviewResult("u1", "co-1", "a", "b")).toEqual({ kind: "forbidden" });
    fetchMock.mockRejectedValueOnce(new PlatformError(400, "periodEnd is before periodStart"));
    expect(await getFreelancerPreviewResult("u1", "co-1", "a", "b")).toEqual({ kind: "unavailable", reason: "periodEnd is before periodStart" });
  });
});

describe("listFreelancerBillsResult", () => {
  it("reads every freelancer bill", async () => {
    fetchMock.mockResolvedValue([{ billId: "b1" }]);
    expect(await listFreelancerBillsResult("u1", "co-1")).toEqual({ kind: "ok", data: [{ billId: "b1" }] });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-1/finance/freelancer-bills");
    fetchMock.mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect(await listFreelancerBillsResult("u1", "co-1")).toEqual({ kind: "forbidden" });
  });
});
