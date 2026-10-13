import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { Invoice } from "@/lib/invoice";
import type { Me } from "@/lib/platform";

// PV5-09 — the staff invoice page rendered as the server renders it: the issued view (number, dates, PDF or "being
// prepared", the issuer as frozen with the bank account masked, tax and totals, the ledger link for the finance read tier,
// Void) and, for an approved invoice, what is MISSING before it can be issued (read before any click).

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
vi.mock("@/lib/invoiceActions", () => ({
  approveInvoiceAction: vi.fn(), issueInvoiceAction: vi.fn(), voidInvoiceAction: vi.fn(), setServiceLineAction: vi.fn(),
}));
// PV5-04b: the company's service lines, for the picker. `null` (the default here) = the viewer cannot read them: no picker.
vi.mock("@/lib/billingNumbering-data", () => ({ serviceLinesOrNull: vi.fn(async () => null) }));

import { getMe } from "@/lib/platform";
import { getInvoice, getIssueReadiness } from "@/lib/invoice";
import { serviceLinesOrNull } from "@/lib/billingNumbering-data";
import InvoiceDetailPage from "./page";

const meMock = vi.mocked(getMe);
const invoiceMock = vi.mocked(getInvoice);
const readinessMock = vi.mocked(getIssueReadiness);
const linesMock = vi.mocked(serviceLinesOrNull);
const LINES = [
  { key: "web", name: "Web development", departmentId: "dept-web", active: true, updatedAt: "2026-10-01T09:00:00Z", invoiceCount: 2 },
  { key: "seo", name: "Search", departmentId: null, active: true, updatedAt: "2026-10-01T09:00:00Z", invoiceCount: 0 },
  { key: "old", name: "Retired line", departmentId: null, active: false, updatedAt: "2026-10-01T09:00:00Z", invoiceCount: 1 },
];

const ADMIN: Me = { userId: "u-fin", name: "Fin", email: "f@example.test", title: null, assurance: "high", companies: [{ id: "co-1", name: "Example", type: null }], roles: [{ role: "platform_admin", scopeType: "global", scopeId: null }] };
const MEMBER: Me = { ...ADMIN, roles: [{ role: "member", scopeType: "company", scopeId: "co-1" }] };

const ISSUED: Invoice = {
  id: "inv-1", clientId: "cl-1", clientName: "Example Client", periodStart: "2026-09-01", periodEnd: "2026-09-30", status: "sent",
  currency: "USD", total: 1110, lines: [{ description: "Billable time", hours: 10, rate: 100, amount: 1000 }],
  createdAt: "2026-10-01T09:00:00Z", createdBy: "u-other", approvedBy: "u-approver", approvedAt: "2026-10-02T09:00:00Z", updatedBy: "u-approver",
  clientVisible: true,
  invoiceNo: "EX/2026/0001", issuedAt: "2026-10-03T09:00:00Z", issuedBy: "u-approver", issueDate: "2026-10-03", dueDate: "2026-11-02",
  subtotal: 1000, taxTotal: 110, taxCode: "PPN", arInvoiceId: "ar-1", legacyUnissued: false, pdfFileId: "f-pdf",
  issuer: { legalName: "Example Agency Ltd", address: "1 Example Street", npwp: "00.000.000.0-000.000", isPkp: true,
    bank: { name: "Example Bank", accountName: "Example Agency Ltd", accountNo: "1234567890" } },
};

const mount = async (inv: Invoice, me: Me = ADMIN) => {
  meMock.mockResolvedValue(me);
  invoiceMock.mockResolvedValue(inv);
  return render(await InvoiceDetailPage({ params: Promise.resolve({ invoiceId: inv.id }) }));
};
const card = (title: string) => screen.getByRole("heading", { name: new RegExp(`^${title}`) }).closest("section") as HTMLElement;

beforeEach(() => { meMock.mockReset(); invoiceMock.mockReset(); readinessMock.mockReset(); linesMock.mockReset(); linesMock.mockResolvedValue(null); });

describe("staff invoice page · the issued view", () => {
  it("🔴 shows the invoice of record: number, issue and due dates, and the PDF through the staff file route", async () => {
    await mount(ISSUED);
    const record = within(card("Invoice of record"));
    expect(record.getByText("EX/2026/0001")).toBeInTheDocument();
    expect(record.getByText("03 Oct 2026")).toBeInTheDocument();
    expect(record.getByText("02 Nov 2026")).toBeInTheDocument();
    expect(record.getByRole("link", { name: /Invoice EX\/2026\/0001 PDF/ })).toHaveAttribute("href", "/api/files/f-pdf");
    expect(screen.getByText("Issued", { selector: ".lux-badge" })).toBeInTheDocument();
  });

  it("🔴 an issued invoice whose PDF is not rendered yet says 'being prepared': null and a missing field read alike", async () => {
    const first = await mount({ ...ISSUED, pdfFileId: null });
    expect(within(card("Invoice of record")).getByText(/Being prepared/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /PDF/ })).toBeNull();
    first.unmount();
    const older: Invoice = { ...ISSUED };
    delete older.pdfFileId;
    await mount(older);
    expect(within(card("Invoice of record")).getByText(/Being prepared/)).toBeInTheDocument();
  });

  it("shows the issuer as frozen, with the bank account masked until Show", async () => {
    await mount(ISSUED);
    const issuer = within(card("Issued by"));
    // The legal name, and the name the account is held in.
    expect(issuer.getAllByText("Example Agency Ltd")).toHaveLength(2);
    expect(issuer.getByText("00.000.000.0-000.000")).toBeInTheDocument();
    expect(issuer.getByText("•••• 7890")).toBeInTheDocument();
    expect(issuer.queryByText("1234567890")).toBeNull();
    expect(issuer.getByRole("button", { name: "Show account number" })).toBeInTheDocument();
  });

  it("🔴 shows subtotal, the tax with its code, and the total, from the API's figures", async () => {
    await mount(ISSUED);
    const lines = within(card("Line items"));
    expect(lines.getByText("Subtotal")).toBeInTheDocument();
    expect(lines.getByText("Tax (PPN)")).toBeInTheDocument();
    // Formatted, never recomputed (the staff locale is en-GB, so USD reads "US$1,000.00"). `.lux-dlist__value` keeps the match to
    // the totals block and off the line-item table above it.
    expect(lines.getByText(/1,000\.00/, { selector: ".lux-dlist__value" })).toBeInTheDocument();
    expect(lines.getByText(/110\.00/, { selector: ".lux-dlist__value" })).toBeInTheDocument();
    expect(lines.getByText(/1,110\.00/, { selector: "strong" })).toBeInTheDocument();
  });

  it("🔴 the ledger link is for the finance read tier only", async () => {
    const first = await mount(ISSUED);
    expect(screen.getByRole("link", { name: "View in Receivables" })).toHaveAttribute("href", "/finance/receivables");
    first.unmount();
    await mount(ISSUED, MEMBER);
    expect(screen.queryByRole("link", { name: "View in Receivables" })).toBeNull();
  });

  it("offers Void behind the confirm step, for an issued invoice that is still Issued", async () => {
    await mount(ISSUED);
    expect(screen.getByRole("button", { name: /Void this invoice/ })).toBeInTheDocument();
  });

  it("a void or paid invoice keeps the record and offers no Void", async () => {
    for (const status of ["void", "paid"] as const) {
      const r = await mount({ ...ISSUED, status });
      expect(within(card("Invoice of record")).getByText("EX/2026/0001")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Void this invoice/ })).toBeNull();
      r.unmount();
    }
  });

  it("the client-sees-this marker is the backend's flag, and a payload without it says nothing", async () => {
    const first = await mount({ ...ISSUED, clientVisible: true });
    expect(screen.getByText(/Client sees this/)).toBeInTheDocument();
    first.unmount();
    const older: Invoice = { ...ISSUED };
    delete older.clientVisible;
    await mount(older);
    expect(screen.queryByText(/Client sees this/)).toBeNull();
    expect(screen.queryByText(/Internal/)).toBeNull();
  });

  it("🔴 a legacy sent invoice (no number) has no record card, no PDF line and no Void, and says why", async () => {
    await mount({ ...ISSUED, invoiceNo: null, issueDate: null, dueDate: null, subtotal: null, taxTotal: null, issuer: null, pdfFileId: null, legacyUnissued: true });
    expect(screen.queryByRole("heading", { name: /^Invoice of record/ })).toBeNull();
    expect(screen.queryByText(/Being prepared/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Void this invoice/ })).toBeNull();
    expect(screen.getByText(/marked sent before invoices were issued through the ledger/)).toBeInTheDocument();
  });
});

describe("staff invoice page · what is missing before Issue", () => {
  const APPROVED: Invoice = { ...ISSUED, status: "approved", invoiceNo: null, issueDate: null, dueDate: null, subtotal: null, taxTotal: null, issuer: null, pdfFileId: null, issuedAt: null };
  const BLOCKERS = [
    { code: "NO_BANK_DETAILS", message: "the billing profile has no bank account" },
    { code: "NO_OPEN_PERIOD", message: "no open accounting period covers today" },
  ];

  it("🔴 lists every blocker on the page BEFORE any click, each with its fix link, and disables Issue", async () => {
    readinessMock.mockResolvedValue({ invoiceId: "inv-1", status: "approved", issued: false, invoiceNo: null, ready: false, blockers: BLOCKERS });
    await mount(APPROVED);
    expect(screen.getByText(/can't be issued yet\. Clear these first/)).toBeInTheDocument();
    expect(screen.getByText(/the billing profile has no bank account/)).toBeInTheDocument();
    expect(screen.getByText(/no open accounting period covers today/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the billing profile" })).toHaveAttribute("href", "/finance/settings/billing-profile");
    expect(screen.getByRole("button", { name: "Issue" })).toBeDisabled();
    expect(screen.queryByRole("heading", { name: /^Invoice of record/ })).toBeNull();
  });

  it("with nothing missing there is no blocker list and Issue is enabled", async () => {
    readinessMock.mockResolvedValue({ invoiceId: "inv-1", status: "approved", issued: false, invoiceNo: null, ready: true, blockers: [] });
    await mount(APPROVED);
    expect(screen.queryByText(/Clear these first/)).toBeNull();
    expect(screen.getByRole("button", { name: "Issue" })).toBeEnabled();
  });

  it("🔴 when the readiness read gives no answer (null) nothing is claimed: no list, Issue stays enabled for the server to decide", async () => {
    readinessMock.mockResolvedValue(null);
    await mount(APPROVED);
    expect(screen.queryByText(/Clear these first/)).toBeNull();
    expect(screen.getByRole("button", { name: "Issue" })).toBeEnabled();
  });

  it("only an approved invoice asks the readiness question", async () => {
    await mount({ ...APPROVED, status: "draft" });
    expect(readinessMock).not.toHaveBeenCalled();
  });
});

describe("staff invoice page · the service line (PV-D35)", () => {
  const APPROVED: Invoice = { ...ISSUED, status: "approved", invoiceNo: null, issueDate: null, dueDate: null, subtotal: null, taxTotal: null, issuer: null, pdfFileId: null, issuedAt: null };
  const NO_LINE = { code: "NO_SERVICE_LINE", message: "the invoice has no service line (staff pick one before issuing)" };

  it("🔴 an approved invoice with no line shows the blocker AND the picker it links to (#service-line), and Issue is disabled", async () => {
    linesMock.mockResolvedValue(LINES);
    readinessMock.mockResolvedValue({ invoiceId: "inv-1", status: "approved", issued: false, invoiceNo: null, ready: false, blockers: [NO_LINE] });
    await mount({ ...APPROVED, serviceLineKey: null, defaultServiceLineKey: null });
    expect(screen.getByRole("link", { name: "Choose a service line" })).toHaveAttribute("href", "#service-line");
    const picker = within(card("Service line"));
    const select = picker.getByRole("combobox", { name: "Service line" });
    expect(select).toHaveValue("");
    // Active lines are offered; a switched-off line that is not the chosen one is not.
    expect(within(select).getByRole("option", { name: "Web development" })).toBeInTheDocument();
    expect(within(select).queryByRole("option", { name: /Retired line/ })).toBeNull();
    expect(picker.getByText(/no default applies/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Issue" })).toBeDisabled();
  });

  it("names the default line when every project maps to one, and shows the chosen line selected", async () => {
    linesMock.mockResolvedValue(LINES);
    readinessMock.mockResolvedValue({ invoiceId: "inv-1", status: "approved", issued: false, invoiceNo: null, ready: true, blockers: [] });
    const first = await mount({ ...APPROVED, serviceLineKey: null, defaultServiceLineKey: "web" });
    expect(within(card("Service line")).getByRole("option", { name: "Default: Web development" })).toBeInTheDocument();
    expect(within(card("Service line")).getByText(/issued under Web development/)).toBeInTheDocument();
    first.unmount();
    await mount({ ...APPROVED, serviceLineKey: "seo", serviceLineName: "Search", defaultServiceLineKey: "web" });
    expect(within(card("Service line")).getByRole("combobox", { name: "Service line" })).toHaveValue("seo");
  });

  it("a company with no lines is told where to add them", async () => {
    linesMock.mockResolvedValue([]);
    readinessMock.mockResolvedValue({ invoiceId: "inv-1", status: "approved", issued: false, invoiceNo: null, ready: false, blockers: [NO_LINE] });
    await mount({ ...APPROVED, serviceLineKey: null });
    expect(screen.getByRole("link", { name: "Add service lines" })).toHaveAttribute("href", "/finance/settings/billing-profile#service-lines");
  });

  it("🔴 an ISSUED invoice shows the line and decodes the number's code for staff, and offers no picker", async () => {
    linesMock.mockResolvedValue(LINES);
    await mount({
      ...ISSUED, invoiceNo: "EX/2026/10/7K3/0001", serviceLineKey: "web", serviceLineName: "Web development",
      numberCode: "7K3", numberDecode: { serviceLineKey: "web", serviceLineName: "Web development", businessType: "hotel" },
    });
    const record = within(card("Invoice of record"));
    expect(record.getByText("EX/2026/10/7K3/0001")).toBeInTheDocument();
    expect(record.getByText("7K3")).toBeInTheDocument();
    expect(record.getByText(/Web development · hotel/)).toBeInTheDocument();
    expect(within(card("Summary")).getByText("Web development")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^Service line/ })).toBeNull();
    expect(linesMock).not.toHaveBeenCalled();
  });

  it("an older server (no numbering fields) shows no code row and no picker, and claims nothing", async () => {
    await mount(ISSUED);
    expect(within(card("Invoice of record")).queryByText("Number code")).toBeNull();
    expect(screen.queryByRole("heading", { name: /^Service line/ })).toBeNull();
  });

  it("a viewer who cannot read the lines (null) gets no picker for an approved invoice", async () => {
    readinessMock.mockResolvedValue({ invoiceId: "inv-1", status: "approved", issued: false, invoiceNo: null, ready: true, blockers: [] });
    await mount(APPROVED);
    expect(screen.queryByRole("heading", { name: /^Service line/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Issue" })).toBeEnabled();
  });
});
