import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, within, cleanup } from "@testing-library/react";
import type { PortalSchedule as Schedule } from "@/lib/portal";
import { portalAddedAfterSigning, portalInstalmentDue, portalInstalmentState } from "@/lib/portal";

// DW-10f-2b (BFF §61.3's portal column, §61.6, §61.9) — the CLIENT's payment schedule. Pinned: each state in the client's words, the invoice
// number linking the portal's own invoice page, nothing for a contract with no schedule, the "added after signing" line with the company and the
// date (never who), and that an unissued invoice, an instalment id or a claim time never reach the page.
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));

import { PortalSchedule } from "./PortalSchedule";

const SCHEDULE: Schedule = {
  currency: "IDR", total: 240_000_000, scheduleSha256: "ab".repeat(32), addedAfterSigning: null,
  instalments: [
    { position: 1, label: "Deposit", amount: 80_000_000, due: { kind: "on_signing", on: "2026-07-21" }, state: "invoiced", invoice: { id: "inv-2026-014", invoiceNo: "DEMO/2026/0014" } },
    { position: 2, label: "Milestone: design approved", amount: 80_000_000, due: { kind: "date", on: "2026-10-14" }, state: "due", invoice: null },
    { position: 3, label: "Milestone: launch", amount: 80_000_000, due: { kind: "date", on: "2026-12-18" }, state: "upcoming", invoice: null },
  ],
};

afterEach(cleanup);

describe("PortalSchedule", () => {
  it("🔴 renders a table of label, due, amount and status, in the client's words, with a total", () => {
    render(<PortalSchedule schedule={SCHEDULE} />);
    expect(screen.getByRole("heading", { name: /^Payment schedule/ })).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Payment schedule instalments" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(1 + 3 + 1); // header, three instalments, total
    expect(within(rows[1]).getByText("Deposit")).toBeInTheDocument();
    expect(within(rows[1]).getByText("On signing (21 Jul 2026)")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Due 14 Oct 2026")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Due")).toBeInTheDocument();
    // an upcoming instalment says its date in the Due column and, in the client's words, again as its status
    expect(within(rows[3]).getAllByText("Due 18 Dec 2026")).toHaveLength(2);
    expect(within(table).getAllByText(/IDR\s?80,000,000/)).toHaveLength(3);
    expect(within(rows[4]).getByText(/IDR\s?240,000,000/)).toBeInTheDocument();
  });

  it("🔴 an issued invoice's number links the portal's own invoice page, and nothing else is a link", () => {
    render(<PortalSchedule schedule={SCHEDULE} />);
    const link = screen.getByRole("link", { name: "Invoiced, DEMO/2026/0014" });
    expect(link).toHaveAttribute("href", "/portal/invoices/inv-2026-014");
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("renders nothing for a contract with no schedule: null, absent and empty read alike", () => {
    for (const schedule of [null, undefined, { ...SCHEDULE, instalments: [] }]) {
      const { container, unmount } = render(<PortalSchedule schedule={schedule} />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it("🔴 a schedule added after signing says by which company and on what date, after the agreement was signed, and never who", () => {
    render(<PortalSchedule schedule={{ ...SCHEDULE, addedAfterSigning: { on: "2026-10-18" } }} company="Gaia Digital Agency" />);
    expect(screen.getByText("Added by Gaia Digital Agency on 18 Oct 2026, after the agreement was signed.")).toBeInTheDocument();
  });

  it("with no company name the line says 'us' rather than guess one; a normal schedule has no such line", () => {
    const { unmount } = render(<PortalSchedule schedule={{ ...SCHEDULE, addedAfterSigning: { on: "2026-10-18" } }} />);
    expect(screen.getByText("Added by us on 18 Oct 2026, after the agreement was signed.")).toBeInTheDocument();
    unmount();
    render(<PortalSchedule schedule={SCHEDULE} company="Gaia Digital Agency" />);
    expect(screen.queryByText(/after the agreement was signed/)).toBeNull();
  });

  it("never prints an instalment id, a hash or an internal invoice status", () => {
    const { container } = render(<PortalSchedule schedule={SCHEDULE} />);
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/instalmentId|abababab|\bdraft\b/);
  });
});

describe("the client's words for each state (§61.3, portal column)", () => {
  const due = { kind: "date" as const, on: "2026-12-18" };
  it("words every state", () => {
    expect(portalInstalmentState({ state: "scheduled", due: { kind: "on_signing", on: null }, invoice: null })).toBe("On signing");
    expect(portalInstalmentState({ state: "scheduled", due, invoice: null })).toBe("Due 18 Dec 2026");
    expect(portalInstalmentState({ state: "upcoming", due, invoice: null })).toBe("Due 18 Dec 2026");
    expect(portalInstalmentState({ state: "due", due, invoice: null })).toBe("Due");
    expect(portalInstalmentState({ state: "invoiced", due, invoice: { id: "i", invoiceNo: "INV/9" } })).toBe("Invoiced, INV/9");
    expect(portalInstalmentState({ state: "invoiced", due, invoice: null })).toBe("Invoiced");
    expect(portalInstalmentState({ state: "paid", due, invoice: null })).toBe("Paid");
    expect(portalInstalmentState({ state: "not_billed", due, invoice: null })).toBe("Not billed");
    expect(portalInstalmentState({ state: "something new", due, invoice: null })).toBe("something new");
  });

  it("words the due column and the added-after-signing line", () => {
    expect(portalInstalmentDue({ kind: "on_signing", on: null })).toBe("On signing");
    expect(portalInstalmentDue({ kind: "date", on: null })).toBe("Due date to be confirmed");
    expect(portalAddedAfterSigning({ on: "2026-10-18" }, "  Gaia  ")).toBe("Added by Gaia on 18 Oct 2026, after the agreement was signed");
  });
});
