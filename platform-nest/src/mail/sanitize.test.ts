import { describe, it, expect } from "vitest";
import { stripHeaderInjection, isPlausibleEmail, normalizeEmail } from "./sanitize";

describe("mail/sanitize", () => {
  it("strips embedded CR/LF from header-ish values (header-injection AC)", () => {
    expect(stripHeaderInjection("real subject")).toBe("real subject");
    expect(stripHeaderInjection("real\r\nBcc: attacker@evil.test")).toBe("realBcc: attacker@evil.test");
    expect(stripHeaderInjection("a\nb\rc\r\nd")).toBe("abcd");
  });

  it("rejects addresses carrying CR/LF even if otherwise well-formed", () => {
    expect(isPlausibleEmail("ok@example.test")).toBe(true);
    expect(isPlausibleEmail("evil@example.test\r\nBcc: x@y.test")).toBe(false);
    expect(isPlausibleEmail("no-at-sign")).toBe(false);
    expect(isPlausibleEmail("")).toBe(false);
  });

  it("normalizes email for the exact-lowercased suppression match (§5.1)", () => {
    expect(normalizeEmail("  Someone@Example.TEST ")).toBe("someone@example.test");
  });
});
