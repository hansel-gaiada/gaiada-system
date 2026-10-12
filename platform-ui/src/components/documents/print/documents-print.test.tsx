// PV5-07 — the two document print routes' components and their data source. The pages themselves are thin (token ->
// payload -> component); what is pinned here is what a client reads on the PDF: the invoice of record and the evidence
// page's plain words about what the company seal proves and does not prove.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { InvoiceDocument } from "./InvoiceDocument";
import { ContractDocument } from "./ContractDocument";
import { DocumentRefusal } from "./DocumentRefusal";
import { DocumentTitle } from "./DocumentTitle";
import { formatAmount, formatDecimal, formatMoney, formatUtc } from "@/lib/documents-format";
import { DocumentPrintError, getDocumentPrintPayload, type ContractPrintPayload, type InvoicePrintPayload } from "@/lib/documents-print-data";

const invoice: InvoicePrintPayload = {
  kind: "invoice",
  renderNonce: "render-abc",
  invoice: {
    id: "i1", invoiceNo: "TST/2026/0007", status: "sent", issueDate: "2026-10-13", dueDate: "2026-11-12",
    periodStart: "2026-09-01", periodEnd: "2026-09-30", currency: "IDR", minorUnit: 0,
    subtotal: "15000000", taxTotal: "1650000", total: "16650000", taxCode: "PPN",
  },
  issuer: {
    legalName: "Example Issuer Legal Name", address: "1 Example Street\nExample City", npwp: "00.000.000.0-000.000", isPkp: true,
    bank: { name: "Example Bank", accountName: "Example Issuer Legal Name", accountNo: "0000000000" },
  },
  client: { name: "Example Client" },
  lines: [
    { lineNo: 1, description: "Design work", quantity: "12.50", unitPrice: "1200000", amount: "15000000", taxCode: "PPN", taxRate: "11.0000", taxAmount: "1650000" },
  ],
  taxLines: [{ code: "PPN", rate: "11.0000", base: "15000000", amount: "1650000" }],
};

const contract: ContractPrintPayload = {
  kind: "contract",
  renderNonce: "render-xyz",
  includeBody: true,
  contract: {
    id: "k1", title: "Website retainer", reference: "REF-1", version: 2, kind: "agreement", value: "150000000", currency: "IDR",
    startsOn: "2026-10-01", endsOn: "2027-09-30", sentAt: "2026-10-01T02:00:00.000Z", signedAt: "2026-10-03T03:04:05.000Z",
    contentSha256: "a".repeat(64), contentFixedAt: "2026-10-01T02:00:00.000Z", signatureTier: "attested",
    bodyMd: "## Scope\nThe exact words both parties signed.",
  },
  parties: { issuerLegalName: "Example Issuer Legal Name", clientName: "Example Client" },
  document: { source: "body", filename: null, sha256: "a".repeat(64) },
  signatures: [
    { party: "client", signerName: "Sam Signer", signerTitle: "Director", signedAt: "2026-10-02T01:00:00.000Z", ipHash: "b".repeat(64), userAgent: "Mozilla/5.0 test", contentSha256: "a".repeat(64) },
    { party: "provider", signerName: "Pat Provider", signerTitle: null, signedAt: "2026-10-03T03:04:05.000Z", ipHash: "c".repeat(64), userAgent: "Mozilla/5.0 staff", contentSha256: "a".repeat(64) },
  ],
  seal: {
    legalName: "Example Issuer Legal Name", certificateSerial: "4a1b", certificateFingerprint: "d".repeat(64),
    certificateValidTo: "2031-10-13T00:00:00.000Z", sealedAt: "2026-10-03T03:05:00.000Z",
  },
};

describe("formatting is exact (from the decimal string, never a float)", () => {
  it("groups thousands, pads or cuts to the currency's minor unit, never rounds", () => {
    expect(formatAmount("16650000", 0)).toBe("16,650,000");
    expect(formatAmount("1234567.5", 2)).toBe("1,234,567.50");
    expect(formatAmount("0.129", 2)).toBe("0.12");
    expect(formatAmount("-42", 2)).toBe("-42.00");
    expect(formatAmount("90071992547409931", 0)).toBe("90,071,992,547,409,931"); // past 2^53: a float would change it
    expect(formatMoney("1650000", "IDR", 0)).toBe("IDR 1,650,000");
    expect(formatDecimal("12.50")).toBe("12.5");
    expect(formatDecimal("11.0000")).toBe("11");
    expect(formatUtc("2026-10-13T04:05:06.789Z")).toBe("2026-10-13 04:05:06 UTC");
  });
});

describe("InvoiceDocument — the invoice of record", () => {
  it("shows the number, dates, frozen issuer, lines, tax, total and how to pay", () => {
    const { container } = render(<InvoiceDocument payload={invoice} />);
    const text = container.textContent ?? "";
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Invoice");
    for (const s of ["TST/2026/0007", "2026-10-13", "2026-11-12", "Example Issuer Legal Name", "NPWP 00.000.000.0-000.000",
      "Example Client", "Design work", "12.5", "IDR 16,650,000", "Tax PPN 11% on 15,000,000", "IDR 1,650,000",
      "Example Bank", "0000000000"]) {
      expect(text).toContain(s);
    }
    expect(screen.getByRole("region", { name: "How to pay" }).textContent).toContain("Payment reference");
    expect(text).not.toMatch(/VOID/);
  });

  it("a voided invoice says so and offers no payment instructions", () => {
    render(<InvoiceDocument payload={{ ...invoice, invoice: { ...invoice.invoice, status: "void" } }} />);
    expect(screen.getByRole("note").textContent).toMatch(/VOID/);
    expect(screen.queryByRole("region", { name: "How to pay" })).toBeNull();
  });
});

describe("ContractDocument — the agreement and its evidence page", () => {
  it("renders the body, then the evidence: parties, hash, signatures, IP hashes, user agents, tier, seal", () => {
    const { container } = render(<ContractDocument payload={contract} />);
    const text = container.textContent ?? "";
    expect(screen.getByRole("region", { name: "Agreement" }).textContent).toContain("The exact words both parties signed.");
    expect(text).toContain("IDR 150,000,000");
    const evidence = screen.getByRole("region", { name: "Signature evidence" }).textContent ?? "";
    for (const s of ["Website retainer", "REF-1", "version 2", "a".repeat(64), "b".repeat(64), "c".repeat(64),
      "Mozilla/5.0 test", "Mozilla/5.0 staff", "Sam Signer, Director", "Pat Provider", "Attested", "4a1b", "d".repeat(64),
      "2026-10-03 03:05:00 UTC"]) {
      expect(evidence).toContain(s);
    }
    expect(evidence).toContain("Each signature above was made over the content hash shown above.");
  });

  it("states plainly what the seal proves and what it does not", () => {
    render(<ContractDocument payload={contract} />);
    const evidence = screen.getByRole("region", { name: "Signature evidence" }).textContent ?? "";
    expect(evidence).toMatch(/has not been changed since Example Issuer Legal Name sealed it/);
    expect(evidence).toMatch(/not by a certification authority/);
    expect(evidence).toMatch(/identity could not be verified/);
    expect(evidence).toMatch(/legally they remain uncertified electronic signatures/);
    expect(evidence).toMatch(/no\s+independent timestamp service was used/);
  });

  it("an attached agreement renders only the evidence page, naming the file", () => {
    render(<ContractDocument payload={{ ...contract, includeBody: false, document: { source: "attached_pdf", filename: "terms.pdf", sha256: "a".repeat(64) } }} />);
    expect(screen.queryByRole("region", { name: "Agreement" })).toBeNull();
    expect(screen.getByRole("region", { name: "Signature evidence" }).textContent).toContain("terms.pdf");
  });
});

describe("the render nonce and the refusal", () => {
  it("DocumentTitle sets document.title to the nonce (the PDF /Title platform-nest checks)", () => {
    render(<DocumentTitle nonce="render-nonce-1" />);
    expect(document.title).toBe("render-nonce-1");
  });

  it("the refusal carries no nonce and no detail", () => {
    document.title = "before";
    render(<DocumentRefusal />);
    expect(screen.getByRole("alert").textContent).toMatch(/can.t be rendered/);
    expect(document.title).toBe("before");
  });
});

describe("getDocumentPrintPayload — one session-less fetch, every failure one error type", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    vi.unstubAllEnvs();
  });

  it("fetches the internal payload route with the token and returns a valid payload", async () => {
    vi.stubEnv("PLATFORM_URL", "http://nest.test");
    const f = vi.fn(async () => new Response(JSON.stringify(invoice), { status: 200 }));
    global.fetch = f as unknown as typeof fetch;
    const p = await getDocumentPrintPayload("A".repeat(43));
    expect(p.kind).toBe("invoice");
    expect(f).toHaveBeenCalledWith(`http://nest.test/internal/documents/print-payload/${"A".repeat(43)}`, expect.objectContaining({ cache: "no-store" }));
  });

  it("a burned token (401), a malformed body and a bad token all reject as DocumentPrintError", async () => {
    vi.stubEnv("PLATFORM_URL", "http://nest.test");
    global.fetch = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    await expect(getDocumentPrintPayload("B".repeat(43))).rejects.toBeInstanceOf(DocumentPrintError);
    global.fetch = (async () => new Response(JSON.stringify({ kind: "invoice" }), { status: 200 })) as unknown as typeof fetch;
    await expect(getDocumentPrintPayload("C".repeat(43))).rejects.toBeInstanceOf(DocumentPrintError);
    await expect(getDocumentPrintPayload("../../etc")).rejects.toBeInstanceOf(DocumentPrintError);
  });
});
