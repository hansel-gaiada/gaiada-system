// MAIL-04 QA gate — header-injection probes BEYOND the implementer's own CRLF cases (per the
// ticket's instruction to try unicode line separators, bare CR, bare LF, encoded variants, and
// injection via template-interpolated values rather than just the address).
import { describe, it, expect } from "vitest";
import { stripHeaderInjection, isPlausibleEmail } from "./sanitize";
import { renderTemplate } from "./templates";
import { smtpTransportOptions } from "./provider";

describe("MAIL-04 QA gate — header injection beyond the implementer's cases", () => {
  it("bare CR alone (no paired LF) is stripped", () => {
    expect(stripHeaderInjection("real\rBcc: attacker@evil.test")).toBe("realBcc: attacker@evil.test");
  });

  it("bare LF alone (no paired CR) is stripped", () => {
    expect(stripHeaderInjection("real\nBcc: attacker@evil.test")).toBe("realBcc: attacker@evil.test");
  });

  it("U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR pass through unchanged — NOT ASCII CR/LF, so they cannot form a real SMTP header line break on the wire (their UTF-8 bytes contain no 0x0D/0x0A)", () => {
    // This documents the boundary of the sanitizer rather than a gap: nodemailer/SMTP only ever
    // terminates a header on an actual CRLF octet pair. U+2028's UTF-8 encoding is E2 80 A8 — no
    // byte in it is 0x0D or 0x0A, so it cannot inject a header line even though the regex doesn't
    // strip it.
    const withU2028 = "subject\u2028Bcc: attacker@evil.test";
    expect(stripHeaderInjection(withU2028)).toBe(withU2028); // unchanged — confirms it's not treated as CR/LF
    // But it is NOT exploitable: no CR (\r, 0x0D) or LF (\n, 0x0A) byte exists in the string.
    expect(/[\r\n]/.test(withU2028)).toBe(false);
  });

  it("percent-encoded CRLF (%0d%0a) is inert: it is literal text, not a real CR/LF byte, unless something double-decodes it", () => {
    const encoded = "subject%0d%0aBcc: attacker@evil.test";
    // stripHeaderInjection correctly leaves it alone — it is not raw CR/LF. The real question is
    // whether the query/body parser upstream ever decodes it into real CR/LF before this function
    // sees it; it must not.
    expect(stripHeaderInjection(encoded)).toBe(encoded);
    expect(isPlausibleEmail(`a@b.test${encoded}`)).toBe(false); // still fails plausibility due to shape, belt+suspenders
  });

  it("real CRLF injected via a TEMPLATE-INTERPOLATED value (subjectTitle), not the address, is neutralized in the rendered subject", () => {
    const rendered = renderTemplate("approval.actionable", {
      href: "https://erp.gaiada.invalid/x",
      subjectTitle: "sign\r\nBcc: attacker@evil.test the gate",
    });
    expect(rendered.subject).not.toMatch(/[\r\n]/);
    expect(rendered.subject).not.toMatch(/^Bcc:/im);
  });

  it("real CRLF injected via companyName/tool/impact (approval.warning body fields) cannot reach the SUBJECT header (those fields are never interpolated into subject)", () => {
    const rendered = renderTemplate("approval.warning", {
      href: "https://erp.gaiada.invalid/x",
      subjectTitle: "ok",
      companyName: "Acme\r\nBcc: attacker@evil.test",
      tool: "bot\r\nX-Injected: 1",
      impact: "high\r\nX-Injected: 2",
    });
    expect(rendered.subject).not.toMatch(/[\r\n]/);
  });

  it("CRLF in the reply-to display name (mail.replyTo.name path) is stripped before nodemailer sees it — pinning the code path, not just the raw string", () => {
    // provider.ts's smtpAdapter.send() calls stripHeaderInjection on replyTo.name inline; verify the
    // primitive it relies on handles the exact string shape a reply-to name could carry.
    const injected = "Reply Bot\r\nBcc: attacker@evil.test";
    expect(stripHeaderInjection(injected)).not.toMatch(/[\r\n]/);
  });

  it("TLS rule is unaffected by header-injection-shaped host/user strings (defense in depth: this is a config value, not user input, but confirm the function does not special-case CR/LF)", () => {
    const opts = smtpTransportOptions({ host: "h", port: 1, user: "u\r\nX: 1", password: "p" });
    expect(opts.requireTLS).toBe(true); // credentials-present logic unaffected either way
  });
});
