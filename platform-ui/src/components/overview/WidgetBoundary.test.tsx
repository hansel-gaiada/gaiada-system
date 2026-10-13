import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { WidgetBoundary } from "./WidgetBoundary";

function Throws(): never {
  throw new Error("read failed");
}

afterEach(() => vi.restoreAllMocks());

describe("WidgetBoundary", () => {
  it("renders its children while they work", () => {
    render(<WidgetBoundary title="Pulse"><p>four tiles</p></WidgetBoundary>);
    expect(screen.getByText("four tiles")).toBeInTheDocument();
    expect(screen.queryByText("Unavailable")).not.toBeInTheDocument();
  });

  it("says the block's title and Unavailable when its read throws, never 0 or an empty list", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(<WidgetBoundary title="Needs you"><Throws /></WidgetBoundary>);
    expect(screen.getByRole("heading", { name: "Needs you" })).toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\b0\b/);
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("confines the failure to its own block", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <div>
        <WidgetBoundary title="Pulse"><Throws /></WidgetBoundary>
        <WidgetBoundary title="Projects"><p>two projects</p></WidgetBoundary>
      </div>,
    );
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.getByText("two projects")).toBeInTheDocument();
  });
});
