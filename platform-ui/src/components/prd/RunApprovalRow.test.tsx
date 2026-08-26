import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { RunApprovalRow } from "./RunApprovalRow";
import type { PipelineGate, PipelineRun } from "@/lib/pipeline";

function run(over: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: "run-1", title: "Northwind — site redesign", status: "extracting", source_meeting_id: "mtg-1",
    mom_ref: null, created_at: "2026-07-01T00:00:00Z", updated_at: "2026-07-01T00:00:00Z", ...over,
  };
}
function gate(over: Partial<PipelineGate>): PipelineGate {
  return {
    id: "g-1", run_id: "run-1", stage_id: null, kind: "prd_review", actor_side: "internal",
    status: "pending", decision: null, note: null, decided_by: null, decided_at: null,
    created_at: "2026-07-01T00:00:00Z", ...over,
  };
}
const noop = vi.fn(async () => {});

describe("RunApprovalRow — one run, two approval beats", () => {
  it("links the run title into its workspace and names both beats", () => {
    render(<RunApprovalRow run={run()} gates={[]} briefingHref="/meetings/rec-1" mayDecide={false} onDecide={noop} />);
    expect(screen.getByRole("link", { name: "Northwind — site redesign" })).toHaveAttribute("href", "/pipeline/run-1");
    expect(screen.getByText(/gm review/i)).toBeInTheDocument();
    expect(screen.getByText(/client sign-off/i)).toBeInTheDocument();
    expect(screen.getByText(/still being drafted/i)).toBeInTheDocument();
  });

  it("a GM sees Approve / Request changes only while the PRD review is pending", () => {
    render(<RunApprovalRow run={run()} gates={[gate({ status: "pending" })]} mayDecide onDecide={noop} />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Request changes" })).toBeInTheDocument();
  });

  it("someone who cannot decide sees the waiting state, not the buttons", () => {
    render(<RunApprovalRow run={run()} gates={[gate({ status: "pending" })]} mayDecide={false} onDecide={noop} />);
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.getByText(/waiting on gm/i)).toBeInTheDocument();
  });

  it("when gates were not read (beyond the detail cap), it says so instead of guessing", () => {
    render(<RunApprovalRow run={run()} gates={null} mayDecide onDecide={noop} />);
    expect(screen.getByText(/open the run to see its approvals/i)).toBeInTheDocument();
    expect(screen.queryByText(/still being drafted/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("the client beat is never decidable here — it says where it happens instead", () => {
    render(
      <RunApprovalRow
        run={run()}
        gates={[gate({ id: "a", status: "decided", decision: "approved" }), gate({ id: "b", kind: "prd_sign", actor_side: "client", status: "pending" })]}
        mayDecide
        onDecide={noop}
      />,
    );
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.getByText(/waiting on client/i)).toBeInTheDocument();
    expect(screen.getByText(/client portal/i)).toBeInTheDocument();
  });
});
