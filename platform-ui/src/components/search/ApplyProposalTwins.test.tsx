import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ApplyProposalTwins } from "./ApplyProposalTwins";
import type { SearchChangeProposal } from "@/lib/searchMarketingShared";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/lib/searchMarketingActions", () => ({
  exportChangeProposal: vi.fn(),
  markChangeProposalApplied: vi.fn(),
}));

// SM-19 — the SEM dual-mode picker: both twins must render for anything approved/applied, the
// automated (api) twin must ALWAYS read as unavailable (SM-21 isn't built), and neither twin may
// appear for a proposal with nothing yet to execute.

function proposal(overrides: Partial<SearchChangeProposal> = {}): SearchChangeProposal {
  return {
    id: "cp-1", campaignId: "camp-1", kind: "pause", payload: {}, status: "approved", mode: "manual",
    approvalId: null, exportFileId: null, proposedBy: "u1", approvedBy: "u1", appliedBy: null,
    appliedAt: null, created_at: "2026-07-01T00:00:00Z", updated_at: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

describe("ApplyProposalTwins", () => {
  it("renders nothing for a 'proposed' proposal — there is nothing to execute yet", () => {
    const { container } = render(
      <ApplyProposalTwins tenantId="t1" campaignId="camp-1" proposal={proposal({ status: "proposed" })} canManage={true} canLaunch={true} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for a 'dismissed' proposal", () => {
    const { container } = render(
      <ApplyProposalTwins tenantId="t1" campaignId="camp-1" proposal={proposal({ status: "dismissed" })} canManage={true} canLaunch={true} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("an approved manual proposal shows a live 'Export CSV' affordance and the automated twin as unavailable", () => {
    render(<ApplyProposalTwins tenantId="t1" campaignId="camp-1" proposal={proposal()} canManage={true} canLaunch={true} />);
    expect(screen.getByText("Export CSV")).toBeInTheDocument();
    expect(screen.getByText(/Unavailable — the one-shot API executor/)).toBeInTheDocument();
  });

  it("without canManage, no Export button is offered", () => {
    render(<ApplyProposalTwins tenantId="t1" campaignId="camp-1" proposal={proposal()} canManage={false} canLaunch={true} />);
    expect(screen.queryByText("Export CSV")).not.toBeInTheDocument();
  });

  it("without canLaunch, 'Mark as applied' is not offered and the permission gap is named", () => {
    render(<ApplyProposalTwins tenantId="t1" campaignId="camp-1" proposal={proposal()} canManage={true} canLaunch={false} />);
    expect(screen.queryByText("Mark as applied")).not.toBeInTheDocument();
    expect(screen.getByText(/search.campaign.launch/)).toBeInTheDocument();
  });

  it("an api-mode approved proposal shows the manual twin as not-applicable and the automated twin as unavailable — never a working control on either side", () => {
    render(<ApplyProposalTwins tenantId="t1" campaignId="camp-1" proposal={proposal({ mode: "api" })} canManage={true} canLaunch={true} />);
    expect(screen.queryByText("Export CSV")).not.toBeInTheDocument();
    expect(screen.getByText(/only available for mode='manual'/)).toBeInTheDocument();
    expect(screen.getByText(/currently has no way to reach 'applied'/)).toBeInTheDocument();
  });

  it("an already-applied proposal states who applied it and when, and offers a re-download once exported", () => {
    render(
      <ApplyProposalTwins
        tenantId="t1" campaignId="camp-1"
        proposal={proposal({ status: "applied", exportFileId: "file-1", appliedBy: "u9", appliedAt: "2026-07-05T10:00:00Z" })}
        canManage={true} canLaunch={true}
      />,
    );
    expect(screen.getByText(/Applied by user u9/)).toBeInTheDocument();
    expect(screen.getByText("Re-export CSV")).toBeInTheDocument();
    expect(screen.getByText(/^Download /)).toBeInTheDocument();
  });
});
