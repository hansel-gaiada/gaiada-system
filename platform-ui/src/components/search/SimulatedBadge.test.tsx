import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { SimulatedBadge, ProviderLabel, ProviderModeStatement } from "./SimulatedBadge";

// SM-38 AC: "each rendered field is verified against the controller's actual SELECT and response
// envelope" — these tests pin the chip's PRESENCE and ABSENCE (a surface with no provenance must
// render neither a chip nor a claim) and the vendor label, which is what an operator actually reads
// to avoid blending Semrush/Ahrefs/DataForSEO metrics (design addendum §A2 conflict ruling).

describe("SimulatedBadge", () => {
  it("renders the SIMULATED chip", () => {
    render(<SimulatedBadge />);
    expect(screen.getByText("Simulated")).toBeInTheDocument();
  });

  it("carries a title explaining what simulated means, not just the label", () => {
    render(<SimulatedBadge />);
    expect(screen.getByText("Simulated").closest("span")).toHaveAttribute("title", expect.stringContaining("synthetic"));
  });
});

describe("ProviderLabel", () => {
  it("renders the known vendor's display name for a recognised provider key", () => {
    render(<ProviderLabel provider="dataforseo" />);
    expect(screen.getByText("· DataForSEO")).toBeInTheDocument();
  });

  it("renders semrush and ahrefs distinctly — never blends the two", () => {
    const { unmount } = render(<ProviderLabel provider="semrush" />);
    expect(screen.getByText("· Semrush")).toBeInTheDocument();
    unmount();
    render(<ProviderLabel provider="ahrefs" />);
    expect(screen.getByText("· Ahrefs")).toBeInTheDocument();
  });

  it("falls back to the raw key for an unrecognised provider rather than hiding it", () => {
    render(<ProviderLabel provider="future-vendor" />);
    expect(screen.getByText("· future-vendor")).toBeInTheDocument();
  });

  it("renders nothing — no chip, no claim — when the provider is null", () => {
    const { container } = render(<ProviderLabel provider={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the provider is undefined", () => {
    const { container } = render(<ProviderLabel provider={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("ProviderModeStatement", () => {
  it("states SIMULATED when the mode is simulate", () => {
    render(<ProviderModeStatement mode="simulate" />);
    expect(screen.getByText(/SIMULATED/)).toBeInTheDocument();
  });

  it("states Live when the mode is live", () => {
    render(<ProviderModeStatement mode="live" />);
    expect(screen.getByText(/Live/)).toBeInTheDocument();
  });

  // The honesty invariant this whole ticket is built on: an unknown mode must render as unknown,
  // never default to "Live" (a false claim of realness is the same class of lie as rendering an
  // absent value as 0).
  it("renders an explicit unknown state — never defaults to Live — when the mode is null", () => {
    render(<ProviderModeStatement mode={null} />);
    // Scoped to <strong> — the parent <span>'s own accumulated textContent also contains
    // "unknown", so an unscoped getByText would ambiguously match both.
    expect(screen.getByText(/unknown/i, { selector: "strong" })).toBeInTheDocument();
    expect(screen.queryByText(/^Live$/)).not.toBeInTheDocument();
  });
});
