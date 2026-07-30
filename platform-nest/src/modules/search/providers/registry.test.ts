// SM-36 — per-capability provider preference (docs/blueprints/seo-sem-execution-tracker.md §6 SM-36;
// design addendum §A2). Pure unit tests, no DB: resolveProvider()/pickProviderKey() touch only the
// process-level registry Map and `config.search`, exactly like the pre-existing
// "SM-04 resolveProvider — fail-closed selection" describe block in dispatch.test.ts (kept there,
// unmodified — this file adds the SM-36-specific cascade/fallback coverage instead of duplicating it).
//
// AC covered here (tracker §6 SM-36 re-spec):
//   - explicit override (per-tool AND engagement-default) to an unregistered/incapable provider still
//     refuses — regression-pins today's honor-or-refuse behaviour, now against a MULTI-vendor registry
//     where a silent substitution would be easy to introduce by accident
//   - the platform tier falls through to the first REGISTERED + CAPABLE provider in
//     config.search.capabilityPreference, in list order
//   - per-capability defaults match §A2 byte-for-byte
//   - serp / ai_visibility (length-1 lists) refuse rather than substitute even when a differently
//     -sourced provider is registered and technically capable — the no-fallback policy, not a registry
//     accident
//   - the resolved provider is the one actually returned (dispatch.ts bills whichever key this
//     function hands back — pickProviderKey must report the SAME provider resolveProvider would use)
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { config } from "../../../config";
import { registerProvider, resetProviders, resolveProvider, pickProviderKey } from "./registry";
import {
  NoCapableProviderError,
  ProviderDispatchError,
  type AiVisibilityQuery,
  type AiVisibilityResult,
  type BacklinkSummary,
  type Capability,
  type KeywordMetrics,
  type KeywordQuery,
  type ProviderKey,
  type ProviderOp,
  type SearchDataProvider,
  type SerpRequest,
  type SerpResult,
  type TaskRef,
} from "./types";

/** A minimal SearchDataProvider stub: only `key` and `capabilities` matter to resolveProvider(); every
 *  data method throws if actually invoked (these tests never dispatch, only resolve). */
class FakeProvider implements SearchDataProvider {
  readonly capabilities: Set<Capability>;
  constructor(readonly key: ProviderKey, caps: Capability[]) {
    this.capabilities = new Set(caps);
  }
  postSerpTasks(_r: SerpRequest[]): Promise<TaskRef[]> { throw new Error("not exercised"); }
  fetchSerpResults(_r: TaskRef[]): Promise<SerpResult[]> { throw new Error("not exercised"); }
  getKeywordMetrics(_k: KeywordQuery[]): Promise<KeywordMetrics[]> { throw new Error("not exercised"); }
  getBacklinkSummary(_t: string): Promise<BacklinkSummary> { throw new Error("not exercised"); }
  getAiVisibility(_q: AiVisibilityQuery): Promise<AiVisibilityResult[]> { throw new Error("not exercised"); }
  estimateCostUsd(_op: ProviderOp): number { return 0.01; }
}

// Snapshot + restore every config knob these tests touch, so no test can leak state into another
// file (dispatch.test.ts's own resolveProvider describe block runs against the SAME config object).
let savedPreference: typeof config.search.capabilityPreference;
let savedTenantDefault: string;
let savedDefaultProvider: string;

describe("SM-36 resolveProvider — per-capability preference cascade (design addendum §A2)", () => {
  beforeEach(() => {
    resetProviders();
    savedPreference = config.search.capabilityPreference;
    savedTenantDefault = config.search.tenantDefaultProvider;
    savedDefaultProvider = config.search.defaultProvider;
    config.search.tenantDefaultProvider = "";
  });

  afterEach(() => {
    resetProviders();
    config.search.capabilityPreference = savedPreference;
    config.search.tenantDefaultProvider = savedTenantDefault;
    config.search.defaultProvider = savedDefaultProvider;
  });

  // ── §A2 byte-for-byte ──────────────────────────────────────────────────────────────────────────
  it("seeds the platform default preference lists byte-for-byte from design addendum §A2", () => {
    expect(config.search.capabilityPreference.serp).toEqual(["dataforseo"]);
    expect(config.search.capabilityPreference.volume).toEqual(["semrush", "dataforseo", "ahrefs"]);
    expect(config.search.capabilityPreference.suggestions).toEqual(["dataforseo", "scraper"]);
    expect(config.search.capabilityPreference.backlinks).toEqual(["ahrefs", "semrush", "dataforseo"]);
    expect(config.search.capabilityPreference.ai_visibility).toEqual(["dataforseo"]);
  });

  // ── SM-46d: serp / ai_visibility are hardcoded literals, not env-parsed ───────────────────────────
  it("SEARCH_PREFERENCE_SERP / SEARCH_PREFERENCE_AI_VISIBILITY have NO effect on the resolved default — "
    + "the §A2 no-widen invariant is a code-level refusal, not an operator-editable deployment variable", () => {
    const prevSerp = process.env.SEARCH_PREFERENCE_SERP;
    const prevAiVis = process.env.SEARCH_PREFERENCE_AI_VISIBILITY;
    // If config.ts still ran these two through preferenceList(env, fallback), setting the env var
    // WOULD change the parsed value the next time config.ts's module body ran; because config.ts
    // now hardcodes `["dataforseo"]` for both instead of calling preferenceList(), the already-loaded
    // config object cannot observe this env var at all — proving the parse is genuinely absent, not
    // merely defaulted. (Contrast `volume` two lines up: it stays env-overridable by design.)
    try {
      process.env.SEARCH_PREFERENCE_SERP = "dataforseo,semrush";
      process.env.SEARCH_PREFERENCE_AI_VISIBILITY = "semrush,ahrefs";
      expect(config.search.capabilityPreference.serp).toEqual(["dataforseo"]);
      expect(config.search.capabilityPreference.ai_visibility).toEqual(["dataforseo"]);
    } finally {
      if (prevSerp === undefined) delete process.env.SEARCH_PREFERENCE_SERP; else process.env.SEARCH_PREFERENCE_SERP = prevSerp;
      if (prevAiVis === undefined) delete process.env.SEARCH_PREFERENCE_AI_VISIBILITY; else process.env.SEARCH_PREFERENCE_AI_VISIBILITY = prevAiVis;
    }
  });

  // ── honor-or-refuse, unchanged, now against a multi-vendor registry ───────────────────────────────
  it("an explicit PER-TOOL override to an unregistered provider refuses rather than falling through the platform list", () => {
    registerProvider(new FakeProvider("dataforseo", ["volume"]));
    expect(() => resolveProvider({ provider: { volume: "semrush" } }, "volume"))
      .toThrow(/'semrush' is not registered/);
    // Confirms it did NOT silently fall through to the registered, capable 'dataforseo' — the
    // whole point of honor-or-refuse.
  });

  it("an explicit PER-TOOL override to a provider lacking the capability refuses, never substitutes", () => {
    registerProvider(new FakeProvider("semrush", ["backlinks"])); // no 'volume'
    registerProvider(new FakeProvider("dataforseo", ["volume"]));
    expect(() => resolveProvider({ provider: { volume: "semrush" } }, "volume"))
      .toThrow(NoCapableProviderError);
  });

  it("an explicit ENGAGEMENT-DEFAULT override is honor-or-refuse exactly like the per-tool override", () => {
    registerProvider(new FakeProvider("dataforseo", ["volume"]));
    expect(() => resolveProvider({ provider: { default: "ahrefs" } }, "volume"))
      .toThrow(/'ahrefs' is not registered/);
  });

  it("a TENANT default is honor-or-refuse and outranks the platform preference list", () => {
    registerProvider(new FakeProvider("semrush", ["volume"]));
    registerProvider(new FakeProvider("dataforseo", ["volume"]));
    config.search.tenantDefaultProvider = "dataforseo";
    // Platform preference for volume is [semrush, dataforseo, ahrefs] — semrush would win at tier 4,
    // but the tenant default (tier 3) must win first.
    expect(resolveProvider({}, "volume").key).toBe("dataforseo");
  });

  // ── the platform tier is the ONLY one allowed to fall through ─────────────────────────────────────
  it("falls through the platform preference list to the first REGISTERED + CAPABLE provider", () => {
    // volume's default order is [semrush, dataforseo, ahrefs]; semrush is unregistered here, so
    // dataforseo (next in the list) must be chosen.
    registerProvider(new FakeProvider("dataforseo", ["volume"]));
    registerProvider(new FakeProvider("ahrefs", ["volume"]));
    expect(resolveProvider({}, "volume").key).toBe("dataforseo");
  });

  it("falls through past a REGISTERED but INCAPABLE provider to the next in the list", () => {
    registerProvider(new FakeProvider("semrush", ["backlinks"])); // registered, but not 'volume'
    registerProvider(new FakeProvider("ahrefs", ["volume"]));
    // semrush is first in preference order but can't serve 'volume' — must fall through to ahrefs,
    // skipping dataforseo entirely since it was never registered.
    expect(resolveProvider({}, "volume").key).toBe("ahrefs");
  });

  it("refuses when every candidate in the platform preference list is unregistered or incapable", () => {
    registerProvider(new FakeProvider("semrush", ["backlinks"])); // wrong capability, present anyway
    expect(() => resolveProvider({}, "volume")).toThrow(NoCapableProviderError);
  });

  it("pickProviderKey reports the SAME provider resolveProvider would fall through to — dispatch bills the actual winner", () => {
    registerProvider(new FakeProvider("dataforseo", ["volume"]));
    registerProvider(new FakeProvider("ahrefs", ["volume"]));
    expect(pickProviderKey({}, "volume")).toBe(resolveProvider({}, "volume").key);
  });

  // ── serp / ai_visibility: no fallback, ever (§A2's explicit ruling) ───────────────────────────────
  it("'serp' refuses rather than substituting a same-capability vendor when DataForSEO is unregistered", () => {
    // Semrush truthfully advertises 'serp' too (organic-positions reports) — but §A2 is explicit:
    // Semrush/Ahrefs 'positions' are DB snapshots, a different product from a live SERP capture, so
    // the seeded platform list for 'serp' stays length-1 and must never widen to include them.
    registerProvider(new FakeProvider("semrush", ["serp"]));
    expect(() => resolveProvider({}, "serp")).toThrow(NoCapableProviderError);
  });

  it("'ai_visibility' refuses rather than substituting when DataForSEO is unregistered, even if another provider claims the capability", () => {
    registerProvider(new FakeProvider("semrush", ["ai_visibility"])); // hypothetical/misconfigured
    expect(() => resolveProvider({}, "ai_visibility")).toThrow(NoCapableProviderError);
  });

  it("'serp' resolves to DataForSEO when it IS registered, ignoring a same-capability competitor entirely", () => {
    registerProvider(new FakeProvider("semrush", ["serp"]));
    registerProvider(new FakeProvider("dataforseo", ["serp"]));
    expect(resolveProvider({}, "serp").key).toBe("dataforseo");
  });

  // ── env override shape (SEARCH_PREFERENCE_* parsing lives in config.ts; this proves the registry
  //    actually CONSUMES whatever config.search.capabilityPreference holds, not a hardcoded copy) ───
  it("consults config.search.capabilityPreference directly — an operator-repointed list changes the winner with no code change", () => {
    registerProvider(new FakeProvider("ahrefs", ["backlinks"]));
    registerProvider(new FakeProvider("dataforseo", ["backlinks"]));
    config.search.capabilityPreference = {
      ...config.search.capabilityPreference,
      backlinks: ["dataforseo", "ahrefs"], // reversed from the §A2 default [ahrefs, semrush, dataforseo]
    };
    expect(resolveProvider({}, "backlinks").key).toBe("dataforseo");
  });

  // ── QA gate finding (2026-07-29): an empty platform preference list must REFUSE, not mean "no
  //    constraint" ──────────────────────────────────────────────────────────────────────────────────
  // Pre-fix, resolveProvider() fell back to config.search.defaultProvider whenever the capability's
  // preference list was empty. That is safe by coincidence for a multi-vendor capability like
  // 'volume' when defaultProvider happens to name a registered+capable provider, but it is a live
  // breach of §A2's no-substitute guarantee for 'serp'/'ai_visibility': an operator (or a future bug)
  // that ends up with an empty list for one of those two must get a refusal, never a same-capability
  // competitor silently standing in. config.ts's preferenceList() currently prevents an env override
  // from ever producing an empty list, so this is defence-in-depth, not a reachable-today prod path —
  // but the guard is the point: an empty list is "no candidates", not "no constraint".
  it("an empty platform preference list REFUSES rather than falling back to config.search.defaultProvider", () => {
    registerProvider(new FakeProvider("dataforseo", ["volume"]));
    config.search.capabilityPreference = { ...config.search.capabilityPreference, volume: [] };
    config.search.defaultProvider = "dataforseo"; // even though defaultProvider IS registered+capable
    expect(() => resolveProvider({}, "volume")).toThrow(NoCapableProviderError);
  });

  it("an empty 'serp' preference list REFUSES rather than substituting a same-capability competitor named as the platform defaultProvider", () => {
    // The attack: a same-capability vendor (semrush) is registered and capable, and
    // config.search.defaultProvider happens to name it (simulating an operator setting
    // SEARCH_DEFAULT_PROVIDER=semrush while capabilityPreference.serp is empty for any reason). The
    // no-substitute guarantee for 'serp' must hold even here — refuse, never hand back semrush's
    // database-snapshot positions in place of a live DataForSEO capture.
    registerProvider(new FakeProvider("semrush", ["serp"]));
    config.search.capabilityPreference = { ...config.search.capabilityPreference, serp: [] };
    config.search.defaultProvider = "semrush";
    expect(() => resolveProvider({}, "serp")).toThrow(NoCapableProviderError);
  });

  it("an empty 'ai_visibility' preference list REFUSES rather than substituting", () => {
    registerProvider(new FakeProvider("semrush", ["ai_visibility"])); // hypothetical/misconfigured
    config.search.capabilityPreference = { ...config.search.capabilityPreference, ai_visibility: [] };
    config.search.defaultProvider = "semrush";
    expect(() => resolveProvider({}, "ai_visibility")).toThrow(NoCapableProviderError);
  });
});
