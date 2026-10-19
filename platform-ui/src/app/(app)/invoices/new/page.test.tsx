import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { Me } from "@/lib/platform";
import type { BillableAnswer } from "@/lib/contractBilling";
import type { ReadResult } from "@/lib/readResult";

// DW-10f-3b (BFF §61.5, §61.9, DW-D48) — /invoices/new, rendered as the server renders it. Pinned: the gate is `company.manage` as before; the
// page opens on the payment schedule (client and "Due up to", the checklist), the hourly form is the explicit exception behind a disclosure and
// is today's form unchanged; a failed read is said, never an empty list; an empty list says what it means; and the read is asked for the chosen
// client and date only.
vi.mock("next/navigation", () => ({ redirect: vi.fn(() => { throw new Error("redirect"); }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-fin") }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-1") }));
vi.mock("@/lib/platform", async () => {
  const actual = await vi.importActual<typeof import("@/lib/platform")>("@/lib/platform");
  return { ...actual, getMe: vi.fn() };
});
vi.mock("@/lib/entities", () => ({ listClients: vi.fn(async () => [{ id: "cl-3", name: "Lumen Studio" }, { id: "cl-4", name: "Viceroy" }]) }));
vi.mock("@/lib/contractBilling-data", () => ({ listBillableInstalmentsResult: vi.fn() }));
vi.mock("@/lib/invoiceActions", () => ({ createInvoiceAction: vi.fn(), createInvoiceFromScheduleAction: vi.fn() }));
vi.mock("@/lib/format", async () => {
  const actual = await vi.importActual<typeof import("@/lib/format")>("@/lib/format");
  return { ...actual, todayIsoInDisplayZone: () => "2026-10-19" };
});

import { getMe } from "@/lib/platform";
import { listBillableInstalmentsResult } from "@/lib/contractBilling-data";
import NewInvoicePage from "./page";

const meMock = vi.mocked(getMe);
const readMock = vi.mocked(listBillableInstalmentsResult);
const ADMIN: Me = { userId: "u-fin", name: "Fin", email: "f@example.test", title: null, assurance: "high", companies: [{ id: "co-1", name: "Example", type: null }], roles: [{ role: "platform_admin", scopeType: "global", scopeId: null }] };
const MEMBER: Me = { ...ADMIN, roles: [{ role: "member", scopeType: "company", scopeId: "co-1" }] };

const row = (over: Record<string, unknown> = {}) => ({
  instalmentId: "i1", client: { id: "cl-4", name: "Viceroy" }, contract: { id: "k1", title: "Website build", reference: "GDA-1", kind: "agreement", projectId: null },
  position: 1, count: 2, label: "Deposit", amount: 45_000_000, currency: "IDR", due: { kind: "on_signing", on: "2026-10-01" }, state: "due", invoice: null, ...over,
});
const ok = (items: unknown[], dueBy = "2026-10-19"): ReadResult<BillableAnswer> => ({ kind: "ok", data: { dueBy, items: items as never } });

const mount = async (sp: { clientId?: string; dueBy?: string } = {}, me: Me = ADMIN) => {
  meMock.mockResolvedValue(me);
  return render(await NewInvoicePage({ searchParams: Promise.resolve(sp) }));
};

beforeEach(() => { meMock.mockReset(); readMock.mockReset(); });

describe("/invoices/new · the gate", () => {
  it("🔴 stays company.manage: anyone else is told invoicing is limited, and nothing is read", async () => {
    await mount({ clientId: "cl-4" }, MEMBER);
    expect(screen.getByText("Invoicing is limited to finance administrators.")).toBeInTheDocument();
    expect(readMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("form", { name: "Choose what to bill" })).toBeNull();
  });
});

describe("/invoices/new · from the payment schedule", () => {
  it("opens on the schedule: a client picker, 'Due up to' defaulting to today, and a prompt before a client is chosen", async () => {
    await mount();
    const form = screen.getByRole("form", { name: "Choose what to bill" });
    expect(within(form).getByLabelText("Client")).toBeInTheDocument();
    expect(within(form).getByLabelText("Due up to")).toHaveValue("2026-10-19");
    expect(screen.getByText("Choose a client to see what is due to invoice.")).toBeInTheDocument();
    expect(readMock).not.toHaveBeenCalled();
  });

  it("the choice is a plain GET form (client and date in the URL)", async () => {
    await mount();
    const form = screen.getByRole("form", { name: "Choose what to bill" });
    expect(form).toHaveAttribute("method", "get");
    expect(form).toHaveAttribute("action", "/invoices/new");
    expect(within(form).getByLabelText("Client")).toHaveAttribute("name", "clientId");
    expect(within(form).getByLabelText("Due up to")).toHaveAttribute("name", "dueBy");
  });

  it("🔴 reads the billable list for the chosen client and date only, and draws the checklist", async () => {
    readMock.mockResolvedValue(ok([row(), row({ instalmentId: "i2", state: "upcoming", label: "Balance", position: 2, due: { kind: "date", on: "2026-12-01" } })], "2026-11-30"));
    await mount({ clientId: "cl-4", dueBy: "2026-11-30" });
    expect(readMock).toHaveBeenCalledWith("u-fin", "co-1", { clientId: "cl-4", dueBy: "2026-11-30" });
    expect(screen.getByRole("form", { name: "Create an invoice from the payment schedule" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /^Invoice Deposit \(1 of 2\)/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Balance \(2 of 2\).*not due yet/ })).toBeDisabled();
  });

  it("an unknown client id asks for no read at all", async () => {
    await mount({ clientId: "cl-999" });
    expect(readMock).not.toHaveBeenCalled();
    expect(screen.getByText("Choose a client to see what is due to invoice.")).toBeInTheDocument();
  });

  it("a malformed 'Due up to' falls back to today and says so", async () => {
    readMock.mockResolvedValue(ok([]));
    await mount({ clientId: "cl-4", dueBy: "2026-02-30" });
    expect(readMock).toHaveBeenCalledWith("u-fin", "co-1", { clientId: "cl-4", dueBy: "2026-10-19" });
    expect(screen.getByRole("alert")).toHaveTextContent(/not a date, so today is used/);
  });

  it("🔴 an empty list says 'Nothing is due for this client up to <date>' and draws no checklist", async () => {
    readMock.mockResolvedValue(ok([], "2026-10-19"));
    await mount({ clientId: "cl-4" });
    expect(screen.getByText("Nothing is due for this client up to 19 Oct 2026.")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Create an invoice from the payment schedule" })).toBeNull();
  });

  it("with only upcoming rows it still says nothing is due, and still shows them with their dates", async () => {
    readMock.mockResolvedValue(ok([row({ state: "upcoming", due: { kind: "date", on: "2026-12-01" } })]));
    await mount({ clientId: "cl-4" });
    expect(screen.getByText(/Nothing is due for this client up to/)).toBeInTheDocument();
    expect(screen.getByText(/^Upcoming, /)).toBeInTheDocument();
  });

  it("🔴 a failed read says so and is never an empty list; a refused read says that", async () => {
    readMock.mockResolvedValue({ kind: "unavailable", reason: "platform 502" });
    const first = await mount({ clientId: "cl-4" });
    expect(screen.getByText(/billable instalments/i)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing is due/)).toBeNull();
    expect(screen.queryByRole("form", { name: "Create an invoice from the payment schedule" })).toBeNull();
    first.unmount();
    readMock.mockResolvedValue({ kind: "forbidden" });
    await mount({ clientId: "cl-4" });
    expect(screen.queryByText(/Nothing is due/)).toBeNull();
    expect(screen.getByText(/access/i)).toBeInTheDocument();
  });
});

describe("/invoices/new · the hourly form is the exception, unchanged (DW-D48)", () => {
  it("🔴 sits behind 'From logged hours (exception)', closed, with today's fields, and says an invoice is never both", async () => {
    const { container } = await mount();
    const details = container.querySelector("details.bs-exception") as HTMLDetailsElement;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(within(details).getByText("From logged hours (exception)")).toBeInTheDocument();
    expect(within(details).getByText(/never both/)).toBeInTheDocument();
    for (const f of ["Period start", "Period end", "Hourly rate", "Currency"]) expect(within(details).getByLabelText(f)).toBeInTheDocument();
    expect(within(details).getByRole("button", { name: "Generate invoice" })).toBeInTheDocument();
  });
});
