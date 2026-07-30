// SM-16 — backlink snapshots (docs/blueprints/seo-sem-design.md §12 SM-16; tracker §6j "SM-16 ·
// backlinks + GEO/AI-visibility" — reuses SM-14's (rank.ts) pattern verbatim, transposed to
// `search_backlink_snapshots`). Authoritative provider per §A2: Ahrefs (resolveProvider picks it;
// this file never chooses a vendor).
//
// This is the SECOND real caller of providers/dispatch.ts's dispatchProviderOp (rank.ts was the
// first) — nothing here modifies providers/*; a concurrent QA audit owns that surface.
//
// Governed by 0048's column-comment law (tracker §6j's five inherited ACs, transposed):
//   1. `simulated` stamped from DispatchResult.simulated ONLY — never re-read from
//      config.search.providerMode, never derived from the nullable provider_call_id FK.
//   2. Stamped in the SAME INSERT as the payload (totals/provider/provider_call_id) — provenance can
//      never disagree with the row it sits on.
//   3. `search_backlink_snapshots` is APPEND-ONLY (0034's own table comment), so there is no existing
//      row to leave "untouched" the way search_keywords.metrics_* is — the AC3 analogue here is
//      batch-shaped instead: a mid-batch provider refusal stops the loop, but every row ALREADY
//      inserted for an earlier property/query in the same call stays exactly as written (nothing is
//      rolled back or re-labelled after the fact).
//   4. Any reader added here states its mode handling — see search.controller.ts's listBacklinks
//      (badge, unfiltered — the raw history view) doc comment.
//   5. This file + search.controller.ts own every platform route for backlink pulls.
//
// `new_links`/`lost_links` (0034: "top-N samples") are honestly left `[]` here: SearchDataProvider.
// getBacklinkSummary (providers/types.ts) returns only aggregate counts (backlinks/refDomains/
// authorityScore) — there is no per-link sample in the abstraction to store, and inventing one would
// be a confident-wrong-answer (§4i). "Lost spike" detection below therefore works off the AGGREGATE
// delta (this snapshot's total vs the immediately-prior one for the same property), which is the one
// signal actually available without a providers/* change (out of this ticket's file ownership).
import type { PoolClient } from "pg";
import { newId, withTenants } from "../../db";
import { config } from "../../config";
import { emitEvent } from "../../events/outbox.service";
import { dispatchProviderOp } from "./providers/dispatch";
import type { BacklinkSummary } from "./providers/types";
import { normalizeDomain } from "./rank";

/** design §09's event catalog requires `search.backlinks.lost_spike` to exist as a real producer;
 *  notifications.ts (SM-13) deliberately left it UNWIRED to a notification (no Backlinks tab exists
 *  in the current uiManifest — that is a platform-ui decision, out of this BE-only ticket's scope)
 *  but explicitly punted the "what counts as a spike" definition to "whoever builds the SM-16
 *  backlinks surface". Defined here, off the one aggregate signal the provider abstraction exposes:
 *  a drop is a "spike" if it is BOTH large in absolute terms (≥ LOST_SPIKE_ABSOLUTE) OR large as a
 *  share of the prior total (≥ LOST_SPIKE_RATIO) — either threshold alone would either miss large
 *  sites' small-percentage-but-huge-count losses, or spam small sites' single-digit noise.
 *
 *  §6r's NaN-cap lesson applied: `previous <= 0` is guarded BEFORE the ratio division, so a
 *  first-ever-nonzero-then-zero (or genuinely zero-previous) case can never divide by zero — the
 *  absolute-drop arm alone still catches a real loss in that edge case. */
const LOST_SPIKE_ABSOLUTE = 50;
const LOST_SPIKE_RATIO = 0.1;

export function isBacklinkLostSpike(previousBacklinks: number | null, currentBacklinks: number): boolean {
  if (previousBacklinks === null || previousBacklinks <= 0) return false;
  if (currentBacklinks >= previousBacklinks) return false;
  const dropped = previousBacklinks - currentBacklinks;
  return dropped >= LOST_SPIKE_ABSOLUTE || dropped / previousBacklinks >= LOST_SPIKE_RATIO;
}

export interface BacklinkPullOutcome {
  propertyId: string;
  status: "pulled";
  backlinks: number;
  refDomains: number;
  authorityScore: number | null;
  provider: string;
  simulated: boolean;
  lostSpike: boolean;
  previousBacklinks: number | null;
}

interface PullBacklinksParams {
  tenantId: string;
  engagementId: string;
  propertyId: string;
  propertyDomain: string;
  requestedBy: string | null;
  correlationId?: string | null;
}

/** Pull + persist ONE property's backlink snapshot — the unit search.controller.ts's
 *  POST engagements/:id/backlinks-pull calls. Backlink snapshots use the NORMAL 7d cache (design §05
 *  CACHE_TTL_SECONDS.backlinks) — unlike tracked-rank pulls, there is no `bypassCache` here; a
 *  monthly-cadence aggregate is exactly the case the cache exists to keep cheap. */
export async function pullBacklinksForProperty(p: PullBacklinksParams): Promise<BacklinkPullOutcome> {
  const domain = normalizeDomain(p.propertyDomain);

  // OUTSIDE any transaction of ours, exactly like rank.ts's pullRankForKeyword — dispatchProviderOp
  // owns its own connection + advisory-lock critical section; we only persist the DERIVED snapshot
  // after it returns.
  const result = await dispatchProviderOp({
    tenantId: p.tenantId,
    engagementId: p.engagementId,
    propertyId: p.propertyId,
    op: { kind: "backlinks", query: domain },
    requestedBy: p.requestedBy,
    correlationId: p.correlationId,
  });

  const summary = result.payload as BacklinkSummary;

  return withTenants(
    [p.tenantId],
    async (c: PoolClient) => {
      const prev = await c.query<{ totals: { backlinks?: number } }>(
        `SELECT totals FROM search_backlink_snapshots
          WHERE property_id = $1
          ORDER BY captured_at DESC LIMIT 1`,
        [p.propertyId],
      );
      const previousBacklinks = prev.rows[0] ? Number(prev.rows[0].totals?.backlinks ?? 0) : null;

      const totals = {
        backlinks: summary.backlinks,
        refDomains: summary.refDomains,
        authorityScore: summary.authorityScore ?? null,
      };
      const id = newId();
      await c.query(
        `INSERT INTO search_backlink_snapshots
           (id, tenant_id, property_id, totals, new_links, lost_links, provider, provider_call_id, simulated, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id, p.tenantId, p.propertyId, JSON.stringify(totals), JSON.stringify([]), JSON.stringify([]),
          // AC1 (tracker §6j / 0048 column-comment law): stamped from DispatchResult.simulated
          // ONLY — never re-read from config.search.providerMode, never inferred from
          // provider_call_id being present (that FK is nullable and unrelated to provenance).
          result.provider, result.ledgerId, result.simulated, config.originSite,
        ],
      );

      const lostSpike = isBacklinkLostSpike(previousBacklinks, summary.backlinks);
      if (lostSpike) {
        await emitEvent(c, p.tenantId, "search_property", p.propertyId, "search.backlinks.lost_spike", {
          propertyId: p.propertyId, previousBacklinks, newBacklinks: summary.backlinks,
        });
      }

      return {
        propertyId: p.propertyId, status: "pulled" as const,
        backlinks: summary.backlinks, refDomains: summary.refDomains, authorityScore: summary.authorityScore ?? null,
        provider: result.provider, simulated: result.simulated, lostSpike, previousBacklinks,
      };
    },
    { modules: ["search"] },
  );
}
