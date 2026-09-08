// Pins the Edge-side expiry peek against the Node-side sealer (finding 01, 2026-09-08).
//
// THE TEST THAT ACTUALLY MATTERS is the round-trip one. `session.ts` encodes with `Buffer` under
// node:crypto; `session-expiry.ts` decodes with `atob` + `TextDecoder` because middleware runs on
// Edge and cannot load Buffer or node:crypto. Those are two independent implementations of the same
// wire format, written in different files, running in different runtimes.
//
// If they ever disagree, `peekSessionExpiry` returns null, `needsRefresh` returns false, and the
// refresh SILENTLY NEVER FIRES — restoring finding 01 exactly, with no error anywhere and every
// dashboard green. That is the failure this file exists to make loud.
import { describe, it, expect } from "vitest";
import { peekSessionExpiry, needsRefresh, REFRESH_SKEW_MS } from "./session-expiry";
import { sealSession, encodeSession } from "./session";

process.env.SESSION_SECRET ??= "test-secret-for-session-expiry-specs";

const sealOidc = (expiresAt: number, userId = "11111111-1111-4111-8111-111111111111") =>
  sealSession(encodeSession({ mode: "oidc", userId, accessToken: "at", refreshToken: "rt", expiresAt }));

describe("peekSessionExpiry — Edge decoder vs Node encoder", () => {
  it("reads back the exact expiry the Node sealer wrote (the round trip)", () => {
    const exp = 1_788_888_888_000;
    expect(peekSessionExpiry(sealOidc(exp))).toBe(exp);
  });

  it("survives payloads whose base64url needs padding — all four length residues", () => {
    // atob() throws on unpadded base64. The encoder emits base64url WITHOUT padding, so the decoder
    // has to re-add it. Varying the userId length walks the payload through every `length % 4` case;
    // get this wrong and the refresh works for some users and silently never fires for others.
    for (const pad of ["a", "aa", "aaa", "aaaa", "aaaaa", "aaaaaa", "aaaaaaa"]) {
      const exp = 1_700_000_000_000;
      expect(peekSessionExpiry(sealOidc(exp, pad)), `userId=${pad}`).toBe(exp);
    }
  });

  it("handles a token containing base64url's - and _ alphabet", () => {
    // Real JWTs are base64url and routinely contain - and _. The decoder maps them back to + and /
    // before atob; skipping that yields a throw, a null, and a refresh that never happens.
    const exp = 1_700_000_000_000;
    const sealed = sealSession(
      encodeSession({ mode: "oidc", userId: "u", accessToken: "ab-cd_ef.gh-ij_kl", refreshToken: "mn-op_qr", expiresAt: exp }),
    );
    expect(peekSessionExpiry(sealed)).toBe(exp);
  });

  it("returns null for a DEV-mode session — there is no token to refresh", () => {
    // A dev session's payload is a bare userId. Returning a number here would send local stacks and
    // the whole test suite into a refresh redirect for a token that does not exist.
    expect(peekSessionExpiry(sealSession(encodeSession({ mode: "dev", userId: "u1" })))).toBeNull();
  });

  it("returns null rather than throwing on anything malformed", () => {
    // Middleware calls this on every request. A throw here is every page down, so the contract is
    // "null means do nothing" for every unparseable shape.
    for (const bad of [undefined, "", ".", "nodot", "oidc:!!!not-base64!!!.sig", "oidc:.sig", "dev-payload.sig"]) {
      expect(() => peekSessionExpiry(bad as string | undefined)).not.toThrow();
      expect(peekSessionExpiry(bad as string | undefined)).toBeNull();
    }
  });

  it("returns null when the payload parses but carries no numeric expiry", () => {
    const b64 = Buffer.from(JSON.stringify({ u: "x", a: "y", r: "z" }), "utf8").toString("base64url");
    expect(peekSessionExpiry(`oidc:${b64}.sig`)).toBeNull();
  });
});

describe("needsRefresh", () => {
  const now = 1_700_000_000_000;

  it("null expiry NEVER triggers a refresh — unknown must not mean expired", () => {
    // The inverse would redirect every dev-mode and malformed-cookie request to /auth/refresh,
    // which clears the session — turning an unreadable cookie into a forced logout.
    expect(needsRefresh(null, now)).toBe(false);
  });

  it("refreshes once inside the skew window, not before", () => {
    expect(needsRefresh(now + REFRESH_SKEW_MS + 1_000, now)).toBe(false);
    expect(needsRefresh(now + REFRESH_SKEW_MS - 1_000, now)).toBe(true);
  });

  it("refreshes an already-expired token", () => {
    expect(needsRefresh(now - 1, now)).toBe(true);
    expect(needsRefresh(now - 3_600_000, now)).toBe(true);
  });

  it("the skew is a real margin, not decorative", () => {
    // A page render fans out several platformFetch calls; a token valid at middleware time can
    // expire mid-render. Zero skew would let exactly that through.
    expect(REFRESH_SKEW_MS).toBeGreaterThanOrEqual(60_000);
  });
});

// ── Absolute lifetime must survive a token refresh (finding 08 + finding 01 interaction) ────────
// Added after the finding-08 work: `encodeSession` stamps a fresh iat/exp whenever iat is absent,
// and `/auth/refresh` rebuilds the session object on every silent refresh — roughly hourly for an
// active user. If that route lets iat default, the 12h ABSOLUTE lifetime is restamped on every hop
// and is never once reached by anybody actually using the ERP. It would still expire idle and
// replayed sessions, so every test of `isSessionExpired` in isolation stays green while the control
// silently protects almost nobody.
describe("session lifetime survives a refresh (findings 01 + 08)", () => {
  it("carrying iat forward keeps the ORIGINAL expiry — renewing the access token is not renewing the session", async () => {
    const { encodeSession, decodeSession } = await import("./session");
    const signedInAt = Date.now() - 11 * 60 * 60 * 1000; // 11h ago, inside a 12h cap

    // What /auth/refresh does: rebuild the session with a NEW access token, passing iat through.
    const refreshed = decodeSession(
      encodeSession({
        mode: "oidc", userId: "u1", accessToken: "new-token", refreshToken: "rt",
        expiresAt: Date.now() + 3_600_000,
        iat: Math.floor(signedInAt / 1000),
      }),
    );
    expect(refreshed?.iat).toBe(Math.floor(signedInAt / 1000));

    // And the regression it guards: omitting iat restamps the clock to "now".
    const restamped = decodeSession(
      encodeSession({
        mode: "oidc", userId: "u1", accessToken: "new-token", refreshToken: "rt",
        expiresAt: Date.now() + 3_600_000,
      }),
    );
    expect(restamped?.iat).toBeGreaterThan(Math.floor(signedInAt / 1000));
  });
});
