// SM-22 — unit tests for reports.ts's pure rendering/disclosure functions. No DB, no HTTP — the
// controller e2e (search-reports.test.ts) covers the assembly + persistence side.
import { describe, it, expect } from "vitest";
import {
  hasAnySimulated,
  isAllSimulated,
  periodDateRange,
  renderReportMarkdown,
  reportFilename,
  summarizeSimulated,
  type ReportRenderInput,
} from "./reports";

function baseInput(overrides: Partial<ReportRenderInput> = {}): ReportRenderInput {
  return {
    reportId: "11111111-2222-3333-4444-555555555555",
    engagementName: "Acme SEO",
    clientName: "Acme Corp",
    period: "2026-07",
    kind: "monthly",
    narrativeMd: "Great month.",
    frozen: { rankTop10: 5, criticalFindingsOpen: 2, kpiTargets: [] },
    rank: null,
    audit: { auditsCompleted: 0 },
    gsc: { present: false, totalClicks: 0, totalImpressions: 0, topQueries: [], provenance: { real: 0, simulated: 0 }, latestDate: null, lagDays: 3 },
    ga4: { present: false, totalSessions: 0, totalConversions: 0, provenance: { real: 0, simulated: 0 }, anySampled: false },
    ads: { present: false, totalClientSpendMinor: 0, currency: null, totalClicks: 0, totalImpressions: 0, provenance: { real: 0, simulated: 0 } },
    generatedAt: "2026-07-31T00:00:00.000Z",
    ...overrides,
  };
}

describe("summarizeSimulated / hasAnySimulated / isAllSimulated", () => {
  it("tallies real vs simulated rows", () => {
    const p = summarizeSimulated([{ simulated: false }, { simulated: true }, { simulated: false }]);
    expect(p).toEqual({ real: 2, simulated: 1 });
  });
  it("empty rows -> {real:0, simulated:0}, neither helper true", () => {
    const p = summarizeSimulated([]);
    expect(p).toEqual({ real: 0, simulated: 0 });
    expect(hasAnySimulated(p)).toBe(false);
    expect(isAllSimulated(p)).toBe(false);
  });
  it("all-simulated only when simulated>0 AND real===0", () => {
    expect(isAllSimulated({ real: 0, simulated: 3 })).toBe(true);
    expect(isAllSimulated({ real: 1, simulated: 3 })).toBe(false);
    expect(hasAnySimulated({ real: 1, simulated: 3 })).toBe(true);
  });
});

describe("periodDateRange", () => {
  it("resolves a YYYY-MM period to that calendar month, inclusive", () => {
    expect(periodDateRange("2026-02", new Date("2026-03-15"))).toEqual({ start: "2026-02-01", end: "2026-02-28" });
  });
  it("resolves a leap-year February correctly", () => {
    expect(periodDateRange("2024-02", new Date("2024-03-01"))).toEqual({ start: "2024-02-01", end: "2024-02-29" });
  });
  it("falls back to the trailing 30 days ending fallbackEnd for a non-YYYY-MM period", () => {
    const r = periodDateRange("Q3 2026 ad-hoc", new Date(Date.UTC(2026, 6, 31)));
    expect(r.end).toBe("2026-07-31");
    expect(r.start).toBe("2026-07-01");
  });
});

describe("reportFilename", () => {
  it("never carries -SIMULATED when nothing simulated", () => {
    const f = reportFilename("11111111-aaaa-bbbb-cccc-222222222222", "2026-07", "monthly", false);
    expect(f).toBe("seo-report-monthly-2026-07-11111111.md");
    expect(f).not.toMatch(/SIMULATED/);
  });
  it("carries -SIMULATED whenever any simulated figure is present", () => {
    const f = reportFilename("11111111-aaaa-bbbb-cccc-222222222222", "2026-07", "monthly", true);
    expect(f).toMatch(/-SIMULATED\.md$/);
  });
  it("strips unsafe characters out of a free-form ad-hoc period", () => {
    const f = reportFilename("11111111-aaaa-bbbb-cccc-222222222222", "Q3/2026 (draft)", "adhoc", false);
    expect(f).toMatch(/^seo-report-adhoc-Q32026draft-11111111\.md$/);
  });
});

describe("renderReportMarkdown — honesty rules", () => {
  it("renders NO banner and no [SIMULATED]/[MIXED] tags when every present section is real", () => {
    const input = baseInput({
      rank: { provenance: { real: 4, simulated: 0 }, asOf: "2026-07-31T00:00:00.000Z" },
    });
    const { markdown, anySimulated, allSimulated } = renderReportMarkdown(input);
    expect(anySimulated).toBe(false);
    expect(allSimulated).toBe(false);
    expect(markdown).not.toMatch(/SIMULATED DATA/);
    expect(markdown).not.toMatch(/MIXED DATA/);
    expect(markdown).not.toMatch(/\[SIMULATED\]/);
  });

  it("renders the top-of-document SIMULATED banner (beside the numbers, not a footnote) when every section is simulated", () => {
    const input = baseInput({
      rank: { provenance: { real: 0, simulated: 4 }, asOf: "2026-07-31T00:00:00.000Z" },
      gsc: { present: true, totalClicks: 10, totalImpressions: 100, topQueries: [], provenance: { real: 0, simulated: 2 }, latestDate: "2026-07-20", lagDays: 3 },
    });
    const { markdown, anySimulated, allSimulated } = renderReportMarkdown(input);
    expect(anySimulated).toBe(true);
    expect(allSimulated).toBe(true);
    // The banner must appear before the first data section (## Summary), not after it.
    const bannerIdx = markdown.indexOf("SIMULATED DATA");
    const summaryIdx = markdown.indexOf("## Summary");
    expect(bannerIdx).toBeGreaterThan(-1);
    expect(bannerIdx).toBeLessThan(summaryIdx);
    expect(markdown).toMatch(/\[SIMULATED\]/);
  });

  it("renders the MIXED banner (never the ALL-simulated one) when only some sections are simulated", () => {
    const input = baseInput({
      rank: { provenance: { real: 3, simulated: 1 }, asOf: "2026-07-31T00:00:00.000Z" },
    });
    const { markdown, anySimulated, allSimulated } = renderReportMarkdown(input);
    expect(anySimulated).toBe(true);
    expect(allSimulated).toBe(false);
    expect(markdown).toMatch(/MIXED DATA/);
    expect(markdown).not.toMatch(/SIMULATED DATA\./);
  });

  it("never emits our vendor cost-to-serve figure (no 'cost_usd'/'cost-to-serve' string anywhere)", () => {
    const { markdown } = renderReportMarkdown(baseInput());
    expect(markdown).not.toMatch(/cost_usd/i);
    expect(markdown).not.toMatch(/cost-to-serve/i);
  });

  it("labels Ads spend explicitly as the client's own money, never a platform fee", () => {
    const input = baseInput({
      ads: { present: true, totalClientSpendMinor: 12345, currency: "USD", totalClicks: 50, totalImpressions: 900, provenance: { real: 1, simulated: 0 } },
    });
    const { markdown } = renderReportMarkdown(input);
    expect(markdown).toMatch(/Your media spend/);
    expect(markdown).toMatch(/123\.45 USD/);
    expect(markdown).toMatch(/not a platform service fee/);
  });

  describe("empty is not zero", () => {
    it("no rank snapshots at all -> explicit 'no data' line, never a 0 count", () => {
      const { markdown } = renderReportMarkdown(baseInput({ rank: null }));
      expect(markdown).toMatch(/No rank-tracking data collected yet/);
    });
    it("zero completed audits -> 'no audits' line, not '0 critical findings'", () => {
      const { markdown } = renderReportMarkdown(baseInput({ audit: { auditsCompleted: 0 } }));
      expect(markdown).toMatch(/No technical audits completed yet/);
      expect(markdown).not.toMatch(/Open critical findings/);
    });
    it("no GSC rows -> 'no data pulled', never a rendered 0-click table", () => {
      const { markdown } = renderReportMarkdown(baseInput());
      expect(markdown).toMatch(/No Search Console data pulled for this period/);
    });
    it("no GA4 rows -> 'no data pulled'", () => {
      const { markdown } = renderReportMarkdown(baseInput());
      expect(markdown).toMatch(/No Analytics data pulled for this period/);
    });
    it("no Ads rows -> 'no data available'", () => {
      const { markdown } = renderReportMarkdown(baseInput());
      expect(markdown).toMatch(/No advertising data available for this period/);
    });
    it("no KPI targets -> explicit empty line, no empty table", () => {
      const { markdown } = renderReportMarkdown(baseInput());
      expect(markdown).toMatch(/No KPI targets set for this engagement/);
    });
  });

  it("discloses GSC freshness lag beside the clicks/impressions numbers, using the shared constant", () => {
    const input = baseInput({
      gsc: { present: true, totalClicks: 500, totalImpressions: 8000, topQueries: [{ query: "acme shoes", clicks: 40, impressions: 300 }], provenance: { real: 1, simulated: 0 }, latestDate: "2026-07-28", lagDays: 3 },
    });
    const { markdown } = renderReportMarkdown(input);
    const clicksIdx = markdown.indexOf("Clicks:");
    const lagIdx = markdown.indexOf("lags 3");
    expect(clicksIdx).toBeGreaterThan(-1);
    expect(lagIdx).toBeGreaterThan(clicksIdx);
    expect(markdown).toMatch(/acme shoes/);
  });

  it("discloses GA4 sampling inline, not only in a page footer", () => {
    const input = baseInput({
      ga4: { present: true, totalSessions: 200, totalConversions: 5, provenance: { real: 1, simulated: 0 }, anySampled: true },
    });
    const { markdown } = renderReportMarkdown(input);
    expect(markdown).toMatch(/sampled.*estimates, not exact counts/is);
  });

  it("names the missing PDF layer as a real gap, not silently", () => {
    const { markdown } = renderReportMarkdown(baseInput());
    expect(markdown).toMatch(/PDF layer is not yet built/);
  });

  it("filename matches the returned allSimulated/anySimulated state", () => {
    const allSim = renderReportMarkdown(baseInput({ rank: { provenance: { real: 0, simulated: 2 }, asOf: "x" } }));
    expect(allSim.filename).toMatch(/-SIMULATED\.md$/);
    const noSim = renderReportMarkdown(baseInput());
    expect(noSim.filename).not.toMatch(/SIMULATED/);
  });
});
