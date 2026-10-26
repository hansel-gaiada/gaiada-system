import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ApprovalRow } from "./ApprovalRow";
import { approveRefusalSentence, type UnifiedApprovalItem } from "@/lib/approvalsShared";

// PGL-05/06 (PERMISSION-CONTRACT §52): the inbox row shows WHY Approve is refused for this viewer, from the server's
// typed `approveRefusal`, instead of offering a button that answers 403.
function item(over: Partial<UnifiedApprovalItem> = {}): UnifiedApprovalItem {
  return {
    id: "a-1", origin: "agent", tenantId: "t-1", company: "Gaia Test Co", subject: "Issue invoice INV-1",
    createdAt: "2026-10-26T00:00:00Z", ageMs: 60_000, urgencyScore: 1, decidable: true, status: "pending", ...over,
  };
}

describe("ApprovalRow — the approve refusal (PV-D46)", () => {
  it("self_approval: Approve is disabled, the sentence explains it, and Deny stays available", () => {
    const onDecide = vi.fn();
    render(<ApprovalRow item={item({ approveRefusal: "self_approval" })} mode="pending" onDecide={onDecide} />);
    const approve = screen.getByRole("button", { name: "Approve" });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAttribute("aria-describedby", "approve-refusal-a-1");
    expect(screen.getByText(/from you or from an agent acting for you/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled();
  });

  it("countersign_right_required names the countersign right", () => {
    render(<ApprovalRow item={item({ approveRefusal: "countersign_right_required" })} mode="pending" onDecide={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByText(/right to countersign this contract yourself/i)).toBeInTheDocument();
  });

  it("no refusal (null or absent from an older backend): Approve is enabled and no sentence is shown", () => {
    const { rerender } = render(<ApprovalRow item={item({ approveRefusal: null })} mode="pending" onDecide={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    rerender(<ApprovalRow item={item()} mode="pending" onDecide={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(screen.queryByText(/you can't approve this/i)).not.toBeInTheDocument();
  });

  it("an unknown future reason still disables Approve, with a generic sentence", () => {
    render(<ApprovalRow item={item({ approveRefusal: "some_new_rule" })} mode="pending" onDecide={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(approveRefusalSentence("some_new_rule")).toMatch(/some new rule/);
  });
});
