// M4 F1 — the WS4 v2 (EdDSA) wire format pinned by fixed vectors, asserted on BOTH sides of the control
// channel, like the v1 vectors in ./ws4-assertion-vectors.spec.ts.
//
// The ERP mints (`platform-nest/src/modules/webdev/webdesk-ws4-assertion.ts`, mintWs4AssertionV2); this
// repo verifies (`src/control/auth/ws4-assertion.ts`, verifyWs4Assertion). They share LITERALS: the key
// labels, kids, public `x` values, claims and the expected tokens below appear verbatim in
// `platform-nest/src/modules/webdev/webdesk-ws4-assertion.test.ts`. Ed25519 is deterministic, so
// (key, header, payload) gives exactly one token. Change a literal here only together with that file.
//
// Pure: no database, no app, no network.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computeCommandHash, peekWs4Assertion, verifyWs4Assertion, WS4_REFUSAL } from "../src/control/auth/ws4-assertion";
import { parseWs4Jwks } from "../src/control/auth/ws4-jwks";
import { mintWs4V2, vectorKey, ws4KeySetOf } from "./ws4-assertion-kit";

const WS4_V2_VECTORS = [
  {
    name: "v1 claims of WSK-63b's vector, now as v2 (tenant.archive {tenantSlug: acme})",
    label: "m4-f1-ws4-vector-key-not-a-secret",
    kid: "ws4-vector-1",
    x: "TmxGQVTuyZQhzGd99OcY1ovRIEkXgvwoJ1VpVIiey3E",
    claims: {
      approvalId: "00000000-0000-4000-8000-000000000063",
      commandHash: "3ba7dad4d2e8cdc9f210754d5af57f23ef6b758cc14e80c58088458d4840288b",
      exp: 4102444800, // 2100-01-01T00:00:00Z, so the literal stays verifiable
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

const keys = WS4_V2_VECTORS.map((v) => vectorKey(v.kid, v.label));
const bothKids = ws4KeySetOf(...keys);

describe("M4 F1 WS4 v2 cross-repo vectors (Zone B side)", () => {
  WS4_V2_VECTORS.forEach((v, i) => {
    it(`${v.name}: the label derives the pinned public key`, () => {
      expect(keys[i].x).toBe(v.x);
    });

    it(`${v.name}: WebDesk's test-only minter produces the pinned token bytes`, () => {
      expect(mintWs4V2({ ...v.claims }, keys[i])).toBe(v.token);
    });

    it(`${v.name}: verifyWs4Assertion accepts it as v2 with exactly these claims (both kids installed)`, () => {
      expect(verifyWs4Assertion(v.token, { hmacKey: null, v2Keys: bothKids })).toEqual({ ok: true, version: 2, claims: v.claims });
    });

    it(`${v.name}: peekWs4Assertion reads v2 and the approval id from the PAYLOAD segment`, () => {
      expect(peekWs4Assertion(v.token)).toEqual({ version: 2, approvalId: v.claims.approvalId });
    });

    it(`${v.name}: the header and payload decode to the pinned wire order`, () => {
      const [h, p, s] = v.token.split(".");
      expect(Buffer.from(h, "base64url").toString("utf8")).toBe(JSON.stringify({ alg: "EdDSA", kid: v.kid, typ: "ws4+jwt" }));
      expect(Buffer.from(p, "base64url").toString("utf8")).toBe(JSON.stringify({ ...v.claims, aud: "webdesk-control-plane" }));
      expect(Buffer.from(s, "base64url")).toHaveLength(64);
    });
  });

  it("vector 1's commandHash is WSK-63b's tenant.archive {tenantSlug: acme} hash (same function, same args)", () => {
    expect(WS4_V2_VECTORS[0].claims.commandHash).toBe(computeCommandHash("tenant.archive", { tenantSlug: "acme" }));
  });

  it("negative control: with only the OTHER kid installed, each vector is an unknown key", () => {
    for (let i = 0; i < 2; i++) {
      const other = ws4KeySetOf(keys[1 - i]);
      const r = verifyWs4Assertion(WS4_V2_VECTORS[i].token, { hmacKey: null, v2Keys: other });
      expect(r).toMatchObject({ ok: false, version: 2, code: WS4_REFUSAL.unknownKey });
    }
  });

  // Live cross-check: the ERP test writes a FRESHLY minted v2 assertion (real clock, random approvalId,
  // args built the way the ERP client builds them, a fresh key) when WS4_V2_FIXTURE_OUT is set; pointing
  // this variable at that file verifies it here with the real verifier. Skipped (visibly) when unset.
  const fixturePath = process.env.WS4_V2_FIXTURE_IN;
  it.skipIf(!fixturePath)("a v2 assertion minted by platform-nest verifies with the real verifyWs4Assertion", () => {
    const f = JSON.parse(readFileSync(fixturePath as string, "utf8")) as {
      jwks: string;
      header: string;
      command: string;
      args: unknown;
      approvalId: string;
    };
    const r = verifyWs4Assertion(f.header, { hmacKey: null, v2Keys: parseWs4Jwks(f.jwks, "fixture") });
    expect(r.ok, r.ok ? "" : r.reason).toBe(true);
    if (!r.ok) return;
    expect(r.version).toBe(2);
    expect(r.claims.approvalId).toBe(f.approvalId);
    expect(r.claims.commandHash).toBe(computeCommandHash(f.command, f.args));
    const now = Math.floor(Date.now() / 1000);
    expect(r.claims.exp).toBeGreaterThan(now);
    expect(r.claims.exp - now).toBeLessThanOrEqual(60);
  });
});
