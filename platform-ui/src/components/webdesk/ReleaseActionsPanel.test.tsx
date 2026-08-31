import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ReleaseActionsPanel } from "./ReleaseActionsPanel";
import type { DegradeMeta, ReleaseFact } from "@/lib/webdesk";
import type { AutomationApproval } from "@/lib/automationApprovals";

const META: DegradeMeta = { stale: true, source: "facts", asOf: "2026-08-25T10:00:00Z", reason: "zone_b_has_no_live_release_read_endpoint_yet" };

describe("ReleaseActionsPanel — disabled-with-reason, never a button that would fail", () => {
  it("every release action renders disabled, each with its own visible reason", () => {
    render(<ReleaseActionsPanel slug="acme-site" releases={[]} meta={META} approvals={[]} />);
    for (const label of ["Deploy to staging", "Promote to live", "Rollback"]) {
      const btn = screen.getByRole("button", { name: label });
      expect(btn).toBeDisabled();
    }
    // The reason text is visible prose, not just a title attribute nobody reads.
    expect(screen.getByText(/No write route exists on Zone B's control plane yet/i)).toBeInTheDocument();
    expect(screen.getAllByText(/requires WS4 approval/i).length).toBeGreaterThanOrEqual(2);
  });

  it("renders the staleness banner for the release history read itself", () => {
    render(<ReleaseActionsPanel slug="acme-site" releases={[]} meta={META} approvals={[]} />);
    expect(screen.getByRole("status")).toHaveAttribute("data-stale", "true");
  });
});

describe("ReleaseActionsPanel — WS4 decisions render inline, honestly", () => {
  it("says 'no decisions on file' rather than omitting the section when none match", () => {
    render(<ReleaseActionsPanel slug="acme-site" releases={[]} meta={META} approvals={[]} />);
    expect(screen.getByText(/No WS4 decisions on file for this site yet/i)).toBeInTheDocument();
  });

  it("best-effort matches an approval by siteSlug in tool_args and renders its status", () => {
    const approvals: AutomationApproval[] = [{
      id: "aa-1", workflow_id: "wf-1", tool_name: "webdesk.promote", tool_args: { siteSlug: "acme-site" },
      impact: "high", reason: null, status: "pending", origin: "automation", agent_name: null,
      requested_by: "hansel@gaiada.com", decided_by: null, decided_at: null, created_at: "2026-08-24T00:00:00Z",
    }];
    render(<ReleaseActionsPanel slug="acme-site" releases={[]} meta={META} approvals={approvals} />);
    expect(screen.getByText(/webdesk.promote/)).toBeInTheDocument();
    expect(screen.queryByText(/No WS4 decisions on file/i)).not.toBeInTheDocument();
  });

  it("does NOT match an approval for a different site's slug", () => {
    const approvals: AutomationApproval[] = [{
      id: "aa-2", workflow_id: "wf-2", tool_name: "webdesk.promote", tool_args: { siteSlug: "some-other-site" },
      impact: "high", reason: null, status: "pending", origin: "automation", agent_name: null,
      requested_by: "hansel@gaiada.com", decided_by: null, decided_at: null, created_at: "2026-08-24T00:00:00Z",
    }];
    render(<ReleaseActionsPanel slug="acme-site" releases={[]} meta={META} approvals={approvals} />);
    expect(screen.getByText(/No WS4 decisions on file for this site yet/i)).toBeInTheDocument();
  });

  it("distinguishes 'couldn't be read' from 'confirmed zero decisions' when approvals is null", () => {
    render(<ReleaseActionsPanel slug="acme-site" releases={[]} meta={META} approvals={null} />);
    expect(screen.getByText(/Couldn.t be read right now/i)).toBeInTheDocument();
    expect(screen.queryByText(/No WS4 decisions on file/i)).not.toBeInTheDocument();
  });
});

describe("ReleaseActionsPanel — release history table", () => {
  it("renders known fact kinds with plain-language labels", () => {
    const releases: ReleaseFact[] = [
      { kind: "deploy.done", receivedAt: "2026-08-20T00:00:00Z", data: {} },
      { kind: "promote.done", receivedAt: "2026-08-21T00:00:00Z", data: {} },
    ];
    render(<ReleaseActionsPanel slug="acme-site" releases={releases} meta={META} approvals={[]} />);
    expect(screen.getByText("Deployed to staging")).toBeInTheDocument();
    expect(screen.getByText("Promoted to live")).toBeInTheDocument();
  });
});
