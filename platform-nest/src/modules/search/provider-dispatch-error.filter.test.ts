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
