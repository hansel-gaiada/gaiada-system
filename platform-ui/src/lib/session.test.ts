import { describe, it, expect, beforeAll } from "vitest";
import { sealSession, openSession, encodeSession, decodeSession, isSessionExpired, SESSION_TTL_SECONDS } from "./session";
// Cross-check against the Edge reader (fault register finding 01's module). It is NOT owned by
// this change and must not need editing — importing it here is exactly how we prove the new
// payload shape still round-trips through it (see the "Edge reader" describe block below).
import { peekSessionExpiry } from "./session-expiry";

beforeAll(() => { process.env.SESSION_SECRET = "test-secret"; });

describe("session sealing", () => {
  it("round-trips a userId", () => {
    const sealed = sealSession("user-123");
    expect(openSession(sealed)).toBe("user-123");
  });
  it("rejects tampered values", () => {
    const sealed = sealSession("user-123");
    expect(openSession(sealed.replace("user-123", "user-666"))).toBeNull();
    expect(openSession("garbage")).toBeNull();
  });
});

// Fault register finding 08 (2026-09-08): the session cookie never expired. These pin the fix —
// a real signed iat/exp inside the payload, verified server-side, not just a cookie attribute.
describe("session absolute lifetime (finding 08)", () => {
  it("encodeSession stamps a fresh dev session with iat/exp when none is given", () => {
    const before = Date.now();
    const sealed = sealSession(encodeSession({ mode: "dev", userId: "u1" }));
    const decoded = decodeSession(openSession(sealed)!);
    expect(decoded?.mode).toBe("dev");
    expect(decoded?.userId).toBe("u1");
    expect(decoded?.iat).toBeGreaterThanOrEqual(before);
    expect(decoded?.exp).toBe((decoded?.iat ?? 0) + SESSION_TTL_SECONDS * 1000);
  });

  it("encodeSession stamps a fresh oidc session with iat/exp without disturbing the access-token fields", () => {
    const sealed = sealSession(
      encodeSession({ mode: "oidc", userId: "u1", accessToken: "at", refreshToken: "rt", expiresAt: 12345 }),
    );
    const decoded = decodeSession(openSession(sealed)!);
    expect(decoded).toMatchObject({ mode: "oidc", userId: "u1", accessToken: "at", refreshToken: "rt", expiresAt: 12345 });
    expect(typeof decoded?.iat).toBe("number");
    expect(typeof decoded?.exp).toBe("number");
  });

  it("a dev session still opens when its exp is in the future", () => {
    const notExpired = { mode: "dev" as const, userId: "u1", iat: Date.now() - 1000, exp: Date.now() + 60_000 };
    const sealed = sealSession(encodeSession(notExpired));
    const decoded = decodeSession(openSession(sealed)!);
    expect(decoded).not.toBeNull();
    expect(isSessionExpired(decoded!)).toBe(false);
  });

  it("an expired payload is rejected by isSessionExpired", () => {
    const expired = { mode: "dev" as const, userId: "u1", iat: Date.now() - 100_000, exp: Date.now() - 1_000 };
    const sealed = sealSession(encodeSession(expired));
    const decoded = decodeSession(openSession(sealed)!);
    expect(decoded).not.toBeNull(); // signature is still valid — the payload isn't tampered
    expect(isSessionExpired(decoded!)).toBe(true); // but its own absolute lifetime has passed
  });

  it("a tampered iat/exp payload fails signature verification, not just the exp check", () => {
    const sealed = sealSession(encodeSession({ mode: "dev", userId: "u1", iat: Date.now(), exp: Date.now() + 60_000 }));
    // Flip a character inside the base64url envelope (well past the "dev:" prefix) — this is the
    // signed payload, so any edit must be caught by the HMAC before exp is ever consulted.
    const tampered = sealed.slice(0, 8) + (sealed[8] === "a" ? "b" : "a") + sealed.slice(9);
    expect(openSession(tampered)).toBeNull();
  });

  it("a session with no exp at all (the legacy bare-userId dev shape) is never treated as expired", () => {
    // app/auth/magic/route.ts mints exactly this shape and is out of scope for this change — it
    // must keep working, which means "no exp field" must mean "not covered", never "expired".
    const legacy = decodeSession(openSession(sealSession("legacy-user-id"))!);
    expect(legacy).toEqual({ mode: "dev", userId: "legacy-user-id" });
    expect(isSessionExpired(legacy!)).toBe(false);
  });

  it("Edge reader (session-expiry.ts) still reads the access-token expiry out of the new payload", () => {
    // The new payload carries an extra iat/exp pair the Edge reader has never heard of; it must
    // keep reading `e` (the access token's own expiry) exactly as before, ignoring the rest.
    const sealed = sealSession(
      encodeSession({ mode: "oidc", userId: "u1", accessToken: "at", refreshToken: "rt", expiresAt: 999_999 }),
    );
    expect(peekSessionExpiry(sealed)).toBe(999_999);
  });

  it("Edge reader still returns null for a dev session, new envelope shape included", () => {
    const sealed = sealSession(encodeSession({ mode: "dev", userId: "u1" }));
    expect(peekSessionExpiry(sealed)).toBeNull();
  });
});
