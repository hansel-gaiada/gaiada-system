// The one place that decides whether DEMO_MODE is on, and the one place that refuses to let it be
// on in production.
//
// What DEMO_MODE actually is: a LOCAL verification harness. `platform.ts`'s `platformFetch` answers
// from `demoFixtures.ts` instead of calling the BFF, so a UI surface can be driven with no backend
// running at all. That is the main chokepoint and it loads the fixtures through a DYNAMIC import,
// which is why production has always been clean: those ~16.6k lines never enter the bundle unless the
// flag is set. Verified 2026-09-03 against the live estate — `gaiada-platform-ui-1` carries only
// NODE_ENV=production, and DEMO_MODE appears in no compose file or env on the box.
//
// It is NOT a single branch, though, which is the reason this module exists rather than a comment.
// Eight further branches gate real behaviour on the flag: the meetings audio route, the search
// change-proposal export route, three paths in `meetingsActions.ts`, the assistant and portal SSE
// streams, and — the one that matters most — `app/login/actions.ts`, which in demo mode accepts ANY
// email as a valid login. All of them now go through `isDemoMode()`.
//
// Why a guard exists at all. "Production never sets it" is a fact about today's configuration, not a
// property of the system. One stray `DEMO_MODE=1` in an env file would BYPASS AUTHENTICATION and
// answer real users from fixtures — invented invoices, clients, monitors — while looking entirely
// healthy: 200s, no errors, plausible data. Nothing about the running app would reveal it. So the
// rule is FAIL LOUD, NOT FAIL OPEN: refuse to serve rather than serve fiction.
//
// This deliberately does NOT delete the harness. Removing it would remove the only way to drive a UI
// surface without a backend, and it is still how several surfaces are verified. It gets deleted per
// surface, once live coverage replaces it — owner ruling, 2026-09-03.

/** Raw request: is DEMO_MODE asked for? Says nothing about whether it is ALLOWED. Use this only to
 *  REPORT the flag (the /about diagnostics panel), never to decide behaviour. */
export function demoModeRequested(): boolean {
  return process.env.DEMO_MODE === "1";
}

/** True when the deployment must never serve fixtures. `NODE_ENV` is set to `production` by
 *  `next build`/`next start` and by the deployed image; a local `next dev` is `development`. */
function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production";
}

/** CI legitimately runs a PRODUCTION-mode build and server against the demo fixtures: the
 *  `npm run build` gate exists precisely to catch `server-only` imports reaching client components,
 *  and the Playwright smoke drives that same artifact through `next start` — both with no backend,
 *  hence DEMO_MODE=1. `next build` always sets NODE_ENV=production, so a naive "demo + production =
 *  refuse" rule breaks CI. It did exactly that on 2026-09-03.
 *
 *  The escape hatch is therefore a SECOND, explicitly-named variable. This is not a weakening: the
 *  live deployment sets NEITHER, so a stray DEMO_MODE=1 there still refuses to start. Defeating the
 *  guard now requires deliberately asserting, by name, that the environment is not production. */
export function demoModeAcknowledgedNonProduction(): boolean {
  return process.env.DEMO_MODE_ACK_NON_PRODUCTION === "1";
}

// Leads with the login bypass, deliberately. Whoever reads this at 2am is deciding whether to force
// the deployment back up, and "invented data" sounds survivable while "anyone can log in" does not.
// The severity ordering here is the message's whole job.
export const DEMO_MODE_IN_PRODUCTION_MESSAGE =
  "DEMO_MODE=1 is set while NODE_ENV=production. Refusing to start: demo mode bypasses login " +
  "(app/login/actions.ts accepts ANY email as a valid session) and answers every API read from " +
  "in-memory fixtures instead of the platform, so this deployment would let anyone in and serve " +
  "invented invoices, clients and monitors to real users while appearing completely healthy. Unset " +
  "DEMO_MODE on this deployment. It is a local verification harness and is never valid in production.";

/** Throws if DEMO_MODE is requested in a production runtime. Called from the boot guard
 *  (`next.config.ts`) so a misconfigured deployment dies at start, and again from `isDemoMode()` so
 *  a runtime that somehow got past boot still cannot serve a single fixture. */
export function assertDemoModeAllowed(): void {
  if (demoModeRequested() && isProductionRuntime() && !demoModeAcknowledgedNonProduction()) {
    throw new Error(DEMO_MODE_IN_PRODUCTION_MESSAGE);
  }
}

/** The only function that may gate BEHAVIOUR on demo mode. Asserts first, so the answer is never
 *  "yes" in a context where fixtures are forbidden. */
export function isDemoMode(): boolean {
  assertDemoModeAllowed();
  return demoModeRequested();
}
