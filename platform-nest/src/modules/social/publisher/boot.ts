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
import { config } from "../../../config";
import { checkPrivateVendorBaseUrl } from "../../../search-vendor-baseurl-guard";
import { createPostizDriverFromConfig } from "./postiz";
import { createDirectDriver } from "./direct";
import { createDbYouTubeQuotaStore } from "./youtube-quota";
import { registerLinkedInTokenRefresher } from "./linkedin-oauth";
import { registerYouTubeTokenRefresher } from "./youtube-oauth";
import { registerPublisher } from "./registry";

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

/** Register the publisher driver, or deliberately register nothing.
 *
 *  KEYLESS/URL-LESS IS THE DEFAULT AND IS SUPPORTED — see config.ts. With no base URL the registry
 *  stays empty and every publisher path fails closed at `resolvePublisher` with
 *  `publisher_not_configured`, exactly as the search registry does for an unfunded vendor. There is
 *  deliberately no fallback driver and no simulator: a "simulated publish" would be a post that
 *  never appeared on a client's account while our calendar said it did — silent, and worse than an
 *  outage (see mock-driver.ts's header for the full contrast with SM-33's simulated providers). */
export function wireSocialPublisher(): void {
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
    return;
  }
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
