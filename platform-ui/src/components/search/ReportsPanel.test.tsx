import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ReportsPanel } from "./ReportsPanel";
import type { SearchReport, ReportRenderPreview } from "@/lib/searchMarketingShared";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock("@/lib/searchMarketingActions", () => ({
  draftReport: vi.fn(), editReportNarrative: vi.fn(), submitReportForReview: vi.fn(),
  sendReportBackToDraft: vi.fn(), approveReport: vi.fn(), deliverReport: vi.fn(),
}));

function report(overrides: Partial<SearchReport> = {}): SearchReport {
  return {
    id: "r1", engagementId: "e1", period: "2026-07", kind: "monthly", status: "draft",
    metrics: { rankTop10: 3, criticalFindingsOpen: 1, kpiTargets: [] },
    narrativeMd: "Solid month.", fileId: null, deliverableId: null,
    approvedBy: null, approvedAt: null, deliveredAt: null,
    created_at: "2026-07-01T00:00:00Z", updated_at: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

function preview(overrides: Partial<ReportRenderPreview> = {}): ReportRenderPreview {
  return { markdown: "# Report\nSolid month.", anySimulated: false, allSimulated: false, filename: "seo-report-monthly-2026-07-r1.md", ...overrides };
}

// SM-22 — pins: status-gated action visibility (module_staff can draft/submit/send-back only; the
// elevated approve/deliver affordances require canApprove), the honesty banner rendering for a
// mixed/all-simulated preview, and that a delivered report shows no further mutating controls.

describe("ReportsPanel", () => {
  it("empty state reads 'No reports drafted yet', never an empty table", () => {
    render(<ReportsPanel tenantId="t1" engagementId="e1" reports={[]} selectedPreview={null} canManage={false} canApprove={false} />);
    expect(screen.getByText(/No reports drafted yet/i)).toBeInTheDocument();
  });

  it("hides the 'Draft report' form when canManage is false", () => {
    render(<ReportsPanel tenantId="t1" engagementId="e1" reports={[]} selectedPreview={null} canManage={false} canApprove={false} />);
    expect(screen.queryByText(/Draft report/i)).not.toBeInTheDocument();
  });

  it("shows the 'Draft report' form when canManage is true", () => {
    render(<ReportsPanel tenantId="t1" engagementId="e1" reports={[]} selectedPreview={null} canManage={true} canApprove={false} />);
    expect(screen.getByText(/Draft report/i)).toBeInTheDocument();
  });

  it("a 'draft' report selected by module_staff (canManage only) shows Submit for review, never Approve/Deliver", () => {
    render(
      <ReportsPanel tenantId="t1" engagementId="e1" reports={[report()]} selectedReportId="r1" selectedPreview={preview()} canManage={true} canApprove={false} />,
    );
    expect(screen.getByText("Submit for review")).toBeInTheDocument();
    expect(screen.queryByText("Approve")).not.toBeInTheDocument();
    expect(screen.queryByText("Deliver")).not.toBeInTheDocument();
  });

  it("an 'in_review' report shows Approve only to a canApprove user, and a hint to everyone else", () => {
    const r = report({ status: "in_review" });
    const { rerender } = render(
      <ReportsPanel tenantId="t1" engagementId="e1" reports={[r]} selectedReportId="r1" selectedPreview={preview()} canManage={true} canApprove={false} />,
    );
    expect(screen.queryByText("Approve")).not.toBeInTheDocument();
    expect(screen.getByText(/Ask someone with search.report.approve/)).toBeInTheDocument();

    rerender(
      <ReportsPanel tenantId="t1" engagementId="e1" reports={[r]} selectedReportId="r1" selectedPreview={preview()} canManage={true} canApprove={true} />,
    );
    expect(screen.getByText("Approve")).toBeInTheDocument();
  });

  it("an 'approved' report shows Deliver only to a canApprove user", () => {
    const r = report({ status: "approved", approvedBy: "u1", approvedAt: "2026-07-05T00:00:00Z" });
    render(
      <ReportsPanel tenantId="t1" engagementId="e1" reports={[r]} selectedReportId="r1" selectedPreview={preview()} canManage={true} canApprove={true} />,
    );
    expect(screen.getByText("Deliver")).toBeInTheDocument();
  });

  it("a 'delivered' report shows no mutating controls, only the delivered-at note", () => {
    const r = report({ status: "delivered", deliveredAt: "2026-07-10T00:00:00Z" });
    render(
      <ReportsPanel tenantId="t1" engagementId="e1" reports={[r]} selectedReportId="r1" selectedPreview={preview()} canManage={true} canApprove={true} />,
    );
    expect(screen.queryByText("Submit for review")).not.toBeInTheDocument();
    expect(screen.queryByText("Approve")).not.toBeInTheDocument();
    expect(screen.queryByText("Deliver")).not.toBeInTheDocument();
    expect(screen.getByText(/no longer editable/i)).toBeInTheDocument();
  });

  it("renders the ALL-SIMULATED warning banner when the preview says allSimulated", () => {
    render(
      <ReportsPanel
        tenantId="t1" engagementId="e1" reports={[report({ status: "in_review" })]} selectedReportId="r1"
        selectedPreview={preview({ anySimulated: true, allSimulated: true })} canManage={true} canApprove={true}
      />,
    );
    expect(screen.getByText(/do not deliver this as though it were real/i)).toBeInTheDocument();
  });

  it("renders the MIXED warning (not the all-simulated one) when only anySimulated is true", () => {
    render(
      <ReportsPanel
        tenantId="t1" engagementId="e1" reports={[report({ status: "in_review" })]} selectedReportId="r1"
        selectedPreview={preview({ anySimulated: true, allSimulated: false })} canManage={true} canApprove={true}
      />,
    );
    expect(screen.getByText(/mixes real and SIMULATED figures/i)).toBeInTheDocument();
    expect(screen.queryByText(/do not deliver this as though it were real/i)).not.toBeInTheDocument();
  });

  it("renders no warning banner when nothing is simulated", () => {
    render(
      <ReportsPanel
        tenantId="t1" engagementId="e1" reports={[report({ status: "in_review" })]} selectedReportId="r1"
        selectedPreview={preview()} canManage={true} canApprove={true}
      />,
    );
    expect(screen.queryByText(/SIMULATED/)).not.toBeInTheDocument();
  });

  it("renders 'Preview unavailable' rather than a blank pane when selectedPreview is null", () => {
    render(
      <ReportsPanel tenantId="t1" engagementId="e1" reports={[report()]} selectedReportId="r1" selectedPreview={null} canManage={true} canApprove={false} />,
    );
    expect(screen.getByText(/Preview unavailable/i)).toBeInTheDocument();
  });

  it("prompts to select a report when none is selected", () => {
    render(<ReportsPanel tenantId="t1" engagementId="e1" reports={[report()]} selectedPreview={null} canManage={true} canApprove={false} />);
    expect(screen.getByText(/Select a report on the left/i)).toBeInTheDocument();
  });
});
