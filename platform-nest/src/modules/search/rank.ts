// SM-14 — rank tracking (docs/blueprints/seo-sem-design.md §12; tracker §6j "SM-14 · rank tracking").
//
// This is the FIRST real caller of providers/dispatch.ts's dispatchProviderOp — until this file
// existed, `search_provider_calls` was empty in every environment because nothing dispatched a real
// (or simulated) provider op (tracker §6l "Honest limit — no ledger rows yet"). Everything below
// CALLS dispatchProviderOp; nothing here modifies it (providers/* is owned by a concurrent QA audit
// this ticket must not touch).
//
// Two writers live here, both governed by 0048's column-comment law (tracker §6j's five inherited
// ACs, verbatim):
//   1. Rank-snapshot persister (AC1) — one search_rank_snapshots row per pull, `simulated` stamped
//      from DispatchResult.simulated ONLY — never re-read from config.search.providerMode, never
//      derived from the nullable provider_call_id FK.
//   2. Keyword-metrics writer (AC2) — search_keywords.volume/difficulty/cpc_usd + metrics_provider +
//      metrics_simulated, all written in ONE UPDATE (discharges SM-36's carried-forward AC).
// AC3 (absent stays absent; a live re-pull overwrites value+provider+flag together) and AC5 (this
// module owns every platform route for rank pulls, including the Standard-queue completion callback
// n8n will hit) are implemented in search.controller.ts, which calls the functions below.
import type { PoolClient } from "pg";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import { emitEvent } from "../../events/outbox.service";
import { dispatchProviderOp } from "./providers/dispatch";
import { ProviderDispatchError, type KeywordMetrics, type SerpResult } from "./providers/types";

// ── domain matching (the provider has no notion of "whose rank" — design §05: SerpRequest carries
// only the keyword; locating OUR property inside the returned top-N list is this module's job) ─────
export function normalizeDomain(d: string): string {
  return d.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
}

export function hostnameOf(url: string): string | null {
  try {
    return normalizeDomain(new URL(url).hostname);
  } catch {
    return null;
  }
}

/** Locate the tracked property's own domain within a dispatched SERP's ranked items. Returns the
 *  BEST (lowest) position if the domain appears more than once (the migration only promises "not
 *  found ⇒ null", not uniqueness). `position: null` is the schema's own documented, honest "not
 *  found in this SERP" state (0034: "position integer -- nullable = not found in the SERP") — never
 *  an error, and never coerced into a guessed number. */
export function findPropertyPosition(
  items: SerpResult["items"],
  propertyDomain: string,
): { position: number | null; rankedUrl: string | null } {
  const target = normalizeDomain(propertyDomain);
  let best: { position: number; url: string } | null = null;
  for (const item of items) {
    const host = hostnameOf(item.url);
    if (!host) continue;
    if (host !== target && !host.endsWith(`.${target}`)) continue;
    if (!best || item.position < best.position) best = { position: item.position, url: item.url };
  }
  return best ? { position: best.position, rankedUrl: best.url } : { position: null, rankedUrl: null };
}

/** design §12 SM-14 AC: "drop emits event". A drop is (a) a keyword that WAS found and is now not
 *  found at all, or (b) found but at a numerically WORSE position than its immediately-prior
 *  snapshot. A keyword with no prior snapshot (first-ever pull), or one that stays not-found across
 *  two consecutive pulls, has nothing to regress FROM — never a drop. A newly-found keyword (prev
 *  null, new found) is a gain, not a drop, and is also excluded. */
export function isRankDrop(previousPosition: number | null, newPosition: number | null): boolean {
  if (previousPosition === null) return false;
  return newPosition === null || newPosition > previousPosition;
}

export interface TrackedKeywordRef {
  keywordId: string;
  keyword: string;
  locale: string | null;
}

export interface RankPullOutcome {
  keywordId: string;
  keyword: string;
  status: "pulled" | "skipped" | "failed";
  position?: number | null;
  rankedUrl?: string | null;
  provider?: string;
  simulated?: boolean;
  dropped?: boolean;
  previousPosition?: number | null;
  reason?: string;
}

interface PullRankParams {
  tenantId: string;
  engagementId: string;
  propertyId: string;
  propertyDomain: string;
  keyword: TrackedKeywordRef;
  engine?: string;
  device?: string;
  locationCode?: number;
  requestedBy: string | null;
  correlationId?: string | null;
}

/** Pull + persist ONE tracked keyword's rank snapshot — the unit both the batch engagement pull
 *  (below) and the Standard-queue completion callback (search.controller.ts) call. Tracked-rank
 *  pulls ALWAYS bypass the cache (dispatch.ts's own documented rule: "must capture the property's
 *  live position", design §05). search_rank_snapshots is append-only (0034's own comment) — a
 *  second call for the same keyword is a genuine new capture, not a duplicate to suppress. */
export async function pullRankForKeyword(p: PullRankParams): Promise<RankPullOutcome> {
  const engine = p.engine ?? "google";
  const device = p.device ?? "desktop";

  // The dispatch call is OUTSIDE any transaction of ours — dispatchProviderOp owns its own
  // connection + advisory-lock critical section (dispatch.ts's documented concurrency model); we
  // only persist the DERIVED snapshot after it returns, exactly like SM-16 will for backlinks.
  const result = await dispatchProviderOp({
    tenantId: p.tenantId,
    engagementId: p.engagementId,
    propertyId: p.propertyId,
    op: {
      kind: "serp", query: p.keyword.keyword, engine, device,
      locale: p.keyword.locale ?? undefined, locationCode: p.locationCode,
    },
    requestedBy: p.requestedBy,
    correlationId: p.correlationId,
    bypassCache: true,
  });

  const serpResults = result.payload as SerpResult[];
  const serp = serpResults[0] as SerpResult | undefined;
  const { position, rankedUrl } = serp
    ? findPropertyPosition(serp.items, p.propertyDomain)
    : { position: null, rankedUrl: null };
  const serpFeatures = serp?.serpFeatures ?? {};

  return withTenants(
    [p.tenantId],
    async (c: PoolClient) => {
      const prev = await c.query<{ position: number | null }>(
        `SELECT position FROM search_rank_snapshots
          WHERE property_id = $1 AND keyword_id = $2 AND engine = $3 AND device = $4
          ORDER BY captured_at DESC LIMIT 1`,
        [p.propertyId, p.keyword.keywordId, engine, device],
      );
      const previousPosition = prev.rows[0]?.position ?? null;

      const id = newId();
      await c.query(
        `INSERT INTO search_rank_snapshots
           (id, tenant_id, property_id, keyword_id, engine, device, location_code, position, ranked_url,
            serp_features, provider, provider_call_id, simulated, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          id, p.tenantId, p.propertyId, p.keyword.keywordId, engine, device, p.locationCode ?? null,
          position, rankedUrl, JSON.stringify(serpFeatures),
          // AC1 (tracker §6j / 0048 column-comment law): stamped from DispatchResult.simulated ONLY.
          // `result.provider` is the driver dispatch actually resolved and billed; `result.ledgerId`
          // is that dispatch's own search_provider_calls row (provider_call_id) — never re-derived
          // from config.search.providerMode, never inferred from this (nullable) FK being present.
          result.provider, result.ledgerId, result.simulated, config.originSite,
        ],
      );

      const dropped = isRankDrop(previousPosition, position);
      if (dropped) {
        await emitEvent(c, p.tenantId, "search_property", p.propertyId, "search.rank.dropped", {
          propertyId: p.propertyId, keywordId: p.keyword.keywordId, keyword: p.keyword.keyword,
          engine, device, previousPosition, newPosition: position,
        });
      }

      return {
        keywordId: p.keyword.keywordId, keyword: p.keyword.keyword, status: "pulled" as const,
        position, rankedUrl, provider: result.provider, simulated: result.simulated,
        dropped, previousPosition,
      };
    },
    { modules: ["search"] },
  );
}

export interface RankPullBatchResult {
  engagementId: string;
  propertyId: string;
  attempted: number;
  pulled: number;
  skipped: number;
  failed: number;
  results: RankPullOutcome[];
}

/** Pull ranks for a batch of tracked keywords under one engagement (search.controller.ts's
 *  POST .../rank-pull). Sequential, not parallel: dispatchProviderOp already serializes identical
 *  concurrent calls under the engagement's advisory lock, and a scope/pillar/budget refusal applies
 *  IDENTICALLY to every remaining keyword in the batch (none of those gates are per-keyword) — once
 *  one fires, retrying the rest would only add N more `recordBlocked` ledger rows for an outcome
 *  already known, so the loop stops there and reports what was already pulled. A per-KEYWORD failure
 *  (e.g. a malformed provider response for that one query) does NOT stop the batch. */
export async function pullRanksForEngagement(input: {
  tenantId: string;
  engagementId: string;
  propertyId: string;
  propertyDomain: string;
  keywords: TrackedKeywordRef[];
  requestedBy: string | null;
  correlationId?: string | null;
}): Promise<RankPullBatchResult> {
  const results: RankPullOutcome[] = [];
  let pulled = 0;
  let skipped = 0;
  let failed = 0;
  let stopped: string | null = null;

  for (const kw of input.keywords) {
    if (stopped) {
      results.push({ keywordId: kw.keywordId, keyword: kw.keyword, status: "skipped", reason: stopped });
      skipped++;
      continue;
    }
    try {
      const outcome = await pullRankForKeyword({
        tenantId: input.tenantId, engagementId: input.engagementId, propertyId: input.propertyId,
        propertyDomain: input.propertyDomain, keyword: kw,
        requestedBy: input.requestedBy, correlationId: input.correlationId,
      });
      results.push(outcome);
      pulled++;
    } catch (err) {
      if (err instanceof ProviderDispatchError) {
        results.push({ keywordId: kw.keywordId, keyword: kw.keyword, status: "skipped", reason: err.code });
        skipped++;
        stopped = err.code;
      } else {
        results.push({ keywordId: kw.keywordId, keyword: kw.keyword, status: "failed", reason: (err as Error).message });
        failed++;
      }
    }
  }

  return { engagementId: input.engagementId, propertyId: input.propertyId, attempted: input.keywords.length, pulled, skipped, failed, results };
}

// ── keyword-metrics writer (AC2/AC3) ────────────────────────────────────────────────────────────────
export interface MetricsPullOutcome {
  keywordId: string;
  keyword: string;
  status: "updated" | "absent" | "skipped" | "failed";
  volume?: number | null;
  difficulty?: number | null;
  cpcUsd?: number | null;
  provider?: string;
  simulated?: boolean;
  reason?: string;
}

export interface MetricsPullBatchResult {
  attempted: number;
  updated: number;
  absent: number;
  skipped: number;
  failed: number;
  results: MetricsPullOutcome[];
}

/** Pull volume/difficulty/cpc for a batch of keywords (search.controller.ts's POST
 *  .../metrics-pull) — the "keyword-metrics writer" tracker §6j's AC2 requires, discharging SM-36's
 *  carried-forward AC (search-marketing-execution-tracker §6j: "the keyword-metrics writer stamps
 *  metrics_provider + metrics_simulated in the SAME UPDATE as the metric values"). Same sequential /
 *  hard-stop-on-choke-point-refusal shape as pullRanksForEngagement, for the identical reason. */
export async function pullMetricsForKeywords(input: {
  tenantId: string;
  engagementId: string;
  propertyId: string | null;
  keywords: TrackedKeywordRef[];
  requestedBy: string | null;
  correlationId?: string | null;
}): Promise<MetricsPullBatchResult> {
  const results: MetricsPullOutcome[] = [];
  let updated = 0;
  let absent = 0;
  let skipped = 0;
  let failed = 0;
  let stopped: string | null = null;

  for (const kw of input.keywords) {
    if (stopped) {
      results.push({ keywordId: kw.keywordId, keyword: kw.keyword, status: "skipped", reason: stopped });
      skipped++;
      continue;
    }

    let dispatch: Awaited<ReturnType<typeof dispatchProviderOp>>;
    try {
      dispatch = await dispatchProviderOp({
        tenantId: input.tenantId, engagementId: input.engagementId, propertyId: input.propertyId,
        op: { kind: "volume", query: kw.keyword, locale: kw.locale ?? undefined },
        requestedBy: input.requestedBy, correlationId: input.correlationId,
      });
    } catch (err) {
      if (err instanceof ProviderDispatchError) {
        results.push({ keywordId: kw.keywordId, keyword: kw.keyword, status: "skipped", reason: err.code });
        skipped++;
        stopped = err.code;
      } else {
        results.push({ keywordId: kw.keywordId, keyword: kw.keyword, status: "failed", reason: (err as Error).message });
        failed++;
      }
      continue;
    }

    const metrics = (dispatch.payload as KeywordMetrics[])[0] as KeywordMetrics | undefined;
    // AC3: "Keywords absent from a pull's response keep NULL provider and prior values untouched
    // (absent stays absent)". A provider that genuinely returned nothing for this query must not
    // touch the row at all — not even to re-stamp provenance — so a keyword that was never pulled
    // stays honestly NULL, and one with prior (e.g. simulated) values is left exactly as it was.
    if (!metrics) {
      results.push({ keywordId: kw.keywordId, keyword: kw.keyword, status: "absent" });
      absent++;
      continue;
    }

    await withTenants(
      [input.tenantId],
      (c: PoolClient) => c.query(
        // AC2: metrics_provider + metrics_simulated set in the SAME UPDATE as the metric values —
        // provenance can never disagree with the payload it sits on (the writeCache atomicity
        // principle, tracker §6j). AC3's second clause ("a live re-pull over previously-simulated
        // metrics overwrites value+provider+flag together") falls out of this being an
        // UNCONDITIONAL overwrite whenever the keyword IS present — no branching on the row's prior
        // metrics_simulated value is needed or present here.
        `UPDATE search_keywords
            SET volume = $2, difficulty = $3, cpc_usd = $4,
                metrics_provider = $5, metrics_simulated = $6, metrics_fetched_at = now(), updated_at = now()
          WHERE id = $1 AND deleted_at IS NULL`,
        [
          kw.keywordId,
          metrics.volume ?? null,
          metrics.difficulty ?? null,
          metrics.cpcUsd ?? null,
          dispatch.provider,
          dispatch.simulated,
        ],
      ),
      { modules: ["search"] },
    );
    results.push({
      keywordId: kw.keywordId, keyword: kw.keyword, status: "updated",
      volume: metrics.volume ?? null, difficulty: metrics.difficulty ?? null, cpcUsd: metrics.cpcUsd ?? null,
      provider: dispatch.provider, simulated: dispatch.simulated,
    });
    updated++;
  }

  return { attempted: input.keywords.length, updated, absent, skipped, failed, results };
}
