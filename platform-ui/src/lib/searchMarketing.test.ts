import { describe, it, expect } from "vitest";
import {
  isToggleEnabled,
  formatUsd,
  engagementStatusTone,
  CAPABILITY_TOGGLE,
  toggleLimit,
  patchToolScope,
  isProjectionOverBudget,
  isScopePreset,
  SCOPE_PRESET_SEEDS,
  numberOrDash,
  groupFindingsBySeverity,
  groupKeywordsByCluster,
  keywordVolumeState,
  formatVolume,
  anyEnabledToolSimulated,
  numOrNull,
  CAMPAIGN_STATUSES_WRITABLE,
  AD_STATUSES_WRITABLE,
  NEGATIVE_STATUSES_WRITABLE,
  CHANGE_PROPOSAL_TRANSITIONS,
  type ToolScopeConfig,
  type AuditFinding,
  type SearchKeyword,
  type CostProjectionTool,
} from "./searchMarketing";

// Pure-helper tests only — no network. skipUnavailable/platformFetch (the
// networked half of this module) are exercised by the pages that call them,
// not here.

describe("isToggleEnabled", () => {
  // The backend refuses dispatch identically for an absent toggle and an
  // explicit `enabled: false` (D-11) — so the console MUST treat the two the
  // same, and this equivalence is the one property worth locking down.
  it("is true only for an explicit enabled: true", () => {
    const scope: ToolScopeConfig = { rank: { enabled: true } };
    expect(isToggleEnabled(scope, "rank")).toBe(true);
  });

  it("is false when the toggle key is absent entirely", () => {
    const scope: ToolScopeConfig = {};
    expect(isToggleEnabled(scope, "rank")).toBe(false);
  });

  it("is false when the toggle entry exists but has no enabled field", () => {
    const scope: ToolScopeConfig = { rank: {} };
    expect(isToggleEnabled(scope, "rank")).toBe(false);
  });

  it("is false when the toggle is explicitly disabled", () => {
    const scope: ToolScopeConfig = { rank: { enabled: false } };
    expect(isToggleEnabled(scope, "rank")).toBe(false);
  });

  it("treats absent and explicitly-disabled as identical", () => {
    const absent = isToggleEnabled({}, "rank");
    const disabled = isToggleEnabled({ rank: { enabled: false } }, "rank");
    expect(absent).toBe(disabled);
  });
});

describe("formatUsd", () => {
  it("renders null as an em dash", () => {
    expect(formatUsd(null)).toBe("—");
  });

  it("renders undefined as an em dash", () => {
    expect(formatUsd(undefined)).toBe("—");
  });

  it("renders zero as an explicit $0.00, not an em dash", () => {
    // Zero is a real, known answer ("this engagement costs nothing"); only
    // null/undefined ("we don't know") should collapse to the dash.
    expect(formatUsd(0)).toBe("$0.00");
  });

  it("formats a fractional amount to two decimal places", () => {
    expect(formatUsd(12.5)).toBe("$12.50");
  });
  // Regression: Postgres numeric arrives as a STRING. An un-cast endpoint used to crash the
  // engagements page with "n.toFixed is not a function" — formatUsd must coerce, and must still
  // refuse to invent a number for genuinely non-numeric input.
  it("coerces a numeric-as-string without crashing, and refuses junk", () => {
    expect(formatUsd("12.500000")).toBe("$12.50");
    expect(formatUsd("0")).toBe("$0.00");
    expect(formatUsd("")).toBe("—");
    expect(formatUsd("not-a-number")).toBe("—");
  });
});

describe("toggleLimit", () => {
  // rank/volume/suggestions cap via maxKeywords (the backend's real field — see
  // ToolScopeToggle's header note on the earlier `limit` drift).
  it("reads maxKeywords for rank", () => {
    expect(toggleLimit({ enabled: true, maxKeywords: 50 }, "rank")).toBe(50);
  });

  it("reads maxQueries for ai_visibility, not maxKeywords", () => {
    expect(toggleLimit({ enabled: true, maxQueries: 10, maxKeywords: 999 }, "ai_visibility")).toBe(10);
  });

  it("is undefined for backlinks — no cap field exists for that tool", () => {
    expect(toggleLimit({ enabled: true, maxKeywords: 50 }, "backlinks")).toBeUndefined();
  });

  it("is undefined when the toggle is absent entirely", () => {
    expect(toggleLimit(undefined, "rank")).toBeUndefined();
  });

  it("is undefined for a non-numeric value rather than throwing or coercing", () => {
    expect(toggleLimit({ enabled: true, maxKeywords: "fifty" as unknown as number }, "rank")).toBeUndefined();
  });
});

describe("patchToolScope", () => {
  it("updates only the named tool's fields, preserving other toggles untouched", () => {
    const scope: ToolScopeConfig = {
      rank: { enabled: true, cadence: "weekly" },
      audit_technical: { enabled: true, cadence: "monthly" },
    };
    const next = patchToolScope(scope, "rank", { enabled: false });
    expect(next.rank).toEqual({ enabled: false, cadence: "weekly" });
    expect(next.audit_technical).toEqual({ enabled: true, cadence: "monthly" });
  });

  it("creates the tool's entry when it was absent, without disturbing siblings", () => {
    const scope: ToolScopeConfig = { volume: { enabled: true } };
    const next = patchToolScope(scope, "backlinks", { enabled: true, cadence: "monthly" });
    expect(next.backlinks).toEqual({ enabled: true, cadence: "monthly" });
    expect(next.volume).toEqual({ enabled: true });
  });

  it("does not mutate the input scope object", () => {
    const scope: ToolScopeConfig = { rank: { enabled: false } };
    patchToolScope(scope, "rank", { enabled: true });
    expect(scope.rank).toEqual({ enabled: false });
  });
});

describe("isProjectionOverBudget", () => {
  it("is true when the projected total exceeds the budget", () => {
    expect(isProjectionOverBudget(50, 42.5)).toBe(true);
  });

  it("is false when the projected total is within budget", () => {
    expect(isProjectionOverBudget(30, 42.5)).toBe(false);
  });

  it("coerces numeric-as-string inputs (Postgres numeric over the wire)", () => {
    expect(isProjectionOverBudget("50.000000", "42.500000")).toBe(true);
  });

  it("never claims over-budget when either side is unresolvable", () => {
    expect(isProjectionOverBudget(undefined, 42.5)).toBe(false);
    expect(isProjectionOverBudget(50, null)).toBe(false);
    expect(isProjectionOverBudget("not-a-number", 42.5)).toBe(false);
  });
});

describe("isScopePreset", () => {
  it("accepts the four documented values", () => {
    expect(isScopePreset("light")).toBe(true);
    expect(isScopePreset("standard")).toBe(true);
    expect(isScopePreset("heavy")).toBe(true);
    expect(isScopePreset("custom")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isScopePreset("aggressive")).toBe(false);
    expect(isScopePreset(undefined)).toBe(false);
    expect(isScopePreset(42)).toBe(false);
  });
});

describe("SCOPE_PRESET_SEEDS", () => {
  // Mirrors platform-nest scope-presets.ts's SEEDED_PRESETS — this pins the shape so a future
  // edit to either side surfaces as a failing test instead of a silently wrong what-if preview.
  it("standard seeds rank at 50 keywords/weekly and leaves backlinks off", () => {
    expect(SCOPE_PRESET_SEEDS.standard.rank).toEqual({ enabled: true, cadence: "weekly", maxKeywords: 50 });
    expect(SCOPE_PRESET_SEEDS.standard.backlinks).toEqual({ enabled: false });
  });

  it("heavy enables backlinks and doubles rank's cap over standard", () => {
    expect(SCOPE_PRESET_SEEDS.heavy.backlinks).toEqual({ enabled: true, cadence: "monthly" });
    expect(SCOPE_PRESET_SEEDS.heavy.rank).toEqual({ enabled: true, cadence: "daily", maxKeywords: 200 });
  });

  it("light disables every paid pull and keeps only the free crawler audits on", () => {
    expect(SCOPE_PRESET_SEEDS.light.rank).toEqual({ enabled: false });
    expect(SCOPE_PRESET_SEEDS.light.volume).toEqual({ enabled: false });
    expect(SCOPE_PRESET_SEEDS.light.ai_visibility).toEqual({ enabled: false });
    expect(SCOPE_PRESET_SEEDS.light.audit_technical).toEqual({ enabled: true, cadence: "monthly" });
  });
});

describe("engagementStatusTone", () => {
  it("active is ok", () => {
    expect(engagementStatusTone("active")).toBe("ok");
  });

  it("paused is warn", () => {
    expect(engagementStatusTone("paused")).toBe("warn");
  });

  it("draft is warn", () => {
    expect(engagementStatusTone("draft")).toBe("warn");
  });

  it("closed is muted", () => {
    expect(engagementStatusTone("closed")).toBe("muted");
  });
});

describe("numberOrDash", () => {
  it("renders null/undefined/empty as an em dash", () => {
    expect(numberOrDash(null)).toBe("—");
    expect(numberOrDash(undefined)).toBe("—");
    expect(numberOrDash("")).toBe("—");
  });

  it("renders zero as an explicit 0, not a dash", () => {
    expect(numberOrDash(0)).toBe("0");
  });

  it("coerces a numeric-as-string (Postgres numeric over the wire)", () => {
    expect(numberOrDash("42.50")).toBe("42.5");
  });

  it("refuses non-numeric junk", () => {
    expect(numberOrDash("not-a-number")).toBe("—");
  });
});

function makeFinding(overrides: Partial<AuditFinding>): AuditFinding {
  return {
    id: "f-1", auditId: "a-1", code: "server_error", severity: "high", category: "availability",
    message: "x", urlCount: 1, sampleUrls: [], status: "open", firstSeenAuditId: null, lastSeenAuditId: null,
    createdAt: "2026-01-01T00:00:00Z", ...overrides,
  };
}

describe("groupFindingsBySeverity", () => {
  it("groups by severity in critical-first rank order regardless of input order", () => {
    const findings = [
      makeFinding({ id: "f-low", severity: "low" }),
      makeFinding({ id: "f-critical", severity: "critical" }),
      makeFinding({ id: "f-medium", severity: "medium" }),
    ];
    const groups = groupFindingsBySeverity(findings);
    expect(groups.map((g) => g.severity)).toEqual(["critical", "medium", "low"]);
  });

  it("keeps every finding of the same severity in one group", () => {
    const findings = [makeFinding({ id: "f-1", severity: "high" }), makeFinding({ id: "f-2", severity: "high" })];
    const groups = groupFindingsBySeverity(findings);
    expect(groups).toHaveLength(1);
    expect(groups[0].findings).toHaveLength(2);
  });

  it("sorts an unrecognised severity value last instead of throwing", () => {
    const findings = [makeFinding({ id: "f-weird", severity: "weird" }), makeFinding({ id: "f-crit", severity: "critical" })];
    const groups = groupFindingsBySeverity(findings);
    expect(groups.map((g) => g.severity)).toEqual(["critical", "weird"]);
  });

  it("returns an empty array for no findings", () => {
    expect(groupFindingsBySeverity([])).toEqual([]);
  });
});

function makeKeyword(overrides: Partial<SearchKeyword>): SearchKeyword {
  return {
    id: "k-1", keyword: "seo tools", locale: "id-ID", intent: null, clusterId: null, clusterLabel: null,
    volume: null, difficulty: null, cpcUsd: null, isTracked: false, hasEmbedding: false,
    createdAt: "2026-01-01T00:00:00Z", ...overrides,
  };
}

describe("groupKeywordsByCluster", () => {
  it("groups keywords sharing a clusterId together", () => {
    const keywords = [
      makeKeyword({ id: "k-1", clusterId: "c-1", clusterLabel: "Tools" }),
      makeKeyword({ id: "k-2", clusterId: "c-1", clusterLabel: "Tools" }),
      makeKeyword({ id: "k-3", clusterId: "c-2", clusterLabel: "Checklists" }),
    ];
    const groups = groupKeywordsByCluster(keywords);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.clusterId === "c-1")?.keywords).toHaveLength(2);
  });

  it("drops unclustered keywords (null clusterId) rather than inventing an 'Unclustered' group", () => {
    const keywords = [makeKeyword({ id: "k-1", clusterId: null }), makeKeyword({ id: "k-2", clusterId: "c-1" })];
    const groups = groupKeywordsByCluster(keywords);
    expect(groups).toHaveLength(1);
    expect(groups[0].clusterId).toBe("c-1");
  });

  it("sorts largest cluster first", () => {
    const keywords = [
      makeKeyword({ id: "k-1", clusterId: "small" }),
      makeKeyword({ id: "k-2", clusterId: "big" }),
      makeKeyword({ id: "k-3", clusterId: "big" }),
    ];
    const groups = groupKeywordsByCluster(keywords);
    expect(groups[0].clusterId).toBe("big");
  });

  it("falls back to the clusterId itself when no clusterLabel was ever set", () => {
    const groups = groupKeywordsByCluster([makeKeyword({ id: "k-1", clusterId: "c-1", clusterLabel: null })]);
    expect(groups[0].clusterLabel).toBe("c-1");
  });
});

describe("keywordVolumeState", () => {
  // The ticket's own MUST HOLD: 'disabled' (scope toggle off) and 'unpulled' (toggle on, no data
  // yet) must never collapse into the same rendering, and a real value must never be confused with
  // either — same asymmetry formatUsd documents for money (never show 0 for "we don't know").
  it("is 'disabled' when the volume scope toggle is off, regardless of the raw value", () => {
    expect(keywordVolumeState(false, null)).toBe("disabled");
    expect(keywordVolumeState(false, 0)).toBe("disabled");
    expect(keywordVolumeState(false, 500)).toBe("disabled");
  });

  it("is 'unpulled' when the toggle is on but no value has been pulled yet", () => {
    expect(keywordVolumeState(true, null)).toBe("unpulled");
    expect(keywordVolumeState(true, undefined)).toBe("unpulled");
  });

  it("is 'value' when the toggle is on and a real number (including zero) is present", () => {
    expect(keywordVolumeState(true, 210)).toBe("value");
    expect(keywordVolumeState(true, 0)).toBe("value");
  });
});

describe("formatVolume", () => {
  it("renders null/undefined as an em dash", () => {
    expect(formatVolume(null)).toBe("—");
    expect(formatVolume(undefined)).toBe("—");
  });

  it("formats a real number with thousands separators", () => {
    expect(formatVolume(12000)).toBe("12,000");
  });

  it("renders zero as an explicit 0, not a dash — the caller only invokes this once a real value is confirmed", () => {
    expect(formatVolume(0)).toBe("0");
  });
});

function makeProjectedTool(overrides: Partial<CostProjectionTool>): CostProjectionTool {
  return {
    tool: "rank", opKind: "serp", enabled: true, cadence: "weekly", runsPerMonth: 4.29,
    itemsPerRun: 50, costPerRunUsd: 2.5, projectedMonthlyUsd: 10.71, provider: "dataforseo",
    simulated: false, ...overrides,
  };
}

describe("anyEnabledToolSimulated", () => {
  // SM-38: a total built from simulated inputs is itself simulated ("aggregates count") — this is
  // the pure predicate ScopeEditor's preview total and the engagement KPI strip both key off.
  it("is true when at least one ENABLED row is simulated", () => {
    const rows = [
      makeProjectedTool({ tool: "rank", enabled: true, simulated: false }),
      makeProjectedTool({ tool: "volume", enabled: true, simulated: true }),
    ];
    expect(anyEnabledToolSimulated(rows)).toBe(true);
  });

  it("is false when every enabled row is real, even if a DISABLED row happens to carry simulated: true", () => {
    // A disabled toggle's $0 isn't a number a provider sourced at all — its simulated flag (which
    // the backend still populates, since it always resolves a provider regardless of `enabled`)
    // must not taint an otherwise-real total.
    const rows = [
      makeProjectedTool({ tool: "rank", enabled: true, simulated: false }),
      makeProjectedTool({ tool: "backlinks", enabled: false, simulated: true }),
    ];
    expect(anyEnabledToolSimulated(rows)).toBe(false);
  });

  it("is false for an empty row set", () => {
    expect(anyEnabledToolSimulated([])).toBe(false);
  });

  it("is true when every enabled row is simulated (the whole-platform simulate-mode case)", () => {
    const rows = [
      makeProjectedTool({ tool: "rank", enabled: true, simulated: true }),
      makeProjectedTool({ tool: "volume", enabled: true, simulated: true }),
    ];
    expect(anyEnabledToolSimulated(rows)).toBe(true);
  });
});

describe("CAPABILITY_TOGGLE", () => {
  // Mirrors OP_SCOPE_TOGGLE in platform-nest src/modules/search/providers/types.ts —
  // the two maps must stay in step, since this is the toggle every metered
  // capability rides on when the console explains a refused dispatch.
  it("maps each metered capability to its backend scope toggle", () => {
    expect(CAPABILITY_TOGGLE).toEqual({
      rankings: "rank",
      keywords_volume: "volume",
      suggestions: "suggestions",
      backlinks: "backlinks",
      ai_visibility: "ai_visibility",
    });
  });
});

// ── SM-47: SEM (campaigns/ad-groups/ads/negatives/change-proposals) pure helpers ─────────────────
describe("numOrNull", () => {
  // search_campaigns.budget_minor/target_cpa_minor are `bigint` and NOT cast by the controller —
  // this repo registers no pg.types.setTypeParser for OID 20 (confirmed by grep) — so they reach
  // this module as STRINGS. This coercion is what stands between that and a `.toFixed()`-style
  // crash the same class §4i already found twice in this module.
  it("coerces a numeric string to a number", () => {
    expect(numOrNull("500000")).toBe(500000);
  });

  it("passes a real number through unchanged", () => {
    expect(numOrNull(4.5)).toBe(4.5);
  });

  it("returns null for null, undefined and an empty string — never 0", () => {
    expect(numOrNull(null)).toBeNull();
    expect(numOrNull(undefined)).toBeNull();
    expect(numOrNull("")).toBeNull();
  });

  it("returns null for a non-numeric string rather than NaN", () => {
    expect(numOrNull("not-a-number")).toBeNull();
  });
});

describe("SEM writable-status sets", () => {
  // Mirror search.controller.ts's own CAMPAIGN_STATUSES_WRITABLE / AD_STATUSES_WRITABLE /
  // NEGATIVE_STATUSES_WRITABLE exactly (§6o) — 'live'/'paused'/'ended'/'applied' need a live-ads
  // sync or SM-30/21's execution flow and must never be offered as an option from this console.
  it("campaign statuses never include a live-account state", () => {
    expect(CAMPAIGN_STATUSES_WRITABLE).toEqual(["draft", "proposed"]);
    expect(CAMPAIGN_STATUSES_WRITABLE).not.toContain("live");
  });

  it("ad statuses never include 'live' — sync-only", () => {
    expect(AD_STATUSES_WRITABLE).toEqual(["draft", "approved", "rejected"]);
    expect(AD_STATUSES_WRITABLE).not.toContain("live");
  });

  it("negative statuses never include 'applied' — SM-30/21's execution flow owns it exclusively", () => {
    expect(NEGATIVE_STATUSES_WRITABLE).toEqual(["proposed", "approved", "dismissed"]);
    expect(NEGATIVE_STATUSES_WRITABLE).not.toContain("applied");
  });
});

describe("CHANGE_PROPOSAL_TRANSITIONS", () => {
  // The binding no-live-side-effect rule (SM-18 §6o, this ticket's own "explicitly NOT in scope"):
  // 'applied' must NEVER be a reachable target from any state this console could read — SM-30
  // (manual mark-applied) and SM-21 (api-mode execution) own that transition exclusively.
  it("never lists 'applied' as reachable from any state", () => {
    for (const reachable of Object.values(CHANGE_PROPOSAL_TRANSITIONS)) {
      expect(reachable).not.toContain("applied");
    }
  });

  it("a proposed proposal can move to approved or dismissed, nothing else", () => {
    expect(CHANGE_PROPOSAL_TRANSITIONS.proposed).toEqual(["approved", "dismissed"]);
  });

  it("an approved proposal can only be dismissed", () => {
    expect(CHANGE_PROPOSAL_TRANSITIONS.approved).toEqual(["dismissed"]);
  });

  it("a dismissed or applied proposal has no further reachable transition", () => {
    expect(CHANGE_PROPOSAL_TRANSITIONS.dismissed).toEqual([]);
    expect(CHANGE_PROPOSAL_TRANSITIONS.applied).toEqual([]);
  });
});
