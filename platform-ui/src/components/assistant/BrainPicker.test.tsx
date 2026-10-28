import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { BrainPicker } from "./BrainPicker";
import { refreshBrainsAction, setThreadBrainAction } from "@/lib/assistantActions";
import type { AssistantThread } from "@/lib/assistant";

vi.mock("@/lib/assistantActions", () => ({ refreshBrainsAction: vi.fn(), setThreadBrainAction: vi.fn() }));

function thread(brainProvider: string | null, brainTier: AssistantThread["brainTier"] = null): AssistantThread {
  return {
    id: "t1", ownerUserId: "u1", title: "T", brainProvider, brainTier, brainModel: null, hermesSessionId: null, status: "active",
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
      ok: true, checkedAt: "x", tiers: [],
      brains: [{ value: "claude", available: false }, { value: "gemini", available: false }, { value: "openai", available: true }],
    });
    render(<BrainPicker thread={thread(null)} disabled={false} onChanged={() => {}} />);
    await waitFor(() => expect(optionTexts()).toEqual(["Auto (failover chain)", "Cloud (default)"]));
    expect(screen.queryByText(/can't be checked/)).not.toBeInTheDocument();
  });

  it("unknown (null) shows Auto plus the muted line", async () => {
    vi.mocked(refreshBrainsAction).mockResolvedValue({ ok: true, brains: null, tiers: null, checkedAt: "x" });
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
      ok: true, checkedAt: "x", tiers: [], brains: [{ value: "gemini", available: false }, { value: "openai", available: true }],
    });
    render(<BrainPicker thread={thread("gemini")} disabled={false} onChanged={() => {}} />);
    await waitFor(() => expect(optionTexts()).toContain("Gemini (unavailable)"));
    expect(screen.getByRole("combobox")).toHaveValue("provider:gemini");
    expect(optionTexts()).toEqual(["Auto (failover chain)", "Cloud (default)", "Gemini (unavailable)"]);
  });

  it("choosing a provider sends {brainProvider} and clears the tier locally", async () => {
    vi.mocked(refreshBrainsAction).mockResolvedValue({ ok: true, checkedAt: "x", tiers: [], brains: [{ value: "openai", available: true }] });
    const onChanged = vi.fn();
    render(<BrainPicker thread={thread(null)} disabled={false} onChanged={onChanged} />);
    await waitFor(() => expect(optionTexts()).toContain("Cloud (default)"));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "provider:openai" } });
    await waitFor(() => expect(setThreadBrainAction).toHaveBeenCalledWith("t1", { brainProvider: "openai" }));
    expect(onChanged).toHaveBeenCalledWith({ brainProvider: "openai", brainTier: null, hermesSessionId: null });
  });

  it("choosing Auto from an unavailable stored provider sends both null", async () => {
    vi.mocked(refreshBrainsAction).mockResolvedValue({ ok: true, checkedAt: "x", tiers: [], brains: [{ value: "openai", available: true }] });
    render(<BrainPicker thread={thread("hermes")} disabled={false} onChanged={() => {}} />);
    await waitFor(() => expect(optionTexts()).toContain("Hermes (unavailable)"));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } });
    await waitFor(() => expect(setThreadBrainAction).toHaveBeenCalledWith("t1", { brainProvider: null, brainTier: null }));
  });
});

describe("BrainPicker tiers (AIP-08a)", () => {
  const brains = [{ value: "openai", available: true }];
  const load = (tiers: string[] | null, b: typeof brains | null = brains) =>
    vi.mocked(refreshBrainsAction).mockResolvedValue({ ok: true, checkedAt: "x", brains: b, tiers });

  it("all three tiers reported: Auto, Fast, Strong, then the providers; Standard is not offered", async () => {
    load(["fast", "standard", "strong"]);
    render(<BrainPicker thread={thread(null)} disabled={false} onChanged={() => {}} />);
    await waitFor(() => expect(optionTexts()).toEqual(["Auto (failover chain)", "Fast", "Strong", "Cloud (default)"]));
  });

  it("only the reported tiers are offered", async () => {
    load(["fast", "standard"]);
    render(<BrainPicker thread={thread(null)} disabled={false} onChanged={() => {}} />);
    await waitFor(() => expect(optionTexts()).toEqual(["Auto (failover chain)", "Fast", "Cloud (default)"]));
  });

  it("no tiers configured offers no tier", async () => {
    load([]);
    render(<BrainPicker thread={thread(null)} disabled={false} onChanged={() => {}} />);
    await waitFor(() => expect(optionTexts()).toEqual(["Auto (failover chain)", "Cloud (default)"]));
  });

  it("unknown tiers (null) offers no tier and shows the muted line", async () => {
    load(null, null);
    render(<BrainPicker thread={thread(null)} disabled={false} onChanged={() => {}} />);
    expect(await screen.findByText("Other brains can't be checked right now.")).toBeInTheDocument();
    expect(optionTexts()).toEqual(["Auto (failover chain)"]);
  });

  it("a stored standard tier is the current choice, labelled Standard", async () => {
    load(["fast", "standard", "strong"]);
    render(<BrainPicker thread={thread(null, "standard")} disabled={false} onChanged={() => {}} />);
    await waitFor(() => expect(optionTexts()).toEqual(["Auto (failover chain)", "Fast", "Strong", "Standard", "Cloud (default)"]));
    expect(screen.getByRole("combobox")).toHaveValue("tier:standard");
  });

  it("a stored tier the gateway no longer reports is labelled (unavailable)", async () => {
    load(["fast"]);
    render(<BrainPicker thread={thread(null, "strong")} disabled={false} onChanged={() => {}} />);
    await waitFor(() => expect(optionTexts()).toContain("Strong (unavailable)"));
    expect(screen.getByRole("combobox")).toHaveValue("tier:strong");
  });

  it("a stored fast with unknown tiers is shown as (unavailable), never hidden", async () => {
    load(null, null);
    render(<BrainPicker thread={thread(null, "fast")} disabled={false} onChanged={() => {}} />);
    await waitFor(() => expect(optionTexts()).toContain("Fast (unavailable)"));
  });

  it("choosing Fast PATCHes {brainTier} only and updates the thread optimistically", async () => {
    load(["fast", "standard", "strong"]);
    const onChanged = vi.fn();
    render(<BrainPicker thread={thread(null)} disabled={false} onChanged={onChanged} />);
    await waitFor(() => expect(optionTexts()).toContain("Fast"));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "tier:fast" } });
    await waitFor(() => expect(setThreadBrainAction).toHaveBeenCalledWith("t1", { brainTier: "fast" }));
    expect(onChanged).toHaveBeenCalledWith({ brainTier: "fast", brainProvider: null, hermesSessionId: null });
  });

  it("choosing a provider while a tier is stored PATCHes {brainProvider} only", async () => {
    load(["fast"]);
    const onChanged = vi.fn();
    render(<BrainPicker thread={thread(null, "fast")} disabled={false} onChanged={onChanged} />);
    await waitFor(() => expect(optionTexts()).toContain("Cloud (default)"));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "provider:openai" } });
    await waitFor(() => expect(setThreadBrainAction).toHaveBeenCalledWith("t1", { brainProvider: "openai" }));
    expect(onChanged).toHaveBeenCalledWith({ brainProvider: "openai", brainTier: null, hermesSessionId: null });
  });

  it("choosing Auto from a tier PATCHes both to null", async () => {
    load(["fast", "strong"]);
    const onChanged = vi.fn();
    render(<BrainPicker thread={thread(null, "strong")} disabled={false} onChanged={onChanged} />);
    await waitFor(() => expect(screen.getByRole("combobox")).toHaveValue("tier:strong"));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } });
    await waitFor(() => expect(setThreadBrainAction).toHaveBeenCalledWith("t1", { brainProvider: null, brainTier: null }));
    expect(onChanged).toHaveBeenCalledWith({ brainProvider: null, brainTier: null, hermesSessionId: null });
  });

  it("a tier and a provider named alike never collide", async () => {
    vi.mocked(refreshBrainsAction).mockResolvedValue({ ok: true, checkedAt: "x", tiers: ["fast"], brains: [] });
    render(<BrainPicker thread={thread("fast")} disabled={false} onChanged={() => {}} />);
    await waitFor(() => expect(screen.getAllByRole("option").map((o) => (o as HTMLOptionElement).value)).toEqual(["", "tier:fast", "provider:fast"]));
  });

  it("a failed PATCH restores the previous brain and shows the error", async () => {
    load(["fast"]);
    vi.mocked(setThreadBrainAction).mockResolvedValue({ ok: false, error: "nope" });
    const onChanged = vi.fn();
    render(<BrainPicker thread={thread("hermes", null)} disabled={false} onChanged={onChanged} />);
    await waitFor(() => expect(optionTexts()).toContain("Fast"));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "tier:fast" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("nope");
    expect(onChanged).toHaveBeenLastCalledWith({ brainProvider: "hermes", brainTier: null, hermesSessionId: null });
  });

  it("shows the help line linked to the select, keeps the label, and is disabled while generating", async () => {
    load(["fast", "strong"]);
    render(<BrainPicker thread={thread(null)} disabled={true} onChanged={() => {}} />);
    const help = await screen.findByText("Fast is quicker and cheaper; Strong is for harder questions.");
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-describedby", help.id);
    expect(screen.getByRole("combobox")).toBeDisabled();
    expect(screen.getByLabelText("Brain")).toBe(screen.getByRole("combobox"));
  });
});
