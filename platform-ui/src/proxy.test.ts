// Proxy routing decisions (finding 01, 2026-09-08; `proxy.ts` is Next 16's name for `middleware.ts`).
//
// This file runs on EVERY request in the app. Its two failure modes are asymmetric and both are
// bad in ways that do not look like errors:
//   * refreshing too little -> finding 01 comes straight back (silent hourly breakage, no logs)
//   * refreshing too eagerly -> redirect loops, torn SSE streams, JSON callers handed HTML
// Neither throws. So the exemptions and the GET-only rule are pinned here rather than trusted.
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { proxy, config } from "./proxy";
import { PATHNAME_HEADER, SEARCH_HEADER } from "./lib/pathnameHeader";
import { sealSession, encodeSession } from "./lib/session";
import { cookieName, HOST_COOKIES } from "./lib/cookieNames";

beforeAll(() => {
  process.env.SESSION_SECRET ??= "test-secret-for-middleware-specs";
});

const oidcCookie = (expiresAt: number) =>
  sealSession(encodeSession({ mode: "oidc", userId: "u1", accessToken: "at", refreshToken: "rt", expiresAt }));
const devCookie = () => sealSession(encodeSession({ mode: "dev", userId: "u1" }));

function req(path: string, opts: { cookie?: string; method?: string; headers?: Record<string, string> } = {}) {
  const r = new NextRequest(new URL(`https://erp.example${path}`), { method: opts.method ?? "GET", headers: opts.headers });
  // The wire name, resolved the way the app resolves it (`__Host-` only in production).
  if (opts.cookie) r.cookies.set(cookieName(HOST_COOKIES.session), opts.cookie);
  return r;
}
const location = (res: Response) => res.headers.get("location") ?? "";

const EXPIRED = Date.now() - 60_000;
const FRESH = Date.now() + 60 * 60_000;

describe("proxy — token refresh handoff", () => {
  it("redirects an expired session to /auth/refresh, preserving the deep link", () => {
    const res = proxy(req("/approvals/abc-123", { cookie: oidcCookie(EXPIRED) }));
    expect(location(res)).toContain("/auth/refresh");
    // Losing the return target would dump the user on the home page every hour — technically
    // "logged in", practically a worse bug than the one being fixed.
    expect(decodeURIComponent(location(res))).toContain("return=/approvals/abc-123");
  });

  it("leaves a fresh session completely alone", () => {
    const res = proxy(req("/approvals/abc-123", { cookie: oidcCookie(FRESH) }));
    expect(location(res)).toBe("");
  });

  it("never redirects a DEV-mode session — there is no token to refresh", () => {
    // Local stacks and the whole test suite run on dev sessions. Redirecting them would send every
    // developer through a refresh route that clears their cookie.
    const res = proxy(req("/approvals/abc-123", { cookie: devCookie() }));
    expect(location(res)).toBe("");
  });

  it("does not redirect non-GET — a 307 replays the body", () => {
    // A Server Action POST re-sent to /auth/refresh would replay the user's write at a route that
    // is not expecting it. Writes ride the existing token instead; the skew window covers them.
    const res = proxy(req("/approvals/abc-123", { cookie: oidcCookie(EXPIRED), method: "POST" }));
    expect(location(res)).toBe("");
  });

  describe("exemptions", () => {
    it("/auth/* is exempt — redirecting the refresh route to itself is an infinite loop", () => {
      expect(location(proxy(req("/auth/refresh", { cookie: oidcCookie(EXPIRED) })))).toBe("");
      expect(location(proxy(req("/auth/callback", { cookie: oidcCookie(EXPIRED) })))).toBe("");
    });

    it("/api/* is exempt — those answer JSON and SSE, not redirects", () => {
      // A client fetch() would try to parse a redirect as JSON; the portal and assistant SSE
      // streams would be torn off mid-flight.
      expect(location(proxy(req("/api/portal/stream", { cookie: oidcCookie(EXPIRED) })))).toBe("");
      expect(location(proxy(req("/api/assistant/threads/t1/stream", { cookie: oidcCookie(EXPIRED) })))).toBe("");
    });

    it("/print is exempt — the report-renderer must never reach a login page", () => {
      expect(location(proxy(req("/print/report-1", { cookie: oidcCookie(EXPIRED) })))).toBe("");
    });
  });

  it("a malformed cookie does not throw and does not redirect", () => {
    // Middleware throwing is every page down, so unreadable must degrade to "do nothing".
    expect(() => proxy(req("/dashboard", { cookie: "garbage.not-a-session" }))).not.toThrow();
    expect(location(proxy(req("/dashboard", { cookie: "garbage.not-a-session" })))).toBe("");
  });
});

describe("proxy — the pre-existing session gate still holds", () => {
  it("no session on a private route still goes to /login", () => {
    expect(location(proxy(req("/dashboard")))).toContain("/login");
  });

  it("public routes stay reachable without a session", () => {
    for (const p of ["/login", "/auth/login", "/step-up", "/print/x", "/invite/abc", "/contributor-invite/ctr1.abc"]) {
      expect(location(proxy(req(p))), p).toBe("");
    }
  });

  it("M5-W1f: only the contributor INVITE page is public; the contributor shell stays behind the session check", () => {
    // The segment is matched whole, so a path that merely starts with the same letters, or the shell itself, never becomes public.
    for (const p of ["/contributor", "/contributor/items/t/s/c/x", "/contributor-invitefoo/x", "/contributors"]) {
      expect(location(proxy(req(p))), p).toContain("/login");
    }
  });
});

// ── B0: `__Host-` session cookie ─────────────────────────────────────────────────────────────────
describe("proxy — production reads only the __Host- session cookie", () => {
  afterEach(() => vi.unstubAllEnvs());

  function prodReq(p: string, name: string, value: string) {
    const r = new NextRequest(new URL(`https://erp.example${p}`));
    r.cookies.set(name, value);
    return r;
  }

  it("a __Host-gaiada_session counts as a session", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(location(proxy(prodReq("/dashboard", "__Host-gaiada_session", oidcCookie(FRESH))))).toBe("");
  });

  it("a bare gaiada_session does NOT — that is what a sibling subdomain can toss in", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(location(proxy(prodReq("/dashboard", "gaiada_session", oidcCookie(FRESH))))).toContain("/login");
  });

  it("the refresh handoff reads the prefixed cookie too", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(location(proxy(prodReq("/dashboard", "__Host-gaiada_session", oidcCookie(EXPIRED))))).toContain("/auth/refresh");
  });
});

// ── B0: Origin allow-list on state-changing requests ─────────────────────────────────────────────
describe("proxy — origin check on writes", () => {
  afterEach(() => vi.unstubAllEnvs());

  async function expectRefused(res: Response) {
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "origin_not_allowed" });
    // No side effect: not a redirect, not a pass-through.
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("x-middleware-next")).toBeNull();
  }

  it("refuses a Server Action POST from a sibling subdomain, before the session gate", async () => {
    vi.stubEnv("PUBLIC_ORIGIN", "https://erp.example");
    await expectRefused(proxy(req("/approvals/abc", {
      method: "POST", cookie: oidcCookie(FRESH),
      headers: { origin: "https://staging.example", "next-action": "abc123" },
    })));
    // ...and with no session too: refused, not redirected to /login.
    await expectRefused(proxy(req("/approvals/abc", { method: "POST", headers: { origin: "https://staging.example" } })));
  });

  it("refuses foreign writes to every app/api route handler", async () => {
    vi.stubEnv("PUBLIC_ORIGIN", "https://erp.example");
    for (const p of ["/api/admin/bot/actions/approve", "/api/admin/bot/digests/run/morning", "/api/meetings/m1/audio"]) {
      await expectRefused(proxy(req(p, { method: "POST", cookie: oidcCookie(FRESH), headers: { origin: "https://evil.example" } })));
    }
    await expectRefused(proxy(req("/api/x", { method: "DELETE", headers: { "sec-fetch-site": "same-site" } })));
  });

  it("refuses Origin: null", async () => {
    vi.stubEnv("PUBLIC_ORIGIN", "https://erp.example");
    await expectRefused(proxy(req("/approvals", { method: "POST", headers: { origin: "null" } })));
  });

  it("lets the ERP's own origin through, untouched", () => {
    vi.stubEnv("PUBLIC_ORIGIN", "https://erp.example");
    const res = proxy(req("/approvals/abc", { method: "POST", cookie: oidcCookie(FRESH), headers: { origin: "https://erp.example" } }));
    expect(res.status).toBe(200);
    expect(location(res)).toBe("");
  });

  it("ALLOWED_ORIGINS overrides PUBLIC_ORIGIN (both names during the cut-over)", async () => {
    vi.stubEnv("PUBLIC_ORIGIN", "https://erp.example");
    vi.stubEnv("ALLOWED_ORIGINS", "https://erp.gaiada.com,https://erp.gaiada.online");
    expect(proxy(req("/x", { method: "POST", cookie: oidcCookie(FRESH), headers: { origin: "https://erp.gaiada.online" } })).status).toBe(200);
    await expectRefused(proxy(req("/x", { method: "POST", cookie: oidcCookie(FRESH), headers: { origin: "https://erp.example" } })));
  });

  it("with nothing configured (next dev / e2e) the request's own origin is allowed", async () => {
    vi.stubEnv("PUBLIC_ORIGIN", "");
    vi.stubEnv("ALLOWED_ORIGINS", "");
    expect(proxy(req("/x", { method: "POST", cookie: oidcCookie(FRESH), headers: { origin: "https://erp.example" } })).status).toBe(200);
    await expectRefused(proxy(req("/x", { method: "POST", headers: { origin: "https://evil.example" } })));
  });

  it("a non-browser client (no Origin, no Sec-Fetch-Site) is not refused", () => {
    vi.stubEnv("PUBLIC_ORIGIN", "https://erp.example");
    expect(proxy(req("/api/meetings/m1/audio", { method: "POST", cookie: oidcCookie(FRESH) })).status).toBe(200);
  });

  it("GETs are never origin-checked (a cross-site link must still open the ERP)", () => {
    vi.stubEnv("PUBLIC_ORIGIN", "https://erp.example");
    const res = proxy(req("/approvals/abc", { cookie: oidcCookie(FRESH), headers: { "sec-fetch-site": "cross-site" } }));
    expect(res.status).toBe(200);
  });
});

// ── B0: the matcher is what puts every write in front of the origin check ────────────────────────
// Uses Next's own matcher compiler (the one the build uses), not a re-implementation.
describe("proxy matcher", () => {
  const matches = (url: string) => unstable_doesMiddlewareMatch({ config, url });

  it("covers Server Action targets (page paths) and every app/api route handler", () => {
    for (const p of [
      "/", "/approvals/abc", "/login", "/auth/callback", "/portal/company", "/office", "/office-lab",
      "/api/admin/bot/actions/approve", "/api/admin/bot/digests/run/morning", "/api/meetings/m1/audio",
      "/api/search/google/callback", "/print/r1", "/invite/t",
    ]) {
      expect(matches(p), p).toBe(true);
    }
  });

  it("skips only static assets", () => {
    for (const p of ["/_next/static/chunks/a.js", "/fonts/inter.woff2", "/office-sprites/a.png", "/office-env/x.png", "/office-chars/c.png", "/favicon.ico"]) {
      expect(matches(p), p).toBe(false);
    }
  });

  it("every top-level route in src/app is matched (a route under an excluded prefix would skip the origin check)", () => {
    const APP = path.resolve(__dirname, "app");
    const segments: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (!statSync(path.join(dir, name)).isDirectory()) continue;
        if (name.startsWith("(") && name.endsWith(")")) walk(path.join(dir, name)); // route group: transparent
        else if (!name.startsWith("_") && !name.startsWith("@")) segments.push(name); // private/parallel: not URL segments
      }
    };
    walk(APP);
    expect(segments.length).toBeGreaterThan(10);
    for (const seg of segments) {
      const p = `/${seg.replace(/^\[+\.{0,3}|\]+$/g, "") || "x"}/anything`;
      expect(matches(p), p).toBe(true);
    }
  });
});

describe("proxy — the pathname request header (DW-3a2)", () => {
  // NextResponse.next({ request: { headers } }) reports the forwarded request headers on the response as
  // `x-middleware-request-<name>` (and lists them in `x-middleware-override-headers`).
  const forwarded = (res: Response) => res.headers.get(`x-middleware-request-${PATHNAME_HEADER}`);
  afterEach(() => vi.unstubAllEnvs());

  it("hands the request's pathname to the server, without the query", () => {
    const res = proxy(req("/", { cookie: devCookie() }));
    expect(forwarded(res)).toBe("/");
    expect(forwarded(proxy(req("/projects?x=1", { cookie: devCookie() })))).toBe("/projects");
  });

  it("overwrites a client-sent value, so it can never be spoofed", () => {
    const res = proxy(req("/projects", { cookie: devCookie(), headers: { [PATHNAME_HEADER]: "/" } }));
    expect(forwarded(res)).toBe("/projects");
  });

  it("keeps the other request headers", () => {
    const res = proxy(req("/", { cookie: devCookie(), headers: { "x-keep": "yes" } }));
    expect(res.headers.get("x-middleware-request-x-keep")).toBe("yes");
  });

  // A layout redirect thrown while a Server Action or an RSC fetch re-renders never reaches the browser (a Server Action on `/`
  // left the old page on screen), so only a document request carries the header.
  it("withholds it from the client router's RSC fetches and prefetches, and strips a client-sent copy", () => {
    expect(forwarded(proxy(req("/", { cookie: devCookie(), headers: { rsc: "1" } })))).toBeNull();
    expect(forwarded(proxy(req("/", { cookie: devCookie(), headers: { rsc: "1", "next-router-prefetch": "1" } })))).toBeNull();
    expect(forwarded(proxy(req("/", { cookie: devCookie(), headers: { rsc: "1", [PATHNAME_HEADER]: "/" } })))).toBeNull();
  });

  it("withholds it from a Server Action", () => {
    vi.stubEnv("PUBLIC_ORIGIN", "https://erp.example");
    const res = proxy(req("/", { method: "POST", cookie: devCookie(), headers: { origin: "https://erp.example", "next-action": "abc123" } }));
    expect(res.status).not.toBe(403);
    expect(forwarded(res)).toBeNull();
  });
});

describe("proxy — the deep link survives sign-in (SCP-2: /portal/social?post=<id>)", () => {
  const forwardedSearch = (res: Response) => res.headers.get(`x-middleware-request-${SEARCH_HEADER}`);

  it("a visitor with NO session cookie is sent to /login with the whole link, query included", () => {
    const res = proxy(req("/portal/social?post=soc-post-n-3"));
    expect(res.status).toBe(307);
    const to = new URL(location(res), "https://erp.example");
    expect(to.pathname).toBe("/login");
    expect(to.searchParams.get("return")).toBe("/portal/social?post=soc-post-n-3");
  });

  it("hands the query to the server on a document request, so a layout can send a stale cookie to /login with the link", () => {
    expect(forwardedSearch(proxy(req("/portal/social?post=p1&tab=grid", { cookie: devCookie() })))).toBe("?post=p1&tab=grid");
    expect(forwardedSearch(proxy(req("/portal/social", { cookie: devCookie() })))).toBe("");
  });

  it("overwrites a client-sent value, and withholds it from RSC fetches", () => {
    expect(forwardedSearch(proxy(req("/portal/social?post=p1", { cookie: devCookie(), headers: { [SEARCH_HEADER]: "?evil=1" } })))).toBe("?post=p1");
    expect(forwardedSearch(proxy(req("/portal/social?post=p1", { cookie: devCookie(), headers: { rsc: "1", [SEARCH_HEADER]: "?evil=1" } })))).toBeNull();
  });
});
