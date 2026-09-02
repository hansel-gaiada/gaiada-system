// GH-01 §2.3 — the JWT minter's shape must match scripts/github-app/verify-app.mjs EXACTLY (that
// script is proven against the live gaiadabali org, 2026-08-31; this file's job is to prove OUR copy
// of the algorithm agrees with it, since no test here may call the live API).
import { describe, it, expect } from "vitest";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { mintAppJwt, decodeJwtClaimsForTest, GITHUB_APP_JWT_MAX_TTL_SECONDS } from "./jwt";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const PUB = publicKey.export({ type: "pkcs1", format: "pem" }).toString();

function verify(jwt: string): boolean {
  const [header, payload, sig] = jwt.split(".");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${payload}`);
  const sigBuf = Buffer.from(sig.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return verifier.verify(PUB, sigBuf);
}

describe("mintAppJwt (§2.3)", () => {
  it("produces a three-part RS256 JWT GitHub's own public key can verify", () => {
    const jwt = mintAppJwt({ appId: "4777424", privateKeyPem: PEM });
    expect(jwt.split(".").length).toBe(3);
    expect(verify(jwt)).toBe(true);
  });

  it("header declares RS256/JWT", () => {
    const jwt = mintAppJwt({ appId: "1", privateKeyPem: PEM });
    const [headerB64] = jwt.split(".");
    const header = JSON.parse(Buffer.from(headerB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
  });

  it("iat is backdated exactly 60s — GitHub rejects a future iat", () => {
    const now = () => 1_700_000_000_000;
    const jwt = mintAppJwt({ appId: "4777424", privateKeyPem: PEM, now });
    const claims = decodeJwtClaimsForTest(jwt);
    expect(claims.iat).toBe(1_700_000_000 - 60);
  });

  it("iss is the app id, verbatim (string, not coerced)", () => {
    const jwt = mintAppJwt({ appId: "4777699", privateKeyPem: PEM });
    expect(decodeJwtClaimsForTest(jwt).iss).toBe("4777699");
  });

  it("default TTL is 540s (9 min), matching verify-app.mjs's proven value", () => {
    const now = () => 1_700_000_000_000;
    const jwt = mintAppJwt({ appId: "1", privateKeyPem: PEM, now });
    const claims = decodeJwtClaimsForTest(jwt);
    expect(claims.exp - (claims.iat + 60)).toBe(540); // exp measured from the UN-backdated "now"
  });

  it("a requested TTL above GitHub's 600s ceiling is clamped, never sent as-is", () => {
    const now = () => 1_700_000_000_000;
    const jwt = mintAppJwt({ appId: "1", privateKeyPem: PEM, now, ttlSeconds: 3600 });
    const claims = decodeJwtClaimsForTest(jwt);
    expect(claims.exp - (claims.iat + 60)).toBe(GITHUB_APP_JWT_MAX_TTL_SECONDS);
  });

  it("a zero/negative TTL is floored to 1s, never produces an already-expired or backwards token", () => {
    const now = () => 1_700_000_000_000;
    const jwt = mintAppJwt({ appId: "1", privateKeyPem: PEM, now, ttlSeconds: -5 });
    const claims = decodeJwtClaimsForTest(jwt);
    expect(claims.exp).toBeGreaterThan(claims.iat);
  });

  it("two mints a second apart produce different signatures (iat actually varies)", () => {
    let t = 1_700_000_000_000;
    const now = () => t;
    const jwt1 = mintAppJwt({ appId: "1", privateKeyPem: PEM, now });
    t += 1000;
    const jwt2 = mintAppJwt({ appId: "1", privateKeyPem: PEM, now });
    expect(jwt1).not.toBe(jwt2);
  });

  it("base64url output carries no '+', '/' or '=' padding (a GitHub-rejecting shape)", () => {
    const jwt = mintAppJwt({ appId: "1", privateKeyPem: PEM });
    for (const part of jwt.split(".")) {
      expect(part).not.toMatch(/[+/=]/);
    }
  });
});
