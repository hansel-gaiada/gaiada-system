// AIP-00c — `GET :tenantId/assistant/brains`: which LLM providers the gateway can serve RIGHT NOW,
// so the brain picker lists only brains that work.
//
// Source: ai-gateway-go `GET /health` -> `providers.llm`, a `{name: state}` map from
// `chain.State()`. The only states the chain can produce are:
//   "ok"           — configured and its breaker is closed: it can serve.
//   "open"         — configured but the breaker is tripped (cooling down): it cannot serve now.
//   "unconfigured" — no key/endpoint: it cannot serve.
// Only "ok" means available. Providers NOT in the live LLM_CHAIN (e.g. hermes, ollama today) are
// absent from the map and therefore never offered.
//
// Output is deliberately minimal: `{value, available}` per provider. Model names, endpoints, budget,
// key state and every other `/health` field are dropped here and must never reach the browser.
// `echo` is the test provider and is never offered.
import { config } from "../../config";
import { GATEWAY_TIERS } from "../ai-usage/routing";

export interface BrainEntry { value: string; available: boolean }
/** `tiers`: the valid tier names `/health` reports (AIP-08a). `[]` = none configured (the key is absent), `null` = unknown. */
export interface BrainsResult { brains: BrainEntry[] | null; tiers: string[] | null; checkedAt: string }

export const BRAINS_CACHE_TTL_MS = 60_000;
export const BRAINS_TIMEOUT_MS = 3_000;

export interface BrainsDeps {
  fetchImpl?: typeof fetch;
  gatewayUrl?: string;
  gatewayToken?: string;
  now?: () => number;
  warn?: (msg: string) => void;
}

let cache: { at: number; value: BrainsResult } | null = null;

export function resetBrainsCache(): void { cache = null; }

/** Pure mapping of a `/health` body to the brains list; `null` when the shape is not understood. */
export function mapHealthToBrains(body: unknown): BrainEntry[] | null {
  if (!body || typeof body !== "object") return null;
  const providers = (body as { providers?: unknown }).providers;
  if (!providers || typeof providers !== "object") return null;
  const llm = (providers as { llm?: unknown }).llm;
  if (!llm || typeof llm !== "object" || Array.isArray(llm)) return null;
  const out: BrainEntry[] = [];
  for (const [name, state] of Object.entries(llm as Record<string, unknown>)) {
    if (typeof state !== "string") return null;
    if (name === "echo") continue;
    out.push({ value: name, available: state === "ok" });
  }
  return out;
}

/** Pure mapping of a `/health` body to the configured tier names. Only the three known names survive, in the gateway's order;
 *  an absent or malformed `tiers` key means none are configured (`[]`); a body that is not an object is unreadable (`null`). */
export function mapHealthToTiers(body: unknown): string[] | null {
  if (!body || typeof body !== "object") return null;
  const raw = (body as { tiers?: unknown }).tiers;
  if (!Array.isArray(raw)) return [];
  return GATEWAY_TIERS.filter((t) => raw.includes(t));
}

export async function getBrains(deps: BrainsDeps = {}): Promise<BrainsResult> {
  const now = deps.now ?? Date.now;
  const t = now();
  if (cache && t - cache.at < BRAINS_CACHE_TTL_MS) return cache.value;

  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const base = (deps.gatewayUrl ?? config.services.gateway.url ?? "").replace(/\/$/, "");
  const token = deps.gatewayToken ?? config.services.gateway.token;
  let brains: BrainEntry[] | null = null;
  let tiers: string[] | null = null;
  if (!base) {
    warn("assistant brains: GATEWAY_URL is unset; brain list is unknown");
  } else {
    try {
      const res = await (deps.fetchImpl ?? fetch)(`${base}/health`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(BRAINS_TIMEOUT_MS),
      });
      if (!res.ok) {
        warn(`assistant brains: gateway /health answered HTTP ${res.status}; brain list is unknown`);
      } else {
        const health: unknown = await res.json();
        brains = mapHealthToBrains(health);
        // Tiers are unknown exactly when the brain list is (same cases); otherwise read from the same body.
        tiers = brains === null ? null : mapHealthToTiers(health);
        if (brains === null) warn("assistant brains: gateway /health had an unexpected shape; brain list is unknown");
      }
    } catch (e) {
      warn(`assistant brains: gateway /health unreachable (${e instanceof Error ? e.name : "error"}); brain list is unknown`);
    }
  }
  const value: BrainsResult = { brains, tiers, checkedAt: new Date(t).toISOString() };
  cache = { at: t, value };
  return value;
}
