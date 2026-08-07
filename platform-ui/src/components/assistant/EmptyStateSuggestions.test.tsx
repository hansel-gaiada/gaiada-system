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
