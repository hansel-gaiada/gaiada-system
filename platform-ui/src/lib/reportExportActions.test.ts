import { describe, it, expect, vi, beforeEach } from "vitest";

// DW-4k — the export action: it creates the job for exactly the document the page shows, in the caller's active company,
// and puts the platform's refusals back as they were sent (status and sentence). It decides nothing about who may export.
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn(async () => "u1") }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("./platform", async () => {
  const actual = await vi.importActual<typeof import("./platform")>("./platform");
  return { ...actual, platformFetch: vi.fn(), getMe: vi.fn(async () => ({ userId: "u1", assurance: "high", roles: [], companies: [] })) };
});

import { getSessionUserId } from "./session-server";
import { getActiveTenant } from "./tenant";
import { platformFetch, PlatformError } from "./platform";
import { createReportExport } from "./reportExportActions";
import type { ReportExportRequest } from "./reportExport";

const fetchMock = vi.mocked(platformFetch);
const body = () => JSON.parse(String(fetchMock.mock.calls[0][2]?.body));

const DEPARTMENT: ReportExportRequest = { grain: "department", scopeRef: "dept-1", periodKind: "month", start: "2026-07-01", end: "2026-07-31", format: "pdf" };

beforeEach(() => {
  fetchMock.mockReset();
  vi.mocked(getSessionUserId).mockResolvedValue("u1");
  vi.mocked(getActiveTenant).mockResolvedValue("co-1");
});

describe("createReportExport", () => {
  it("POSTs the document's own parameters to the active company's export route and returns the job id", async () => {
    fetchMock.mockResolvedValue({ jobId: "11111111-2222-3333-4444-555555555555" });
    const r = await createReportExport(DEPARTMENT);
    expect(r).toEqual({ ok: true, jobId: "11111111-2222-3333-4444-555555555555" });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-1/reports/export");
    expect(fetchMock.mock.calls[0][2]?.method).toBe("POST");
    expect(body()).toEqual(DEPARTMENT);
  });

  it.each([
    ["company", { grain: "company", scopeRef: "co-1", periodKind: "quarter", start: "2026-07-01", end: "2026-09-30", format: "xlsx" }],
    ["person", { grain: "person", scopeRef: "u-dev", periodKind: "week", start: "2026-10-12", end: "2026-10-18", format: "csv" }],
    ["project", { grain: "project", scopeRef: "p-web-1", periodKind: "custom", start: "2026-07-16", end: "2026-08-03", format: "pdf" }],
  ] as const)("sends the %s page's request as built, and nothing else", async (_n, req) => {
    fetchMock.mockResolvedValue({ jobId: "j1" });
    await createReportExport(req as ReportExportRequest);
    expect(body()).toEqual(req);
  });

  it("never takes the company from the caller: a tenant field smuggled into the request is dropped", async () => {
    fetchMock.mockResolvedValue({ jobId: "j1" });
    await createReportExport({ ...DEPARTMENT, tenantId: "co-evil", servedTenant: "x" } as unknown as ReportExportRequest);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/co-1/reports/export");
    expect(body()).toEqual(DEPARTMENT);
  });

  it("accepts the documented {id} answer too", async () => {
    fetchMock.mockResolvedValue({ id: "j2", status: "completed", filename: "r.pdf" });
    expect(await createReportExport(DEPARTMENT)).toEqual({ ok: true, jobId: "j2" });
  });

  it.each([
    [403, "forbidden"],
    [404, "not_found"],
    [422, "range_too_large"],
    [503, "pdf export is not configured"],
  ])("a %i from the platform comes back as sent, with its own sentence", async (status, sentence) => {
    fetchMock.mockRejectedValue(new PlatformError(status, sentence, "format"));
    expect(await createReportExport(DEPARTMENT)).toEqual({ ok: false, status, error: sentence });
  });

  it("a refusal with no sentence of its own falls back to words, keeping the status", async () => {
    fetchMock.mockRejectedValue(new PlatformError(500, "platform 500"));
    const r = await createReportExport(DEPARTMENT);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(500);
      expect(r.error).not.toMatch(/^platform 500$/);
    }
  });

  it("an answer with no job is a failure, never a success", async () => {
    fetchMock.mockResolvedValue({});
    expect(await createReportExport(DEPARTMENT)).toMatchObject({ ok: false, status: 502 });
  });

  it("an unreachable platform is a failure in words", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    expect(await createReportExport(DEPARTMENT)).toMatchObject({ ok: false, status: 502 });
  });

  it("no session: 401 and no platform call; no active company: 400; a bad request: 400", async () => {
    vi.mocked(getSessionUserId).mockResolvedValueOnce(null as unknown as string);
    expect(await createReportExport(DEPARTMENT)).toMatchObject({ ok: false, status: 401 });
    vi.mocked(getActiveTenant).mockResolvedValueOnce(null as unknown as string);
    expect(await createReportExport(DEPARTMENT)).toMatchObject({ ok: false, status: 400 });
    expect(await createReportExport({ ...DEPARTMENT, format: "docx" } as unknown as ReportExportRequest)).toMatchObject({ ok: false, status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
