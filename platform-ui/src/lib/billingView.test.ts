import { describe, it, expect } from "vitest";
import {
  blockerFix, classifyBankRefusal, contractDocumentState, documentState, invoiceDocumentState, maskAccountNo, shortHash,
  stepUpHref, tierLabel, validateBank, voidErrorText, voidReasonOk,
} from "./billingView";

// PV5-09 — the pure rules the contracts-and-billing screens render from. Each one is a sentence the screens would
// otherwise get wrong by guessing.

describe("documentState · a file rendered after the commit", () => {
  it("a stored file is a link, whatever the record is", () => {
    expect(documentState(true, "f-1")).toEqual({ kind: "link", fileId: "f-1" });
    expect(documentState(false, "f-1")).toEqual({ kind: "link", fileId: "f-1" });
  });

  it("🔴 a record that SHOULD have a file but has none yet says 'preparing': null and absent read alike", () => {
    expect(documentState(true, null)).toEqual({ kind: "preparing" });
    expect(documentState(true, undefined)).toEqual({ kind: "preparing" });
    expect(documentState(true, "  ")).toEqual({ kind: "preparing" });
  });

  it("🔴 a record that should have none says NOTHING (never promises a file for a draft)", () => {
    expect(documentState(false, null)).toEqual({ kind: "none" });
    expect(documentState(false, undefined)).toEqual({ kind: "none" });
  });

  it("an invoice has a PDF once it has its number; a legacy sent invoice (no number) has none to promise", () => {
    expect(invoiceDocumentState({ invoiceNo: "X/2026/0001", pdfFileId: null })).toEqual({ kind: "preparing" });
    expect(invoiceDocumentState({ invoiceNo: "X/2026/0001" })).toEqual({ kind: "preparing" });
    expect(invoiceDocumentState({ invoiceNo: "X/2026/0001", pdfFileId: "f-9" })).toEqual({ kind: "link", fileId: "f-9" });
    expect(invoiceDocumentState({ invoiceNo: null, pdfFileId: null })).toEqual({ kind: "none" });
    expect(invoiceDocumentState({})).toEqual({ kind: "none" });
  });

  it("a contract has a sealed copy once it is SIGNED, and only then", () => {
    expect(contractDocumentState({ status: "signed", signedCopyFileId: null })).toEqual({ kind: "preparing" });
    expect(contractDocumentState({ status: "signed" })).toEqual({ kind: "preparing" });
    expect(contractDocumentState({ status: "signed", signedCopyFileId: "f-2" })).toEqual({ kind: "link", fileId: "f-2" });
    for (const status of ["draft", "sent", "void", "declined", "expired"]) {
      expect(contractDocumentState({ status, signedCopyFileId: null })).toEqual({ kind: "none" });
    }
  });
});

describe("shortHash and maskAccountNo", () => {
  it("shortens a SHA-256 to its first and last eight characters, and leaves a short value alone", () => {
    const h = "0123456789abcdef".repeat(4);
    expect(shortHash(h)).toBe("01234567…89abcdef");
    expect(shortHash(h)).not.toBe(h);
    expect(shortHash("abc")).toBe("abc");
  });

  it("🔴 masks all but the last four characters, with a fixed bullet count that does not leak the length", () => {
    expect(maskAccountNo("1234567890")).toBe("•••• 7890");
    expect(maskAccountNo("12345678901234567890")).toBe("•••• 7890");
    expect(maskAccountNo("1234 5678 90")).toBe("•••• 7890");
  });

  it("hides a very short number entirely and says a dash for none", () => {
    expect(maskAccountNo("1234")).toBe("••••");
    expect(maskAccountNo("")).toBe("—");
    expect(maskAccountNo(null)).toBe("—");
  });
});

describe("tierLabel", () => {
  it("says what each tier means, and that a draft has none yet", () => {
    expect(tierLabel("attested")).toMatch(/typed name/i);
    expect(tierLabel("certified")).toMatch(/certified provider/i);
    expect(tierLabel(null)).toMatch(/when the contract is sent/i);
    expect(tierLabel(undefined)).toMatch(/when the contract is sent/i);
  });
});

describe("blockerFix · where a blocker is cleared", () => {
  it("links the billing profile for the four profile-shaped blockers", () => {
    for (const code of ["NO_BILLING_PROFILE", "NO_BANK_DETAILS", "NO_REVENUE_ACCOUNT", "NO_RECEIPT_ACCOUNT"]) {
      expect(blockerFix(code)?.href).toBe("/finance/settings/billing-profile");
    }
  });

  it("links accounting settings for PKP and the missing settings row", () => {
    expect(blockerFix("PKP_NOT_CONFIRMED")?.href).toBe("/finance/settings");
    expect(blockerFix("NO_FINANCE_SETTINGS")?.href).toBe("/finance/settings");
  });

  it("PV5-04b: a missing service line points at the picker on the invoice page itself", () => {
    expect(blockerFix("NO_SERVICE_LINE")).toEqual({ href: "#service-line", label: "Choose a service line" });
  });

  it("🔴 a code this UI does not know has NO link (never a guessed one)", () => {
    expect(blockerFix("SOMETHING_NEW")).toBeNull();
    expect(blockerFix("NOT_APPROVED")).toBeNull();
  });
});

describe("void · the reason and the refusals in words", () => {
  it("🔴 needs at least four characters once trimmed (the server's own rule)", () => {
    expect(voidReasonOk("abc")).toBe(false);
    expect(voidReasonOk("  ab  ")).toBe(false);
    expect(voidReasonOk("typo")).toBe(true);
  });

  it("puts every named 409 reason in plain words, not the raw message", () => {
    expect(voidErrorText(409, "not_issued", "RAW")).toMatch(/never issued/i);
    expect(voidErrorText(409, "not_voidable", "RAW")).toMatch(/credit note in Finance/i);
    expect(voidErrorText(409, "pending_payment", "RAW")).toMatch(/confirm or reject it first/i);
    expect(voidErrorText(409, "conflict", "RAW")).toMatch(/try again/i);
    expect(voidErrorText(409, "ledger_missing", "RAW")).not.toBe("RAW");
  });

  it("a 403 names who may void, and an unknown 409 reason falls back to the server's message", () => {
    expect(voidErrorText(403, undefined, "RAW")).toMatch(/administrators and owners/i);
    expect(voidErrorText(409, "something_new", "the server said so")).toBe("the server said so");
    expect(voidErrorText(400, undefined, "RAW")).toMatch(/four characters/i);
  });
});

describe("bank change · step-up (PV-D26)", () => {
  it("🔴 a 403 below high assurance means: verify a second factor, not 'forbidden'", () => {
    expect(classifyBankRefusal("linked")).toBe("step_up");
    expect(classifyBankRefusal("low")).toBe("step_up");
    expect(classifyBankRefusal(undefined)).toBe("step_up");
    expect(classifyBankRefusal(null)).toBe("step_up");
  });

  it("🔴 a 403 AT high assurance is the role, and sending the user round the step-up again would loop", () => {
    expect(classifyBankRefusal("high")).toBe("not_allowed");
  });

  it("builds the step-up link with the return path encoded", () => {
    expect(stepUpHref("/finance/settings/billing-profile")).toBe("/step-up?return=%2Ffinance%2Fsettings%2Fbilling-profile");
  });

  it("the bank block is all three fields or nothing, and the account number must be typed", () => {
    expect(validateBank({ bankName: "B", accountName: "A", accountNo: "1" })).toBeNull();
    expect(validateBank({ bankName: " ", accountName: "A", accountNo: "1" })?.field).toBe("bankName");
    expect(validateBank({ bankName: "B", accountName: "", accountNo: "1" })?.field).toBe("accountName");
    expect(validateBank({ bankName: "B", accountName: "A", accountNo: "" })?.field).toBe("accountNo");
  });
});
