// SM-16 — GEO/AI-visibility snapshots (docs/blueprints/seo-sem-design.md §12 SM-16; tracker §6j
// "SM-16 · backlinks + GEO/AI-visibility" — reuses SM-14's (rank.ts) pattern, transposed to
// `search_ai_visibility`). Authoritative provider per §A2: DataForSEO, with NO fallback for this
// capability — resolveProvider refuses rather than substituting a different vendor if DataForSEO
// isn't registered/capable; this file never chooses a provider itself.
//
// Same governance as backlinks.ts (0048's column-comment law, tracker §6j's five inherited ACs,
// transposed to this table):
//   1. `simulated` stamped from DispatchResult.simulated ONLY — never config.search.providerMode,
//      never derived from the nullable provider_call_id FK.
//   2. Stamped in the SAME INSERT as the row's payload (engine/query/brand_mentioned/cited/…) —
//      provenance can never disagree with the bytes it sits on.
//   3. `search_ai_visibility` is APPEND-ONLY (0034), so — like backlinks.ts — there is no existing
//      row to leave untouched; the AC3 analogue is the batch shape below: a mid-batch provider
//      refusal (scope/budget/pillar) stops the loop, but every row already inserted for an earlier
//      query in this same call is left exactly as written.
//   4. Any reader added here states its mode handling — see search.controller.ts's
//      listAiVisibility (badge, unfiltered — raw history view, same shape as rank-snapshots).
//   5. This file + search.controller.ts own every platform route for AI-visibility pulls.
//
// One dispatch call covers ONE query (SearchDataProvider.getAiVisibility takes a single
// AiVisibilityQuery, providers/types.ts) but can return MULTIPLE rows — one per engine the resolved
// driver reports on when no single engine is named (design: "brand mentioned/cited across ChatGPT,
// AI Overviews, Gemini, Claude, Perplexity"). Every row from the SAME dispatch shares that one
// dispatch's provenance (provider/provider_call_id/simulated) by construction — there is exactly one
// `result` per query, never a re-derivation per row.
import type { PoolClient } from "pg";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import { emitEvent } from "../../events/outbox.service";
import { dispatchProviderOp } from "./providers/dispatch";
import { ProviderDispatchError, type AiVisibilityResult } from "./providers/types";

/** design §12 SM-16 AC: "GEO panel shows mention/citation deltas". A "change" for one (property,
 *  engine, query) is either flag flipping vs the immediately-prior captured row for that EXACT
 *  triple — mirrors isRankDrop/isBacklinkLostSpike's null-guard: no prior row (first-ever capture of
 *  this triple) is never a "change", there is nothing to compare against. */
export function isAiVisibilityChange(
  previous: { brandMentioned: boolean; cited: boolean } | null,
  current: { brandMentioned: boolean; cited: boolean },
): boolean {
  if (previous === null) return false;
  return previous.brandMentioned !== current.brandMentioned || previous.cited !== current.cited;
}

export interface AiVisibilityRowOutcome {
  engine: string;
  brandMentioned: boolean;
  cited: boolean;
  citedUrl: string | null;
  prominence: number | null;
  changed: boolean;
  previousBrandMentioned: boolean | null;
  previousCited: boolean | null;
}

export interface AiVisibilityQueryOutcome {
  query: string;
  status: "pulled" | "skipped" | "failed";
  rows?: AiVisibilityRowOutcome[];
  provider?: string;
  simulated?: boolean;
  reason?: string;
}

interface PullAiVisibilityQueryParams {
  tenantId: string;
  engagementId: string;
  propertyId: string;
  query: string;
  requestedBy: string | null;
  correlationId?: string | null;
}

/** Pull + persist ALL engine rows for ONE GEO query — the unit both the batch property pull (below)
 *  and search.controller.ts's POST .../ai-visibility-pull call. Uses the NORMAL 7d cache (design §05
 *  CACHE_TTL_SECONDS.ai_visibility) — no bypassCache; weekly-cadence snapshots are exactly the case
 *  the cache exists to keep cheap (matches backlinks.ts, unlike rank.ts's tracked-position bypass). */
export async function pullAiVisibilityForQuery(p: PullAiVisibilityQueryParams): Promise<AiVisibilityQueryOutcome> {
  const result = await dispatchProviderOp({
    tenantId: p.tenantId,
    engagementId: p.engagementId,
    propertyId: p.propertyId,
    op: { kind: "ai_visibility", query: p.query },
    requestedBy: p.requestedBy,
    correlationId: p.correlationId,
  });

  const rows = (result.payload as AiVisibilityResult[]) ?? [];

  return withTenants(
    [p.tenantId],
    async (c: PoolClient) => {
      const outcomes: AiVisibilityRowOutcome[] = [];
      let anyChanged = false;

      for (const row of rows) {
        const prev = await c.query<{ brand_mentioned: boolean; cited: boolean }>(
          `SELECT brand_mentioned, cited FROM search_ai_visibility
            WHERE property_id = $1 AND engine = $2 AND query = $3
            ORDER BY captured_at DESC LIMIT 1`,
          [p.propertyId, row.engine, p.query],
        );
        const previous = prev.rows[0]
          ? { brandMentioned: prev.rows[0].brand_mentioned, cited: prev.rows[0].cited }
          : null;
        const changed = isAiVisibilityChange(previous, { brandMentioned: row.brandMentioned, cited: row.cited });
        if (changed) anyChanged = true;

        const id = newId();
        await c.query(
          `INSERT INTO search_ai_visibility
             (id, tenant_id, property_id, engine, query, brand_mentioned, cited, cited_url, prominence, raw,
              provider, provider_call_id, simulated, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            id, p.tenantId, p.propertyId, row.engine, p.query, row.brandMentioned, row.cited,
            row.citedUrl ?? null, row.prominence ?? null, JSON.stringify(row),
            // AC1 (tracker §6j / 0048 column-comment law): stamped from DispatchResult.simulated
            // ONLY, same rule as backlinks.ts/rank.ts.
            result.provider, result.ledgerId, result.simulated, config.originSite,
          ],
        );
        outcomes.push({
          engine: row.engine, brandMentioned: row.brandMentioned, cited: row.cited,
          citedUrl: row.citedUrl ?? null, prominence: row.prominence ?? null, changed,
          previousBrandMentioned: previous?.brandMentioned ?? null, previousCited: previous?.cited ?? null,
        });
      }

      if (anyChanged) {
        await emitEvent(c, p.tenantId, "search_property", p.propertyId, "search.ai_visibility.changed", {
          propertyId: p.propertyId, query: p.query,
        });
      }

      return {
        query: p.query, status: "pulled" as const, rows: outcomes,
        provider: result.provider, simulated: result.simulated,
      };
    },
    { modules: ["search"] },
  );
}

export interface AiVisibilityPullBatchResult {
  propertyId: string;
  attempted: number;
  pulled: number;
  skipped: number;
  failed: number;
  results: AiVisibilityQueryOutcome[];
}

/** Pull GEO/AI-visibility for a batch of queries under one property (search.controller.ts's
 *  POST .../ai-visibility-pull). Same sequential / hard-stop-on-choke-point-refusal shape as
 *  rank.ts's pullRanksForEngagement / pullMetricsForKeywords, for the identical reason: a scope/
 *  pillar/budget refusal applies IDENTICALLY to every remaining query in the batch (none of those
 *  gates are per-query), so the loop stops there and reports what was already pulled; a per-QUERY
 *  failure does NOT stop the batch. */
export async function pullAiVisibilityForProperty(input: {
  tenantId: string;
  engagementId: string;
  propertyId: string;
  queries: string[];
  requestedBy: string | null;
  correlationId?: string | null;
}): Promise<AiVisibilityPullBatchResult> {
  const results: AiVisibilityQueryOutcome[] = [];
  let pulled = 0;
  let skipped = 0;
  let failed = 0;
  let stopped: string | null = null;

  for (const query of input.queries) {
    if (stopped) {
      results.push({ query, status: "skipped", reason: stopped });
      skipped++;
      continue;
    }
    try {
      const outcome = await pullAiVisibilityForQuery({
        tenantId: input.tenantId, engagementId: input.engagementId, propertyId: input.propertyId,
        query, requestedBy: input.requestedBy, correlationId: input.correlationId,
      });
      results.push(outcome);
      pulled++;
    } catch (err) {
      if (err instanceof ProviderDispatchError) {
        results.push({ query, status: "skipped", reason: err.code });
        skipped++;
        stopped = err.code;
      } else {
        results.push({ query, status: "failed", reason: (err as Error).message });
        failed++;
      }
    }
  }

  return { propertyId: input.propertyId, attempted: input.queries.length, pulled, skipped, failed, results };
}
