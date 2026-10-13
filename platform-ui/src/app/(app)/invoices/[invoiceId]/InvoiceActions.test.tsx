import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// PV5-09 — the invoice page's controls: Issue (with what is missing shown BEFORE the click) and Void (behind a confirm step).
// The server actions are mocked: what is pinned is what the components offer and say for each answer.
const approve = vi.fn();
const issue = vi.fn();
const voidIt = vi.fn();
vi.mock("@/lib/invoiceActions", () => ({
  approveInvoiceAction: (...a: unknown[]) => approve(...a),
  issueInvoiceAction: (...a: unknown[]) => issue(...a),
  voidInvoiceAction: (...a: unknown[]) => voidIt(...a),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a>,
}));

import { InvoiceActions } from "./InvoiceActions";
import { VoidInvoice } from "./VoidInvoice";

const base = { invoiceId: "inv-1", canApprove: false, canBill: true, isCreator: false, legacyUnknownCreator: false };

beforeEach(() => { approve.mockReset(); issue.mockReset(); voidIt.mockReset(); });

describe("InvoiceActions · Issue", () => {
  it("🔴 with blockers known beforehand, Issue is DISABLED and says why (described-by), instead of failing on click", () => {
    render(<InvoiceActions {...base} status="approved" blockerCount={2} />);
    const btn = screen.getByRole("button", { name: "Issue" });
    expect(btn).toBeDisabled();
    expect(btn.getAttribute("aria-describedby")).toBe("issue-blocked-reason");
    expect(document.getElementById("issue-blocked-reason")).toHaveTextContent(/Not ready to issue yet/);
    fireEvent.click(btn);
    expect(issue).not.toHaveBeenCalled();
  });

  it("with nothing missing, Issue is enabled and the note says so", () => {
    render(<InvoiceActions {...base} status="approved" blockerCount={0} />);
    expect(screen.getByRole("button", { name: "Issue" })).toBeEnabled();
    expect(screen.getByText(/nothing is missing/)).toBeInTheDocument();
  });

  it("🔴 with no answer from the readiness read (null), Issue stays enabled and nothing is claimed either way", () => {
    render(<InvoiceActions {...base} status="approved" blockerCount={null} />);
    expect(screen.getByRole("button", { name: "Issue" })).toBeEnabled();
    expect(screen.queryByText(/nothing is missing/)).toBeNull();
    expect(screen.queryByText(/Not ready to issue yet/)).toBeNull();
  });

  it("if the server's own re-check finds blockers on click, ALL of them are listed with their links", async () => {
    issue.mockResolvedValue({
      error: "This invoice can't be issued yet:",
      blockers: [
        { code: "NO_OPEN_PERIOD", message: "no open accounting period covers today" },
        { code: "NO_BANK_DETAILS", message: "the billing profile has no bank account" },
      ],
    });
    render(<InvoiceActions {...base} status="approved" blockerCount={0} />);
    fireEvent.click(screen.getByRole("button", { name: "Issue" }));
    await waitFor(() => expect(issue).toHaveBeenCalledTimes(1));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("no open accounting period covers today");
    expect(alert).toHaveTextContent("the billing profile has no bank account");
    expect(screen.getByRole("link", { name: "Open the billing profile" })).toHaveAttribute("href", "/finance/settings/billing-profile");
  });

  it("an issued invoice has no Issue and says it is marked paid only when payments cover it", () => {
    render(<InvoiceActions {...base} status="sent" invoiceNo="EX/2026/0001" />);
    expect(screen.queryByRole("button", { name: "Issue" })).toBeNull();
    expect(screen.getByText(/Issued as EX\/2026\/0001/)).toBeInTheDocument();
  });
});

describe("VoidInvoice · behind a confirm step", () => {
  it("🔴 the button does NOT void: it opens a panel that says what will happen and asks for a reason", () => {
    render(<VoidInvoice invoiceId="inv-1" invoiceNo="EX/2026/0001" />);
    fireEvent.click(screen.getByRole("button", { name: /Void this invoice/ }));
    expect(voidIt).not.toHaveBeenCalled();
    expect(screen.getByText(/credit note for the full amount is posted in the ledger/i)).toBeInTheDocument();
    expect(screen.getByText("EX/2026/0001")).toBeInTheDocument();
    expect(screen.getByLabelText("Why is it being voided?")).toBeInTheDocument();
  });

  it("🔴 Confirm void stays disabled until a reason of at least four characters is typed", () => {
    render(<VoidInvoice invoiceId="inv-1" invoiceNo={null} />);
    fireEvent.click(screen.getByRole("button", { name: /Void this invoice/ }));
    const confirm = screen.getByRole("button", { name: "Confirm void" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Why is it being voided?"), { target: { value: "abc" } });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Why is it being voided?"), { target: { value: "issued in error" } });
    expect(confirm).toBeEnabled();
  });

  it("Cancel closes the panel and discards the reason, calling nothing", () => {
    render(<VoidInvoice invoiceId="inv-1" invoiceNo={null} />);
    fireEvent.click(screen.getByRole("button", { name: /Void this invoice/ }));
    fireEvent.change(screen.getByLabelText("Why is it being voided?"), { target: { value: "issued in error" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(voidIt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Void this invoice/ }));
    expect(screen.getByLabelText("Why is it being voided?")).toHaveValue("");
  });

  it("confirming sends the typed reason to the action", async () => {
    voidIt.mockResolvedValue({ ok: true });
    render(<VoidInvoice invoiceId="inv-1" invoiceNo={null} />);
    fireEvent.click(screen.getByRole("button", { name: /Void this invoice/ }));
    fireEvent.change(screen.getByLabelText("Why is it being voided?"), { target: { value: "issued in error" } });
    fireEvent.submit(screen.getByRole("form", { name: "Confirm voiding this invoice" }));
    await waitFor(() => expect(voidIt).toHaveBeenCalledTimes(1));
    const fd = voidIt.mock.calls[0][2] as FormData; // (invoiceId, previous state, form data): the id is bound
    expect(fd.get("reason")).toBe("issued in error");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/credit note for the full amount was posted/i));
  });

  it("🔴 a 409 reason is shown in plain words next to the button, and the panel stays open to try again or cancel", async () => {
    voidIt.mockResolvedValue({ error: "This invoice can't be voided because money has been applied to it, or it is already settled or written off. Raise a credit note in Finance instead." });
    render(<VoidInvoice invoiceId="inv-1" invoiceNo={null} />);
    fireEvent.click(screen.getByRole("button", { name: /Void this invoice/ }));
    fireEvent.change(screen.getByLabelText("Why is it being voided?"), { target: { value: "issued in error" } });
    fireEvent.submit(screen.getByRole("form", { name: "Confirm voiding this invoice" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Raise a credit note in Finance/));
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });
});
