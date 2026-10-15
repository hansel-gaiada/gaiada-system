import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { me as meFixture, member } from "@/lib/workspaceFixtures";
import type { Me } from "@/lib/platform";

// DW-7e-2: the Receivables page offers the "Payments to confirm" queue to whoever may decide a payment (it mirrors Cerbos
// `invoice` update with `company.manage` or an elevated role) and reads nothing for anyone else. The page's other
// sections are mocked: what is pinned is the queue's gate and that a failed queue read never costs the rest of the page.
vi.mock("next/navigation", () => ({ redirect: vi.fn(() => { throw new Error("redirect"); }) }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(), PlatformError: class extends Error {} }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/finance", () => ({
  getArAging: vi.fn(async () => []), reconcileAr: vi.fn(async () => null), listPeriods: vi.fn(async () => [{ id: "p", startDate: "2000-01-01", endDate: "2999-12-31" }]),
  listArCustomers: vi.fn(async () => []), listArOpenInvoices: vi.fn(async () => []), listAccounts: vi.fn(async () => []),
  listArCreditNotes: vi.fn(async () => []), money: (n: unknown) => String(n),
}));
vi.mock("@/lib/finance-data", () => ({ listPendingPaymentsResult: vi.fn() }));
vi.mock("@/components/finance/AgingTable", () => ({ AgingTable: () => null }));
vi.mock("@/components/finance/ArForms", () => ({ IssueInvoiceForm: () => null, RecordReceiptForm: () => null, CreateCustomerForm: () => null }));
vi.mock("@/components/finance/CreditNotesForms", () => ({ IssueCreditNoteForm: () => null, CreditNotesTable: () => null, WriteOffInvoiceForm: () => null }));
vi.mock("@/lib/contractsActions", () => ({ decidePaymentAction: vi.fn() }));

import { getMe } from "@/lib/platform";
import { listPendingPaymentsResult } from "@/lib/finance-data";
import FinanceReceivablesPage from "./page";

const read = vi.mocked(listPendingPaymentsResult);
const admin = meFixture([{ role: "company_admin", scopeType: "company", scopeId: "co-a" }]);
const staff = meFixture([member()]);
const owner = meFixture([{ role: "owner", scopeType: "global", scopeId: null as unknown as string }]);
const operator = meFixture([{ role: "platform_admin", scopeType: "global", scopeId: null as unknown as string }]);
const mount = async (me: Me) => {
  vi.mocked(getMe).mockResolvedValue(me);
  return render(await FinanceReceivablesPage({ searchParams: Promise.resolve({}) }));
};

beforeEach(() => { read.mockReset(); });

describe("Receivables: the Payments to confirm section", () => {
  it("draws the queue for a company admin, from the company-wide read", async () => {
    read.mockResolvedValue({ kind: "ok", data: [] });
    await mount(admin);
    expect(read).toHaveBeenCalledWith("u-1", "co-a");
    expect(screen.getByRole("heading", { name: /Payments to confirm/ })).toBeInTheDocument();
    expect(screen.getByText(/No client payment is waiting for confirmation/)).toBeInTheDocument();
  });

  it("draws it for the owner and the platform operator, who decide too", async () => {
    read.mockResolvedValue({ kind: "ok", data: [] });
    const first = await mount(owner);
    expect(screen.getByRole("heading", { name: /Payments to confirm/ })).toBeInTheDocument();
    first.unmount();
    await mount(operator);
    expect(screen.getByRole("heading", { name: /Payments to confirm/ })).toBeInTheDocument();
  });

  it("does not draw it, and reads nothing, for someone who cannot decide a payment", async () => {
    read.mockResolvedValue({ kind: "ok", data: [] });
    await mount(staff);
    expect(read).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: /Payments to confirm/ })).toBeNull();
    expect(screen.getByRole("heading", { name: "Receivables" })).toBeInTheDocument();
  });

  it("a failed queue read says so in the section and keeps the rest of the page", async () => {
    read.mockResolvedValue({ kind: "unavailable", reason: "503" });
    await mount(admin);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load payments to confirm");
    expect(screen.queryByText(/No client payment is waiting/)).toBeNull();
    expect(screen.getByRole("heading", { name: "Receivables" })).toBeInTheDocument();
  });
});
