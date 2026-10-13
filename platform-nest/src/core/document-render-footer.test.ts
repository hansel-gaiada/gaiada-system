// PV5-F1: the PDF footer of an issued invoice / sealed contract names the issuer and the document, never a fixed company.
import { describe, expect, it } from "vitest";
import { documentFooterText, type DocumentPrintPayload } from "./document-render";

const invoice = (legalName: string, invoiceNo: string) =>
  ({ kind: "invoice", issuer: { legalName }, invoice: { invoiceNo } }) as unknown as DocumentPrintPayload;
const contract = (issuerLegalName: string, reference: string | null) =>
  ({ kind: "contract", parties: { issuerLegalName }, contract: { reference } }) as unknown as DocumentPrintPayload;

describe("documentFooterText", () => {
  it("an invoice: issuer legal name and invoice number", () => {
    expect(documentFooterText(invoice("Issuer Ltd", "INV/2026/0001"))).toBe("Issuer Ltd - INV/2026/0001");
  });
  it("a contract: issuer legal name and the contract reference", () => {
    expect(documentFooterText(contract("Issuer Ltd", "MSA-7"))).toBe("Issuer Ltd - MSA-7");
  });
  it("a contract with no reference: the issuer alone, no dangling separator", () => {
    expect(documentFooterText(contract("Issuer Ltd", null))).toBe("Issuer Ltd");
  });
  it("never carries a hard-coded company name", () => {
    expect(documentFooterText(invoice("Other Co", "N-1"))).not.toMatch(/gaiada/i);
  });
});
