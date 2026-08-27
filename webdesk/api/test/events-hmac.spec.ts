// WSK-12 — THE SECURITY INVARIANT (design §03, non-negotiable): "A forged, replayed, or mutated
// webhook may at most create a notification and a log row. It must never cause a privileged
// transition." This suite proves the FIRST line of defense that makes that true — the HMAC check
// that must pass BEFORE any JSON.parse of the body — by exercising `verifySignature()`, the exact
// reference implementation `automation/workflows/wd-zoneb-intake.json`'s "Verify HMAC" Code node
// hand-transliterates (see zoneb-event-signature.ts's own header for why the two cannot share an
// import across the zone boundary). No infrastructure needed — pure functions, no DB/HTTP.
import { describe, it, expect } from "vitest";
import {
  computeSignatureHex, formatSignatureHeader, verifySignature,
} from "../src/events/zoneb-event-signature";

const SECRET = "wsk12-test-secret-never-used-outside-this-suite";
const OTHER_SECRET = "a-different-secret-an-attacker-might-guess";
const TOLERANCE_MS = 5 * 60_000;

function sign(secret: string, timestampMs: string, rawBody: string): string {
  return formatSignatureHeader(computeSignatureHex(secret, timestampMs, rawBody));
}

describe("WSK-12 · zoneb event HMAC — the pre-parse gate", () => {
  it("ACCEPTS a genuinely signed, fresh request — the positive control every refusal below is measured against", () => {
    const now = Date.now();
    const rawBody = JSON.stringify({ eventId: "e1", kind: "form.received", tenantId: "t1" });
    const timestampHeader = now.toString();
    const signatureHeader = sign(SECRET, timestampHeader, rawBody);

    const result = verifySignature({
      secret: SECRET, timestampHeader, rawBody, signatureHeader, toleranceMs: TOLERANCE_MS, now,
    });

    expect(result.ok).toBe(true);
  });

  it("REFUSES a FORGED signature — signed with the wrong secret (an attacker without WEBDESK_EVENT_SECRET)", () => {
    const now = Date.now();
    const rawBody = JSON.stringify({ eventId: "e2", kind: "form.received", tenantId: "t1" });
    const timestampHeader = now.toString();
    // The attacker does not have the real secret — this is the whole point of an attacker.
    const signatureHeader = sign(OTHER_SECRET, timestampHeader, rawBody);

    const result = verifySignature({
      secret: SECRET, timestampHeader, rawBody, signatureHeader, toleranceMs: TOLERANCE_MS, now,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("signature mismatch");
  });

  it("REFUSES a MUTATED body — genuinely signed payload, one byte changed after signing (tampering in transit)", () => {
    const now = Date.now();
    const timestampHeader = now.toString();
    const originalBody = JSON.stringify({ eventId: "e3", kind: "form.received", tenantId: "t1" });
    const signatureHeader = sign(SECRET, timestampHeader, originalBody);
    // The attacker (or a MITM) mutates the tenant id AFTER the signature was computed — the classic
    // "forge a fact about someone else's tenant" attack this whole channel exists to prevent.
    const mutatedBody = originalBody.replace('"tenantId":"t1"', '"tenantId":"t2-not-mine"');

    const result = verifySignature({
      secret: SECRET, timestampHeader, rawBody: mutatedBody, signatureHeader, toleranceMs: TOLERANCE_MS, now,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("signature mismatch");
  });

  it("REFUSES a REPLAYED (stale) request — a validly-signed payload captured and resent long after its timestamp", () => {
    const capturedAt = Date.now() - (TOLERANCE_MS + 60_000); // 1 minute past the tolerance window
    const rawBody = JSON.stringify({ eventId: "e4", kind: "form.received", tenantId: "t1" });
    const timestampHeader = capturedAt.toString();
    // The signature itself is completely genuine — this is exactly what an attacker who recorded a
    // real webhook and resent it later would present. The MAC alone cannot catch this; the
    // timestamp-tolerance check is the layer that does.
    const signatureHeader = sign(SECRET, timestampHeader, rawBody);

    const result = verifySignature({
      secret: SECRET, timestampHeader, rawBody, signatureHeader, toleranceMs: TOLERANCE_MS, now: Date.now(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("stale timestamp — outside the replay-tolerance window");
  });

  it("REFUSES a FUTURE-DATED timestamp too — accepting 'not yet stale' would let an attacker pre-mint a signature that becomes valid later", () => {
    const now = Date.now();
    const futureTimestamp = (now + TOLERANCE_MS + 60_000).toString();
    const rawBody = JSON.stringify({ eventId: "e5", kind: "form.received", tenantId: "t1" });
    const signatureHeader = sign(SECRET, futureTimestamp, rawBody);

    const result = verifySignature({
      secret: SECRET, timestampHeader: futureTimestamp, rawBody, signatureHeader, toleranceMs: TOLERANCE_MS, now,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("stale timestamp — outside the replay-tolerance window");
  });

  it("REFUSES a WRONG-TIMESTAMP request — missing, non-numeric, or empty timestamp header, BEFORE any signature math runs", () => {
    const rawBody = JSON.stringify({ eventId: "e6", kind: "form.received", tenantId: "t1" });
    const signatureHeader = sign(SECRET, "1000", rawBody);

    for (const badTimestamp of [undefined, "", "not-a-number", "12.5", "-100"]) {
      const result = verifySignature({
        secret: SECRET, timestampHeader: badTimestamp, rawBody, signatureHeader, toleranceMs: TOLERANCE_MS,
      });
      expect(result.ok, `timestamp header ${JSON.stringify(badTimestamp)} must be refused`).toBe(false);
      if (!result.ok) expect(result.reason).toBe("missing or malformed timestamp header");
    }
  });

  it("REFUSES a malformed signature header — missing 'sha256=' prefix, non-hex, or absent entirely", () => {
    const now = Date.now();
    const timestampHeader = now.toString();
    const rawBody = JSON.stringify({ eventId: "e7", kind: "form.received", tenantId: "t1" });

    for (const badSignature of [undefined, "", "not-prefixed-at-all", "sha256=zz-not-hex", "sha1=deadbeef"]) {
      const result = verifySignature({
        secret: SECRET, timestampHeader, rawBody, signatureHeader: badSignature, toleranceMs: TOLERANCE_MS, now,
      });
      expect(result.ok, `signature header ${JSON.stringify(badSignature)} must be refused`).toBe(false);
      if (!result.ok) expect(result.reason).toBe("malformed signature header");
    }
  });

  it("REFUSES a signature copied from a DIFFERENT request — same secret, different (timestamp, body) pair", () => {
    const now = Date.now();
    const timestampA = now.toString();
    const bodyA = JSON.stringify({ eventId: "e8a", kind: "form.received", tenantId: "t1" });
    const signatureForA = sign(SECRET, timestampA, bodyA);

    // An attacker with no secret takes a real signature they observed on request A and pastes it
    // onto a different body/timestamp pair, hoping the receiver checks presence-of-signature only.
    const bodyB = JSON.stringify({ eventId: "e8b", kind: "form.received", tenantId: "t1" });

    const result = verifySignature({
      secret: SECRET, timestampHeader: timestampA, rawBody: bodyB, signatureHeader: signatureForA,
      toleranceMs: TOLERANCE_MS, now,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("signature mismatch");
  });

  it("is deterministic — signing the same (secret, timestamp, body) twice yields byte-identical hex", () => {
    const a = computeSignatureHex(SECRET, "1000", "{}");
    const b = computeSignatureHex(SECRET, "1000", "{}");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex is always 64 chars
  });
});
