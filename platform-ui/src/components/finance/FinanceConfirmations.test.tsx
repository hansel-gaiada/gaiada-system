import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ArOpenInvoice, ApOpenBill } from "@/lib/finance";

// These actions revalidate their /finance page; since Next 16.3 the refreshed props (the period charged,
// the invoice/bill written off, the period now closed) are applied right after the action. Each rerender
// below stands in for that refresh: the confirmation the reader just earned must still be on screen.
const fa = vi.hoisted(() => ({
  runDepreciation: vi.fn(), writeOffArInvoice: vi.fn(), writeOffApBill: vi.fn(),
  createArCreditNote: vi.fn(), applyArCreditNote: vi.fn(),
  createApVendorCredit: vi.fn(), applyApVendorCredit: vi.fn(), recordBupotAmendment: vi.fn(),
}));
vi.mock("@/lib/financeActions", () => fa);

import { RunDepreciationForm } from "./RunDepreciationForm";
import { ConfirmAction } from "./ConfirmAction";
import { WriteOffInvoiceForm } from "./CreditNotesForms";
import { WriteOffBillForm } from "./ApCreditNotesForms";

beforeEach(() => { Object.values(fa).forEach((f) => f.mockReset().mockResolvedValue({ ok: true })); });

describe("finance confirmations survive the refresh", () => {
  it("depreciation: charging the last open period keeps the confirmation", async () => {
    const { rerender } = render(<RunDepreciationForm periods={[{ id: "p1", name: "Aug 2026" }]} />);
    fireEvent.click(screen.getByRole("button", { name: /Charge depreciation/ }));
    await screen.findByText("Depreciation charged and posted.");
    rerender(<RunDepreciationForm periods={[]} />);
    expect(screen.getByText(/Every open period has already been charged/)).toBeInTheDocument();
    expect(screen.getByText("Depreciation charged and posted.")).toHaveAttribute("role", "status");
  });

  it("period close/sign-off: done is not replaced by the refreshed disabledNote", async () => {
    const run = vi.fn(async () => ({ ok: true }));
    const props = { expected: "Aug 2026", expectedLabel: "period", consequence: "c", actionLabel: "Close this period", run };
    const { rerender } = render(<ConfirmAction {...props} disabledNote={null} />);
    fireEvent.change(screen.getByLabelText(/Type the period/), { target: { value: "Aug 2026" } });
    fireEvent.click(screen.getByRole("button", { name: "Close this period" }));
    await screen.findByText("Close this period — done.");
    rerender(<ConfirmAction {...props} disabledNote="Aug 2026 is already closed." />);
    expect(screen.getByText("Close this period — done.")).toHaveAttribute("role", "status");
    expect(screen.getByText("Aug 2026 is already closed.")).toBeInTheDocument();
  });

  it("AR write-off: the written-off invoice leaving the list keeps the confirmation", async () => {
    const inv = (id: string, no: string) => ({ id, invoiceNo: no, customerName: "Acme", outstanding: "1000" }) as ArOpenInvoice;
    const { rerender } = render(<WriteOffInvoiceForm openInvoices={[inv("i1", "INV-1"), inv("i2", "INV-2")]} />);
    fireEvent.change(screen.getByLabelText(/Type the invoice number/), { target: { value: "INV-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Write off this invoice" }));
    await screen.findByText("Write off this invoice — done.");
    rerender(<WriteOffInvoiceForm openInvoices={[inv("i2", "INV-2")]} />);
    expect(screen.getByText("INV-1 written off.")).toHaveAttribute("role", "status");
    rerender(<WriteOffInvoiceForm openInvoices={[]} />);
    expect(screen.getByText("INV-1 written off.")).toBeInTheDocument();
  });

  it("AP write-off: the written-off bill leaving the list keeps the confirmation", async () => {
    const bill = (id: string, no: string) => ({ id, billNo: no, vendorName: "Vend", outstanding: "1000" }) as ApOpenBill;
    const { rerender } = render(<WriteOffBillForm openBills={[bill("b1", "BILL-1"), bill("b2", "BILL-2")]} />);
    fireEvent.change(screen.getByLabelText(/Type the bill number/), { target: { value: "BILL-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Write off this bill" }));
    await screen.findByText("Write off this bill — done.");
    rerender(<WriteOffBillForm openBills={[bill("b2", "BILL-2")]} />);
    expect(screen.getByText("BILL-1 written off.")).toHaveAttribute("role", "status");
  });
});
