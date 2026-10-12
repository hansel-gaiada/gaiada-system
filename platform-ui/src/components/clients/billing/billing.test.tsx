import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Contract, InvoicePayment } from "@/lib/contracts";

// PV3-08 — the billing components render FROM the pure rules in lib/contracts.ts. These tests pin that:
// the Countersign control exists only for a row the backend marked `canCountersign`, a draft with nothing
// to send shows a disabled Send with its reason, Reject stays disabled until a reason is typed, and a
// server refusal (the maker-checker 403) is shown in words. The server actions are mocked: what is pinned
// is what the components do with each answer.
const send = vi.fn();
const voidIt = vi.fn();
const countersign = vi.fn();
const decide = vi.fn();
const create = vi.fn();
const update = vi.fn();
vi.mock("@/lib/contractsActions", () => ({
  sendContractAction: (...a: unknown[]) => send(...a),
  voidContractAction: (...a: unknown[]) => voidIt(...a),
  countersignContractAction: (...a: unknown[]) => countersign(...a),
  decidePaymentAction: (...a: unknown[]) => decide(...a),
  createContractAction: (...a: unknown[]) => create(...a),
  updateContractAction: (...a: unknown[]) => update(...a),
}));

import { ContractRow } from "./ContractRow";
import { PaymentRow } from "./PaymentRow";
import { ContractForm } from "./ContractForm";

const k = (over: Partial<Contract> = {}): Contract => ({
  id: "k1", clientId: "cl-1", clientName: "Northwind", projectId: null, projectName: null, title: "Retainer agreement",
  reference: "GDA-1", version: 1, supersedesId: null, status: "draft", fileId: null, bodyMd: null, value: 4000,
  currency: "USD", startsOn: null, endsOn: null, sentAt: null, signedAt: null, declineReason: null, createdBy: null,
  createdAt: "2026-10-01T00:00:00Z", clientSigned: false, providerSigned: false, termEnded: false, canCountersign: false,
  ...over,
});

const pay = (over: Partial<InvoicePayment> = {}): InvoicePayment => ({
  id: "p1", invoiceId: "inv-1", clientId: "cl-1", clientName: "Northwind", amount: 2400, currency: "USD", paidOn: "2026-10-01",
  method: "bank_transfer", reference: "TRX-1", status: "pending", note: null, proofFileId: "f-2", recordedBy: "u-client",
  recordedAt: "2026-10-01T00:00:00Z", confirmedBy: null, confirmedAt: null, rejectedReason: null, invoiceTotal: 6300, invoiceStatus: "sent",
  ...over,
});

const row = (c: Contract, extra: Partial<React.ComponentProps<typeof ContractRow>> = {}) =>
  render(<ul><ContractRow contract={c} clientId="cl-1" projects={[]} {...extra} /></ul>);

beforeEach(() => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of [send, voidIt, countersign, decide, create, update]) f.mockReset();
});

describe("ContractRow · Countersign", () => {
  it("🔴 shows Countersign only when the backend said canCountersign", () => {
    row(k({ id: "a", status: "sent", bodyMd: "x", canCountersign: true }));
    expect(screen.getByRole("button", { name: "Countersign" })).toBeInTheDocument();
  });

  it("🔴 shows NO Countersign for a sent contract the backend did not flag, even one the client has signed", () => {
    row(k({ status: "sent", bodyMd: "x", clientSigned: true, canCountersign: false }));
    expect(screen.queryByRole("button", { name: "Countersign" })).toBeNull();
    // It says what it is waiting for instead of offering a button the caller cannot use.
    expect(screen.getByText(/Waiting for our countersignature/)).toBeInTheDocument();
  });

  it("opens a form that explains both parties must sign, and sends the typed name and title", async () => {
    countersign.mockResolvedValue({ ok: true, notice: "Countersigned." });
    row(k({ status: "sent", bodyMd: "x", canCountersign: true }));
    fireEvent.click(screen.getByRole("button", { name: "Countersign" }));
    expect(screen.getByText(/once\s+both parties have signed/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Your full name"), { target: { value: "Olive Owner" } });
    fireEvent.change(screen.getByLabelText("Your title"), { target: { value: "Owner" } });
    fireEvent.submit(screen.getByRole("form", { name: "Countersign this contract" }));
    await waitFor(() => expect(countersign).toHaveBeenCalledTimes(1));
    const fd = countersign.mock.calls[0][1] as FormData;
    expect(fd.get("signerName")).toBe("Olive Owner");
    expect(fd.get("signerTitle")).toBe("Owner");
    expect(fd.get("contractId")).toBe("k1");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Countersigned."));
  });

  it("shows who has signed on a sent contract: party, name, title and date", () => {
    row(k({ status: "sent", bodyMd: "x", clientSigned: true }), {
      signatures: [{ party: "client", signer: "u", signerName: "Dana Whitfield", signerTitle: "Head of Marketing", signedAt: "2026-10-03T08:00:00Z" }],
    });
    const list = screen.getByRole("list", { name: "Signatures" });
    expect(list).toHaveTextContent("Client: Dana Whitfield, Head of Marketing");
  });

  it("🔴 when the signatures cannot be read it says so, and never reads as 'nobody has signed'", () => {
    row(k({ status: "sent", bodyMd: "x" }), { signaturesRefused: "you may not read it" });
    expect(screen.getByText(/cannot be read right now/)).toBeInTheDocument();
    expect(screen.getByText(/not a statement that nobody has/)).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Signatures" })).toBeNull();
  });
});

describe("ContractRow · Send", () => {
  it("🔴 a draft with nothing to send shows a DISABLED Send with the reason beside it", () => {
    row(k({ status: "draft", bodyMd: null, fileId: null }));
    const btn = screen.getByRole("button", { name: "Send to client" });
    expect(btn).toBeDisabled();
    expect(screen.getByText(/Write the terms or attach a PDF before sending/)).toBeInTheDocument();
    expect(btn.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("a draft with terms has an enabled Send and no reason; pressing it asks first, then calls the action", async () => {
    send.mockResolvedValue({ ok: true, notice: "Sent. 2 contacts were notified." });
    row(k({ status: "draft", bodyMd: "Terms." }));
    const btn = screen.getByRole("button", { name: "Send to client" });
    expect(btn).toBeEnabled();
    expect(screen.queryByText(/Write the terms or attach a PDF/)).toBeNull();
    fireEvent.click(btn);
    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("2 contacts were notified"));
  });

  it("declining the confirm sends nothing", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    row(k({ status: "draft", bodyMd: "Terms." }));
    fireEvent.click(screen.getByRole("button", { name: "Send to client" }));
    expect(send).not.toHaveBeenCalled();
  });

  it("a sent contract has no Send and no Edit, only Void", () => {
    row(k({ status: "sent", bodyMd: "x" }));
    expect(screen.queryByRole("button", { name: "Send to client" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.getByRole("button", { name: "Void" })).toBeInTheDocument();
  });

  it("a server refusal on Void is shown in words, not swallowed", async () => {
    voidIt.mockResolvedValue({ ok: false, error: "not authorized: cerbos denied update on contract" });
    row(k({ status: "sent", bodyMd: "x" }));
    fireEvent.click(screen.getByRole("button", { name: "Void" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("cerbos denied update on contract"));
  });
});

describe("PaymentRow", () => {
  it("🔴 Reject is disabled, with its reason beside it, until a reason is typed; Confirm needs none", () => {
    render(<ul><PaymentRow payment={pay()} clientId="cl-1" /></ul>);
    const reject = screen.getByRole("button", { name: "Reject" });
    expect(reject).toBeDisabled();
    expect(screen.getByText(/Say why you are rejecting/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm payment" })).toBeEnabled();
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "   " } });
    expect(reject).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "no matching transfer" } });
    expect(reject).toBeEnabled();
    expect(screen.queryByText(/Say why you are rejecting/)).toBeNull();
  });

  it("shows amount, method, reference, proof and the invoice link", () => {
    render(<ul><PaymentRow payment={pay()} clientId="cl-1" /></ul>);
    expect(screen.getByText(/2,400\.00/)).toBeInTheDocument();
    expect(screen.getByText(/Bank transfer/)).toBeInTheDocument();
    expect(screen.getByText(/Ref TRX-1/)).toBeInTheDocument();
    expect(screen.getByText(/Proof of payment attached/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Invoice/ })).toHaveAttribute("href", "/invoices/inv-1");
  });

  it("🔴 the maker-checker refusal is shown in full: 'you recorded this payment'", async () => {
    decide.mockResolvedValue({ ok: false, error: "You recorded this payment, so someone else has to confirm or reject it. Ask a colleague." });
    render(<ul><PaymentRow payment={pay()} clientId="cl-1" /></ul>);
    fireEvent.click(screen.getByRole("button", { name: "Confirm payment" }));
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("You recorded this payment"));
  });

  it("the Confirm button carries its decision in the form data", async () => {
    decide.mockResolvedValue({ ok: true, notice: "Confirmed. The balance is updated." });
    render(<ul><PaymentRow payment={pay()} clientId="cl-1" /></ul>);
    fireEvent.click(screen.getByRole("button", { name: "Confirm payment" }));
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
    const fd = decide.mock.calls[0][1] as FormData;
    expect(fd.get("decision")).toBe("confirm");
    expect(fd.get("paymentId")).toBe("p1");
  });
});

describe("ContractForm", () => {
  it("offers a project only when the projects read worked, and says so when it did not", () => {
    const { unmount } = render(<ContractForm clientId="cl-1" projects={[{ id: "p1", name: "Website redesign" }]} />);
    expect(screen.getByLabelText(/Project/)).toBeInTheDocument();
    unmount();
    render(<ContractForm clientId="cl-1" projects={null} />);
    expect(screen.queryByLabelText(/Project/)).toBeNull();
    expect(screen.getByText(/projects cannot be read right now/)).toBeInTheDocument();
  });

  it("has an optional PDF input and shows a failed attach as a field error that says the draft was saved", async () => {
    create.mockResolvedValue({ ok: false, id: "k9", field: "file", error: "The draft was saved, but the PDF could not be attached (too big)." });
    render(<ContractForm clientId="cl-1" projects={[]} />);
    const file = screen.getByLabelText("PDF (optional)") as HTMLInputElement;
    expect(file.type).toBe("file");
    expect(file.required).toBe(false);
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: "MSA" } });
    fireEvent.submit(screen.getByRole("form", { name: "New draft contract" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The draft was saved"));
  });

  it("edit mode has no project field (it is fixed at creation) and a Close button", () => {
    render(<ContractForm clientId="cl-1" projects={[{ id: "p1", name: "X" }]} contract={k({ bodyMd: "t" })} onDone={() => {}} />);
    expect(screen.queryByLabelText(/Project/)).toBeNull();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });
});
