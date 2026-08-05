import { describe, it, expect } from "vitest";
import { sanitizeReturnTo, sanitizeReturnToParam } from "./returnTo";

describe("sanitizeReturnTo — UI-01 shared return-target validator", () => {
  it("passes through ordinary same-origin deep links unchanged", () => {
    expect(sanitizeReturnTo("/approvals/abc-123")).toBe("/approvals/abc-123");
    expect(sanitizeReturnTo("/pipeline/run-42")).toBe("/pipeline/run-42");
    expect(sanitizeReturnTo("/portal/approvals/run-42")).toBe("/portal/approvals/run-42");
    expect(sanitizeReturnTo("/portal/approvals")).toBe("/portal/approvals");
  });

  it("preserves query strings and hashes on an otherwise-valid path", () => {
    expect(sanitizeReturnTo("/reports/company?range=90d")).toBe("/reports/company?range=90d");
    expect(sanitizeReturnTo("/pm/board#col-3")).toBe("/pm/board#col-3");
  });

  it("defaults to / for no value / empty / non-path input", () => {
    expect(sanitizeReturnTo(null)).toBe("/");
    expect(sanitizeReturnTo(undefined)).toBe("/");
    expect(sanitizeReturnTo("")).toBe("/");
    expect(sanitizeReturnTo("approvals/123")).toBe("/"); // no leading slash
  });

  it("defaults to / for an oversized value rather than erroring", () => {
    expect(sanitizeReturnTo("/" + "a".repeat(3000))).toBe("/");
  });

  describe("open-redirect probes — every one must fall back to /, never throw, never leave the origin", () => {
    const probes: Array<[label: string, value: string]> = [
      ["absolute URL, same-looking host", "https://erp.gaiada.online.evil.test/x"],
      ["absolute URL, http", "http://evil.test/"],
      ["absolute URL, https", "https://evil.test/steal"],
      ["protocol-relative, double slash", "//evil.test"],
      ["protocol-relative, triple slash", "///evil.test"],
      ["protocol-relative with path", "//evil.test/approvals/1"],
      ["backslash variant (WHATWG backslash-as-slash quirk)", "/\\evil.test"],
      ["double backslash variant", "\\\\evil.test"],
      ["mixed slash/backslash", "/\\/evil.test"],
      ["backslash deeper in the path", "/approvals/\\evil.test"],
      ["encoded protocol-relative (%2F%2F)", "/%2F%2Fevil.test"],
      ["encoded backslash (%5C)", "/%5Cevil.test"],
      ["double-encoded protocol-relative", "/%252F%252Fevil.test"],
      ["javascript scheme", "javascript:alert(1)"],
      ["javascript scheme, leading slash", "/javascript:alert(1)"],
      ["data scheme", "data:text/html,<script>alert(1)</script>"],
      ["vbscript scheme", "vbscript:msgbox(1)"],
      ["userinfo host smuggling", "https://erp.gaiada.online@evil.test/"],
      ["tab-injected protocol-relative", "/\t/evil.test"],
      ["newline-injected protocol-relative", "/\n/evil.test"],
      ["scheme with no slashes at all", "evil.test"],
      ["whitespace-padded absolute URL", "  https://evil.test"],
    ];

    for (const [label, value] of probes) {
      it(`refuses: ${label} (${JSON.stringify(value)})`, () => {
        const result = sanitizeReturnTo(value);
        expect(result).toBe("/");
      });
    }

    it("never throws on malformed percent-encoding", () => {
      expect(() => sanitizeReturnTo("/%")).not.toThrow();
      expect(sanitizeReturnTo("/%")).toBe("/");
      expect(() => sanitizeReturnTo("/%zz")).not.toThrow();
    });
  });

  describe("sanitizeReturnToParam — the string | string[] | undefined searchParams shape", () => {
    it("takes the first element of an array", () => {
      expect(sanitizeReturnToParam(["/approvals/1", "/pipeline/2"])).toBe("/approvals/1");
    });
    it("rejects an array whose first element is dangerous", () => {
      expect(sanitizeReturnToParam(["//evil.test"])).toBe("/");
    });
    it("defaults on undefined", () => {
      expect(sanitizeReturnToParam(undefined)).toBe("/");
    });
  });
});
