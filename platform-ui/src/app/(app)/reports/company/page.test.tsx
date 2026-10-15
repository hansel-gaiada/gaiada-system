import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Me } from "@/lib/platform";
import type { ReportDocument } from "@/lib/reports";

// DW-4k — the document pages offer Export (and Print) only when they rendered the document: the company page stands for the
// four (company, department, person, project all mount the same `ReportPageClient`). A refused or too-wide read renders no
// document and so no export; a sealed period carries no AD HOC note, an unsealed one does.
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => { throw new Error("redirect"); }),
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/reports/company",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-exec") }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("@/lib/platform", async () => {
  const actual = await vi.importActual<typeof import("@/lib/platform")>("@/lib/platform");
  return { ...actual, getMe: vi.fn() };
});
vi.mock("@/lib/reports-data", async () => {
  const actual = await vi.importActual<typeof import("@/lib/reports-data")>("@/lib/reports-data");
  return { ...actual, getReportDocument: vi.fn() };
});
vi.mock("@/lib/reportExportActions", () => ({ createReportExport: vi.fn() }));
// The chart kit and the viewer are not under test.
vi.mock("@/components/reports/ReportViewer", () => ({ ReportViewer: ({ children }: { children?: React.ReactNode }) => <div data-testid="viewer">{children}</div> }));
vi.mock("@/components/reports/GrainCharts", () => ({ CompanyCharts: () => null }));

import { getMe, PlatformError } from "@/lib/platform";
import { getReportDocument } from "@/lib/reports-data";
import CompanyReportPage from "./page";

const ME: Me = { userId: "u-exec", name: "Exec", email: "e@example.test", title: null, assurance: "high", companies: [{ id: "co-1", name: "Example", type: null }], roles: [] };
const docMock = vi.mocked(getReportDocument);

const DOC = (header: Partial<ReportDocument["header"]> = {}): ReportDocument => ({
  header: {
    tenantId: "co-1", grain: "company", scopeRef: "co-1", scopeName: "Example", periodKind: "month", periodStart: "2026-07-01", periodEnd: "2026-07-31",
    dayCount: 31, periodLabel: "July 2026", generatedAt: "2026-08-01T00:00:00Z", sealed: false, ...header,
  },
  kpis: [], series: [], distributions: [], tables: [], highlights: [], narrative: { text: "", source: "deterministic" },
});

const mount = async () => {
  vi.mocked(getMe).mockResolvedValue(ME);
  return render(await CompanyReportPage({ searchParams: Promise.resolve({ periodKind: "month", start: "2026-07-01" }) }));
};

beforeEach(() => { docMock.mockReset(); });

describe("document pages · export and print (DW-4k)", () => {
  it("a rendered, unsealed document offers PDF, XLSX, CSV and Print, and says the file is marked AD HOC · UNSEALED", async () => {
    docMock.mockResolvedValue(DOC());
    await mount();
    for (const f of ["PDF", "XLSX", "CSV"]) expect(screen.getByRole("button", { name: `Export this report as ${f}` })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Print this report" })).toBeInTheDocument();
    expect(screen.getByText(/marked "AD HOC · UNSEALED"/)).toBeInTheDocument();
  });

  it("a sealed document offers the same controls without the AD HOC note", async () => {
    docMock.mockResolvedValue(DOC({ sealed: true, revision: 1 }));
    await mount();
    expect(screen.getByRole("button", { name: "Export this report as PDF" })).toBeInTheDocument();
    expect(screen.queryByText(/AD HOC/)).not.toBeInTheDocument();
  });

  it("the printed copy states the scope and the period (the sidebar that names the company does not print)", async () => {
    docMock.mockResolvedValue(DOC());
    const { container } = await mount();
    expect(container.querySelector(".rp-printonly")).toHaveTextContent("Example · July 2026");
    expect(container.querySelector(".rp-reports")).not.toBeNull();
  });

  it("a refused read renders no document and no export or print controls", async () => {
    docMock.mockRejectedValue(new PlatformError(403, "forbidden"));
    await mount();
    expect(screen.queryByRole("button", { name: /Export this report as/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Print/ })).not.toBeInTheDocument();
  });

  it("a too-wide custom range renders no document and no export", async () => {
    docMock.mockRejectedValue(new PlatformError(422, "range_too_large", "end"));
    await mount();
    expect(screen.queryByRole("button", { name: /Export this report as/ })).not.toBeInTheDocument();
  });
});
