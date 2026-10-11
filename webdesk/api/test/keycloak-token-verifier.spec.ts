// Issuer-move window: the control channel accepts a LIST of issuers (old,new). Pure unit spec — the
// JWKS is a local 127.0.0.1 listener, no network, no Postgres/Redis.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as jose from "jose";
import {
  ControlIssuerConfigError,
  OfflineJwksVerifier,
  parseIssuerList,
} from "../src/control/auth/keycloak-token-verifier";

const AUD = "webdesk-control-plane";
const ISSUER_REALM_PATH = "/idp/realms/gaiada";

let server: http.Server;
let requestedPaths: string[] = [];
let signingKey: Awaited<ReturnType<typeof jose.generateKeyPair>>["privateKey"];
let kid: string;
let issuerA: string; // local http (allowed for 127.0.0.1) -> the JWKS is served under it
const issuerB = "https://erp.gaiada.com/idp/realms/gaiada";
const issuerC = "https://evil.example.com/idp/realms/gaiada";

async function mint(iss: string): Promise<string> {
  return new jose.SignJWT({ scope: "webdesk:read", azp: "webdesk-control" })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(iss)
    .setAudience(AUD)
    .setExpirationTime("5m")
    .sign(signingKey);
}

beforeAll(async () => {
  const { publicKey, privateKey } = await jose.generateKeyPair("RS256", { extractable: true });
  signingKey = privateKey;
  const jwk = await jose.exportJWK(publicKey);
  kid = await jose.calculateJwkThumbprint(jwk);
  Object.assign(jwk, { kid, alg: "RS256", use: "sig" });
  server = http.createServer((req, res) => {
    requestedPaths.push(req.url ?? "");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  issuerA = `http://127.0.0.1:${(server.address() as AddressInfo).port}${ISSUER_REALM_PATH}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("OfflineJwksVerifier — issuer list", () => {
  it("token from the first issuer verifies; the JWKS is derived from the FIRST issuer", async () => {
    requestedPaths = [];
    const v = new OfflineJwksVerifier({ issuers: [issuerA, issuerB], audience: AUD });
    const r = await v.verify(await mint(issuerA));
    expect(r.ok).toBe(true);
    expect(requestedPaths).toEqual([`${ISSUER_REALM_PATH}/protocol/openid-connect/certs`]);
  });

  it("token from the second issuer verifies (keys fetched via the first issuer's JWKS)", async () => {
    requestedPaths = [];
    const v = new OfflineJwksVerifier({ issuers: [issuerA, issuerB], audience: AUD });
    const r = await v.verify(await mint(issuerB));
    expect(r.ok).toBe(true);
    expect(requestedPaths).toEqual([`${ISSUER_REALM_PATH}/protocol/openid-connect/certs`]);
  });

  it("token from an unlisted issuer is refused, with the usual claim-validation reason", async () => {
    const v = new OfflineJwksVerifier({ issuers: [issuerA, issuerB], audience: AUD });
    const r = await v.verify(await mint(issuerC));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/token claim validation failed: iss/);
  });

  it("an explicit jwksUri wins over derivation", async () => {
    requestedPaths = [];
    const v = new OfflineJwksVerifier({
      issuers: [issuerB, issuerA],
      jwksUri: `${issuerA}/custom-certs`,
      audience: AUD,
    });
    expect((await v.verify(await mint(issuerA))).ok).toBe(true);
    expect(requestedPaths).toEqual([`${ISSUER_REALM_PATH}/custom-certs`]);
  });

  it("a single-string `issuer` still works and still refuses others", async () => {
    const v = new OfflineJwksVerifier({ issuer: issuerA, audience: AUD });
    expect((await v.verify(await mint(issuerA))).ok).toBe(true);
    expect((await v.verify(await mint(issuerB))).ok).toBe(false);
  });
});

describe("issuer list — configuration validation (fails at construction)", () => {
  const make = (issuers: string[]) => () => new OfflineJwksVerifier({ issuers, audience: AUD });

  it("empty list", () => {
    expect(make([])).toThrow(ControlIssuerConfigError);
    expect(make([])).toThrow(/empty list/);
  });
  it("no issuer given at all", () => {
    expect(() => new OfflineJwksVerifier({ audience: AUD })).toThrow(/empty list/);
  });
  it("empty entry", () => {
    expect(make([issuerB, ""])).toThrow(/empty entry/);
    expect(make(parseIssuerList("https://a.example/r,"))).toThrow(/empty entry/);
  });
  it("duplicate", () => {
    expect(make([issuerB, issuerB])).toThrow(/more than once/);
  });
  it("not an absolute URL", () => {
    expect(make(["erp.gaiada.com/idp/realms/gaiada"])).toThrow(/not an absolute URL/);
  });
  it("non-https scheme, and http on a non-local host", () => {
    expect(make(["ftp://erp.gaiada.com/r"])).toThrow(/https:/);
    expect(make(["http://erp.gaiada.com/idp/realms/gaiada"])).toThrow(/https:/);
  });
  it("http is allowed for localhost and 127.0.0.1 only", () => {
    expect(make(["http://localhost:8080/realms/x"])).not.toThrow();
    expect(make(["http://127.0.0.1:8080/realms/x"])).not.toThrow();
  });
  it("parseIssuerList trims whitespace around entries", () => {
    expect(parseIssuerList(" https://a.example/r ,\thttps://b.example/r ")).toEqual(["https://a.example/r", "https://b.example/r"]);
  });
});
