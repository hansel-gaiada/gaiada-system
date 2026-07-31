import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { GscGa4Panel } from "./GscGa4Panel";
import type { GscPerformanceRow, Ga4MetricsRow } from "@/lib/searchMarketingShared";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

// SM-25b's UI — pins the three provenance states (real / simulated / genuinely-empty), the
// per-row GA4 sampling disclosure (never averaged away, never only a footnote), and the absence
// of forbidden money wording ("actual"/"spend"/"cash" never belong on a $0-to-the-deposit surface).

const realGscRow: GscPerformanceRow = {
  id: "gsc-1", date: "2026-07-26", query: "seo tools", page: "https://cedargroup.example.com/tools",
  device: "DESKTOP", clicks: 42, impressions: 980, ctr: 0.0429, position: 8.3, simulated: false, fetchedAt: "2026-07-29T04:00:00Z",
};
const simulatedGscRow: GscPerformanceRow = {
  id: "gsc-3", date: "2026-07-20", query: "cedar group reviews", page: "https://cedargroup.example.com/",
  device: "DESKTOP", clicks: 5, impressions: 60, ctr: 0.0833, position: 3.1, simulated: true, fetchedAt: "2026-07-21T04:00:00Z",
};
const realGa4Row: Ga4MetricsRow = {
  id: "ga4-1", date: "2026-07-26", channelGroup: "Organic Search", sessions: 340, engagedSessions: 210,
  conversions: 12, totalRevenue: 480.5, sampled: false, simulated: false, fetchedAt: "2026-07-29T04:05:00Z",
};
const sampledGa4Row: Ga4MetricsRow = {
  id: "ga4-2", date: "2026-07-26", channelGroup: "Paid Search", sessions: 96, engagedSessions: 40,
  conversions: 3, totalRevenue: 150, sampled: true, simulated: false, fetchedAt: "2026-07-29T04:05:00Z",
};
const noRevenueGa4Row: Ga4MetricsRow = {
  id: "ga4-3", date: "2026-07-26", channelGroup: "Direct", sessions: 58, engagedSessions: 30,
  conversions: 1, totalRevenue: null, sampled: false, simulated: false, fetchedAt: "2026-07-29T04:05:00Z",
};

describe("GscGa4Panel", () => {
  it("genuine emptiness — 'no data pulled yet' for BOTH GSC and GA4, never a flat chart of zeros", () => {
    render(<GscGa4Panel tenantId="t1" engagementId="eng-1" gscRows={[]} topQueries={[]} ga4Rows={[]} canManage={false} />);
    expect(screen.getByText(/No Search Console data pulled yet/i)).toBeInTheDocument();
    expect(screen.getByText(/No GA4 data pulled yet/i)).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("a REAL GSC row carries no Simulated chip; a SIMULATED one does — both in one render", () => {
    render(<GscGa4Panel tenantId="t1" engagementId="eng-1" gscRows={[realGscRow, simulatedGscRow]} topQueries={[]} ga4Rows={[]} canManage={false} />);
    expect(screen.getByText("seo tools")).toBeInTheDocument();
    expect(screen.getByText("cedar group reviews")).toBeInTheDocument();
    expect(screen.getAllByText("Simulated").length).toBe(1);
  });

  it("GSC position renders one decimal place, CTR renders as a percentage", () => {
    render(<GscGa4Panel tenantId="t1" engagementId="eng-1" gscRows={[realGscRow]} topQueries={[]} ga4Rows={[]} canManage={false} />);
    expect(screen.getByText("8.3")).toBeInTheDocument();
    expect(screen.getByText("4.3%")).toBeInTheDocument();
  });

  it("a SAMPLED GA4 row is flagged distinctly from an unsampled one — presence AND absence in one render", () => {
    render(<GscGa4Panel tenantId="t1" engagementId="eng-1" gscRows={[]} topQueries={[]} ga4Rows={[realGa4Row, sampledGa4Row]} canManage={false} />);
    expect(screen.getByText(/▲ sampled/)).toBeInTheDocument();
    // Only the sampled row's cell carries the flag — exactly one occurrence, not both rows.
    expect(screen.getAllByText(/▲ sampled/).length).toBe(1);
  });

  it("absent totalRevenue renders '—', never '0' — 'no revenue configured' is not 'zero revenue'", () => {
    render(<GscGa4Panel tenantId="t1" engagementId="eng-1" gscRows={[]} topQueries={[]} ga4Rows={[noRevenueGa4Row]} canManage={false} />);
    const cells = screen.getAllByText("—");
    expect(cells.length).toBeGreaterThan(0);
    expect(screen.queryByText("$0")).not.toBeInTheDocument();
  });

  it("hides the pull controls when canManage is false, shows them when true", () => {
    const { rerender } = render(<GscGa4Panel tenantId="t1" engagementId="eng-1" gscRows={[]} topQueries={[]} ga4Rows={[]} canManage={false} />);
    expect(screen.queryByText(/Pull Search Console data/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Pull GA4 data/i)).not.toBeInTheDocument();

    rerender(<GscGa4Panel tenantId="t1" engagementId="eng-1" gscRows={[]} topQueries={[]} ga4Rows={[]} canManage={true} />);
    expect(screen.getByText(/Pull Search Console data/i)).toBeInTheDocument();
    expect(screen.getByText(/Pull GA4 data/i)).toBeInTheDocument();
  });

  it("never renders the forbidden money words 'actual', 'spend', or unqualified 'cash' — this surface is $0 to the shared deposit, not a cost-to-serve figure", () => {
    const { container } = render(
      <GscGa4Panel tenantId="t1" engagementId="eng-1" gscRows={[realGscRow, simulatedGscRow]} topQueries={[]} ga4Rows={[realGa4Row, sampledGa4Row, noRevenueGa4Row]} canManage={true} />,
    );
    const text = container.textContent ?? "";
    expect(text.toLowerCase()).not.toMatch(/\bactual\b/);
    expect(text.toLowerCase()).not.toMatch(/\bspend\b/);
    expect(text.toLowerCase()).not.toMatch(/\bcash\b/);
  });

  it("top queries render when provided, with real numbers not strings-as-dashes", () => {
    render(
      <GscGa4Panel
        tenantId="t1" engagementId="eng-1" gscRows={[realGscRow]}
        topQueries={[{ query: "seo tools", clicks: 42, impressions: 980, ctr: 0.0429, position: 8.3 }]}
        ga4Rows={[]} canManage={false}
      />,
    );
    expect(screen.getByText(/Top queries/i)).toBeInTheDocument();
    expect(screen.getAllByText("seo tools").length).toBeGreaterThan(0);
  });
});
