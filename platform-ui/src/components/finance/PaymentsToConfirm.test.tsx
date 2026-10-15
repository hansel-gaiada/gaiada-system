import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import type { InvoicePayment } from "@/lib/contracts";

// DW-7e-2: Finance's company-wide "Payments to confirm" queue on Receivables. The rows are the client hub's own `PaymentRow`
// (its Reject-needs-a-reason and maker-checker behaviour is pinned in billing.test.tsx); what is pinned here is the queue: an
// empty queue, rows naming their client, a failed read that never reads as "none", and the decide wiring with no client hub.
const decide = vi.fn();
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/contractsActions", () => ({ decidePaymentAction: (...a: unknown[]) => decide(...a) }));

import { PaymentsToConfirm } from "./PaymentsToConfirm";

const pay = (over: Partial<InvoicePayment> = {}): InvoicePayment => ({
  id: "p1", invoiceId: "inv-1", clientId: "cl-1", clientName: "Northwind", amount: 2400, currency: "USD", paidOn: "2026-10-01",
  method: "bank_transfer", reference: "TRX-1", status: "pending", note: "Paid from our Mandiri account", proofFileId: null, recordedBy: "u-client",
  recordedAt: "2026-10-01T00:00:00Z", confirmedBy: null, confirmedAt: null, rejectedReason: null, invoiceTotal: 6300, invoiceStatus: "sent",
  ...over,
});

beforeEach(() => { vi.spyOn(window, "confirm").mockReturnValue(true); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); decide.mockReset(); });

describe("PaymentsToConfirm", () => {
  it("carries the anchor the Overview tile and quick action point at", () => {
    const { container } = render(<PaymentsToConfirm result={{ kind: "ok", data: [] }} />);
    expect(container.querySelector("#payments-to-confirm")).not.toBeNull();
  });

  it("says so, in words, for an empty queue (a real answer: the read succeeded)", () => {
    render(<PaymentsToConfirm result={{ kind: "ok", data: [] }} />);
    expect(screen.getByRole("heading", { name: /Payments to confirm · 0/ })).toBeInTheDocument();
    expect(screen.getByText(/No client payment is waiting for confirmation/)).toBeInTheDocument();
  });

  it("lists each pending payment with its client, amount, date, reference, note and Confirm and Reject", () => {
    render(<PaymentsToConfirm result={{ kind: "ok", data: [pay(), pay({ id: "p2", clientId: null, clientName: null, reference: null, note: null })] }} />);
    expect(screen.getByRole("heading", { name: /Payments to confirm · 2/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Northwind" })).toHaveAttribute("href", "/clients/cl-1/billing");
    expect(screen.getByText(/Internal \(no client\)/)).toBeInTheDocument();
    expect(screen.getAllByText(/2,400\.00/)).toHaveLength(2);
    expect(screen.getByText(/Ref TRX-1/)).toBeInTheDocument();
    expect(screen.getByText(/Paid from our Mandiri account/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Confirm payment" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Reject" })).toHaveLength(2);
    expect(screen.queryByText(/No client payment is waiting/)).toBeNull();
  });

  it("a failed read says 'Could not load payments to confirm', never that none are waiting", () => {
    render(<PaymentsToConfirm result={{ kind: "unavailable", reason: "502 bad gateway" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load payments to confirm");
    expect(screen.getByText(/502 bad gateway/)).toBeInTheDocument();
    expect(screen.queryByText(/No client payment is waiting/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Confirm payment" })).toBeNull();
    expect(screen.queryByText(/· 0/)).toBeNull();
  });

  it("a refused read says the viewer has no access, never an empty queue", () => {
    render(<PaymentsToConfirm result={{ kind: "forbidden" }} />);
    expect(screen.getByText(/have access to payments to confirm/)).toBeInTheDocument();
    expect(screen.queryByText(/No client payment is waiting/)).toBeNull();
  });

  it("decides through the existing action with the payment id and no client id", async () => {
    decide.mockResolvedValue({ ok: true, notice: "Confirmed. The balance is updated." });
    render(<PaymentsToConfirm result={{ kind: "ok", data: [pay({ clientId: null, clientName: null })] }} />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm payment" }));
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
    const fd = decide.mock.calls[0][1] as FormData;
    expect(fd.get("decision")).toBe("confirm");
    expect(fd.get("paymentId")).toBe("p1");
    expect(fd.get("clientId")).toBeNull();
  });

  it("Reject needs a reason and sends it; the server refusal is shown in words", async () => {
    decide.mockResolvedValue({ ok: false, error: "You recorded this payment, so someone else has to confirm or reject it. Ask a colleague." });
    render(<PaymentsToConfirm result={{ kind: "ok", data: [pay()] }} />);
    const reject = screen.getByRole("button", { name: "Reject" });
    expect(reject).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "no matching transfer" } });
    expect(reject).toBeEnabled();
    fireEvent.click(reject);
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
    const fd = decide.mock.calls[0][1] as FormData;
    expect(fd.get("decision")).toBe("reject");
    expect(fd.get("reason")).toBe("no matching transfer");
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("You recorded this payment"));
  });
});
