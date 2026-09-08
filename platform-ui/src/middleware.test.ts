// Middleware routing decisions (finding 01, 2026-09-08).
//
// This file runs on EVERY request in the app. Its two failure modes are asymmetric and both are
// bad in ways that do not look like errors:
//   * refreshing too little -> finding 01 comes straight back (silent hourly breakage, no logs)
//   * refreshing too eagerly -> redirect loops, torn SSE streams, JSON callers handed HTML
// Neither throws. So the exemptions and the GET-only rule are pinned here rather than trusted.
import { describe, it, expect, beforeAll } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "./middleware";
import { sealSession, encodeSession } from "./lib/session";

beforeAll(() => {
  process.env.SESSION_SECRET ??= "test-secret-for-middleware-specs";
});

const oidcCookie = (expiresAt: number) =>
  sealSession(encodeSession({ mode: "oidc", userId: "u1", accessToken: "at", refreshToken: "rt", expiresAt }));
const devCookie = () => sealSession(encodeSession({ mode: "dev", userId: "u1" }));

function req(path: string, opts: { cookie?: string; method?: string } = {}) {
  const r = new NextRequest(new URL(`https://erp.example${path}`), { method: opts.method ?? "GET" });
  if (opts.cookie) r.cookies.set("gaiada_session", opts.cookie);
  return r;
}
const location = (res: Response) => res.headers.get("location") ?? "";

const EXPIRED = Date.now() - 60_000;
const FRESH = Date.now() + 60 * 60_000;

describe("middleware — token refresh handoff", () => {
  it("redirects an expired session to /auth/refresh, preserving the deep link", () => {
    const res = middleware(req("/approvals/abc-123", { cookie: oidcCookie(EXPIRED) }));
    expect(location(res)).toContain("/auth/refresh");
    // Losing the return target would dump the user on the home page every hour — technically
    // "logged in", practically a worse bug than the one being fixed.
    expect(decodeURIComponent(location(res))).toContain("return=/approvals/abc-123");
  });

  it("leaves a fresh session completely alone", () => {
    const res = middleware(req("/approvals/abc-123", { cookie: oidcCookie(FRESH) }));
    expect(location(res)).toBe("");
  });

  it("never redirects a DEV-mode session — there is no token to refresh", () => {
    // Local stacks and the whole test suite run on dev sessions. Redirecting them would send every
    // developer through a refresh route that clears their cookie.
    const res = middleware(req("/approvals/abc-123", { cookie: devCookie() }));
    expect(location(res)).toBe("");
  });

  it("does not redirect non-GET — a 307 replays the body", () => {
    // A Server Action POST re-sent to /auth/refresh would replay the user's write at a route that
    // is not expecting it. Writes ride the existing token instead; the skew window covers them.
    const res = middleware(req("/approvals/abc-123", { cookie: oidcCookie(EXPIRED), method: "POST" }));
    expect(location(res)).toBe("");
  });

  describe("exemptions", () => {
    it("/auth/* is exempt — redirecting the refresh route to itself is an infinite loop", () => {
      expect(location(middleware(req("/auth/refresh", { cookie: oidcCookie(EXPIRED) })))).toBe("");
      expect(location(middleware(req("/auth/callback", { cookie: oidcCookie(EXPIRED) })))).toBe("");
    });

    it("/api/* is exempt — those answer JSON and SSE, not redirects", () => {
      // A client fetch() would try to parse a redirect as JSON; the portal and assistant SSE
      // streams would be torn off mid-flight.
      expect(location(middleware(req("/api/portal/stream", { cookie: oidcCookie(EXPIRED) })))).toBe("");
      expect(location(middleware(req("/api/assistant/threads/t1/stream", { cookie: oidcCookie(EXPIRED) })))).toBe("");
    });

    it("/print is exempt — the report-renderer must never reach a login page", () => {
      expect(location(middleware(req("/print/report-1", { cookie: oidcCookie(EXPIRED) })))).toBe("");
    });
  });

  it("a malformed cookie does not throw and does not redirect", () => {
    // Middleware throwing is every page down, so unreadable must degrade to "do nothing".
    expect(() => middleware(req("/dashboard", { cookie: "garbage.not-a-session" }))).not.toThrow();
    expect(location(middleware(req("/dashboard", { cookie: "garbage.not-a-session" })))).toBe("");
  });
});

describe("middleware — the pre-existing session gate still holds", () => {
  it("no session on a private route still goes to /login", () => {
    expect(location(middleware(req("/dashboard")))).toContain("/login");
  });

  it("public routes stay reachable without a session", () => {
    for (const p of ["/login", "/auth/login", "/step-up", "/print/x", "/invite/abc"]) {
      expect(location(middleware(req(p))), p).toBe("");
    }
  });
});
