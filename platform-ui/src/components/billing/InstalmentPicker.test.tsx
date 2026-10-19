import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import type { BillableInstalment } from "@/lib/contractBilling";

// DW-10f-3b (BFF §61.5, §61.9) — the checklist behind "Create from the schedule". Pinned: every due row is ticked when it opens, an upcoming row
// shows its date and cannot be ticked, an invoicing row links its draft, the total is exact, a mix of currencies is flagged before the click,
// and the form posts the ticked ids, the client, Due up to and the tax code. A 409 lists the rows it names, with the reason, in words.
const create = vi.fn();
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/invoiceActions", () => ({ createInvoiceFromScheduleAction: (...a: unknown[]) => create(...a) }));

import { InstalmentPicker } from "./InstalmentPicker";

const item = (over: Partial<BillableInstalment> = {}): BillableInstalment => ({
  instalmentId: "i1", client: { id: "cl-4", name: "Viceroy" }, contract: { id: "k1", title: "Website build agreement (signed)", reference: "GDA-2026-041", kind: "agreement", projectId: null },
  position: 2, count: 3, label: "Milestone: design approved", amount: 30_000_000, currency: "IDR", due: { kind: "date", on: "2026-10-09" }, state: "due", invoice: null,
  ...over,
});
const ITEMS: BillableInstalment[] = [
  item({ instalmentId: "a" }),
  item({ instalmentId: "b", position: 1, count: 1, label: "Amendment fee", amount: 15_000_000, contract: { id: "k2", title: "Amendment 1", reference: "GDA-2026-041-A1", kind: "amendment", projectId: null }, due: { kind: "on_signing", on: "2026-10-14" } }),
  item({ instalmentId: "c", position: 3, label: "Milestone: launch", due: { kind: "date", on: "2026-12-01" }, state: "upcoming" }),
  item({ instalmentId: "d", position: 1, label: "Deposit", state: "invoicing", invoice: { id: "inv-d", status: "draft" }, due: { kind: "on_signing", on: "2026-09-01" } }),
];
const picker = (items = ITEMS) => render(<InstalmentPicker clientId="cl-4" dueBy="2026-10-19" items={items} />);
const box = (name: RegExp) => screen.getByRole("checkbox", { name }) as HTMLInputElement;

beforeEach(() => create.mockReset());
afterEach(cleanup);

describe("InstalmentPicker · what is ticked and what cannot be", () => {
  it("🔴 ticks every due row when it opens, and only those", () => {
    picker();
    expect(box(/^Invoice Milestone: design approved \(2 of 3\)/).checked).toBe(true);
    expect(box(/^Invoice Amendment fee \(1 of 1\)/).checked).toBe(true);
  });

  it("🔴 an upcoming row shows its date and cannot be ticked; an invoicing row links its draft and cannot be ticked", () => {
    picker();
    const upcoming = screen.getByRole("checkbox", { name: /Milestone: launch \(3 of 3\).*not due yet/ });
    expect(upcoming).toBeDisabled();
    expect(screen.getByText(/^Upcoming, /)).toBeInTheDocument();
    const onDraft = screen.getByRole("checkbox", { name: /Deposit \(1 of 3\).*already on a draft invoice/ });
    expect(onDraft).toBeDisabled();
    expect(screen.getByRole("link", { name: "On a draft invoice" })).toHaveAttribute("href", "/invoices/inv-d");
  });

  it("links each instalment's agreement to its row on the client's page, and names an amendment", () => {
    picker();
    expect(screen.getAllByRole("link", { name: /GDA-2026-041-A1/ })[0]).toHaveAttribute("href", "/clients/cl-4/billing#contract-k2");
    expect(screen.getByText(/· Amendment/)).toBeInTheDocument();
  });

  it("totals the ticked rows exactly and moves with the ticks", () => {
    picker();
    expect(screen.getByText("2 instalments ticked, IDR 45,000,000.")).toBeInTheDocument();
    fireEvent.click(box(/^Invoice Amendment fee/));
    expect(screen.getByText("1 instalment ticked, IDR 30,000,000.")).toBeInTheDocument();
  });

  it("🔴 disables Create with the reason when nothing is ticked", () => {
    picker();
    fireEvent.click(box(/^Invoice Milestone: design approved/));
    fireEvent.click(box(/^Invoice Amendment fee/));
    const btn = screen.getByRole("button", { name: "Create from the schedule" });
    expect(btn).toBeDisabled();
    expect(screen.getByText("Tick at least one instalment that is due.")).toBeInTheDocument();
  });

  it("🔴 flags a mix of currencies before the click and disables Create", () => {
    picker([item({ instalmentId: "a" }), item({ instalmentId: "b", currency: "USD", amount: 100, label: "Fee" })]);
    expect(screen.getByRole("button", { name: "Create from the schedule" })).toBeDisabled();
    expect(screen.getByText(/more than one currency/)).toBeInTheDocument();
  });

  it("with only upcoming rows there is nothing to tick and no tax field to fill", () => {
    picker([item({ instalmentId: "c", state: "upcoming" })]);
    expect(screen.getByRole("button", { name: "Create from the schedule" })).toBeDisabled();
    expect(screen.queryByLabelText(/Tax code/)).toBeNull();
  });
});

describe("InstalmentPicker · Create from the schedule", () => {
  it("🔴 posts the client, Due up to, the tax code and exactly the ticked ids", async () => {
    create.mockResolvedValue({});
    picker();
    fireEvent.change(screen.getByLabelText(/Tax code/), { target: { value: "PPN" } });
    fireEvent.click(box(/^Invoice Amendment fee/)); // unticked: not sent
    fireEvent.submit(screen.getByRole("form", { name: "Create an invoice from the payment schedule" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const fd = create.mock.calls[0][1] as FormData;
    expect(fd.get("clientId")).toBe("cl-4");
    expect(fd.get("dueBy")).toBe("2026-10-19");
    expect(fd.get("taxCode")).toBe("PPN");
    expect(fd.getAll("instalmentId")).toEqual(["a"]);
  });

  it("🔴 a 409 says which rows can no longer be billed, and why, in words (with the claiming invoice)", async () => {
    create.mockResolvedValue({
      error: "Some of the instalments you ticked can no longer be billed. Nothing was created. Reload the list and tick again.",
      items: [{ instalmentId: "a", reason: "already_invoiced", invoiceId: "inv-9" }, { instalmentId: "b", reason: "not_due" }],
    });
    picker();
    fireEvent.submit(screen.getByRole("form", { name: "Create an invoice from the payment schedule" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/can no longer be billed\. Nothing was created/);
    const list = within(alert).getByRole("list");
    expect(within(list).getByText(/Milestone: design approved \(2 of 3\), Website build agreement \(signed\) · GDA-2026-041 is already on another invoice\./)).toBeInTheDocument();
    expect(within(list).getByText(/Amendment fee \(1 of 1\).*is not due yet for the date you chose\./)).toBeInTheDocument();
    expect(within(alert).getByRole("link", { name: "Open that invoice" })).toHaveAttribute("href", "/invoices/inv-9");
  });

  it("shows any other refusal as the sentence the action returned", async () => {
    create.mockResolvedValue({ error: "The instalments you ticked are in more than one currency. Make one invoice per currency." });
    picker();
    fireEvent.submit(screen.getByRole("form", { name: "Create an invoice from the payment schedule" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/one invoice per currency/);
  });
});
