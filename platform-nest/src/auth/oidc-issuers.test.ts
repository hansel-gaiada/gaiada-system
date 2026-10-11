// OIDC_ISSUER list parsing/validation + verification accepting issuer A and B, refusing C.
// DB-free: verifyToken only needs a key set, injected via setJwksForTest.
import { describe, it, expect, beforeAll } from "vitest";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, type JWK } from "jose";
import { config } from "../config";
import { parseOidcIssuers, DEFAULT_OIDC_ISSUER } from "./oidc-issuers";
import { setJwksForTest, verifyToken } from "./oidc";

const NEW = "https://erp.gaiada.com/idp/realms/gaiada";
const OLD = "https://erp.gaiada.online/idp/realms/gaiada";

describe("parseOidcIssuers", () => {
  it("unset or blank keeps the default", () => {
    expect(parseOidcIssuers(undefined)).toEqual([DEFAULT_OIDC_ISSUER]);
    expect(parseOidcIssuers("")).toEqual([DEFAULT_OIDC_ISSUER]);
    expect(parseOidcIssuers("   ")).toEqual([DEFAULT_OIDC_ISSUER]);
  });
  it("single entry and a trimmed list, order preserved", () => {
    expect(parseOidcIssuers(OLD)).toEqual([OLD]);
    expect(parseOidcIssuers(` ${NEW} , ${OLD} `)).toEqual([NEW, OLD]);
  });
  it("allows http for localhost, 127.0.0.1 and the compose host keycloak", () => {
    expect(parseOidcIssuers("http://keycloak:8080/realms/gaiada")).toHaveLength(1);
    expect(parseOidcIssuers("http://127.0.0.1:8080/realms/gaiada")).toHaveLength(1);
    expect(parseOidcIssuers("http://localhost:8080/realms/gaiada")).toHaveLength(1);
  });
  it.each([
    ["empty entry", `${NEW},,${OLD}`],
    ["trailing comma", `${NEW},`],
    ["only commas", ","],
    ["duplicate", `${NEW}, ${NEW}`],
    ["not absolute", "erp.gaiada.com/idp/realms/gaiada"],
    ["not a url", "not a url"],
    ["plain http on a public host", "http://erp.gaiada.com/idp/realms/gaiada"],
    ["non-http scheme", "ftp://erp.gaiada.com/x"],
  ])("throws on %s", (_n, raw) => {
    expect(() => parseOidcIssuers(raw)).toThrow(/OIDC_ISSUER/);
  });
});

describe("config.oidcIssuer / oidcIssuers", () => {
  it("oidcIssuer is the first entry of oidcIssuers", () => {
    expect(config.oidcIssuer).toBe(config.oidcIssuers[0]);
  });
});

describe("verifyToken with an issuer list", () => {
  let privateKey: CryptoKey;
  const saved = config.oidcIssuers;
  beforeAll(async () => {
    const kp = await generateKeyPair("RS256");
    privateKey = kp.privateKey;
    const pub = (await exportJWK(kp.publicKey)) as JWK;
    pub.kid = "k1";
    setJwksForTest(createLocalJWKSet({ keys: [pub] }));
    (config as { oidcIssuers: string[] }).oidcIssuers = [NEW, OLD];
    return () => {
      (config as { oidcIssuers: string[] }).oidcIssuers = saved;
    };
  });
  const mint = (iss: string) =>
    new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(iss)
      .setAudience(config.oidcAudience)
      .setSubject("s1")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

  it("accepts issuer A and issuer B", async () => {
    expect((await verifyToken(await mint(NEW))).sub).toBe("s1");
    expect((await verifyToken(await mint(OLD))).sub).toBe("s1");
  });
  it("refuses issuer C", async () => {
    await expect(verifyToken(await mint("https://evil.example/idp/realms/gaiada"))).rejects.toThrow();
  });
});
