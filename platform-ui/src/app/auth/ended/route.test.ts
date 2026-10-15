// DW-7h (FRONTEND-BFF-CONTRACT §52.4): where a session IT ended lands. It must remove the ERP session cookie (with the
// attributes that actually delete a __Host- cookie) and land on the sign-in page with the reason.
import { describe, it, expect, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "./route";

afterEach(() => vi.unstubAllEnvs());

describe("GET /auth/ended", () => {
  it("clears the session cookie and redirects to /login?reason=session_revoked", () => {
    const res = GET(new NextRequest("http://localhost/auth/ended"));
    expect(res.status).toBe(307);
    const to = new URL(res.headers.get("location")!);
    expect(to.pathname).toBe("/login");
    expect(to.searchParams.get("reason")).toBe("session_revoked");
    const cookie = res.cookies.get("gaiada_session");
    expect(cookie?.value).toBe("");
    expect(cookie?.maxAge).toBe(0);
    expect(cookie?.path).toBe("/");
  });

  it("signs out on a same-origin navigation (the platformFetch redirect) and on a typed URL", () => {
    for (const site of ["same-origin", "none"]) {
      const res = GET(new NextRequest("http://localhost/auth/ended", { headers: { "sec-fetch-site": site } }));
      expect(new URL(res.headers.get("location")!).pathname, site).toBe("/login");
      expect(res.cookies.get("gaiada_session")?.maxAge, site).toBe(0);
    }
  });

  it("keeps the session when another site links here, and only lands on the home page", () => {
    for (const site of ["cross-site", "same-site"]) {
      const res = GET(new NextRequest("http://localhost/auth/ended", { headers: { "sec-fetch-site": site } }));
      expect(new URL(res.headers.get("location")!).pathname, site).toBe("/");
      expect(res.cookies.get("gaiada_session"), site).toBeUndefined();
    }
  });

  it("clears the __Host- cookie in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = GET(new NextRequest("https://erp.example.test/auth/ended"));
    const cookie = res.cookies.get("__Host-gaiada_session");
    expect(cookie?.maxAge).toBe(0);
    expect(cookie?.secure).toBe(true);
  });
});
