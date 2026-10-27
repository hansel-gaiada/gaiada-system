import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { BrainPicker } from "./BrainPicker";
import { refreshBrainsAction, setThreadBrainAction } from "@/lib/assistantActions";
import type { AssistantThread } from "@/lib/assistant";

vi.mock("@/lib/assistantActions", () => ({ refreshBrainsAction: vi.fn(), setThreadBrainAction: vi.fn() }));

function thread(brainProvider: string | null): AssistantThread {
  return {
    id: "t1", ownerUserId: "u1", title: "T", brainProvider, brainModel: null, hermesSessionId: null, status: "active",
    pinned: false, lastMessageAt: "2026-10-27T09:00:00Z", totalTokens: 0, totalCostUsd: "0.00",
    compactionSummary: null, compactionSummaryUptoSeq: null, createdAt: "2026-10-27T09:00:00Z", updatedAt: "2026-10-27T09:00:00Z",
  };
}
const optionTexts = () => screen.getAllByRole("option").map((o) => o.textContent);

beforeEach(() => {
  vi.mocked(refreshBrainsAction).mockReset();
  vi.mocked(setThreadBrainAction).mockReset().mockResolvedValue({ ok: true });
});

describe("BrainPicker availability (AIP-00c)", () => {
  it("with only openai available: Auto and Cloud (default), nothing else", async () => {
    vi.mocked(refreshBrainsAction).mockResolvedValue({
      ok: true, checkedAt: "x",
      brains: [{ value: "claude", available: false }, { value: "gemini", available: false }, { value: "openai", available: true }],
    });
    render(<BrainPicker thread={thread(null)} disabled={false} onChanged={() => {}} />);
    await waitFor(() => expect(optionTexts()).toEqual(["Auto (failover chain)", "Cloud (default)"]));
    expect(screen.queryByText(/can't be checked/)).not.toBeInTheDocument();
  });

  it("unknown (null) shows Auto plus the muted line", async () => {
    vi.mocked(refreshBrainsAction).mockResolvedValue({ ok: true, brains: null, checkedAt: "x" });
    render(<BrainPicker thread={thread(null)} disabled={false} onChanged={() => {}} />);
    expect(await screen.findByText("Other brains can't be checked right now.")).toBeInTheDocument();
    expect(optionTexts()).toEqual(["Auto (failover chain)"]);
  });

  it("a failed fetch is treated as unknown", async () => {
    vi.mocked(refreshBrainsAction).mockResolvedValue({ ok: false, error: "boom" });
    render(<BrainPicker thread={thread(null)} disabled={false} onChanged={() => {}} />);
    expect(await screen.findByText("Other brains can't be checked right now.")).toBeInTheDocument();
    expect(optionTexts()).toEqual(["Auto (failover chain)"]);
  });

  it("a stored gemini that is unavailable is still the current value, labelled (unavailable)", async () => {
    vi.mocked(refreshBrainsAction).mockResolvedValue({
      ok: true, checkedAt: "x", brains: [{ value: "gemini", available: false }, { value: "openai", available: true }],
    });
    render(<BrainPicker thread={thread("gemini")} disabled={false} onChanged={() => {}} />);
    await waitFor(() => expect(optionTexts()).toContain("Gemini (unavailable)"));
    expect(screen.getByRole("combobox")).toHaveValue("gemini");
    expect(optionTexts()).toEqual(["Auto (failover chain)", "Cloud (default)", "Gemini (unavailable)"]);
  });

  it("choosing an option sends the same hint as before (the provider name)", async () => {
    vi.mocked(refreshBrainsAction).mockResolvedValue({ ok: true, checkedAt: "x", brains: [{ value: "openai", available: true }] });
    const onChanged = vi.fn();
    render(<BrainPicker thread={thread(null)} disabled={false} onChanged={onChanged} />);
    await waitFor(() => expect(optionTexts()).toContain("Cloud (default)"));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "openai" } });
    await waitFor(() => expect(setThreadBrainAction).toHaveBeenCalledWith("t1", "openai"));
    expect(onChanged).toHaveBeenCalledWith({ brainProvider: "openai", hermesSessionId: null });
  });

  it("choosing Auto from an unavailable stored value sends null", async () => {
    vi.mocked(refreshBrainsAction).mockResolvedValue({ ok: true, checkedAt: "x", brains: [{ value: "openai", available: true }] });
    render(<BrainPicker thread={thread("hermes")} disabled={false} onChanged={() => {}} />);
    await waitFor(() => expect(optionTexts()).toContain("Hermes (unavailable)"));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } });
    await waitFor(() => expect(setThreadBrainAction).toHaveBeenCalledWith("t1", null));
  });
});
