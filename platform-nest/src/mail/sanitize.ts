// MAIL-04 — header-injection + basic address hygiene. A mail body/subject/address that reaches
// nodemailer with an embedded CR/LF can inject extra SMTP headers (classic header-injection: a
// forged Bcc:, a second Subject:, a spoofed From:) — this is the QA item design §4.1 calls out
// ("header-injection probes are a QA item"), and MAIL-18 re-asserts it end to end. Applied to
// EVERY header-ish value the sender constructs (subject, address display names, custom headers)
// before it ever reaches the adapter — not just at the admin-log/webhook boundary.
const CRLF_RE = /[\r\n]+/g;

/** Strips CR/LF (and anything the caller tried to smuggle after them) from a header-ish value.
 *  Deliberately DROPS the newline rather than replacing it with a space: a value that arrives
 *  containing "Subject: real\r\nBcc: attacker@evil.test" must not silently become a second,
 *  still-injected header with a space instead of a newline — dropping the character removes the
 *  injection vector outright rather than reformatting it. */
export function stripHeaderInjection(value: string): string {
  return value.replace(CRLF_RE, "");
}

/** Very deliberately NOT a full RFC 5322 validator (that is a security anti-pattern of its own —
 *  regexes claiming full RFC 5322 coverage are notoriously exploitable). This only rejects the
 *  shapes that matter here: embedded CR/LF (header injection via the address itself) and the
 *  absence of an "something@something" shape. Real deliverability validation happens at the
 *  provider, which is the correct place for it. */
export function isPlausibleEmail(value: string): boolean {
  if (!value || CRLF_RE.test(value)) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** Lowercased, trimmed — the exact-match key `mail_suppressions` and every suppression lookup use
 *  (design §5.1: "exact lowercased address match only"). */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}
