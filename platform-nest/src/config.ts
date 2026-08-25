import "dotenv/config";

// SM-36 — parse an optional comma-separated env override for a per-capability provider preference
// list (config.search.capabilityPreference); an unset or empty-after-trim value keeps `fallback` so
// a single stray comma or blank env var can never silently produce an empty (all-refuse) list.
function preferenceList(envVar: string | undefined, fallback: string[]): string[] {
  if (!envVar) return fallback;
  const parsed = envVar.split(",").map((s) => s.trim()).filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
}

// SMM-38/38a→38b (design addendum §PD) — parse the per-(network, capability) driver-override switch
// (`SOCIAL_PUBLISHER_CAPABILITY_DRIVERS`), a NEW dimension on top of `social_publisher_orgs.driver`
// (the existing per-ORG column): "key=driverKey,key2=driverKey2" where each `key` is ONE of three
// shapes registry.ts's `resolvePublisherForCapability` checks in order (most specific wins):
//   `network:capability`  — exact, e.g. `linkedin:schedule=direct`
//   `network:*`           — every capability on one network, e.g. `linkedin:*=direct`
//   `*:capability`        — one capability across every network, e.g. `*:inbox_read=direct`
// 38b's correction to 38a: the key was capability-only ("schedule=driverKey") until this pass. That
// could not express either 38e's per-NETWORK flip or the P2 inbox's per-capability-within-a-network
// need ("LinkedIn comments via direct, LinkedIn publish via postiz"), so the key gains the network
// dimension before this switch is ever set in a real deployment (it has not been — the tracker's own
// record: `resolvePublisherForCapability` has never been called from a live path). This function's
// own logic is UNCHANGED by that correction — it stores whatever string is on the left of `=` as an
// opaque map key and lets the registry interpret its shape; only the shape callers are expected to
// write changed.
//
// Unset or malformed pairs are dropped from the map rather than throwing at boot — an operator typo
// here degrades to "no override for that key" (the SAME fallthrough an absent env var already
// produces), not a boot crash, because a bad driver NAME is caught loudly downstream at the one place
// that matters: the registry's `resolvePublisherForCapability`, which honors-or-refuses exactly like
// `resolvePublisher` already does for the per-org column. The default (unset) parses to `{}`, which
// is what makes the switch INERT out of the box — every (network, capability) pair falls through to
// the org's own driver, unchanged.
function parseCapabilityDriverOverrides(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const pair of raw.split(",")) {
    const [cap, driver] = pair.split("=").map((s) => s.trim());
    if (cap && driver) out[cap] = driver;
  }
  return out;
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

/**
 * Read a POSITIVE integer from the environment, treating **empty string, NaN, and any value <= 0 as
 * "not configured"** and returning `fallback` instead.
 *
 * Why this exists rather than `Number(process.env.X ?? fallback)`: `??` does not fire on `""`, and
 * `Number("")` is `0`. Compose's `${VAR:-}` passthrough turns an unset variable into an EMPTY one, so
 * the idiomatic-looking expression silently yields 0 — for an interval that means a hot loop, for a
 * threshold it means everything trips the brake. Learned the hard way on 2026-08-18; see
 * `positionDriftSweepIntervalMs` below.
 *
 * Deliberately NOT retrofitted onto every numeric env read in this file: none of the others is
 * currently passed empty by any compose file (audited against the live container the same day), and
 * rewriting them blind would change behaviour on paths this change has no business touching. New
 * numeric settings should use this helper.
 */
function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[config] ${name}="${raw}" is not a positive number — falling back to ${fallback}. ` +
        `A zero or negative interval would busy-loop.`,
    );
    return fallback;
  }
  return n;
}

/**
 * Parse a millisecond interval from the environment, falling back on anything that is not a usable
 * number. Exported so the empty-string case — the one `??` cannot catch and the one compose actually
 * produces — is pinned by a test rather than by a comment.
 */
export function readIntervalMs(raw: string | undefined, fallback: number, floor: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < floor) return fallback;
  return n;
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
  // T3b (§7.2.3 of the 2026-08-06 ASST-23 unblock design DELTA) — how long an unconfirmed
  // `assistant_write_intents` draft's REAL args survive before the confirm/dismiss claim structurally
  // refuses it (`expires_at > now()`) and a later GET thread lazily flips it to 'expired' + scrubs
  // `tool_args` to NULL. Purely a raw-args retention bound: correctness never depends on it — the
  // registry precondition re-checks staleness at EXECUTION time regardless. Default 1h per the design.
  assistantIntentTtlMs: Number(process.env.ASSISTANT_INTENT_TTL_MS ?? 60 * 60 * 1000),
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
  // ── IAM Phase 2 (P2-05) — the POSITION reconciler. Design §3: "Flag-gated
  // `POSITION_SYNC_ENABLED` (default off) until QA's battery passes." DARK by default exactly as
  // serviceAssignmentsEnabled is: when off, every entry point in `position-reconciler.ts` returns
  // an empty result BEFORE reading anything, and the consumer drains its streams materializing
  // nothing — position rows stay dormant provisioning metadata (as P2-01 left them).
  positionSyncEnabled:
    process.env.POSITION_SYNC_ENABLED === "1" || process.env.POSITION_SYNC_ENABLED === "true",
  // Design §3.2 mass-revoke brake: "a single reconcile computing more than N revocations (N
  // configurable, default ~20) aborts and reports instead of applying". The program risk table
  // names "position reconciler mass-revokes on an org edit" as the TOP hazard — a reconciler bug
  // that revokes everyone is far worse than one that revokes nothing, so this fails CLOSED (the
  // run aborts before any write commits) rather than clamping to the first N revocations.
  positionMassRevokeThreshold: Number(process.env.POSITION_MASS_REVOKE_THRESHOLD ?? 20),
  // Design §3.4 nightly drift detector + expiry sweep cadence. Default 24h.
  //
  // 🔴 `??` IS NOT ENOUGH HERE, AND THIS CAUSED A LIVE INCIDENT (2026-08-18). `??` falls back only on
  // `undefined`/`null`, and `Number("")` is **0** — so an EMPTY value yields a 0ms interval and
  // `startPositionMaintenanceLoop`'s self-rescheduling `setTimeout(tick, interval)` becomes a hot
  // loop. Exactly that happened: compose was given
  // `POSITION_DRIFT_SWEEP_INTERVAL_MS: ${POSITION_DRIFT_SWEEP_INTERVAL_MS:-}`, which turns "unset"
  // into "empty string"; the box logged `sweep on: every 0ms` and platform sat at ~46% CPU spinning
  // against Postgres until an explicit value was set.
  //
  // `positiveIntFromEnv` treats empty / NaN / <= 0 as "not configured". The loop ALSO refuses a
  // non-positive value (grant-expiry-sweep.ts) — two layers, because a busy loop presents as healthy
  // uptime rather than as an error.
  positionDriftSweepIntervalMs: positiveIntFromEnv("POSITION_DRIFT_SWEEP_INTERVAL_MS", 24 * 3600 * 1000),
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
  // MON-09i: read-only Plane A summary for the admin Observability console. Both are optional
  // and default to empty: an unset PROMETHEUS_URL makes the console report itself unconfigured
  // rather than pretend the box is healthy, and it never blocks boot -- Plane A telemetry is
  // collected by Prometheus whether or not the platform can read it back.
  // MON-12c: the monitor runner loop. DARK BY DEFAULT and that is a safety property, not caution:
  // this loop DIALS CLIENT WEBSITES, and a deployment must not start probing third-party hosts
  // merely because it booted. `intervalMs` only sets how often due-ness is re-asked; each monitor's
  // own interval_sec decides whether it is actually probed.
  monitoring: {
    runnerEnabled: process.env.MONITORING_RUNNER_ENABLED === "1",
    // NOT `Number(x ?? 60_000)`. `??` only catches null/undefined, and compose's ubiquitous
    // `${VAR:-}` idiom passes an EMPTY STRING when the var is absent from `.env` — `Number("")` is 0,
    // so that spelling yields a 0 ms sweep interval: a busy loop that dials CLIENT WEBSITES as fast
    // as the event loop allows. This estate has already had exactly that bug (46% CPU) from the same
    // `${VAR:-}` + `??` pairing elsewhere; here the blast radius is third-party hosts, not our CPU.
    // Empty, non-numeric, zero and negative all fall back. The 1s floor exists because no sane sweep
    // is sub-second and a typo'd `10` must not become a stampede.
    runnerIntervalMs: readIntervalMs(process.env.MONITORING_RUNNER_INTERVAL_MS, 60_000, 1_000),
  },
  observability: {
    prometheusUrl: process.env.PROMETHEUS_URL ?? "",
    // Display-only: an operator-facing hint about where the full dashboards live. Never fetched
    // (Grafana requires its own auth and is reached over an SSH tunnel, not proxied by us).
    grafanaUrl: process.env.GRAFANA_PUBLIC_HINT ?? "",
    // MSO-05 (docs/plans/2026-08-21-multi-server-observability.md §5): alerts for the estate view
    // come from ALERTMANAGER, never from Prometheus's own `ALERTS` series — that is the only way
    // silence/inhibition state is visible (a silenced alert rendered as firing teaches operators to
    // distrust the board). Deploy value is `http://10.88.0.2:9093` (the SumoPod hub, over the
    // WireGuard tunnel — never a public address). Empty ⇒ the estate endpoint reports
    // `alerts: null` with a reason naming this var, exactly like an unset PROMETHEUS_URL degrades
    // the rest of the console — never a silent fallback to the Prometheus ALERTS series, which is a
    // second source that can disagree with this one.
    alertmanagerUrl: process.env.ALERTMANAGER_URL ?? "",
  },
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
  // PRV-02 — the `provision` seam (docs/blueprints/provision-erp-seam-design.md §03/§04). This is a
  // REAL cross-host hop: platform-nest on gda-aicenter calling `provision` on gda-s01 over public
  // HTTPS. Deliberately its OWN namespace, not a `services.*` row, because `services.*` is the
  // admin/systems console's read-only aggregation and this is a WRITE seam that creates public
  // infrastructure (a GitHub repo + an nginx vhost).
  //
  // ── NO DEFAULT ENDPOINT, EVER ────────────────────────────────────────────────────────────────
  // `baseUrl` defaults to "" and MUST NOT be given a fallback of `https://provision.gaiada.online`
  // (or anything else). A default endpoint turns "this deployment was never configured" into "this
  // deployment silently provisions against production" — the exact class of accident that creates a
  // repo and a public vhost nobody asked for. `provisionConfigured()` below is the fail-closed
  // predicate; unconfigured ⇒ 503, never a half-attempt. `src/modules/webdev/egress-inventory.test.ts`
  // pins the absence of any hardcoded provision host in module source.
  //
  // ── THE PASSWORD IS A CREDENTIAL, NOT A SETTING ──────────────────────────────────────────────
  // `servicePassword` authenticates the ERP to provision as a dedicated, revocable SERVICE account
  // (design D-P9). It is never logged, never serialized into a mirror row, never returned in a
  // response, and never handed to the MCP hub. The GitHub PAT and the fleet deploy SSH key live on
  // gda-s01 and NEVER enter Zone A (D-P4) — nothing here references them, by design.
  provision: {
    baseUrl: process.env.PROVISION_BASE_URL ?? "",
    serviceEmail: process.env.PROVISION_SERVICE_EMAIL ?? "",
    servicePassword: process.env.PROVISION_SERVICE_PASSWORD ?? "",
    // Per-request timeout on ONE HTTP call to provision (login / provision / project read).
    timeoutMs: Number(process.env.PROVISION_TIMEOUT_MS ?? 20_000),
    // Connect/TLS-error retry budget for a single logical call (design §03: 3 attempts,
    // exponential backoff, ≤30s total). Deliberately NOT applied to a completed HTTP response —
    // a 4xx/5xx from provision is an answer, and re-POSTing an answered create is how you get two
    // repos. Only transport failures (where we cannot know whether the request was received) are
    // retried, and even then the far side's DB-unique name + repo-exists check (layer 2) holds.
    retryAttempts: Number(process.env.PROVISION_RETRY_ATTEMPTS ?? 3),
    retryBaseDelayMs: Number(process.env.PROVISION_RETRY_BASE_DELAY_MS ?? 500),
    // Status poll after a successful egress (design §04: ~5s → 30s backoff, ≤5 min, then an honest
    // `failed/poll_timeout` that the hourly reconcile flow can still flip forward).
    pollIntervalMs: Number(process.env.PROVISION_POLL_INTERVAL_MS ?? 5_000),
    pollMaxIntervalMs: Number(process.env.PROVISION_POLL_MAX_INTERVAL_MS ?? 30_000),
    pollMaxMs: Number(process.env.PROVISION_POLL_MAX_MS ?? 5 * 60_000),
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
  // SMM-02/SMM-05 — the social-media module.
  //
  // `defaultUsageBudgetUsd` is the monthly metered cap a NEW engagement starts on. Small on
  // purpose: the stop-loss should be tripped by a runaway loop long before it is tripped by real
  // work, and raising it is a deliberate, audited act (`social.ledger.admin`, held by
  // company_admin — one tier above the department head who wants to spend it).
  //
  // ── `publisher` (SMM-05, absorbing SMM-06's config plumbing) ────────────────────────────────
  // The ERP half of the cross-host contract the integrator named in infra/compose/.env.example so
  // it could not drift across two machines (addendum §A4l §7). Everything else `SOCIAL_*` lives on
  // the VPS that runs the licence zone; filling those into THIS host's .env does nothing at all
  // while scattering the group's platform-app secrets onto a box with no use for them.
  //
  // KEYLESS/URL-LESS IS A SUPPORTED MODE, and it is the default. With no SOCIAL_POSTIZ_BASE_URL no
  // driver is registered at boot, no network call is attempted at boot, and every publisher-touching
  // endpoint refuses `publisher_not_configured` (503) while every READ the module serves keeps
  // working. That is the shape the search module already uses for an unfunded vendor, and it is
  // what makes "Postiz is unreachable" a visibly degraded feature rather than a dead module.
  social: {
    defaultUsageBudgetUsd: Number(process.env.SOCIAL_DEFAULT_USAGE_BUDGET_USD ?? 10),
    publisher: {
      driver: process.env.SOCIAL_PUBLISHER_DRIVER ?? "postiz",
      // The WireGuard peer address, NOT a public hostname and NOT https — there is no public
      // listener on the VPS to name, and the tunnel supplies what https would (§A4l §2). A tunnel
      // outage must fail closed here, loudly; `assertPublisherBaseUrlIsPrivate` in main.ts refuses
      // BOOT if this is ever "fixed" by pointing it at a public address.
      baseUrl: (process.env.SOCIAL_POSTIZ_BASE_URL ?? "").replace(/\/$/, ""),
      apiPrefix: process.env.SOCIAL_POSTIZ_API_PREFIX ?? "/api/public/v1",
      // Split timeouts, not one value (§A4l §4). This estate has already shipped a default 30s
      // timeout against a real 31-40s round trip (the n8n dispatcher, reported unreachable after
      // the run had already been created). Media upload is the ONE call on this hop whose duration
      // changed by more than milliseconds when the engine moved hosts, so it gets its own class.
      // ⚠ connectTimeoutMs is carried and reported but NOT independently enforced: global `fetch`
      // exposes no connect-phase deadline without an undici Agent, and this project does not depend
      // on undici directly. Named rather than silently conflated — see the driver's header.
      connectTimeoutMs: Number(process.env.SOCIAL_POSTIZ_CONNECT_TIMEOUT_MS ?? 5000),
      readTimeoutMs: Number(process.env.SOCIAL_POSTIZ_READ_TIMEOUT_MS ?? 30000),
      uploadTimeoutMs: Number(process.env.SOCIAL_POSTIZ_UPLOAD_TIMEOUT_MS ?? 120000),
      // Custody split (b), design §11 / D-5: the org-scoped API key is resolved SERVER-SIDE BY
      // ALIAS at call time from `social_publisher_orgs.api_key_ref`, never stored in a column,
      // never sent to platform-ui, never put in an n8n credential, never written to a log or an
      // audit line. `defaultOrgApiKey` backs the `default` alias; any other alias resolves from
      // `SOCIAL_POSTIZ_ORG_API_KEY__<ALIAS>` (see publisher/keys.ts).
      defaultOrgApiKey: process.env.SOCIAL_POSTIZ_ORG_API_KEY ?? "",
      // Per-network DEPLOYMENT flags — a second, higher gate than the per-engagement tool_scope.
      // The default set is the addendum's own roadmap conclusion (§A4h): Instagram/Facebook and
      // LinkedIn first, own accounts. `x` is metered (OQ-2 / D-14), `youtube` is audit-locked to
      // private uploads for ~3 months (§A4g), and `tiktok` is audit-locked AND carries the open
      // OQ-8 consent-timing question (§A4i) — a toggle that cannot do what its name says is worse
      // than an absent one, so all three ship off at the deployment level too.
      enabledNetworks: (process.env.SOCIAL_NETWORKS_ENABLED ?? "instagram,facebook,linkedin")
        .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
      // The LIVE Instagram quota probe (`GET /<IG_ID>/content_publishing_limit`, addendum §A4f).
      // EMPTY BY DEFAULT, and the emptiness is a finding, not laziness: Postiz's only generic
      // passthrough is `POST /public/v1/integration-trigger/:id`, which is gated on an upstream
      // `@Tool` decorator, and the SMM-04 spike proved the TikTok provider carries none. Whether
      // the Instagram provider exposes one is UNVERIFIED — it needs a live engine and a connected
      // IG account, which OQ-1 gates. Unset ⇒ the driver does not advertise `quota_probe`, the
      // registry records `quota: {}` with `quotaSource: 'probe_unavailable'`, and media-rules'
      // checkQuota degrades to its existing `quota_unknown` warning. What must NEVER happen is a
      // constant: 25 is obsolete, Meta's own doc says 100 and 50 on the same page, and a synthesized
      // cap is wrong in a way nothing downstream can detect.
      quotaProbeTool: process.env.SOCIAL_POSTIZ_QUOTA_PROBE_TOOL ?? "",
      // SMM-10/D-22, D-21's fork exception. Same shape and same reasoning as quotaProbeTool
      // immediately above: EMPTY BY DEFAULT until the ~15-line fork exception is verified against a
      // live engine. Unset ⇒ the driver does not advertise `creator_info_probe`, the dispatch flow's
      // live fetch returns `undefined`, and a TikTok publish refuses `creator_info_unverified` — the
      // fail-closed steady state addendum §A4i/D-22 both describe.
      creatorInfoProbeTool: process.env.SOCIAL_POSTIZ_CREATOR_INFO_PROBE_TOOL ?? "",
      // SMM-07 — the guided connect flow's own two knobs. Both are EMPTY BY DEFAULT and the
      // emptiness is a finding, not laziness — see provisioning.ts's `initiateAccountConnect`.
      //
      // `connectRedirectUrl` is the platform-ui page the engine hands the browser back to once ITS
      // OWN OAuth round trip with the network finishes (the third argument of
      // `SocialPublisher.connectUrl`) — mirroring `GOOGLE_OAUTH_REDIRECT_URI`'s shape (SM-25): one
      // fixed, deployment-level destination, config-driven rather than derived per request. It is
      // NOT Postiz's own `FRONTEND_URL` (that is the licence-zone host's env, governs the
      // network-facing leg of the OAuth dance, and is out of this platform's control by design —
      // addendum §A4j's containment-invariant-5 finding). Unset ⇒ connect refuses
      // `connect_redirect_not_configured` rather than handing the engine an empty destination.
      connectRedirectUrl: (process.env.SOCIAL_CONNECT_REDIRECT_URL ?? "").replace(/\/$/, ""),
      // OQ-3 (owner decision, addendum §A4i / the design addendum's OQ-3 row): "own accounts
      // proceed; client connects wait for AGPL counsel sign-off." This is a LEGAL gate, not a
      // technical capability, and it is temporary by nature — it goes away entirely the day counsel
      // signs off, at which point this whole check (and this config key) should be deleted rather
      // than flipped. A schema column would outlive that day as dead weight; a deployment-level list
      // does not. `clients.id` values, comma-separated — deliberately GLOBAL (not per-tenant) same
      // as every other deployment dial in this block, because there is exactly one legal answer to
      // "have we cleared client connects" and it does not vary by tenant.
      ownBrandClientIds: (process.env.SOCIAL_OWN_BRAND_CLIENT_IDS ?? "")
        .split(",").map((s) => s.trim()).filter(Boolean),
      // SMM-38/38a→38b (§PD) — the per-(network, capability) driver switch. EMPTY BY DEFAULT, and
      // the emptiness is what keeps 38b inert: `registry.ts`'s `resolvePublisherForCapability` falls
      // through to the org's own named driver (0105's `social_publisher_orgs.driver`, still 'postiz'
      // for every row today) for any (network, capability) pair with no entry here. Setting
      // `linkedin:schedule=direct` here is the ONLY thing 38e's flip does — see that ticket's own
      // exit criterion ("flip ... in config"). Keys are `network:capability` / `network:*` /
      // `*:capability` (most specific wins — see registry.ts); a bare `capability=driver` key from
      // 38a's original (capability-only) shape is simply an unmatched string here, which resolves to
      // "no override" rather than a crash — the same forgiving-typo posture `parseCapabilityDriverOverrides`
      // already documents.
      capabilityDrivers: parseCapabilityDriverOverrides(process.env.SOCIAL_PUBLISHER_CAPABILITY_DRIVERS),
    },
    // ── `direct` (SMM-38 phase 38c, design addendum §PD) — the `direct` driver's OWN per-network app
    // credentials. Deliberately a SEPARATE block from `publisher` above, not folded into it:
    // `publisher.*` is the POSTIZ ENGINE's own wiring (base URL, org-scoped API key, per-network
    // deployment toggles) and stays that even as `direct` grows more networks (38d adds YouTube);
    // `direct.*` is THIS platform's own OAuth app registration, one sub-object per network, read
    // from env — never a tenant row (client credentials are the deployment's, never a client's, same
    // "client credentials come from config/env" rule GOOGLE_OAUTH_CLIENT_ID/`config.search.google`
    // already follows). `direct` NEVER crosses the WireGuard tunnel — it is a second, independent
    // OAuth client speaking to the network directly, which is the whole point of D-20.
    //
    // KEYLESS IS A SUPPORTED MODE, same doctrine as `publisher.baseUrl` above: with no
    // SOCIAL_LINKEDIN_CLIENT_ID/_SECRET the LinkedIn OAuth start refuses `platform_app_not_registered`
    // (SMM-07's existing, reused token — see `publisher/linkedin-oauth.ts`), never a half-built
    // authorize URL with an empty client_id baked in.
    direct: {
      linkedin: {
        clientId: process.env.SOCIAL_LINKEDIN_CLIENT_ID ?? "",
        clientSecret: process.env.SOCIAL_LINKEDIN_CLIENT_SECRET ?? "",
        // OUR callback route (a fixed, tenant-agnostic path — see linkedin-oauth.controller.ts's
        // header for why: LinkedIn, like Google, permits no wildcard redirect_uri). Mirrors
        // GOOGLE_OAUTH_REDIRECT_URI's shape (SM-25) exactly. Unset ⇒ the connect start refuses
        // `connect_redirect_not_configured` (SMM-07's existing token, reused) rather than handing
        // LinkedIn an empty destination.
        redirectUri: process.env.SOCIAL_LINKEDIN_REDIRECT_URI ?? "",
        // LinkedIn's own hosts — never Postiz's. ⚠UNVERIFIED against a live app (no credential exists
        // yet, D-23): these are the documented endpoints from the app-review dossier §4, not driven.
        authorizeUrl: process.env.SOCIAL_LINKEDIN_AUTHORIZE_URL ?? "https://www.linkedin.com/oauth/v2/authorization",
        tokenUrl: process.env.SOCIAL_LINKEDIN_TOKEN_URL ?? "https://www.linkedin.com/oauth/v2/accessToken",
        apiBaseUrl: process.env.SOCIAL_LINKEDIN_API_BASE_URL ?? "https://api.linkedin.com",
        // LinkedIn's REST API requires a versioned header on every call (`LinkedIn-Version:
        // YYYYMM`) — ⚠UNVERIFIED which version this deployment's eventual app is approved against;
        // a fixed recent value so the wire shape is at least well-formed when first driven.
        apiVersion: process.env.SOCIAL_LINKEDIN_API_VERSION ?? "202601",
        // Own timeout class (§A4l §4's own reasoning, ported to a SECOND host): LinkedIn's asset
        // upload is a 3-step register→PUT→finalize dance on api.linkedin.com, not Postiz's single
        // multipart POST, so it earns its own budget rather than inheriting
        // SOCIAL_POSTIZ_UPLOAD_TIMEOUT_MS — a DIFFERENT host's number for a DIFFERENT wire shape.
        readTimeoutMs: Number(process.env.SOCIAL_LINKEDIN_READ_TIMEOUT_MS ?? 30000),
        uploadTimeoutMs: Number(process.env.SOCIAL_LINKEDIN_UPLOAD_TIMEOUT_MS ?? 120000),
        // The Gaiada LinkedIn Company Page this deployment publishes AS (dossier §4.6 checklist item
        // 1), e.g. "urn:li:organization:12345". ONE per deployment, own-brand-first (D-20/OQ-3
        // unchanged) — a CLIENT's own org URN is a per-account fact (a future `social_accounts`
        // column, not built by this phase since no client LinkedIn connect exists yet), never a
        // config constant.
        organizationUrn: process.env.SOCIAL_LINKEDIN_ORGANIZATION_URN ?? "",
      },
      // SMM-38 phase 38d — YouTube's OWN app credentials, a SEPARATE Google Cloud project/OAuth
      // client from search's `config.google` (dossier §8's own app-mapping table: "Gaiada YouTube" is
      // its own row, distinct from search's older Google app and from LinkedIn's app above). Reusing
      // `config.google`/`core/google-oauth` here would either silently borrow search's client
      // credentials for a YouTube consent screen (wrong app, wrong scope-sensitivity review, wrong
      // verification track) or require widening a core file outside this ticket's surface — named
      // in `publisher/youtube-client.ts`'s own header, same reasoning `linkedin-client.ts` gave for
      // not reusing `core/google-oauth/state.ts`.
      //
      // KEYLESS IS A SUPPORTED MODE, same doctrine as `direct.linkedin` above: with no
      // SOCIAL_YOUTUBE_CLIENT_ID/_SECRET the YouTube OAuth start refuses `platform_app_not_registered`
      // (the same reused SMM-07 token), never a half-built authorize URL with an empty client_id.
      youtube: {
        clientId: process.env.SOCIAL_YOUTUBE_CLIENT_ID ?? "",
        clientSecret: process.env.SOCIAL_YOUTUBE_CLIENT_SECRET ?? "",
        // OUR callback route — fixed, tenant-agnostic, mirroring `direct.linkedin.redirectUri` and
        // GOOGLE_OAUTH_REDIRECT_URI's shape (Google, like LinkedIn, permits no wildcard redirect_uri).
        redirectUri: process.env.SOCIAL_YOUTUBE_REDIRECT_URI ?? "",
        // Google's own documented endpoints (dossier §6) — ⚠UNVERIFIED against a live app (D-23), not
        // driven. `authorizeUrl` is the standard Google OAuth 2.0 endpoint, not a YouTube-specific one.
        authorizeUrl: process.env.SOCIAL_YOUTUBE_AUTHORIZE_URL ?? "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: process.env.SOCIAL_YOUTUBE_TOKEN_URL ?? "https://oauth2.googleapis.com/token",
        // Data API v3 base for ordinary calls (comments, etc).
        apiBaseUrl: process.env.SOCIAL_YOUTUBE_API_BASE_URL ?? "https://www.googleapis.com/youtube/v3",
        // The resumable-upload endpoint is a DIFFERENT path on the SAME host, per Google's own
        // resumable-upload protocol doc — never folded into `apiBaseUrl` above, since the two are
        // genuinely different routes with different bodies (JSON metadata init vs. raw byte PUT).
        uploadUrl: process.env.SOCIAL_YOUTUBE_UPLOAD_URL ?? "https://www.googleapis.com/upload/youtube/v3/videos",
        // Own timeout class, same reasoning as `direct.linkedin` above: a resumable upload's
        // initiate+PUT dance is a different host/shape from Postiz's single multipart POST.
        readTimeoutMs: Number(process.env.SOCIAL_YOUTUBE_READ_TIMEOUT_MS ?? 30000),
        uploadTimeoutMs: Number(process.env.SOCIAL_YOUTUBE_UPLOAD_TIMEOUT_MS ?? 120000),
      },
    },
    // SMM-10 — the dispatch/reconcile pair's own knobs.
    //
    // `reconcileIntervalMs` is the SAFETY POLL's cadence: `smm-post-status-sync`'s batched
    // `getPostStatus` sweep over every in-flight (`queued`/`publishing`) variant. Addendum §A4 already
    // reasoned that publish LATENCY is not where this programme's cost lives (the queue's own
    // availability IS publishing reliability for Instagram/LinkedIn — no server-side scheduling on
    // either), so 15 minutes is deliberately not tuned tighter: a webhook (when the network/engine
    // offers one) closes the common case immediately, and this poll is the backstop for the case
    // where it does not fire, is dropped, or fires twice (idempotent either way — see
    // `post-status-sync-job.ts`'s own header).
    reconcileIntervalMs: Number(process.env.SOCIAL_RECONCILE_INTERVAL_MS ?? 15 * 60 * 1000),
    // Dark by default, same convention as every other background sweep in this file
    // (`pmBurndownSnapshotEnabled`, `itDiscovery.reaperEnabled`, `inboxRetention.purgeEnabled`): a
    // fresh deployment with no publisher org provisioned has nothing in flight to reconcile, so
    // starting the loop unconditionally would just be an idle sweep — but turning it on is a
    // deploy-time decision paired with provisioning the first publisher org, not a boot-time default.
    reconcileEnabled:
      process.env.SOCIAL_RECONCILE_ENABLED === "1" || process.env.SOCIAL_RECONCILE_ENABLED === "true",
    // The webhook intake's shared secret (HMAC-verified, mirroring the search module's
    // `callbackSecret`/`semCallbackSecret` convention below and MAIL-13's inbound-mail HMAC). Empty
    // ⇒ the webhook route fail-closed refuses every request rather than trusting an unauthenticated
    // caller to name a `providerPostId` — a webhook payload is the ONE input in this ticket that
    // rides an untrusted network hop, and "ids only, never trusted content" does not relax the need
    // to know WHO is allowed to even name an id.
    webhookSecret: process.env.SOCIAL_WEBHOOK_SECRET ?? "",
    // SMM-36 — the LinkedIn-driven inbox retention purge (`inbox-retention-job.ts`). DARK by
    // default, same pattern as `pmBurndownSnapshotEnabled`/`serviceAssignmentsEnabled`: unlike
    // those two this job is NOT a pure optimization with a lazy backstop — until it runs, LinkedIn
    // comment text and commenter profile fields accumulate past the 24h/48h ceiling their own
    // Data Storage Requirements impose (addendum §A4e). It still defaults OFF because
    // `SOCIAL_NETWORKS_ENABLED` also defaults every network but instagram/facebook/linkedin off at
    // the deployment level, and no LinkedIn client is connected yet (OQ-1/OQ-3 both still gate
    // that) — turning this job on is a deploy-time decision paired with turning LinkedIn on for
    // real, not a boot-time default.
    inboxRetention: {
      purgeEnabled:
        process.env.SOCIAL_INBOX_RETENTION_PURGE_ENABLED === "1"
        || process.env.SOCIAL_INBOX_RETENTION_PURGE_ENABLED === "true",
      // Default 1h: LinkedIn's SHORTER window is 24h, so an hourly sweep gives at most ~4% window
      // slack even at the moment a purge run was due — tight enough that "we purge daily" could
      // never be mistaken for compliant. No effect unless purgeEnabled.
      purgeIntervalMs: Number(process.env.SOCIAL_INBOX_RETENTION_PURGE_INTERVAL_MS ?? 3600 * 1000),
    },
    // SMM-15 — `pullInbox` / `smm-inbox-pull`: the per-post engagement-inbox comment sync
    // (`inbox-sync-job.ts`). Dark by default, same convention as `inboxRetention`/`reconcileEnabled`
    // above — a fresh deployment with no LinkedIn/YouTube account connected has nothing to pull, and
    // turning this on is a deploy-time decision paired with clearing D-23's credential gate for the
    // first network, not a boot-time default.
    inboxPull: {
      pullEnabled:
        process.env.SOCIAL_INBOX_PULL_ENABLED === "1" || process.env.SOCIAL_INBOX_PULL_ENABLED === "true",
      pullIntervalMs: Number(process.env.SOCIAL_INBOX_PULL_INTERVAL_MS ?? 15 * 60 * 1000),
      // How far back a PUBLISHED post is still eligible for a comment pull — an OPERATIONAL job
      // parameter (mirrors `metrics-job.ts`'s own `POST_METRICS_LOOKBACK_DAYS` reasoning), never a
      // business or quota number: an old post can still gather new comments, but pulling every post
      // ever published, forever, on every sweep would be unbounded API spend for a vanishing return.
      lookbackDays: Number(process.env.SOCIAL_INBOX_PULL_LOOKBACK_DAYS ?? 30),
      // ⚠ A SELF-IMPOSED SAFETY VALVE, NOT A CLAIMED LINKEDIN/YOUTUBE RATE LIMIT. Neither network's
      // Standard-tier per-app/per-user rate limit is published anywhere reachable without a live
      // Developer Portal session (D-23) — this ticket's own instruction is to model that as UNKNOWN,
      // never to invent a number and call it a limit. This cap instead bounds how many `listComments`
      // calls ONE sweep will make for a SINGLE account, so an account with an unbounded backlog of
      // eligible posts cannot turn one tenant's sweep into an unbounded burst of outbound calls with
      // no ceiling at all — the newest posts win (query orders by `published_at DESC`), and whatever
      // does not fit this run is picked up on the next one.
      maxPostsPerAccountPerRun: Number(process.env.SOCIAL_INBOX_PULL_MAX_POSTS_PER_ACCOUNT ?? 20),
    },
    // SMM-24 — the daily metrics pull (`smm-metrics-pull`). Dark by default, same convention as
    // `inboxPull`/`inboxRetention`/`triage` below. These two were read straight from `process.env` in
    // `metrics-job.ts` for the length of SMM-24 because this file was held by SMM-38a's parallel
    // worktree at the time; that file's own comment called the later fold-in "a mechanical rename,
    // not a redesign", which is what this is. It also restores the module's single convention: every
    // other social job is gated by `config.social.*` and `main.ts` reads the flag from here.
    metricsPull: {
      enabled:
        process.env.SOCIAL_METRICS_PULL_ENABLED === "1" || process.env.SOCIAL_METRICS_PULL_ENABLED === "true",
      intervalMs: Number(process.env.SOCIAL_METRICS_PULL_INTERVAL_MS ?? 24 * 3600 * 1000),
    },
    // SMM-16 — AI triage (`smm-inbox-triage`) + the SLA/spike guard (`smm-inbox-sla-guard`, named in
    // 0105's own `ix_social_inbox_threads_sla` comment). Both dark by default, same convention as
    // `inboxPull`/`inboxRetention` above.
    triage: {
      classifyEnabled:
        process.env.SOCIAL_INBOX_TRIAGE_ENABLED === "1" || process.env.SOCIAL_INBOX_TRIAGE_ENABLED === "true",
      classifyIntervalMs: Number(process.env.SOCIAL_INBOX_TRIAGE_INTERVAL_MS ?? 15 * 60 * 1000),
      // A SELF-IMPOSED safety valve on THIS sweep's own gateway-call volume per tenant, the SAME
      // reasoning as `inboxPull.maxPostsPerAccountPerRun` — never a claimed ai-gateway-go rate limit.
      maxThreadsPerTenantPerRun: Number(process.env.SOCIAL_INBOX_TRIAGE_MAX_THREADS ?? 25),
      // A thread left `unavailable` (gateway unreachable/unconfigured at the time it was tried) is
      // retried on a LATER sweep rather than abandoned forever — but not on every tick, or a
      // persistently-down gateway would spend the whole per-run cap retrying the same failed threads
      // and never reach a freshly-arrived one. An operational cooldown, not a business number.
      retryUnavailableAfterMs: Number(process.env.SOCIAL_INBOX_TRIAGE_RETRY_MS ?? 30 * 60 * 1000),
      slaGuard: {
        guardEnabled:
          process.env.SOCIAL_INBOX_SLA_GUARD_ENABLED === "1" || process.env.SOCIAL_INBOX_SLA_GUARD_ENABLED === "true",
        // 0105's own `ix_social_inbox_threads_sla` comment: "the SLA guard (smm-inbox-sla-guard,
        // every 15 min)". Kept at the figure the schema itself already named, not a new invention.
        guardIntervalMs: Number(process.env.SOCIAL_INBOX_SLA_GUARD_INTERVAL_MS ?? 15 * 60 * 1000),
        // ── SPIKE DETECTION — the ticket's own instruction, quoted here so nobody "tightens" this
        // into a claimed vendor/business number later: "do not invent thresholds... whatever you
        // choose is config with a documented rationale, never a constant that reads as measured."
        // No account is connected and app reviews are deferred to staging (D-23) — there is NO real
        // traffic to derive a measured baseline from. Every value below is a deliberately generous,
        // self-imposed default meant to stay silent through ordinary variance on a real account, not
        // a business commitment about what "too many comments" means. Revisit once real inbox
        // volume exists to measure.
        spikeWindowMinutes: Number(process.env.SOCIAL_INBOX_SPIKE_WINDOW_MINUTES ?? 60),
        // Trailing baseline = this many PRIOR windows of the same size (24 x 60min = a 24h baseline
        // at the default window).
        spikeBaselineWindows: Number(process.env.SOCIAL_INBOX_SPIKE_BASELINE_WINDOWS ?? 24),
        // The recent window's count must reach at least this many TIMES the trailing average.
        spikeMultiplier: Number(process.env.SOCIAL_INBOX_SPIKE_MULTIPLIER ?? 3),
        // A brand-new or low-volume account has a near-zero baseline; multiplying near-zero by ANY
        // multiplier is still near-zero, which would make even a single ordinary comment read as a
        // "spike". This absolute floor exists ONLY to prevent that div-by-noise failure mode — it is
        // not a claim that 5 comments/hour is meaningful for any real account.
        spikeMinRecentCount: Number(process.env.SOCIAL_INBOX_SPIKE_MIN_RECENT ?? 5),
        // Re-notify cooldown for a SUSTAINED spike. `0` means DERIVE it as
        // `spikeWindowMinutes * (spikeBaselineWindows + 1)` — the point at which the spiking traffic
        // has fully aged out of its own baseline comparison, so a still-firing detector is reporting
        // genuinely new elevation rather than the same burst it already reported. Derived rather
        // than a fresh constant precisely so it cannot read as a measured or claimed number; an
        // explicit override is available when an operator wants a different cadence.
        spikeRenotifyMinutes: Number(process.env.SOCIAL_INBOX_SPIKE_RENOTIFY_MINUTES ?? 0),
      },
    },
    // SMM-26 — the `smm-agent-content-brief` flow (content-brief.ts). SMM-26 shipped ONE knob (the
    // ON-DEMAND, principal-driven MCP tool/endpoint) and deliberately NOT the v1.0 design's "weekly
    // per opted-in engagement" scheduled sweep, naming the reason as a follow-up requiring an
    // architect decision on an automation service identity (docs/plans/smm-tracker.md's own SMM-26
    // follow-up row). That decision is now made (owner-authorised): a dedicated, PER-TENANT
    // automation principal (`seed/social-content-brief-automation.ts`) — see `content-brief-job.ts`'s
    // header for why per-tenant, not one global principal, is the only safe shape.
    //
    // `maxVariantsPerCall` bounds how many (idea, account) pairings ONE call will draft — an N-ideas
    // x M-enabled-networks request has no natural ceiling otherwise. A SELF-IMPOSED budget on THIS
    // request's own gateway-call/latency cost, never a claimed vendor rate limit — same idiom as
    // `inboxPull.maxPostsPerAccountPerRun`/`triage.maxThreadsPerTenantPerRun` above.
    contentBrief: {
      maxVariantsPerCall: Number(process.env.SOCIAL_CONTENT_BRIEF_MAX_VARIANTS_PER_CALL ?? 20),
      // The scheduled sweep (`smm-content-brief-sweep`, content-brief-job.ts). DARK BY DEFAULT, same
      // convention as every other background sweep in this file — and a HARD gate, not a perf
      // opt-in, because unlike a purge/read job this one SPENDS ai-gateway-go calls per opted-in
      // engagement it finds. Absent ANY opted-in engagement (the toggle lives on
      // `social_engagements.tool_scope.ai.autoWeeklyBrief`, additive jsonb, no migration) or ANY
      // provisioned per-tenant principal, a tick still runs but drafts nothing and spends nothing —
      // "opted in", "opted in but nothing to brief", and "the sweep never ran" stay three distinct,
      // observable facts (this file's own standing "absent ≠ zero" discipline), never collapsed.
      weeklySweep: {
        enabled:
          process.env.SOCIAL_CONTENT_BRIEF_SWEEP_ENABLED === "1"
          || process.env.SOCIAL_CONTENT_BRIEF_SWEEP_ENABLED === "true",
        // Weekly by default, matching the design's own "weekly per opted-in engagement" framing —
        // an OPERATIONAL cadence, not a business number; an operator who wants a different cadence
        // overrides it.
        intervalMs: Number(process.env.SOCIAL_CONTENT_BRIEF_SWEEP_INTERVAL_MS ?? 7 * 24 * 3600 * 1000),
      },
    },
    // SMM-27 — best-time-to-post: a nightly CLASSICAL STATS sweep (best-time-job.ts), never a
    // gateway call — no model, no prompt, deliberate per the ticket's own binding instruction.
    // ── NO DATA EXISTS, AND WON'T SOON (D-23) — every threshold below is a SELF-IMPOSED config
    // default with its own documented rationale, never a constant that reads as measured, per the
    // ticket's own instruction ("state a minimum-observations threshold as CONFIG... never a
    // constant that reads as measured"). The chip and the cache row both distinguish
    // insufficient_evidence (below threshold) from unsupported (the driver cannot ever report
    // per-post engagement) from suggested (a real answer) — three distinct facts, never one
    // boolean or a bare zero (`capabilities.ts`'s own discipline, applied to a statistic).
    bestTime: {
      enabled: process.env.SOCIAL_BEST_TIME_ENABLED === "1" || process.env.SOCIAL_BEST_TIME_ENABLED === "true",
      // Once a day is enough — the input data (SMM-21's nightly metrics pull) itself only refreshes
      // once a day, so recomputing more often would re-derive the identical answer.
      intervalMs: Number(process.env.SOCIAL_BEST_TIME_INTERVAL_MS ?? 24 * 3600 * 1000),
      // How far back to sample published posts. Longer than `metrics-job.ts`'s own 30-day
      // REFRESH window on purpose: that window is about keeping an already-measured post's numbers
      // current, this one is about accumulating enough SAMPLE SIZE to say anything at all while
      // volume is sparse. 180 days is a deliberately generous starting point to reach the sample
      // thresholds below sooner once a real account connects; revisit once real posting cadence is
      // observed.
      lookbackDays: Number(process.env.SOCIAL_BEST_TIME_LOOKBACK_DAYS ?? 180),
      // THE THRESHOLD THE TICKET BRIEF ASKS FOR BY NAME. Below this many measured, published posts
      // for an account, NO suggestion is computed — status stays 'insufficient_evidence' rather than
      // ranking noise. Chosen as a classical-stats rule-of-thumb floor (you need at least a small
      // handful of independent observations before a mean says more than the underlying variance
      // does), NOT a claimed significance level and NOT vendor guidance — there is no vendor
      // guidance for "how many of your own posts before a best-hour claim is trustworthy". Easy to
      // raise once real volume exists to tune it against.
      minMeasuredPosts: Number(process.env.SOCIAL_BEST_TIME_MIN_MEASURED_POSTS ?? 5),
      // A SECOND, independent floor on the WINNING hour bucket itself: even once the account clears
      // `minMeasuredPosts` overall, a single lucky post sitting alone in one hour must not "win" that
      // hour outright just because every other hour has zero posts. The winning bucket must carry at
      // least this many of its own measured posts before its average is trusted as the answer.
      minBucketPosts: Number(process.env.SOCIAL_BEST_TIME_MIN_BUCKET_POSTS ?? 2),
    },
    // SMM-22 — X metering (design D-9, addendum). The stop-loss chain's tenant + global tiers, X's
    // own per-post price, and the barred-twin unbar gate. Mirrors search's own moneyEnv/numericEnv
    // convention byte-for-byte (design's own words: "byte-for-byte the SEO pattern").
    usage: {
      // X's per-post price is a CONFIG FACT with a documented external source, never a literal that
      // reads as measured (defect class #4). BOTH must be set for X pricing to be considered
      // configured — media-rules.ts's estimateCostUsd refuses `x_price_not_configured` rather than
      // treating either-absent as $0, because a zero price is an unmetered spend. Unverified against
      // a live X Developer Portal account (D-23) — design §05's own ~$0.015/~$0.20 figures are
      // EXPLICITLY named "re-verify at build time", so no default ships here; an operator who has
      // actually checked the live rate sets these two vars.
      xPerPostCostUsd: moneyEnv("SOCIAL_X_PER_POST_COST_USD"),
      xPerPostWithLinkCostUsd: moneyEnv("SOCIAL_X_PER_POST_WITH_LINK_COST_USD"),
      // D-9's tenant tier. Optional; unset => tier SKIPPED (engagement + global tiers still
      // enforced) — exactly `tenantMonthlyCapUsd`'s existing null-skips-tier convention in
      // `config.search`, reused rather than reinvented.
      tenantMonthlyCapUsd: moneyEnv("SOCIAL_TENANT_MONTHLY_CAP_USD"),
      // D-9's global tier. Design §05 (smm-design.md, the ledger section): "global platform cap
      // (env, default $100/mo until X usage is proven)" — a DOCUMENTED design default, never an
      // invented number. On a default deployment this is the ONLY platform-wide ceiling, exactly
      // the same "silently inert default" hazard SM-52 closed for search's own global cap — hence
      // `numericEnv` (throws on an unparseable override) rather than a bare `Number(...)`.
      globalMonthlyCapUsd: numericEnv("SOCIAL_GLOBAL_MONTHLY_CAP_USD", { default: 100 }),
      // The fraction of a cap at which a threshold event fires (mirrors search's budgetWarnRatio).
      budgetWarnRatio: numericEnv("SOCIAL_USAGE_BUDGET_WARN_RATIO", { default: 0.8, max: 1 }),
      // ── THE BARRED-TWIN UNBAR GATE (D-14, this ticket) ──────────────────────────────────────────
      // Default FALSE: `social.publishPostMetered` stays permanently barred from the D14 executor
      // (core/approval-executables.ts's SMM-09 section) and the default posture is BYTE-IDENTICAL to
      // before this ticket. Flipping this to true is a deliberate, explicit deployment decision —
      // never a side effect of enabling the `x` network alone — and `approval-executables.ts`'s own
      // SMM-22 section REFUSES AT BOOT if this is true while X's per-post price is unconfigured: an
      // auto-executing money-spending tool with no price is precisely the "under-count" failure
      // direction this ticket exists to prevent, and a boot failure is the loud, cheap-to-fix answer
      // (matching this file's own `wireSearchProviderModeAndAdsWriteMode`-class boot refusals).
      meteredPublishEnabled:
        process.env.SOCIAL_METERED_PUBLISH_ENABLED === "1" || process.env.SOCIAL_METERED_PUBLISH_ENABLED === "true",
    },
  },
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
  // LMS L5 — the lab runner (`lab-runner/`), the sidecar that executes a learner's submission in a
  // capped, unprivileged, network-less container and returns a graded result. Same fail-soft shape
  // as reportRenderer above: url or token unset -> a lab attempt is REFUSED with a clear message
  // rather than accepted and left pending forever. "Submitted, awaiting the runner" when no runner
  // exists is how somebody ends up waiting on a service nobody is building, on a path they can
  // never complete. `token` is the SAME value as the sidecar's own LAB_RUNNER_TOKEN.
  //
  // `pollTimeoutMs` must exceed the runner's own wall clock PLUS its queue wait, or the platform
  // gives up on runs that were about to succeed and reports an error nobody can reproduce.
  labRunner: {
    url: process.env.LAB_RUNNER_URL ?? "",
    token: process.env.LAB_RUNNER_TOKEN ?? "",
    timeoutMs: Number(process.env.LAB_RUNNER_TIMEOUT_MS ?? 15000),
    pollIntervalMs: Number(process.env.LAB_RUNNER_POLL_INTERVAL_MS ?? 1500),
    pollTimeoutMs: Number(process.env.LAB_RUNNER_POLL_TIMEOUT_MS ?? 300000),
    // An LMS lab endpoint is an obvious way to get free compute on a shared host, so the limit is
    // per LEARNER and counts errored runs too — a limit that only counted successes is one an
    // attacker drives by failing.
    maxRunsPerHour: Number(process.env.LAB_RUNNER_MAX_RUNS_PER_HOUR ?? 30),
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
    // MAIL-37 — trusted-proxy allowlist for `inbound.controller.ts`'s per-source rate-limit key.
    // Same gate as `magicLinkTrustedProxies` below (shared implementation: `src/mail/client-ip.ts`),
    // but a SEPARATE list, deliberately: the two endpoints sit behind completely different network
    // hops (this one behind the public-facing nginx vhost once NET-01 is applied; magic-link behind
    // a direct platform-ui-to-platform-nest internal call), so the address that legitimately belongs
    // in one allowlist has no business being trusted for the other. Exact-string match against
    // `req.ip` — the raw TCP peer, since this app never sets Fastify's `trustProxy` (main.ts).
    // Empty (the DEFAULT — "trust nothing") => every caller's header is ignored and the limiter keys
    // on the socket address, same honest trade-off as everywhere else in this file.
    //
    // PRODUCTION VALUE — reasoned, not measured (no shell on the box for this ticket): nginx is a
    // HOST-native process (not a sibling container) that reaches this app via a loopback-published
    // Docker port (`127.0.0.1:<port>:<port>`, see the NET-01 runbook), not via the compose network
    // platform-ui/platform-nest share. A host-loopback connection into a bridge-networked container's
    // published port is hairpin-NATed by Docker; the peer address this app actually observes is the
    // docker0 bridge gateway, NOT literally `127.0.0.1` — this repo already documents that gateway as
    // `172.17.0.1` for the box this runs on (see `docker-compose.hostdata.yml`'s and
    // `hermes-gateway.service`'s comments — both independently confirm containers reach the host, and
    // are reached BY the host's hairpin-NATed loopback traffic, at that one address). Set to
    // `172.17.0.1` for that reason. If the observed peer ever turns out to be `127.0.0.1` instead
    // (e.g. a future non-Docker run of this app behind a local nginx, or a Docker networking mode
    // that preserves the loopback source) — add it too; a comma-separated superset costs nothing
    // (these are both non-routable, host-only addresses, never anything an internet attacker can BE)
    // and the default posture is fail-closed either way, so an over-broad guess only risks staying at
    // "trust nothing" a little longer, never a new hole. Confirm once deployed by checking whether
    // legitimate Brevo traffic gets its own rate-limit bucket rather than sharing the fallback one
    // (`mail_inbound_rejected_total{reason="rate"}` firing on normal volume would mean the configured
    // address never matched and every caller is still sharing one socket-address bucket).
    inboundTrustedProxies: (process.env.MAIL_INBOUND_TRUSTED_PROXIES ?? "")
      .split(",").map((s) => s.trim()).filter(Boolean),
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

/** PRV-02 — the `provision` seam is fully configured and an egress is even attemptable.
 *
 *  All THREE knobs are required: a base URL with no service credential cannot authenticate (every
 *  provision call is `Bearer`-gated behind `POST /api/users/login`), and a credential with no base
 *  URL has nowhere to go. Anything less is "unconfigured", not "partly working" — the provisioning
 *  service turns a false here into `ProvisionNotConfiguredError` -> 503, exactly the fail-closed
 *  convention `googleOAuthConfigured()` above and `mcp-hub/src/delivery-tools.ts:78` already use.
 *
 *  Fail-CLOSED is load-bearing here in a way it is not for a read-only integration: the alternative
 *  failure mode (a default endpoint, or "just skip the call") would either provision against a
 *  production host nobody configured, or silently report success for infrastructure that was never
 *  created. Both are worse than a 503. */
export function provisionConfigured(): boolean {
  const p = config.provision;
  return !!(p.baseUrl && p.serviceEmail && p.servicePassword);
}

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
