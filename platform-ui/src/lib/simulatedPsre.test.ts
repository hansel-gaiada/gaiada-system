import { describe, it, expect } from "vitest";
import { certifiedStartErrorText, signerStateText, simulatedSignErrorText } from "./simulatedPsre";

// PV5-11 — the words around the simulated PSrE. Pure; the pages render from them.

describe("simulatedSignErrorText", () => {
  it("puts each refusal in words, branching on the reason and never on the message", () => {
    expect(simulatedSignErrorText(409, "content_changed", "x")).toMatch(/changed since you opened/);
    expect(simulatedSignErrorText(409, "not_sent", "x")).toMatch(/not been sent/);
    expect(simulatedSignErrorText(403, "signer_must_be_a_person", "x")).toMatch(/person has to sign/);
    expect(simulatedSignErrorText(404, undefined, "x")).toMatch(/not available/);
  });
  it("passes the server's own sentence through when it has no special case (the owner-only countersign refusal)", () => {
    expect(simulatedSignErrorText(403, undefined, "Only a company owner can countersign")).toBe("Only a company owner can countersign");
  });
});

describe("certifiedStartErrorText", () => {
  it("covers the start route's refusals", () => {
    expect(certifiedStartErrorText(409, "content_changed", "x")).toMatch(/changed since you opened it/);
    expect(certifiedStartErrorText(409, "content_mismatch", "x")).toMatch(/changed since you opened it/);
    expect(certifiedStartErrorText(409, "no_certified_provider", "x")).toMatch(/isn't set up/);
    expect(certifiedStartErrorText(409, "already_signed", "x")).toMatch(/already signed/);
    expect(certifiedStartErrorText(403, undefined, "x")).toMatch(/view-only/);
    expect(certifiedStartErrorText(404, undefined, "x")).toMatch(/could not be found/);
    expect(certifiedStartErrorText(500, undefined, "boom")).toBe("boom");
  });
});

describe("signerStateText", () => {
  const f = (iso: string) => iso.slice(0, 10);
  it("says who signed and when, or that nobody has", () => {
    expect(signerStateText({ state: "pending", signerName: null, signerTitle: null, signedAt: null }, f)).toBe("Not signed yet");
    expect(signerStateText({ state: "signed", signerName: "Dana", signerTitle: "COO", signedAt: "2026-10-11T03:00:00Z" }, f)).toBe("Dana, COO, 2026-10-11");
    expect(signerStateText({ state: "signed", signerName: null, signerTitle: null, signedAt: null }, f)).toBe("Signed");
  });
});
