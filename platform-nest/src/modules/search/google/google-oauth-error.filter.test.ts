// SM-25a — pins the GoogleSurfaceError → HTTP mapping, mirroring provider-dispatch-error.filter.test.ts
// (SM-53) and gateway-not-configured-error.filter.test.ts (SM-57).
//
// WHY THIS FILE EXISTS AT ALL: twice now this module has thrown a plain `Error` from a service layer,
// which `HttpErrorFilter` (`@Catch(HttpException)`) never sees, so Nest's default handler produced a
// MESSAGE-LESS 500 and discarded the actionable content. SM-58 added the app-wide
// `LastResortExceptionFilter` floor — but a floor is not a mapping: it cannot know that "Google OAuth is
// not configured" is a 503 deployment state while "this callback does not verify" is a 400.
//
// The REGISTRATION half (that main.ts actually wires this filter, in the right position) is pinned in
// provider-dispatch-error.filter.test.ts, deliberately in the same place as the other four rather than
// in a private pin here — a separate pin could pass while the real useGlobalFilters call dropped one.
import { describe, it, expect } from "vitest";
import { GoogleOAuthErrorFilter } from "./google-oauth-error.filter";
import {
  GoogleApiError,
  GoogleConnectionNotLinkedError,
  GoogleOAuthNotConfiguredError,
  GoogleOAuthStateError,
  GoogleSurfaceError,
  GoogleTokenEndpointError,
} from "./errors";

function capture(err: GoogleSurfaceError): { status: number; body: Record<string, unknown> } {
  let status = 0;
  let body: unknown;
  const reply = {
    status(s: number) {
      status = s;
      return this;
    },
    send(b: unknown) {
      body = b;
      return this;
    },
  };
  const host = { switchToHttp: () => ({ getResponse: () => reply }) };
  new GoogleOAuthErrorFilter().catch(err, host as never);
  return { status, body: body as Record<string, unknown> };
}

describe("SM-25a · GoogleSurfaceError maps to honest HTTP, never to a bare 500", () => {
  it("FAIL-CLOSED: an unconfigured OAuth client is 503 with a code and the env vars to set", () => {
    const { status, body } = capture(new GoogleOAuthNotConfiguredError(["GOOGLE_OAUTH_CLIENT_ID"]));
    expect(status).toBe(503);
    expect(body.code).toBe("google_oauth_not_configured");
    // The actionable half — the whole reason a mapping beats the last-resort floor.
    expect(String(body.error)).toContain("GOOGLE_OAUTH_CLIENT_ID");
    expect((body.detail as { missing: string[] }).missing).toEqual(["GOOGLE_OAUTH_CLIENT_ID"]);
  });

  it("a failed callback is 400 with a COARSE message — the specific reason never reaches the caller", () => {
    const { status, body } = capture(new GoogleOAuthStateError("principal_mismatch"));
    expect(status).toBe(400);
    expect(body.code).toBe("google_oauth_invalid_state");
    // Deliberately says nothing about WHY. Distinguishing "unknown state" from "expired" from "wrong
    // user" on a redirect endpoint is a free oracle for someone probing the callback.
    expect(String(body.error)).not.toContain("principal");
    expect(String(body.error)).toMatch(/could not be verified/i);
    // The reason IS carried, for the server's own logs/tracing.
    expect((body.detail as { reason: string }).reason).toBe("principal_mismatch");
  });

  it("every state-failure reason produces the SAME status and the SAME client-facing message", () => {
    const reasons = [
      "malformed_state", "bad_signature", "unknown_or_expired", "already_consumed",
      "redirect_uri_mismatch", "principal_mismatch", "provider_mismatch", "issuer_error",
    ] as const;
    const seen = new Set<string>();
    for (const r of reasons) {
      const { status, body } = capture(new GoogleOAuthStateError(r));
      expect(status).toBe(400);
      seen.add(String(body.error));
    }
    // ONE message across all eight — if a future edit made any reason distinguishable by its message,
    // this set would grow and this test would fail. That is the oracle-closure property, pinned.
    expect(seen.size).toBe(1);
  });

  it("an issuer refusal is 502 (upstream), carrying the operation and the OAuth error code", () => {
    const { status, body } = capture(new GoogleTokenEndpointError("exchange", 400, "invalid_grant"));
    expect(status).toBe(502);
    expect(body.code).toBe("google_token_endpoint_error");
    expect(body.detail).toMatchObject({ operation: "exchange", httpStatus: 400, oauthError: "invalid_grant" });
  });

  it("an API refusal is 502 and carries the surface + status (so 429 is distinguishable from 403)", () => {
    const { status, body } = capture(new GoogleApiError("search_console", 429));
    expect(status).toBe(502);
    expect(body.detail).toMatchObject({ surface: "search_console", httpStatus: 429 });
  });

  it("an unusable connection is 409 — the wrong STATE, fixed by a human re-link, not by a retry", () => {
    for (const why of ["no_access_token", "no_refresh_token", "revoked", "not_found", "grant_invalid"] as const) {
      const { status, body } = capture(new GoogleConnectionNotLinkedError("conn-1", why));
      expect(status).toBe(409);
      expect(body.code).toBe("google_connection_not_linked");
      expect(String(body.error)).toMatch(/re-link/);
    }
  });

  it("no error in the family carries token material, a client secret, or a code_verifier", () => {
    // A blunt sweep over every constructible error: the serialized body must never contain anything
    // that looks like a credential. The constructors are the single place that decides what is safe to
    // expose, so this is the assertion that keeps that decision honest.
    const errs: GoogleSurfaceError[] = [
      new GoogleOAuthNotConfiguredError(["GOOGLE_OAUTH_CLIENT_SECRET"]),
      new GoogleOAuthStateError("bad_signature"),
      new GoogleTokenEndpointError("refresh", 400, "invalid_grant"),
      new GoogleApiError("ads", 403, "some upstream text"),
      new GoogleConnectionNotLinkedError("conn-1", "grant_invalid"),
    ];
    for (const e of errs) {
      const serialized = JSON.stringify(capture(e));
      expect(serialized).not.toMatch(/code_verifier/);
      expect(serialized).not.toMatch(/refresh_token=/);
      expect(serialized).not.toMatch(/client_secret/);
      expect(serialized).not.toMatch(/Bearer /);
    }
    // Note the ONE permitted mention: the not-configured error names the ENV VAR
    // `GOOGLE_OAUTH_CLIENT_SECRET` (a variable name, never a value), because telling an operator which
    // switch is unset is the entire point of a 503 here.
    expect(JSON.stringify(capture(new GoogleOAuthNotConfiguredError(["GOOGLE_OAUTH_CLIENT_SECRET"])))).toContain(
      "GOOGLE_OAUTH_CLIENT_SECRET",
    );
  });

  it("every error in the family declares a status and a code — a new one cannot be unmapped", () => {
    // Structural: GoogleSurfaceError's constructor REQUIRES both, so this asserts the shape the filter
    // depends on rather than a list of known subclasses (a list would go stale silently).
    const e = new GoogleApiError("analytics_data", 500);
    expect(e).toBeInstanceOf(GoogleSurfaceError);
    expect(typeof e.status).toBe("number");
    expect(typeof e.code).toBe("string");
    expect(e.code.length).toBeGreaterThan(0);
  });
});
