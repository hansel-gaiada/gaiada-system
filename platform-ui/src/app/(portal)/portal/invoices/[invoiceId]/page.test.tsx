import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { PortalInvoiceDetail } from "@/lib/portal";

// PV5-09 — the client's invoice page, rendered as the server renders it. An ISSUED invoice is laid out as the invoice of
// record (number, dates, issuer, tax, totals, PDF), "How to pay" comes from the issuer block frozen at issue, and the manual
// claim form has no "Card". The PDF is rendered after the commit (PV5-07), so an issued invoice with no file yet says "being
// prepared" (null and an older server's missing field read alike), and an invoice that was never issued promises no PDF.

vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => { throw new Error("redirect"); }),
  notFound: vi.fn(() => { throw new Error("notFound"); }),
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-client") }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(async () => ({ userId: "u-client" })) }));
vi.mock("@/lib/portal-company", () => ({ getActivePortalCompany: vi.fn(async () => ({ id: "northwind" })) }));
vi.mock("@/lib/portal-data", () => ({ getPortalInvoice: vi.fn() }));
vi.mock("@/lib/portalActions", () => ({ portalRecordPayment: vi.fn() }));
vi.mock("@/components/portal/PortalLive", () => ({ PortalLive: () => null }));

import { getPortalInvoice } from "@/lib/portal-data";
import PortalInvoicePage from "./page";

const invoiceMock = vi.mocked(getPortalInvoice);

const ISSUER = {
  legalName: "Example Agency Ltd", address: "1 Example Street", npwp: "00.000.000.0-000.000", isPkp: true,
  bank: { name: "Example Bank", accountName: "Example Agency Ltd", accountNo: "0000000000" },
};
const ISSUED: PortalInvoiceDetail = {
  id: "inv-1", status: "sent", currency: "IDR", total: 24_975_000, lines: [{ description: "Discovery", hours: 75, rate: 300_000, amount: 22_500_000 }],
  periodStart: "2026-09-01", periodEnd: "2026-09-30", issuedAt: "2026-10-02T03:00:00Z", clientName: "Example Client", clientId: "cl-1",
  payments: [], paid: 0, balance: 24_975_000,
  invoiceNo: "EX/2026/0021", issueDate: "2026-10-02", dueDate: "2026-11-01", subtotal: 22_500_000, taxTotal: 2_475_000, taxCode: "PPN",
  taxLines: [{ code: "PPN", rate: 11, base: 22_500_000, amount: 2_475_000 }],
  issuer: ISSUER, outstanding: 24_975_000, payable: true, pdfFileId: "f-pdf",
};

const mount = async (inv: PortalInvoiceDetail) => {
  invoiceMock.mockResolvedValue(inv);
  return render(await PortalInvoicePage({ params: Promise.resolve({ invoiceId: inv.id }) }));
};
// A card's heading also holds its "?" hint button, so the accessible name is "<title> ..." and is matched by prefix.
const heading = (title: string) => new RegExp(`^${title}`);
const card = (title: string) => screen.getByRole("heading", { name: heading(title) }).closest("section") as HTMLElement;

beforeEach(() => invoiceMock.mockReset());

describe("portal invoice · the invoice of record", () => {
  it("🔴 shows the number, issue and due dates, who issued it (legal name, address, tax id) and the PDF", async () => {
    await mount(ISSUED);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Invoice EX/2026/0021");
    const record = within(card("Invoice of record"));
    expect(record.getByText("EX/2026/0021")).toBeInTheDocument();
    expect(record.getByText("02 Oct 2026")).toBeInTheDocument();
    expect(record.getByText("01 Nov 2026")).toBeInTheDocument();
    expect(record.getByText("Example Agency Ltd")).toBeInTheDocument();
    expect(record.getByText("1 Example Street")).toBeInTheDocument();
    expect(record.getByText("00.000.000.0-000.000")).toBeInTheDocument();
    // The portal's OWN file route (never the staff one).
    expect(record.getByRole("link", { name: /Download invoice EX\/2026\/0021 \(PDF\)/ })).toHaveAttribute("href", "/api/northwind/portal/files/f-pdf");
  });

  it("🔴 lays out tax and totals from the API's lines: subtotal, each tax line, total", async () => {
    await mount(ISSUED);
    const covers = within(card("What this covers"));
    expect(covers.getByText("Subtotal")).toBeInTheDocument();
    expect(covers.getByText(/22,500,000/, { selector: "dd" })).toBeInTheDocument();
    expect(covers.getByText("PPN 11%")).toBeInTheDocument();
    expect(covers.getByText(/2,475,000/, { selector: "dd" })).toBeInTheDocument();
    expect(covers.getByText("Total")).toBeInTheDocument();
    expect(covers.getAllByText(/24,975,000/).length).toBeGreaterThan(0);
  });

  it("🔴 an issued invoice whose PDF is not rendered yet says 'being prepared': null and an older server's missing field read alike", async () => {
    const first = await mount({ ...ISSUED, pdfFileId: null });
    expect(within(card("Invoice of record")).getByText(/Being prepared/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Download invoice/ })).toBeNull();
    first.unmount();
    const withoutField: PortalInvoiceDetail = { ...ISSUED };
    delete withoutField.pdfFileId;
    await mount(withoutField);
    expect(within(card("Invoice of record")).getByText(/Being prepared/)).toBeInTheDocument();
  });

  it("🔴 an invoice that was never issued (no number) has no record card and promises no PDF", async () => {
    await mount({ ...ISSUED, invoiceNo: null, issueDate: null, dueDate: null, subtotal: null, taxTotal: null, taxLines: [], issuer: null, pdfFileId: null, payable: undefined });
    expect(screen.queryByRole("heading", { name: heading("Invoice of record") })).toBeNull();
    expect(screen.queryByText(/Being prepared/)).toBeNull();
    expect(screen.queryByRole("link", { name: /Download invoice/ })).toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/Sep 2026/);
  });
});

describe("portal invoice · how to pay", () => {
  it("🔴 shows the bank block from the frozen issuer snapshot, with the invoice number as the reference and the amount due", async () => {
    await mount(ISSUED);
    const pay = within(card("How to pay"));
    expect(pay.getByText("Example Bank")).toBeInTheDocument();
    expect(pay.getByText("0000000000")).toBeInTheDocument();
    expect(pay.getByText("Reference").nextElementSibling).toHaveTextContent("EX/2026/0021");
    expect(pay.getByText("Amount due").nextElementSibling).toHaveTextContent(/24,975,000/);
  });

  it("shows no How to pay, and no claim form, when the API says the invoice is not payable", async () => {
    await mount({ ...ISSUED, payable: false });
    expect(screen.queryByRole("heading", { name: heading("How to pay") })).toBeNull();
    expect(screen.queryByRole("heading", { name: /tell us you've paid/i })).toBeNull();
  });

  it("🔴 the manual claim form offers bank transfer, cash and other, and NO Card (design decision 17)", async () => {
    await mount(ISSUED);
    const select = screen.getByLabelText("How you paid") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["bank_transfer", "cash", "other"]);
    expect(screen.queryByRole("option", { name: "Card" })).toBeNull();
  });
});
