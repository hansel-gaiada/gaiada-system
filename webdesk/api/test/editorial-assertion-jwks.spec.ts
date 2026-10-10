// WSK-40 — done-when (2): the pinned JWKS loader refuses a truncated or non-Ed25519 file AT BOOT
// (the CA-loader discipline of real-control-channel-authenticator.ts), and treats an ABSENT file as
// "not configured" (503 on writes, the instance still boots so /v1 delivery stays up).
//
// The boot rows build the real AppModule with the production resolver class bound, the same way
// production binds it, and assert that compile() rejects. Needs the CI Postgres (content-test-kit).
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { buildContentApp } from "./content-test-kit";
import { EDITORIAL_PRINCIPAL_RESOLVER } from "../src/control/auth/editorial-principal";
import { RealEditorialPrincipalResolver } from "../src/control/auth/real-editorial-principal-resolver";
import { EditorialJwksError, loadEditorialJwks, parseEditorialJwks, EDITORIAL_JWKS_FILE_ENV } from "../src/control/auth/editorial-jwks";
import { freshKey, jwksJson } from "./editorial-assertion-kit";

const a = freshKey("wde-a");
const b = freshKey("wde-b");
const c = freshKey("wde-c");
const okp = (kid: string, x: string, extra: Record<string, unknown> = {}) => ({ kty: "OKP", crv: "Ed25519", kid, x, ...extra });
const doc = (...keys: unknown[]) => JSON.stringify({ keys });

describe("WSK-40 editorial JWKS: parse rules", () => {
  it("accepts one key and a two-key rotation overlap", () => {
    expect([...parseEditorialJwks(jwksJson([a]), "t").keys()]).toEqual(["wde-a"]);
    const two = parseEditorialJwks(jwksJson([a, b]), "t");
    expect([...two.keys()]).toEqual(["wde-a", "wde-b"]);
    expect(two.get("wde-b")?.asymmetricKeyType).toBe("ed25519");
  });

  const refusals: Array<[string, string, RegExp]> = [
    ["empty file", "", /empty/],
    ["truncated JSON (half of a valid file)", jwksJson([a]).slice(0, Math.floor(jwksJson([a]).length / 2)), /not valid JSON/],
    ["truncated JSON (last byte cut)", jwksJson([a]).slice(0, -1), /not valid JSON/],
    ["a JSON array, not a JWKS", "[]", /not a JSON object/],
    ["no keys array", "{}", /no "keys" array/],
    ["zero keys", doc(), /expected 1\.\.2 keys/],
    ["three keys", jwksJson([a, b, c]), /expected 1\.\.2 keys/],
    [
      "RSA key",
      doc({ kty: "RSA", kid: "r", n: generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "jwk" }).n, e: "AQAB" }),
      /has unexpected member "n"|kty must be "OKP"/,
    ],
    ["EC P-256 key", doc({ kty: "EC", crv: "P-256", kid: "e", x: generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" }).x, y: "AAAA" }), /unexpected member "y"|kty must be "OKP"/],
    ["X25519 (OKP, wrong curve)", doc(okp("x", generateKeyPairSync("x25519").publicKey.export({ format: "jwk" }).x as string, { crv: "X25519" })), /crv must be "Ed25519"/],
    ["Ed448 (OKP, wrong curve)", doc(okp("x", generateKeyPairSync("ed448").publicKey.export({ format: "jwk" }).x as string, { crv: "Ed448" })), /crv must be "Ed25519"/],
    ["private key material (d)", doc(okp("p", a.x, { d: a.privateKey.export({ format: "jwk" }).d })), /PRIVATE key material/],
    ["short x (truncated public key)", doc(okp("s", a.x.slice(0, 42))), /32-byte base64url/],
    ["duplicate kid", doc(okp("dup", a.x), okp("dup", b.x)), /duplicate kid/],
    ["bad kid", doc(okp("has space", a.x)), /kid must match/],
    ["use=enc", doc(okp("u", a.x, { use: "enc" })), /use must be "sig"/],
    ["alg=RS256", doc(okp("g", a.x, { alg: "RS256" })), /alg must be "EdDSA"/],
  ];
  for (const [name, text, re] of refusals) {
    it(`refuses: ${name}`, () => {
      let err: unknown;
      try {
        parseEditorialJwks(text, "FILE");
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(EditorialJwksError);
      expect((err as Error).message).toMatch(re);
      expect((err as Error).message).toContain("FILE");
      // Never echoes key material.
      expect((err as Error).message).not.toContain(a.x);
    });
  }
});

describe("WSK-40 editorial JWKS: file loading and the boot refusal", () => {
  let dir: string;
  const saved = process.env[EDITORIAL_JWKS_FILE_ENV];
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "wsk40-jwks-"));
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[EDITORIAL_JWKS_FILE_ENV];
    else process.env[EDITORIAL_JWKS_FILE_ENV] = saved;
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("unset → not configured", () => {
    expect(loadEditorialJwks("")).toMatchObject({ state: "not-configured" });
    expect(loadEditorialJwks(undefined)).toMatchObject({ state: "not-configured" });
  });
  it("a path that does not exist → not configured", () => {
    expect(loadEditorialJwks(join(dir, "nope.json"))).toMatchObject({ state: "not-configured", reason: expect.stringContaining("does not exist") });
  });
  it("a directory (what a bind mount of a missing host file creates) → not configured", () => {
    const d = join(dir, "editorial.jwks.json.d");
    mkdirSync(d);
    expect(loadEditorialJwks(d)).toMatchObject({ state: "not-configured", reason: expect.stringContaining("not a regular file") });
  });
  it("a valid file → configured with its kids", () => {
    const f = join(dir, "ok.json");
    writeFileSync(f, jwksJson([a, b]));
    const r = loadEditorialJwks(f);
    expect(r.state).toBe("configured");
    expect(r.state === "configured" && [...r.keys.keys()]).toEqual(["wde-a", "wde-b"]);
  });

  async function bootWith(file: string) {
    process.env[EDITORIAL_JWKS_FILE_ENV] = file;
    return buildContentApp((bld) => bld.overrideProvider(EDITORIAL_PRINCIPAL_RESOLVER).useClass(RealEditorialPrincipalResolver));
  }

  it("BOOT REFUSED: the real AppModule with the production resolver and a TRUNCATED JWKS file does not compile", async () => {
    const f = join(dir, "truncated.json");
    writeFileSync(f, jwksJson([a]).slice(0, 40));
    await expect(bootWith(f)).rejects.toThrow(/editorial JWKS .* refused: not valid JSON/);
  });

  it("BOOT REFUSED: the real AppModule with the production resolver and a NON-Ed25519 JWKS file does not compile", async () => {
    const f = join(dir, "x25519.json");
    writeFileSync(f, doc(okp("x", generateKeyPairSync("x25519").publicKey.export({ format: "jwk" }).x as string, { crv: "X25519" })));
    await expect(bootWith(f)).rejects.toThrow(/crv must be "Ed25519"/);
  });

  it("boots with a valid file (positive control for the two refusals above)", async () => {
    const f = join(dir, "valid.json");
    writeFileSync(f, jwksJson([a]));
    const app = await bootWith(f);
    await app.close();
  });
});
