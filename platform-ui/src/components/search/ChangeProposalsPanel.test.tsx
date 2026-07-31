import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ChangeProposalsPanel } from "./ChangeProposalsPanel";
import type { SearchChangeProposal } from "@/lib/searchMarketingShared";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/lib/searchMarketingActions", () => ({
  createChangeProposal: vi.fn(),
  updateChangeProposalStatus: vi.fn(),
  exportChangeProposal: vi.fn(),
  markChangeProposalApplied: vi.fn(),
}));

const approved: SearchChangeProposal = {
  id: "cp-1", campaignId: "camp-1", kind: "pause", payload: {}, status: "approved", mode: "manual",
  approvalId: null, exportFileId: null, proposedBy: "u1", approvedBy: "u1", appliedBy: null,
  appliedAt: null, created_at: "2026-07-01T00:00:00Z", updated_at: "2026-07-01T00:00:00Z",
};
const proposed: SearchChangeProposal = { ...approved, id: "cp-2", status: "proposed", approvedBy: null };

describe("ChangeProposalsPanel", () => {
  it("offers the manual/api execution-mode picker at creation, never implying api mode has an executor", () => {
    render(<ChangeProposalsPanel tenantId="t1" campaignId="camp-1" proposals={[]} canManage={true} canLaunch={true} />);
    expect(screen.getByText("Execution mode")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /manual — export/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /api — automated push \(SM-21 not built yet\)/i })).toBeInTheDocument();
  });

  it("renders the dual-mode picker (ApplyProposalTwins) for an APPROVED row", () => {
    render(<ChangeProposalsPanel tenantId="t1" campaignId="camp-1" proposals={[approved]} canManage={true} canLaunch={true} />);
    expect(screen.getByText("Export CSV")).toBeInTheDocument();
  });

  it("renders no dual-mode picker for a merely PROPOSED row — nothing to execute yet", () => {
    render(<ChangeProposalsPanel tenantId="t1" campaignId="camp-1" proposals={[proposed]} canManage={true} canLaunch={true} />);
    expect(screen.queryByText("Export CSV")).not.toBeInTheDocument();
  });

  it("never offers an 'Apply'/'Push to Google Ads' control on the approve/dismiss table itself", () => {
    render(<ChangeProposalsPanel tenantId="t1" campaignId="camp-1" proposals={[approved]} canManage={true} canLaunch={true} />);
    expect(screen.queryByText(/^Apply$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Push to Google Ads/i)).not.toBeInTheDocument();
  });
});
