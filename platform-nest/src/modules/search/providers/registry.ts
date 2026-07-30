// SM-04 — provider registry + capability index + the per-engagement selection cascade (design §05).
// SM-36 (design addendum §A2) replaces the tail of that cascade with a per-CAPABILITY ordered
// preference list — see resolveProvider's doc comment below for the full cascade and why only the
// platform tier is allowed to fall through across providers.
//
// The registry is a process-level Map (drivers are stateless, keyed by ProviderKey). SM-05 registers
// the real `dataforseo` driver at bootstrap; tests register the mock. It starts EMPTY: with no
// driver registered, dispatch fails closed (NoCapableProviderError) rather than silently no-op'ing —
// a paid pull must never proceed against a phantom provider. There is deliberately no auto-registered
// production default here (SM-06 wires bootstrap registration behind the creds/feature flags).
import { config } from "../../../config";
import {
  type Capability,
  type OpKind,
  type ProviderKey,
  type SearchDataProvider,
  OP_CAPABILITY,
  NoCapableProviderError,
  ProviderDispatchError,
} from "./types";

const providers = new Map<ProviderKey, SearchDataProvider>();

export function registerProvider(p: SearchDataProvider): void {
  providers.set(p.key, p);
}

/** Test seam — drop all registrations (each suite registers exactly the drivers it exercises). */
export function resetProviders(): void {
  providers.clear();
}

export function getProvider(key: ProviderKey): SearchDataProvider | undefined {
  return providers.get(key);
}

/** Capability index: every registered driver advertising `cap`, in registration order. */
export function providersWithCapability(cap: Capability): SearchDataProvider[] {
  return [...providers.values()].filter((p) => p.capabilities.has(cap));
}

/** The shape of `tool_scope.provider` (design §04): a per-tool provider override map plus an
 *  optional `default`. All optional; every field is a ProviderKey string. */
export interface ToolScopeProviderOverride {
  default?: string;
  [opKind: string]: string | undefined;
}

/** A single explicitly-named provider is an OPERATOR INSTRUCTION (an engagement per-tool override,
 *  an engagement default, or a tenant default) — honor it or refuse, NEVER silently substitute a
 *  different vendor. This is the one piece of pre-SM-36 behaviour that must never change. */
function requireExplicitProvider(key: string, capability: Capability): SearchDataProvider {
  const provider = providers.get(key as ProviderKey);
  if (!provider) {
    throw new ProviderDispatchError("unknown_provider", `selected search-data provider '${key}' is not registered`);
  }
  if (!provider.capabilities.has(capability)) {
    // The explicitly-selected provider can't do this op. Do NOT silently fall through to a
    // different provider — an explicit override is an operator instruction; honor it or refuse.
    throw new NoCapableProviderError(capability);
  }
  return provider;
}

/** Selection cascade (design §05, amended by SM-36 / addendum §A2), evaluated per op:
 *    1. engagement `tool_scope.provider[<opKind>]`  (per-tool override) — honor-or-refuse
 *    2. engagement `tool_scope.provider.default`                       — honor-or-refuse
 *    3. tenant default    (config.search.tenantDefaultProvider — env, may be unset) — honor-or-refuse
 *    4. platform per-CAPABILITY ordered preference (config.search.capabilityPreference), falling
 *       through only across REGISTERED + CAPABLE providers.
 *
 *  Tiers 1-3 are all explicit, human/operator-supplied configuration — each is a single key, and each
 *  is honor-or-refuse: if the named provider isn't registered or can't serve this op's capability,
 *  dispatch REFUSES rather than quietly trying a different vendor (unchanged from pre-SM-36
 *  behaviour, and the AC this ticket regression-pins). Tier 4 is the ONLY tier allowed to fall
 *  through, because nothing there is an operator instruction — it is the platform's own policy
 *  default, seeded from §A2's capability x vendor matrix. `serp` and `ai_visibility` are seeded as
 *  length-1 lists (§A2: no fallback — a snapshot from a different vendor has different product
 *  semantics than a live capture), so an unregistered DataForSEO still refuses at tier 4 exactly as
 *  it would have refused at any single-key tier; the fallthrough behaviour is only observable for
 *  the capabilities §A2 actually gives more than one entry.
 *
 *  Returns the chosen provider (never null — it throws instead). */
export function resolveProvider(toolScope: Record<string, unknown> | null | undefined, opKind: OpKind): SearchDataProvider {
  const capability = OP_CAPABILITY[opKind];
  const providerMap = (toolScope?.provider ?? {}) as ToolScopeProviderOverride;

  const perToolKey = providerMap[opKind];
  if (typeof perToolKey === "string" && perToolKey.length > 0) {
    return requireExplicitProvider(perToolKey, capability);
  }

  const engagementDefaultKey = providerMap.default;
  if (typeof engagementDefaultKey === "string" && engagementDefaultKey.length > 0) {
    return requireExplicitProvider(engagementDefaultKey, capability);
  }

  if (config.search.tenantDefaultProvider) {
    return requireExplicitProvider(config.search.tenantDefaultProvider, capability);
  }

  // Tier 4 — platform per-capability preference. QA fix (2026-07-29): an empty/missing list here
  // used to fall back to the single platform config.search.defaultProvider — which is a DIFFERENT
  // vendor key, not a "no constraint" no-op. For 'serp'/'ai_visibility' (§A2's length-1,
  // no-substitute capabilities) that fallback was a live landmine: an empty list must mean "no
  // candidates satisfy the constraint" and REFUSE, never "no constraint at all" and substitute a
  // same-capability competitor. config.ts's preferenceList() currently guarantees every capability
  // is non-empty (env override empty/blank/comma-only keeps the seeded default), so this path is not
  // reachable through today's env-parsing — but it must still fail closed on its own, both as
  // defence-in-depth and because nothing here is type-enforced to stay non-empty forever (a future
  // capability added to OP_CAPABILITY without a capabilityPreference entry would hit this exact
  // branch). Proven by a mutation test: registerProvider("semrush", ["serp"]) +
  // capabilityPreference.serp = [] + defaultProvider = "semrush" used to resolve to 'semrush' for a
  // 'serp' op instead of throwing — see registry.test.ts.
  const preference = config.search.capabilityPreference[capability] ?? [];
  for (const key of preference) {
    const provider = providers.get(key as ProviderKey);
    if (provider && provider.capabilities.has(capability)) return provider;
  }
  // Every candidate in the ordered list is either unregistered or incapable (or the list was empty)
  // — fail closed. Never substitutes config.search.defaultProvider here.
  throw new NoCapableProviderError(capability);
}

/** The ProviderKey resolveProvider() would select for this op — same selection cascade, key only.
 *  The dispatch ledger records which provider a pull is billed to without needing the driver. */
export function pickProviderKey(toolScope: Record<string, unknown> | null | undefined, opKind: OpKind): ProviderKey {
  return resolveProvider(toolScope, opKind).key;
}
