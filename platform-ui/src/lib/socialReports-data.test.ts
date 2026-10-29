import { describe, it, expect, vi, beforeEach } from "vitest";

// SCP-5a (BFF §63.18): the report pages' two readers. Every answer is a `ReadResult`: a failed or malformed read is "cannot tell" and a 403 is "forbidden", never an empty list; a report that does
// not exist is a real answer (`ok` with null), not a refusal.
vi.mock("./platform", async (orig) => ({ ...(await orig<typeof import("./platform")>()), platformFetch: vi.fn() }));

import { platformFetch, PlatformError } from "./platform";
import { getSocialReport, getSocialReports } from "./socialReports-data";

beforeEach(() => { vi.mocked(platformFetch).mockReset(); });

const row = { id: "r1", engagementId: "e1", clientName: "Northwind Traders", period: "2026-09", kind: "monthly", status: "draft", createdAt: null, approvedAt: null, deliveredAt: null, notesComplete: false, simulated: false };
const detail = {
  id: "r1", status: "draft", engagementId: "e1", kind: "monthly", period: "2026-09", notes: {}, actionPlan: [], simulated: false, notesComplete: false, canApprove: false, canDeliver: false,
  document: { header: {}, kpis: [], series: [], tables: [], narrative: { source: "deterministic", text: "" } },
};

describe("getSocialReports", () => {
  it("asks the company's own reports route with the filters it was given, and nothing else", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ reports: [row] });
    const r = await getSocialReports("u-1", "co a", { status: "approved", period: "2026-09", engagementId: "e1" });
    expect(platformFetch).toHaveBeenCalledWith("/api/co%20a/modules/social/reports?engagementId=e1&status=approved&period=2026-09", "u-1");
    expect(r).toMatchObject({ kind: "ok", data: [{ id: "r1", clientName: "Northwind Traders" }] });
    await getSocialReports("u-1", "co-a");
    expect(platformFetch).toHaveBeenLastCalledWith("/api/co-a/modules/social/reports", "u-1");
  });
  it("is forbidden on a 403 and cannot-tell on any other failure or a body that is not a list", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "not authorized: cerbos denied read on social_report"));
    expect((await getSocialReports("u-1", "co-a")).kind).toBe("forbidden");
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(404, "Not Found"));
    expect(await getSocialReports("u-1", "co-a")).toEqual({ kind: "unavailable", reason: "Not Found" });
    vi.mocked(platformFetch).mockResolvedValueOnce({ unexpected: true });
    expect((await getSocialReports("u-1", "co-a")).kind).toBe("unavailable");
  });
});

describe("getSocialReport", () => {
  it("reads one report in the company, with the flags and the document", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ ...detail, canApprove: true });
    const r = await getSocialReport("u-1", "co-a", "r 1");
    expect(platformFetch).toHaveBeenCalledWith("/api/co-a/modules/social/reports/r%201", "u-1");
    expect(r).toMatchObject({ kind: "ok", data: { id: "r1", canApprove: true, canDeliver: false } });
  });
  it("a report that does not exist, or an id that is not one, is ok with null (a real answer)", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(404, "report not found"));
    expect(await getSocialReport("u-1", "co-a", "gone")).toEqual({ kind: "ok", data: null });
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(400, "id_invalid"));
    expect(await getSocialReport("u-1", "co-a", "x")).toEqual({ kind: "ok", data: null });
  });
  it("is forbidden on a 403, and cannot-tell on a failure or a body that is not a report", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "not authorized"));
    expect((await getSocialReport("u-1", "co-a", "r1")).kind).toBe("forbidden");
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(502, "bad gateway"));
    expect(await getSocialReport("u-1", "co-a", "r1")).toEqual({ kind: "unavailable", reason: "bad gateway" });
    vi.mocked(platformFetch).mockResolvedValueOnce({ id: "r1" });
    expect((await getSocialReport("u-1", "co-a", "r1")).kind).toBe("unavailable");
  });
});
