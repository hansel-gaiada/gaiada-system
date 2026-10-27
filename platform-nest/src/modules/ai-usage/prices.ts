// AIP-04 — the price table (migration 202610271610_ai_model_prices.sql) and the arithmetic that fills a missing cost from it.
//
// THE RULES (AIP-D11)
//   * The provider's own cost always comes first and is labelled 'provider'. This file is only reached for an event that has token counts
//     and NO cost; it never overwrites a figure a provider reported (resolveEventCost returns the event untouched when costUsd is set).
//   * The price is the NEWEST row of (provider, model) whose effective_from is on or before the UTC day of the call. A call made before the
//     first row, or for a model with no row, gets NO cost: NULL, never 0. Unknown is not zero.
//   * Both token counts are needed. The table has one rate for the prompt and one for the completion; with only one count the other side's
//     cost is unknown, so the cost stays NULL rather than being understated.
//   * Nothing here throws. A failed lookup (no database, a missing table) leaves the cost NULL; the usage row is still written.
import { withGlobal } from "../../db";
import type { AiUsageEvent } from "./writer";

/** One row of ai_model_prices. Rates are US dollars per MILLION tokens; effectiveFrom is a UTC day, 'YYYY-MM-DD'. */
export interface ModelPrice {
  provider: string;
  model: string;
  promptUsdPerMtok: number;
  completionUsdPerMtok: number;
  effectiveFrom: string;
}

/** The UTC day of a call, 'YYYY-MM-DD' (matches ai_usage_daily's day: occurred_at AT TIME ZONE 'UTC'). */
export function utcDay(at: Date | string | null | undefined, now: Date = new Date()): string {
  const d = at instanceof Date ? at : typeof at === "string" ? new Date(at) : now;
  return (Number.isNaN(d.getTime()) ? now : d).toISOString().slice(0, 10);
}

/** The newest price of (provider, model) in force on `day`: the greatest effectiveFrom that is <= day. Null when none. Pure. */
export function pickPrice(prices: readonly ModelPrice[], provider: string, model: string, day: string): ModelPrice | null {
  let best: ModelPrice | null = null;
  for (const p of prices) {
    if (p.provider !== provider || p.model !== model || p.effectiveFrom > day) continue;
    if (best === null || p.effectiveFrom > best.effectiveFrom) best = p;
  }
  return best;
}

/** USD for a call: prompt*rate + completion*rate, per million. Null unless BOTH counts are present (see the header). Pure. */
export function computeCostUsd(price: ModelPrice, promptTokens: number | null | undefined, completionTokens: number | null | undefined): number | null {
  if (promptTokens === null || promptTokens === undefined || completionTokens === null || completionTokens === undefined) return null;
  const usd = (promptTokens * price.promptUsdPerMtok + completionTokens * price.completionUsdPerMtok) / 1_000_000;
  return Number.isFinite(usd) && usd >= 0 ? usd : null;
}

/** The price lookup seam. Resolves the price in force on `day`, or null. Must not throw (the default never does). */
export type PriceLookup = (provider: string, model: string, day: string) => Promise<ModelPrice | null>;

/** The default lookup: one indexed read of the global table. A failure is swallowed into null: the cost stays NULL, the row is still written. */
export const lookupModelPrice: PriceLookup = async (provider, model, day) => {
  try {
    const { rows } = await withGlobal((c) =>
      c.query<{ prompt: string; completion: string; effective_from: string }>(
        `SELECT prompt_usd_per_mtok::text AS prompt, completion_usd_per_mtok::text AS completion, to_char(effective_from, 'YYYY-MM-DD') AS effective_from
           FROM ai_model_prices
          WHERE provider = $1 AND model = $2 AND effective_from <= $3::date
          ORDER BY effective_from DESC
          LIMIT 1`,
        [provider, model, day],
      ),
    );
    const r = rows[0];
    if (!r) return null;
    const prompt = Number(r.prompt);
    const completion = Number(r.completion);
    if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return null;
    return { provider, model, promptUsdPerMtok: prompt, completionUsdPerMtok: completion, effectiveFrom: r.effective_from };
  } catch {
    return null;
  }
};

/**
 * AIP-D11 in one function. An event that already carries a cost is returned UNCHANGED (the provider's figure, whatever its label). An event with
 * both token counts, a provider and a model, and no cost, gets the table's cost labelled 'table' when a price is in force on its day. Every other
 * event is returned unchanged: its cost stays NULL. Never throws.
 */
export async function resolveEventCost(event: AiUsageEvent, lookup: PriceLookup = lookupModelPrice, now: Date = new Date()): Promise<AiUsageEvent> {
  try {
    if (event.costUsd !== undefined && event.costUsd !== null) return event;
    if (!event.provider || !event.model) return event;
    if (event.promptTokens === undefined || event.promptTokens === null || event.completionTokens === undefined || event.completionTokens === null) return event;
    const price = await lookup(event.provider, event.model, utcDay(event.occurredAt, now));
    if (!price) return event;
    const usd = computeCostUsd(price, event.promptTokens, event.completionTokens);
    if (usd === null) return event;
    return { ...event, costUsd: usd, costSource: "table" };
  } catch {
    return event;
  }
}
