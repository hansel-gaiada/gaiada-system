import { describe, it, expect } from "vitest";
import { scrub, SCRUB_RULESET_VERSION } from "./scrub";

describe("scrub — positives (day-one categories)", () => {
  it("redacts a Luhn-valid card number", () => {
    const r = scrub("pay to 4111 1111 1111 1111 today");
    expect(r.clean).toBe("pay to [REDACTED-CARD] today");
    expect(r.redactions.some((x) => x.type === "PAN")).toBe(true);
  });

  it("redacts a labelled Indonesian KTP/NIK", () => {
    const r = scrub("NIK 3174012345678901 for the form");
    expect(r.clean).not.toContain("3174012345678901");
    expect(r.redactions.some((x) => x.type === "KTP")).toBe(true);
  });

  it("redacts an UNLABELLED number that validates as a real NIK (province + birthdate)", () => {
    // 32=West Java · area 0115 · DDMMYY=081200 (8 Dec 2000) · serial 1234 → valid NIK.
    const r = scrub("kirim data 3201150812001234 ya");
    expect(r.clean).not.toContain("3201150812001234");
    expect(r.redactions.some((x) => x.type === "KTP")).toBe(true);
  });

  it("redacts NPWP in both formatted and labelled-bare forms", () => {
    expect(scrub("NPWP 09.254.294.3-407.000").clean).toContain("[REDACTED-ID]");
    expect(scrub("npwp 092542943407000").clean).toContain("[REDACTED-ID]");
  });

  it("redacts a labelled bank account, keeps the label", () => {
    const r = scrub("transfer ke rekening 1234567890 atas nama Budi");
    expect(r.clean).toContain("[REDACTED-ACCT]");
    expect(r.clean).not.toContain("1234567890");
    expect(r.redactions.some((x) => x.type === "BANK_ACCT")).toBe(true);
  });

  it("redacts a passport-style id", () => {
    expect(scrub("passport A1234567 issued").clean).toContain("[REDACTED-ID]");
  });

  it("opt-in: phone redacted only when enabled", () => {
    expect(scrub("call 0811 2345 6789 now").clean).toContain("0811");
    expect(scrub("call 0811 2345 6789 now", { phone: true }).clean).toContain("[REDACTED-PHONE]");
  });

  it("opt-in: email redacted only when enabled", () => {
    expect(scrub("mail budi@site.co.id").clean).toContain("budi@");
    expect(scrub("mail budi@site.co.id", { email: true }).clean).toContain("[REDACTED-EMAIL]");
  });
});

describe("scrub — false-positive corpus (must NOT redact)", () => {
  const clean = [
    "order 1234567890123456 shipped", // 16-digit, not Luhn, not a valid NIK
    "invoice #99001234 approved",
    "the meeting is at 08.30 in room 12",
    "budget is 15000000 rupiah for Q3",
    "Project Alpha is behind schedule, need help on the API by Friday.",
    "PO 2024-00123 and PO 2024-00124 are ready",
    "we poured 250 m3 of concrete over 3 days",
    "SKU ABC12345 restocked", // passport-like but too short digit run? A B C then 12345 (5 digits) — not 6-8
  ];
  for (const t of clean) {
    it(`leaves untouched: "${t.slice(0, 40)}"`, () => {
      const r = scrub(t);
      expect(r.clean).toBe(t);
      expect(r.redactions).toHaveLength(0);
    });
  }
});

describe("scrub — ruleset version", () => {
  it("exposes a version (mirrored copies pin this)", () => {
    expect(SCRUB_RULESET_VERSION).toBe(2);
  });
});
