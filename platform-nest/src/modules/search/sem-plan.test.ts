// SM-18 — pure unit tests for sem-plan.ts's buildCampaignPlan: determinism, cluster grouping, and
// the provenance rules (§A2 no-blending, §A4.7 provenance-flows-through). No DB, no HTTP — mirrors
// clustering.test.ts's split between pure-function tests and the controller-level integration file
// (search-sem.test.ts).
import { describe, it, expect } from "vitest";
import { buildCampaignPlan, NoClusteredKeywordsError, type PlanKeywordRow } from "./sem-plan";

function kw(overrides: Partial<PlanKeywordRow> & { id: string; keyword: string }): PlanKeywordRow {
  return {
    intent: null, clusterId: null, clusterLabel: null, volume: null, difficulty: null, cpcUsd: null,
    metricsProvider: null, metricsSimulated: false,
    ...overrides,
  };
}

describe("buildCampaignPlan (SM-18)", () => {
  it("throws NoClusteredKeywordsError when every row is unclustered", () => {
    const rows = [kw({ id: "1", keyword: "a" }), kw({ id: "2", keyword: "b" })];
    expect(() => buildCampaignPlan(rows)).toThrow(NoClusteredKeywordsError);
  });

  it("groups by clusterId into one ad group per cluster, skipping unclustered rows", () => {
    const rows = [
      kw({ id: "1", keyword: "running shoes", clusterId: "c1", clusterLabel: "Running Shoes" }),
      kw({ id: "2", keyword: "trail shoes", clusterId: "c1", clusterLabel: "Running Shoes" }),
      kw({ id: "3", keyword: "yoga mats", clusterId: "c2", clusterLabel: "Yoga" }),
      kw({ id: "4", keyword: "unclustered term" }), // clusterId null -> skipped
    ];
    const plan = buildCampaignPlan(rows);
    expect(plan.unclusteredSkipped).toBe(1);
    expect(plan.totalClusteredKeywords).toBe(3);
    expect(plan.adGroups.map((g) => g.clusterId).sort()).toEqual(["c1", "c2"]);
    const g1 = plan.adGroups.find((g) => g.clusterId === "c1")!;
    expect(g1.keywordCount).toBe(2);
    expect(g1.name).toBe("Running Shoes");
    expect(g1.keywordIds).toEqual(["1", "2"]); // preserves input order within the group
  });

  it("falls back to a short cluster-id-derived name when cluster_label is null or blank", () => {
    const rows = [
      kw({ id: "1", keyword: "a", clusterId: "abcdef12-3456-7890-abcd-ef1234567890", clusterLabel: null }),
      kw({ id: "2", keyword: "b", clusterId: "abcdef12-3456-7890-abcd-ef1234567890", clusterLabel: "   " }),
    ];
    const plan = buildCampaignPlan(rows);
    expect(plan.adGroups[0].name).toBe("Cluster abcdef12");
  });

  it("caps keywordSample at MAX_PLAN_KEYWORD_SAMPLE while keywordCount reflects the true total", () => {
    const rows = Array.from({ length: 30 }, (_, i) => kw({ id: `k${i}`, keyword: `kw${i}`, clusterId: "c1", clusterLabel: "Big cluster" }));
    const plan = buildCampaignPlan(rows);
    const g = plan.adGroups[0];
    expect(g.keywordCount).toBe(30);
    expect(g.keywordSample.length).toBe(20); // MAX_PLAN_KEYWORD_SAMPLE
    expect(g.keywordIds.length).toBe(30); // the full id list is NOT truncated
  });

  it("picks the majority non-null intent, alphabetical tie-break, and null when every member is untagged", () => {
    const majority = buildCampaignPlan([
      kw({ id: "1", keyword: "a", clusterId: "c1", intent: "commercial" }),
      kw({ id: "2", keyword: "b", clusterId: "c1", intent: "commercial" }),
      kw({ id: "3", keyword: "c", clusterId: "c1", intent: "informational" }),
    ]).adGroups[0];
    expect(majority.intent).toBe("commercial");

    const tie = buildCampaignPlan([
      kw({ id: "1", keyword: "a", clusterId: "c1", intent: "transactional" }),
      kw({ id: "2", keyword: "b", clusterId: "c1", intent: "commercial" }),
    ]).adGroups[0];
    expect(tie.intent).toBe("commercial"); // alphabetically first among the 1-1 tie

    const untagged = buildCampaignPlan([
      kw({ id: "1", keyword: "a", clusterId: "c1", intent: null }),
      kw({ id: "2", keyword: "b", clusterId: "c1", intent: null }),
    ]).adGroups[0];
    expect(untagged.intent).toBeNull();
  });

  // ── §A2/§A4.7 standing rule: provenance flows through, never blended ──────────────────────────
  describe("keyword-metric provenance (never blended, never coerced)", () => {
    it("lists distinct providers separately and never averages/blends their figures", () => {
      const plan = buildCampaignPlan([
        kw({ id: "1", keyword: "a", clusterId: "c1", metricsProvider: "dataforseo", metricsSimulated: false, volume: 100 }),
        kw({ id: "2", keyword: "b", clusterId: "c1", metricsProvider: "semrush", metricsSimulated: false, volume: 200 }),
        kw({ id: "3", keyword: "c", clusterId: "c1", metricsProvider: "dataforseo", metricsSimulated: false, volume: 150 }),
      ]).adGroups[0];
      // Alphabetically sorted, DISTINCT — never a blended/averaged number is produced anywhere here.
      expect(plan.provenance.providers).toEqual(["dataforseo", "semrush"]);
      expect(plan.provenance.realCount).toBe(3);
      expect(plan.provenance.simulatedCount).toBe(0);
      expect(plan.provenance.unpulledCount).toBe(0);
    });

    it("counts simulated vs real SEPARATELY, never summed into one ambiguous count", () => {
      const plan = buildCampaignPlan([
        kw({ id: "1", keyword: "a", clusterId: "c1", metricsProvider: "dataforseo", metricsSimulated: false }),
        kw({ id: "2", keyword: "b", clusterId: "c1", metricsProvider: "semrush", metricsSimulated: true }),
      ]).adGroups[0];
      expect(plan.provenance.realCount).toBe(1);
      expect(plan.provenance.simulatedCount).toBe(1);
    });

    it("keywords with no metrics pulled yet count as unpulled, never coerced into 'real' or 0", () => {
      const plan = buildCampaignPlan([
        kw({ id: "1", keyword: "a", clusterId: "c1", metricsProvider: null }),
        kw({ id: "2", keyword: "b", clusterId: "c1", metricsProvider: null }),
      ]).adGroups[0];
      expect(plan.provenance.unpulledCount).toBe(2);
      expect(plan.provenance.realCount).toBe(0);
      expect(plan.provenance.simulatedCount).toBe(0);
      expect(plan.provenance.providers).toEqual([]);
    });

    // Mutation probe: deleting the `if (r.metricsProvider === null)` branch in summarizeProvenance
    // (sem-plan.ts) would make this assertion fail — an unpulled keyword would fall through into
    // providers.add(null) / realCount, silently presenting "not yet known" as "known and real".
    it("mutation probe: an unpulled keyword must never contribute to providers/realCount/simulatedCount", () => {
      const plan = buildCampaignPlan([
        kw({ id: "1", keyword: "a", clusterId: "c1", metricsProvider: null, metricsSimulated: false }),
      ]).adGroups[0];
      expect(plan.provenance.providers.length).toBe(0);
      expect(plan.provenance.realCount + plan.provenance.simulatedCount).toBe(0);
      expect(plan.provenance.unpulledCount).toBe(1);
    });
  });

  it("is a pure function of its input: same input order in, identical partition + provenance out", () => {
    const rows: PlanKeywordRow[] = [
      kw({ id: "1", keyword: "a", clusterId: "c1", clusterLabel: "A", metricsProvider: "dataforseo" }),
      kw({ id: "2", keyword: "b", clusterId: "c2", clusterLabel: "B", metricsProvider: "semrush", metricsSimulated: true }),
      kw({ id: "3", keyword: "c", clusterId: "c1", clusterLabel: "A" }),
    ];
    const run1 = buildCampaignPlan(rows);
    const run2 = buildCampaignPlan([...rows]); // fresh array, same order and content
    expect(run2).toEqual(run1);
  });

  it("cross-group ordering is deterministic (name then clusterId) regardless of map insertion order", () => {
    const rows = [
      kw({ id: "1", keyword: "z", clusterId: "zzz", clusterLabel: "Zeta" }),
      kw({ id: "2", keyword: "a", clusterId: "aaa", clusterLabel: "Alpha" }),
    ];
    const plan = buildCampaignPlan(rows);
    expect(plan.adGroups.map((g) => g.name)).toEqual(["Alpha", "Zeta"]);
  });
});
