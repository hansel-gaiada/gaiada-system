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

// MAIL-04 (design §4.1) — one stream's transport facts, read for a given env-var PREFIX
// ("NOTIFY" | "AUTH"). `defaultFrom` is the ONLY per-stream literal, and it is a RESERVED-TLD
// fake (A12) — `*.gaiada.invalid` — so a deployment that forgets to set the real `*_FROM` value
// sends from an address that can never resolve or deliver, rather than silently leaking a
// plausible-looking `gaiada.com` identity nobody actually configured.
function mailStreamConfig(prefix: "NOTIFY" | "AUTH", defaultFrom: string) {
  return {
    // A8: operator failover flip, per stream. Anything other than the literal "brevo" is "relay"
    // (same typo-safety convention as SEARCH_PROVIDER_MODE/DATAFORSEO_QUEUE elsewhere in this file).
    transport: (process.env[`MAIL_STREAM_${prefix}_TRANSPORT`] ?? "relay") === "brevo" ? ("brevo" as const) : ("relay" as const),
    from: process.env[`MAIL_STREAM_${prefix}_FROM`] ?? defaultFrom,
    relay: {
      host: process.env[`MAIL_STREAM_${prefix}_RELAY_HOST`] ?? "",
      port: Number(process.env[`MAIL_STREAM_${prefix}_RELAY_PORT`] ?? 587),
      user: process.env[`MAIL_STREAM_${prefix}_RELAY_USER`] ?? "",
      password: process.env[`MAIL_STREAM_${prefix}_RELAY_PASSWORD`] ?? "",
    },
    brevo: {
      host: process.env[`MAIL_STREAM_${prefix}_BREVO_HOST`] ?? "",
      port: Number(process.env[`MAIL_STREAM_${prefix}_BREVO_PORT`] ?? 587),
      user: process.env[`MAIL_STREAM_${prefix}_BREVO_USER`] ?? "",
      password: process.env[`MAIL_STREAM_${prefix}_BREVO_PASSWORD`] ?? "",
    },
  };
}

const configBase = {
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
  // W0-3 — Keycloak ADMIN access, used ONLY to provision client-portal contact accounts on invite
  // acceptance. Deliberately separate from the oidc* keys above: those verify incoming tokens, this
  // one CREATES users, and the two should never share a credential.
  //
  // FAIL-CLOSED like every other optional downstream in this file: any of the four unset =>
  // keycloakAdminConfigured() is false and every provisioning entry point throws
  // KeycloakNotConfiguredError, which maps to an honest 503 rather than half-creating an account.
  //
  // The client must be a CONFIDENTIAL SERVICE-ACCOUNT client holding realm-management:manage-users
  // (+ view-users). Use a dedicated one -- `gaiada-provisioner` exists on the gaiada realm for
  // exactly this -- never the master-realm admin, and never the gaiada-platform client whose
  // audience the API itself trusts: a leaked provisioner secret should be able to manage users and
  // nothing else. Verified boundary: it cannot create clients and cannot map realm-admin onto a user.
  //
  // baseUrl is the realm ROOT (no /realms/... suffix) -- note this deployment serves Keycloak under
  // `/idp`, so internally that is http://keycloak:8080/idp, NOT /auth.
  // W0-4 — client-portal invite links. TTL is short on purpose: the token grants ACCOUNT CREATION,
  // not merely a read, so a stale link left in an inbox is a liability rather than a convenience.
  // 72h is long enough for a client to act across a weekend.
  clientInvites: {
    ttlSeconds: Number(process.env.CLIENT_INVITE_TTL_SECONDS ?? 72 * 60 * 60),
  },
  keycloakAdmin: {
    baseUrl: process.env.KEYCLOAK_ADMIN_BASE_URL ?? "",
    realm: process.env.KEYCLOAK_ADMIN_REALM ?? "gaiada",
    clientId: process.env.KEYCLOAK_ADMIN_CLIENT_ID ?? "",
    clientSecret: process.env.KEYCLOAK_ADMIN_CLIENT_SECRET ?? "",
  },
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
  // D14-03/D14-04 — the ONE shared HMAC secret for the single-use automation-write EXECUTION GRANT
  // (contract: docs/superpowers/plans/2026-08-05-d14-and-assistant-tickets.md §1). platform-nest MINTS
  // a grant inside an approval's `pending -> executing` claim; mcp-hub VERIFIES it and lifts ONLY its
  // impact-suspend gate for that exact tool + args. It must be byte-identical in both services'
  // `environment:` blocks (already wired in infra/compose/docker-compose.vps.yml for platform,
  // mcp-hub and mcp-hub-central — the compose env-passthrough trap).
  //
  // Empty => FAIL CLOSED, and loudly rather than silently: core/hub-client.ts throws
  // ApprovalGrantNotConfiguredError instead of minting an unsigned grant, so the approval lands
  // `execution_status='failed'` with `not_configured: …` and notifies. That is deliberate — the
  // alternative (mint with an empty key) would be rejected hub-side as `bad_signature` and
  // misdiagnosed as a broken contract rather than an unfinished deployment. NEVER logged.
  //
  // The executor ALSO needs HUB_URL + HUB_SERVICE_TOKEN (config.services.hub below) to reach the
  // hub at all; with either unset the re-drive records `not_configured` rather than half-attempting.
  approvalGrantSecret: process.env.APPROVAL_GRANT_SECRET ?? "",
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
  // TR-07 (tracker/reporting §6.2's REPORTS_TZ, OQ-1): the IANA zone that decides which calendar
  // DAY a `work_activity.occurred_at` timestamp belongs to when the fact job buckets it into
  // `report_work_facts.fact_date`. It must be a single deploy-wide answer rather than the caller's
  // local zone, or the same event lands on different days for different readers and a day's
  // company total stops being reproducible. UTC by default — matching dept-resolution.ts's
  // todayIso() and every other calendar-day comparison in the program.
  reportsTz: process.env.REPORTS_TZ ?? "UTC",
  // IT-01/03 network discovery (docs/superpowers/specs/2026-08-03-it-network-discovery-design.md).
  itDiscovery: {
    // PRIVACY GATE, default DENY. ~25 of the 58 hosts observed on the office network are personal
    // phones whose hostnames name staff outright (Ratihs-iPhone, A56-milik-Tini, ...). Persisting
    // them with MAC + per-poll timestamps builds a presence log of named employees on their own
    // devices, which CLAUDE.md forbids before legal Gate 1. When off (the default) the report
    // endpoint counts BYOD clients and discards them without ever writing a row.
    persistByod:
      process.env.IT_DISCOVERY_PERSIST_BYOD === "1" || process.env.IT_DISCOVERY_PERSIST_BYOD === "true",
    // Hostname patterns that mark a discovered client as a COMPANY asset ('managed'). Anything that
    // matches none of these is 'byod' — default-deny, so a new unknown device is never persisted by
    // accident. Comma-separated regexes; the defaults cover the observed corporate naming.
    managedHostnamePatterns: (process.env.IT_DISCOVERY_MANAGED_PATTERNS ??
      "^GDA-,^DESKTOP-,^LAPTOP-,^MSI\\.,^Dina\\.,^Laptop-").split(",").map((s) => s.trim()).filter(Boolean),
    // Derived-status thresholds (IT-03). Sized off a 5-minute collector interval: a device seen
    // within 2 intervals is online, within 6 it is degraded (missed polls), beyond that offline.
    // NEVER probe with ICMP to decide this — only 12 of 58 real hosts answer ping.
    onlineWindowMs: Number(process.env.IT_DISCOVERY_ONLINE_WINDOW_MS ?? 11 * 60 * 1000),
    degradedWindowMs: Number(process.env.IT_DISCOVERY_DEGRADED_WINDOW_MS ?? 31 * 60 * 1000),
    // The stale reaper. Fail-soft and OFF by default, like every other background sweep here.
    reaperEnabled:
      process.env.IT_DISCOVERY_REAPER_ENABLED === "1" || process.env.IT_DISCOVERY_REAPER_ENABLED === "true",
    reaperIntervalMs: Number(process.env.IT_DISCOVERY_REAPER_INTERVAL_MS ?? 5 * 60 * 1000),
  },
  // Downstream service endpoints the admin/systems console aggregates (Phase C). All
  // read-only; empty URL -> that system reports "not configured" (fail-soft, never fake).
  services: {
    gateway: { url: process.env.GATEWAY_URL ?? "", token: process.env.GATEWAY_TOKEN ?? "" },
    bot: { url: process.env.BOT_URL ?? "", token: process.env.BOT_ADMIN_TOKEN ?? process.env.ADMIN_TOKEN ?? "" },
    // `assuranceToken` (mcp-hub design §2, 2026-08-06): the platform is one of exactly two services
    // entitled to mint `verified` hub principals — it IS the IdP, so it is the one caller whose word
    // "this envelope belongs to a session I authenticated" means something. Presented instead of
    // `token` on OBO tool calls (core/hub-client.ts) so the D14 agent re-drive can clear
    // `approvals.resolveExecute`'s `minAssurance: "verified"` floor. Empty ⇒ falls back to `token`,
    // i.e. exactly today's behaviour (every verified-tier tool denied), never a failure to call.
    hub: {
      url: process.env.HUB_URL ?? "",
      token: process.env.HUB_SERVICE_TOKEN ?? "",
      assuranceToken: process.env.HUB_ASSURANCE_TOKEN ?? "",
    },
    knowledge: { url: process.env.KNOWLEDGE_URL ?? "", token: process.env.KNOWLEDGE_SERVICE_TOKEN ?? "" },
    // n8n: token is its Public-API key (X-N8N-API-KEY) used to list workflows/executions.
    automation: { url: process.env.AUTOMATION_URL ?? "", token: process.env.AUTOMATION_API_KEY ?? "" },
    // B3 (erp-whatsapp-and-agent-runtime-e2e.md §3.3): the agent-runner service (B1). Bearer
    // AGENT_RUNNER_TOKEN gates every runner call, same convention as the other service tokens.
    agents: { url: process.env.AGENTS_URL ?? "", token: process.env.AGENT_RUNNER_TOKEN ?? "" },
  },
  // ASST-06 — the assistant's send->stream engine. Reuses `services.gateway` above for the actual
  // ai-gateway-go URL/token (already the one place GATEWAY_URL/GATEWAY_TOKEN are wired from env,
  // same binding admin-systems.controller.ts and search's providers/gateway-client.ts read) —
  // these two knobs are assistant-specific TUNABLES, not a second gateway endpoint.
  assistant: {
    // Server-side idle timeout for a single streamed generation (modules/assistant/stream.ts):
    // no token/event received from ai-gateway-go for this long -> abort the upstream fetch and
    // surface a visible `error` event (errorKind 'idle_timeout') rather than hanging the SSE
    // connection forever. Deliberately shorter than the blueprint's client-side 120s idle timeout
    // (§5/ASST-07) so the SERVER fails the stalled generation first and the browser sees a clean
    // error instead of ever hitting its own timeout.
    streamIdleTimeoutMs: Number(process.env.ASSISTANT_STREAM_IDLE_TIMEOUT_MS ?? 60_000),
    // Context-assembly char budget (modules/assistant/context.ts) for the recent-messages window
    // kept VERBATIM in the prompt sent to the gateway. Approximate (~4 chars/token), not a real
    // tokenizer count -- the gateway's /complete(/stream) wire carries no usage field for us to
    // calibrate against (ASST-10's grammar has no `usage` event upstream). Overflow beyond this
    // budget triggers compaction v1 (fold the oldest excerpt into the thread's rolling summary).
    contextCharBudget: Number(process.env.ASSISTANT_CONTEXT_CHAR_BUDGET ?? 12_000),
    // ASST-18 — how many knowledge chunks context.ts's RAG retrieval asks WS8's `/search` for on
    // every context assembly. `0` disables retrieval outright (an explicit opt-out, not a silent
    // one) — `assembleContext` skips the call entirely rather than asking for zero and getting an
    // empty array back, so this is a real "off" switch, not just a very small "on".
    knowledgeTopK: Number(process.env.ASSISTANT_KNOWLEDGE_TOPK ?? 4),
  },
  /**
   * BROWSER-reachable n8n editor origin — deliberately NOT `services.automation.url`.
   *
   * That one is the in-cluster base (`http://n8n:5678`) the platform calls the Public API on: a
   * hostname that resolves only inside the compose network. It was being handed to the UI as the
   * "Open in n8n" link target, so the button was unclickable-by-design from any real browser while
   * looking perfectly healthy in the console. Two different audiences, two different values.
   *
   * Deliberately OUTSIDE `services` — that object is indexed by system name
   * (`config.services[system]`), so an extra key there would read as another probeable service.
   *
   * Empty by default: the UI hides the affordance when it is unset, which is strictly better than
   * rendering a link that 404s. Trailing slash stripped so callers can append paths freely.
   */
  automationPublicUrl: (process.env.AUTOMATION_PUBLIC_URL ?? "").replace(/\/$/, ""),
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
    // SM-56's collect-edge shared secret, moved here from its interim parse site in
    // search.controller.ts (that ticket read `process.env` directly because this file was held by a
    // concurrent agent, and reported the key rather than smuggling it — this is the promised move).
    //
    // **Deliberately NOT routed through moneyEnv/numericEnv**: those exist to refuse an
    // uninterpretable MONEY value at boot, because a silently-inert cap leaves spend unbounded. A
    // secret has the opposite failure shape — an empty secret does not weaken the control, it makes
    // the route refuse EVERY request (search.controller.ts's `assertCallbackSecret`). So unset is
    // fail-CLOSED here, and there is nothing to validate at boot: any non-empty string is a
    // syntactically valid secret, and we must not compare against a value we have "corrected".
    //
    // Left as a plain string with an empty default so the fail-closed branch stays reachable and
    // testable. Do not "improve" this into a throw-if-unset: it is unset in every environment today
    // (SM-55 deleted the only consumer), and booting the whole platform down over an unused
    // integration secret would be a fail-open of a different kind — an operator would remove the
    // check to get the stack up.
    callbackSecret: process.env.SEARCH_CALLBACK_SECRET ?? "",
    // SM-20's search-terms ingest secret. DELIBERATELY a SECOND secret, not a reuse of the one above:
    // that guards a paid-vendor postback (DataForSEO), this guards a script running inside the client's
    // own Google Ads account. They are two different external trust boundaries, and one shared value
    // would mean a compromise of either grants both. Same fail-closed-when-unset reasoning as above
    // applies verbatim, including the "do not improve this into a throw-if-unset" warning.
    semCallbackSecret: process.env.SEARCH_SEM_CALLBACK_SECRET ?? "",
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
    // SM-54 (tracker §6ad Ruling 1 / addendum §A13.2) — the platform-side pull scheduler
    // (modules/search/pull-scheduler.ts). DARK BY DEFAULT, and here that is a money control rather
    // than a convention: this is the one loop in the platform that spends VENDOR MONEY with no human
    // in the request path, so it must never start itself in a dev environment, a test run, or a fresh
    // deployment where nobody has set per-engagement budgets yet. Same env-flag shape as
    // PM_BURNDOWN_SNAPSHOT_ENABLED / SERVICE_ASSIGNMENTS_ENABLED.
    schedulerEnabled:
      process.env.SEARCH_SCHEDULER_ENABLED === "1" || process.env.SEARCH_SCHEDULER_ENABLED === "true",
    // How often DUE-NESS IS RE-ASKED — NOT how often a pull happens. Cadence is derived per
    // engagement from `tool_scope.<tool>.cadence` vs that tool's last capture-or-attempt, so shrinking
    // this interval cannot increase spend; it only reduces how late a due pull fires. Default 1h.
    //
    // Routed through numericEnv (not a raw `Number(...)`, unlike the burndown/drift intervals) for a
    // reason specific to this job: `Number("1 hour")` is NaN, `setTimeout(fn, NaN)` fires IMMEDIATELY,
    // and an immediately-rescheduling loop over a money path is a hot loop that re-asks due-ness
    // thousands of times a second. The cadence gate means it still would not over-spend, but it would
    // hammer Postgres, and a typo must not be able to do that silently. `min: 1000` refuses a
    // sub-second interval outright while leaving dev tuning available (numericEnv's bound is
    // EXCLUSIVE — `n > min` — so anything at or below 1000ms is refused at boot).
    schedulerIntervalMs: numericEnv("SEARCH_SCHEDULER_INTERVAL_MS", { default: 3600 * 1000, min: 1000 }),
    // Per-pillar kill switches (design §12 SM-06). Default ON — they are an operator brake for an
    // incident (a provider misbehaving, a cost surprise), not a rollout gate. A disabled pillar
    // refuses at the same fail-closed choke-point as an unregistered provider.
    pillars: {
      seo: (process.env.SEARCH_PILLAR_SEO ?? "1") !== "0",
      sem: (process.env.SEARCH_PILLAR_SEM ?? "1") !== "0",
      geo: (process.env.SEARCH_PILLAR_GEO ?? "1") !== "0",
    },
    // ── SM-51 / SM-25a · GOOGLE CLIENT-ACCOUNT SURFACES (GSC / GA4 / Ads) ─────────────────────────
    // Design addendum §A12 (binding): these are a THIRD EGRESS CLASS, not vendor market data.
    // client-private + $0-API-billed + per-client-OAuth, so they do NOT ride SearchDataProvider /
    // dispatchProviderOp (there is no money to meter) and they NEVER touch search_data_cache (no-RLS
    // shared market data by design — a client's own Search Console rows there would be a cross-tenant
    // leak BY CONSTRUCTION, not by bug). The bounding resource is Google QUOTA, not dollars.
    //
    // FAIL-CLOSED, like every other optional downstream in this file: with clientId/clientSecret/
    // redirectUri unset there is no partially-working Google surface — googleOAuthConfigured() is
    // false and every OAuth entry point throws GoogleOAuthNotConfiguredError, which
    // GoogleOAuthErrorFilter maps to an honest 503 (modules/search/google/errors.ts). That mapping is
    // deliberate and not optional: this module has now twice shipped a plain Error that escaped as a
    // body-less 500 (SM-53's ProviderDispatchError, SM-57's GatewayNotConfiguredError).
    //
    // ENDPOINT SEAMS EXIST SO THE FLOW IS EXERCISABLE WITHOUT A GOOGLE OAUTH CLIENT (§A12.3): the
    // authorize/token/revoke URLs are pointed at the local Keycloak realm (the machine path — real
    // authorization-code + PKCE + rotation + RFC-7009 on real sockets) or at SM-51's in-process
    // google sandbox in tests. §A10.4's private-host boot guard EXTENDS to these seams in live mode
    // (assertLiveGoogleEndpointsAreNotPrivate, called from main.ts's live branch) so a deployed
    // "live" stack cannot silently be pointed at a dev issuer.
    //
    // WHAT NO LOCAL SETUP CAN PROVE — SM-41G's staging clauses, restated here because this config
    // block is where an operator forms their expectations: Google's consent screen, incremental
    // consent and scope-grant semantics; refresh-token longevity under the OAuth app's publish status
    // (Testing-mode refresh tokens expire in 7 days); Google-side revocation; quota/429 behaviour;
    // the Ads developer-token approval + MCC/login-customer-id semantics; and whether real Google
    // accepts our serialized requests at all.
    google: {
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
      // The ONE registered redirect URI. Deliberately tenant-agnostic: real Google requires EXACT
      // registered redirect URIs (no wildcards), so a per-tenant callback path would need one
      // registration per company. The tenant travels in the signed `state` instead (oauth-state.ts).
      redirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI ?? "",
      authorizeUrl: process.env.GOOGLE_OAUTH_AUTHORIZE_URL ?? "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: process.env.GOOGLE_OAUTH_TOKEN_URL ?? "https://oauth2.googleapis.com/token",
      // RFC 7009 revocation endpoint (Google's own documented spelling of it).
      revokeUrl: process.env.GOOGLE_OAUTH_REVOKE_URL ?? "https://oauth2.googleapis.com/revoke",
      searchConsoleBaseUrl: process.env.GOOGLE_SEARCH_CONSOLE_BASE_URL ?? "https://searchconsole.googleapis.com",
      analyticsDataBaseUrl: process.env.GOOGLE_ANALYTICS_DATA_BASE_URL ?? "https://analyticsdata.googleapis.com",
      adsBaseUrl: process.env.GOOGLE_ADS_BASE_URL ?? "https://googleads.googleapis.com",
      // Ads-only extras. UNVERIFIED plan/approval facts (SM-41G): a developer token must be approved
      // by Google before it works at all, and login-customer-id/MCC semantics are unrehearsable
      // locally. Empty => the Ads surface refuses rather than half-working (SM-25c's own AC).
      adsDeveloperToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN ?? "",
      adsLoginCustomerId: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ?? "",
      adsApiVersion: process.env.GOOGLE_ADS_API_VERSION ?? "v18",
      // How long an in-flight authorization request stays redeemable. Short on purpose: the row holds
      // a PKCE verifier, and a stale authorize link is a liability, not a convenience.
      stateTtlSeconds: Number(process.env.GOOGLE_OAUTH_STATE_TTL_SECONDS ?? 600),
      // Refresh this many seconds BEFORE the stored expiry, so a call never races its own token.
      refreshSkewSeconds: Number(process.env.GOOGLE_OAUTH_REFRESH_SKEW_SECONDS ?? 120),
      timeoutMs: Number(process.env.GOOGLE_OAUTH_TIMEOUT_MS ?? 15000),
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
    // Video takes its own, larger cap: the same meeting is an order of magnitude bigger with a
    // picture attached. Default 500MB, which at the browser recorder's own bitrate ceiling
    // (~800 kbps video + 32 kbps audio) is comfortably more than a 60-minute meeting.
    //
    // WHY THIS IS NOT SET TO SOMETHING HUGE, stated because the number looks arbitrary otherwise:
    // the upload path buffers the WHOLE file in memory (`mp.toBuffer()`), and
    // `transcribeWithWhisper` then makes a second copy for the multipart body it sends on — so peak
    // RSS is roughly 2x the file. A multi-gigabyte cap here would turn one long recording into an
    // OOM of the platform container. Raising it means streaming to storage first, which is a
    // different change. Both caps are enforced per-kind in meetings.controller.ts, because the
    // multipart plugin can register only ONE fileSize for the whole app.
    maxVideoBytes: Number(process.env.MEETING_VIDEO_MAX_BYTES ?? 500 * 1024 * 1024),
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
  // TR-21 (tracker/reporting §6.3) — the report-renderer sidecar (TR-19) this platform calls to
  // turn a one-shot `jobToken` URL into PDF bytes. Same fail-soft convention as every other
  // optional downstream in this file: any of the three unset -> the pdf export path refuses with
  // a clear 503 rather than half-attempting a call with an empty token or an empty target origin
  // (report-pdf-export.ts's own guard restates this at the point of enforcement). `url` is
  // report-renderer's OWN address (`http://report-renderer:3007` in compose); `token` is the
  // SAME `RENDERER_TOKEN` the sidecar's own auth.ts checks; `platformUiInternalUrl` is embedded
  // into the URL handed to the sidecar (`{platformUiInternalUrl}/print/reports/{jobToken}`) —
  // it MUST be byte-identical to the sidecar's own `PLATFORM_UI_INTERNAL_URL` (its `isAllowedRenderUrl`
  // same-origin check), so both read the SAME env var name deliberately.
  reportRenderer: {
    url: process.env.REPORT_RENDERER_URL ?? "",
    token: process.env.RENDERER_TOKEN ?? "",
    platformUiInternalUrl: process.env.PLATFORM_UI_INTERNAL_URL ?? "",
    timeoutMs: Number(process.env.REPORT_RENDERER_TIMEOUT_MS ?? 30000),
  },
  // Knowledge (D9 RAG) ingestion — the two corpora the store is filled from.
  //
  // PUBLIC tier: our own marketing site, ingested as world-readable chunks so an agent can answer a
  // lead with no ERP identity. `publicSites` is an EGRESS ALLOWLIST, not a hint: the fetcher refuses
  // any URL — seed, sitemap entry, discovered link, or redirect target — whose host is not in it.
  // Leave it at gaiada.com unless you have read the SSRF note at the top of ingest/web-source.ts.
  // `publicTenantId` is only the owning company row for those chunks; it does NOT restrict who may
  // read them (that is what audience='public' means).
  //
  // INTERNAL tier: ERP records for the listed tenants (empty = every active company), readable by
  // that company's members only. Both tiers run on `intervalMs` and can be triggered on demand from
  // the admin console. Fail-closed: with no knowledge URL/token configured, nothing runs at all.
  knowledgeIngest: {
    enabled: (process.env.KNOWLEDGE_INGEST_ENABLED ?? "") === "1",
    intervalMs: Number(process.env.KNOWLEDGE_INGEST_INTERVAL_MS ?? 6 * 60 * 60 * 1000),
    publicSites: (process.env.KNOWLEDGE_PUBLIC_SITES ?? "https://gaiada.com").split(",").map((s) => s.trim()).filter(Boolean),
    publicTenantId: process.env.KNOWLEDGE_PUBLIC_TENANT_ID ?? "",
    publicMaxPages: Number(process.env.KNOWLEDGE_PUBLIC_MAX_PAGES ?? 150),
    internalTenantIds: (process.env.KNOWLEDGE_INTERNAL_TENANT_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    /** Index attached-file CONTENTS (text/spreadsheet only — see ingest/file-text.ts). */
    indexFileContents: (process.env.KNOWLEDGE_INDEX_FILE_CONTENTS ?? "1") === "1",
  },
  // MAIL-04 (docs/superpowers/specs/2026-08-04-zone-a-mail-design.md v3 §4.1/§10/§12). `src/mail/`
  // is core infra (A1), not a ModuleContract module — no per-tenant enable gate, same class as
  // `src/events/`.
  //
  // A12 (BINDING, grep-gate enforced): every domain/FROM/link-base below defaults to a
  // RESERVED-TLD fake (`*.gaiada.invalid`) — never a real `gaiada.com`/`gaiada.online` literal —
  // so a deployment that forgets to override an env var fails obviously (nothing resolves,
  // nothing delivers) instead of silently sending as a plausible-looking identity nobody
  // configured. The staging swap is an env change only; nothing in `src/mail/` ever needs editing.
  mail: {
    // Master gate (design §7.8): 0 (default) = the whole module is dark — the sender loop is never
    // started (see main.ts) and `enqueueMail` no-ops rather than writing a row, so there truly are
    // zero side effects, not merely "nothing gets sent". 1 = live (still routes through the
    // dev-log adapter with no per-stream host configured — see provider.ts's resolveAdapter).
    enabled: process.env.MAIL_ENABLED === "1",
    senderIntervalMs: Number(process.env.MAIL_SENDER_INTERVAL_MS ?? 15000),
    // VERP reply-token domain (§7.6). The local part (`reply+<token>@`) is built by the caller;
    // this is only the host half.
    replyDomain: process.env.MAIL_REPLY_DOMAIN ?? "notify.gaiada.invalid",
    // The deep-link base every approval/warning template's `href` is built from (A12 — brand new;
    // no ERP public-base config existed before this). Trailing slash stripped so callers can
    // append paths freely, matching `automationPublicUrl`'s convention above.
    linkBaseUrl: (process.env.MAIL_LINK_BASE_URL ?? "https://erp.gaiada.invalid").replace(/\/$/, ""),
    // Provider delivery-event webhook auth (§7.7). Empty => the webhook refuses every request
    // (fail-closed, same convention as SEARCH_CALLBACK_SECRET) — an unconfigured secret is an
    // unfinished deployment, not permission to skip the check.
    webhookToken: process.env.MAIL_WEBHOOK_TOKEN ?? "",
    // Inbound intake auth + caps (§7.6). Scanning is a tri-state string, not a boolean, because a
    // third value ('clamav') names a REAL dependency (MAIL-14) rather than just "on".
    inboundToken: process.env.MAIL_INBOUND_TOKEN ?? "",
    inboundMaxBytes: Number(process.env.MAIL_INBOUND_MAX_BYTES ?? 5 * 1024 * 1024),
    inboundScan: (process.env.MAIL_INBOUND_SCAN ?? "off") === "clamav" ? ("clamav" as const) : ("off" as const),
    // MAIL-13 (design §7.6). Brevo offers NO payload signature — its documented options are
    // basic-auth-in-URL, a token header, or custom headers (verified against Brevo's docs
    // 2026-08-04; see src/mail/inbound/auth.ts's header comment). So the token above is the wall
    // that is real today, and this key enables an ADDITIONAL HMAC-SHA256 verifier over the raw
    // request bytes. Empty (the default) => signature verification reports `off` rather than
    // pretending to have passed. Set => a valid signature is REQUIRED (fail-closed on the
    // configured path).
    inboundSigningKey: process.env.MAIL_INBOUND_SIGNING_KEY ?? "",
    inboundSignatureToleranceS: Number(process.env.MAIL_INBOUND_SIGNATURE_TOLERANCE_S ?? 300),
    // Per-attachment + count caps (§7.6, listed alongside the total-message cap). An attachment over
    // either cap is DROPPED while the message still threads; only the TOTAL cap above refuses a whole
    // delivery. Rationale in src/mail/inbound/intake.ts's cap-policy note.
    inboundMaxAttachmentBytes: Number(process.env.MAIL_INBOUND_MAX_ATTACHMENT_BYTES ?? 2 * 1024 * 1024),
    inboundMaxAttachments: Number(process.env.MAIL_INBOUND_MAX_ATTACHMENTS ?? 10),
    // Per-source flood control (§7.8). 0 disables. In-process/per-instance by design — there is no
    // Redis dependency in src/mail/ (A2); see src/mail/inbound/rate-limit.ts.
    inboundRatePerMin: Number(process.env.MAIL_INBOUND_RATE_PER_MIN ?? 60),
    // MAIL-14's clamd. Reachable only when the compose `scan` profile is up; unreachable => every
    // attachment stays `pending` => downloads refused (fail-closed on exposure, §7.6).
    clamavHost: process.env.MAIL_CLAMAV_HOST ?? "clamav",
    clamavPort: Number(process.env.MAIL_CLAMAV_PORT ?? 3310),
    clamavTimeoutMs: Number(process.env.MAIL_CLAMAV_TIMEOUT_MS ?? 20000),
    // §9 — stays 0 for real users until the staging M8 SLO gate closes (§15 R5); dev may flip it
    // for dev-created users once MAIL-10 lands. Read here even though MAIL-10 ships in its own
    // later ticket, so the env/compose wiring lands once and never has to be revisited per-ticket.
    magicLinksEnabled: process.env.MAIL_MAGIC_LINKS_ENABLED === "1",
    // MAIL-10 — token lifetime + the two rate-limit dimensions the ticket AC names verbatim
    // ("3 per address/hour, 10 per IP/hour"). Short TTL on purpose: like client_invites' token,
    // this one grants a live SESSION, not merely a read, so a stale link sitting in an inbox is a
    // liability, not a convenience.
    magicLinkTtlSeconds: Number(process.env.MAIL_MAGIC_LINK_TTL_SECONDS ?? 15 * 60),
    magicLinkRatePerAddressHour: Number(process.env.MAIL_MAGIC_LINK_RATE_PER_ADDRESS_HOUR ?? 3),
    magicLinkRatePerIpHour: Number(process.env.MAIL_MAGIC_LINK_RATE_PER_IP_HOUR ?? 10),
    // MAIL-24 (QA-MAIL-11 Finding 3, LOW/latent) — trusted-proxy allowlist for
    // `magic-link/controller.ts`'s `clientIp()`. QA proved `x-forwarded-for` was honoured
    // UNCONDITIONALLY: 8 freshly-spoofed IPs against a configured per-IP limit of 3 all minted
    // (zero protection). Exact-string match against `req.ip` — the raw TCP peer, since this app
    // never sets Fastify's `trustProxy` (main.ts), so `req.ip` is never itself header-influenced.
    // Empty (the DEFAULT — "trust nothing") => `clientIp()` always returns the socket address, so
    // an unconfigured deployment gets the pre-existing, honest trade-off (every caller behind one
    // NAT/proxy shares one bucket) rather than a NEW hole (an attacker's own header moving the
    // key). Set this to the real reverse-proxy's IP(s) ONLY once one actually sits in front of
    // this service — comma-separated, no CIDR (a single reverse-proxy hop has one address; widen
    // this to real CIDR matching only if a multi-IP proxy tier is introduced, a design decision).
    // MUST also be set in docker-compose.vps.yml's platform `environment:` block (compose-env-
    // passthrough trap — a var only in `.env` ships silently disabled).
    magicLinkTrustedProxies: (process.env.MAIL_MAGIC_LINK_TRUSTED_PROXIES ?? "")
      .split(",").map((s) => s.trim()).filter(Boolean),
    streams: {
      notify: mailStreamConfig("NOTIFY", "Gaiada Dev <no-reply@notify.gaiada.invalid>"),
      auth: mailStreamConfig("AUTH", "Gaiada Sign-in <no-reply@auth.gaiada.invalid>"),
    },
  },
};

// WD-23A-1 — `config.google` is the CORE name for the Google OAuth settings, because the state machine
// and token client moved out of `modules/search/` into `core/google-oauth/` and core must not reach into
// a module's config namespace.
//
// It is the SAME OBJECT as `config.search.google`, not a copy: `Object.assign` returns its target, so
// both paths alias one value and a test that mutates either (several do) still affects both. The old
// path is kept rather than rewritten across every search call site — env var NAMES are unchanged too,
// so no deployment has to learn anything new.
export const config: typeof configBase & { google: typeof configBase.search.google } =
  Object.assign(configBase, { google: configBase.search.google });

/** The bridge is fully configured (all four knobs present) and may start. */
export function n8nBridgeEnabled(): boolean {
  const b = config.n8nBridge;
  return !!(b.webhookBaseUrl && b.secret && b.events.length && b.entityTypes.length);
}

/** The graph bridge may start: a reachable knowledge service + at least one entity stream to watch. */
export function graphBridgeEnabled(): boolean {
  return !!(config.services.knowledge.url && config.services.knowledge.token && config.graphBridge.entityTypes.length);
}

/** Knowledge ingestion may run: explicitly enabled AND a reachable knowledge service. Requiring the
 *  explicit flag keeps a fresh environment from crawling and embedding on first boot by accident. */
export function knowledgeIngestEnabled(): boolean {
  return !!(config.knowledgeIngest.enabled && config.services.knowledge.url && config.services.knowledge.token);
}

/** SM-25a — the Google OAuth client is fully configured and an authorization-code round trip is even
 *  attemptable. All THREE knobs are required: a client id without a secret cannot complete the token
 *  exchange for a confidential client, and without a registered redirect URI the authorize request is
 *  refused by the issuer anyway. Anything less is "unconfigured", not "partly working" — callers turn
 *  a false here into GoogleOAuthNotConfiguredError -> 503, never a half-attempt against a phantom
 *  endpoint (the same fail-closed convention as the keyless vendor-driver path). */
export function googleOAuthConfigured(): boolean {
  const g = config.search.google;
  return !!(g.clientId && g.clientSecret && g.redirectUri);
}
