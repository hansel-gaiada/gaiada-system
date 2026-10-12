// B0 sweep: the silent refresh re-stamped the session cookie WITHOUT a maxAge, turning it into a browser-session
// cookie. It must carry the session's REMAINING absolute lifetime (anchored to the original sign-in), never a
// fresh 12h and never none.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const getSession = vi.fn();
vi.mock("@/lib/session-server", () => ({ getSession: () => getSession() }));

import { GET } from "./route";
import { SESSION_TTL_SECONDS } from "@/lib/session";

const HOUR = 3_600_000;

describe("GET /auth/refresh — the re-stamped cookie keeps the remaining lifetime", () => {
  beforeEach(() => {
    vi.stubEnv("SESSION_SECRET", "test-secret-test-secret-test-secret-32");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ access_token: "a2", refresh_token: "r2", expires_in: 300 })));
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("a session signed in 2h ago gets ~10h, not a browser-session cookie and not a fresh 12h", async () => {
    const iat = Date.now() - 2 * HOUR;
    getSession.mockResolvedValue({ mode: "oidc", userId: "u1", accessToken: "a", refreshToken: "r", expiresAt: 0, iat, exp: iat + SESSION_TTL_SECONDS * 1000 });
    const res = await GET(new NextRequest("http://localhost/auth/refresh?return=/"));
    expect(res.headers.get("x-gaiada-refresh")).toBe("ok");
    const cookie = res.cookies.getAll().find((c) => c.name.endsWith("gaiada_session"));
    expect(cookie?.value).toBeTruthy();
    expect(cookie?.maxAge).toBeGreaterThan(10 * 3600 - 60);
    expect(cookie?.maxAge).toBeLessThanOrEqual(10 * 3600);
  });

  it("a legacy session without exp falls back to iat + 12h", async () => {
    const iat = Date.now() - 11 * HOUR;
    getSession.mockResolvedValue({ mode: "oidc", userId: "u1", accessToken: "a", refreshToken: "r", expiresAt: 0, iat });
    const res = await GET(new NextRequest("http://localhost/auth/refresh?return=/"));
    const cookie = res.cookies.getAll().find((c) => c.name.endsWith("gaiada_session"));
    expect(cookie?.maxAge).toBeGreaterThan(3600 - 60);
    expect(cookie?.maxAge).toBeLessThanOrEqual(3600);
  });
});
