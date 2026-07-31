import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { WarningsBanner } from "./WarningsBanner";
import type { ReportHeader } from "@/lib/reports";

function header(warnings: ReportHeader["warnings"]): ReportHeader {
  return {
    tenantId: "t1", grain: "person", scopeRef: "u1", scopeName: "Test Person",
    periodKind: "custom", periodStart: "2026-06-01", periodEnd: "2026-07-30",
    dayCount: 60, periodLabel: "1 Jun – 30 Jul 2026", generatedAt: new Date().toISOString(),
    sealed: false, warnings,
  };
}

describe("WarningsBanner — silence would be a lie of omission (§7)", () => {
  it("renders nothing when there are no warnings", () => {
    const { container } = render(<WarningsBanner header={header(undefined)} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when warnings is an empty object", () => {
    const { container } = render(<WarningsBanner header={header({})} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the ad-hoc/unsealed message", () => {
    render(<WarningsBanner header={header({ adHoc: true })} />);
    expect(screen.getByText(/Ad hoc · unsealed/)).toBeInTheDocument();
  });

  it("renders the partial-period message", () => {
    render(<WarningsBanner header={header({ partialPeriod: true })} />);
    expect(screen.getByText(/Partial period/)).toBeInTheDocument();
  });

  it("renders the ends-in-future message", () => {
    render(<WarningsBanner header={header({ endsInFuture: true })} />);
    expect(screen.getByText(/Ends in the future/)).toBeInTheDocument();
  });

  it("renders the precedes-fact-history message WITH the affected day count", () => {
    render(<WarningsBanner header={header({ precedesFactHistory: { firstFactDate: "2026-07-01", affectedDays: 12 } })} />);
    expect(screen.getByText(/2026-07-01/)).toBeInTheDocument();
    expect(screen.getByText(/12 day/)).toBeInTheDocument();
  });

  it("renders the spans-membership-change message", () => {
    render(<WarningsBanner header={header({ spansMembershipChange: true })} />);
    expect(screen.getByText(/membership change/)).toBeInTheDocument();
  });

  it("renders every flag at once when several are set", () => {
    render(<WarningsBanner header={header({ adHoc: true, partialPeriod: true, endsInFuture: true })} />);
    expect(screen.getByText(/Ad hoc/)).toBeInTheDocument();
    expect(screen.getByText(/Partial period/)).toBeInTheDocument();
    expect(screen.getByText(/Ends in the future/)).toBeInTheDocument();
  });
});
