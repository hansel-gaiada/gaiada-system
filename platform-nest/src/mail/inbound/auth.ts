// MAIL-13 — authenticating the inbound webhook (design §7.6: "Authenticate the webhook: provider
// signature where offered, plus `MAIL_INBOUND_TOKEN` in the URL/header; reject otherwise").
//
// ══ WHAT "BREVO'S DOCUMENTED SCHEME" TURNED OUT TO BE (verified 2026-08-04, architect-visible) ══
// Brevo does NOT sign webhooks. Its published mechanisms for securing a webhook endpoint are
//   (1) HTTP basic-auth credentials embedded in the webhook URL,
//   (2) a token-bearing request header defined when the webhook object is created,
//   (3) arbitrary custom headers sent with every call.
// There is no HMAC payload signature to implement "to Brevo's documented scheme" — the plan row's
// phrasing assumed one exists, and design §7.6's own wording ("provider signature WHERE OFFERED")
// already anticipates this case. So this file implements BOTH walls:
//
//   * `MAIL_INBOUND_TOKEN` in the `x-gaiada-mail-inbound-token` header — Brevo's documented
//     mechanism (2), constant-time compared, FAIL-CLOSED when unset. This is the wall that is real
//     today, and it matches MAIL-04's `assertWebhookToken` exactly (`configured` must be truthy
//     before any comparison happens, so an unconfigured secret refuses every request rather than
//     skipping the check).
//   * An OPTIONAL HMAC-SHA256 signature over the RAW request bytes, enabled by
//     `MAIL_INBOUND_SIGNING_KEY`. When that key is set the signature is REQUIRED (fail-closed on
//     the configured path — a configured verifier that silently accepts unsigned posts is worse than
//     no verifier). When it is unset, the token alone is the wall and signature verification is
//     reported as `off` rather than as "passed". Dev verifies this against SELF-GENERATED fixture
//     signatures (plan row MAIL-13, explicit) — that is a test of OUR verifier, and §15 R3's "verify
//     signature validation against real signatures" has to be re-scoped at staging to whichever of
//     Brevo's three mechanisms is actually wired.
//
// The signature scheme is OURS and documented here rather than inferred from a provider: header
// `x-gaiada-mail-inbound-signature: t=<unix-seconds>,v1=<hex hmac-sha256>` over the exact bytes
// `<t>.<raw body>`. Timestamp binding is what makes a captured-and-replayed signature expire
// (`MAIL_INBOUND_SIGNATURE_TOLERANCE_S`, default 300s); the `(provider, provider_message_id)` UNIQUE
// makes an in-window replay a no-op anyway, so the two controls are independent.
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../../config";
import { secretEquals } from "../../core/secret-box";

export const INBOUND_TOKEN_HEADER = "x-gaiada-mail-inbound-token";
export const INBOUND_SIGNATURE_HEADER = "x-gaiada-mail-inbound-signature";

export type InboundAuthResult =
  | { ok: true; signature: "verified" | "off" }
  | { ok: false; reason: string };

function headerValue(headers: Record<string, unknown>, name: string): string {
  const raw = headers[name];
  if (Array.isArray(raw)) return typeof raw[0] === "string" ? raw[0] : "";
  return typeof raw === "string" ? raw : "";
}

/** Builds the signature header value for a payload. Used by the fixture corpus, the replay script,
 *  and the tests — deliberately EXPORTED from the same module that verifies, so a change to the
 *  scheme cannot leave signer and verifier disagreeing. */
export function signInboundPayload(rawBody: Buffer | string, key: string, timestampSeconds?: number): string {
  const t = timestampSeconds ?? Math.floor(Date.now() / 1000);
  const mac = createHmac("sha256", key)
    .update(`${t}.`)
    .update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8"))
    .digest("hex");
  return `t=${t},v1=${mac}`;
}

function parseSignatureHeader(value: string): { t: number; v1: string } | null {
  let t: number | null = null;
  let v1: string | null = null;
  for (const part of value.split(",")) {
    const [k, v] = part.split("=", 2);
    if (!k || v === undefined) continue;
    if (k.trim() === "t") t = Number(v.trim());
    else if (k.trim() === "v1") v1 = v.trim();
  }
  if (t === null || !Number.isFinite(t) || !v1 || !/^[0-9a-f]+$/i.test(v1)) return null;
  return { t, v1 };
}

/**
 * The whole authentication wall for one inbound POST. Returns a result rather than throwing so the
 * controller owns the HTTP mapping (401) and the `mail_inbound_rejected_total{reason="auth"}`
 * counter in one place.
 *
 * `rawBody` is the exact bytes received (captured by `raw-body.ts`); the signature is computed over
 * those, never over a re-serialization of the parsed object — a JSON round-trip reorders keys and
 * rewrites whitespace, which would make every real signature fail.
 */
export function authenticateInbound(
  headers: Record<string, unknown>,
  rawBody: Buffer,
  nowSeconds = Math.floor(Date.now() / 1000),
): InboundAuthResult {
  const configuredToken = config.mail.inboundToken;
  const presentedToken = headerValue(headers, INBOUND_TOKEN_HEADER);
  // FAIL-CLOSED on an unset token: `!configuredToken` short-circuits before any comparison, so an
  // unconfigured deployment refuses everything. Same shape as MAIL-04's webhook controller.
  if (!configuredToken || !secretEquals(presentedToken, configuredToken)) {
    return { ok: false, reason: "invalid or missing inbound token" };
  }

  const signingKey = config.mail.inboundSigningKey;
  if (!signingKey) return { ok: true, signature: "off" };

  const presented = parseSignatureHeader(headerValue(headers, INBOUND_SIGNATURE_HEADER));
  if (!presented) return { ok: false, reason: "missing or malformed signature header" };
  if (Math.abs(nowSeconds - presented.t) > config.mail.inboundSignatureToleranceS) {
    return { ok: false, reason: "signature timestamp outside tolerance" };
  }
  const expected = createHmac("sha256", signingKey)
    .update(`${presented.t}.`)
    .update(rawBody)
    .digest();
  const got = Buffer.from(presented.v1, "hex");
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    return { ok: false, reason: "signature mismatch" };
  }
  return { ok: true, signature: "verified" };
}
