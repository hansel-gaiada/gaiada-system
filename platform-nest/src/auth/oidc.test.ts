// 5b.1: OIDC verification + auto-provision + assurance mapping, driven by an in-test
// signing key (no running IdP). Live-Keycloak wiring is exercised in the phase e2e.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, type JWK } from "jose";
import { config } from "../config";
import { withGlobal } from "../db";
import { setJwksForTest, verifyToken, principalFromToken } from "./oidc";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createUser } from "../testing/fixtures";

let privateKey: CryptoKey;

async function token(claims: Record<string, unknown>, opts: { iss?: string; aud?: string; expired?: boolean } = {}) {
  const jwt = new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(opts.iss ?? config.oidcIssuer)
    .setAudience(opts.aud ?? config.oidcAudience)
    .setIssuedAt()
    .setSubject(String(claims.sub ?? "sub-1"))
    .setExpirationTime(opts.expired ? "-1h" : "1h");
  return jwt.sign(privateKey);
}

describe.skipIf(!TEST_URL)("OIDC verification (5b.1)", () => {
  beforeAll(async () => {
    await initTestDb();
    const { publicKey, privateKey: pk } = await generateKeyPair("RS256");
    privateKey = pk;
    const pub = (await exportJWK(publicKey)) as JWK;
    pub.kid = "test-key";
    setJwksForTest(createLocalJWKSet({ keys: [pub] }));
  });
  afterAll(teardownTestDb);

  it("verifies a well-formed token and extracts sub/email/amr", async () => {
    const t = await token({ sub: "kc-1", email: "budi@gaiada.test", name: "Budi", amr: ["pwd"] });
    const v = await verifyToken(t);
    expect(v).toMatchObject({ sub: "kc-1", email: "budi@gaiada.test", name: "Budi" });
  });

  it("rejects wrong issuer, wrong audience, and expired tokens", async () => {
    await expect(verifyToken(await token({ sub: "x" }, { iss: "http://evil" }))).rejects.toThrow();
    await expect(verifyToken(await token({ sub: "x" }, { aud: "someone-else" }))).rejects.toThrow();
    await expect(verifyToken(await token({ sub: "x" }, { expired: true }))).rejects.toThrow();
  });

  it("auto-provisions a new user on first login (joined by sub)", async () => {
    const p = await principalFromToken(await token({ sub: "kc-new", email: "sari@gaiada.test", email_verified: true, name: "Sari" }));
    expect(p?.userId).toBeTruthy();
    const again = await principalFromToken(await token({ sub: "kc-new", email: "sari@gaiada.test", email_verified: true, name: "Sari" }));
    expect(again?.userId).toBe(p?.userId); // idempotent — same user, not a duplicate
    const rows = await withGlobal((c) => c.query(`SELECT id FROM users WHERE idp_subject = 'kc-new'`));
    expect(rows.rows.length).toBe(1);
  });

  it("links an invited (pre-existing email) user only when the email is IdP-VERIFIED", async () => {
    const invitedId = await createUser("invited@gaiada.test", "Invited");
    const p = await principalFromToken(
      await token({ sub: "kc-invited", email: "invited@gaiada.test", email_verified: true, name: "Invited" }),
    );
    expect(p?.userId).toBe(invitedId); // no duplicate; existing row linked
  });

  it("REFUSES to link to an existing account when the colliding email is unverified (account-takeover guard)", async () => {
    const victimId = await createUser("victim@gaiada.test", "Victim");
    await expect(
      principalFromToken(await token({ sub: "kc-attacker", email: "victim@gaiada.test", email_verified: false, name: "Attacker" })),
    ).rejects.toThrow(/not IdP-verified/);
    // The victim's account is untouched — no idp_subject was attached.
    const row = await withGlobal((c) => c.query<{ idp_subject: string | null }>(`SELECT idp_subject FROM users WHERE id = $1`, [victimId]));
    expect(row.rows[0].idp_subject).toBeNull();
  });

  it("a fresh subject with an unverified email is provisioned without claiming that email", async () => {
    const p = await principalFromToken(await token({ sub: "kc-unverif", email: "new-unverified@gaiada.test", email_verified: false }));
    const row = await withGlobal((c) => c.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [p!.userId]));
    expect(row.rows[0].email).toBe("kc-unverif@idp.local"); // placeholder, not the unverified address
  });

  it("an MFA'd token → high assurance; a password-only token → linked", async () => {
    const mfa = await principalFromToken(await token({ sub: "kc-mfa", email: "m@gaiada.test", email_verified: true, amr: ["pwd", "otp"] }));
    expect(mfa?.assurance).toBe("high");
    const pwd = await principalFromToken(await token({ sub: "kc-pwd", email: "p@gaiada.test", email_verified: true, amr: ["pwd"] }));
    expect(pwd?.assurance).toBe("linked");
  });
});
