// GH-07 (docs/blueprints/github-integration-foundation.md §4.5) — HMAC-SHA256 verification for
// `POST /api/webhooks/github`. This endpoint is internet-facing and carries NO AuthGuard — GitHub is
// not a session holder — so this function IS the entire authentication wall (github-webhook.controller.ts).
//
// Lives outside `core/github/` for the same scope-boundary reason github-webhook-raw-body.ts does —
// see that file's header.
import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_PREFIX = "sha256=";

/** GitHub signs the RAW request body with the webhook's shared secret and sends
 *  `X-Hub-Signature-256: sha256=<hex hmac>`. Verification MUST run over the exact bytes received
 *  (see github-webhook-raw-body.ts) — a signature computed over a re-parsed/re-serialized body
 *  proves nothing, because an attacker controls what that re-serialization looks like.
 *
 *  Timing-safe by construction: `timingSafeEqual` compares two EQUAL-LENGTH buffers in constant
 *  time. A length mismatch (including a malformed/truncated hex string, which `Buffer.from(x,
 *  "hex")` silently stops parsing at the first invalid character rather than throwing) is rejected
 *  by the length check before `timingSafeEqual` ever runs — `timingSafeEqual` itself throws on
 *  unequal lengths, so the check is not optional. Both branches — no header, empty secret, bad
 *  prefix, wrong length, wrong bytes — return `false`; there is exactly one way to return `true`. */
export function verifyGithubWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!secret || !signatureHeader) return false;
  if (!signatureHeader.startsWith(SIGNATURE_PREFIX)) return false;
  const presentedHex = signatureHeader.slice(SIGNATURE_PREFIX.length);

  const expected = createHmac("sha256", secret).update(rawBody).digest();
  let presented: Buffer;
  try {
    presented = Buffer.from(presentedHex, "hex");
  } catch {
    return false;
  }
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}
