// WSK-63b — the ERP (Zone A) side of the WebDesk control channel's Layer 4: minting the WS4 assertion.
// Design: docs/plans/2026-10-10-webdesk-write-plane-design.md §11 (last paragraph) + §12 WSK-63b.
//
// ── BYTE-IDENTICAL TO WEBDESK'S VERIFIER, ON PURPOSE ──────────────────────────────────────────────
// Zone B verifies with `webdesk/api/src/control/auth/ws4-assertion.ts` (`verifyWs4Signature` +
// `computeCommandHash`). The NestJS api there cannot be imported from here (separate project, separate
// build), so the three primitives below are a COPY of that file's, statement for statement:
//
//   x-ws4-assertion: <payload>.<hmacHex>
//   payload     = base64url(JSON.stringify({ approvalId, commandHash, exp }))
//   hmacHex     = HMAC-SHA256(payload, key) as lowercase hex   (key = WebDesk's WEBDESK_APPROVAL_ASSERTION_KEY)
//   commandHash = sha256(`${command}:${canonicalize(args)}`) hex
//   canonicalize = JSON with object keys sorted recursively, arrays in order
//
// Drift is caught by fixed vectors asserted on BOTH sides (this file's test and
// `webdesk/api/test/ws4-assertion-vectors.spec.ts` carry the same literals). Change one side and
// one of those two tests goes red. Do not "improve" canonicalize() here (e.g. to drop undefined
// or to sort arrays): the only correct version is the one Zone B runs.
//
// ── WHAT `args` IS (the part the hash depends on and the design prose does not spell out) ─────────
// Zone B's CommandAuthorizationGuard builds args as `{ ...request.params, ...request.body }` —
// route params FIRST, body SECOND (a body key wins a collision), from the request AS RECEIVED: the
// params are the URL-decoded path segments under the route's own param names (e.g. `tenantSlug`,
// not `slug`), and the body is whatever JSON.parse produced. `commandArgsAsZoneBSeesThem()` rebuilds
// exactly that from what the ERP is about to send, including the JSON round-trip (so an `undefined`
// field, a Date or a class instance hashes the way it will look on the wire, not the way it looks in
// memory). Query strings are NOT part of args on Zone B, so they are not part of it here.
//
// ── M4 F1: v2, the asymmetric assertion (docs/plans/2026-10-11-webdesk-m4-plan.md, "F1") ─────────
// v1 above needs the HMAC key on BOTH sides, so WebDesk held a secret that could mint approvals. v2 is
// a JWS compact token signed with an Ed25519 key only the ERP holds; WebDesk verifies it against the
// public half in its pinned WS4 JWKS file (webdesk/api/src/control/auth/ws4-jwks.ts). Wire format,
// byte-pinned by the shared vectors in this file's test AND in
// webdesk/api/test/ws4-assertion-v2-vectors.spec.ts (change one side and both go red):
//
//   x-ws4-assertion: <b64url(header)>.<b64url(payload)>.<b64url(Ed25519 signature)>
//   header   = {"alg":"EdDSA","kid":"<kid>","typ":"ws4+jwt"}                  (this key order)
//   payload  = {"approvalId","commandHash","exp","aud":"webdesk-control-plane"} (this key order)
//   signed   = the ASCII bytes of `<b64url(header)>.<b64url(payload)>` (RFC 7515 signing input)
//
// Ed25519 is deterministic, so (key, claims) gives exactly one string. The same `commandHash` and the
// same args as v1. mintWs4ForCommand() mints v2 whenever a WS4 signing key is configured, else v1.
//
// KEY CUSTODY: the same as the editorial signing key (webdesk-editorial-signer.ts). A PKCS8 PEM FILE
// (WEBDESK_CONTROL_WS4_SIGNING_KEY_FILE, a read-only mount: infra/compose/docker-compose.vps.yml), read
// once into a KeyObject that the control client holds in a `#private` field; no message names key bytes.
// A NEW key pair (kid `ws4-<yyyy-mm>`), never the editorial key: WebDesk refuses to boot if its WS4 and
// editorial key sets share a kid or a key. infra/runbooks/webdesk-ws4-keys.md.
import { createHash, createHmac, createPrivateKey, sign as cryptoSign, type KeyObject } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

export interface Ws4Claims {
  approvalId: string;
  commandHash: string;
  /** Unix seconds. */
  exp: number;
}

// ── The three primitives: copied verbatim from webdesk/api/src/control/auth/ws4-assertion.ts ─────

export function mintWs4Assertion(claims: Ws4Claims, key: string): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const sig = createHmac("sha256", key).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

export function computeCommandHash(command: string, args: unknown): string {
  return createHash("sha256").update(`${command}:${canonicalize(args)}`).digest("hex");
}

/** Deterministic JSON: object keys sorted recursively, arrays keep their order. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(record[k])}`).join(",")}}`;
}

// ── ERP-side helpers (not in WebDesk's file; they only decide WHAT goes into the primitives) ─────

/** Default assertion lifetime. §5's skew table: the ERP mints short-lived assertions (60 s); Zone B's
 *  WS4 check is `now < exp` with no extra skew. One box today, so clock skew is NTP-bounded (< 1 s,
 *  WSK-63a's acceptance criterion). */
export const DEFAULT_WS4_TTL_SEC = 60;

/**
 * The args object Zone B will hash, rebuilt from what the ERP is about to send: route params first,
 * then the JSON-round-tripped body, exactly as `CommandAuthorizationGuard` merges them.
 */
export function commandArgsAsZoneBSeesThem(
  params: Readonly<Record<string, string>>,
  body: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  const wireBody = body === undefined ? {} : (JSON.parse(JSON.stringify(body)) as Record<string, unknown>);
  return { ...params, ...wireBody };
}

// ── M4 F1: the v2 primitive and the WS4 signing key ──────────────────────────────────────────────

export const WS4_V2_ALG = "EdDSA";
export const WS4_V2_TYP = "ws4+jwt";
export const WS4_V2_AUD = "webdesk-control-plane";
const WS4_KID_RE = /^[A-Za-z0-9._-]{1,64}$/;
// Built from parts so the repo's secret-scanning pre-commit hook (which greps for the literal PEM
// header) does not mistake this pattern for key material (same as webdesk-editorial-signer.ts).
const WS4_PEM_LABEL = ["PRIVATE", "KEY"].join(" ");
const WS4_PKCS8_PEM_RE = new RegExp(`-----BEGIN ${WS4_PEM_LABEL}-----[\\s\\S]+-----END ${WS4_PEM_LABEL}-----`);

/** The ERP's WS4 v2 signing key: an Ed25519 private KeyObject and the kid WebDesk's WS4 JWKS knows it by. */
export interface Ws4SigningKey {
  readonly privateKey: KeyObject;
  readonly kid: string;
}

export class Ws4SigningKeyError extends Error {
  constructor(reason: string) {
    super(`webdesk WS4 v2 signing key not usable: ${reason}`);
    this.name = "Ws4SigningKeyError";
  }
}

function assertWs4SigningKey(signing: Ws4SigningKey): void {
  if (typeof signing.kid !== "string" || !WS4_KID_RE.test(signing.kid)) throw new Ws4SigningKeyError(`kid must match ${WS4_KID_RE}`);
  if (signing.privateKey.type !== "private" || signing.privateKey.asymmetricKeyType !== "ed25519") {
    throw new Ws4SigningKeyError("the WS4 signing key must be an Ed25519 private key");
  }
}

/**
 * The v2 primitive: a compact JWS over the pinned header and payload, in the pinned key order.
 * Synchronous (node:crypto Ed25519), like the v1 primitive, so the control client mints either inline.
 */
export function mintWs4AssertionV2(claims: Ws4Claims, signing: Ws4SigningKey): string {
  assertWs4SigningKey(signing);
  const header = Buffer.from(JSON.stringify({ alg: WS4_V2_ALG, kid: signing.kid, typ: WS4_V2_TYP }), "utf8").toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ approvalId: claims.approvalId, commandHash: claims.commandHash, exp: claims.exp, aud: WS4_V2_AUD }),
    "utf8",
  ).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const sig = cryptoSign(null, Buffer.from(signingInput, "ascii"), signing.privateKey).toString("base64url");
  return `${signingInput}.${sig}`;
}

/** Parses + checks a PKCS8 PEM Ed25519 private key. Throws Ws4SigningKeyError, never echoing key bytes. */
export function ws4PrivateKeyFromPem(pem: string | Buffer, source: string): KeyObject {
  const text = typeof pem === "string" ? pem : pem.toString("utf8");
  if (!WS4_PKCS8_PEM_RE.test(text)) throw new Ws4SigningKeyError(`${source} is not a complete PKCS8 PEM (${text.length} bytes)`);
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: text, format: "pem" });
  } catch (err) {
    throw new Ws4SigningKeyError(`${source} does not parse as a private key (${(err as Error).message})`);
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Ws4SigningKeyError(`${source} is a ${key.asymmetricKeyType ?? "unknown"} key; the WS4 signing key must be Ed25519`);
  }
  return key;
}

export type Ws4SigningKeyLoad =
  | { state: "configured"; signing: Ws4SigningKey }
  /** No kid set: the operator has not switched to v2. The client mints v1 (if its HMAC key is set). */
  | { state: "not-configured"; reason: string }
  /** A kid IS set but the key is unusable: the operator asked for v2 and it cannot be honoured. The
   *  client then refuses every WS4-bearing call (503) rather than silently falling back to v1. */
  | { state: "invalid"; reason: string };

/**
 * Reads the WS4 signing key named by `kid` from `keyFile` (config.webdeskControl.ws4SigningKid /
 * ws4SigningKeyFile). Never throws. The kid decides intent: unset → not-configured (v1); set → the file
 * must hold a valid Ed25519 PKCS8 key, else `invalid` with a reason naming the file, never its bytes.
 */
export function loadWs4SigningKey(o: { keyFile: string; kid: string }): Ws4SigningKeyLoad {
  if (!o.kid) return { state: "not-configured", reason: "WEBDESK_CONTROL_WS4_SIGNING_KID is not set" };
  if (!WS4_KID_RE.test(o.kid)) return { state: "invalid", reason: `WEBDESK_CONTROL_WS4_SIGNING_KID must match ${WS4_KID_RE}` };
  if (!o.keyFile) return { state: "invalid", reason: "WEBDESK_CONTROL_WS4_SIGNING_KEY_FILE is not set" };
  const source = `WEBDESK_CONTROL_WS4_SIGNING_KEY_FILE ('${o.keyFile}')`;
  try {
    let isFile = false;
    try {
      isFile = statSync(o.keyFile).isFile();
    } catch (err) {
      return { state: "invalid", reason: `${source} cannot be read (${(err as NodeJS.ErrnoException).code ?? "error"})` };
    }
    if (!isFile) return { state: "invalid", reason: `${source} is not a regular file` };
    const signing: Ws4SigningKey = { privateKey: ws4PrivateKeyFromPem(readFileSync(o.keyFile), source), kid: o.kid };
    assertWs4SigningKey(signing);
    return { state: "configured", signing };
  } catch (err) {
    return { state: "invalid", reason: err instanceof Error ? err.message : "invalid WS4 signing key" };
  }
}

/**
 * Mint the `x-ws4-assertion` header value for one command: v2 when `signing` is given (M4 F1), else
 * v1 from the HMAC `key`. The claims are built here in the fixed order `{approvalId, commandHash, exp}`
 * (v2 adds `aud` last), so the bytes match the shared vectors exactly.
 */
export function mintWs4ForCommand(input: {
  /** v1 HMAC key (WEBDESK_CONTROL_WS4_KEY). Ignored when `signing` is given. */
  key?: string;
  /** v2 Ed25519 signing key. When present, v2 is minted. */
  signing?: Ws4SigningKey;
  approvalId: string;
  command: string;
  args: unknown;
  /** Unix seconds; injectable for tests. */
  nowSec?: number;
  ttlSec?: number;
}): string {
  if (!input.signing && !input.key) throw new Error("WS4 minting refused: no assertion key configured");
  if (typeof input.approvalId !== "string" || input.approvalId.length === 0) {
    throw new Error("WS4 minting refused: approvalId must be a non-empty string");
  }
  if (typeof input.command !== "string" || input.command.length === 0) {
    throw new Error("WS4 minting refused: command must be a non-empty string");
  }
  const ttl = input.ttlSec ?? DEFAULT_WS4_TTL_SEC;
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > 300) {
    throw new Error("WS4 minting refused: ttlSec must be an integer in 1..300");
  }
  const now = input.nowSec ?? Math.floor(Date.now() / 1000);
  const claims: Ws4Claims = {
    approvalId: input.approvalId,
    commandHash: computeCommandHash(input.command, input.args),
    exp: now + ttl,
  };
  return input.signing ? mintWs4AssertionV2(claims, input.signing) : mintWs4Assertion(claims, input.key as string);
}
