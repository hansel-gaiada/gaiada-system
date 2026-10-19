import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import type { Contract, ContractSchedule } from "@/lib/contracts";

// DW-10f-2b (BFF §61.4, §61.4a, §61.9) — the payment-schedule editor. Pinned: the presets fill the rows from the SAVED value (remainder on the
// first row, month ends clamped), the live line reads "adds up / short / over" from exact sums, Save posts the rows as typed, and an addition to a
// signed contract goes through a CONFIRM step that says what it is before the one-time POST. The server actions are mocked: what is pinned is what
// the component sends and shows for each answer.
const save = vi.fn();
const add = vi.fn();
vi.mock("@/lib/contractsActions", () => ({
  saveScheduleAction: (...a: unknown[]) => save(...a),
  addScheduleAfterSigningAction: (...a: unknown[]) => add(...a),
}));

import { ScheduleEditor } from "./ScheduleEditor";

const contract = (over: Partial<Contract> = {}): Pick<Contract, "id" | "title" | "value" | "currency" | "startsOn" | "endsOn"> => ({
  id: "k1", title: "Retainer 2027", value: 10_000_000, currency: "IDR", startsOn: "2026-01-31", endsOn: "2026-12-31", ...over,
});
const SAVED: ContractSchedule = {
  currency: "IDR", value: 10_000_000, total: 10_000_000, matchesValue: true, scheduleSha256: null, addedAfterSigning: null,
  instalments: [
    { id: "i1", position: 1, label: "Deposit", amount: 4_000_000, due: { kind: "on_signing", on: null }, state: "scheduled", invoice: null },
    { id: "i2", position: 2, label: "Balance", amount: 6_000_000, due: { kind: "date", on: "2026-06-30" }, state: "scheduled", invoice: null },
  ],
};

const draft = (c = contract(), schedule: ContractSchedule | null = null) =>
  render(<ScheduleEditor clientId="cl-4" contract={c} schedule={schedule} mode="draft" />);
const after = (c = contract(), onDone?: () => void) => render(<ScheduleEditor clientId="cl-4" contract={c} mode="after-signing" onDone={onDone} />);
const amount = (n: number) => screen.getByLabelText(`Amount, instalment ${n}`) as HTMLInputElement;
const label = (n: number) => screen.getByLabelText(`Label, instalment ${n}`) as HTMLInputElement;
const dueSel = (n: number) => screen.getByLabelText(`Due, instalment ${n}`) as HTMLSelectElement;
const dueDate = (n: number) => screen.getByLabelText(`Due date, instalment ${n}`) as HTMLInputElement;

beforeEach(() => { save.mockReset(); add.mockReset(); });
afterEach(cleanup);

describe("ScheduleEditor · presets", () => {
  it("All on signing: one row with the whole saved value, due on signing", () => {
    draft();
    fireEvent.click(screen.getByRole("button", { name: "All on signing" }));
    expect(label(1).value).toBe("Payment on signing");
    expect(amount(1).value).toBe("10000000");
    expect(dueSel(1).value).toBe("on_signing");
    expect(screen.getByText("Adds up to IDR 10,000,000 of 10,000,000.")).toBeInTheDocument();
  });

  it("50/50: the deposit on signing, the balance on the date the person picked (default the term's end)", () => {
    draft();
    fireEvent.click(screen.getByRole("button", { name: "50/50" }));
    expect(label(1).value).toBe("Deposit (50%)");
    expect(label(2).value).toBe("Balance (50%)");
    expect(amount(1).value).toBe("5000000");
    expect(amount(2).value).toBe("5000000");
    expect(dueDate(2).value).toBe("2026-12-31");
    fireEvent.change(screen.getByLabelText("Balance due on"), { target: { value: "2026-09-30" } });
    fireEvent.click(screen.getByRole("button", { name: "50/50" }));
    expect(dueDate(2).value).toBe("2026-09-30");
  });

  it("🔴 Monthly x N: the remainder lands on Month 1 and the dates are month ends (31 Jan, 28 Feb, 31 Mar)", () => {
    draft();
    fireEvent.change(screen.getByLabelText("Months (N)"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("First due on"), { target: { value: "2026-01-31" } });
    fireEvent.click(screen.getByRole("button", { name: "Monthly × N" }));
    expect([1, 2, 3].map((n) => amount(n).value)).toEqual(["3333334", "3333333", "3333333"]);
    expect([1, 2, 3].map((n) => label(n).value)).toEqual(["Month 1", "Month 2", "Month 3"]);
    expect([1, 2, 3].map((n) => dueDate(n).value)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
    expect(screen.getByText("Adds up to IDR 10,000,000 of 10,000,000.")).toBeInTheDocument();
  });

  it("after a preset the rows are ordinary rows: editing one reads 'short' with the exact figure", () => {
    draft();
    fireEvent.click(screen.getByRole("button", { name: "All on signing" }));
    fireEvent.change(amount(1), { target: { value: "9995000" } });
    expect(screen.getByText(/IDR 5,000 short/)).toBeInTheDocument();
    fireEvent.change(amount(1), { target: { value: "10005000" } });
    expect(screen.getByText(/IDR 5,000 over/)).toBeInTheDocument();
  });

  it("🔴 the presets are disabled without a saved value, and the editor says to set one first", () => {
    draft(contract({ value: null }));
    for (const name of ["All on signing", "50/50", "Monthly × N"]) expect(screen.getByRole("button", { name })).toBeDisabled();
    expect(screen.getByText(/has no value yet, so it carries no payment schedule/)).toBeInTheDocument();
  });

  it("Monthly is disabled for an N outside 1 to 60", () => {
    draft();
    fireEvent.change(screen.getByLabelText("Months (N)"), { target: { value: "61" } });
    expect(screen.getByRole("button", { name: "Monthly × N" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Months (N)"), { target: { value: "12" } });
    expect(screen.getByRole("button", { name: "Monthly × N" })).toBeEnabled();
  });
});

describe("ScheduleEditor · custom rows", () => {
  it("starts from the saved schedule, and shows the date field only for a dated row", () => {
    draft(contract(), SAVED);
    expect(label(1).value).toBe("Deposit");
    expect(amount(2).value).toBe("6000000");
    expect(dueSel(1).value).toBe("on_signing");
    expect(screen.queryByLabelText("Due date, instalment 1")).toBeNull();
    expect(dueDate(2).value).toBe("2026-06-30");
    expect(screen.getByText("Adds up to IDR 10,000,000 of 10,000,000.")).toBeInTheDocument();
  });

  it("adds, moves and removes rows", () => {
    draft(contract(), SAVED);
    fireEvent.click(screen.getByRole("button", { name: "Add an instalment" }));
    expect(label(3).value).toBe("");
    fireEvent.change(label(3), { target: { value: "Extra" } });
    fireEvent.click(screen.getByRole("button", { name: "Move instalment 3 up" }));
    expect(label(2).value).toBe("Extra");
    expect(label(3).value).toBe("Balance");
    expect(screen.getByRole("button", { name: "Move instalment 1 up" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move instalment 3 down" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Remove instalment 2" }));
    expect(label(2).value).toBe("Balance");
  });

  it("switching a row to 'On a date' asks for the date, and 'On signing' drops it", () => {
    draft(contract(), SAVED);
    fireEvent.change(dueSel(1), { target: { value: "date" } });
    expect(dueDate(1).value).toBe("");
    fireEvent.change(dueSel(2), { target: { value: "on_signing" } });
    expect(screen.queryByLabelText("Due date, instalment 2")).toBeNull();
  });
});

describe("ScheduleEditor · Save (a draft)", () => {
  it("🔴 posts the rows as typed (strings, with the contract's id and currency) to saveScheduleAction", async () => {
    save.mockResolvedValue({ ok: true, notice: "Schedule saved. It adds up to the value, so the contract can be sent." });
    draft(contract(), SAVED);
    fireEvent.change(label(1), { target: { value: " Deposit (40%) " } });
    fireEvent.submit(screen.getByRole("form", { name: "Save the payment schedule" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const fd = save.mock.calls[0][1] as FormData;
    expect(fd.get("clientId")).toBe("cl-4");
    expect(fd.get("contractId")).toBe("k1");
    expect(fd.get("currency")).toBe("IDR");
    expect(JSON.parse(String(fd.get("instalments")))).toEqual([
      { label: " Deposit (40%) ", amount: "4000000", due: "on_signing" },
      { label: "Balance", amount: "6000000", due: "2026-06-30" },
    ]);
    expect(await screen.findByText(/so the contract can be sent/)).toBeInTheDocument();
  });

  it("shows a refusal in words, and puts a stale answer away once the rows change again", async () => {
    save.mockResolvedValue({ ok: false, error: "This contract has been sent, so its payment schedule is fixed and can no longer be changed." });
    draft(contract(), SAVED);
    fireEvent.submit(screen.getByRole("form", { name: "Save the payment schedule" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/fixed and can no longer be changed/);
    fireEvent.change(amount(1), { target: { value: "1" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("ScheduleEditor · adding a schedule to a signed contract (DW-D49)", () => {
  const ROW_WORDS = /This agreement is already signed\. The schedule must restate the payment terms the agreement states\. It can be added once and never changed\./;

  it("says what the addition is up front, and cannot be reviewed with no rows", () => {
    after();
    expect(screen.getAllByText(ROW_WORDS).length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Add a payment schedule" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review the schedule" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Add the payment schedule/ })).toBeNull(); // no submit before the confirm step
  });

  it("🔴 will not reach the confirm step until the rows add up to the value, and says by how much", () => {
    after();
    fireEvent.click(screen.getByRole("button", { name: "All on signing" }));
    fireEvent.change(amount(1), { target: { value: "9995000" } });
    fireEvent.click(screen.getByRole("button", { name: "Review the schedule" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/must add up exactly to the contract's value\. IDR 5,000 short/);
    expect(screen.queryByRole("form", { name: "Confirm adding the payment schedule" })).toBeNull();
  });

  it("checks the rows first (a blank label is named)", () => {
    after();
    fireEvent.click(screen.getByRole("button", { name: "All on signing" }));
    fireEvent.change(label(1), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Review the schedule" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Give instalment 1 a label.");
  });

  it("🔴 the confirm step shows every row and the warning, and only then can the one-time POST be made", async () => {
    add.mockResolvedValue({ ok: true, notice: "Payment schedule added." });
    after();
    fireEvent.click(screen.getByRole("button", { name: "50/50" }));
    fireEvent.click(screen.getByRole("button", { name: "Review the schedule" }));
    const confirm = screen.getByRole("form", { name: "Confirm adding the payment schedule" });
    expect(within(confirm).getAllByText(ROW_WORDS).length).toBe(1);
    const table = within(confirm).getByRole("table", { name: "The schedule to be added" });
    expect(within(table).getByText("Deposit (50%)")).toBeInTheDocument();
    expect(within(table).getByText("Balance (50%)")).toBeInTheDocument();
    expect(within(table).getByText("On signing")).toBeInTheDocument();
    expect(within(table).getByText("Due 31 Dec 2026")).toBeInTheDocument();
    expect(within(table).getAllByText("IDR 5,000,000")).toHaveLength(2);
    expect(within(table).getByText("IDR 10,000,000")).toBeInTheDocument(); // the total
    expect(add).not.toHaveBeenCalled();
    fireEvent.submit(confirm);
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    const fd = add.mock.calls[0][1] as FormData;
    expect(fd.get("contractId")).toBe("k1");
    expect(JSON.parse(String(fd.get("instalments")))).toEqual([
      { label: "Deposit (50%)", amount: "5000000", due: "on_signing" },
      { label: "Balance (50%)", amount: "5000000", due: "2026-12-31" },
    ]);
    expect(save).not.toHaveBeenCalled();
  });

  it("goes back to the rows from the confirm step, and shows a refusal of the addition in words", async () => {
    add.mockResolvedValue({ ok: false, error: "This agreement already has a payment schedule. One can be added only once and is never changed." });
    after();
    fireEvent.click(screen.getByRole("button", { name: "All on signing" }));
    fireEvent.click(screen.getByRole("button", { name: "Review the schedule" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to the rows" }));
    expect(screen.getByLabelText("Amount, instalment 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review the schedule" }));
    fireEvent.submit(screen.getByRole("form", { name: "Confirm adding the payment schedule" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already has a payment schedule/);
  });

  it("Cancel closes it", () => {
    const onDone = vi.fn();
    after(contract(), onDone);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onDone).toHaveBeenCalled();
  });
});
