import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { CohortBand } from "./CohortBand";
import type { CohortBandDatum } from "@/lib/appraisals";

// TR-26 adaptation of TR-16's component to the real appraisal-document.ts contract — see this
// component's own header comment for the three deltas from the original placeholder. This test
// covers exactly those deltas plus the two program-wide regression classes named in the ticket
// brief: a suppressed band must never read as a low score, and a percent value must never render
// as its raw 0-1 fraction.
function bandable(overrides: Partial<CohortBandDatum> = {}): CohortBandDatum {
  return {
    metricKey: "delivery.on_time_rate", metricLabel: "On-time rate", unit: "percent",
    subjectValue: 0.864, numerator: 19, denominator: 22, subjectPercentile: 70, band: 4,
    cohortSize: 6, axis: "delivery", informationalOnly: false,
    ...overrides,
  };
}

describe("CohortBand", () => {
  it("formats a percent value as a rounded whole percentage, not the raw fraction (the '0.86' defect class)", () => {
    render(<CohortBand data={bandable()} />);
    // Two renders of the same value are expected — the visible chip AND the always-mounted,
    // visually-hidden `ChartDataFallback` accessible table (same numbers, sr-only twin) — so this
    // asserts both instances read "86%" and NEITHER ever falls back to the raw fraction.
    const matches = screen.getAllByText(/86%/);
    expect(matches.length).toBe(2);
    expect(screen.queryByText("0.864")).not.toBeInTheDocument();
    expect(screen.queryByText("0.86")).not.toBeInTheDocument();
  });

  it("always shows the numerator/denominator for a rate, band or no band (§5.2 point 2)", () => {
    render(<CohortBand data={bandable()} />);
    expect(screen.getByText("(19/22)")).toBeInTheDocument();
  });

  it("a suppressed small-cohort band (band: null) renders as EXPLICITLY suppressed, never as a low score or a blank", () => {
    const suppressed = bandable({ band: null, subjectPercentile: undefined, cohortSize: 3 });
    render(<CohortBand data={suppressed} />);
    expect(screen.getByText(/cohort too small for a band/i)).toBeInTheDocument();
    expect(screen.getByText(/3 in cohort/)).toBeInTheDocument();
    // No "Band N of 5" chip, and nothing reading as a score, when suppressed.
    expect(screen.queryByText(/Band \d of 5/)).not.toBeInTheDocument();
    // The raw rate is still fully honest, denominator and all.
    expect(screen.getByText("(19/22)")).toBeInTheDocument();
    expect(screen.getAllByText(/86%/).length).toBe(2); // visible chip + sr-only fallback table
  });

  it("shows the band chip when the cohort is large enough", () => {
    render(<CohortBand data={bandable({ band: 4 })} />);
    expect(screen.getByText("Band 4 of 5")).toBeInTheDocument();
  });

  it("marks a discipline (informationalOnly) metric distinctly from a weighted-axis metric", () => {
    render(<CohortBand data={bandable({ informationalOnly: true })} />);
    expect(screen.getByText("informational")).toBeInTheDocument();
  });

  it("does not render the marker/percentile at all when the band is suppressed (nothing to plot)", () => {
    const suppressed = bandable({ band: null, subjectPercentile: undefined });
    const { container } = render(<CohortBand data={suppressed} />);
    expect(container.querySelector(".rc-cohort__marker")).toBeNull();
  });
});
