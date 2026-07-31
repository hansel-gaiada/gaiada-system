import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { PaidActionGate } from "./PaidActionGate";
import type { CostProjectionTool } from "@/lib/searchMarketingShared";

// SM-19 — the pre-commit disclosure for a metered provider pull. Pins the four honesty rules the
// ticket names: real-vs-simulated is unmissable and backend-sourced; a projection is captioned an
// ESTIMATE, never a charge; a single-provider capability (serp/ai_visibility) renders a disabled,
// reasoned fact rather than a picker; an unavailable provider never reads as "$0.00".

function tool(overrides: Partial<CostProjectionTool> = {}): CostProjectionTool {
  return {
    tool: "rank", opKind: "serp", enabled: true, cadence: "weekly", scheduled: true,
    runsPerMonth: 4.2857, itemsPerRun: 50, costPerRunUsd: 2.5, projectedMonthlyUsd: 10.71,
    provider: "dataforseo", simulated: false,
    ...overrides,
  };
}

describe("PaidActionGate", () => {
  it("does not disclose anything until the trigger is clicked (the commit-time gate, not a page-level banner)", () => {
    render(
      <PaidActionGate tool="rank" projection={tool()} providerMode="live" overBudget={false}
        triggerLabel="Pull ranks now" confirmLabel="Confirm" onConfirm={() => {}} />,
    );
    expect(screen.getByText("Pull ranks now")).toBeInTheDocument();
    expect(screen.queryByText(/Estimated cost/i)).not.toBeInTheDocument();
  });

  it("reveals provider, cost-as-ESTIMATE, and a live-mode disclosure at the moment of committing", () => {
    render(
      <PaidActionGate tool="rank" projection={tool()} providerMode="live" overBudget={false}
        triggerLabel="Pull ranks now" confirmLabel="Confirm — pull ranks" onConfirm={() => {}} />,
    );
    fireEvent.click(screen.getByText("Pull ranks now"));
    expect(screen.getAllByText(/DataForSEO/).length).toBeGreaterThan(0);
    expect(screen.getByText(/\$2\.50/)).toBeInTheDocument();
    expect(screen.getByText(/an estimate — not a charge/i)).toBeInTheDocument();
    // "actual" is the forbidden word on a projection (addendum §A3) — "charge" only ever appears
    // inside the explicit negation above ("not a charge"), never asserting the figure IS one.
    expect(screen.queryByText(/actual/i)).not.toBeInTheDocument();
    expect(screen.getByText(/real, billable request/i)).toBeInTheDocument();
  });

  it("a SIMULATED tool states plainly this run will NOT place a real call — unmissable, not a footnote", () => {
    render(
      <PaidActionGate tool="rank" projection={tool({ simulated: true })} providerMode="simulate" overBudget={false}
        triggerLabel="Pull ranks now" confirmLabel="Confirm" onConfirm={() => {}} />,
    );
    fireEvent.click(screen.getByText("Pull ranks now"));
    expect(screen.getByText(/will NOT place a real vendor call/i)).toBeInTheDocument();
    expect(screen.getByText("Simulated")).toBeInTheDocument();
  });

  it("an unavailable provider (resolveProvider threw) reads 'Unavailable', never $0.00, and disables confirm", () => {
    render(
      <PaidActionGate
        tool="rank"
        projection={tool({ provider: null, costPerRunUsd: 0, note: "no provider available to estimate (NoCapableProviderError)" })}
        providerMode="live" overBudget={false}
        triggerLabel="Pull ranks now" confirmLabel="Confirm" onConfirm={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("Pull ranks now"));
    expect(screen.getByText(/Unavailable/)).toBeInTheDocument();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
    expect(screen.getByText("Confirm").closest("button")).toBeDisabled();
  });

  it("a single-provider capability (rank/serp) renders a disabled, reasoned fact — no dropdown of alternatives", () => {
    render(
      <PaidActionGate tool="rank" projection={tool()} providerMode="live" overBudget={false}
        triggerLabel="Pull ranks now" confirmLabel="Confirm" onConfirm={() => {}} />,
    );
    fireEvent.click(screen.getByText("Pull ranks now"));
    expect(screen.getByText(/only provider this capability may use/i)).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("an over-budget engagement warns before the click, naming what it cannot see", () => {
    render(
      <PaidActionGate tool="rank" projection={tool()} providerMode="live" overBudget={true}
        triggerLabel="Pull ranks now" confirmLabel="Confirm" onConfirm={() => {}} />,
    );
    fireEvent.click(screen.getByText("Pull ranks now"));
    expect(screen.getByRole("alert")).toHaveTextContent(/exceeds its budget cap/i);
    expect(screen.getByRole("alert")).toHaveTextContent(/kill switch/i);
  });

  it("an unanswered cost-projection (undefined) is disclosed as UNKNOWN, never defaulted to free or real", () => {
    render(
      <PaidActionGate tool="rank" projection={undefined} providerMode={null} overBudget={false}
        triggerLabel="Pull ranks now" confirmLabel="Confirm" onConfirm={() => {}} />,
    );
    fireEvent.click(screen.getByText("Pull ranks now"));
    expect(screen.getByText(/UNKNOWN for this action/i)).toBeInTheDocument();
  });

  it("cancel returns to the idle trigger without confirming", () => {
    const onConfirm = vi.fn();
    render(
      <PaidActionGate tool="rank" projection={tool()} providerMode="live" overBudget={false}
        triggerLabel="Pull ranks now" confirmLabel="Confirm" onConfirm={onConfirm} />,
    );
    fireEvent.click(screen.getByText("Pull ranks now"));
    fireEvent.click(screen.getByText("Cancel"));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByText(/Estimated cost/i)).not.toBeInTheDocument();
  });

  it("confirm invokes onConfirm exactly once and closes the disclosure", () => {
    const onConfirm = vi.fn();
    render(
      <PaidActionGate tool="rank" projection={tool()} providerMode="live" overBudget={false}
        triggerLabel="Pull ranks now" confirmLabel="Confirm — pull ranks" onConfirm={onConfirm} />,
    );
    fireEvent.click(screen.getByText("Pull ranks now"));
    fireEvent.click(screen.getByText("Confirm — pull ranks"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Estimated cost/i)).not.toBeInTheDocument();
  });
});
