// M6-P6i -- the one rule for what may be stored in `environments.domain`.
//
// WHY THIS IS A SECURITY RULE: every browser-facing route of this service answers CORS from that column and from
// nothing else. The forms guard builds `https://<domain>` / `http://<domain>` and compares the request's Origin to
// them as whole strings; the consent repository compares the Origin's host to the column; the draft-preview route
// compares `https://<domain>` exactly (delivery/preview-token.ts allowedPreviewOrigin). There is no suffix match, no
// wildcard and no "same site" widening anywhere, so a lookalike (`example.com.evil.test`, `exampIe.com` with a capital
// I, a Cyrillic `a`, a sibling subdomain, a port) is refused for free ONCE THE STORED VALUE IS A CANONICAL BARE HOST.
// This file is what makes the stored value canonical. A stored value that is not (a scheme, a path, a port, a
// wildcard, userinfo, whitespace, upper case, a Unicode label) would either never match a real Origin or, worse, match
// something the operator did not mean, so the command REFUSES such a value instead of cleaning it up: what the approver
// saw and what the WS4 hash covers is exactly what is stored, never a transformation of it.
//
// CANONICAL = lowercase ASCII LDH labels (letters, digits, hyphen), 2 or more labels, each 1..63 characters and neither
// starting nor ending with a hyphen, 253 characters in all. An internationalised name is stored in its punycode form
// (`xn--...`), which is also what a browser sends in the Origin header, so the comparison stays byte-for-byte.
// The last label is letters only (2..63) or a punycode label, which excludes every IPv4 literal and a bare `localhost`.
import { BadRequestException } from "@nestjs/common";

export const ENVIRONMENT_DOMAIN_MAX = 253;

const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD_RE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
/** Top-level labels that can never be a public site: the placeholder namespace and the machine-local ones. */
const REFUSED_TLDS: ReadonlySet<string> = new Set(["invalid", "local", "localhost", "internal"]);

export type DomainVerdict = { ok: true; domain: string } | { ok: false; reason: string };

/** Pure. A canonical bare host, or the reason it is not one. */
export function checkEnvironmentDomain(value: unknown): DomainVerdict {
  if (typeof value !== "string") return { ok: false, reason: "domain must be a string" };
  if (value.length < 3 || value.length > ENVIRONMENT_DOMAIN_MAX) {
    return { ok: false, reason: `domain must be 3..${ENVIRONMENT_DOMAIN_MAX} characters` };
  }
  if (/\s/.test(value)) return { ok: false, reason: "domain must not contain whitespace" };
  if (value !== value.toLowerCase()) return { ok: false, reason: "domain must be lowercase" };
  // The characters that turn a host into something else, named so the refusal says what was wrong.
  if (/[:/\\?#@*[\]]/.test(value)) return { ok: false, reason: "domain must be a bare host name (no scheme, port, path, userinfo or wildcard)" };
  if (/[^\x21-\x7e]/.test(value)) return { ok: false, reason: "domain must be ASCII (use the punycode form of an international name)" };
  if (value.startsWith(".") || value.endsWith(".")) return { ok: false, reason: "domain must not start or end with a dot (no trailing root dot)" };
  const labels = value.split(".");
  if (labels.length < 2) return { ok: false, reason: "domain must have at least two labels" };
  for (const label of labels) {
    if (!LABEL_RE.test(label)) return { ok: false, reason: "each label must be letters, digits or hyphens, 1..63 characters, not starting or ending with a hyphen" };
  }
  const tld = labels[labels.length - 1];
  if (!TLD_RE.test(tld)) return { ok: false, reason: "the last label must be letters (an IP address is not a domain)" };
  if (REFUSED_TLDS.has(tld)) return { ok: false, reason: `.${tld} can never be a public site domain` };
  return { ok: true, domain: value };
}

/** The body rule of `site.setDomain`: a canonical bare host, or null (clear the environment's domain). */
export function assertNullableEnvironmentDomain(value: unknown, field = "domain"): string | null {
  if (value === null) return null;
  const v = checkEnvironmentDomain(value);
  if (!v.ok) throw new BadRequestException(`${field}: ${v.reason}`);
  return v.domain;
}
