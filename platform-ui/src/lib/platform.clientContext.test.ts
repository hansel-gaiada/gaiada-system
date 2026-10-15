// DW-7h (FRONTEND-BFF-CONTRACT §52.2, §52.4): platformFetch tells platform-nest who is really calling, and turns IT's
// sign-out refusal into a redirect to /auth/ended while staying a PlatformError for callers that catch it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isRedirectError } from "next/dist/client/components/redirect-error";

let incoming: Record<string, string> | null = null;
vi.mock("next/headers", () => ({
  // No request context (a test, a build): Next's headers() throws. getSession's cookies() too, which keeps the dev path.
  headers: async () => {
    if (!incoming) throw new Error("headers() was called outside a request scope");
    const h = new Headers(incoming);
    return { get: (n: string) => h.get(n) };
  },
  cookies: async () => { throw new Error("cookies() was called outside a request scope"); },
}));

import { platformFetch, platformUpload, PlatformError, CLIENT_UA_MAX } from "./platform";
import { SESSION_ENDED_PATH, SESSION_REVOKED_MESSAGE, isSessionEnded } from "./sessionEnded";

const ok = () => vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
const sentHeaders = (fetchMock: ReturnType<typeof vi.fn>) =>
  ((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers ?? {}) as Record<string, string>;

beforeEach(() => {
  process.env.PLATFORM_URL = "http://platform.test";
  process.env.PLATFORM_SERVICE_TOKEN = "svc-tok";
  incoming = null;
});
afterEach(() => vi.unstubAllGlobals());

describe("platformFetch — the client's address and browser (§52.2)", () => {
  it("forwards nginx's X-Real-IP and the user agent", async () => {
    incoming = { "x-real-ip": "203.0.113.7", "x-forwarded-for": "6.6.6.6, 198.51.100.1", "user-agent": "Mozilla/5.0 Firefox" };
    const f = ok();
    vi.stubGlobal("fetch", f);
    await platformFetch("/api/me", "u-1");
    expect(sentHeaders(f)["x-gaiada-client-ip"]).toBe("203.0.113.7");
    expect(sentHeaders(f)["x-gaiada-client-ua"]).toBe("Mozilla/5.0 Firefox");
  });

  it("falls back to the RIGHTMOST X-Forwarded-For entry, never the leftmost the client wrote", async () => {
    incoming = { "x-forwarded-for": "6.6.6.6, 198.51.100.1" };
    const f = ok();
    vi.stubGlobal("fetch", f);
    await platformFetch("/api/me", "u-1");
    expect(sentHeaders(f)["x-gaiada-client-ip"]).toBe("198.51.100.1");
    expect(sentHeaders(f)).not.toHaveProperty("x-gaiada-client-ua");
  });

  it("cuts the user agent to 512 characters", async () => {
    incoming = { "user-agent": "x".repeat(CLIENT_UA_MAX + 100) };
    const f = ok();
    vi.stubGlobal("fetch", f);
    await platformFetch("/api/me", "u-1");
    expect(sentHeaders(f)["x-gaiada-client-ua"]).toHaveLength(CLIENT_UA_MAX);
  });

  it("sends neither header when there is no request context", async () => {
    const f = ok();
    vi.stubGlobal("fetch", f);
    await platformFetch("/api/me", "u-1");
    expect(sentHeaders(f)).not.toHaveProperty("x-gaiada-client-ip");
    expect(sentHeaders(f)).not.toHaveProperty("x-gaiada-client-ua");
    expect(sentHeaders(f).authorization).toBe("Bearer svc-tok"); // the rest is unchanged
  });

  it("platformUpload forwards them too", async () => {
    incoming = { "x-real-ip": "203.0.113.9", "user-agent": "Safari" };
    const f = ok();
    vi.stubGlobal("fetch", f);
    await platformUpload("/api/x/upload", "u-1", new FormData());
    expect(sentHeaders(f)["x-gaiada-client-ip"]).toBe("203.0.113.9");
    expect(sentHeaders(f)["x-gaiada-client-ua"]).toBe("Safari");
  });
});

describe("platformFetch — a session IT ended (§52.4)", () => {
  const respond = (status: number, body: unknown) =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

  it("a 401 session_revoked is a PlatformError AND a Next redirect to /auth/ended", async () => {
    respond(401, { error: SESSION_REVOKED_MESSAGE, reason: "session_revoked" });
    const err = await platformFetch("/api/x", "u-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect(err).toMatchObject({ status: 401, reason: "session_revoked", message: SESSION_REVOKED_MESSAGE });
    expect(isRedirectError(err)).toBe(true);
    expect((err as { digest: string }).digest).toContain(SESSION_ENDED_PATH);
    expect(isSessionEnded(err)).toBe(true);
  });

  it("platformUpload does the same", async () => {
    respond(401, { error: SESSION_REVOKED_MESSAGE, reason: "session_revoked" });
    const err = await platformUpload("/api/x/upload", "u-1", new FormData()).catch((e: unknown) => e);
    expect(isRedirectError(err)).toBe(true);
  });

  it("leaves every other 401, and a 403 with a reason, a plain PlatformError", async () => {
    respond(401, { error: "session revoked — re-authenticate" });
    const plain = await platformFetch("/api/x", "u-1").catch((e: unknown) => e);
    expect(plain).toBeInstanceOf(PlatformError);
    expect(isRedirectError(plain)).toBe(false);
    expect(isSessionEnded(plain)).toBe(false);

    respond(403, { error: "Access from this network address is blocked for this company.", reason: "ip_blocked" });
    const blocked = await platformFetch("/api/x", "u-1").catch((e: unknown) => e);
    expect(blocked).toMatchObject({ status: 403, reason: "ip_blocked" });
    expect(isRedirectError(blocked)).toBe(false);
  });
});
