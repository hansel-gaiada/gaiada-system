// WSK-22 — §03 Layer 4 / WSK-D3: the WS4 assertion. Zone A (platform-nest, out of this repo's
// webdesk/ scope) is the ONLY minter in production — "Zone A enforces WS4 before egress" (§03).
// This file's `verifyWs4Signature`/`computeCommandHash` are what Zone B actually runs at
// verification time; `mintWs4Assertion` exists so (a) this ticket's own adversarial tests can
// fabricate real, byte-for-byte-correct assertions without a second implementation drifting from
// this one, and (b) platform-nest's own minting code has one canonical reference implementation
// to mirror instead of reinventing the wire format from the design doc's prose alone.
//
// WIRE FORMAT (this ticket's own definition — the design doc specifies the CLAIM SET
// `{approvalId, commandHash, exp}` and "HMAC'd", not exact bytes; documented here and in
// ../../../README.md as the concrete contract platform-nest's minting code must match exactly):
//
//   x-ws4-assertion: <payload>.<hmacHex>
//   payload  = base64url(JSON.stringify({ approvalId, commandHash, exp }))
//   hmacHex  = HMAC-SHA256(payload, WEBDESK_APPROVAL_ASSERTION_KEY) as lowercase hex
//
// The signature covers the LITERAL base64url payload bytes (not a re-serialization of the parsed
// claims) — same reasoning JWS uses: verify what was actually transmitted, never something
// recomputed from parsed-then-reserialized JSON where key order or whitespace could differ.
//
// commandHash = sha256(`${command}:${canonicalArgs}`), hex. `command` is the design's
// `CommandName` string (e.g. "release.promote" — command-types.ts's registry, not a second
// vocabulary). `canonicalArgs` is this file's own deterministic (recursively key-sorted) JSON
// serialization of the caller-visible route params + body merged — see canonicalize() below.
// Zone A must compute this the SAME way when minting, from the same fields it is about to send;
// this is a real cross-zone contract and needs platform-nest-side alignment when that side is
// built — flagged in this ticket's report, not assumed.
//
// ── M4 F1: v2, the asymmetric form (docs/plans/2026-10-11-webdesk-m4-plan.md, "F1") ─────────────
// v1 above needs the HMAC key on BOTH sides, so WebDesk held a secret that could mint approvals.
// v2 is a JWS compact token signed by the ERP's Ed25519 key; WebDesk holds only the public half, in
// the pinned WS4 key set (./ws4-jwks.ts, WEBDESK_WS4_JWKS_FILE). Wire format, byte-pinned by the
// shared vectors in test/ws4-assertion-v2-vectors.spec.ts and
// platform-nest/src/modules/webdev/webdesk-ws4-assertion.test.ts:
//
//   x-ws4-assertion: <b64url(header)>.<b64url(payload)>.<b64url(Ed25519 signature)>
//   header   = {"alg":"EdDSA","kid":"<kid>","typ":"ws4+jwt"}                  (this key order)
//   payload  = {"approvalId","commandHash","exp","aud":"webdesk-control-plane"} (this key order)
//   signed   = the ASCII bytes of `<b64url(header)>.<b64url(payload)>` (RFC 7515 signing input)
//
// The verifier tells the versions apart by shape ONLY: two dot-separated parts is v1, three is v2,
// anything else is malformed. It never guesses from content. verifyWs4Assertion() below is the one
// entry point Layer 4 (real-policy-decision-point.ts) calls; it runs v1 only while the HMAC key is
// configured and v2 only while the WS4 key set is installed.
//
// v2 CHECK ORDER, and the refusal code each step answers with (WS4_REFUSAL):
//   0. no WS4 key set installed                                        ws4-v2-unavailable
//   1. not three base64url segments, too long, non-canonical base64url ws4-malformed
//      protected header not a JSON object                              ws4-malformed
//   2. alg ≠ "EdDSA" (none, HS*, RS*, ES*, PS*, …)                     ws4-alg-refused
//      decided from the header BEFORE any key is touched, so the HS256-keyed-with-the-public-key
//      confusion has no code path at all: this file never computes an HMAC for a three-part token.
//   3. header members other than exactly {alg, kid, typ} (crit, jwk, jku, x5u, x5c, b64, cty, …)
//                                                                       ws4-header-invalid
//   4. typ ≠ "ws4+jwt" (e.g. the editorial "wd-editorial+jwt")         ws4-typ-invalid
//   5. kid absent, or not in the WS4 key set (an editorial kid never is) ws4-unknown-key
//   6. Ed25519 signature (node:crypto verify, the looked-up key only)  ws4-signature-invalid
//   7. payload not a JSON object                                       ws4-claims-invalid
//   8. aud missing or ≠ "webdesk-control-plane" (an array is refused)  ws4-aud-invalid
//   9. approvalId / commandHash / exp shapes                           ws4-claims-invalid
//  10. now ≥ exp (v1's rule exactly: no extra skew)                    ws4-expired
// Layer 4 then compares commandHash with the request and enforces single use by approvalId, the
// same for both versions.
import { createHmac, createHash, timingSafeEqual, verify as cryptoVerify } from "node:crypto";
import type { Ws4KeySet } from "./ws4-jwks";

export interface Ws4Claims {
  approvalId: string;
  commandHash: string;
  /** Unix seconds. */
  exp: number;
}

export type Ws4VerifyResult = { ok: true; claims: Ws4Claims } | { ok: false; reason: string };

export function mintWs4Assertion(claims: Ws4Claims, key: string): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const sig = createHmac("sha256", key).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

export function verifyWs4Signature(header: string, key: string): Ws4VerifyResult {
  const dot = header.indexOf(".");
  if (dot < 0 || header.indexOf(".", dot + 1) !== -1) {
    return { ok: false, reason: "malformed x-ws4-assertion (expected exactly one '.' separating payload and signature)" };
  }
  const payload = header.slice(0, dot);
  const sig = header.slice(dot + 1);

  const expectedSig = createHmac("sha256", key).update(payload).digest("hex");
  const provided = Buffer.from(sig, "hex");
  const expected = Buffer.from(expectedSig, "hex");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: "WS4 assertion signature invalid (HMAC mismatch — tampered or wrong key)" };
  }

  let claims: Ws4Claims;
  try {
    const json = Buffer.from(payload, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as Partial<Ws4Claims>;
    if (typeof parsed.approvalId !== "string" || typeof parsed.commandHash !== "string" || typeof parsed.exp !== "number") {
      return { ok: false, reason: "WS4 assertion payload missing one of approvalId/commandHash/exp" };
    }
    claims = { approvalId: parsed.approvalId, commandHash: parsed.commandHash, exp: parsed.exp };
  } catch (err) {
    return { ok: false, reason: `WS4 assertion payload is not valid JSON: ${(err as Error).message}` };
  }

  if (Math.floor(Date.now() / 1000) >= claims.exp) {
    return { ok: false, reason: "WS4 assertion expired" };
  }

  return { ok: true, claims };
}

export function computeCommandHash(command: string, args: unknown): string {
  return createHash("sha256").update(`${command}:${canonicalize(args)}`).digest("hex");
}

/** Deterministic JSON: object keys sorted recursively, arrays keep their order. Exported for WSK-41: the
 *  content hash (content-projection.ts contentHash) is sha256 of this same serialization (design §3.3). */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(record[k])}`).join(",")}}`;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// M4 F1 — v2 (EdDSA) and the dual-mode entry point. Nothing above this line changed for F1: the three
// v1 primitives are compared byte for byte with platform-nest's copy by its source-drift test.
// ═════════════════════════════════════════════════════════════════════════════════════════════════

export type Ws4AssertionVersion = 1 | 2;

export const WS4_V2_ALG = "EdDSA";
export const WS4_V2_TYP = "ws4+jwt";
export const WS4_V2_AUD = "webdesk-control-plane";
/** The only protected-header members a v2 token may carry, all three required. */
const WS4_V2_HEADER_MEMBERS: readonly string[] = ["alg", "kid", "typ"];
const MAX_WS4_TOKEN_CHARS = 4096;
const MAX_APPROVAL_ID_CHARS = 200;
const COMMAND_HASH_RE = /^[0-9a-f]{64}$/;
/** Shape only. The third segment may be empty so that `alg: none` is refused BY ITS ALG, not as malformed. */
const THREE_PART_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const ED25519_SIG_BYTES = 64;

export const WS4_REFUSAL = {
  malformed: "ws4-malformed",
  v1Disabled: "ws4-v1-disabled",
  v1Invalid: "ws4-v1-invalid",
  v2Unavailable: "ws4-v2-unavailable",
  algRefused: "ws4-alg-refused",
  headerInvalid: "ws4-header-invalid",
  typInvalid: "ws4-typ-invalid",
  unknownKey: "ws4-unknown-key",
  signatureInvalid: "ws4-signature-invalid",
  audInvalid: "ws4-aud-invalid",
  claimsInvalid: "ws4-claims-invalid",
  expired: "ws4-expired",
} as const;
export type Ws4RefusalCode = (typeof WS4_REFUSAL)[keyof typeof WS4_REFUSAL];

export type Ws4AssertionResult =
  | { ok: true; version: Ws4AssertionVersion; claims: Ws4Claims }
  | { ok: false; version: Ws4AssertionVersion | null; code: Ws4RefusalCode; reason: string };

/** What Layer 4 verifies with. Either may be null; both null means every WS4 assertion is refused. */
export interface Ws4VerifierKeys {
  /** v1 HMAC key, or null when v1 is retired (WEBDESK_APPROVAL_ASSERTION_KEY unset in production). */
  hmacKey: string | null;
  /** v2 public key set, or null when WEBDESK_WS4_JWKS_FILE is not installed. */
  v2Keys: Ws4KeySet | null;
}

function refuse(version: Ws4AssertionVersion | null, code: Ws4RefusalCode, reason: string): Ws4AssertionResult {
  return { ok: false, version, code, reason };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** base64url → bytes, refusing any non-canonical spelling (so one token has exactly one string form). */
function strictB64url(segment: string): Buffer | null {
  const bytes = Buffer.from(segment, "base64url");
  return bytes.toString("base64url") === segment ? bytes : null;
}

/**
 * The single Layer-4 entry point: picks v1 or v2 from the token's SHAPE (two parts or three) and
 * verifies it with that version's key. Pure apart from the signature check; consumes nothing.
 */
export function verifyWs4Assertion(
  header: string,
  keys: Ws4VerifierKeys,
  nowSec: number = Math.floor(Date.now() / 1000),
): Ws4AssertionResult {
  const dots = header.split(".").length - 1;
  if (dots === 2) return verifyWs4AssertionV2(header, keys.v2Keys, nowSec);
  if (dots === 1) {
    if (keys.hmacKey === null) {
      return refuse(
        1,
        WS4_REFUSAL.v1Disabled,
        "WS4 v1 (HMAC) assertions are no longer accepted: WEBDESK_APPROVAL_ASSERTION_KEY is not configured on this instance",
      );
    }
    // v1 keeps its own clock (Date.now) and its own reasons, unchanged: what Layer 4 has always answered.
    const v1 = verifyWs4Signature(header, keys.hmacKey);
    return v1.ok ? { ok: true, version: 1, claims: v1.claims } : refuse(1, WS4_REFUSAL.v1Invalid, v1.reason);
  }
  return refuse(null, WS4_REFUSAL.malformed, "malformed x-ws4-assertion (expected two dot-separated parts for v1 or three for v2)");
}

/** v2 only: the check order in this file's header. */
export function verifyWs4AssertionV2(token: string, keys: Ws4KeySet | null, nowSec: number): Ws4AssertionResult {
  // 0. availability
  if (keys === null) {
    return refuse(2, WS4_REFUSAL.v2Unavailable, "WS4 v2 (EdDSA) assertion presented but no WS4 key set is installed (WEBDESK_WS4_JWKS_FILE)");
  }

  // 1. shape
  if (token.length > MAX_WS4_TOKEN_CHARS || !THREE_PART_RE.test(token)) {
    return refuse(2, WS4_REFUSAL.malformed, "WS4 v2 assertion is not a compact JWS (three base64url segments)");
  }
  const [headerB64, payloadB64, sigB64] = token.split(".");
  const headerBytes = strictB64url(headerB64);
  const payloadBytes = strictB64url(payloadB64);
  const sigBytes = strictB64url(sigB64);
  if (headerBytes === null || payloadBytes === null || sigBytes === null) {
    return refuse(2, WS4_REFUSAL.malformed, "WS4 v2 assertion has a non-canonical base64url segment");
  }
  let header: unknown;
  try {
    header = JSON.parse(headerBytes.toString("utf8"));
  } catch {
    return refuse(2, WS4_REFUSAL.malformed, "WS4 v2 assertion protected header is not JSON");
  }
  if (!isPlainObject(header)) return refuse(2, WS4_REFUSAL.malformed, "WS4 v2 assertion protected header is not a JSON object");

  // 2. algorithm pinned, before any key is looked up
  if (header.alg !== WS4_V2_ALG) {
    return refuse(2, WS4_REFUSAL.algRefused, `WS4 v2 algorithm ${JSON.stringify(header.alg ?? null)} is not accepted (only ${WS4_V2_ALG})`);
  }

  // 3. exactly {alg, kid, typ}: no crit/jwk/jku/x5u/b64 or any other member that could change how it verifies
  for (const member of Object.keys(header)) {
    if (!WS4_V2_HEADER_MEMBERS.includes(member)) {
      return refuse(
        2,
        WS4_REFUSAL.headerInvalid,
        `WS4 v2 protected header member ${JSON.stringify(member.slice(0, 32))} is not accepted (only alg, kid, typ)`,
      );
    }
  }

  // 4. typ: this channel's own, never the editorial one
  if (header.typ !== WS4_V2_TYP) {
    return refuse(2, WS4_REFUSAL.typInvalid, `WS4 v2 typ must be ${JSON.stringify(WS4_V2_TYP)}`);
  }

  // 5. key, by kid, in the WS4 key set only
  const kid = header.kid;
  if (typeof kid !== "string" || kid.length === 0) {
    return refuse(2, WS4_REFUSAL.unknownKey, "WS4 v2 assertion names no kid");
  }
  const key = keys.get(kid);
  if (!key) {
    return refuse(2, WS4_REFUSAL.unknownKey, `WS4 v2 kid ${JSON.stringify(kid.slice(0, 64))} is not in the pinned WS4 JWKS`);
  }

  // 6. signature, Ed25519 only (the key set holds Ed25519 keys only; checked again here)
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, "ascii");
  let valid = false;
  if (sigBytes.length === ED25519_SIG_BYTES && key.asymmetricKeyType === "ed25519") {
    try {
      valid = cryptoVerify(null, signingInput, key, sigBytes);
    } catch {
      valid = false;
    }
  }
  if (!valid) {
    return refuse(2, WS4_REFUSAL.signatureInvalid, "WS4 v2 assertion signature does not verify (tampered, or not signed by that kid)");
  }

  // 7. payload
  let payload: unknown;
  try {
    payload = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return refuse(2, WS4_REFUSAL.claimsInvalid, "WS4 v2 assertion payload is not JSON");
  }
  if (!isPlainObject(payload)) return refuse(2, WS4_REFUSAL.claimsInvalid, "WS4 v2 assertion payload is not a JSON object");

  // 8. audience: this control plane, as a single string
  if (payload.aud === undefined) {
    return refuse(2, WS4_REFUSAL.audInvalid, `WS4 v2 aud is missing (must be ${JSON.stringify(WS4_V2_AUD)})`);
  }
  if (payload.aud !== WS4_V2_AUD) return refuse(2, WS4_REFUSAL.audInvalid, `WS4 v2 aud must be ${JSON.stringify(WS4_V2_AUD)}`);

  // 9. claim shapes
  const { approvalId, commandHash, exp } = payload;
  if (typeof approvalId !== "string" || approvalId.length === 0 || approvalId.length > MAX_APPROVAL_ID_CHARS) {
    return refuse(2, WS4_REFUSAL.claimsInvalid, `WS4 v2 approvalId must be a non-empty string (max ${MAX_APPROVAL_ID_CHARS})`);
  }
  if (typeof commandHash !== "string" || !COMMAND_HASH_RE.test(commandHash)) {
    return refuse(2, WS4_REFUSAL.claimsInvalid, "WS4 v2 commandHash must be a lowercase sha256 hex digest");
  }
  if (typeof exp !== "number" || !Number.isSafeInteger(exp)) {
    return refuse(2, WS4_REFUSAL.claimsInvalid, "WS4 v2 exp must be an integer NumericDate");
  }

  // 10. time: v1's rule exactly
  if (nowSec >= exp) return refuse(2, WS4_REFUSAL.expired, "WS4 assertion expired");

  return { ok: true, version: 2, claims: { approvalId, commandHash, exp } };
}

/**
 * UNVERIFIED peek at an `x-ws4-assertion`: its version (from the shape) and its approvalId (v1: the
 * first segment; v2: the second, the payload). Only for populating ControlContext.ws4ApprovalId and
 * the editorial `apr` comparison: Layer 4 has verified the same header (signature, expiry,
 * commandHash, single use) before any HIGH command runs, which is the only case the value is used.
 */
export function peekWs4Assertion(header: string | null | undefined): { version: Ws4AssertionVersion; approvalId: string } | null {
  if (!header) return null;
  const parts = header.split(".");
  if (parts.length !== 2 && parts.length !== 3) return null;
  const version: Ws4AssertionVersion = parts.length === 3 ? 2 : 1;
  const claimsSegment = version === 2 ? parts[1] : parts[0];
  if (claimsSegment.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(claimsSegment, "base64url").toString("utf8"));
    if (!isPlainObject(parsed) || typeof parsed.approvalId !== "string" || parsed.approvalId.length === 0) return null;
    return { version, approvalId: parsed.approvalId };
  } catch {
    return null;
  }
}
