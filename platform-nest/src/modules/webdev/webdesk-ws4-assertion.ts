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
import { createHash, createHmac } from "node:crypto";

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

/**
 * Mint the `x-ws4-assertion` header value for one command. The claim object is built here, in the
 * fixed key order `{approvalId, commandHash, exp}` that WebDesk's own minting uses, so the bytes match
 * a WebDesk-side mint of the same claims exactly (the signature covers the literal payload bytes, so
 * key order would not break verification, but byte identity is what the shared vectors pin).
 */
export function mintWs4ForCommand(input: {
  key: string;
  approvalId: string;
  command: string;
  args: unknown;
  /** Unix seconds; injectable for tests. */
  nowSec?: number;
  ttlSec?: number;
}): string {
  if (!input.key) throw new Error("WS4 minting refused: no assertion key configured");
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
  return mintWs4Assertion(claims, input.key);
}
