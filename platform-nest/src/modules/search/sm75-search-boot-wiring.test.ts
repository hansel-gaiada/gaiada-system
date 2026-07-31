// SM-75 (tracker §6bv/§6bv.1) — a boot-wiring smoke test for the search department's
// SEARCH_PROVIDER_MODE / SEARCH_ADS_WRITE_MODE wiring in main.ts.
//
// THE FAILURE THIS CLOSES: SM-24's gate caught `registerLiveAdsExecutor(googleAdsLiveExecutor)` +
// `assertAdsWriteModeBootSafe(...)` nested INSIDE main.ts's `SEARCH_PROVIDER_MODE === "live"` branch,
// while a comment on that exact code claimed the registration was "unconditional". So
// `SEARCH_PROVIDER_MODE=simulate` silently skipped both the registration and the boot assertion —
// and simulated DATA with live AD WRITES is a combination design addendum §A12.6 calls legitimate. It
// booted cleanly and only failed at REQUEST time with `NoLiveExecutorError`, after a one-shot approval
// had already been spent — exactly the outcome architect Ruling 3.1 exists to forbid. No test in this
// platform executes `bootstrap()`, so 1056 tests, five mutation probes and a full architect ruling all
// missed it; a careful human read caught it. This file exists so a regression back into that shape
// fails a test, not a human re-read.
//
// `assertAdsWriteModeBootSafe` itself is pure and already unit-tested (sem-executor-google-ads.test.ts
// pins that "live with no live executor" throws and "simulate", or "live WITH one", does not). This
// file does NOT re-test that pure contract — it tests WHERE it is called from, which is the actual
// thing that regressed. That is why it drives `main.ts`'s own exported
// `wireSearchProviderModeAndAdsWriteMode` (the function `bootstrap()` calls, unchanged in substance,
// merely lifted out of its call site per SM-75's own header comment above it) rather than
// re-implementing main.ts's if/else ordering here — a copy of the ordering would only ever prove
// itself self-consistent while main.ts silently drifted, which is a fresh instance of the very defect
// class this ticket exists to close.
//
// THE SIGNAL THAT DISTINGUISHES "IT RAN" FROM "NOTHING THREW YET": sem-apply.ts's
// `registerLiveAdsExecutor` sets a module-private variable with no direct getter. This file reads it
// back through the SAME public seam a real request handler uses — `resolveAdsExecutor("live")` throws
// `NoLiveExecutorError` iff no live executor is registered, and returns the real registered executor
// otherwise. Starting every case from `clearLiveAdsExecutor()` (so a stale registration from an
// earlier case or file can never fake a pass) and then asserting `resolveAdsExecutor("live")` resolves
// to the real `googleAdsLiveExecutor`, for all four SEARCH_PROVIDER_MODE × SEARCH_ADS_WRITE_MODE
// combinations, is what would actually go red if the two SM-26 lines were skipped for some
// SEARCH_PROVIDER_MODE — merely asserting "no throw" would not: the original defect's whole shape was
// that skipping the wiring did NOT throw at boot.
//
// NEGATIVE-CONTROL PROBE (§6bi Ruling 6; recorded per the ticket's own instruction, not left as an
// unstated claim): re-nesting `registerLiveAdsExecutor(...)`/`assertAdsWriteModeBootSafe(...)` back
// inside main.ts's `providerMode === "live"` branch (the exact original defect shape) and re-running
// this file alone was VERIFIED to turn the "providerMode=simulate" rows of the table below red (both
// of them — SEARCH_ADS_WRITE_MODE=simulate AND =live), while the "providerMode=live" rows stayed
// green (unaffected by that specific regression shape, matching the historical bug's own symptom,
// which only ever manifested under SEARCH_PROVIDER_MODE=simulate). The change was reverted from a
// `cp`-restored backup immediately after, verified byte-identical via sha256sum. See this ticket's
// completion report for the exact counts observed.
import { describe, it, expect, beforeEach } from "vitest";
import { wireSearchProviderModeAndAdsWriteMode } from "../../main";
import { clearLiveAdsExecutor, resolveAdsExecutor } from "./sem-apply";
import { googleAdsLiveExecutor } from "./sem-executor-google-ads";
import { resetProviders } from "./providers/registry";

type Mode = "simulate" | "live";
const MODES: readonly Mode[] = ["simulate", "live"];

describe("SM-75 boot-wiring smoke test — main.ts's wireSearchProviderModeAndAdsWriteMode()", () => {
  beforeEach(() => {
    // Start every case from a genuinely empty registration — a stale live-executor registration
    // carried over from an earlier case (or an earlier file, though vitest's default per-file module
    // isolation already prevents that) must never be mistaken for THIS case having registered one.
    clearLiveAdsExecutor();
    resetProviders();
  });

  // ── The design addendum §A12.6 cross-product table, driven through the REAL wiring function ──────
  for (const providerMode of MODES) {
    for (const adsWriteMode of MODES) {
      it(
        `SEARCH_PROVIDER_MODE=${providerMode} × SEARCH_ADS_WRITE_MODE=${adsWriteMode} boots, and ` +
          "registers a live Google Ads executor regardless of the DATA provider mode",
        () => {
          // The real call site's real function, not a re-implementation of its ordering.
          expect(() => wireSearchProviderModeAndAdsWriteMode({ providerMode, adsWriteMode })).not.toThrow();

          // THE PLACEMENT CHECK. `registerLiveAdsExecutor(googleAdsLiveExecutor)` must have actually run
          // — not merely "no error was thrown" — for EVERY providerMode, because the two SM-26 lines
          // sit at this function's top level (after, never inside, the providerMode if/else). This is
          // exactly the assertion that goes red under the original defect shape for the
          // providerMode=simulate rows (see this file's header, "NEGATIVE-CONTROL PROBE").
          const resolved = resolveAdsExecutor("live");
          expect(resolved.executor).toBe(googleAdsLiveExecutor);
          expect(resolved.expectSimulated).toBe(false);
        },
      );
    }
  }

  // ── Bonus: the production call shape itself (bootstrap() calls this with NO arguments) ────────────
  it(
    "with no explicit modes (bootstrap()'s own call shape), still reads real config/env and still " +
      "registers a live executor unconditionally",
    () => {
      expect(() => wireSearchProviderModeAndAdsWriteMode()).not.toThrow();
      const resolved = resolveAdsExecutor("live");
      expect(resolved.executor).toBe(googleAdsLiveExecutor);
    },
  );
});
