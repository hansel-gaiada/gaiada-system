import { describe, it, expect, vi, beforeEach } from "vitest";

// PV7-04b — the portal's report helpers (label from the file's content type, readable period) and the read-marker action.

vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: () => undefined, set: vi.fn() })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u1") }));
vi.mock("./portal-company", () => ({ getActivePortalCompany: vi.fn(async () => ({ id: "co-1", name: "Example" })) }));
vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return { ...actual, platformFetch: vi.fn(), getMe: vi.fn(async () => ({ userId: "u1" })) };
});

import { revalidatePath } from "next/cache";
import { platformFetch, PlatformError } from "./platform";
import { portalPeriod, reportDownloadLabel } from "./portal";
import { markPortalReportRead } from "./portalActions";

const fetchMock = vi.mocked(platformFetch);
beforeEach(() => { fetchMock.mockReset(); vi.mocked(revalidatePath).mockClear(); });

describe("reportDownloadLabel", () => {
  it("is named from the FILE's content type, never hard-coded to PDF", () => {
    expect(reportDownloadLabel("application/pdf")).toBe("Download PDF");
    expect(reportDownloadLabel("text/markdown")).toBe("Download (Markdown)");
    expect(reportDownloadLabel("text/markdown; charset=utf-8")).toBe("Download (Markdown)");
    expect(reportDownloadLabel("Application/PDF")).toBe("Download PDF");
  });
  it("is a neutral Download for anything else, and for a missing type", () => {
    expect(reportDownloadLabel("application/octet-stream")).toBe("Download");
    expect(reportDownloadLabel(null)).toBe("Download");
    expect(reportDownloadLabel(undefined)).toBe("Download");
    expect(reportDownloadLabel("")).toBe("Download");
  });
});

describe("portalPeriod", () => {
  it("reads from to, and one date for a one-day period", () => {
    expect(portalPeriod("2026-10-01", "2026-10-31")).toBe("01 Oct 2026 to 31 Oct 2026");
    expect(portalPeriod("2026-10-05", "2026-10-05")).toBe("05 Oct 2026");
  });
});

describe("markPortalReportRead", () => {
  it("POSTs the read route of the active company, encodes the id, and revalidates the portal layout (the badge)", async () => {
    fetchMock.mockResolvedValue({ id: "r/1", readAt: "2026-10-15T00:00:00Z" });
    const r = await markPortalReportRead("r/1");
    expect(r).toEqual({ ok: true, id: "r/1" });
    expect(fetchMock).toHaveBeenCalledWith("/api/co-1/portal/reports/r%2F1/read", "u1", { method: "POST" });
    expect(revalidatePath).toHaveBeenCalledWith("/portal", "layout");
  });
  it("a 404 (withdrawn since the page loaded, or out of reach) is a result, not a throw", async () => {
    fetchMock.mockRejectedValue(new PlatformError(404, "report not found"));
    expect(await markPortalReportRead("r1")).toEqual({ ok: false, error: "report not found" });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
  it("any other failure is a result too, so a click never breaks the download", async () => {
    fetchMock.mockRejectedValue(new Error("socket hang up"));
    expect(await markPortalReportRead("r1")).toMatchObject({ ok: false });
  });
  it("sends nothing without a report id", async () => {
    expect(await markPortalReportRead("")).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
