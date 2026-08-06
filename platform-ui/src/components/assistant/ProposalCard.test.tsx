import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ProposalCard } from "./ProposalCard";
import { normalizeLiveToolCall, normalizeThreadToolCall, type NormalizedToolCall, type ThreadToolCall } from "@/lib/assistant";
import { confirmWriteAction, dismissWriteAction } from "@/lib/assistantActions";

// T4 (ASST-23, §7.2) — the confirm chip's own component tests. Mocks the two server actions rather
// than driving a real backend: this file exists to prove the CARD'S rendering/state logic (which
// button shows when, what the confirm/dismiss click actually sends and does with the response), not
// the endpoints themselves (those are T3b/T5's job, against a live stack).
vi.mock("@/lib/assistantActions", () => ({
  confirmWriteAction: vi.fn(),
  dismissWriteAction: vi.fn(),
}));

function draft(over: Partial<ThreadToolCall> = {}): NormalizedToolCall {
  const persisted: ThreadToolCall = {
    id: "tc1", toolName: "pm.createTask", mcpServer: "mcp-hub",
    args: { title: "[redacted:string]", projectId: "[redacted:string]" },
    resultSummary: null, status: "pending", approvalId: null, durationMs: null, createdAt: "2026-08-06T09:00:00Z",
    approval: null, intent: { status: "draft", expiresAt: "2026-08-06T10:00:00Z" },
    ...over,
  };
  return normalizeThreadToolCall(persisted);
}

beforeEach(() => {
  vi.mocked(confirmWriteAction).mockReset();
  vi.mocked(dismissWriteAction).mockReset();
});

describe("ProposalCard — awaiting_confirmation renders Confirm/Dismiss, redacted args, never real values", () => {
  it("shows the tool name, the shape-only redacted args, and both action buttons", () => {
    render(<ProposalCard call={draft()} threadId="t1" />);
    expect(screen.getByText("pm.createTask")).toBeInTheDocument();
    expect(screen.getByText("title")).toBeInTheDocument();
    expect(screen.getAllByText("[redacted:string]").length).toBe(2); // one per redacted key — never a real value
    expect(screen.getByRole("button", { name: /Confirm write/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Dismiss write/ })).toBeInTheDocument();
    // Never a real value on the page — the wire never carried one to begin with.
    expect(screen.queryByText(/demo-project-1/)).not.toBeInTheDocument();
  });

  it("a terminal card (already executed) renders NO Confirm/Dismiss buttons, only a link", () => {
    const executed = draft({ approvalId: "a1", intent: null, approval: { status: "approved", executionStatus: "executed", executionError: null } });
    render(<ProposalCard call={executed} threadId="t1" />);
    expect(screen.queryByRole("button", { name: /Confirm write/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Dismiss write/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View in Approvals/ })).toHaveAttribute("href", "/approvals/a1");
  });
});

describe("ProposalCard — confirm sends NO args, and the response becomes the immediate local state", () => {
  it("clicking Confirm calls confirmWriteAction(threadId, callId) with no third argument, and flips to sent_for_approval", async () => {
    vi.mocked(confirmWriteAction).mockResolvedValue({
      ok: true, intentId: "i1", status: "filed", approvalId: "a1",
      approval: { status: "pending", executionStatus: "not_applicable", executionError: null },
    });
    render(<ProposalCard call={draft()} threadId="t1" />);
    fireEvent.click(screen.getByRole("button", { name: /Confirm write/ }));
    await waitFor(() => expect(screen.getByText("Sent for approval")).toBeInTheDocument());
    expect(confirmWriteAction).toHaveBeenCalledTimes(1);
    expect(confirmWriteAction).toHaveBeenCalledWith("t1", "tc1");
    // The card is now decided — Confirm/Dismiss must be GONE, not merely disabled (a disabled
    // Confirm would imply a click would still do something, which is false once filed).
    expect(screen.queryByRole("button", { name: /Confirm write/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View in Approvals/ })).toHaveAttribute("href", "/approvals/a1");
  });

  it("clicking Dismiss calls dismissWriteAction and flips to dismissed, with no link (never filed)", async () => {
    vi.mocked(dismissWriteAction).mockResolvedValue({ ok: true, intentId: "i1", status: "dismissed", approvalId: null, approval: null });
    render(<ProposalCard call={draft()} threadId="t1" />);
    fireEvent.click(screen.getByRole("button", { name: /Dismiss write/ }));
    await waitFor(() => expect(screen.getByText("Dismissed")).toBeInTheDocument());
    expect(dismissWriteAction).toHaveBeenCalledWith("t1", "tc1");
    expect(screen.queryByRole("link", { name: /View in Approvals/ })).not.toBeInTheDocument();
  });

  it("a failed confirm shows the error and leaves the card actionable — no silent state change", async () => {
    vi.mocked(confirmWriteAction).mockResolvedValue({ ok: false, error: "cannot confirm: this write proposal is 'expired'", status: 409 });
    render(<ProposalCard call={draft()} threadId="t1" />);
    fireEvent.click(screen.getByRole("button", { name: /Confirm write/ }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/expired/));
    // Still awaiting confirmation locally — the failed attempt did not fabricate a state change.
    expect(screen.getByText("Awaiting your confirmation")).toBeInTheDocument();
  });

  it("a fresher prop update (e.g. from a reload) wins over a stale local override", () => {
    // Regression guard for the override-masking trap named in ProposalCard's own header: once the
    // PROP itself reports a state other than awaiting_confirmation, the local override must never
    // paper over it.
    const executed = draft({ approvalId: "a1", intent: null, approval: { status: "approved", executionStatus: "executed", executionError: null } });
    render(<ProposalCard call={executed} threadId="t1" />);
    expect(screen.getByText("Approved and executed")).toBeInTheDocument();
  });
});

describe("ProposalCard — a11y: keyboard-operable actions with clear, disambiguating names", () => {
  it("Confirm/Dismiss are real <button> elements with a name naming the specific tool", () => {
    render(<ProposalCard call={draft({ toolName: "pm.createDoc" })} threadId="t1" />);
    expect(screen.getByRole("button", { name: "Confirm write: pm.createDoc — send for approval" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss write: pm.createDoc — do not send it" })).toBeInTheDocument();
  });
});

// Exercise the LiveToolCall normalization path too — the SAME component, fed the SSE-shaped input.
describe("ProposalCard — also renders from a normalized LiveToolCall (mid-stream shape)", () => {
  it("renders a live confirm-required draft identically to the persisted equivalent", () => {
    const live = normalizeLiveToolCall({
      callId: "c1", toolName: "pm.createTask", args: { title: "[redacted:string]" }, status: "pending",
      resultSummary: null, approvalId: null, impact: "high", intentId: "i1", expiresAt: "2026-08-06T10:00:00Z",
      approval: null, intent: { status: "draft" },
    });
    render(<ProposalCard call={live} threadId="t1" />);
    expect(screen.getByText("high impact")).toBeInTheDocument();
    expect(screen.getByText("Awaiting your confirmation")).toBeInTheDocument();
  });
});
