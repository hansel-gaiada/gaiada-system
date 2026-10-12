// M5-P2 — the per-platform LIVE uploader registry and its boot guard (design §8.7). Follows the §A12.6 pattern of
// sem-executor-google-ads.ts (`registerLiveAdsExecutor` + `assertAdsWriteModeBootSafe`), kept SEPARATE from the campaign switch.
//
//   SEARCH_CONVERSIONS_LIVE_PLATFORMS   default empty = EVERY platform runs in simulate. e.g. `google_ads`.
//
// Boot REFUSES to start when a listed platform has no registered live uploader, or a listed token is not a known platform.
// Both are boot errors and not warnings, for the reason sem-executor-google-ads.ts gives for its own: a request-time failure
// would land AFTER a human's approval was spent. A platform stays simulated until its live uploader exists (Meta waits on O-7).
import { googleAdsConversionUploader, type ConversionUploader } from "./conversions-google";
import {
  SEARCH_CONVERSIONS_LIVE_PLATFORMS_ENV, parseLivePlatforms, type ConversionPlatform,
} from "./conversions";

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
          "a live upload must never silently fall back to simulation (design §8.7). Leave it out of the list until its uploader exists.",
      );
    }
  }
}

/** Called once from main.ts's `wireSearchProviderModeAndAdsWriteMode`, at function scope, unconditionally on every boot. */
export function wireSearchConversionsWriteMode(env: NodeJS.ProcessEnv = process.env): void {
  registerLiveConversionUploader("google_ads", googleAdsConversionUploader);
  assertConversionsBootSafe(env[SEARCH_CONVERSIONS_LIVE_PLATFORMS_ENV]);
}
