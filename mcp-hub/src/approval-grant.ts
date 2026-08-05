// D14-04 — the HUB side of the single-use execution grant.
//
// Contract: `docs/superpowers/plans/2026-08-05-d14-and-assistant-tickets.md` §1 (architect-fixed;
// platform-nest's D14-03 implements the minting half against the same contract, neither side may
// change it unilaterally).
//
//   Transport : HTTP header `x-approval-grant` on the hub tool call.
//   Value     : base64url(payloadJson) + "." + base64url(hmacSha256(APPROVAL_GRANT_SECRET, base64url(payloadJson)))
//   Payload   : { v: 1, approvalId, tenantId, toolName, argsSha256, iat, exp, nonce }, exp − iat ≤ 120s
//
// What a VALID grant buys (and nothing else): it lifts ONLY the D14 impact suspension on writes —
// in BOTH places that gate is encoded (corrected 2026-08-05 by D14-13; the original claim that the
// Cerbos decision was untouched was wrong, and would have left every granted automation re-drive
// Cerbos-DENIED in prod):
//   1. the `tool.write && tool.impact !== "low"` branch inside policy.ts's automation gate, and
//   2. the same conjunct in `platform-nest/cerbos/policies/resource_mcp_tool.yaml`, reached by
//      cerbos.ts surfacing this grant's `approvalId` as a resource attribute — and there, narrowed
//      further to an explicit executable-tool list (deploy.staging / deploy.production), mirroring
//      platform-nest/src/core/approval-executables.ts.
// Assurance rank, the workflow's AUTOMATION_ALLOWLIST scope, and every OTHER Cerbos condition are
// evaluated completely unchanged — in the policy the disjunct sits INSIDE the workflow-scope
// conjunction, so a grant can never widen what a principal may reach. It only lifts the "unattended"
// objection to a write a human already approved.
//
// Every failure mode is a REJECTION, and a rejection means the call is authorized exactly as if no
// header had been sent (today's path, today's reason string) — never a new refusal, never fail-open.
// An unset APPROVAL_GRANT_SECRET rejects every grant (fail CLOSED).
//
// ───────────────────────────────────────────────────────────────────────────────────────────────────
// CANONICAL JSON — the exact algorithm D14-03 must mirror byte for byte.
//
// `argsSha256` = lowercase hex SHA-256 of the UTF-8 bytes of `canonicalJson(args)`, where
// canonicalJson is a MANUAL serializer (deliberately not `JSON.stringify` over a rebuilt object —
// JS reorders integer-like keys such as "2" before "10" regardless of insertion order, so relying on
// property order would encode an engine quirk into a cross-service contract):
//
//   1. object  -> "{" + entries.join(",") + "}" where entries are `JSON.stringify(key) + ":" + canon(value)`
//                 and keys come from `Object.keys(obj).sort()` — the DEFAULT sort, i.e. ascending
//                 UTF-16 code-unit order. NOT localeCompare, NOT case-insensitive, NOT byte order
//                 (they differ only for astral-plane/locale-sensitive keys, which arg names must avoid).
//                 Recursive: nested objects are canonicalized the same way, at every depth.
//   2. array   -> "[" + elements.map(canon).join(",") + "]" — ORDER IS PRESERVED (arrays are data,
//                 not sets). An `undefined` element serializes as `null` (JSON.stringify semantics).
//   3. string  -> `JSON.stringify(str)`: minimal escaping, so only `"` `\` and C0 control chars are
//                 escaped; every other code point is emitted LITERALLY as UTF-8 (no \uXXXX escaping
//                 of non-ASCII, no NFC/NFKC normalization — "é" precomposed and "é" decomposed
//                 hash DIFFERENTLY and are deliberately different args). Lone surrogates are escaped
//                 as \udXXX by JSON.stringify (well-formed-stringify, ES2019+) on both sides.
//   4. number  -> `JSON.stringify(n)` (shortest round-trip form: `1`, `1.5`, `-0` -> `0`, `1e+21`).
//                 NaN/±Infinity -> `null`, matching JSON.stringify.
//   5. boolean -> "true" / "false";  null -> "null"
//   6. An object key whose value is `undefined` is OMITTED entirely (JSON.stringify semantics), as
//      are function/symbol values. There are no separators or indentation anywhere: no spaces after
//      `:` or `,`.
//   7. Top-level `undefined` canonicalizes to "null" (never happens in practice: args default to {}).
//
// Fixed vectors (asserted in approval-grant.test.ts — copy them into the platform-side test):
//   canonicalJson({})                                   = "{}"
//     sha256 = 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a
//   canonicalJson({ b:1, a:{ d:1, c:[3,{ y:2, x:1 }] } }) = {"a":{"c":[3,{"x":1,"y":2}],"d":1},"b":1}
//     sha256 = f2b017ad2046767a1fb4a845843b145aef66713aa8adef3952e980dc15f44ce4
//   canonicalJson({ runId:"r1", repo:"acme/site" })       = {"repo":"acme/site","runId":"r1"}
//     sha256 = 756a6e9ac2f5873539d73f9a95008a46ed673573ade26e86ff42a6b27b1f9dad
//
// The hub recomputes this over the ACTUAL call arguments (`req.params.arguments ?? {}`), so the
// approval binds one exact call. Platform side: hash the approval row's stored `tool_args` jsonb
// EXACTLY as it will be sent to the hub (same JSON value — if the executor adds or drops a field on
// the way out, the hashes disagree and the grant is rejected, which is the intended fail-closed).
//
// ENCODING TOLERANCE (interop safety, not a weakening): the contract does not pin the units of
// iat/exp nor the encoding of argsSha256 / the signature. Because a unit or encoding mismatch across
// the two services would silently reject EVERY grant (a deny-everything bug that no happy-path test
// on either side would catch), this verifier accepts all equivalent encodings of the same value:
//   • iat/exp — epoch MILLISECONDS (canonical, `Date.now()`) or epoch SECONDS. Values < 1e11 are
//     read as seconds, larger as milliseconds (unambiguous for any date between 1973 and year 5138).
//     Each claim is normalized INDEPENDENTLY to an absolute instant, so even a mixed-unit payload
//     resolves to the instants the minter meant; the ≤120s window and the expiry check are applied
//     after normalization, so a too-long window is caught in either unit.
//   • argsSha256 — lowercase or uppercase hex (canonical: lowercase hex), or base64 / base64url of
//     the same 32 digest bytes.
//   • signature — base64url (canonical), base64, or lowercase/uppercase hex of the same HMAC bytes.
// All of these are different spellings of one authenticated value; accepting them admits no input
// that a single spelling would have rejected as authentic.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config";

/** The transport header (contract §1). Lower-case: Node normalizes incoming header names. */
export const APPROVAL_GRANT_HEADER = "x-approval-grant";

/** exp − iat must be ≤ 120s (contract §1). */
export const GRANT_MAX_WINDOW_MS = 120_000;

/** Forward clock-skew allowance on `iat`. Without a bound, a minter with a fast clock (or a stolen
 *  secret and a chosen `iat`) could keep a grant alive far beyond the 120s the contract promises. */
export const GRANT_MAX_FORWARD_SKEW_MS = 60_000;

/** A grant is ~300 bytes; anything much larger is not one (cheap DoS floor before any HMAC work). */
const GRANT_MAX_HEADER_CHARS = 4096;

/** Stable rejection codes — they land in the JSONL tool audit, so treat them as a contract too. */
export type GrantRejection =
  | "secret_not_configured"
  | "malformed"
  | "bad_signature"
  | "unsupported_version"
  | "bad_claims"
  | "bad_window"
  | "expired"
  | "not_yet_valid"
  | "tool_mismatch"
  | "tenant_mismatch"
  | "args_mismatch"
  | "replayed_nonce";

// Brand: a VerifiedExecutionGrant can only be produced by verifyExecutionGrant() in this module.
// policy.ts's suspend-skip therefore cannot be reached by handing it a plain object or a parsed-but-
// unverified payload — the one shape of fail-open this ticket must not allow.
declare const verifiedGrantBrand: unique symbol;

export interface VerifiedExecutionGrant {
  readonly [verifiedGrantBrand]: true;
  readonly approvalId: string;
  readonly tenantId: string;
  readonly toolName: string;
  readonly argsSha256: string;
  readonly nonce: string;
  /** Normalized to epoch milliseconds regardless of the units the minter used. */
  readonly iatMs: number;
  readonly expMs: number;
}

export type GrantVerdict =
  | { ok: true; grant: VerifiedExecutionGrant }
  /** `approvalId` is present ONLY when the signature verified — an unauthenticated payload's claims
   *  are attacker-controlled and are never promoted into the audit as facts. */
  | { ok: false; reason: GrantRejection; approvalId?: string };

// ───────────────────────────────── canonical JSON + args digest ─────────────────────────────────

/** One value, canonically serialized. `undefined` for values JSON.stringify omits from objects. */
function canon(value: unknown): string | undefined {
  if (value === null) return "null";
  switch (typeof value) {
    case "undefined":
      return undefined;
    case "boolean":
      return value ? "true" : "false";
    case "number":
      // JSON.stringify already emits the shortest round-trip form and "null" for non-finite.
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "string":
      return JSON.stringify(value);
    case "bigint":
      // JSON.stringify throws on bigint; args arrive as parsed JSON so this cannot occur from the
      // wire. Serialize as a decimal string rather than crashing the authorization path.
      return JSON.stringify(value.toString());
    case "function":
    case "symbol":
      return undefined;
    case "object": {
      if (Array.isArray(value)) return `[${value.map((el) => canon(el) ?? "null").join(",")}]`;
      const obj = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(obj).sort()) {
        const encoded = canon(obj[key]);
        if (encoded === undefined) continue; // JSON.stringify drops undefined-valued keys
        parts.push(`${JSON.stringify(key)}:${encoded}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      return undefined;
  }
}

/** Canonical JSON per the algorithm documented at the top of this file. */
export function canonicalJson(value: unknown): string {
  return canon(value) ?? "null";
}

/** SHA-256 over canonicalJson(args), lowercase hex — the canonical `argsSha256` spelling. */
export function computeArgsSha256(args: unknown): string {
  return createHash("sha256").update(canonicalJson(args), "utf8").digest("hex");
}

// ───────────────────────────────────── encodings + comparisons ──────────────────────────────────

function base64urlDecode(part: string): Buffer {
  // Liberal in what we accept: normalize a standard-base64 alphabet to base64url before decoding.
  // Safe because the HMAC was already verified over the EXACT string received, not over the decode.
  return Buffer.from(part.replace(/\+/g, "-").replace(/\//g, "_"), "base64url");
}

/** Constant-time (per candidate) comparison of a provided MAC against every equivalent encoding of
 *  the expected MAC bytes. Length differences short-circuit — a length leak is standard and carries
 *  no information about the key. */
function macMatches(expected: Buffer, provided: string): boolean {
  const candidates = [
    expected.toString("base64url"),
    expected.toString("base64"),
    expected.toString("hex"),
  ];
  const given = Buffer.from(provided, "utf8");
  let matched = false;
  for (const candidate of candidates) {
    const cb = Buffer.from(candidate, "utf8");
    // Never early-return: keep the work uniform across candidates.
    if (cb.length === given.length && timingSafeEqual(cb, given)) matched = true;
  }
  if (!matched && /^[0-9a-fA-F]+$/.test(provided)) {
    const hex = expected.toString("hex");
    const lower = Buffer.from(provided.toLowerCase(), "utf8");
    const hb = Buffer.from(hex, "utf8");
    if (hb.length === lower.length && timingSafeEqual(hb, lower)) matched = true;
  }
  return matched;
}

/** Does `claim` spell the same 32 digest bytes as `expectedHex`? (hex either case, or base64/url.) */
function digestMatches(expectedHex: string, claim: string): boolean {
  const c = claim.trim();
  if (/^[0-9a-fA-F]{64}$/.test(c)) return c.toLowerCase() === expectedHex;
  const bytes = Buffer.from(expectedHex, "hex");
  return c === bytes.toString("base64") || c === bytes.toString("base64url");
}

/** Epoch seconds OR milliseconds -> milliseconds (see ENCODING TOLERANCE at the top). */
function toMs(claim: number): number {
  return claim < 1e11 ? Math.round(claim * 1000) : Math.round(claim);
}

// ─────────────────────────────────────── nonce cache (v1) ───────────────────────────────────────
//
// BEST-EFFORT, IN-MEMORY, TTL'd — and that is deliberate. The AUTHORITATIVE single-use guarantee is
// platform-side: the grant is minted only inside D14-03's `pending → executing` claimed transition,
// which can succeed exactly once per approval row. This cache is a second, cheap wall that catches a
// replay against THIS hub process within the grant's ≤120s life. The v1 hub is single-instance
// (same deferral class as its in-memory rate limiter, plan §5.7); if the hub ever goes
// multi-instance, replace this with the Redis-backed store — do NOT build a distributed nonce store
// here, and do NOT let anything depend on this cache being authoritative.
const usedNonces = new Map<string, number>(); // nonce -> expiry (epoch ms)
const NONCE_PRUNE_THRESHOLD = 512;

function pruneNonces(now: number): void {
  for (const [nonce, expiry] of usedNonces) if (expiry <= now) usedNonces.delete(nonce);
}

/** Claim a nonce for its remaining lifetime. False = already used (replay). */
function consumeNonce(nonce: string, expMs: number, now: number): boolean {
  if (usedNonces.size >= NONCE_PRUNE_THRESHOLD) pruneNonces(now);
  const seen = usedNonces.get(nonce);
  if (seen !== undefined && seen > now) return false;
  usedNonces.set(nonce, expMs);
  return true;
}

/** Test/ops helper — clears the best-effort replay cache. */
export function resetGrantNonceCache(): void {
  usedNonces.clear();
}

// ────────────────────────────────────────── verification ────────────────────────────────────────

interface GrantPayload {
  v: unknown;
  approvalId: unknown;
  tenantId: unknown;
  toolName: unknown;
  argsSha256: unknown;
  iat: unknown;
  exp: unknown;
  nonce: unknown;
}

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/**
 * Verify a presented `x-approval-grant` against the ACTUAL call. Order matters and is part of the
 * security property: the signature is checked BEFORE any payload claim is parsed or trusted, and the
 * nonce is consumed LAST so an invalid grant can never burn a nonce.
 */
export function verifyExecutionGrant(
  header: string,
  call: { toolName: string; args: Record<string, unknown> },
  now: number = Date.now(),
): GrantVerdict {
  // Fail CLOSED on an unconfigured secret: every grant is rejected, so the impact gate keeps
  // suspending exactly as it does today. Never "no secret ⇒ skip verification".
  const secret = config.approvalGrantSecret;
  if (!secret) return { ok: false, reason: "secret_not_configured" };

  if (typeof header !== "string") return { ok: false, reason: "malformed" }; // duplicated header etc.
  const raw = header.trim();
  if (!raw || raw.length > GRANT_MAX_HEADER_CHARS) return { ok: false, reason: "malformed" };

  const parts = raw.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [payloadPart, signaturePart] = parts;
  if (!payloadPart || !signaturePart) return { ok: false, reason: "malformed" };
  if (!/^[A-Za-z0-9_\-+/]+={0,2}$/.test(payloadPart)) return { ok: false, reason: "malformed" };

  // (4) Signature FIRST, timing-safe, over the exact received payload string.
  const expectedMac = createHmac("sha256", secret).update(payloadPart, "utf8").digest();
  if (!macMatches(expectedMac, signaturePart)) return { ok: false, reason: "bad_signature" };

  // Signature verified — from here the claims are authenticated and may be parsed.
  let payload: GrantPayload;
  try {
    const decoded = base64urlDecode(payloadPart).toString("utf8");
    const parsed = JSON.parse(decoded) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "malformed" };
    payload = parsed as GrantPayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  if (payload.v !== 1) return { ok: false, reason: "unsupported_version" };

  if (
    !isNonEmptyString(payload.approvalId) ||
    !isNonEmptyString(payload.tenantId) ||
    !isNonEmptyString(payload.toolName) ||
    !isNonEmptyString(payload.argsSha256) ||
    !isNonEmptyString(payload.nonce) ||
    typeof payload.iat !== "number" ||
    typeof payload.exp !== "number" ||
    !Number.isFinite(payload.iat) ||
    !Number.isFinite(payload.exp)
  ) {
    return { ok: false, reason: "bad_claims" };
  }
  const approvalId = payload.approvalId;

  const iatMs = toMs(payload.iat);
  const expMs = toMs(payload.exp);
  const window = expMs - iatMs;
  if (window <= 0 || window > GRANT_MAX_WINDOW_MS) return { ok: false, reason: "bad_window", approvalId };
  if (now >= expMs) return { ok: false, reason: "expired", approvalId };
  if (iatMs - now > GRANT_MAX_FORWARD_SKEW_MS) return { ok: false, reason: "not_yet_valid", approvalId };

  if (payload.toolName !== call.toolName) return { ok: false, reason: "tool_mismatch", approvalId };

  // Tenant binding. Most hub tools carry the tenant IN their args (`tenantId`), in which case this is
  // an explicit check; for the few that don't (e.g. deploy.* dispatch webhooks, which are not
  // tenant-scoped at all) the binding is carried by argsSha256 + the platform-side single-use claim.
  // A grant can therefore never be moved onto a DIFFERENT tenant's call whose args name the tenant.
  const callTenant = call.args.tenantId;
  if (typeof callTenant === "string" && callTenant !== payload.tenantId) {
    return { ok: false, reason: "tenant_mismatch", approvalId };
  }

  if (!digestMatches(computeArgsSha256(call.args), payload.argsSha256)) {
    return { ok: false, reason: "args_mismatch", approvalId };
  }

  // LAST: single-use. Only a fully valid grant burns its nonce.
  if (!consumeNonce(payload.nonce, expMs, now)) return { ok: false, reason: "replayed_nonce", approvalId };

  const grant = {
    approvalId,
    tenantId: payload.tenantId,
    toolName: payload.toolName,
    argsSha256: payload.argsSha256,
    nonce: payload.nonce,
    iatMs,
    expMs,
  } as unknown as VerifiedExecutionGrant;
  return { ok: true, grant };
}

/** Does this verified grant authorize THIS tool? Defence in depth — hub.ts already verified the
 *  grant against the actual call, so a mismatch here would mean an internal plumbing bug; treat it
 *  as "no grant" rather than trusting it. */
export function grantAuthorizesTool(grant: VerifiedExecutionGrant | undefined, toolName: string): boolean {
  return !!grant && grant.toolName === toolName;
}

/**
 * REFERENCE MINTER — the executable spelling of the contract, for the hub's own tests and as the
 * shape platform-nest's D14-03 must reproduce. The hub NEVER mints grants in production: minting is
 * the platform's `pending → executing` claim, which is what makes single-use authoritative.
 */
export function signGrantPayload(
  payload: { v: 1; approvalId: string; tenantId: string; toolName: string; argsSha256: string; iat: number; exp: number; nonce: string },
  secret: string,
): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const mac = createHmac("sha256", secret).update(encoded, "utf8").digest("base64url");
  return `${encoded}.${mac}`;
}
