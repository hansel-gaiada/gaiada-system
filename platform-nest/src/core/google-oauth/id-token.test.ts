// DW-6i — the ID-token claim checks (id-token.ts). Pure: no database, no network. Fixtures follow Google's documented ID token
// claims (https://developers.google.com/identity/openid-connect/openid-connect): iss, aud, sub, email, email_verified, exp.
import { describe, it, expect } from "vitest";
import { IdTokenError, readGoogleIdentity } from "./id-token";

const CLIENT = "123-abc.apps.googleusercontent.com";
const NOW = Date.parse("2026-10-14T10:00:00Z");
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload: Record<string, unknown>) => `${b64({ alg: "RS256", typ: "JWT" })}.${b64(payload)}.c2ln`;
const good = (over: Record<string, unknown> = {}) => ({
  iss: "https://accounts.google.com", aud: CLIENT, sub: "110169484474386276334", email: "Dana@Example.test", email_verified: true,
  exp: Math.floor(NOW / 1000) + 3600, ...over,
});
const reason = (fn: () => unknown): string | null => {
  try { fn(); return null; } catch (e) { return e instanceof IdTokenError ? e.reason : "other"; }
};

describe("readGoogleIdentity (DW-6i)", () => {
  it("reads sub and a lower-cased email from a token for our client", () => {
    expect(readGoogleIdentity(jwt(good()), CLIENT, NOW)).toEqual({ sub: "110169484474386276334", email: "dana@example.test", emailVerified: true });
  });
  it("accepts both documented issuer spellings", () => {
    expect(reason(() => readGoogleIdentity(jwt(good({ iss: "accounts.google.com" })), CLIENT, NOW))).toBeNull();
  });
  it("accepts an audience array that contains our client id", () => {
    expect(reason(() => readGoogleIdentity(jwt(good({ aud: ["other", CLIENT] })), CLIENT, NOW))).toBeNull();
  });
  it("refuses another issuer, another audience, an expired token, no subject and no email", () => {
    expect(reason(() => readGoogleIdentity(jwt(good({ iss: "https://accounts.google.com.evil.test" })), CLIENT, NOW))).toBe("bad_issuer");
    expect(reason(() => readGoogleIdentity(jwt(good({ aud: "someone-elses-client" })), CLIENT, NOW))).toBe("bad_audience");
    expect(reason(() => readGoogleIdentity(jwt(good({ aud: ["a", "b"] })), CLIENT, NOW))).toBe("bad_audience");
    expect(reason(() => readGoogleIdentity(jwt(good({ exp: Math.floor(NOW / 1000) - 1 })), CLIENT, NOW))).toBe("expired");
    expect(reason(() => readGoogleIdentity(jwt(good({ exp: undefined })), CLIENT, NOW))).toBe("expired");
    expect(reason(() => readGoogleIdentity(jwt(good({ sub: undefined })), CLIENT, NOW))).toBe("no_subject");
    expect(reason(() => readGoogleIdentity(jwt(good({ email: undefined })), CLIENT, NOW))).toBe("no_email");
  });
  it("refuses an empty expected client id (an unset config can never match)", () => {
    expect(reason(() => readGoogleIdentity(jwt(good({ aud: "" })), "", NOW))).toBe("bad_audience");
  });
  it("refuses something that is not a three-part JWT with a JSON object payload", () => {
    expect(reason(() => readGoogleIdentity("nope", CLIENT, NOW))).toBe("malformed");
    expect(reason(() => readGoogleIdentity("a.b", CLIENT, NOW))).toBe("malformed");
    expect(reason(() => readGoogleIdentity(`x.${Buffer.from("[1]").toString("base64url")}.y`, CLIENT, NOW))).toBe("malformed");
    expect(reason(() => readGoogleIdentity(`x.${Buffer.from("not json").toString("base64url")}.y`, CLIENT, NOW))).toBe("malformed");
  });
  it("never puts the token or a claim in the error", () => {
    const token = jwt(good({ aud: "another" }));
    try { readGoogleIdentity(token, CLIENT, NOW); } catch (e) {
      expect(String((e as Error).message)).not.toContain(token);
      expect(JSON.stringify(e)).not.toContain("example.test");
    }
  });
});
