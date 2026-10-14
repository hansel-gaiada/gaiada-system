import { describe, it, expect } from "vitest";
import { certifiedBadgeText, documentLinkLabel, documentStateNote } from "./documents";

describe("documents wording", () => {
  it("a ready document with a file says nothing about state", () => {
    expect(documentStateNote({ kind: "invoice", fileId: "f", ready: true })).toBeNull();
  });
  it("each kind says what is missing, in words", () => {
    expect(documentStateNote({ kind: "signed_contract", fileId: "f", ready: false })).toMatch(/sealed copy is being prepared/);
    expect(documentStateNote({ kind: "signed_contract", fileId: null, ready: false })).toMatch(/signed copy is being prepared/);
    expect(documentStateNote({ kind: "invoice", fileId: null, ready: false })).toMatch(/invoice PDF is being prepared/);
  });
  it("only an unsealed agreement's link is called the original", () => {
    expect(documentLinkLabel({ kind: "signed_contract", ready: false })).toMatch(/original/);
    expect(documentLinkLabel({ kind: "signed_contract", ready: true })).toBe("Download");
    expect(documentLinkLabel({ kind: "invoice", ready: false })).toBe("Download");
  });
});

describe("certifiedBadgeText (PV5-11)", () => {
  it("says Certified (simulated) for a simulated certified copy, Certified for a real one, and nothing otherwise", () => {
    expect(certifiedBadgeText({ certified: true, simulated: true })).toBe("Certified (simulated)");
    expect(certifiedBadgeText({ certified: true, simulated: false })).toBe("Certified");
    expect(certifiedBadgeText({ certified: true })).toBe("Certified");
    expect(certifiedBadgeText({ certified: false, simulated: true })).toBeNull();
    expect(certifiedBadgeText({})).toBeNull();
  });
});
