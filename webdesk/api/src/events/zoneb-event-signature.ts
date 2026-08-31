// WSK-12 — the ONE signing algorithm both sides of the B->A channel implement. Design
// §03: "HMAC-SHA256 over the raw request bytes with WEBDESK_EVENT_SECRET, carrying an event id +
// timestamp" + the ticket's own hard rule: "verify the MAC on raw bytes BEFORE JSON parsing, or
// the signature is meaningless."
//
// ── WHY THE TIMESTAMP IS SIGNED TOO, NOT JUST CARRIED ───────────────────────────────────────────
// If only the body were signed, a captured request stays validly-signed forever — an attacker who
// recorded one legitimate webhook could replay it next year and the MAC would still check out.
// Signing `${timestamp}.${rawBody}` (the Stripe/GitHub webhook convention) means the VERIFY side
// can refuse anything outside a tolerance window BEFORE it even touches the body — a second,
// independent defense layered in front of `webdev_zoneb_event_log`'s own (tenant_id, event_id)
// idempotency dedup, which only catches a replay of the SAME event id, not a stale-but-well-formed
// one with a fabricated new id.
//
// ── WHY THIS FILE EXISTS IN webdesk/api/src/events/ AT ALL ──────────────────────────────────────
// The emitter (zoneb-event-emitter.service.ts) is Zone B code Nest can import directly. The
// VERIFIER below is conceptually Zone A/n8n's job — n8n's Code node has no module system to import
// this file from, so `automation/workflows/wd-zoneb-intake.json`'s "Verify HMAC" Code node is a
// hand-transliterated copy of `verifySignature`'s algorithm, not a shared import. Keeping the
// reference implementation here, fully unit-tested (test/events-hmac.spec.ts), is what makes that
// duplication safe: the n8n Code node is reviewed against THIS file rather than against prose.
// Flagged in the ticket report as the one place the two zones' code must be kept in sync by hand.
import { createHmac, timingSafeEqual } from "node:crypto";

export type SignatureVerification = { ok: true } | { ok: false; reason: string };

/** `${timestampMs}.${rawBody}` — never the body alone (see header). `rawBody` MUST be the exact
 *  UTF-8 bytes sent on the wire, not a re-serialization of the parsed object (a re-serialization
 *  can reorder keys or change whitespace and silently break verification on the far side). */
export function signaturePayload(timestampMs: string, rawBody: string): string {
  return `${timestampMs}.${rawBody}`;
}

/** Hex HMAC-SHA256, no `sha256=` prefix — that framing is the header's job, not the algorithm's. */
export function computeSignatureHex(secret: string, timestampMs: string, rawBody: string): string {
  return createHmac("sha256", secret).update(signaturePayload(timestampMs, rawBody), "utf8").digest("hex");
}

/** `sha256=<hex>` — the header value the emitter sends and the verifier parses. */
export function formatSignatureHeader(hex: string): string {
  return `sha256=${hex}`;
}

/**
 * The verify side, run BEFORE any JSON.parse of `rawBody` (the ticket's own ordering rule). Three
 * independent refusal reasons, each proven by its own test case:
 *   - `stale timestamp`   — outside `toleranceMs` of now, in EITHER direction (a clock-skewed or
 *                           maliciously-future-dated timestamp is refused exactly like a stale
 *                           one — accepting "future" would let an attacker pre-mint a signature
 *                           that becomes valid later, defeating the tolerance window's purpose).
 *   - `malformed signature header` — not the `sha256=<hex>` shape at all.
 *   - `signature mismatch` — well-formed, but does not match what THIS secret + THIS raw body +
 *                           THIS timestamp compute to (covers a forged secret, a mutated body, or
 *                           a signature copied from a different request).
 * `timingSafeEqual` requires equal-length buffers; a length mismatch is itself constant-time-safe
 * to short-circuit on (it leaks only "the hex length differed", never which bytes matched), so this
 * still resists a byte-at-a-time timing attack on the actual secret comparison.
 */
export function verifySignature(params: {
  secret: string;
  timestampHeader: string | undefined;
  rawBody: string;
  signatureHeader: string | undefined;
  toleranceMs: number;
  now?: number;
}): SignatureVerification {
  const { secret, timestampHeader, rawBody, signatureHeader, toleranceMs } = params;
  const now = params.now ?? Date.now();

  if (!timestampHeader || !/^\d+$/.test(timestampHeader)) {
    return { ok: false, reason: "missing or malformed timestamp header" };
  }
  const ts = Number(timestampHeader);
  if (Math.abs(now - ts) > toleranceMs) {
    return { ok: false, reason: "stale timestamp — outside the replay-tolerance window" };
  }

  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return { ok: false, reason: "malformed signature header" };
  }
  const providedHex = signatureHeader.slice("sha256=".length);
  if (!/^[0-9a-f]+$/i.test(providedHex)) {
    return { ok: false, reason: "malformed signature header" };
  }

  const expectedHex = computeSignatureHex(secret, timestampHeader, rawBody);
  const providedBuf = Buffer.from(providedHex, "hex");
  const expectedBuf = Buffer.from(expectedHex, "hex");
  if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
    return { ok: false, reason: "signature mismatch" };
  }

  return { ok: true };
}
