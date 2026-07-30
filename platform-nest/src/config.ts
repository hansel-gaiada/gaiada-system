import "dotenv/config";

// SM-36 — parse an optional comma-separated env override for a per-capability provider preference
// list (config.search.capabilityPreference); an unset or empty-after-trim value keeps `fallback` so
// a single stray comma or blank env var can never silently produce an empty (all-refuse) list.
function preferenceList(envVar: string | undefined, fallback: string[]): string[] {
  if (!envVar) return fallback;
  const parsed = envVar.split(",").map((s) => s.trim()).filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
}

// SM-40 (design addendum §A3.5, OQ-12) — the per-vendor reservation FRACTION for a prepaid
// provider's monthly ceiling. An unset, unparsable, or non-positive value keeps the ratified 50%
// default rather than silently producing a 0 (always-refuse) or negative fraction — same defensive
// posture as preferenceList above. Per-vendor so OQ-12's eventual ratified figure (or a temporary
// per-vendor override) never requires a code change.
/** SM-52 (tracker §6x.1 / §6z) — the general form of `moneyEnv` below, for a var that HAS a default.
 *
 *  Unset (or blank) => the default. **Set but uninterpretable => THROW at boot**, naming the var.
 *
 *  Why this exists as a second helper: `moneyEnv` closed the same hole for
 *  `DATAFORSEO_MONTHLY_CAP_USD`, but the architect gate on that fix found it covered ONE variable
 *  while every other money input still parsed raw — including `SEARCH_GLOBAL_MONTHLY_CAP_USD`, which
 *  on a default deployment is the **only platform-wide ceiling** (the tenant cap is null by default).
 *  So the very hole I reported as closed was still open on the most load-bearing cap in the system.
 *
 *  The failure mode is silent-and-wrong, not loud: a typo produced NaN or a silent fallback, and
 *  every downstream comparison against NaN is false by IEEE-754, so a tier looked configured and
 *  enforced nothing. `reservationFraction` was worse than NaN — it silently substituted 0.5, so an
 *  operator who typed `0.7` got a different budget than they configured with no signal at all.
 *  A silent substitution is harder to notice than a crash and harder to notice than a NaN.
 *
 *  `max` is enforced where a value above it is meaningless rather than merely large: a warn ratio
 *  above 1 can never fire (it would warn only past the cap it is meant to pre-empt), and reserving
 *  more than 100% of a plan's allowance is not a reservation. */
function numericEnv(
  name: string,
  opts: { default: number; min?: number; max?: number },
): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return opts.default;
  const n = Number(raw);
  const min = opts.min ?? 0;
  const okMin = n > min;
  const okMax = opts.max === undefined || n <= opts.max;
  if (!Number.isFinite(n) || !okMin || !okMax) {
    throw new Error(
      `${name}="${raw}" is not a number in (${min}, ${opts.max ?? "∞"}]. Leave it unset to accept ` +
        `the default (${opts.default}); a value that cannot be parsed would otherwise be silently ` +
        `substituted or leave the control it governs inert while appearing configured.`,
    );
  }
  return n;
}

/** A prepaid vendor's plan fact (price or unit allowance). Unset => 0, which every consumer reads as
 *  "no plan fact configured" and which correctly leaves the driver unregistered and its provider cap
 *  skipped (B1 / §A3.3). Set but uninterpretable => THROW: a typo'd plan price previously became NaN
 *  and silently *disabled that vendor entirely*, which looks identical to "we chose not to configure
 *  Semrush" in every log and surface. Refusing to boot is the only way an operator learns the
 *  difference. */
function planFactEnv(name: string): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `${name}="${raw}" is not a positive finite number. Leave it unset to declare the vendor ` +
        `unconfigured; an unparseable value would otherwise disable that vendor silently, which is ` +
        `indistinguishable from a deliberate choice not to configure it.`,
    );
  }
  return n;
}

function reservationFraction(envVarName: string): number {
  return numericEnv(envVarName, { default: 0.5, min: 0, max: 1 });
}

// SM-40 / §A3.5 — the amortized-USD reservation cap for a PREPAID vendor (Semrush, Ahrefs): the
// ERP's reserved SHARE of the monthly subscription allowance, expressed in amortized standard-rate
// USD. The full allowance's amortized cost IS the plan price by construction — cost-to-serve at the
// standard rate (computeSemrushCostPerUnitUsd / computeAhrefsCostPerUnitUsd), summed over every
// unit in the allowance, equals exactly the plan price — so the reserved SHARE of that allowance in
// amortized USD is simply `reservation x monthlyPlanPriceUsd`; no separate unit-count arithmetic is
// needed. A non-positive plan price means "no plan fact configured" (the same fact that makes the
// live driver itself not register, per B1) — but the two checks are independent, and this one MUST
// return null (tier SKIPPED), never 0 (tier ALWAYS BREACHED, i.e. every dispatch to that vendor
// refused), matching the same unset-cap-skips-tier convention `tenantMonthlyCapUsd` already
// established. Exported (not just used inline) so ledger.test.ts / dispatch.test.ts can pin the
// arithmetic directly, the same way semrush.ts/ahrefs.ts export their cost-per-unit derivations.
export function computeProviderReservationCapUsd(
  monthlyPlanPriceUsd: number,
  reservation: number,
): number | null {
  if (!(monthlyPlanPriceUsd > 0)) return null;
  return monthlyPlanPriceUsd * reservation;
}

// Local consts so the SAME plan-price/allowance facts feed both the vendor's own credential block
// below AND the SM-40 provider-ceiling derivation, without either place re-parsing process.env or
// (worse) the two silently drifting apart.
const semrushMonthlyPlanPriceUsd = planFactEnv("SEMRUSH_MONTHLY_PLAN_PRICE_USD");
const semrushMonthlyUnitAllowance = planFactEnv("SEMRUSH_MONTHLY_UNIT_ALLOWANCE");
const semrushReservationFraction = reservationFraction("SEMRUSH_PROVIDER_RESERVATION_FRACTION");
const ahrefsMonthlyApiTierPriceUsd = planFactEnv("AHREFS_MONTHLY_API_TIER_PRICE_USD");
const ahrefsMonthlyApiTierUnitAllowance = planFactEnv("AHREFS_MONTHLY_UNIT_ALLOWANCE");
const ahrefsReservationFraction = reservationFraction("AHREFS_PROVIDER_RESERVATION_FRACTION");
// DataForSEO is genuinely pay-as-you-go — there is no subscription allowance to reserve a SHARE of,
// so this tier is a literal deposit-burn ceiling in USD, operator-set directly from the account's
// funded deposit (OQ-11). Unset (default, and the out-of-the-box state before that deposit is
// funded) => the tier is SKIPPED, exactly like an unset tenantMonthlyCapUsd — the platform must not
// invent a cash ceiling any more than it invents a tenant one.
/** A money CAP or a price that feeds one. Unset => `null` (the tier is skipped, deliberately).
 *  **Set but uninterpretable => THROW at boot.**
 *
 *  Why throwing, and not coercing to `null`: the SM-40/42/18 QA gate found that a malformed cap
 *  (`Number("50 usd")` → NaN) let `evaluateBudget` ENTER the tier and then compare against NaN,
 *  where `projected > NaN` and `projected >= ratio * NaN` are both false by IEEE-754 — a tier that
 *  looked configured and enforced nothing. Its proposed fix was to coerce NaN to `null`. That fix
 *  does not work, and the reason is worth writing down: **an inert NaN tier and a skipped null tier
 *  enforce exactly the same nothing.** Verified directly. So coercion changes no behaviour at all;
 *  it only moves where the silence happens.
 *
 *  The actual hazard was never the arithmetic — it is **silent misconfiguration**: an operator sets
 *  a spend ceiling, believes the platform is enforcing it, and it is not. `null` is the honest
 *  encoding of "no cap was configured", and a typo is not that; it is a deployment error. This
 *  module fails closed on the money path everywhere else (pillar, scope, ceiling-unavailable,
 *  provider-capability), so the consistent answer is to refuse to start rather than to run
 *  unbounded while looking bounded. A boot failure is loud, immediate, and cheap to fix; an
 *  unenforced ceiling is silent and is discovered by the invoice. */
function moneyEnv(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `${name}="${raw}" is not a positive finite number. Leave it unset to disable that spend ` +
        `ceiling deliberately; a value that cannot be parsed would otherwise leave the ceiling ` +
        `silently unenforced while appearing configured.`,
    );
  }
  return n;
}

const dataforseoProviderMonthlyCapUsd = moneyEnv("DATAFORSEO_MONTHLY_CAP_USD");

export const config = {
  port: Number(process.env.PLATFORM_PORT ?? 3004),
  host: process.env.HOST ?? "0.0.0.0",
  // Postgres. Connect as a NON-superuser NOBYPASSRLS role in any real deployment —
  // superusers bypass RLS entirely (D5).
  databaseUrl: process.env.DATABASE_URL ?? "",
  // Migrations/DDL + runtime-grant provisioning run as the OWNER role (migrate() uses this, not
  // the restricted runtime role). Empty -> migrate() falls back to databaseUrl at call time
  // (dev/tests, where owner==runtime).
  migrateDatabaseUrl: process.env.MIGRATE_DATABASE_URL ?? "",
  // Service token surfaces (bot, mcp-hub, n8n) must present. Empty -> reject (fail-closed).
  serviceToken: process.env.PLATFORM_SERVICE_TOKEN ?? "",
  // This site's identifier (sync retrofit later; recorded on every row now).
  originSite: process.env.ORIGIN_SITE ?? "main",
  // Auth mode (5b): "oidc" requires a verified IdP JWT; "dev" keeps the x-user-id header
  // (local + tests). OBO-envelope resolution works in both modes.
  authMode: process.env.AUTH_MODE ?? "dev",
  oidcIssuer: process.env.OIDC_ISSUER ?? "http://localhost:8080/realms/gaiada",
  oidcJwksUri:
    process.env.OIDC_JWKS_URI ?? "http://localhost:8080/realms/gaiada/protocol/openid-connect/certs",
  oidcAudience: process.env.OIDC_AUDIENCE ?? "gaiada-platform",
  // Cerbos policy decision point (5b.4). The platform calls it for every authorization.
  cerbosUrl: process.env.CERBOS_URL ?? "http://localhost:3592",
  // File storage (5c.4). Local-first backend now (a directory on disk / mounted volume);
  // an object store is the target-state swap behind the same StorageBackend interface.
  filesDir: process.env.FILES_DIR ?? "./data/files",
  // WSUX-14 connection-credential vault (decision #7): base64 of exactly 32 bytes (AES-256) used by
  // src/core/secret-box.ts to seal integration_connections tokens at rest. UNSET -> the token write
  // path is fail-closed 503 (mapping create/list/revoke still work); a future OpenBao/KMS key rotates
  // in behind token_key_version. NEVER logged.
  integrationTokenKey: process.env.INTEGRATION_TOKEN_KEY ?? "",
  // Event backbone (5c continuation): Redis Streams for outbox relay + consumption.
  redisUrl: process.env.REDIS_URL ?? "",
  // ORG-6 release train (A4): the whole shared-service reconciler is DARK by default. When off,
  // the reconcile consumer drains its stream but materializes nothing — assignments stay dormant
  // metadata (exactly as ORG-2/ORG-3 left them). Flips on only with the rest of the train green.
  serviceAssignmentsEnabled:
    process.env.SERVICE_ASSIGNMENTS_ENABLED === "1" || process.env.SERVICE_ASSIGNMENTS_ENABLED === "true",
  // A16 orphan escalation: an ACTIVE assignment whose provider unit node has been orphaned for
  // longer than this TTL is auto-suspended by the nightly drift sweep (grants off, edge kept), so
  // an accidental chart edit cannot leave cross-company access standing indefinitely. Default 7d.
  serviceOrphanTtlMs: Number(process.env.SERVICE_ORPHAN_TTL_MS ?? 7 * 24 * 3600 * 1000),
  // ORG-7 §3: how often the nightly drift/orphan sweep runs (sweepDriftAndOrphans). Default 24h;
  // dev/tests override to something short-lived. No effect unless serviceAssignmentsEnabled.
  serviceDriftSweepIntervalMs: Number(process.env.SERVICE_DRIFT_SWEEP_INTERVAL_MS ?? 24 * 3600 * 1000),
  // P2-07 (pm-console-ux-design-spec.md §4, §0 D-2): nightly burndown-snapshot pre-warmer. DARK
  // by default — the lazy upsert-on-read on every burndown GET (pm.controller.ts) is the
  // correctness backstop, so this job is a pure best-effort optimization, never load-bearing.
  pmBurndownSnapshotEnabled:
    process.env.PM_BURNDOWN_SNAPSHOT_ENABLED === "1" || process.env.PM_BURNDOWN_SNAPSHOT_ENABLED === "true",
  pmBurndownSnapshotIntervalMs: Number(process.env.PM_BURNDOWN_SNAPSHOT_INTERVAL_MS ?? 24 * 3600 * 1000),
  // Downstream service endpoints the admin/systems console aggregates (Phase C). All
  // read-only; empty URL -> that system reports "not configured" (fail-soft, never fake).
  services: {
    gateway: { url: process.env.GATEWAY_URL ?? "", token: process.env.GATEWAY_TOKEN ?? "" },
    bot: { url: process.env.BOT_URL ?? "", token: process.env.BOT_ADMIN_TOKEN ?? process.env.ADMIN_TOKEN ?? "" },
    hub: { url: process.env.HUB_URL ?? "", token: process.env.HUB_SERVICE_TOKEN ?? "" },
    knowledge: { url: process.env.KNOWLEDGE_URL ?? "", token: process.env.KNOWLEDGE_SERVICE_TOKEN ?? "" },
    // n8n: token is its Public-API key (X-N8N-API-KEY) used to list workflows/executions.
    automation: { url: process.env.AUTOMATION_URL ?? "", token: process.env.AUTOMATION_API_KEY ?? "" },
    // B3 (erp-whatsapp-and-agent-runtime-e2e.md §3.3): the agent-runner service (B1). Bearer
    // AGENT_RUNNER_TOKEN gates every runner call, same convention as the other service tokens.
    agents: { url: process.env.AGENTS_URL ?? "", token: process.env.AGENT_RUNNER_TOKEN ?? "" },
  },
  // Per-outbound-call timeout for the admin aggregator's probes (ms).
  adminProbeTimeoutMs: Number(process.env.ADMIN_PROBE_TIMEOUT_MS ?? 3000),
  // Search-marketing provider layer (SM-04, design §05/§11). The stop-loss caps + provider-
  // selection defaults. defaultProvider is the platform default at the tail of the selection
  // cascade; tenantDefaultProvider is an optional per-deploy tenant default (empty -> falls
  // through to defaultProvider). globalMonthlyCapUsd is the platform-wide ceiling (env, default
  // $150/mo until the deposit model is proven). tenantMonthlyCapUsd is an OPTIONAL per-tenant
  // monthly ceiling (unset -> that tier is skipped; engagement provider_budget_usd + global still
  // enforced). budgetWarnRatio is the fraction of a cap at which a threshold event fires (0.8).
  //
  // SM-06 adds the credentials + per-pillar feature flags. KEYLESS IS A SUPPORTED MODE: with no
  // DATAFORSEO_LOGIN/PASSWORD the driver is simply not registered at bootstrap, so every paid
  // capability fails closed at the registry (NoCapableProviderError / unknown_provider) instead of
  // half-working against a phantom endpoint. The $0 pillars (crawl audits, keyword clustering, AI
  // drafts) are unaffected — that is the whole point of the P1-before-P2 build order.
  search: {
    defaultProvider: process.env.SEARCH_DEFAULT_PROVIDER ?? "dataforseo",
    tenantDefaultProvider: process.env.SEARCH_TENANT_DEFAULT_PROVIDER ?? "",
    // SM-36 (design addendum §A2) — per-capability platform-default PREFERENCE LISTS, consulted only
    // at the tail of registry.ts's resolveProvider() cascade (after any engagement per-tool override,
    // engagement default, and tenant default — all three of which stay single-key honor-or-refuse,
    // unchanged). This is the ONE tier allowed to fall through across multiple providers, because
    // nothing here is an operator instruction — it's the platform's own policy default, and falling
    // through only ever lands on a REGISTERED + CAPABLE driver (registry.ts).
    //
    // Seeded byte-for-byte from §A2's matrix. `serp` and `ai_visibility` are deliberately length-1:
    // Semrush/Ahrefs "positions"/AI-visibility products are database snapshots on the vendor's own
    // refresh schedule — different product semantics from a live per-query capture — so substituting
    // one for the other would silently change what a client report's number means. A length-1 list
    // means an unregistered DataForSEO refuses the pull rather than falling back to a same-named but
    // differently-sourced number; do not widen these two without a design decision (§A2, §A8.3).
    //
    // SM-46d: `serp` and `ai_visibility` are hardcoded literals, NOT `preferenceList(env, ...)` parsed
    // — unlike every other capability below. §A2 rules these two must REFUSE rather than substitute,
    // and an env-parsed list turns that invariant into something a well-meaning operator can widen by
    // editing a deployment variable, with no code review in the loop. Hardcoding makes widening a code
    // change, which routes it through the design gate where it belongs (the QA gate already found one
    // breach in this area: an empty list silently fell back to a different vendor). Do not restore the
    // preferenceList()/env-var parse for these two without a design decision.
    // The rest stay env-overridable per capability (comma-separated ProviderKey list; empty/unset
    // keeps the default) so a plan-tier change or a new vendor fact doesn't require a code edit.
    capabilityPreference: {
      serp: ["dataforseo"],
      volume: preferenceList(process.env.SEARCH_PREFERENCE_VOLUME, ["semrush", "dataforseo", "ahrefs"]),
      // Difficulty rides whichever provider served the volume pull (§A2) — no standalone dispatch op
      // consults this list today, but it is seeded to the same order for documentation/consistency
      // and so a future difficulty-specific read has a real default instead of an invented one.
      difficulty: preferenceList(process.env.SEARCH_PREFERENCE_DIFFICULTY, ["semrush", "dataforseo", "ahrefs"]),
      suggestions: preferenceList(process.env.SEARCH_PREFERENCE_SUGGESTIONS, ["dataforseo", "scraper"]),
      backlinks: preferenceList(process.env.SEARCH_PREFERENCE_BACKLINKS, ["ahrefs", "semrush", "dataforseo"]),
      // Not a standalone OpKind in v1 (rides Labs/metrics pulls, §A2) — seeded for the same
      // forward-looking reason as `difficulty` above.
      competitors: preferenceList(process.env.SEARCH_PREFERENCE_COMPETITORS, ["semrush", "ahrefs"]),
      ai_visibility: ["dataforseo"],
    } as Record<string, string[]>,
    // SM-34/35 (tracker §6): "live" (default) registers real vendor drivers per their own credential
    // checks below; "simulate" registers SM-33's createSimulationProviders() INSTEAD (main.ts), so
    // dev/staging can demo the department at $0 real spend without empty tables. Defaults to "live"
    // so nothing changes by accident for an existing deployment — an operator must opt into
    // simulation explicitly. Anything other than the exact string "simulate" resolves to "live",
    // matching the same typo-safety principle as DATAFORSEO_QUEUE below.
    providerMode: (process.env.SEARCH_PROVIDER_MODE ?? "live") === "simulate" ? "simulate" as const : "live" as const,
    // SM-48 (tracker §6s) — a PLATFORM-LEVEL, tenant-agnostic portfolio-domain list, consumed ONLY by
    // providers/simulation.ts's SERP synthesis, and ONLY in simulate mode (the real drivers never read
    // this field — see simulation.ts's own header). The gap this closes: SM-33's simulated SERP had no
    // knowledge of ANY tenant's tracked property, so a rank-pull always returned `position: null` — the
    // feature could not be demoed. The fix deliberately does NOT thread a tenant's property domain into
    // a per-call SERP request (that would leak tenant A's domain into `search_data_cache`, which is
    // shared, no-RLS market data by design — D-4). Instead this is a single config-wide list folded into
    // the simulator's existing candidate pool and scored by the SAME deterministic keyword×domain
    // function every other candidate uses, so the pool — and therefore the cache — stays identical for
    // every caller regardless of tenant. Comma-separated, trimmed, lower-cased, empty entries dropped;
    // unset (the default) => an empty list => today's simulated SERP candidate pool, byte for byte.
    simulation: {
      portfolioDomains: (process.env.SEARCH_SIMULATION_PORTFOLIO_DOMAINS ?? "")
        .split(",")
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean),
    },
    // SM-52: on a DEFAULT deployment this is the ONLY platform-wide ceiling (tenantMonthlyCapUsd
    // is null unless set), so a silently-inert value here removes the last backstop entirely.
    globalMonthlyCapUsd: numericEnv("SEARCH_GLOBAL_MONTHLY_CAP_USD", { default: 150 }),
    tenantMonthlyCapUsd: moneyEnv("SEARCH_TENANT_MONTHLY_CAP_USD"),
    // max 1: a ratio above 1 could only "warn" past the cap it exists to pre-empt — inert by
    // arithmetic, exactly the class SM-52 closes.
    budgetWarnRatio: numericEnv("SEARCH_BUDGET_WARN_RATIO", { default: 0.8, max: 1 }),
    // SM-40 (design addendum §A3.5) — the per-provider monthly ceiling, evaluated by
    // evaluateBudget's "provider" tier (engagement -> tenant -> provider -> global, dispatch.ts).
    // Keyed by ProviderKey but typed Record<string, ...> here (not importing the ProviderKey type
    // into config.ts) to match capabilityPreference's existing convention just above of not
    // creating a config.ts -> providers/types.ts dependency. `null` => the tier is SKIPPED for
    // that provider (matches tenantMonthlyCapUsd's null-skips-tier semantics) — the honest state
    // for `scraper` (always free, no cap needed) and for any prepaid/PAYG vendor before its plan
    // facts or deposit ceiling are configured. A snapshot computed ONCE from env at module load
    // (same convention as globalMonthlyCapUsd/tenantMonthlyCapUsd immediately above) — tests that
    // need to exercise the provider tier mutate this record directly
    // (`config.search.providerMonthlyCapUsd.dataforseo = X`), exactly like the existing
    // `config.search.tenantMonthlyCapUsd = X` pattern in dispatch.test.ts. The ARITHMETIC that
    // derives the prepaid figures is the separately-exported, separately-testable
    // computeProviderReservationCapUsd() above.
    providerMonthlyCapUsd: {
      dataforseo: dataforseoProviderMonthlyCapUsd,
      semrush: computeProviderReservationCapUsd(semrushMonthlyPlanPriceUsd, semrushReservationFraction),
      ahrefs: computeProviderReservationCapUsd(ahrefsMonthlyApiTierPriceUsd, ahrefsReservationFraction),
      scraper: null,
    } as Record<string, number | null>,
    // SM-32 gate defect fix: bounds keyword-SET cardinality. Both embedKeywordSet and
    // clusterKeywordSet (clustering.ts) fire one sequential AWAITED gateway call per keyword (or per
    // cluster) on a connection `withTenants` holds open for a real BEGIN…COMMIT across that entire
    // loop — with no cap, a handful of large concurrent imports can exhaust the pool, and a hiccup
    // near the end rolls back everything. Default 1000 is deliberately set at exactly the size the
    // SM-09 AC proves deterministic end-to-end ("1k-keyword fixture clusters deterministically") —
    // not padded above it — because that is the only size this pipeline has actually been verified
    // at; anything larger is unproven for both determinism-at-scale and held-transaction duration,
    // so it is refused (400) rather than silently attempted. Raise via env once a chunked-commit
    // design (see clustering.ts's embedKeywordSet/clusterKeywordSet doc comments) replaces the
    // single all-or-nothing transaction for these two routes.
    maxKeywordsPerSet: Number(process.env.SEARCH_MAX_KEYWORDS_PER_SET ?? 1000),
    // DataForSEO server-side credentials (HTTP Basic; ONE shared deposit pool across all clients —
    // never per-client keys, per foundation §8a lever 5). Empty => driver not registered.
    dataforseo: {
      login: process.env.DATAFORSEO_LOGIN ?? "",
      password: process.env.DATAFORSEO_PASSWORD ?? "",
      baseUrl: process.env.DATAFORSEO_BASE_URL ?? "https://api.dataforseo.com",
      // 'standard' (~5 min queue, $0.0006/SERP) vs 'live' (immediate, $0.002 — 3.3x). LOCKED to
      // Standard by default (foundation §8a lever 2); the flag exists so a premium engagement can
      // be flipped deliberately, never by accident.
      queue: (process.env.DATAFORSEO_QUEUE ?? "standard") === "live" ? "live" as const : "standard" as const,
      timeoutMs: Number(process.env.DATAFORSEO_TIMEOUT_MS ?? 20000),
    },
    // Semrush Analytics API v3 credentials (SM-34, providers/semrush.ts). `key` query-param auth
    // (Semrush's own model, not Basic auth). Empty apiKey => driver not registered, independently of
    // DataForSEO's and Ahrefs's own credential checks (SM-34 AC: "keyless per-vendor disable proven
    // independently").
    //
    // Design addendum §A3.3/§A7 OQ-9 (BINDING — supersedes this ticket's earlier draft):
    // `monthlyPlanPriceUsd` and `monthlyUnitAllowance` are OWNER-SUPPLIED, UNVERIFIED facts — the
    // team's actual Semrush plan tier, its monthly API-unit allowance, and its unit price list, all
    // of which require reading the Semrush account console (the Analytics API is historically
    // Business-tier-gated; lower tiers may have no API access at all). They default to 0, which
    // semrush.ts's computeSemrushCostPerUnitUsd() turns into a 0 rate — and a 0 (or otherwise
    // non-positive) rate means the driver does NOT register, even with apiKey present (B1: an unset
    // unit rate must never silently become a $0 estimate, which would disarm the budget stop-loss
    // for every Semrush op). Fill BOTH in from the real invoice before expecting Semrush to register.
    semrush: {
      apiKey: process.env.SEMRUSH_API_KEY ?? "",
      baseUrl: process.env.SEMRUSH_BASE_URL ?? "https://api.semrush.com",
      // Semrush's regional database code (e.g. "us", "uk", "id") used when a request doesn't name one.
      database: process.env.SEMRUSH_DATABASE ?? "us",
      timeoutMs: Number(process.env.SEMRUSH_TIMEOUT_MS ?? 20000),
      monthlyPlanPriceUsd: semrushMonthlyPlanPriceUsd,
      monthlyUnitAllowance: semrushMonthlyUnitAllowance,
    },
    // Ahrefs API v3 credentials (SM-35, providers/ahrefs.ts). Bearer-token auth. Empty apiKey =>
    // driver not registered, independently of DataForSEO's and Semrush's own credential checks.
    //
    // Design addendum §A3.3/§A7 OQ-10 (BINDING): `monthlyApiTierPriceUsd` and
    // `monthlyApiTierUnitAllowance` are OWNER-SUPPLIED, UNVERIFIED facts — whether the team's current
    // Ahrefs plan even includes API v3 at all (historically Enterprise-gated; newer plans reportedly
    // sell API access separately), and if so its price/allowance, all requiring the owner to read the
    // Ahrefs account console. They default to 0, which ahrefs.ts's computeAhrefsCostPerUnitUsd() turns
    // into a 0 rate — and per B1, a non-positive rate means the driver does NOT register, even with
    // apiKey present. Fill BOTH in from the real invoice before expecting Ahrefs to register.
    ahrefs: {
      apiKey: process.env.AHREFS_API_KEY ?? "",
      baseUrl: process.env.AHREFS_BASE_URL ?? "https://api.ahrefs.com/v3",
      // ISO 3166-1 alpha-2 country code used by keywords-explorer/organic-competitors/serp-overview
      // when a request doesn't specify one.
      country: process.env.AHREFS_COUNTRY ?? "us",
      timeoutMs: Number(process.env.AHREFS_TIMEOUT_MS ?? 20000),
      // SERP Overview requires a pre-existing Ahrefs Rank Tracker project id (confirmed via
      // docs.ahrefs.com: `project_id` is a REQUIRED param). This platform does not provision Rank
      // Tracker projects, so this must be supplied by an operator who has created one manually;
      // unset => the 'serp' capability refuses cleanly before any network call (ahrefs.ts).
      rankTrackerProjectId: process.env.AHREFS_RANK_TRACKER_PROJECT_ID ?? "",
      monthlyApiTierPriceUsd: ahrefsMonthlyApiTierPriceUsd,
      monthlyApiTierUnitAllowance: ahrefsMonthlyApiTierUnitAllowance,
    },
    // Per-pillar kill switches (design §12 SM-06). Default ON — they are an operator brake for an
    // incident (a provider misbehaving, a cost surprise), not a rollout gate. A disabled pillar
    // refuses at the same fail-closed choke-point as an unregistered provider.
    pillars: {
      seo: (process.env.SEARCH_PILLAR_SEO ?? "1") !== "0",
      sem: (process.env.SEARCH_PILLAR_SEM ?? "1") !== "0",
      geo: (process.env.SEARCH_PILLAR_GEO ?? "1") !== "0",
    },
  },
  // WD-04 (Web Dev Phase 1 §12) — in-ERP audio upload -> server-side transcription. Calls the
  // whisper container's OpenAI-compatible /v1/audio/transcriptions endpoint DIRECTLY (never via
  // ai-gateway-go): meeting-length audio can exceed the gateway's ~2.5-min per-call timeout
  // (design §09), a limit that exists for the gateway's synchronous request path, not for this
  // dedicated server-side transcription job. Empty url => the upload endpoint refuses with a
  // clear "not configured" error rather than half-working against a phantom host (same
  // fail-soft convention as every other optional downstream in this file).
  whisper: {
    url: process.env.WHISPER_URL ?? "",
    model: process.env.WHISPER_MODEL ?? "Systran/faster-whisper-small",
    // Generous ceiling (default 20 min): faster-whisper-small on CPU transcribing a real
    // meeting-length recording is slow; this is a background job, not a request-latency budget.
    timeoutMs: Number(process.env.WHISPER_TIMEOUT_MS ?? 20 * 60 * 1000),
  },
  // The size cap for the in-ERP audio upload (WD-04 AC: oversized refused). Default 200MB —
  // comfortably above a multi-hour meeting compressed to a voice-quality .m4a/.mp3.
  meetingAudio: {
    maxBytes: Number(process.env.MEETING_AUDIO_MAX_BYTES ?? 200 * 1024 * 1024),
  },
  // Event → n8n bridge (WS4 §4): forwards allow-listed event-backbone events to n8n webhooks
  // so automations can trigger on business events, not just CRON/webhook. Fail-closed: the
  // bridge only starts when a webhook base URL, a shared secret, an event allow-list, AND the
  // entity_type streams to watch are ALL set (empty anything -> bridge disabled).
  n8nBridge: {
    webhookBaseUrl: process.env.N8N_WEBHOOK_BASE_URL ?? "",
    secret: process.env.N8N_BRIDGE_SECRET ?? "",
    // Event types (event_type column) allowed to cross to n8n, e.g. "org_structure.updated".
    events: (process.env.N8N_BRIDGE_EVENTS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    // Redis Streams to watch (keyed by entity_type), e.g. "deliverable,org_structure,client".
    entityTypes: (process.env.N8N_BRIDGE_ENTITY_TYPES ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    // DEF-1 (2026-07-30): raised 5000 -> 30000. The meeting dispatcher does real AI work inline
    // (MOM + 3 extractions + a recording-context read), measured at 15-23s end to end, so a 5s
    // timeout made the ingest proxy return {ok:false, reason:"dispatcher_unreachable"} on EVERY
    // ingest: the run completed correctly server-side, but the recording never flipped to
    // `ingested` and never got `pipeline_run_id` linked, silently breaking the capture->run link.
    // 30s covers the measured range with headroom. A fire-and-forget ingest (202 + async link) is
    // the better long-term shape, but that changes the frozen dispatcher contract's response
    // semantics, so it is deliberately not done here.
    timeoutMs: Number(process.env.N8N_BRIDGE_TIMEOUT_MS ?? 30000),
  },
  // Event → knowledge-graph bridge (WS8 Step E live wire): forwards every business event on the
  // watched entity_type streams to the WS8 knowledge service's /graph/ingest, which turns each into
  // source-of-truth graph nodes/edges (D9.2). Reuses services.knowledge.{url,token}. Fail-closed:
  // starts only when the knowledge URL+token AND an entity-type list are all set.
  graphBridge: {
    entityTypes: (process.env.GRAPH_BRIDGE_ENTITY_TYPES ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    timeoutMs: Number(process.env.GRAPH_BRIDGE_TIMEOUT_MS ?? 5000),
  },
};

/** The bridge is fully configured (all four knobs present) and may start. */
export function n8nBridgeEnabled(): boolean {
  const b = config.n8nBridge;
  return !!(b.webhookBaseUrl && b.secret && b.events.length && b.entityTypes.length);
}

/** The graph bridge may start: a reachable knowledge service + at least one entity stream to watch. */
export function graphBridgeEnabled(): boolean {
  return !!(config.services.knowledge.url && config.services.knowledge.token && config.graphBridge.entityTypes.length);
}
