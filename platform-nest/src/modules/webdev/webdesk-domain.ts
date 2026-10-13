// M6-P6i — what may be sent to WebDesk as an environment's public domain. Pure: no database, no clock, no network.
//
// A MIRROR of webdesk/api/src/control/lifecycle/environment-domain.ts (`checkEnvironmentDomain`), which is WebDesk's own
// refusal rule for `site.setDomain`. The two projects share no code (separate builds), so the same vectors are asserted in
// BOTH unit suites (webdesk-domain.unit.test.ts here, test/site-set-domain-unit.spec.ts there): change one rule and one of
// them goes red. It exists so a request WebDesk would refuse is refused at FILING (a 400 before an approval is spent), and so
// a STORED approval row that was edited after filing is refused again at execution.
//
// CANONICAL = a lowercase ASCII bare host: two or more labels of letters, digits and hyphens (1..63 characters, not
// starting or ending with a hyphen), 253 characters at most, a last label of letters only (or punycode), no scheme, port,
// path, userinfo, wildcard, whitespace, trailing dot or Unicode label, and not `.invalid`, `.local`, `.localhost` or
// `.internal`. WebDesk answers CORS by comparing an Origin to this value as a whole string, so a value that is not
// canonical would either never match a real Origin or match something nobody meant; it is refused, never cleaned up.

export const WEBDESK_DOMAIN_MAX = 253;

const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD_RE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const REFUSED_TLDS: ReadonlySet<string> = new Set(["invalid", "local", "localhost", "internal"]);

export type WebdeskDomainVerdict = { ok: true; domain: string } | { ok: false; reason: string };

export function checkWebdeskEnvironmentDomain(value: unknown): WebdeskDomainVerdict {
  if (typeof value !== "string") return { ok: false, reason: "domain must be a string" };
  if (value.length < 3 || value.length > WEBDESK_DOMAIN_MAX) {
    return { ok: false, reason: `domain must be 3..${WEBDESK_DOMAIN_MAX} characters` };
  }
  if (/\s/.test(value)) return { ok: false, reason: "domain must not contain whitespace" };
  if (value !== value.toLowerCase()) return { ok: false, reason: "domain must be lowercase" };
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
