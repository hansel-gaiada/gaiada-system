import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ProvenanceBreakdown } from "./CampaignProvenance";
import type { KeywordProvenanceSummary } from "@/lib/searchMarketingShared";

// SM-47 — pins the binding provenance discipline (design addendum §A2/§A4.7, tracker §6q):
// three distinct states (real / simulated / unpulled), providers listed distinctly (never
// blended/averaged), and no forbidden money wording anywhere on this surface.

function prov(overrides: Partial<KeywordProvenanceSummary> = {}): KeywordProvenanceSummary {
  return { providers: [], simulatedCount: 0, realCount: 0, unpulledCount: 0, ...overrides };
}

describe("ProvenanceBreakdown", () => {
  it("renders all three states — real, simulated, unpulled — even when the counts are honest zeros", () => {
    render(<ProvenanceBreakdown provenance={prov({ providers: ["dataforseo"], realCount: 6, simulatedCount: 0, unpulledCount: 0 })} />);
    expect(screen.getByText("6")).toBeInTheDocument();
    expect(screen.getByText(/real/)).toBeInTheDocument();
    // Both "0 simulated" and "0 not yet pulled" must still be VISIBLE — a state with a real zero
    // count is a different claim from an unknown value, so it must render as an honest 0, not
    // disappear (a missing bucket would read as "this group has no unpulled keywords" when the
    // truth might be "we don't distinguish here" — three buckets must always be present).
    expect(screen.getByText(/simulated/)).toBeInTheDocument();
    expect(screen.getByText(/not yet pulled/)).toBeInTheDocument();
  });

  it("never collapses 'unpulled' into either real or simulated — a mixed group shows all three distinctly", () => {
    render(<ProvenanceBreakdown provenance={prov({ providers: ["dataforseo", "ahrefs"], realCount: 2, simulatedCount: 2, unpulledCount: 1 })} />);
    // realCount and simulatedCount are BOTH "2" — assert both appear (two <strong>2</strong> nodes)
    // and the unpulled bucket ("1") is a THIRD, separate number, not folded into either.
    expect(screen.getAllByText("2", { selector: "strong" })).toHaveLength(2);
    expect(screen.getByText("1", { selector: "strong" })).toBeInTheDocument();
  });

  it("shows the SIMULATED badge only when simulatedCount is greater than zero", () => {
    const { rerender } = render(<ProvenanceBreakdown provenance={prov({ realCount: 6 })} />);
    expect(screen.queryByText("Simulated")).not.toBeInTheDocument();
    rerender(<ProvenanceBreakdown provenance={prov({ simulatedCount: 2, realCount: 2 })} />);
    expect(screen.getByText("Simulated")).toBeInTheDocument();
  });

  it("lists two distinct providers separately — never blended into one string", () => {
    render(<ProvenanceBreakdown provenance={prov({ providers: ["dataforseo", "ahrefs"], realCount: 2, simulatedCount: 2 })} />);
    // Each provider gets its OWN "· Vendor" chip (ProviderLabel, reused verbatim from SM-38) —
    // asserting both appear as separate text nodes proves they are not averaged/joined into one
    // "DataForSEO, Ahrefs" string, which would read as a single blended figure.
    expect(screen.getByText("· DataForSEO")).toBeInTheDocument();
    expect(screen.getByText("· Ahrefs")).toBeInTheDocument();
  });

  it("renders no provider chips when the group has no pulled metrics at all", () => {
    render(<ProvenanceBreakdown provenance={prov({ unpulledCount: 3 })} />);
    expect(screen.queryByText(/Providers/)).not.toBeInTheDocument();
    expect(screen.getByText("3", { selector: "strong" })).toBeInTheDocument();
  });

  it("renders a plain empty note, not a zero-valued table, for a genuinely empty ad group", () => {
    render(<ProvenanceBreakdown provenance={prov()} />);
    expect(screen.getByText("No keywords in this ad group")).toBeInTheDocument();
  });

  it("never renders the forbidden word 'actual' anywhere on this surface", () => {
    const { container } = render(
      <ProvenanceBreakdown provenance={prov({ providers: ["dataforseo", "ahrefs"], realCount: 2, simulatedCount: 2, unpulledCount: 1 })} />,
    );
    expect(container.textContent?.toLowerCase()).not.toContain("actual");
  });

  it("never renders the word 'spend' — this is a provenance surface, not a money one", () => {
    const { container } = render(
      <ProvenanceBreakdown provenance={prov({ providers: ["dataforseo"], realCount: 6 })} />,
    );
    expect(container.textContent?.toLowerCase()).not.toContain("spend");
  });
});
