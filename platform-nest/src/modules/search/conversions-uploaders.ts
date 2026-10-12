// M5-P2 — the per-platform LIVE uploader registry and its boot guard (design §8.7). Follows the §A12.6 pattern of
// sem-executor-google-ads.ts (`registerLiveAdsExecutor` + `assertAdsWriteModeBootSafe`), kept SEPARATE from the campaign switch.
//
//   SEARCH_CONVERSIONS_LIVE_PLATFORMS   default empty = EVERY platform runs in simulate. e.g. `google_ads`.
//
// Boot REFUSES to start when a listed platform has no registered live uploader, or a listed token is not a known platform.
// Both are boot errors and not warnings, for the reason sem-executor-google-ads.ts gives for its own: a request-time failure
// would land AFTER a human's approval was spent. A platform stays simulated until its live uploader exists (Meta waits on O-7).
//
// TWO registries live here, and they are different things:
//   * the PLAN ADAPTERS (`buildConversionPlan`): every platform has one, Google, Meta (P3) and LinkedIn (P4). They build the request
//     and its non-personal summary, which is all simulate needs. Pure, no network.
//   * the LIVE UPLOADERS (`registerLiveConversionUploader`): only Google has one. Meta and LinkedIn are SIMULATE-ONLY, so the boot
//     guard refuses them as live platforms: no live transport, credential or token is wired for either.
import type { LeadConversionFacts } from "../../core/agency-lead-pipeline.service";
import { buildGoogleUploadRequest, googleAdsConversionUploader, type ConversionUploader } from "./conversions-google";
import { buildMetaUploadRequest } from "./conversions-meta";
import { buildLinkedInUploadRequest } from "./conversions-linkedin";
import {
  SEARCH_CONVERSIONS_LIVE_PLATFORMS_ENV, parseLivePlatforms, type ConversionPlan, type ConversionPlatform, type PlanLedger,
} from "./conversions";

/** Everything a plan adapter may read. The facts hold personal data: they are used in memory and never returned except inside `body`. */
export interface BuildPlanInput {
  facts: Pick<LeadConversionFacts, "attribution" | "contactEmail" | "contactPhone" | "visitorConsent">;
  ledger: PlanLedger;
  /** The target's `conversion_action`: a Google conversion action, a Meta event name, or a LinkedIn conversion rule. */
  conversionAction: string;
  sendValue: boolean;
  /** Meta only: `event_source_url`, built from the property's site URL and the form page path. Null when unknown. */
  eventSourceUrl?: string | null;
}

/** Platforms with no live uploader by design (named in the boot error so the reason is not a mystery). */
export const SIMULATE_ONLY_PLATFORMS: readonly ConversionPlatform[] = ["meta_capi", "linkedin_capi"];

/** Dispatch to the platform's request builder. THROWS on a conversion action the platform cannot take (the caller treats it as a typed
 *  `conversion_request_invalid` failure BEFORE anything is sent). */
export function buildConversionPlan(platform: ConversionPlatform, input: BuildPlanInput): ConversionPlan {
  switch (platform) {
    case "google_ads":
      return buildGoogleUploadRequest({ facts: input.facts, ledger: input.ledger, conversionAction: input.conversionAction, customerId: null, sendValue: input.sendValue });
    case "meta_capi":
      return buildMetaUploadRequest({ facts: input.facts, ledger: input.ledger, conversionAction: input.conversionAction, sendValue: input.sendValue, eventSourceUrl: input.eventSourceUrl });
    case "linkedin_capi":
      return buildLinkedInUploadRequest({ facts: input.facts, ledger: input.ledger, conversionAction: input.conversionAction, sendValue: input.sendValue });
  }
}

const live = new Map<ConversionPlatform, ConversionUploader>();

/** Register (or replace, for tests) a platform's live uploader. */
export function registerLiveConversionUploader(platform: ConversionPlatform, uploader: ConversionUploader): void {
  live.set(platform, uploader);
}

export function getLiveConversionUploader(platform: ConversionPlatform): ConversionUploader | undefined {
  return live.get(platform);
}

/** Test seam: forget every registration. */
export function resetLiveConversionUploaders(): void {
  live.clear();
}

export class ConversionsWriteModeBootError extends Error {}

/** Pure and synchronous: trivially unit-testable without booting the app. */
export function assertConversionsBootSafe(
  raw: string | undefined,
  registered: (p: ConversionPlatform) => boolean = (p) => live.has(p),
): void {
  const { platforms, unknown } = parseLivePlatforms(raw);
  if (unknown.length > 0) {
    throw new ConversionsWriteModeBootError(
      `[search] BOOT ERROR: ${SEARCH_CONVERSIONS_LIVE_PLATFORMS_ENV} names unknown platform(s) ${unknown.join(", ")} - a typo here ` +
        "must not silently mean 'simulate everywhere'. Known: google_ads, meta_capi, linkedin_capi.",
    );
  }
  for (const p of platforms) {
    if (!registered(p)) {
      throw new ConversionsWriteModeBootError(
        `[search] BOOT ERROR: ${SEARCH_CONVERSIONS_LIVE_PLATFORMS_ENV} lists '${p}' but no live conversion uploader is registered for it - ` +
          "a live upload must never silently fall back to simulation (design §8.7). Leave it out of the list until its uploader exists." +
          (SIMULATE_ONLY_PLATFORMS.includes(p) ? ` '${p}' is SIMULATE-ONLY: its request builder exists, its live transport and credentials do not (Meta also waits on Business Verification, plan O-7).` : ""),
      );
    }
  }
}

/** Called once from main.ts's `wireSearchProviderModeAndAdsWriteMode`, at function scope, unconditionally on every boot. */
export function wireSearchConversionsWriteMode(env: NodeJS.ProcessEnv = process.env): void {
  registerLiveConversionUploader("google_ads", googleAdsConversionUploader);
  assertConversionsBootSafe(env[SEARCH_CONVERSIONS_LIVE_PLATFORMS_ENV]);
}
