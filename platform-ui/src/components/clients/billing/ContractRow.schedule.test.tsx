import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import type { Contract, ContractSchedule } from "@/lib/contracts";

// DW-10f-2b (BFF §61.9) — what a contract ROW does about its payment schedule, from the backend's own fields: Send is disabled with the
// sentence until the schedule adds up, a draft's Edit panel carries the editor, a sent or signed contract shows its schedule read-only with each
// instalment's state and its invoice link, and "Add a payment schedule" (DW-D49) is offered only on a signed contract the backend says is
// addable, and only to a person with `company.manage`. The server actions are mocked.
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/lib/contractsActions", () => ({
  markCertifiedAction: vi.fn(), sendContractAction: vi.fn(), voidContractAction: vi.fn(), countersignContractAction: vi.fn(),
  decidePaymentAction: vi.fn(), createContractAction: vi.fn(), updateContractAction: vi.fn(),
  saveScheduleAction: vi.fn(), addScheduleAfterSigningAction: vi.fn(),
}));

import { ContractRow } from "./ContractRow";
import { ScheduleView } from "./ScheduleView";

const k = (over: Partial<Contract> = {}): Contract => ({
  id: "k1", clientId: "cl-4", clientName: "Viceroy", projectId: null, projectName: null, title: "Website build agreement",
  reference: "GDA-2026-040", version: 1, supersedesId: null, status: "draft", fileId: null, bodyMd: "terms", value: 120_000_000,
  currency: "IDR", startsOn: null, endsOn: null, sentAt: null, signedAt: null, declineReason: null, createdBy: null,
  createdAt: "2026-10-01T00:00:00Z", clientSigned: false, providerSigned: false, termEnded: false, canCountersign: false,
  ...over,
});
const SCHEDULE: ContractSchedule = {
  currency: "IDR", value: 90_000_000, total: 90_000_000, matchesValue: true, scheduleSha256: "ab".repeat(32), addedAfterSigning: null,
  instalments: [
    { id: "i1", position: 1, label: "Deposit", amount: 30_000_000, due: { kind: "on_signing", on: "2026-09-01" }, state: "invoiced", invoice: { id: "inv-sch-1", invoiceNo: "DEMO/2026/0002", status: "sent" } },
    { id: "i2", position: 2, label: "Milestone: design approved", amount: 30_000_000, due: { kind: "date", on: "2026-10-09" }, state: "due", invoice: null },
    { id: "i3", position: 3, label: "Milestone: launch", amount: 30_000_000, due: { kind: "date", on: "2026-12-01" }, state: "upcoming", invoice: null },
  ],
};
const row = (c: Contract, extra: Partial<React.ComponentProps<typeof ContractRow>> = {}) =>
  render(<ul><ContractRow contract={c} clientId="cl-4" projects={[]} {...extra} /></ul>);

beforeEach(() => { vi.spyOn(window, "confirm").mockReturnValue(true); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("ContractRow · Send waits for the schedule", () => {
  it("🔴 a draft with a value and no schedule has a DISABLED Send with the sentence next to it", () => {
    row(k({ scheduleSummary: null }));
    const send = screen.getByRole("button", { name: "Send to client" });
    expect(send).toBeDisabled();
    expect(screen.getByText("The payment schedule must add up to the value before sending.")).toBeInTheDocument();
    expect(send).toHaveAttribute("aria-describedby", expect.stringContaining("send-reason-k1"));
  });

  it("a draft whose schedule does not add up is disabled too; one that does can be sent", () => {
    const { unmount } = row(k({ scheduleSummary: { count: 2, total: 100, matchesValue: false } }));
    expect(screen.getByRole("button", { name: "Send to client" })).toBeDisabled();
    unmount();
    row(k({ scheduleSummary: { count: 2, total: 120_000_000, matchesValue: true } }));
    expect(screen.getByRole("button", { name: "Send to client" })).toBeEnabled();
    expect(screen.queryByText(/payment schedule must add up/)).toBeNull();
  });

  it("a draft with no value carries no schedule, and says so", () => {
    row(k({ value: null, scheduleSummary: null }));
    expect(screen.getByRole("button", { name: "Send to client" })).toBeEnabled();
    expect(screen.getByText(/A contract with no value carries no schedule/)).toBeInTheDocument();
  });

  it("the send form carries the contract's currency so a refusal can name the figures", () => {
    const { container } = row(k({ scheduleSummary: { count: 1, total: 120_000_000, matchesValue: true } }));
    expect(container.querySelector('input[name="currency"]')).toHaveValue("IDR");
  });
});

describe("ContractRow · the editor, on a draft's Edit panel", () => {
  it("opens the payment-schedule editor under the form, with the saved rows", () => {
    row(k({ scheduleSummary: { count: 2, total: 120_000_000, matchesValue: true } }), {
      schedule: { ...SCHEDULE, value: 120_000_000, total: 120_000_000, instalments: SCHEDULE.instalments.slice(0, 2).map((i) => ({ ...i, amount: 60_000_000, state: "scheduled", invoice: null })) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editor = screen.getByRole("region", { name: "Payment schedule" });
    expect(within(editor).getByLabelText("Label, instalment 1")).toHaveValue("Deposit");
    expect(within(editor).getByRole("button", { name: "Save schedule" })).toBeInTheDocument();
    // while editing, the read-only table is not drawn a second time
    expect(screen.queryByRole("table", { name: "Payment schedule instalments" })).toBeNull();
  });

  it("🔴 when the schedule could not be read, the row says so and offers NO editor (saving replaces the whole list)", () => {
    row(k({ scheduleSummary: { count: 2, total: 120_000_000, matchesValue: true } }), { scheduleRefused: "platform 500" });
    expect(screen.getByText(/payment schedule cannot be read right now \(platform 500\)\. That is not a statement that there is none\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.queryByRole("region", { name: "Payment schedule" })).toBeNull();
  });

  it("a draft with no schedule yet invites one", () => {
    row(k({ scheduleSummary: null }), { schedule: null });
    expect(screen.getByText(/None yet\. Press Edit to add one/)).toBeInTheDocument();
  });
});

describe("ContractRow · a sent or signed contract's schedule is read-only", () => {
  it("shows each instalment with its state in §61.3's words, and links the invoice that claims it", () => {
    row(k({ status: "signed", signedAt: "2026-09-01T00:00:00Z", scheduleSummary: { count: 3, total: 90_000_000, matchesValue: true }, value: 90_000_000 }), { schedule: SCHEDULE });
    const table = screen.getByRole("table", { name: "Payment schedule instalments" });
    expect(within(table).getByText("Deposit")).toBeInTheDocument();
    expect(within(table).getByRole("link", { name: "Invoiced, DEMO/2026/0002" })).toHaveAttribute("href", "/invoices/inv-sch-1");
    expect(within(table).getByText("Due: ready to invoice")).toBeInTheDocument();
    expect(within(table).getByText(/^Upcoming, /)).toBeInTheDocument();
    expect(within(table).getAllByText("IDR 30,000,000")).toHaveLength(3);
    expect(within(table).getByText("IDR 90,000,000")).toBeInTheDocument(); // the total
    // no editor, no Save, no Add on a signed contract that has a schedule
    expect(screen.queryByRole("button", { name: /Save schedule|Add a payment schedule/ })).toBeNull();
  });

  it("an instalment on a draft invoice links its draft", () => {
    const s: ContractSchedule = { ...SCHEDULE, instalments: [{ ...SCHEDULE.instalments[1], state: "invoicing", invoice: { id: "inv-d", invoiceNo: null, status: "draft" } }] };
    row(k({ status: "signed", scheduleSummary: { count: 1, total: 30_000_000, matchesValue: true } }), { schedule: s });
    expect(screen.getByRole("link", { name: "On a draft invoice" })).toHaveAttribute("href", "/invoices/inv-d");
  });

  it("🔴 says who added a schedule after signing and when, and that the agreement was signed without it", () => {
    row(k({ status: "signed" }), {
      schedule: { ...SCHEDULE, addedAfterSigning: { at: "2026-10-18T03:00:00Z", by: { id: "u", name: "Olive Owner" } } },
    });
    expect(screen.getByText(/Added after signing by Olive Owner, 18 Oct 2026\./)).toBeInTheDocument();
    expect(screen.getByText(/The agreement was signed without this schedule/)).toBeInTheDocument();
  });

  it("a not-billed instalment says why", () => {
    const s: ContractSchedule = { ...SCHEDULE, instalments: [{ ...SCHEDULE.instalments[1], state: "not_billed", notBilledReason: "void", invoice: null }] };
    render(<ScheduleView schedule={s} />);
    expect(screen.getByText("Not billed (the agreement was voided)")).toBeInTheDocument();
  });

  it("flags a schedule that does not add up instead of presenting it as fine", () => {
    render(<ScheduleView schedule={{ ...SCHEDULE, total: 80_000_000, matchesValue: false }} />);
    expect(screen.getByText(/does not add up to the contract's value \(IDR 80,000,000 of IDR 90,000,000\)/)).toBeInTheDocument();
  });

  it("an amendment says so", () => {
    row(k({ kind: "amendment", status: "signed" }), { schedule: SCHEDULE });
    expect(screen.getByText(/^Amendment · /)).toBeInTheDocument();
  });
});

describe("ContractRow · Add a payment schedule (DW-D49)", () => {
  const signed = (over: Partial<Contract> = {}) => k({ status: "signed", signedAt: "2026-10-01T00:00:00Z", scheduleAddable: true, scheduleSummary: null, value: 24_000_000, ...over });

  it("🔴 is offered on a signed contract the backend marks scheduleAddable, to a person with company.manage", () => {
    row(signed(), { canBill: true });
    expect(screen.getByRole("button", { name: "Add a payment schedule" })).toBeInTheDocument();
  });

  it("🔴 is NOT offered without company.manage, nor when the backend does not say addable, nor on a contract that has a schedule", () => {
    const { unmount } = row(signed(), { canBill: false });
    expect(screen.queryByRole("button", { name: "Add a payment schedule" })).toBeNull();
    unmount();
    const second = row(signed({ scheduleAddable: false }), { canBill: true });
    expect(screen.queryByRole("button", { name: "Add a payment schedule" })).toBeNull();
    second.unmount();
    row(signed({ scheduleAddable: false, scheduleSummary: { count: 2, total: 24_000_000, matchesValue: true } }), { canBill: true, schedule: { ...SCHEDULE, currency: "IDR" } });
    expect(screen.queryByRole("button", { name: "Add a payment schedule" })).toBeNull();
  });

  it("opens the editor in its after-signing form, with the warning, and Cancel closes it", () => {
    row(signed(), { canBill: true });
    fireEvent.click(screen.getByRole("button", { name: "Add a payment schedule" }));
    const editor = screen.getByRole("region", { name: "Add a payment schedule" });
    expect(within(editor).getAllByText(/It can be added once and never changed/).length).toBeGreaterThan(0);
    expect(within(editor).getByRole("button", { name: "Review the schedule" })).toBeInTheDocument();
    fireEvent.click(within(editor).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("region", { name: "Add a payment schedule" })).toBeNull();
  });
});
