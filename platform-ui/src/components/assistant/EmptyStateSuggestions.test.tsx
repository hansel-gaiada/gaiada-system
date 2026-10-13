import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { EmptyStateSuggestions } from "./EmptyStateSuggestions";

// 2026-08-07 owner fix — a brand-new chat used to dump the raw tool catalogue (`activity.feed`,
// `workActivity.relink`, developer-facing prose) as the first thing anyone saw. This pins the
// replacement: human-readable action tiles, none of which leak a dot-namespaced tool identifier,
// plus one explicit escape hatch back to the full catalogue.
describe("EmptyStateSuggestions", () => {
  it("renders human-readable tiles — no raw tool identifiers", () => {
    render(<EmptyStateSuggestions onPick={vi.fn()} onOpenCapabilities={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Ask about your projects" })).toBeInTheDocument();
    expect(screen.queryByText(/\w+\.\w+/)).not.toBeInTheDocument(); // no "namespace.tool" shaped text
  });

  it("clicking a suggestion hands its full prompt text to onPick — never calls onOpenCapabilities", () => {
    const onPick = vi.fn();
    const onOpenCapabilities = vi.fn();
    render(<EmptyStateSuggestions onPick={onPick} onOpenCapabilities={onOpenCapabilities} />);
    fireEvent.click(screen.getByRole("button", { name: "Ask about your projects" }));
    expect(onPick).toHaveBeenCalledWith("What's the status of my active projects right now?");
    expect(onOpenCapabilities).not.toHaveBeenCalled();
  });

  it("the 'see everything I can do' tile is the escape hatch to the full catalogue, not a prompt", () => {
    const onPick = vi.fn();
    const onOpenCapabilities = vi.fn();
    render(<EmptyStateSuggestions onPick={onPick} onOpenCapabilities={onOpenCapabilities} />);
    fireEvent.click(screen.getByRole("button", { name: "See everything I can do" }));
    expect(onOpenCapabilities).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });
});

// DW-2h — opened from a department, the tiles are that department's prompts (the registry's data).
describe("EmptyStateSuggestions — department prompts", () => {
  const prompts = [
    { label: "Summarise this week's requests", prompt: "Summarise this week's requests to the team." },
    { label: "What is blocked on the board?", prompt: "Which tasks are blocked?" },
    { label: "Draft a client update", prompt: "Draft a short update for the client about " },
  ];

  it("shows the department's prompts instead of today's, and keeps the escape hatch", () => {
    render(<EmptyStateSuggestions onPick={vi.fn()} onOpenCapabilities={vi.fn()} prompts={prompts} />);
    expect(screen.getByRole("button", { name: "Summarise this week's requests" })).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(prompts.length + 1);
    expect(screen.queryByRole("button", { name: "Ask about your projects" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "See everything I can do" })).toBeInTheDocument();
  });

  it("a department tile only pre-fills: it hands its prompt to onPick and nothing else", () => {
    const onPick = vi.fn();
    const onOpenCapabilities = vi.fn();
    render(<EmptyStateSuggestions onPick={onPick} onOpenCapabilities={onOpenCapabilities} prompts={prompts} />);
    fireEvent.click(screen.getByRole("button", { name: "Draft a client update" }));
    expect(onPick).toHaveBeenCalledWith("Draft a short update for the client about ");
    expect(onOpenCapabilities).not.toHaveBeenCalled();
  });

  it("without a department (null, absent or empty) today's suggestions show", () => {
    for (const p of [null, undefined, []] as const) {
      const { unmount } = render(<EmptyStateSuggestions onPick={vi.fn()} onOpenCapabilities={vi.fn()} prompts={p} />);
      expect(screen.getByRole("button", { name: "Ask about your projects" })).toBeInTheDocument();
      expect(screen.getAllByRole("button")).toHaveLength(5);
      unmount();
    }
  });
});
