// SM-53 — pins the dispatch-refusal → HTTP mapping.
//
// The regression: these refusals are plain Errors, so the app-wide `HttpErrorFilter`
// (`@Catch(HttpException)`) never matched them and they surfaced as a **message-less 500**. That threw
// away the one thing they were designed to carry — `ScopeDisabledError` names the toggle to enable,
// `PillarDisabledError` names the env switch — and told the caller "the platform broke" when the
// platform had in fact deliberately refused.
//
// Tested at the filter rather than over HTTP on purpose: the mapping IS the unit, and a route test
// would additionally depend on a live DB + Cerbos + a registered provider to reach the throw, so it
// would fail for many reasons unrelated to the mapping. The message-preservation assertions are what
// actually matter, so they are asserted per refusal kind rather than once generically.
import { describe, it, expect } from "vitest";
import { ProviderDispatchErrorFilter } from "./provider-dispatch-error.filter";
import {
  BudgetExceededError,
  GlobalCeilingUnavailableError,
  NoCapableProviderError,
  PillarDisabledError,
  ProviderDispatchError,
  ScopeDisabledError,
} from "./providers/types";

function capture(err: ProviderDispatchError): { status: number; body: unknown } {
  let status = 0;
  let body: unknown;
  const reply = {
    status(s: number) { status = s; return this; },
    send(b: unknown) { body = b; return this; },
  };
  const host = { switchToHttp: () => ({ getResponse: () => reply }) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new ProviderDispatchErrorFilter().catch(err, host as any);
  return { status, body };
}

describe("SM-53 · dispatch refusals map to HTTP, never to a bare 500", () => {
  it("a scope refusal is 409 and STILL NAMES THE TOGGLE — the whole point of the error", () => {
    const { status, body } = capture(new ScopeDisabledError("ai_visibility", "ai_visibility"));
    expect(status).toBe(409);
    const b = body as { error: string; code: string };
    expect(b.code).toBe("scope_disabled");
    // The actionable substring is the assertion. A 409 carrying an empty body would be just as
    // useless to an operator as the 500 this replaced.
    expect(b.error).toContain("ai_visibility");
    expect(b.error).toContain("scope config");
  });

  it("a pillar refusal is 503 and names the env switch", () => {
    const { status, body } = capture(new PillarDisabledError("geo", "ai_visibility"));
    expect(status).toBe(503);
    const b = body as { error: string; code: string };
    expect(b.code).toBe("pillar_disabled");
    expect(b.error).toContain("SEARCH_PILLAR_GEO");
  });

  it("a budget breach is 409 and reports the arithmetic that refused it", () => {
    const { status, body } = capture(new BudgetExceededError("provider", 10, 9.5, 1));
    expect(status).toBe(409);
    const b = body as { error: string; code: string };
    expect(b.code).toBe("budget_exceeded");
    expect(b.error).toContain("provider");
  });

  it("an unevaluable ceiling is 503, NOT 500 — refusing was the design working, not a fault", () => {
    const { status, body } = capture(new GlobalCeilingUnavailableError("permission denied"));
    expect(status).toBe(503);
    expect((body as { code: string }).code).toBe("global_ceiling_unavailable");
  });

  it("no capable provider is 503 — keyless dev is a deployment state, not a caller error", () => {
    const { status, body } = capture(new NoCapableProviderError("backlinks"));
    expect(status).toBe(503);
    expect((body as { code: string }).code).toBe("no_capable_provider");
  });

  it("an UNMAPPED future refusal code defaults to 503, never 500", () => {
    // Defaulting to 500 would silently recreate this exact bug for any refusal kind added later —
    // the code would look handled while behaving like the thing we just fixed.
    const { status, body } = capture(
      new ProviderDispatchError("scope_disabled", "x") as ProviderDispatchError &
        Record<string, unknown>,
    );
    expect(status).toBe(409);
    expect(body).toHaveProperty("code");
  });

  it("every refusal body keeps `error` for contract parity AND adds `code` for branching", () => {
    // The UI and bot read `.error` app-wide; `code` is additive so a caller can branch on the kind
    // without string-matching a sentence that is free to be reworded.
    for (const err of [
      new ScopeDisabledError("rank", "serp"),
      new PillarDisabledError("seo", "serp"),
      new NoCapableProviderError("serp"),
    ]) {
      const { body } = capture(err);
      expect(body).toHaveProperty("error");
      expect(body).toHaveProperty("code");
      expect(typeof (body as { error: unknown }).error).toBe("string");
      expect((body as { error: string }).error.length).toBeGreaterThan(0);
    }
  });
});

// ── Registration pin (added by the session lead, SM-53/SM-57) ────────────────────────────────────
// Every test above instantiates the filter and calls `.catch()` directly, which proves the MAPPING but
// says nothing about whether Nest ever routes an error to it. So a filter could be deleted from
// `main.ts`'s `useGlobalFilters(...)` and every assertion above would still pass while production
// reverted to the exact message-less 500 these tickets exist to remove.
//
// That is not hypothetical here: SM-49's equivalent static pin on the base-URL boot guard caught two
// real bugs, and this module has now met the "guard whose removal changes nothing observable" pattern
// five times (§4d catch-to-0, §6d shape pin anchoring a name, §6f count that only warned, §6r inert
// remedy, §6z one-variable fix). A wiring gap is the same shape: the code looks handled.
//
// A static text assertion is deliberately crude, and that is the point — it fails loudly on the one
// edit that matters (removing the registration) and is immune to how Nest resolves filters internally.
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("SM-53/SM-57/SM-58/SM-25a · the filters are actually REGISTERED, not merely correct", () => {
  const mainTs = readFileSync(join(__dirname, "..", "..", "main.ts"), "utf8");

  it.each([
    "HttpErrorFilter",
    "ProviderDispatchErrorFilter",
    "GatewayNotConfiguredErrorFilter",
    // SM-58: the app-wide last-resort backstop must be extended into THIS pin, not given a separate
    // one — a second independent pin could pass while the real useGlobalFilters call in main.ts drops
    // one of the other three, since nothing would then cross-check them against each other.
    "LastResortExceptionFilter",
    // SM-25a: the Google-surface error family (modules/search/google/errors.ts +
    // google-oauth-error.filter.ts) joins the SAME pin, for the identical reason SM-58 gave. This is
    // the THIRD time this module has shipped a plain Error that escaped as a message-less 500
    // (SM-53's ProviderDispatchError, SM-57's GatewayNotConfiguredError), and LastResortExceptionFilter
    // is a floor, not a mapping — it cannot know that "Google OAuth is not configured" is a 503
    // deployment state while "this callback does not verify" is a 400. Unwiring this filter would
    // silently collapse every Google refusal onto the generic backstop's status, and every
    // direct-`.catch()` unit test in google-oauth-error.filter.test.ts would stay green.
    "GoogleOAuthErrorFilter",
    // W0-4 (webdev client access). Sixth member, added DELIBERATELY here — which is the whole point of
    // the exact-set pin below. It maps two families that both extend Error rather than HttpException:
    // the Keycloak-admin family (503 not-configured / 409 user-exists / 502 admin error) and
    // ClientInviteError (400, coarse by design). Before it existed, keycloak-admin.ts's header
    // ASSERTED a filter that was never written, so every one of those refusals surfaced as
    // LastResortExceptionFilter's generic 500 — discarding .status, .code and the missing-env list
    // that is the entire value of the 503. Same bug class as SM-53 and SM-57: a doc comment claiming a
    // mapping is not a mapping.
    "ClientAccessErrorFilter",
  ])("%s is passed to useGlobalFilters in main.ts", (filterName) => {
    // Anchored to the call itself, not merely to the identifier appearing somewhere in the file —
    // an import alone would otherwise satisfy a naive `includes()` while the filter stayed unwired.
    const call = mainTs.slice(mainTs.indexOf("useGlobalFilters("));
    const args = call.slice(0, call.indexOf(");") + 1);
    expect(args).toContain(`new ${filterName}(`);
  });

  it("all of them are registered in ONE useGlobalFilters call — a second call would REPLACE, not add", () => {
    // Nest's useGlobalFilters appends, but relying on that across two call sites is a trap worth
    // foreclosing: keeping them in one call makes the full set reviewable at a glance.
    // (Count went four -> five with SM-25a's GoogleOAuthErrorFilter, then five -> six with W0-4's
    // ClientAccessErrorFilter; the assertion below is on the number of CALLS, which must stay 1 no
    // matter how many filters the one call carries.)
    const occurrences = mainTs.split("useGlobalFilters(").length - 1;
    expect(occurrences).toBe(1);
  });

  it("the registered set is EXACTLY the known filters — adding one must be a deliberate edit here", () => {
    // Exact-set equality, the same discipline as the egress-inventory allowlist and ledger.ts's SQL
    // shape pins. The it.each above proves each expected filter is PRESENT; without this, a filter
    // added to main.ts but never reasoned about here would ship unreviewed — and the ORDER hazard
    // below (an unconditional @Catch() must be first) is exactly the kind of thing a silently-added
    // sixth filter can break.
    const call = mainTs.slice(mainTs.indexOf("useGlobalFilters("));
    const args = call.slice(0, call.indexOf(");") + 1);
    const registered = [...args.matchAll(/new (\w+)\(/g)].map((m) => m[1]);
    expect(registered).toEqual([
      // Order is asserted too: LastResortExceptionFilter FIRST (Nest reverses the array, so it is
      // checked LAST — see the next test for why that is load-bearing rather than cosmetic).
      "LastResortExceptionFilter",
      "HttpErrorFilter",
      "ProviderDispatchErrorFilter",
      "GatewayNotConfiguredErrorFilter",
      "GoogleOAuthErrorFilter",
      // Type-scoped filters' order relative to EACH OTHER does not matter (their @Catch types are
      // disjoint), so appending here is safe; what matters is that LastResortExceptionFilter stays
      // FIRST, which the next test pins independently.
      "ClientAccessErrorFilter",
    ]);
  });

  it("SM-58 · LastResortExceptionFilter is the FIRST argument, not merely present", () => {
    // Presence alone is not the AC here the way it is for the other three: this filter's `@Catch()`
    // matches every thrown value unconditionally, and Nest's RouterExceptionFilters reverses the
    // useGlobalFilters(...) argument list before resolving a match (last-resort-exception.filter.
    // test.ts proves this empirically against a real app). So if it were appended LAST instead of
    // FIRST, this same static includes()-style pin would still pass while the filter silently
    // shadowed HttpErrorFilter/ProviderDispatchErrorFilter/GatewayNotConfiguredErrorFilter for every
    // request in production — the exact "correct but unwired" failure mode this whole pin exists to
    // catch, just one level deeper (correct AND wired, but wired in the one position that breaks
    // everything else).
    const call = mainTs.slice(mainTs.indexOf("useGlobalFilters("));
    const args = call.slice(0, call.indexOf(");") + 1);
    const firstArgStart = args.indexOf("new ");
    expect(args.slice(firstArgStart, firstArgStart + "new LastResortExceptionFilter(".length)).toBe(
      "new LastResortExceptionFilter(",
    );
  });
});
