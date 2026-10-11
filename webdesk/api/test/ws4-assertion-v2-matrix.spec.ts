// M4 F1 — the WS4 adversarial matrix, v2 (EdDSA) beside v1 (HMAC). Every row names its exact refusal
// (code + reason, or the exact Layer-4 reason), and the matrix carries its own positive controls.
//
// Three levels, all PURE (no database, no app, no network, no Docker), so they run anywhere:
//   1. verifyWs4Assertion        the verifier: alg confusion, key separation, typ/aud, kid, time, tamper.
//   2. RealPolicyDecisionPoint   Layer 4 as production binds it, over a fake audit store: commandHash
//                                mismatch, replay (also across versions), v1 after the HMAC key is unset,
//                                the audit row's recorded version.
//   3. Boot                      the PDP constructor with WEBDESK_WS4_JWKS_FILE pointing at real files:
//                                malformed shapes refuse boot, absent does not, and a WS4 set that shares
//                                a kid or a key with the editorial set refuses boot.
// The DB-backed end-to-end rows (real mTLS + token + HIGH command + audit_entries) are in
// control-auth-layers.spec.ts.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  computeCommandHash,
  mintWs4Assertion,
  peekWs4Assertion,
  verifyWs4Assertion,
  WS4_REFUSAL,
  type Ws4AssertionResult,
  type Ws4Claims,
  type Ws4VerifierKeys,
} from "../src/control/auth/ws4-assertion";
import { WS4_JWKS_FILE_ENV, Ws4JwksError } from "../src/control/auth/ws4-jwks";
import { EDITORIAL_JWKS_FILE_ENV, EditorialJwksError, parseEditorialJwks } from "../src/control/auth/editorial-jwks";
import { verifyEditorialAssertion, ws4ApprovalIdOf, EDITORIAL_SLUG, EDITORIAL_AUD, EDITORIAL_ISS } from "../src/control/auth/editorial-assertion";
import { RealPolicyDecisionPoint, resolveWs4GateConfig, WS4_DEV_HMAC_KEY } from "../src/control/policy/real-policy-decision-point";
import { COMMAND_REGISTRY } from "../src/control/command-types";
import { AuditService } from "../src/audit/audit.service";
import { clearVerifiedWs4Versions, verifiedWs4VersionOf } from "../src/control/auth/ws4-verified-version";
import type { DbService } from "../src/db/db.service";
import type { TenantLookupService } from "../src/tenants/tenant-lookup.service";
import { freshKey, jwksJson, mintHs256, mintRaw, mintWs4V2, ws4KeySetOf, ws4V2Header, ws4V2Payload } from "./ws4-assertion-kit";
import { keySetOf } from "./editorial-assertion-kit";

const NOW = 1_800_000_000;
const ws4Key = freshKey("ws4-2026-10");
const ws4Unlisted = freshKey("ws4-2026-11"); // a well-formed WS4-shaped key that is NOT installed
const edKey = freshKey("wde-2026-10");
const V1_KEY = "m4-f1-matrix-v1-key-not-a-secret";
const HASH = computeCommandHash("tenant.archive", { tenantSlug: "acme" });
const claims = (over: Partial<Ws4Claims> = {}): Ws4Claims => ({ approvalId: randomUUID(), commandHash: HASH, exp: NOW + 60, ...over });
const ws4Set = ws4KeySetOf(ws4Key);
const v2Only: Ws4VerifierKeys = { hmacKey: null, v2Keys: ws4Set };
const both: Ws4VerifierKeys = { hmacKey: V1_KEY, v2Keys: ws4Set };

/** Every refusal row asserts the full result: version, code and the exact reason. */
function refused(r: Ws4AssertionResult, version: 1 | 2 | null, code: string, reason: string) {
  expect(r).toEqual({ ok: false, version, code, reason });
}

const swapSegment = (token: string, i: number, value: string) => token.split(".").map((s, j) => (j === i ? value : s)).join(".");
const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v), "utf8").toString("base64url");

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("M4 F1 WS4 matrix, level 1: verifyWs4Assertion", () => {
  describe("positive controls", () => {
    it("v2 good: EdDSA, the WS4 kid, ws4+jwt, the control-plane aud, unexpired", () => {
      const c = claims();
      expect(verifyWs4Assertion(mintWs4V2(c, ws4Key), v2Only, NOW)).toEqual({ ok: true, version: 2, claims: c });
    });
    it("v2 good one second before exp (the boundary is now < exp, v1's rule)", () => {
      const c = claims({ exp: NOW + 1 });
      expect(verifyWs4Assertion(mintWs4V2(c, ws4Key), v2Only, NOW)).toMatchObject({ ok: true, version: 2 });
    });
    it("v1 good while WEBDESK_APPROVAL_ASSERTION_KEY is set (the overlap of phases 1 and 2)", () => {
      const c = claims({ exp: Math.floor(Date.now() / 1000) + 300 });
      expect(verifyWs4Assertion(mintWs4Assertion(c, V1_KEY), both)).toEqual({ ok: true, version: 1, claims: c });
    });
    it("v2 still good with the HMAC key configured too (phase 2: both accepted)", () => {
      expect(verifyWs4Assertion(mintWs4V2(claims(), ws4Key), both, NOW)).toMatchObject({ ok: true, version: 2 });
    });
  });

  describe("algorithm confusion: alg is pinned to EdDSA before any key is looked up", () => {
    it('alg "none" with an empty signature', () => {
      const t = `${b64({ alg: "none", kid: ws4Key.kid, typ: "ws4+jwt" })}.${b64(ws4V2Payload(claims()))}.`;
      refused(verifyWs4Assertion(t, v2Only, NOW), 2, WS4_REFUSAL.algRefused, 'WS4 v2 algorithm "none" is not accepted (only EdDSA)');
    });
    it("alg absent", () => {
      const t = mintRaw({ kid: ws4Key.kid, typ: "ws4+jwt" }, ws4V2Payload(claims()), ws4Key.privateKey);
      refused(verifyWs4Assertion(t, v2Only, NOW), 2, WS4_REFUSAL.algRefused, "WS4 v2 algorithm null is not accepted (only EdDSA)");
    });
    const secrets: Array<[string, Buffer | string]> = [
      ["the raw 32 public-key bytes", Buffer.from(ws4Key.x, "base64url")],
      ["the JWK x string", ws4Key.x],
      ["the SPKI PEM text", ws4Key.publicKey.export({ type: "spki", format: "pem" }) as string],
      ["the JWKS file text", jwksJson([ws4Key])],
    ];
    for (const [name, secret] of secrets) {
      it(`HS256 keyed with ${name} (the classic public-key-as-HMAC-secret confusion)`, () => {
        const t = mintHs256({ alg: "HS256", kid: ws4Key.kid, typ: "ws4+jwt" }, ws4V2Payload(claims()), secret);
        refused(verifyWs4Assertion(t, both, NOW), 2, WS4_REFUSAL.algRefused, 'WS4 v2 algorithm "HS256" is not accepted (only EdDSA)');
      });
    }
    for (const alg of ["HS512", "RS256", "ES256", "PS256", "Ed25519", "eddsa"]) {
      it(`alg ${JSON.stringify(alg)}`, () => {
        const t = mintRaw({ alg, kid: ws4Key.kid, typ: "ws4+jwt" }, ws4V2Payload(claims()), ws4Key.privateKey);
        refused(verifyWs4Assertion(t, v2Only, NOW), 2, WS4_REFUSAL.algRefused, `WS4 v2 algorithm ${JSON.stringify(alg)} is not accepted (only EdDSA)`);
      });
    }
  });

  describe("key separation: the editorial key never verifies a WS4 token", () => {
    it("a genuine editorial assertion presented as x-ws4-assertion (its typ)", () => {
      const editorialToken = mintRaw(
        { alg: "EdDSA", typ: "wd-editorial+jwt", kid: edKey.kid },
        { iss: EDITORIAL_ISS, aud: EDITORIAL_AUD, sub: "u", pk: "human", ten: "acme", site: "s", cmd: "tenant.archive", cmh: HASH, iat: NOW, exp: NOW + 60, jti: randomUUID() },
        edKey.privateKey,
      );
      refused(verifyWs4Assertion(editorialToken, both, NOW), 2, WS4_REFUSAL.typInvalid, 'WS4 v2 typ must be "ws4+jwt"');
    });
    it("signed by the editorial key, WS4 typ and aud, the editorial kid: that kid is not in the WS4 set", () => {
      const t = mintWs4V2(claims(), edKey);
      refused(verifyWs4Assertion(t, both, NOW), 2, WS4_REFUSAL.unknownKey, 'WS4 v2 kid "wde-2026-10" is not in the pinned WS4 JWKS');
    });
    it("signed by the editorial key but CLAIMING the WS4 kid: the signature does not verify under the WS4 key", () => {
      const t = mintWs4V2(claims(), { kid: ws4Key.kid, privateKey: edKey.privateKey });
      refused(verifyWs4Assertion(t, both, NOW), 2, WS4_REFUSAL.signatureInvalid, "WS4 v2 assertion signature does not verify (tampered, or not signed by that kid)");
    });
    it("the reverse: a WS4 token presented to the editorial verifier is refused there (unknown key)", async () => {
      const t = mintWs4V2(claims(), ws4Key);
      await expect(
        verifyEditorialAssertion(t, keySetOf(edKey), { tenantSlug: "acme", siteId: "s", command: "tenant.archive", args: {}, high: true, ws4ApprovalId: null }, NOW),
      ).rejects.toMatchObject({ slug: EDITORIAL_SLUG.unknownKey });
    });
    it("the reverse, WS4 key claiming the editorial kid: refused by the editorial verifier (invalid signature)", async () => {
      const t = mintRaw({ alg: "EdDSA", typ: "wd-editorial+jwt", kid: edKey.kid }, { aud: EDITORIAL_AUD }, ws4Key.privateKey);
      await expect(
        verifyEditorialAssertion(t, keySetOf(edKey), { tenantSlug: "acme", siteId: "s", command: "tenant.archive", args: {}, high: true, ws4ApprovalId: null }, NOW),
      ).rejects.toMatchObject({ slug: EDITORIAL_SLUG.invalidSignature });
    });
  });

  describe("header, typ, aud, kid", () => {
    for (const typ of ["JWT", "wd-editorial+jwt", "WS4+JWT", undefined]) {
      it(`typ ${JSON.stringify(typ ?? null)}`, () => {
        const h: Record<string, unknown> = { alg: "EdDSA", kid: ws4Key.kid };
        if (typ !== undefined) h.typ = typ;
        refused(verifyWs4Assertion(mintRaw(h, ws4V2Payload(claims()), ws4Key.privateKey), v2Only, NOW), 2, WS4_REFUSAL.typInvalid, 'WS4 v2 typ must be "ws4+jwt"');
      });
    }
    for (const [member, value] of [
      ["crit", ["exp"]],
      ["jwk", { kty: "OKP", crv: "Ed25519", x: ws4Unlisted.x }],
      ["jku", "https://attacker.example/jwks.json"],
      ["x5u", "https://attacker.example/cert.pem"],
      ["b64", false],
    ] as const) {
      it(`extra protected-header member "${member}" (could change how the token verifies)`, () => {
        const t = mintRaw({ ...ws4V2Header(ws4Key.kid), [member]: value }, ws4V2Payload(claims()), ws4Key.privateKey);
        refused(verifyWs4Assertion(t, v2Only, NOW), 2, WS4_REFUSAL.headerInvalid, `WS4 v2 protected header member "${member}" is not accepted (only alg, kid, typ)`);
      });
    }
    it("aud missing", () => {
      const { aud: _aud, ...noAud } = ws4V2Payload(claims());
      refused(verifyWs4Assertion(mintRaw(ws4V2Header(ws4Key.kid), noAud, ws4Key.privateKey), v2Only, NOW), 2, WS4_REFUSAL.audInvalid, 'WS4 v2 aud is missing (must be "webdesk-control-plane")');
    });
    for (const aud of [EDITORIAL_AUD, "webdesk-control-plane ", ["webdesk-control-plane"], null]) {
      it(`aud ${JSON.stringify(aud)}`, () => {
        const t = mintRaw(ws4V2Header(ws4Key.kid), { ...ws4V2Payload(claims()), aud }, ws4Key.privateKey);
        refused(verifyWs4Assertion(t, v2Only, NOW), 2, WS4_REFUSAL.audInvalid, 'WS4 v2 aud must be "webdesk-control-plane"');
      });
    }
    it("unknown kid (well-formed WS4 key, not installed)", () => {
      refused(verifyWs4Assertion(mintWs4V2(claims(), ws4Unlisted), v2Only, NOW), 2, WS4_REFUSAL.unknownKey, 'WS4 v2 kid "ws4-2026-11" is not in the pinned WS4 JWKS');
    });
    it("no kid", () => {
      const t = mintRaw({ alg: "EdDSA", typ: "ws4+jwt" }, ws4V2Payload(claims()), ws4Key.privateKey);
      refused(verifyWs4Assertion(t, v2Only, NOW), 2, WS4_REFUSAL.unknownKey, "WS4 v2 assertion names no kid");
    });
  });

  describe("time", () => {
    it("expired: now = exp", () => {
      refused(verifyWs4Assertion(mintWs4V2(claims({ exp: NOW }), ws4Key), v2Only, NOW), 2, WS4_REFUSAL.expired, "WS4 assertion expired");
    });
    it("expired: an hour ago", () => {
      refused(verifyWs4Assertion(mintWs4V2(claims({ exp: NOW - 3600 }), ws4Key), v2Only, NOW), 2, WS4_REFUSAL.expired, "WS4 assertion expired");
    });
  });

  describe("tampering", () => {
    it("tampered payload (another approvalId, the original signature)", () => {
      const t = mintWs4V2(claims(), ws4Key);
      const forged = swapSegment(t, 1, b64(ws4V2Payload(claims())));
      refused(verifyWs4Assertion(forged, v2Only, NOW), 2, WS4_REFUSAL.signatureInvalid, "WS4 v2 assertion signature does not verify (tampered, or not signed by that kid)");
    });
    it("tampered payload (a longer exp, the original signature)", () => {
      const c = claims();
      const forged = swapSegment(mintWs4V2(c, ws4Key), 1, b64(ws4V2Payload({ ...c, exp: c.exp + 86_400 })));
      refused(verifyWs4Assertion(forged, v2Only, NOW), 2, WS4_REFUSAL.signatureInvalid, "WS4 v2 assertion signature does not verify (tampered, or not signed by that kid)");
    });
    it("tampered signature (one byte flipped)", () => {
      const t = mintWs4V2(claims(), ws4Key);
      const sig = Buffer.from(t.split(".")[2], "base64url");
      sig[10] ^= 0x01;
      refused(verifyWs4Assertion(swapSegment(t, 2, sig.toString("base64url")), v2Only, NOW), 2, WS4_REFUSAL.signatureInvalid, "WS4 v2 assertion signature does not verify (tampered, or not signed by that kid)");
    });
    it("truncated signature (63 bytes)", () => {
      const t = mintWs4V2(claims(), ws4Key);
      const sig = Buffer.from(t.split(".")[2], "base64url").subarray(0, 63);
      refused(verifyWs4Assertion(swapSegment(t, 2, sig.toString("base64url")), v2Only, NOW), 2, WS4_REFUSAL.signatureInvalid, "WS4 v2 assertion signature does not verify (tampered, or not signed by that kid)");
    });
    it("tampered header (kid swapped to another installed kid): signature fails under that kid", () => {
      const two = ws4KeySetOf(ws4Key, ws4Unlisted);
      const t = mintWs4V2(claims(), ws4Key);
      const forged = swapSegment(t, 0, b64(ws4V2Header(ws4Unlisted.kid)));
      refused(verifyWs4Assertion(forged, { hmacKey: null, v2Keys: two }, NOW), 2, WS4_REFUSAL.signatureInvalid, "WS4 v2 assertion signature does not verify (tampered, or not signed by that kid)");
    });
    it("non-canonical base64url signature (same bytes, unused trailing bits set): malformed", () => {
      const t = mintWs4V2(claims(), ws4Key);
      const sig = t.split(".")[2];
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      const last = alphabet.indexOf(sig[sig.length - 1]);
      const twin = sig.slice(0, -1) + alphabet[(last & ~0x0f) | ((last + 1) & 0x0f)];
      expect(Buffer.from(twin, "base64url").equals(Buffer.from(sig, "base64url"))).toBe(true); // same bytes
      refused(verifyWs4Assertion(swapSegment(t, 2, twin), v2Only, NOW), 2, WS4_REFUSAL.malformed, "WS4 v2 assertion has a non-canonical base64url segment");
    });
  });

  describe("claim shapes, availability, shape dispatch", () => {
    it("commandHash not lowercase hex", () => {
      refused(verifyWs4Assertion(mintWs4V2(claims({ commandHash: HASH.toUpperCase() }), ws4Key), v2Only, NOW), 2, WS4_REFUSAL.claimsInvalid, "WS4 v2 commandHash must be a lowercase sha256 hex digest");
    });
    it("exp as a string", () => {
      const t = mintRaw(ws4V2Header(ws4Key.kid), { ...ws4V2Payload(claims()), exp: String(NOW + 60) }, ws4Key.privateKey);
      refused(verifyWs4Assertion(t, v2Only, NOW), 2, WS4_REFUSAL.claimsInvalid, "WS4 v2 exp must be an integer NumericDate");
    });
    it("empty approvalId", () => {
      refused(verifyWs4Assertion(mintWs4V2(claims({ approvalId: "" }), ws4Key), v2Only, NOW), 2, WS4_REFUSAL.claimsInvalid, "WS4 v2 approvalId must be a non-empty string (max 200)");
    });
    it("v2 presented while no WS4 key set is installed", () => {
      refused(
        verifyWs4Assertion(mintWs4V2(claims(), ws4Key), { hmacKey: V1_KEY, v2Keys: null }, NOW),
        2,
        WS4_REFUSAL.v2Unavailable,
        "WS4 v2 (EdDSA) assertion presented but no WS4 key set is installed (WEBDESK_WS4_JWKS_FILE)",
      );
    });
    it("v1 presented after the HMAC key is unset", () => {
      const t = mintWs4Assertion(claims({ exp: Math.floor(Date.now() / 1000) + 300 }), V1_KEY);
      refused(
        verifyWs4Assertion(t, v2Only),
        1,
        WS4_REFUSAL.v1Disabled,
        "WS4 v1 (HMAC) assertions are no longer accepted: WEBDESK_APPROVAL_ASSERTION_KEY is not configured on this instance",
      );
    });
    it("v1 under the wrong HMAC key keeps its WSK-22 reason, unchanged", () => {
      const t = mintWs4Assertion(claims({ exp: Math.floor(Date.now() / 1000) + 300 }), `${V1_KEY}x`);
      refused(verifyWs4Assertion(t, both), 1, WS4_REFUSAL.v1Invalid, "WS4 assertion signature invalid (HMAC mismatch — tampered or wrong key)");
    });
    for (const [name, t] of [
      ["one part", "abc"],
      ["four parts", "a.b.c.d"],
      ["empty", ""],
    ] as const) {
      it(`${name}: malformed, no version guessed`, () => {
        refused(verifyWs4Assertion(t, both, NOW), null, WS4_REFUSAL.malformed, "malformed x-ws4-assertion (expected two dot-separated parts for v1 or three for v2)");
      });
    }
  });

  describe("the unverified approval-id peek reads the right segment for each version", () => {
    it("v1: first segment; v2: second (the first is the JWS header, which has no approvalId)", () => {
      const c = claims();
      expect(peekWs4Assertion(mintWs4Assertion(c, V1_KEY))).toEqual({ version: 1, approvalId: c.approvalId });
      expect(peekWs4Assertion(mintWs4V2(c, ws4Key))).toEqual({ version: 2, approvalId: c.approvalId });
      expect(ws4ApprovalIdOf(mintWs4V2(c, ws4Key))).toBe(c.approvalId);
      expect(peekWs4Assertion("a.b.c.d")).toBeNull();
      expect(peekWs4Assertion(undefined)).toBeNull();
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// Level 2: Layer 4 as production binds it, over a fake audit store.

const ENV_KEYS = ["NODE_ENV", "WEBDESK_APPROVAL_ASSERTION_KEY", WS4_JWKS_FILE_ENV, EDITORIAL_JWKS_FILE_ENV] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
function setEnv(vars: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) {
  for (const k of ENV_KEYS) {
    const v = k in vars ? vars[k] : savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
function restoreEnv() {
  setEnv({});
}

/** audit_entries as the PDP's dedup query sees it: the approval ids of rows already written. */
class FakeAuditStore {
  readonly used = new Set<string>();
  readonly inserts: unknown[][] = [];
  readonly client = {
    query: async (sql: string, params: unknown[] = []) => {
      if (/^\s*INSERT INTO audit_entries/.test(sql)) {
        this.inserts.push(params);
        if (typeof params[4] === "string") this.used.add(params[4]);
        return { rows: [] };
      }
      return { rows: this.used.has(params[0] as string) ? [{ hit: 1 }] : [] };
    },
  };
  readonly db = { withPlatformCtx: async <T>(fn: (c: unknown) => Promise<T>) => fn(this.client) } as unknown as DbService;
}
const noTenants = { bySlug: async () => null } as unknown as TenantLookupService;

const meta = COMMAND_REGISTRY["tenant.archive"];
const principal = { subject: "erp-control", scopes: [meta.scope], automation: true };
const ARGS = { tenantSlug: "acme" };

let dir: string;
let ws4File: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "m4f1-ws4-"));
  ws4File = join(dir, "ws4.jwks.json");
  writeFileSync(ws4File, jwksJson([ws4Key]));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => {
  restoreEnv();
  clearVerifiedWs4Versions();
});

function pdp(store: FakeAuditStore, env: Parameters<typeof setEnv>[0]) {
  setEnv(env);
  try {
    return new RealPolicyDecisionPoint(store.db, noTenants);
  } finally {
    restoreEnv();
  }
}
const evaluate = (p: RealPolicyDecisionPoint, header: string | null, args: Record<string, unknown> = ARGS) =>
  p.evaluate({ principal, meta, tenantSlug: null, ws4ApprovalId: peekWs4Assertion(header)?.approvalId ?? null, ws4AssertionHeader: header, args });
const live = (over: Partial<Ws4Claims> = {}) => claims({ exp: Math.floor(Date.now() / 1000) + 60, ...over });

describe("M4 F1 WS4 matrix, level 2: RealPolicyDecisionPoint (Layer 4)", () => {
  it("POSITIVE: v2 good is allowed, and the audit row that claims it records version 2", async () => {
    const store = new FakeAuditStore();
    const p = pdp(store, { NODE_ENV: "production", WEBDESK_APPROVAL_ASSERTION_KEY: "", [WS4_JWKS_FILE_ENV]: ws4File });
    const c = live();
    expect(await evaluate(p, mintWs4V2(c, ws4Key))).toEqual({ allow: true });
    expect(verifiedWs4VersionOf(c.approvalId)).toBe(2);
    await new AuditService().record(store.client as never, { tenantId: null, actor: "a", action: "control.tenant.archive", ws4ApprovalId: c.approvalId });
    expect(store.inserts[0]).toEqual([null, "a", "control.tenant.archive", null, c.approvalId, 2]);
  });

  it("POSITIVE: v1 good while the HMAC key is set is allowed and recorded as version 1", async () => {
    const store = new FakeAuditStore();
    const p = pdp(store, { NODE_ENV: "production", WEBDESK_APPROVAL_ASSERTION_KEY: V1_KEY, [WS4_JWKS_FILE_ENV]: ws4File });
    const c = live();
    expect(await evaluate(p, mintWs4Assertion(c, V1_KEY))).toEqual({ allow: true });
    await new AuditService().record(store.client as never, { tenantId: null, actor: "a", action: "control.tenant.archive", ws4ApprovalId: c.approvalId });
    expect(store.inserts[0][5]).toBe(1);
  });

  it("a row whose approval this instance never verified records NULL, never a guess", async () => {
    const store = new FakeAuditStore();
    await new AuditService().record(store.client as never, { tenantId: null, actor: "a", action: "control.x", ws4ApprovalId: randomUUID() });
    await new AuditService().record(store.client as never, { tenantId: null, actor: "a", action: "control.y" });
    expect(store.inserts.map((r) => r[5])).toEqual([null, null]);
  });

  it("REFUSES: commandHash mismatch (signed for other arguments)", async () => {
    const p = pdp(new FakeAuditStore(), { NODE_ENV: "production", [WS4_JWKS_FILE_ENV]: ws4File });
    const t = mintWs4V2(live({ commandHash: computeCommandHash("tenant.archive", { tenantSlug: "other" }) }), ws4Key);
    expect(await evaluate(p, t)).toEqual({
      allow: false,
      reason:
        "WS4 assertion commandHash does not match the actual command arguments — refused " +
        "(design WSK-D3: Zone B never trusts a claimed approval for arguments it did not itself see)",
    });
  });

  it("REFUSES: replay, the second use of one v2 approval (after its audit row exists)", async () => {
    const store = new FakeAuditStore();
    const p = pdp(store, { NODE_ENV: "production", [WS4_JWKS_FILE_ENV]: ws4File });
    const c = live();
    const t = mintWs4V2(c, ws4Key);
    expect(await evaluate(p, t)).toEqual({ allow: true });
    await new AuditService().record(store.client as never, { tenantId: null, actor: "a", action: "control.tenant.archive", ws4ApprovalId: c.approvalId });
    expect(await evaluate(p, t)).toEqual({ allow: false, reason: "WS4 assertion has already been used for a prior command — single-use violated, replay refused" });
  });

  it("REFUSES: replay ACROSS versions (approval used as v1, then re-presented as a fresh v2 token)", async () => {
    const store = new FakeAuditStore();
    const p = pdp(store, { NODE_ENV: "production", WEBDESK_APPROVAL_ASSERTION_KEY: V1_KEY, [WS4_JWKS_FILE_ENV]: ws4File });
    const c = live();
    expect(await evaluate(p, mintWs4Assertion(c, V1_KEY))).toEqual({ allow: true });
    await new AuditService().record(store.client as never, { tenantId: null, actor: "a", action: "control.tenant.archive", ws4ApprovalId: c.approvalId });
    expect(await evaluate(p, mintWs4V2(c, ws4Key))).toEqual({ allow: false, reason: "WS4 assertion has already been used for a prior command — single-use violated, replay refused" });
  });

  it("REFUSES: v1 presented after the HMAC key is unset (production, phase 3)", async () => {
    const p = pdp(new FakeAuditStore(), { NODE_ENV: "production", WEBDESK_APPROVAL_ASSERTION_KEY: undefined, [WS4_JWKS_FILE_ENV]: ws4File });
    expect(await evaluate(p, mintWs4Assertion(live(), V1_KEY))).toEqual({
      allow: false,
      reason: "WS4 assertion rejected: WS4 v1 (HMAC) assertions are no longer accepted: WEBDESK_APPROVAL_ASSERTION_KEY is not configured on this instance",
    });
  });

  it("REFUSES: v1 signed with a published placeholder key in production (the placeholder never counts as a key)", async () => {
    for (const placeholder of [WS4_DEV_HMAC_KEY, "changeme_approval_assertion_key"]) {
      const p = pdp(new FakeAuditStore(), { NODE_ENV: "production", WEBDESK_APPROVAL_ASSERTION_KEY: placeholder, [WS4_JWKS_FILE_ENV]: ws4File });
      expect((await evaluate(p, mintWs4Assertion(live(), placeholder))).allow).toBe(false);
    }
  });

  it("REFUSES: a v2 alg-confusion token reaches Layer 4 as 'rejected', with the verifier's exact reason", async () => {
    const p = pdp(new FakeAuditStore(), { NODE_ENV: "production", WEBDESK_APPROVAL_ASSERTION_KEY: V1_KEY, [WS4_JWKS_FILE_ENV]: ws4File });
    const t = mintHs256({ alg: "HS256", kid: ws4Key.kid, typ: "ws4+jwt" }, ws4V2Payload(live()), Buffer.from(ws4Key.x, "base64url"));
    expect(await evaluate(p, t)).toEqual({ allow: false, reason: 'WS4 assertion rejected: WS4 v2 algorithm "HS256" is not accepted (only EdDSA)' });
  });

  it("REFUSES (fail closed): neither version configured in production — the PDP still constructs, every HIGH command is refused", async () => {
    const p = pdp(new FakeAuditStore(), { NODE_ENV: "production", WEBDESK_APPROVAL_ASSERTION_KEY: undefined, [WS4_JWKS_FILE_ENV]: undefined });
    expect((await evaluate(p, mintWs4V2(live(), ws4Key))).allow).toBe(false);
    expect((await evaluate(p, mintWs4Assertion(live(), V1_KEY))).allow).toBe(false);
  });

  it("outside production the WSK-22 dev default still verifies v1 (the test suites' behaviour is unchanged)", async () => {
    const p = pdp(new FakeAuditStore(), { NODE_ENV: "development", WEBDESK_APPROVAL_ASSERTION_KEY: undefined, [WS4_JWKS_FILE_ENV]: undefined });
    expect(await evaluate(p, mintWs4Assertion(live(), WS4_DEV_HMAC_KEY))).toEqual({ allow: true });
  });

  it("resolveWs4GateConfig summarises what is accepted and never prints a key", () => {
    const g = resolveWs4GateConfig({ NODE_ENV: "production", WEBDESK_APPROVAL_ASSERTION_KEY: V1_KEY, [WS4_JWKS_FILE_ENV]: ws4File });
    expect(g.hmacKey).toBe(V1_KEY);
    expect([...(g.v2Keys?.keys() ?? [])]).toEqual(["ws4-2026-10"]);
    expect(g.summary.join(" ")).not.toContain(V1_KEY);
    expect(g.summary.join(" ")).toContain("kid(s) ws4-2026-10");
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
describe("M4 F1 WS4 matrix, level 3: the WS4 JWKS at boot", () => {
  const okp = (kid: string, x: string, extra: Record<string, unknown> = {}) => ({ kty: "OKP", crv: "Ed25519", kid, x, ...extra });
  const doc = (...keys: unknown[]) => JSON.stringify({ keys });
  const k2 = freshKey("ws4-b");
  const k3 = freshKey("ws4-c");
  const shapes: Array<[string, string, RegExp]> = [
    ["empty file", "", /the file is empty/],
    ["truncated JSON", jwksJson([ws4Key]).slice(0, 40), /not valid JSON/],
    ["a JSON array", "[]", /not a JSON object/],
    ["no keys array", "{}", /no "keys" array/],
    ["zero keys", doc(), /expected 1\.\.2 keys/],
    ["three keys", jwksJson([ws4Key, k2, k3]), /expected 1\.\.2 keys/],
    ["private key material (d)", doc(okp("p", ws4Key.x, { d: ws4Key.privateKey.export({ format: "jwk" }).d })), /PRIVATE key material/],
    ["X25519", doc(okp("x", generateKeyPairSync("x25519").publicKey.export({ format: "jwk" }).x as string, { crv: "X25519" })), /crv must be "Ed25519"/],
    ["an EC P-256 key", doc({ kty: "EC", crv: "P-256", kid: "e", x: "AAAA", y: "AAAA" }), /unexpected member "y"/],
    ["short x", doc(okp("s", ws4Key.x.slice(0, 42))), /32-byte base64url/],
    ["duplicate kid", doc(okp("dup", ws4Key.x), okp("dup", k2.x)), /duplicate kid/],
  ];
  for (const [name, text, re] of shapes) {
    it(`BOOT REFUSED: ${name}`, () => {
      const f = join(dir, `bad-${name.replace(/\W+/g, "-")}.json`);
      writeFileSync(f, text);
      let err: unknown;
      try {
        pdp(new FakeAuditStore(), { NODE_ENV: "production", WEBDESK_APPROVAL_ASSERTION_KEY: V1_KEY, [WS4_JWKS_FILE_ENV]: f });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Ws4JwksError);
      const msg = (err as Error).message;
      expect(msg).toMatch(re);
      expect(msg).toContain(`WS4 JWKS from ${WS4_JWKS_FILE_ENV} ('${f}') refused:`);
      expect(msg).toContain("refusing to boot the WS4 approval assertion verifier");
      expect(msg).not.toContain(ws4Key.x);
    });
  }

  it("BOOT REFUSED: the WS4 file holds the SAME public key as the editorial file (under another kid)", () => {
    const ed = join(dir, "editorial.jwks.json");
    writeFileSync(ed, jwksJson([edKey]));
    const clash = join(dir, "ws4-clash-key.json");
    writeFileSync(clash, jwksJson([{ kid: "ws4-2026-10", x: edKey.x }]));
    expect(() => pdp(new FakeAuditStore(), { NODE_ENV: "production", [WS4_JWKS_FILE_ENV]: clash, [EDITORIAL_JWKS_FILE_ENV]: ed })).toThrow(
      /kid "ws4-2026-10" is the SAME public key as editorial kid "wde-2026-10"/,
    );
  });

  it("BOOT REFUSED: the WS4 file reuses an editorial kid", () => {
    const ed = join(dir, "editorial-2.jwks.json");
    writeFileSync(ed, jwksJson([edKey]));
    const clash = join(dir, "ws4-clash-kid.json");
    writeFileSync(clash, jwksJson([{ kid: edKey.kid, x: ws4Key.x }]));
    expect(() => pdp(new FakeAuditStore(), { NODE_ENV: "production", [WS4_JWKS_FILE_ENV]: clash, [EDITORIAL_JWKS_FILE_ENV]: ed })).toThrow(
      /kid "wde-2026-10" is also in the editorial JWKS/,
    );
  });

  it("boots: distinct WS4 and editorial files (positive control for the two refusals above)", () => {
    const ed = join(dir, "editorial-3.jwks.json");
    writeFileSync(ed, jwksJson([edKey]));
    expect(() => pdp(new FakeAuditStore(), { NODE_ENV: "production", [WS4_JWKS_FILE_ENV]: ws4File, [EDITORIAL_JWKS_FILE_ENV]: ed })).not.toThrow();
  });

  it("boots: a two-key rotation overlap", () => {
    const f = join(dir, "two.json");
    writeFileSync(f, jwksJson([ws4Key, k2]));
    expect(resolveWs4GateConfig({ NODE_ENV: "production", [WS4_JWKS_FILE_ENV]: f }).v2Keys?.size).toBe(2);
  });

  it("ABSENT is not a refusal: unset, a missing path, or a directory → v2 unavailable, v1 unaffected", () => {
    const d = join(dir, "ws4.jwks.json.d");
    mkdirSync(d);
    for (const f of [undefined, join(dir, "nope.json"), d]) {
      const g = resolveWs4GateConfig({ NODE_ENV: "production", WEBDESK_APPROVAL_ASSERTION_KEY: V1_KEY, [WS4_JWKS_FILE_ENV]: f });
      expect(g.v2Keys).toBeNull();
      expect(g.hmacKey).toBe(V1_KEY);
    }
  });

  it("the editorial loader's wording is unchanged by the generalisation (byte-identical message)", () => {
    expect(() => parseEditorialJwks("", "FILE")).toThrow(
      new EditorialJwksError("FILE", "the file is empty"),
    );
    let err: unknown;
    try {
      parseEditorialJwks("{}", "FILE");
    } catch (e) {
      err = e;
    }
    expect((err as Error).name).toBe("EditorialJwksError");
    expect((err as Error).message).toBe(
      '[webdesk:api] editorial JWKS from FILE refused: the document has no "keys" array — refusing to boot the editorial assertion verifier.',
    );
  });
});
