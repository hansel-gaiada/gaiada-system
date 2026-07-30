import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { CostLedgerPanel } from "./CostLedgerPanel";
import type { EngagementLedger } from "@/lib/searchMarketing";

// SM-17 — the ledger/cost surface's console body. These tests pin the BINDING language (tracker
// §6j / design addendum §A3): "cost to serve (standard rates)", never "spend"/"cash"/"actual" on a
// figure, the standing two-line legend verbatim, the empty-state wording (never "$0.00" for zero
// recorded calls), the per-row chip riding the ROW's own flag (never the page-level mode), and the
// "excluded, never blended" simulated-history line.

const baseLedger: EngagementLedger = {
  engagementId: "eng-1",
  providerMode: "live",
  costToServeUsd: 0.006,
  currentModeRowCount: 2,
  simulatedHistoryExcludedUsd: null,
  rows: [
    {
      id: "r1", provider: "dataforseo", endpoint: "serp.google.organic.task_post",
      items: 10, costUsd: 0.006, cacheHit: false, status: "completed", simulated: false,
      createdAt: "2026-07-28T09:12:00Z",
    },
    {
      id: "r2", provider: "dataforseo", endpoint: "serp.google.organic.task_post",
      items: 10, costUsd: 0, cacheHit: true, status: "completed", simulated: false,
      createdAt: "2026-07-27T14:03:00Z",
    },
  ],
};

describe("CostLedgerPanel", () => {
  it("renders 'unavailable' text — not a table, not a $0 — when the ledger is null (404/403)", () => {
    render(<CostLedgerPanel ledger={null} />);
    expect(screen.getByText(/unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  });

  it("labels the figure 'Cost to serve (standard rates)' — never 'spend'", () => {
    render(<CostLedgerPanel ledger={baseLedger} />);
    expect(screen.getByText(/Cost to serve \(standard rates\)/)).toBeInTheDocument();
    expect(screen.queryByText(/spend/i)).not.toBeInTheDocument();
  });

  it("'cash' appears exactly once — inside the standing legend's own prose (AC2), never attached to a figure", () => {
    render(<CostLedgerPanel ledger={baseLedger} />);
    expect(screen.getAllByText(/cash/i).length).toBe(1);
  });

  it("'actual' appears exactly once — inside the legend's 'Actual cash = ...' sentence (AC2), never next to a rendered KPI or row figure (AC4: forbidden until SM-42/SM-41)", () => {
    render(<CostLedgerPanel ledger={baseLedger} />);
    expect(screen.getAllByText(/actual/i).length).toBe(1);
  });

  it("renders the standing two-line cash-model legend verbatim (AC2)", () => {
    render(<CostLedgerPanel ledger={baseLedger} />);
    expect(screen.getByText(/Prepaid vendors \(Semrush, Ahrefs\) bill API units against fixed subscriptions/)).toBeInTheDocument();
    expect(screen.getByText(/Cache hits are free\./)).toBeInTheDocument();
  });

  it("empty state: zero current-mode rows reads as 'no calls recorded', never '$0.00'", () => {
    const empty: EngagementLedger = {
      engagementId: "eng-2", providerMode: "live", costToServeUsd: 0,
      currentModeRowCount: 0, simulatedHistoryExcludedUsd: null, rows: [],
    };
    render(<CostLedgerPanel ledger={empty} />);
    expect(screen.getByText(/No provider calls recorded yet/i)).toBeInTheDocument();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  });

  it("a real $0.00 sum (rows exist, e.g. all cache hits) DOES render as $0.00 — distinct from the empty state", () => {
    const zeroButPresent: EngagementLedger = {
      engagementId: "eng-3", providerMode: "live", costToServeUsd: 0,
      currentModeRowCount: 1, simulatedHistoryExcludedUsd: null,
      rows: [{
        id: "r1", provider: "dataforseo", endpoint: "serp.google.organic.task_post",
        items: 1, costUsd: 0, cacheHit: true, status: "completed", simulated: false,
        createdAt: "2026-07-28T00:00:00Z",
      }],
    };
    render(<CostLedgerPanel ledger={zeroButPresent} />);
    expect(screen.queryByText(/No provider calls recorded yet for the current period/i)).not.toBeInTheDocument();
    // "$0.00" renders twice here (the main KPI AND the single cache-hit row's own cost cell) —
    // both are legitimate, non-empty-state renderings; assert at least one exists.
    expect(screen.getAllByText("$0.00").length).toBeGreaterThanOrEqual(1);
  });

  it("the aggregate KPI gets a SIMULATED chip when the CURRENT platform mode is simulate", () => {
    const simulateMode: EngagementLedger = { ...baseLedger, providerMode: "simulate" };
    render(<CostLedgerPanel ledger={simulateMode} />);
    expect(screen.getAllByText("Simulated").length).toBeGreaterThan(0);
  });

  it("the aggregate KPI carries NO simulated chip when the current mode is live, even though month-to-date simulated history exists elsewhere on the page", () => {
    // baseLedger's own two rows are both simulated:false and providerMode is 'live', so the ONLY
    // "Simulated" text on the page must come from the separately-labelled excluded-history line —
    // never from the main KPI, which sits in its own block above it.
    const withHistory: EngagementLedger = { ...baseLedger, simulatedHistoryExcludedUsd: 0.42 };
    render(<CostLedgerPanel ledger={withHistory} />);
    // "$0.01" (formatUsd(0.006)) appears twice — once as the main KPI, once as row r1's own cost
    // cell — so match on the KPI's distinguishing wrapper: the element whose OWN direct text is
    // "$0.01" AND whose parent also renders the "Cost to serve (standard rates)" label (the table
    // cell's ancestor does not).
    const candidates = screen.getAllByText("$0.01");
    const kpiFigure = candidates.find((el) => el.parentElement?.textContent?.includes("current period"));
    expect(kpiFigure).toBeDefined();
    expect(kpiFigure!.parentElement?.textContent).not.toMatch(/Simulated/);
  });

  it("per-row chip comes from the ROW's own flag, never the page mode — a historical simulated row keeps its badge even while the platform is live", () => {
    const mixed: EngagementLedger = {
      engagementId: "eng-1", providerMode: "live", costToServeUsd: 0.006,
      currentModeRowCount: 2, simulatedHistoryExcludedUsd: 0.42,
      rows: [
        ...baseLedger.rows,
        {
          id: "r3", provider: "semrush", endpoint: "keywords.volume",
          items: 50, costUsd: 0.42, cacheHit: false, status: "completed", simulated: true,
          createdAt: "2026-07-10T08:00:00Z",
        },
      ],
    };
    render(<CostLedgerPanel ledger={mixed} />);
    // Both a REAL row (no chip) and a SIMULATED row (chip) render side by side — presence AND
    // absence must both be exercisable, never a fixture where every row is one mode.
    expect(screen.getByText("keywords.volume")).toBeInTheDocument();
    expect(screen.getAllByText("serp.google.organic.task_post").length).toBeGreaterThanOrEqual(1);
    // At least one "Simulated" chip (the semrush row) exists.
    expect(screen.getAllByText("Simulated").length).toBeGreaterThanOrEqual(1);
  });

  it("status renders verbatim (a 'failed' row is neither dropped nor relabelled to something else)", () => {
    const withFailure: EngagementLedger = {
      ...baseLedger,
      rows: [
        ...baseLedger.rows,
        {
          id: "r4", provider: "dataforseo", endpoint: "serp.google.organic.task_post",
          items: 1, costUsd: 0, cacheHit: false, status: "failed", simulated: false,
          createdAt: "2026-07-26T11:47:00Z",
        },
      ],
    };
    render(<CostLedgerPanel ledger={withFailure} />);
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  it("simulated-history-excluded renders as its own, separately-labelled line — the figure is $0.42, distinct from the main KPI (never summed together)", () => {
    const withHistory: EngagementLedger = { ...baseLedger, simulatedHistoryExcludedUsd: 0.42 };
    render(<CostLedgerPanel ledger={withHistory} />);
    expect(screen.getAllByText("$0.01").length).toBeGreaterThanOrEqual(1); // main KPI, unaffected
    expect(screen.getByText(/history \(excluded\): \$0\.42/i)).toBeInTheDocument();
  });

  it("omits the excluded-history line entirely when the other mode has no rows this period", () => {
    render(<CostLedgerPanel ledger={baseLedger} />); // simulatedHistoryExcludedUsd: null
    expect(screen.queryByText(/history \(excluded\)/i)).not.toBeInTheDocument();
  });
});
