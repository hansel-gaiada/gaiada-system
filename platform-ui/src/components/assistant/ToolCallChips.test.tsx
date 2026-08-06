import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ToolCallChips } from "./ToolCallChips";
import { normalizeLiveToolCall } from "@/lib/assistant";

function chip(status: "succeeded" | "failed" | "denied" | "running") {
  return normalizeLiveToolCall({
    callId: "c1", toolName: "projects.list", args: {}, status, resultSummary: status === "failed" ? "boom" : null,
    approvalId: null, impact: null, intentId: null, expiresAt: null, approval: null, intent: null,
  });
}

describe("ToolCallChips — plain reads/refusals, never a proposal card", () => {
  it("renders nothing for an empty list", () => {
    const { container } = render(<ToolCallChips calls={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a chip per call with its tool name and a humanized status", () => {
    render(<ToolCallChips calls={[chip("succeeded")]} />);
    expect(screen.getByText("projects.list")).toBeInTheDocument();
    expect(screen.getByText("Succeeded")).toBeInTheDocument();
  });

  it("a denied/failed call is visually distinguishable (data-status attribute drives the tier)", () => {
    render(<ToolCallChips calls={[chip("denied")]} />);
    const row = screen.getByLabelText("Tool calls");
    expect(row.querySelector('[data-status="denied"]')).toBeInTheDocument();
  });
});
