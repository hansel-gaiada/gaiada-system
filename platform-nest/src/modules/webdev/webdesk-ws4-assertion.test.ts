// WSK-63b — the ERP's WS4 minting, pinned to WebDesk's verifier by SHARED LITERALS.
//
// The vectors below appear verbatim in `webdesk/api/test/ws4-assertion-vectors.spec.ts`, which runs
// them through WebDesk's real `computeCommandHash` / `mintWs4Assertion` / `verifyWs4Signature`. If
// either side drifts, the test on the side that drifted fails. Change a literal only on both sides.
//
// M4 F1 adds the v2 (Ed25519 JWS) vectors below, verbatim in `webdesk/api/test/ws4-assertion-v2-vectors.spec.ts`,
// which mints them with WebDesk's own test-only minter and verifies them with the real `verifyWs4Assertion`.
//
// Pure: no database, no Cerbos, no network.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  commandArgsAsZoneBSeesThem,
  computeCommandHash,
  loadWs4SigningKey,
  mintWs4Assertion,
  mintWs4AssertionV2,
  mintWs4ForCommand,
  Ws4SigningKeyError,
} from "./webdesk-ws4-assertion";

const WS4_COMMAND_HASH_VECTORS = [
  {
    name: "flat route params (tenant.archive)",
    command: "tenant.archive",
    args: { tenantSlug: "acme" },
    hash: "3ba7dad4d2e8cdc9f210754d5af57f23ef6b758cc14e80c58088458d4840288b",
  },
  {
    name: "nested object, unsorted keys, array order kept, escaped unicode (release.promote)",
    command: "release.promote",
    args: {
      tenantSlug: "gaiada",
      envId: "env_01",
      releaseId: "rel-2026.10.10",
      options: { tags: ["b", "a"], notes: 'Rilis "Ü" ✓\n', dryRun: false },
    },
    hash: "d8bbaf983865c34d6634bdddb493ed80a2e2712046bc9b71ac4fe93c51f0a7d2",
  },
  {
    name: "array of objects, null, fraction, negative zero (key.rotate)",
    command: "key.rotate",
    args: { tenantSlug: "t-1", apiKeyId: "k_9", scopes: [{ z: 1, a: 2 }, { m: null }], ratio: 0.5, n: -0 },
    hash: "fdfb9f8869879277a305ce23050a0f9c298a8273712bf0a456954dcc8b3454cb",
  },
] as const;

const WS4_MINT_VECTOR = {
  key: "wsk63b-vector-key-not-a-secret",
  claims: {
    approvalId: "00000000-0000-4000-8000-000000000063",
    commandHash: "3ba7dad4d2e8cdc9f210754d5af57f23ef6b758cc14e80c58088458d4840288b",
    exp: 4102444800, // 2100-01-01T00:00:00Z
  },
  header:
    "eyJhcHByb3ZhbElkIjoiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDYzIiwiY29tbWFuZEhhc2giOiIzYmE3ZGFkNGQyZThjZGM5ZjIxMDc1NGQ1YWY1N2YyM2VmNmI3NThjYzE0ZTgwYzU4MDg4NDU4ZDQ4NDAyODhiIiwiZXhwIjo0MTAyNDQ0ODAwfQ" +
    ".b4f68d0a2068e7b409aab28e688d3b306658d194adeafcb6ecc46e90129ff748",
} as const;

describe("WSK-63b WS4 minting (ERP side) — shared vectors", () => {
  for (const v of WS4_COMMAND_HASH_VECTORS) {
    it(`computeCommandHash: ${v.name}`, () => {
      expect(computeCommandHash(v.command, v.args)).toBe(v.hash);
    });
  }

  it("mintWs4Assertion produces the pinned header bytes", () => {
    expect(mintWs4Assertion({ ...WS4_MINT_VECTOR.claims }, WS4_MINT_VECTOR.key)).toBe(WS4_MINT_VECTOR.header);
  });

  it("mintWs4ForCommand builds the claims in WebDesk's key order and lands on the same bytes", () => {
    const header = mintWs4ForCommand({
      key: WS4_MINT_VECTOR.key,
      approvalId: WS4_MINT_VECTOR.claims.approvalId,
      command: "tenant.archive",
      args: { tenantSlug: "acme" },
      nowSec: WS4_MINT_VECTOR.claims.exp - 60,
      ttlSec: 60,
    });
    expect(header).toBe(WS4_MINT_VECTOR.header);
  });

  it("the payload is exactly {approvalId, commandHash, exp} in that order, and the signature is lowercase hex", () => {
    const [payload, sig] = WS4_MINT_VECTOR.header.split(".");
    expect(Buffer.from(payload, "base64url").toString("utf8")).toBe(JSON.stringify(WS4_MINT_VECTOR.claims));
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses to mint without a key, an approvalId, or with an out-of-range TTL", () => {
    const base = { key: "k", approvalId: "a", command: "tenant.archive", args: {} };
    expect(() => mintWs4ForCommand({ ...base, key: "" })).toThrow(/no assertion key/);
    expect(() => mintWs4ForCommand({ ...base, approvalId: "" })).toThrow(/approvalId/);
    expect(() => mintWs4ForCommand({ ...base, ttlSec: 0 })).toThrow(/ttlSec/);
    expect(() => mintWs4ForCommand({ ...base, ttlSec: 301 })).toThrow(/ttlSec/);
    expect(() => mintWs4ForCommand({ ...base, ttlSec: 1.5 })).toThrow(/ttlSec/);
  });
});

describe("WSK-63b commandArgsAsZoneBSeesThem — the args WebDesk's guard will hash", () => {
  it("merges params FIRST and body SECOND (a body key wins), like `{...request.params, ...request.body}`", () => {
    expect(commandArgsAsZoneBSeesThem({ tenantSlug: "acme", envId: "e1" }, { envId: "body-wins", x: 1 })).toEqual({
      tenantSlug: "acme",
      envId: "body-wins",
      x: 1,
    });
  });

  it("hashes the body as it will look on the wire (JSON round-trip), not as it looks in memory", () => {
    const when = new Date("2026-10-10T00:00:00.000Z");
    const args = commandArgsAsZoneBSeesThem({ tenantSlug: "acme" }, { dropped: undefined, when, nested: { u: undefined, k: 1 } });
    expect(args).toEqual({ tenantSlug: "acme", when: "2026-10-10T00:00:00.000Z", nested: { k: 1 } });
    expect(Object.prototype.hasOwnProperty.call(args, "dropped")).toBe(false);
    // The same hash WebDesk computes from the parsed request body.
    const parsed = { tenantSlug: "acme", ...JSON.parse(JSON.stringify({ dropped: undefined, when, nested: { u: undefined, k: 1 } })) };
    expect(computeCommandHash("release.promote", args)).toBe(computeCommandHash("release.promote", parsed));
  });

  it("no body ⇒ params only", () => {
    expect(commandArgsAsZoneBSeesThem({ tenantSlug: "acme" }, undefined)).toEqual({ tenantSlug: "acme" });
  });
});

// Source drift: the three primitives must be statement-for-statement WebDesk's. Behavioural vectors
// catch most drift; this catches the rest (e.g. a canonicalize() change no vector happens to hit).
// Runs whenever the webdesk tree sits beside platform-nest (the repo layout); skipped visibly otherwise.
const WEBDESK_WS4 = join(__dirname, "../../../../webdesk/api/src/control/auth/ws4-assertion.ts");

function fnSource(text: string, signature: string): string {
  const t = text.replace(/\r\n/g, "\n");
  const start = t.indexOf(signature);
  if (start < 0) throw new Error(`signature not found: ${signature}`);
  const end = t.indexOf("\n}\n", start);
  return t.slice(start, end + 2);
}

describe("WSK-63b WS4 primitives are a verbatim copy of WebDesk's", () => {
  it.skipIf(!existsSync(WEBDESK_WS4))("mintWs4Assertion, computeCommandHash and canonicalize match webdesk/api byte for byte", () => {
    const theirs = readFileSync(WEBDESK_WS4, "utf8");
    const ours = readFileSync(join(__dirname, "webdesk-ws4-assertion.ts"), "utf8");
    for (const sig of [
      "export function mintWs4Assertion(",
      "export function computeCommandHash(",
      "function canonicalize(value: unknown): string {",
    ]) {
      expect(fnSource(ours, sig), sig).toBe(fnSource(theirs, sig));
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// M4 F1 — v2 (EdDSA). The literals below appear verbatim in webdesk/api/test/ws4-assertion-v2-vectors.spec.ts.
// The vector keys are DERIVED from a public label (sha256(label) as the Ed25519 seed), so both repos pin
// byte-identical tokens without a private key ever being written into either repository.

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
function vectorKey(label: string): { privateKey: KeyObject; x: string } {
  const seed = createHash("sha256").update(label).digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
  return { privateKey, x: createPublicKey(privateKey).export({ format: "jwk" }).x as string };
}

const WS4_V2_VECTORS = [
  {
    name: "v1 claims of WSK-63b's vector, now as v2 (tenant.archive {tenantSlug: acme})",
    label: "m4-f1-ws4-vector-key-not-a-secret",
    kid: "ws4-vector-1",
    x: "TmxGQVTuyZQhzGd99OcY1ovRIEkXgvwoJ1VpVIiey3E",
    claims: {
      approvalId: "00000000-0000-4000-8000-000000000063",
      commandHash: "3ba7dad4d2e8cdc9f210754d5af57f23ef6b758cc14e80c58088458d4840288b",
      exp: 4102444800,
    },
    token:
      "eyJhbGciOiJFZERTQSIsImtpZCI6IndzNC12ZWN0b3ItMSIsInR5cCI6IndzNCtqd3QifQ" +
      ".eyJhcHByb3ZhbElkIjoiMDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDYzIiwiY29tbWFuZEhhc2giOiIzYmE3ZGFkNGQyZThjZGM5ZjIxMDc1NGQ1YWY1N2YyM2VmNmI3NThjYzE0ZTgwYzU4MDg4NDU4ZDQ4NDAyODhiIiwiZXhwIjo0MTAyNDQ0ODAwLCJhdWQiOiJ3ZWJkZXNrLWNvbnRyb2wtcGxhbmUifQ" +
      ".ZQWoPEjeFWynPTDHaBkRAKOs8PwBX5zBcCN7JjiUURZM6THkDvQjtpyrl8SYm0evDUpowJv2PSfOAgINUT9ECw",
  },
  {
    name: "second key (a rotation overlap), release.promote claims, non-UUID approval id",
    label: "m4-f1-ws4-vector-key-2-not-a-secret",
    kid: "ws4-vector-2",
    x: "iOGoUq0hqR-fU8TlL4JLHOLoBg0F9JqtJ0A3g9cJfZg",
    claims: {
      approvalId: "ws4-v2-vector-approval-2",
      commandHash: "d8bbaf983865c34d6634bdddb493ed80a2e2712046bc9b71ac4fe93c51f0a7d2",
      exp: 4102444800,
    },
    token:
      "eyJhbGciOiJFZERTQSIsImtpZCI6IndzNC12ZWN0b3ItMiIsInR5cCI6IndzNCtqd3QifQ" +
      ".eyJhcHByb3ZhbElkIjoid3M0LXYyLXZlY3Rvci1hcHByb3ZhbC0yIiwiY29tbWFuZEhhc2giOiJkOGJiYWY5ODM4NjVjMzRkNjYzNGJkZGRiNDkzZWQ4MGEyZTI3MTIwNDZiYzliNzFhYzRmZTkzYzUxZjBhN2QyIiwiZXhwIjo0MTAyNDQ0ODAwLCJhdWQiOiJ3ZWJkZXNrLWNvbnRyb2wtcGxhbmUifQ" +
      ".CLZU9NCH3wbX-R1JKe82yW8baOjkRcmUrhf9Dx9Bwal5UBsUKmOz1AqtWH-TxnUMIL-2bghdGJ2lMqhP3boFBw",
  },
] as const;

describe("M4 F1 WS4 v2 minting (ERP side) — shared vectors", () => {
  for (const v of WS4_V2_VECTORS) {
    const k = vectorKey(v.label);
    it(`${v.name}: the label derives the pinned public key`, () => {
      expect(k.x).toBe(v.x);
    });
    it(`${v.name}: mintWs4AssertionV2 produces the pinned token bytes`, () => {
      expect(mintWs4AssertionV2({ ...v.claims }, { privateKey: k.privateKey, kid: v.kid })).toBe(v.token);
    });
    it(`${v.name}: the signature verifies with the public key alone (what WebDesk holds)`, () => {
      const [h, p, s] = v.token.split(".");
      const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: v.x }, format: "jwk" });
      expect(cryptoVerify(null, Buffer.from(`${h}.${p}`, "ascii"), pub, Buffer.from(s, "base64url"))).toBe(true);
    });
  }

  it("mintWs4ForCommand mints v2 when a signing key is given, landing on vector 1's bytes", () => {
    const v = WS4_V2_VECTORS[0];
    const k = vectorKey(v.label);
    const header = mintWs4ForCommand({
      key: "an-hmac-key-that-must-be-ignored",
      signing: { privateKey: k.privateKey, kid: v.kid },
      approvalId: v.claims.approvalId,
      command: "tenant.archive",
      args: { tenantSlug: "acme" },
      nowSec: v.claims.exp - 60,
      ttlSec: 60,
    });
    expect(header).toBe(v.token);
  });

  it("without a signing key mintWs4ForCommand still mints v1 (phase 1, and whenever no kid is set)", () => {
    const header = mintWs4ForCommand({
      key: WS4_MINT_VECTOR.key,
      approvalId: WS4_MINT_VECTOR.claims.approvalId,
      command: "tenant.archive",
      args: { tenantSlug: "acme" },
      nowSec: WS4_MINT_VECTOR.claims.exp - 60,
      ttlSec: 60,
    });
    expect(header).toBe(WS4_MINT_VECTOR.header);
  });

  it("refuses to sign with a non-Ed25519 key, a public key, or a malformed kid", () => {
    const c = { ...WS4_V2_VECTORS[0].claims };
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    expect(() => mintWs4AssertionV2(c, { privateKey: ec, kid: "ws4-x" })).toThrow(Ws4SigningKeyError);
    const ed = generateKeyPairSync("ed25519");
    expect(() => mintWs4AssertionV2(c, { privateKey: ed.publicKey, kid: "ws4-x" })).toThrow(/Ed25519 private key/);
    expect(() => mintWs4AssertionV2(c, { privateKey: ed.privateKey, kid: "has space" })).toThrow(/kid must match/);
  });
});

describe("M4 F1 WS4 signing key loading (custody: a PKCS8 PEM file, never env text)", () => {
  const dir = mkdtempSync(join(tmpdir(), "m4f1-ws4-key-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const ed = generateKeyPairSync("ed25519");
  const pemText = ed.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const pemFile = join(dir, "ws4-signing.ws4-2026-10.pk8.pem");
  writeFileSync(pemFile, pemText);
  chmodSync(pemFile, 0o400);
  const write = (name: string, text: string) => {
    const f = join(dir, name);
    writeFileSync(f, text);
    return f;
  };

  it("kid unset → not-configured (v1 stays in charge)", () => {
    expect(loadWs4SigningKey({ keyFile: pemFile, kid: "" })).toEqual({ state: "not-configured", reason: "WEBDESK_CONTROL_WS4_SIGNING_KID is not set" });
  });

  it("kid set + a valid Ed25519 PKCS8 file → configured, and it signs a token the public key verifies", () => {
    const l = loadWs4SigningKey({ keyFile: pemFile, kid: "ws4-2026-10" });
    expect(l.state).toBe("configured");
    if (l.state !== "configured") return;
    const t = mintWs4AssertionV2({ approvalId: "a", commandHash: "0".repeat(64), exp: 1 }, l.signing);
    const [h, p, s] = t.split(".");
    expect(cryptoVerify(null, Buffer.from(`${h}.${p}`, "ascii"), ed.publicKey, Buffer.from(s, "base64url"))).toBe(true);
  });

  const invalid: Array<[string, () => { keyFile: string; kid: string }, RegExp]> = [
    ["a missing file (what compose names for a kid with no key installed)", () => ({ keyFile: join(dir, "ws4-signing.ws4-missing.pk8.pem"), kid: "ws4-missing" }), /cannot be read \(ENOENT\)/],
    ["a directory", () => { const d = join(dir, "a-dir"); mkdirSync(d, { recursive: true }); return { keyFile: d, kid: "ws4-x" }; }, /not a regular file/],
    ["a truncated PEM", () => ({ keyFile: write("trunc.pem", pemText.slice(0, 40)), kid: "ws4-x" }), /not a complete PKCS8 PEM/],
    ["an EC key", () => ({ keyFile: write("ec.pem", generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }) as string), kid: "ws4-x" }), /is a ec key; the WS4 signing key must be Ed25519/],
    ["a bad kid", () => ({ keyFile: pemFile, kid: "has space" }), /SIGNING_KID must match/],
    ["no key file path", () => ({ keyFile: "", kid: "ws4-x" }), /SIGNING_KEY_FILE is not set/],
  ];
  for (const [name, make, re] of invalid) {
    it(`kid set + ${name} → invalid (WS4 calls answer 503, never a silent v1), naming the file, never its bytes`, () => {
      const l = loadWs4SigningKey(make());
      expect(l.state).toBe("invalid");
      if (l.state !== "invalid") return;
      expect(l.reason).toMatch(re);
      expect(l.reason).not.toContain(pemText.slice(40, 80));
    });
  }
});
