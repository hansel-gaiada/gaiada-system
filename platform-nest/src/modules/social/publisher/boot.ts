// SMM-05/06 — the social publisher's boot wiring, extracted out of its call site so a boot-wiring
// test can invoke the exact function `bootstrap()` calls rather than a copy of its ordering. Same
// reasoning (and the same shape) as `wireSearchProviderModeAndAdsWriteMode` in main.ts, which was
// extracted after the SM-24 gate found two guard lines nested inside a mode branch while a comment
// claimed they ran unconditionally.
//
// ── SMM-38 PHASE 38c — `direct` IS NOW REGISTERED, AND WHY THAT IS STILL INERT ──────────────────
// 38a/38b deliberately did NOT call `registerPublisher(createDirectDriver())` here: `direct` had an
// EMPTY capability set, and registering an empty-but-present driver would have flipped
// `resolvePublisher`'s "is anything configured" heuristic from an honest `publisher_not_configured`
// to a confusing `unknown_publisher` for zero behavioural gain. 38c gives `direct` its first real
// capability (LinkedIn), so this phase makes the registration call — and PRESERVES the distinction
// rather than breaking it, by fixing the heuristic itself (`registry.ts#resolvePublisher`, see its
// own updated header) to ignore `direct`'s registration when deciding "is anything configured".
//
// This remains behaviourally INERT on every deployment that has not deliberately set the override
// below, for two independent reasons — a THIRD reason 38c/38d's own header used to name here
// (`dispatch.ts` had no call site that could ever reach `direct`) was closed by 38e's
// `provisioning.ts#resolveDispatchOrgHandle` + `dispatch.ts`'s own wiring onto it, proven with a
// live-shaped test (a real `social_oauth_tokens` row, a real `resolveActiveAccessToken` call) rather
// than merely asserted:
//   1. `resolvePublisher` is only ever called with `org.driver`, which 0105's CHECK constrains to
//      'postiz'|'mixpost' — 'direct' is never named there, so the ordinary per-org resolution path
//      (`provisioning.ts#openOrg`) can never reach it.
//   2. `resolvePublisherForCapability`'s override map (`config.social.publisher.capabilityDrivers`)
//      is still EMPTY by default — nothing routes a (network, capability) pair to `direct` unless an
//      operator explicitly sets `SOCIAL_PUBLISHER_CAPABILITY_DRIVERS`, which no deployment does today
//      (38e does not change this default — see that ticket's own tracker evidence for why).
// `registerLinkedInTokenRefresher()`/`registerYouTubeTokenRefresher()` (38d adds the latter) are the
// SAME story: each is a pure Map insert (no network call), and each only becomes reachable when
// SMM-36's retention sweep finds a grant of its OWN network within its refresh-ahead window — which
// requires a LIVE grant to already exist, and none does until 38e (or a standalone connect ceremony)
// actually completes one via `linkedin-oauth.controller.ts`/`youtube-oauth.controller.ts`.
//
// 38d itself adds no NEW reason this stays inert — it widens `direct`'s real capability set
// (YouTube's resumable upload, quota accounting, comment read) using the SAME registration call this
// header already documents; none of the three reasons above needed revisiting.
//
// ── THE PROPERTY THIS FILE OWES: BOOTING CLEANLY WITH POSTIZ UNREACHABLE ────────────────────────
// Nothing here opens a socket. Registration is a pure, local decision from config, so:
//   - Postiz down, tunnel down, VPS not built yet → the platform boots normally, the social module
//     registers, and every READ it serves works.
//   - The publisher-touching capabilities refuse with a typed `publisher_not_configured` /
//     `publisher_unreachable`, which the filter renders as a 503 with a code — a visibly degraded
//     feature, not a mystery.
// A boot-time health probe would invert that: it would couple this platform's availability to the
// licence zone's, which is precisely what containment exists to prevent.
//
// ── AND THE ONE THING THAT *IS* A BOOT ERROR ───────────────────────────────────────────────────
// A publisher base URL pointing at a PUBLIC address. That is the inverse of the search module's
// guard and it is deliberate — read `assertPublisherBaseUrlIsPrivate` below for why the estate's
// standing "boot errors, not warnings" doctrine applies here too.
//
// ── SCP-Sa — THE SIMULATOR'S BOOT ERRORS (the "no simulator" rule, reversed for the dev review only) ──────────────
// This file used to say "there is deliberately no fallback driver and no simulator". Plan SCP-D3 (owner ruling SCP-D1)
// reverses that for the dev-review stage: with SOCIAL_SIMULATION_ENABLED on, `wireSocialPublisher` registers
// simulated-driver.ts. simulation.ts's header lists the six fences; the ones that live HERE are boot errors that abort
// startup (SM-33's `assertProvenance` doctrine, main.ts: "this must abort startup, not degrade to a warning"):
//   1. an override in SOCIAL_PUBLISHER_CAPABILITY_DRIVERS that names 'simulated', switch on OR off: it would route real
//      accounts to a driver that reports publishes that never happened;
//   and with the switch ON:
//   2. Postiz configured (SOCIAL_POSTIZ_BASE_URL set): a real engine beside the simulator;
//   3. any SOCIAL_PUBLISHER_CAPABILITY_DRIVERS override: the only thing that makes `direct` reachable by config;
//   4. any live (`status = 'active'`) OAuth grant in `social_oauth_tokens`, in any tenant: the other thing that makes
//      `direct` able to publish for real;
//   5. ANY non-simulated `social_accounts` row, in any tenant, soft-deleted included (a soft-deleted account is one upsert
//      away from live again): the simulator and real client accounts never share a database;
//   6. after registration, the object-level re-check (`simulation.ts#publisherProvenanceViolation`): each registered
//      driver's structural `simulated` marker matches its key and the switch.
// With the switch OFF none of 2-5 runs and the DB is not read: a real deployment boots exactly as before, and the
// simulator is never registered (`registry.ts#registerPublisher` would refuse it). Checks 4 and 5 are the ONLY database
// reads in this file; they still open no socket to Postiz or any network, so the property above holds. They read each
// tenant through its own `withTenants` with the social scope declared (the RLS zero-row trap: an unscoped read of a
// FORCE-RLS table counts zero and would wave the boot through).
import { config } from "../../../config";
import { withGlobal, withTenants } from "../../../db";
import { checkPrivateVendorBaseUrl } from "../../../search-vendor-baseurl-guard";
import { createPostizDriverFromConfig } from "./postiz";
import { createDirectDriver } from "./direct";
import { createDbYouTubeQuotaStore } from "./youtube-quota";
import { registerLinkedInTokenRefresher } from "./linkedin-oauth";
import { registerYouTubeTokenRefresher } from "./youtube-oauth";
import { listPublishers, registerPublisher } from "./registry";
import { createSimulatedPublisher } from "./simulated-driver";
import {
  SIMULATED_PUBLISHER_KEY, SIMULATED_URL_ORIGIN, SOCIAL_SIMULATION_ENV, isSocialSimulationEnabled,
  publisherProvenanceViolation,
} from "./simulation";

/** Escape hatch for the one legitimate case: an operator deliberately running the engine behind a
 *  reverse proxy on a public name (a staging arrangement nobody has asked for yet). Named, so the
 *  refusal message can tell a human how to override it knowingly. */
export const SOCIAL_ALLOW_PUBLIC_PUBLISHER_BASE_URL_ENV = "SOCIAL_ALLOW_PUBLIC_PUBLISHER_BASE_URL";

export class PublicPublisherBaseUrlError extends Error {
  constructor(readonly baseUrl: string) {
    super(
      `[social] BOOT ERROR: SOCIAL_POSTIZ_BASE_URL ('${baseUrl}') looks like a PUBLIC address. The `
      + "social publisher is reached over a WireGuard point-to-point tunnel (10.88.0.2), and the VPS "
      + "that runs it has NO public listener of any kind — not :443, not :80, not :4007 (addendum "
      + "§A4l §2/§3). A public value here means either the tunnel was 'fixed' by pointing at a public "
      + "address (the runbook forbids exactly this: a tunnel outage must fail closed and loudly) or "
      + "that someone published the engine's authenticated API to the internet. Both are containment "
      + `failures. Set ${SOCIAL_ALLOW_PUBLIC_PUBLISHER_BASE_URL_ENV}=1 only for a deliberate `
      + "proxied deployment that has had its own review.",
    );
    this.name = "PublicPublisherBaseUrlError";
  }
}

/** Refuse boot when the publisher base URL is public.
 *
 *  ── WHY THIS IS THE INVERSE OF THE SEARCH GUARD, AND WHY BOTH ARE RIGHT ─────────────────────────
 *  `assertLiveVendorBaseUrlsAreNotPrivate` refuses a LIVE vendor URL pointing somewhere PRIVATE,
 *  because a private host answering as DataForSEO would mint `simulated=false` rows from whatever
 *  is listening. Here the hazard runs the other way: the publisher is an AGPL engine holding every
 *  client's live network tokens, deliberately given no public listener at all, and the only correct
 *  value for this variable is a tunnel address. A public one means the containment perimeter moved.
 *  Same doctrine, opposite polarity — and the shared host classifier
 *  (`checkPrivateVendorBaseUrl`) is reused rather than re-implemented so "what counts as private"
 *  cannot drift between the two.
 *
 *  It is a BOOT error, not a request-time one, for the reason platform-nest's CLAUDE.md gives for
 *  every other boot refusal in this codebase: a request-time failure happens AFTER a one-shot
 *  approval has been spent. And it is honest about its own limits — this is a lexical check on a
 *  string, an ACCIDENT guard, not an authz control; a public DNS name that resolves privately sails
 *  straight through it. It catches the mistake a tired operator makes at 3am, which is the mistake
 *  the runbook explicitly warns about.
 *
 *  Unset base URL ⇒ no check and no error: "this deployment has no publisher" is a supported mode. */
export function assertPublisherBaseUrlIsPrivate(baseUrl: string, allowOverride: boolean): void {
  if (allowOverride) return;
  if (!baseUrl) return;
  const { isPrivate } = checkPrivateVendorBaseUrl(baseUrl);
  if (!isPrivate) throw new PublicPublisherBaseUrlError(baseUrl);
}

// ── SCP-Sa — the simulator's boot errors ───────────────────────────────────────────────────────────────────────────

export class SocialSimulationBootError extends Error {
  constructor(reason: string) {
    super(
      `[social] BOOT ERROR: ${reason}. The social simulator (plan SCP-D3, dev review only) never runs beside anything `
      + `real; this must abort startup, not degrade to a warning. Either switch it off (unset ${SOCIAL_SIMULATION_ENV}) `
      + "or remove the real publisher or accounts named above.",
    );
    this.name = "SocialSimulationBootError";
  }
}

/** What boot must know to decide. Every field is a plain value, so `assertSocialSimulationBootSafe` is pure and every
 *  boot error has a test without a database. */
export interface SocialSimulationBootFacts {
  enabled: boolean;
  postizBaseUrl: string;
  capabilityOverrides: Record<string, string>;
  /** `social_oauth_tokens` rows with `status = 'active'`, every tenant. Read only when `enabled`. */
  liveOAuthGrants: number;
  /** `social_accounts` rows with `simulated = false`, every tenant, soft-deleted included. Read only when `enabled`. */
  realAccounts: number;
}

/** Boot errors 1-5 of this file's header. Throws `SocialSimulationBootError`; returns nothing when the boot may go on. */
export function assertSocialSimulationBootSafe(f: SocialSimulationBootFacts): void {
  const routedToSimulator = Object.entries(f.capabilityOverrides).filter(([, d]) => d === SIMULATED_PUBLISHER_KEY);
  if (routedToSimulator.length > 0) {
    throw new SocialSimulationBootError(
      `SOCIAL_PUBLISHER_CAPABILITY_DRIVERS routes ${routedToSimulator.map(([k]) => `'${k}'`).join(", ")} to `
      + `'${SIMULATED_PUBLISHER_KEY}'; the simulator is reached only through a simulated account, never by config`,
    );
  }
  if (!f.enabled) return;
  if (f.postizBaseUrl) {
    throw new SocialSimulationBootError(
      `${SOCIAL_SIMULATION_ENV} is on while SOCIAL_POSTIZ_BASE_URL is set: Postiz is a real publishing engine`,
    );
  }
  const overrides = Object.keys(f.capabilityOverrides);
  if (overrides.length > 0) {
    throw new SocialSimulationBootError(
      `${SOCIAL_SIMULATION_ENV} is on while SOCIAL_PUBLISHER_CAPABILITY_DRIVERS routes ${overrides.join(", ")} to a `
      + "real driver ('direct' publishes for real)",
    );
  }
  if (f.liveOAuthGrants > 0) {
    throw new SocialSimulationBootError(
      `${SOCIAL_SIMULATION_ENV} is on while ${f.liveOAuthGrants} live OAuth grant(s) exist in social_oauth_tokens: a `
      + "connected LinkedIn/YouTube account can publish for real through 'direct'",
    );
  }
  if (f.realAccounts > 0) {
    throw new SocialSimulationBootError(
      `${SOCIAL_SIMULATION_ENV} is on while ${f.realAccounts} non-simulated social_accounts row(s) exist (any tenant, `
      + "soft-deleted included): the simulator may run only on a database whose every social account is simulated "
      + "(mark the seeded mock accounts simulated, SCP-Sb, or remove them)",
    );
  }
}

/** The two DB facts, read tenant by tenant through the third wall (see this file's header). Every company, deleted ones
 *  included: a real account under a deleted company is still a real account. */
export async function readSocialSimulationDbFacts(): Promise<{ liveOAuthGrants: number; realAccounts: number }> {
  const { rows: tenants } = await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM companies`));
  let liveOAuthGrants = 0;
  let realAccounts = 0;
  for (const { id } of tenants) {
    const r = await withTenants(
      [id],
      (c) => c.query<{ grants: string; accounts: string }>(
        `SELECT (SELECT count(*) FROM social_oauth_tokens WHERE status = 'active')::text AS grants,
                (SELECT count(*) FROM social_accounts WHERE simulated = false)::text AS accounts`,
      ),
      { modules: ["social"] },
    );
    liveOAuthGrants += Number(r.rows[0]?.grants ?? 0);
    realAccounts += Number(r.rows[0]?.accounts ?? 0);
  }
  return { liveOAuthGrants, realAccounts };
}

/** Test seams for `wireSocialPublisher`. The switch itself is read from config (`isSocialSimulationEnabled`), exactly as
 *  `registerPublisher` reads it, so a test cannot wire one value and register under another. */
export interface SocialPublisherWiringDeps {
  /** Defaults to `readSocialSimulationDbFacts`. Called ONLY when the switch is on. */
  readDbFacts?: () => Promise<{ liveOAuthGrants: number; realAccounts: number }>;
}

/** Register the publisher driver, or deliberately register nothing.
 *
 *  KEYLESS/URL-LESS IS THE DEFAULT AND IS SUPPORTED — see config.ts. With no base URL the registry
 *  stays empty and every publisher path fails closed at `resolvePublisher` with
 *  `publisher_not_configured`, exactly as the search registry does for an unfunded vendor. There is
 *  deliberately no fallback driver and, with SOCIAL_SIMULATION_ENABLED off, no simulator: a "simulated publish" would be a post that
 *  never appeared on a client's account while our calendar said it did — silent, and worse than an
 *  outage (see mock-driver.ts's header for the full contrast with SM-33's simulated providers).
 *
 *  SCP-Sa: that paragraph stays TRUE for every deployment with SOCIAL_SIMULATION_ENABLED off, which is every deployment
 *  that holds real data. With it on (dev review only), the simulator is registered here, behind the boot errors of this
 *  file's header, and announces itself on a `[social:simulation-enabled]` warning line on every start. Async since
 *  SCP-Sa, for the two DB counts those errors need; with the switch off it awaits nothing. */
export async function wireSocialPublisher(deps: SocialPublisherWiringDeps = {}): Promise<void> {
  // SCP-Sa — decided FIRST, before anything is registered: a refused boot leaves no half-wired registry behind.
  const simulation = isSocialSimulationEnabled();
  const dbFacts = simulation
    ? await (deps.readDbFacts ?? readSocialSimulationDbFacts)()
    : { liveOAuthGrants: 0, realAccounts: 0 };
  assertSocialSimulationBootSafe({
    enabled: simulation,
    postizBaseUrl: config.social.publisher.baseUrl,
    capabilityOverrides: config.social.publisher.capabilityDrivers,
    ...dbFacts,
  });

  // SMM-38c — registered FIRST and UNCONDITIONALLY, deliberately ahead of the Postiz early-return
  // below: `direct` must be present in the registry regardless of whether Postiz is configured, or
  // `resolvePublisherForCapability` could never find it by name in a Postiz-unconfigured deployment
  // (a real deployment shape: LinkedIn/YouTube via `direct`, no Postiz at all, once 38e flips the
  // config). See this file's header for why this is still inert on every live path today, and
  // `registry.ts#resolvePublisher`'s own updated header for the heuristic fix that keeps it safe.
  // SMM-38 phase 38e — Gap 3's durability fix: the REAL app gets the DB-backed, cross-instance-safe
  // quota store (`youtube-quota.ts`'s own header); every test that builds its own driver via
  // `createDirectDriver()` with no override keeps the in-memory default, unchanged.
  registerPublisher(createDirectDriver({ quotaStore: createDbYouTubeQuotaStore() }));
  registerLinkedInTokenRefresher();
  // SMM-38 phase 38d — same pure-Map-insert, verified-inert-until-a-real-grant-exists property as
  // registerLinkedInTokenRefresher() immediately above; see that call's own reasoning in this file's
  // header (point 3) and oauth-tokens.ts's own header.
  registerYouTubeTokenRefresher();

  assertPublisherBaseUrlIsPrivate(
    config.social.publisher.baseUrl,
    process.env[SOCIAL_ALLOW_PUBLIC_PUBLISHER_BASE_URL_ENV] === "1",
  );
  const driver = createPostizDriverFromConfig();
  if (!driver) {
    // eslint-disable-next-line no-console
    console.log(
      "[social] publisher not configured (SOCIAL_POSTIZ_BASE_URL unset) — connector sync and "
      + "publishing are unavailable and refuse with publisher_not_configured; every other social "
      + "capability is unaffected ('direct' is registered for LinkedIn's own capabilities regardless — "
      + "SMM-38 phase 38c)",
    );
  } else {
    registerPublisher(driver);
    // eslint-disable-next-line no-console
    console.log(
      `[social] publisher driver '${driver.key}' registered (networks enabled: `
      + `${config.social.publisher.enabledNetworks.join(", ") || "none"}; `
      + `live quota probe: ${config.social.publisher.quotaProbeTool ? "on" : "off"}; `
      // Named at boot because the addendum's biggest P2 finding is invisible at runtime otherwise:
      // this engine has NO inbound engagement surface for any network.
      + `inbox surface: ${driver.capabilities.has("inbox_read") ? "yes" : "none (engine has no inbound API)"})`,
    );
  }

  // ── SCP-Sa — the simulator: registered ONLY with the switch on, then the object-level re-check ─────────────────────
  // (the Postiz branch above used to `return` early; it no longer does, so this section runs with or without Postiz).
  if (simulation) registerPublisher(createSimulatedPublisher());
  const violation = publisherProvenanceViolation(listPublishers(), simulation);
  if (violation) throw new SocialSimulationBootError(violation);
  if (simulation && !listPublishers().some((p) => p.key === SIMULATED_PUBLISHER_KEY)) {
    throw new SocialSimulationBootError(`${SOCIAL_SIMULATION_ENV} is on but the social simulator did not register`);
  }
  // One line on every start, as PV5-11's signing line does: a WARNING while the simulator is on, so a server that still
  // has it on says so in every boot log.
  if (simulation) {
    // eslint-disable-next-line no-console
    console.warn(
      `[social:simulation-enabled] ${SOCIAL_SIMULATION_ENV} is ON: the social simulator publishes simulated accounts' `
      + `posts to ${SIMULATED_URL_ORIGIN}/ and nothing reaches a real network (plan SCP-D3, dev review only). Turn it `
      + "OFF and purge the simulated rows before the ERP holds real client data.",
    );
  } else {
    // eslint-disable-next-line no-console
    console.log(`[social] simulation: off (${SOCIAL_SIMULATION_ENV} unset); the social simulator is not registered`);
  }
}
