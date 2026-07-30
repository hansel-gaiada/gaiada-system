// SM-18 — cluster→plan generator (design §04/§07/§12 SM-18: "Campaign/ad-group/ad planning objects
// built from keyword clusters"). Pure, synchronous, no I/O: search.controller.ts owns the DB read
// (search_keywords, already clustered by SM-09's clusterKeywordSet) and the INSERTs into
// search_campaigns/search_ad_groups; this file only turns a clustered keyword set into a
// deterministic ad-group plan. Mirrors the pure/testable split every other search sub-module uses
// (clustering.ts, keyword-import.ts, search-audit.ts, ai-drafts.ts).
//
// ── Provenance MUST flow through, never blend (standing rule, design addendum §A2/§A4.7) ──────────
// search_keywords.metrics_provider / metrics_simulated (migration 0048) record WHICH vendor produced
// a keyword's volume/difficulty/cpc_usd and whether that vendor was a SIMULATED driver. A campaign
// plan is built partly from those numbers (grouping, ordering, and — later tickets — pacing
// suggestions), so a plan that silently dropped this provenance would let a client-facing SEM plan
// built entirely from simulated volumes present as though it reflected real market data — the exact
// "confident wrong answer" class this program keeps finding and fixing (§4d/§4i/§6j). This file
// therefore computes a `KeywordProvenanceSummary` per ad group that:
//   - lists every DISTINCT provider actually present (never averaged/blended across providers, §A2);
//   - counts simulated vs. real separately (never summed into one "count" that hides the mix);
//   - counts keywords with NO metrics pulled yet (metricsProvider === null) as "unpulled" — absent
//     stays absent, per the module's own house rule, never coerced into 0 or folded into "real".
// The caller (search.controller.ts) is responsible for surfacing this summary on every response that
// returns a generated plan, exactly as read — this file computes it, it does not decide how honestly
// the controller renders it (that discipline lives in the controller/UI layer, out of this file's
// control, so it is stated here as a MUST for whoever calls this function).
export interface PlanKeywordRow {
  id: string;
  keyword: string;
  intent: string | null;
  clusterId: string | null;
  clusterLabel: string | null;
  volume: number | null;
  difficulty: number | null;
  cpcUsd: number | null;
  metricsProvider: string | null;
  metricsSimulated: boolean;
}

export interface KeywordProvenanceSummary {
  /** Distinct providers backing the PULLED metrics in this group, alphabetically sorted for
   *  deterministic output. Never a blended/averaged figure — just an honest enumeration. */
  providers: string[];
  /** Keywords whose CURRENT metrics were produced by a simulated provider (design addendum §A8.3). */
  simulatedCount: number;
  /** Keywords whose CURRENT metrics were produced by a real (non-simulated) provider. */
  realCount: number;
  /** Keywords with no metrics pulled yet (metricsProvider IS NULL) — "not yet known", never 0. */
  unpulledCount: number;
}

export interface PlannedAdGroup {
  clusterId: string;
  /** cluster_label if Hermes/the deterministic fallback named it; a short, stable placeholder
   *  otherwise (never blank — an ad group with no name is a worse UX failure than an ugly one). */
  name: string;
  /** The single most common non-null intent in the cluster; null if every member is untagged or the
   *  cluster is genuinely mixed-intent with no majority (never guessed/invented). */
  intent: string | null;
  keywordIds: string[];
  /** First MAX_PLAN_KEYWORD_SAMPLE keywords, in the caller's supplied order — for display and as
   *  RSA-drafting grounding context (see sem-drafts.ts), not the full member list. */
  keywordSample: string[];
  keywordCount: number;
  provenance: KeywordProvenanceSummary;
}

export interface CampaignPlan {
  adGroups: PlannedAdGroup[];
  totalClusteredKeywords: number;
  /** Keywords in the set that had no cluster_id (never clustered, or clustering was run before they
   *  were added) — reported so the caller can tell "your whole plan" from "part of your set". */
  unclusteredSkipped: number;
}

export const MAX_PLAN_KEYWORD_SAMPLE = 20;

export class NoClusteredKeywordsError extends Error {
  constructor() {
    super(
      "this keyword set has no clustered keywords yet — run POST .../keyword-sets/:id/cluster first",
    );
    this.name = "NoClusteredKeywordsError";
  }
}

function summarizeProvenance(rows: PlanKeywordRow[]): KeywordProvenanceSummary {
  const providers = new Set<string>();
  let simulatedCount = 0;
  let realCount = 0;
  let unpulledCount = 0;
  for (const r of rows) {
    if (r.metricsProvider === null) {
      unpulledCount++;
      continue;
    }
    providers.add(r.metricsProvider);
    if (r.metricsSimulated) simulatedCount++;
    else realCount++;
  }
  return { providers: [...providers].sort(), simulatedCount, realCount, unpulledCount };
}

/** Majority non-null intent in the group; ties broken alphabetically for determinism. Returns null
 *  if every member is untagged (never invents an intent the clustering job didn't assign). */
function majorityIntent(rows: PlanKeywordRow[]): string | null {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (r.intent) counts.set(r.intent, (counts.get(r.intent) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  let best: string | null = null;
  let bestCount = -1;
  for (const [intent, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (count > bestCount) {
      best = intent;
      bestCount = count;
    }
  }
  return best;
}

/** Pure function of its input array — same determinism contract as clustering.ts's
 *  clusterEmbeddings(): no randomness, no Date.now(), no unordered Map/Set iteration feeding the
 *  output shape. The caller must feed a stably-ordered input (search.controller.ts always reads
 *  `ORDER BY keyword ASC, id ASC`, same convention as listKeywords/clusterKeywordSet) — this function
 *  preserves that order within each ad group (keywordSample/keywordIds are in input order) and only
 *  imposes its OWN deterministic order across ad groups (by name, then clusterId) so the top-level
 *  array order never depends on which cluster happened to appear first in an unordered read. */
export function buildCampaignPlan(rows: PlanKeywordRow[]): CampaignPlan {
  const byCluster = new Map<string, PlanKeywordRow[]>();
  let unclusteredSkipped = 0;
  for (const row of rows) {
    if (!row.clusterId) {
      unclusteredSkipped++;
      continue;
    }
    const bucket = byCluster.get(row.clusterId);
    if (bucket) bucket.push(row);
    else byCluster.set(row.clusterId, [row]);
  }

  if (byCluster.size === 0) throw new NoClusteredKeywordsError();

  const adGroups: PlannedAdGroup[] = [...byCluster.entries()].map(([clusterId, members]) => {
    const name = members[0].clusterLabel?.trim() || `Cluster ${clusterId.slice(0, 8)}`;
    return {
      clusterId,
      name,
      intent: majorityIntent(members),
      keywordIds: members.map((m) => m.id),
      keywordSample: members.slice(0, MAX_PLAN_KEYWORD_SAMPLE).map((m) => m.keyword),
      keywordCount: members.length,
      provenance: summarizeProvenance(members),
    };
  });

  // Deterministic cross-group order: name then clusterId, independent of Map iteration order (which
  // itself already reflects first-seen order from a caller that reads ORDER BY keyword ASC, id ASC —
  // this is a defensive second sort, not a correction of a known bug).
  adGroups.sort((a, b) => a.name.localeCompare(b.name) || a.clusterId.localeCompare(b.clusterId));

  const totalClusteredKeywords = adGroups.reduce((sum, g) => sum + g.keywordCount, 0);
  return { adGroups, totalClusteredKeywords, unclusteredSkipped };
}
