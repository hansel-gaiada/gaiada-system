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
import { createHmac, createHash, timingSafeEqual } from "node:crypto";

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

/** Deterministic JSON: object keys sorted recursively, arrays keep their order. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(record[k])}`).join(",")}}`;
}
