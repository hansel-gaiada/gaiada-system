import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";
import type { Invoice } from "@/lib/invoice";
import type { Me } from "@/lib/platform";

// DW-10f-3b (BFF §61.5, §61.9) — the staff invoice page for an invoice made FROM THE SCHEDULE: an instalment line reads "Fixed fee", quantity
// 1, linked to its contract, and never prints the hours or rate it does not have; a draft or approved invoice that was never issued gets
// "Cancel draft" behind a confirm step that says the instalments go back to the schedule; and the three new readiness blockers link the
// client's contracts. The actions are mocked: what is pinned is what the page and the component show and send.
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => { throw new Error("redirect"); }),
  notFound: vi.fn(() => { throw new Error("notFound"); }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a>,
}));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-fin") }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("@/lib/platform", async () => {
  const actual = await vi.importActual<typeof import("@/lib/platform")>("@/lib/platform");
  return { ...actual, getMe: vi.fn() };
});
vi.mock("@/lib/invoice", () => ({ getInvoice: vi.fn(), getIssueReadiness: vi.fn() }));
vi.mock("@/lib/entities", () => ({ listMembers: vi.fn(async () => []) }));
const cancelAction = vi.fn();
vi.mock("@/lib/invoiceActions", () => ({
  approveInvoiceAction: vi.fn(), issueInvoiceAction: vi.fn(), voidInvoiceAction: vi.fn(), setServiceLineAction: vi.fn(),
  cancelDraftInvoiceAction: (...a: unknown[]) => cancelAction(...a),
}));
vi.mock("@/lib/billingNumbering-data", () => ({ serviceLinesOrNull: vi.fn(async () => null) }));

import { getMe } from "@/lib/platform";
import { getInvoice, getIssueReadiness } from "@/lib/invoice";
import InvoiceDetailPage from "./page";

const meMock = vi.mocked(getMe);
const invoiceMock = vi.mocked(getInvoice);
const readinessMock = vi.mocked(getIssueReadiness);

const ADMIN: Me = { userId: "u-fin", name: "Fin", email: "f@example.test", title: null, assurance: "high", companies: [{ id: "co-1", name: "Example", type: null }], roles: [{ role: "platform_admin", scopeType: "global", scopeId: null }] };
const MEMBER: Me = { ...ADMIN, roles: [{ role: "member", scopeType: "company", scopeId: "co-1" }] };

const DRAFT: Invoice = {
  id: "inv-d", clientId: "cl-4", clientName: "Viceroy", periodStart: "2026-10-09", periodEnd: "2026-10-14", status: "draft",
  currency: "IDR", total: 45_000_000,
  lines: [
    { kind: "instalment", description: "GDA-2026-041 Website build agreement (signed) · Milestone: design approved (2 of 3)", contractId: "k-12", instalmentId: "i-2", projectId: null, amount: 30_000_000 },
    { kind: "instalment", description: "GDA-2026-041-A1 Amendment 1 · Amendment fee (1 of 1)", contractId: "k-13", instalmentId: "i-4", projectId: null, amount: 15_000_000 },
  ],
  createdAt: "2026-10-19T09:00:00Z", createdBy: "u-fin", approvedBy: null, approvedAt: null, updatedBy: "u-fin", clientVisible: false,
};
const HOURLY: Invoice = {
  ...DRAFT, id: "inv-h", currency: "USD", total: 6300,
  lines: [{ description: "Billable time 2026-06", hours: 42, rate: 150, amount: 6300 }],
};

const mount = async (inv: Invoice, me: Me = ADMIN) => {
  meMock.mockResolvedValue(me);
  invoiceMock.mockResolvedValue(inv);
  return render(await InvoiceDetailPage({ params: Promise.resolve({ invoiceId: inv.id }) }));
};
const lines = () => within(screen.getByRole("heading", { name: /^Line items/ }).closest("section") as HTMLElement);

beforeEach(() => { meMock.mockReset(); invoiceMock.mockReset(); readinessMock.mockReset(); cancelAction.mockReset(); });

describe("invoice page · instalment lines", () => {
  it("🔴 an instalment line reads Fixed fee, quantity 1, and links its contract; never 'undefined'", async () => {
    const { container } = await mount(DRAFT);
    const card = lines();
    expect(card.getAllByText("Fixed fee")).toHaveLength(2);
    expect(card.getAllByText("1")).toHaveLength(2);
    expect(card.getByText(/Milestone: design approved \(2 of 3\)/)).toBeInTheDocument();
    const links = card.getAllByRole("link", { name: "Contract" });
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/clients/cl-4/billing#contract-k-12", "/clients/cl-4/billing#contract-k-13"]);
    expect(container.textContent).not.toMatch(/undefined|NaN/);
    expect(card.getByText(/30,000,000/)).toBeInTheDocument();
    expect(card.getByText(/15,000,000/)).toBeInTheDocument();
  });

  it("an hourly line is unchanged: its hours and its rate, and no Fixed fee, no contract link", async () => {
    await mount(HOURLY);
    const card = lines();
    expect(card.getByText("42")).toBeInTheDocument();
    expect(card.getByText(/150\.00/)).toBeInTheDocument();
    expect(card.queryByText("Fixed fee")).toBeNull();
    expect(card.queryByRole("link", { name: "Contract" })).toBeNull();
  });

  it("a legacy line with neither hours nor rate still never prints 'undefined'", async () => {
    const { container } = await mount({ ...HOURLY, lines: [{ description: "Odd line", amount: 10 } as never] });
    expect(container.textContent).not.toMatch(/undefined/);
    expect(lines().getByText("Fixed fee")).toBeInTheDocument();
  });
});

describe("invoice page · Cancel draft", () => {
  it("🔴 a draft that was never issued offers Cancel draft, saying the instalments go back to the schedule", async () => {
    await mount(DRAFT);
    const card = screen.getByRole("heading", { name: "Cancel draft" }).closest("section") as HTMLElement;
    expect(within(card).getByRole("button", { name: "Cancel draft…" })).toBeInTheDocument();
    expect(within(card).getByText("The instalments go back to the payment schedule.")).toBeInTheDocument();
  });

  it("an approved invoice that was never issued offers it too; an hourly draft gets the plain wording", async () => {
    const first = await mount({ ...DRAFT, status: "approved" });
    expect(screen.getByRole("button", { name: "Cancel draft…" })).toBeInTheDocument();
    first.unmount();
    await mount(HOURLY);
    const card = screen.getByRole("heading", { name: "Cancel draft" }).closest("section") as HTMLElement;
    expect(within(card).getByText("Marks the draft void. Nothing is posted to the books.")).toBeInTheDocument();
    expect(within(card).queryByText(/payment schedule/)).toBeNull();
  });

  it("🔴 is for company.manage, and is not offered on an issued invoice (that is voided with a reason)", async () => {
    const first = await mount(DRAFT, MEMBER);
    expect(screen.queryByRole("button", { name: "Cancel draft…" })).toBeNull();
    first.unmount();
    await mount({ ...DRAFT, status: "sent", invoiceNo: "EX/1", issuedAt: "2026-10-03T09:00:00Z", subtotal: 1, taxTotal: 0, issuer: null, pdfFileId: null });
    expect(screen.queryByRole("button", { name: "Cancel draft…" })).toBeNull();
    expect(screen.getByRole("button", { name: /Void this invoice/ })).toBeInTheDocument();
  });

  it("🔴 a click only opens the confirm; cancelling sends nothing until 'Cancel this draft', and 'Keep the draft' closes it", async () => {
    await mount(DRAFT);
    fireEvent.click(screen.getByRole("button", { name: "Cancel draft…" }));
    const confirm = screen.getByRole("form", { name: "Confirm cancelling this draft" });
    expect(within(confirm).getByText(/The 2 instalments on it go back to the payment schedule, due again and ready to invoice\./)).toBeInTheDocument();
    expect(within(confirm).getByText(/A cancelled draft cannot be brought back/)).toBeInTheDocument();
    expect(cancelAction).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Keep the draft" }));
    expect(screen.queryByRole("form", { name: "Confirm cancelling this draft" })).toBeNull();
  });

  it("sends the cancel and shows how many instalments went back to the schedule", async () => {
    cancelAction.mockResolvedValue({ ok: true, notice: "Draft cancelled. 2 instalments go back to the payment schedule, ready to invoice again." });
    await mount(DRAFT);
    fireEvent.click(screen.getByRole("button", { name: "Cancel draft…" }));
    fireEvent.submit(screen.getByRole("form", { name: "Confirm cancelling this draft" }));
    await waitFor(() => expect(cancelAction).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("status")).toHaveTextContent("Draft cancelled. 2 instalments go back to the payment schedule, ready to invoice again.");
  });

  it("shows a refusal next to the button", async () => {
    cancelAction.mockResolvedValue({ error: "This invoice has been issued, so it can no longer be cancelled as a draft. Void it instead, which reverses it in the books." });
    await mount(DRAFT);
    fireEvent.click(screen.getByRole("button", { name: "Cancel draft…" }));
    fireEvent.submit(screen.getByRole("form", { name: "Confirm cancelling this draft" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Void it instead/);
  });

  it("a cancelled (void) draft that was never issued says so, and offers no second cancel", async () => {
    await mount({ ...DRAFT, status: "void" });
    expect(screen.getByText("This draft was cancelled. It never reached the books.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel draft…" })).toBeNull();
  });
});

describe("invoice page · the three new readiness blockers", () => {
  it("🔴 each links the client's contracts, so the person can see which agreement the draft depends on", async () => {
    readinessMock.mockResolvedValue({
      invoiceId: "inv-d", status: "approved", issued: false, invoiceNo: null, ready: false,
      blockers: [
        { code: "INSTALMENT_CONTRACT_NOT_SIGNED", message: "a line's contract is no longer signed (it was voided after this draft); cancel the draft, which releases its instalments" },
        { code: "INSTALMENT_SUPERSEDED", message: "a signed version now supersedes a line's contract; cancel the draft" },
        { code: "INSTALMENT_LINES_INVALID", message: "an instalment line names an instalment this invoice does not claim" },
      ],
    });
    await mount({ ...DRAFT, status: "approved" });
    const list = screen.getByText("This invoice can't be issued yet. Clear these first:").closest("div") as HTMLElement;
    const links = within(list).getAllByRole("link", { name: "Open the client's contracts" });
    expect(links).toHaveLength(3);
    for (const l of links) expect(l).toHaveAttribute("href", "/clients/cl-4/billing");
  });

  it("an hourly invoice's blockers get no contract link", async () => {
    readinessMock.mockResolvedValue({
      invoiceId: "inv-h", status: "approved", issued: false, invoiceNo: null, ready: false,
      blockers: [{ code: "NO_SERVICE_LINE", message: "the invoice has no service line" }],
    });
    await mount({ ...HOURLY, status: "approved" });
    expect(screen.queryByRole("link", { name: "Open the client's contracts" })).toBeNull();
  });
});
