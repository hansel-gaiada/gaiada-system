// SM-30 — pure unit tests for sem-export.ts's CSV builders + provenance summary. No DB, no HTTP —
// the controller-level e2e (RLS, Cerbos gate, mark-applied state machine, mutation probes) lives in
// search-sem-export.test.ts, same split as sem-plan.test.ts (pure) vs search-sem.test.ts (e2e).
import { describe, it, expect } from "vitest";
import {
  buildAdsBatchExport, buildBidExport, buildBudgetExport, buildLaunchExport, buildNegativesBatchExport, buildPauseExport,
  ExportInputError, summarizeKeywordProvenance, RSA_MAX_HEADLINES, RSA_MAX_DESCRIPTIONS,
  type CampaignFacts, type LaunchKeywordFact, type AdFact, type NegativeFact,
} from "./sem-export";

const campaign: CampaignFacts = { name: "Spring Sale" };
const PROPOSAL_ID = "11111111-2222-3333-4444-555555555555";

function parseCsv(csv: string): string[][] {
  // The builders never emit embedded commas/quotes in these fixtures, so a naive split is safe and
  // keeps these tests independent of the escaping implementation (covered separately below).
  return csv.trim().split("\r\n").map((line) => line.split(","));
}

describe("summarizeKeywordProvenance", () => {
  it("never blends providers, never folds unpulled into real/zero", () => {
    const rows = [
      { metricsProvider: "dataforseo", metricsSimulated: false },
      { metricsProvider: "semrush", metricsSimulated: true },
      { metricsProvider: null, metricsSimulated: false },
    ];
    const s = summarizeKeywordProvenance(rows);
    expect(s.providers).toEqual(["dataforseo", "semrush"]);
    expect(s.realCount).toBe(1);
    expect(s.simulatedCount).toBe(1);
    expect(s.unpulledCount).toBe(1);
  });

  it("empty input reports all-zero, not undefined/NaN", () => {
    const s = summarizeKeywordProvenance([]);
    expect(s).toEqual({ providers: [], simulatedCount: 0, realCount: 0, unpulledCount: 0 });
  });
});

describe("buildLaunchExport", () => {
  const keywords: LaunchKeywordFact[] = [
    { adGroupName: "Shoes", keyword: "running shoes", metricsProvider: "dataforseo", metricsSimulated: false },
    { adGroupName: "Shoes", keyword: "trail shoes", metricsProvider: "dataforseo", metricsSimulated: true },
    { adGroupName: "Boots", keyword: "hiking boots", metricsProvider: null, metricsSimulated: false },
  ];

  it("emits the real Ads Editor Keywords header shape + a trailing per-row provenance column", () => {
    const result = buildLaunchExport(campaign, PROPOSAL_ID, keywords);
    const rows = parseCsv(result.csv);
    expect(rows[0]).toEqual(["Campaign", "Ad group", "Keyword", "Criterion Type", "Notes"]);
    expect(rows).toHaveLength(4); // header + 3 keywords
    // Every data row carries the campaign name, its own ad group, keyword, and a Broad default.
    for (const row of rows.slice(1)) {
      expect(row[0]).toBe("Spring Sale");
      expect(row[3]).toBe("Broad");
    }
  });

  it("HONESTY CHANNEL 1 — the per-row Notes column tells real/simulated/unpulled apart, never blended", () => {
    const result = buildLaunchExport(campaign, PROPOSAL_ID, keywords);
    const rows = parseCsv(result.csv);
    const notesByKeyword = new Map(rows.slice(1).map((r) => [r[2], r[4]]));
    expect(notesByKeyword.get("running shoes")).toMatch(/verified market data/);
    expect(notesByKeyword.get("trail shoes")).toMatch(/SIMULATED/);
    expect(notesByKeyword.get("hiking boots")).toMatch(/not yet pulled/);
  });

  it("HONESTY CHANNEL 2 — the API response provenance summary matches the underlying rows exactly", () => {
    const result = buildLaunchExport(campaign, PROPOSAL_ID, keywords);
    expect(result.provenance).toEqual({ providers: ["dataforseo"], simulatedCount: 1, realCount: 1, unpulledCount: 1 });
  });

  it("HONESTY CHANNEL 3 — filename carries -SIMULATED whenever any row is simulated, never when none are", () => {
    const withSimulated = buildLaunchExport(campaign, PROPOSAL_ID, keywords);
    expect(withSimulated.filename).toMatch(/-SIMULATED\.csv$/);

    const allReal: LaunchKeywordFact[] = [
      { adGroupName: "Shoes", keyword: "running shoes", metricsProvider: "dataforseo", metricsSimulated: false },
    ];
    const clean = buildLaunchExport(campaign, PROPOSAL_ID, allReal);
    expect(clean.filename).not.toMatch(/SIMULATED/);
  });

  it("a leading comment row is never emitted — row 0 is always the real header, never shifted", () => {
    // Regression guard for the file header's own design decision: Ads Editor treats row 0 as the
    // header row, so a prepended comment line would silently shift the real header into a data row.
    const result = buildLaunchExport(campaign, PROPOSAL_ID, keywords);
    expect(result.csv.startsWith("Campaign,Ad group,Keyword,Criterion Type,Notes\r\n")).toBe(true);
  });
});

describe("buildPauseExport", () => {
  it("Campaign status = Paused, no provenance claim (not data-informed)", () => {
    const result = buildPauseExport(campaign, PROPOSAL_ID);
    expect(parseCsv(result.csv)).toEqual([["Campaign", "Campaign status"], ["Spring Sale", "Paused"]]);
    expect(result.provenance).toBeNull();
  });
});

describe("buildBudgetExport", () => {
  it("converts minor units to a 2-decimal major-unit string", () => {
    const result = buildBudgetExport(campaign, PROPOSAL_ID, { budgetMinor: 150050, currency: "USD" });
    expect(parseCsv(result.csv)).toEqual([["Campaign", "Campaign daily budget"], ["Spring Sale", "1500.50"]]);
  });

  it("refuses (ExportInputError) rather than emit a budget row with no usable number", () => {
    expect(() => buildBudgetExport(campaign, PROPOSAL_ID, { budgetMinor: NaN, currency: "USD" })).toThrow(ExportInputError);
  });
});

describe("buildBidExport", () => {
  it("blank cells for absent fields, never a fabricated 0", () => {
    const result = buildBidExport(campaign, PROPOSAL_ID, { bidStrategy: "target_cpa", targetCpaMinor: 250000, targetRoas: null });
    const rows = parseCsv(result.csv);
    expect(rows[1]).toEqual(["Spring Sale", "target_cpa", "2500.00", ""]);
  });

  it("refuses when every field is absent", () => {
    expect(() => buildBidExport(campaign, PROPOSAL_ID, { bidStrategy: null, targetCpaMinor: null, targetRoas: null })).toThrow(ExportInputError);
  });
});

describe("buildNegativesBatchExport", () => {
  it("campaign-level vs ad-group-level negatives get the documented Type prefix + match-type suffix", () => {
    const negatives: NegativeFact[] = [
      { adGroupName: null, term: "free", matchType: "phrase" },
      { adGroupName: "Shoes", term: "repair jobs", matchType: "exact" },
    ];
    const result = buildNegativesBatchExport(campaign, PROPOSAL_ID, negatives);
    const rows = parseCsv(result.csv);
    expect(rows[0]).toEqual(["Campaign", "Ad group", "Keyword", "Criterion Type"]);
    expect(rows[1]).toEqual(["Spring Sale", "", "free", "Campaign Negative Phrase"]);
    expect(rows[2]).toEqual(["Spring Sale", "Shoes", "repair jobs", "Negative Exact"]);
  });

  it("refuses an empty resolved list rather than emit a header-only 'successful' export of nothing", () => {
    expect(() => buildNegativesBatchExport(campaign, PROPOSAL_ID, [])).toThrow(ExportInputError);
  });
});

describe("buildAdsBatchExport", () => {
  it("pads headlines/descriptions to the full RSA column count, blank never fabricated text", () => {
    const ads: AdFact[] = [{ adGroupName: "Shoes", headlines: ["Great Shoes", "Shop Now"], descriptions: ["Free shipping."], finalUrl: "https://example.com" }];
    const result = buildAdsBatchExport(campaign, PROPOSAL_ID, ads);
    const rows = parseCsv(result.csv);
    expect(rows[0]).toHaveLength(2 + RSA_MAX_HEADLINES + RSA_MAX_DESCRIPTIONS + 4); // Campaign,Ad group + H1-15 + D1-4 + Final URL,Path1,Path2,Ad status
    const dataRow = rows[1];
    expect(dataRow[2]).toBe("Great Shoes");
    expect(dataRow[3]).toBe("Shop Now");
    expect(dataRow[4]).toBe(""); // Headline 3 blank, never invented
    expect(dataRow[2 + RSA_MAX_HEADLINES]).toBe("Free shipping."); // Description line 1
    expect(dataRow[2 + RSA_MAX_HEADLINES + 1]).toBe(""); // Description line 2 blank
    expect(dataRow.at(-1)).toBe("Enabled");
    expect(dataRow.at(-2)).toBe(""); // Path 2
  });

  it("refuses an empty resolved list", () => {
    expect(() => buildAdsBatchExport(campaign, PROPOSAL_ID, [])).toThrow(ExportInputError);
  });
});

describe("CSV escaping (embedded commas/quotes/newlines never corrupt column alignment)", () => {
  it("a keyword containing a comma stays inside its own cell", () => {
    const keywords: LaunchKeywordFact[] = [
      { adGroupName: "A, B", keyword: 'running "trail" shoes, wide', metricsProvider: null, metricsSimulated: false },
    ];
    const result = buildLaunchExport(campaign, PROPOSAL_ID, keywords);
    // A real CSV parser (not the naive splitter used elsewhere in this file) round-trips it correctly.
    expect(result.csv).toContain('"A, B"');
    expect(result.csv).toContain('"running ""trail"" shoes, wide"');
  });
});
