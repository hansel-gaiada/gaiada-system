import { describe, it, expect } from "vitest";
import {
  exportDownloadHref,
  exportRefusalMessage,
  exportRequestFor,
  filenameFromDisposition,
  isPlausibleJobId,
  isReportExportRequest,
  jobIdFrom,
} from "./reportExport";
import type { ReportHeader } from "./reports";

// DW-4k — the pure parts of a report export: the request is the document the page shows, a job id is a token, a
// download link never carries anything else, and a refusal is words.
const HEADER: ReportHeader = {
  tenantId: "co-1", grain: "department", scopeRef: "dept-1", scopeName: "Web Dev", periodKind: "month",
  periodStart: "2026-07-01", periodEnd: "2026-07-31", dayCount: 31, periodLabel: "July 2026", generatedAt: "2026-08-01T00:00:00Z", sealed: false,
};

describe("exportRequestFor", () => {
  it("is exactly the document's own grain, scope and period, plus the format", () => {
    expect(exportRequestFor(HEADER, "xlsx")).toEqual({
      grain: "department", scopeRef: "dept-1", periodKind: "month", start: "2026-07-01", end: "2026-07-31", format: "xlsx",
    });
  });
});

describe("isReportExportRequest", () => {
  const ok = exportRequestFor(HEADER, "pdf");
  it("accepts the request a page builds", () => expect(isReportExportRequest(ok)).toBe(true));
  it("refuses a bad format, grain, period kind, date or an empty scope (a server action's input is untrusted)", () => {
    expect(isReportExportRequest({ ...ok, format: "docx" })).toBe(false);
    expect(isReportExportRequest({ ...ok, grain: "team" })).toBe(false);
    expect(isReportExportRequest({ ...ok, periodKind: "decade" })).toBe(false);
    expect(isReportExportRequest({ ...ok, start: "July" })).toBe(false);
    expect(isReportExportRequest({ ...ok, scopeRef: "" })).toBe(false);
    expect(isReportExportRequest(null)).toBe(false);
  });
});

describe("jobIdFrom", () => {
  it("reads the controller's {jobId} and the documented {id}", () => {
    expect(jobIdFrom({ jobId: "7f3a-1" })).toBe("7f3a-1");
    expect(jobIdFrom({ id: "abc_1", status: "completed", filename: "x.csv" })).toBe("abc_1");
  });
  it("refuses anything that is not a token", () => {
    expect(jobIdFrom({ jobId: "../etc" })).toBeNull();
    expect(jobIdFrom({ jobId: "" })).toBeNull();
    expect(jobIdFrom({})).toBeNull();
    expect(jobIdFrom(null)).toBeNull();
  });
});

describe("links and words", () => {
  it("builds the proxy link with the id encoded, and validates ids", () => {
    expect(exportDownloadHref("a b")).toBe("/api/reports/exports/a%20b");
    expect(isPlausibleJobId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isPlausibleJobId("a/b")).toBe(false);
  });
  it("puts each refusal in a sentence", () => {
    for (const s of [400, 401, 403, 404, 422, 503]) expect(exportRefusalMessage(s).length).toBeGreaterThan(20);
    expect(exportRefusalMessage(403)).toMatch(/permission/);
  });
});

describe("filenameFromDisposition", () => {
  it("prefers the RFC 5987 name, then the quoted one, else null", () => {
    expect(filenameFromDisposition("attachment; filename=\"a.pdf\"; filename*=UTF-8''Laporan%20Jul.pdf")).toBe("Laporan Jul.pdf");
    expect(filenameFromDisposition("attachment; filename=\"report.csv\"")).toBe("report.csv");
    expect(filenameFromDisposition("attachment")).toBeNull();
    expect(filenameFromDisposition(null)).toBeNull();
  });
});
