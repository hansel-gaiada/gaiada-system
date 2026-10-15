import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReportHeader } from "@/lib/reports";

// DW-4k — Print and Export on one rendered report. What is pinned: Export offers PDF, XLSX and CSV for the document's OWN
// grain/scope/period; an unsealed period says its file is marked AD HOC · UNSEALED (a sealed one does not); a served slice
// is not offered an export that would be a different document; every refusal is shown as sent and never saved as a file;
// a success saves the platform's file name; Print calls window.print.
vi.mock("@/lib/reportExportActions", () => ({ createReportExport: vi.fn() }));

import { createReportExport } from "@/lib/reportExportActions";
import { ReportActions } from "./ReportActions";
import { PrintButton } from "./PrintButton";

const createMock = vi.mocked(createReportExport);
const fetchMock = vi.fn();

const HEADER: ReportHeader = {
  tenantId: "co-1", grain: "department", scopeRef: "dept-1", scopeName: "Web Dev", periodKind: "custom",
  periodStart: "2026-07-16", periodEnd: "2026-08-03", dayCount: 19, periodLabel: "16 Jul - 3 Aug 2026", generatedAt: "2026-08-04T00:00:00Z",
  sealed: false, warnings: { adHoc: true },
};
const SEALED: ReportHeader = { ...HEADER, periodKind: "month", periodStart: "2026-07-01", periodEnd: "2026-07-31", sealed: true, revision: 2, warnings: undefined };

const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

beforeEach(() => {
  createMock.mockReset();
  fetchMock.mockReset();
  clickSpy.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  URL.createObjectURL = vi.fn(() => "blob:report");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => vi.unstubAllGlobals());

const file = (disposition = `attachment; filename="Web Dev - AD HOC.csv"`) =>
  new Response("a,b\n1,2\n", { status: 200, headers: { "content-type": "text/csv", "content-disposition": disposition } });

describe("ReportActions · the controls", () => {
  it("offers PDF, XLSX and CSV with accessible names, and Print", () => {
    render(<ReportActions header={HEADER} />);
    for (const f of ["PDF", "XLSX", "CSV"]) expect(screen.getByRole("button", { name: `Export this report as ${f}` })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Print this report" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Export this report" })).toBeInTheDocument();
  });

  it("an unsealed period says beside the control that the file is marked AD HOC · UNSEALED", () => {
    render(<ReportActions header={HEADER} />);
    expect(screen.getByText(/marked "AD HOC · UNSEALED"/)).toBeInTheDocument();
  });

  it("a sealed period carries no such note", () => {
    render(<ReportActions header={SEALED} />);
    expect(screen.queryByText(/AD HOC/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export this report as PDF" })).toBeInTheDocument();
  });

  it("a served-company slice offers no export (the export has no servedTenant, so it would be another document) and says why; Print stays", () => {
    render(<ReportActions header={{ ...HEADER, providerView: { servedTenantId: "co-2", servedTenantName: "Viceroy" } }} />);
    expect(screen.queryByRole("button", { name: /Export this report as/ })).not.toBeInTheDocument();
    expect(screen.getByText(/not available for a served-company slice/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Print this report" })).toBeInTheDocument();
  });

  it("the whole row is marked as not printing", () => {
    const { container } = render(<ReportActions header={HEADER} />);
    expect(container.firstElementChild).toHaveClass("rp-noprint");
  });
});

describe("ReportActions · exporting", () => {
  it("asks for exactly the document on screen, fetches the job's download, and saves it under the platform's file name", async () => {
    createMock.mockResolvedValue({ ok: true, jobId: "job-1" });
    fetchMock.mockResolvedValue(file());
    render(<ReportActions header={HEADER} />);
    fireEvent.click(screen.getByRole("button", { name: "Export this report as CSV" }));
    await waitFor(() => expect(screen.getByText("Saved Web Dev - AD HOC.csv.")).toBeInTheDocument());
    expect(createMock).toHaveBeenCalledWith({
      grain: "department", scopeRef: "dept-1", periodKind: "custom", start: "2026-07-16", end: "2026-08-03", format: "csv",
    });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/reports/exports/job-1");
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("falls back to report.<format> when the download names no file", async () => {
    createMock.mockResolvedValue({ ok: true, jobId: "job-1" });
    fetchMock.mockResolvedValue(file("attachment"));
    render(<ReportActions header={SEALED} />);
    fireEvent.click(screen.getByRole("button", { name: "Export this report as XLSX" }));
    await waitFor(() => expect(screen.getByText("Saved report.xlsx.")).toBeInTheDocument());
  });

  it.each([
    [403, "forbidden"],
    [404, "not_found"],
    [422, "range_too_large"],
    [503, "pdf export is not configured"],
  ])("a %i from the create step is shown as sent, and nothing is downloaded", async (status, error) => {
    createMock.mockResolvedValue({ ok: false, status, error });
    render(<ReportActions header={HEADER} />);
    fireEvent.click(screen.getByRole("button", { name: "Export this report as PDF" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(`Export failed (${status}): ${error}`);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it("a refused download (403 or 404) is shown as sent and is never saved as a file", async () => {
    createMock.mockResolvedValue({ ok: true, jobId: "job-1" });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } }));
    render(<ReportActions header={HEADER} />);
    fireEvent.click(screen.getByRole("button", { name: "Export this report as PDF" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Export failed (403): forbidden");
    expect(clickSpy).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(screen.queryByText(/^Saved /)).not.toBeInTheDocument();
  });

  it("a download refused with no sentence gets words, and an unreachable server is a failure too", async () => {
    createMock.mockResolvedValue({ ok: true, jobId: "job-1" });
    fetchMock.mockResolvedValueOnce(new Response("", { status: 404 }));
    render(<ReportActions header={HEADER} />);
    fireEvent.click(screen.getByRole("button", { name: "Export this report as PDF" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Export failed \(404\): .*cannot be found/);
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    fireEvent.click(screen.getByRole("button", { name: "Export this report as PDF" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/could not be reached/));
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it("disables the other formats while one is being prepared, and clears an old error on the next try", async () => {
    let finish: (v: { ok: true; jobId: string }) => void = () => {};
    createMock.mockResolvedValueOnce({ ok: false, status: 403, error: "forbidden" });
    render(<ReportActions header={HEADER} />);
    fireEvent.click(screen.getByRole("button", { name: "Export this report as PDF" }));
    await screen.findByRole("alert");
    createMock.mockReturnValueOnce(new Promise<{ ok: true; jobId: string }>((r) => { finish = r; }));
    fetchMock.mockResolvedValue(file());
    fireEvent.click(screen.getByRole("button", { name: "Export this report as CSV" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Export this report as PDF" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Export this report as CSV" })).toHaveAttribute("aria-busy", "true");
    finish({ ok: true, jobId: "job-2" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Export this report as PDF" })).toBeEnabled());
  });
});

describe("Print", () => {
  it("the button calls window.print", () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    render(<PrintButton />);
    fireEvent.click(screen.getByRole("button", { name: "Print this report" }));
    expect(print).toHaveBeenCalledTimes(1);
    print.mockRestore();
  });

  it("the report actions' Print button calls window.print too", () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    render(<ReportActions header={HEADER} />);
    fireEvent.click(screen.getByRole("button", { name: "Print this report" }));
    expect(print).toHaveBeenCalledTimes(1);
    print.mockRestore();
  });
});
