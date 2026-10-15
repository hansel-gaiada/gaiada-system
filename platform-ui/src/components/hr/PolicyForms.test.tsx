import { render, screen, waitFor, fireEvent, cleanup, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import {
  CalendarForm, HolidayForm, DeleteHolidayButton, LeavePolicyForm, LeavePolicyEditForm, AssignmentForm, PayGradeForm, ParameterSetForm,
  RatifyButton,
} from "./PolicyForms";
import type { PolicyFormApi } from "./PolicyFormShell";
import type { PolicyResult } from "@/lib/hrPolicyActions";

// DW-7f-5 — the HR settings forms: each sends what was typed to its action with the tenant, shows the server's sentence as sent
// after a refusal (keeping the form open), shows the server's notice after a success, and re-reads the page after every call.
// The two destructive or signing actions, deleting a holiday and ratifying a parameter set, ask first and say what they do.

const pick = (result: PolicyResult) => vi.fn<PolicyFormApi>(async () => result);
type IdAction = (t: string, id: string, fd: FormData) => Promise<PolicyResult>;
const pickId = (result: PolicyResult) => vi.fn<IdAction>(async () => result);
const open = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const submit = (name: string) => fireEvent.click(screen.getAllByRole("button", { name }).at(-1)!);
const entries = (fd: FormData) => Object.fromEntries(fd.entries());

beforeEach(() => refresh.mockReset());
afterEach(() => cleanup());

describe("CalendarForm", () => {
  it("defaults the weekend to Saturday and Sunday and sends the ticked days, the country and the default flag", async () => {
    const action = pick({ ok: true, notice: "Calendar created." });
    render(<CalendarForm tenantId="co-a" action={action} />);
    open("Add calendar");
    expect(screen.getByLabelText("Sat")).toBeChecked();
    expect(screen.getByLabelText("Sun")).toBeChecked();
    expect(screen.getByLabelText("Mon")).not.toBeChecked();
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Indonesia" } });
    fireEvent.click(screen.getByLabelText("Fri"));
    fireEvent.click(screen.getByLabelText(/Make this the default calendar/));
    submit("Create calendar");
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0][0]).toBe("co-a");
    const fd = action.mock.calls[0][1];
    expect(fd.getAll("weekendDays")).toEqual(["5", "6", "7"]);
    expect(entries(fd)).toMatchObject({ name: "Indonesia", countryCode: "ID", isDefault: "on" });
    expect(await screen.findByRole("status")).toHaveTextContent("Calendar created.");
    expect(refresh).toHaveBeenCalled();
  });

  it("shows the server's refusal as sent and keeps the form open", async () => {
    render(<CalendarForm tenantId="co-a" action={pick({ ok: false, error: "name required" })} />);
    open("Add calendar");
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Indonesia" } });
    submit("Create calendar");
    expect(await screen.findByRole("alert")).toHaveTextContent("name required");
    expect(screen.getByLabelText(/^Name/)).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });
});

describe("HolidayForm", () => {
  it("binds the calendar id, warns that a holiday on the same date is replaced, and sends the holiday", async () => {
    const action = pickId({ ok: true, notice: "Holiday saved." });
    render(<HolidayForm tenantId="co-a" calendarId="cal-1" action={action} />);
    open("Add a holiday");
    expect(screen.getByText(/REPLACES it/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Date/), { target: { value: "2026-08-17" } });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Independence Day" } });
    fireEvent.change(screen.getByLabelText(/^Kind/), { target: { value: "joint_leave" } });
    submit("Save holiday");
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0].slice(0, 2)).toEqual(["co-a", "cal-1"]);
    expect(entries(action.mock.calls[0][2])).toMatchObject({ day: "2026-08-17", name: "Independence Day", kind: "joint_leave", deductsEntitlement: "on" });
    expect(await screen.findByRole("status")).toHaveTextContent("Holiday saved.");
  });
});

describe("DeleteHolidayButton", () => {
  const label = "Independence Day on 2026-08-17";

  it("asks first, says what deleting does, and calls nothing until confirmed", async () => {
    const action = vi.fn(async (): Promise<PolicyResult> => ({ ok: true, notice: "Holiday deleted." }));
    render(<DeleteHolidayButton tenantId="co-a" holidayId="h-1" holidayLabel={label} action={action} />);
    fireEvent.click(screen.getByRole("button", { name: `Delete ${label}` }));
    expect(action).not.toHaveBeenCalled();
    const panel = screen.getByRole("group", { name: `Confirm deleting ${label}` });
    expect(within(panel).getByText(/removed for good/)).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "Yes, delete" }));
    await waitFor(() => expect(action).toHaveBeenCalledWith("co-a", "h-1"));
    expect(await screen.findByRole("status")).toHaveTextContent("Holiday deleted.");
    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("Cancel closes the confirmation without calling the server", () => {
    const action = vi.fn(async (): Promise<PolicyResult> => ({ ok: true }));
    render(<DeleteHolidayButton tenantId="co-a" holidayId="h-1" holidayLabel={label} action={action} />);
    fireEvent.click(screen.getByRole("button", { name: `Delete ${label}` }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(action).not.toHaveBeenCalled();
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("shows a refusal as sent, keeps the confirmation open and still re-reads", async () => {
    const action = vi.fn(async (): Promise<PolicyResult> => ({ ok: false, error: "holiday not found" }));
    render(<DeleteHolidayButton tenantId="co-a" holidayId="h-1" holidayLabel={label} action={action} />);
    fireEvent.click(screen.getByRole("button", { name: `Delete ${label}` }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, delete" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("holiday not found");
    expect(screen.getByRole("group")).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });
});

describe("LeavePolicyForm", () => {
  it("takes entitlements in days (decimals allowed) and sends the typed values and ticks", async () => {
    const action = pick({ ok: true, notice: "Leave policy created." });
    render(<LeavePolicyForm tenantId="co-a" action={action} />);
    open("Add leave policy");
    expect(screen.getByLabelText(/^Annual entitlement/)).toHaveAttribute("step", "any");
    fireEvent.change(screen.getByLabelText(/^Leave type/), { target: { value: "vacation" } });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Annual leave" } });
    fireEvent.change(screen.getByLabelText(/^Accrual/), { target: { value: "monthly" } });
    fireEvent.change(screen.getByLabelText(/^Annual entitlement/), { target: { value: "12.5" } });
    fireEvent.change(screen.getByLabelText(/^Waiting period/), { target: { value: "12" } });
    submit("Create policy");
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(entries(action.mock.calls[0][1])).toMatchObject({
      leaveType: "vacation", name: "Annual leave", accrualMethod: "monthly", annualEntitlementDays: "12.5", waitingPeriodMonths: "12",
      prorateFirstYear: "on", excludesHolidays: "on",
    });
    expect(entries(action.mock.calls[0][1])).not.toHaveProperty("allowNegativeBalance");
    expect(await screen.findByRole("status")).toHaveTextContent("Leave policy created.");
  });

  it("shows a refusal as sent", async () => {
    render(<LeavePolicyForm tenantId="co-a" action={pick({ ok: false, error: "name and leaveType (vacation|sick|unpaid|other) required" })} />);
    open("Add leave policy");
    fireEvent.change(screen.getByLabelText(/^Leave type/), { target: { value: "vacation" } });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Annual leave" } });
    submit("Create policy");
    expect(await screen.findByRole("alert")).toHaveTextContent("name and leaveType");
  });
});

describe("LeavePolicyEditForm", () => {
  const initial = {
    name: "Annual leave", leaveType: "vacation", accrualMethod: "upfront", annualEntitlementMinutes: 5760, waitingPeriodMonths: 12,
    prorateFirstYear: true, carryoverMaxMinutes: 2400, carryoverExpiryMonths: 3, allowNegativeBalance: false, excludesHolidays: true,
    escalateOverMinutes: 2640, minNoticeDays: 7, isActive: true,
  };

  it("is filled from the server's minutes shown as days, says the leave type is fixed, and sends every field with the policy id", async () => {
    const action = pickId({ ok: true, notice: "Leave policy saved." });
    render(<LeavePolicyEditForm tenantId="co-a" policyId="lp-1" initial={initial} action={action} />);
    open("Edit this policy");
    expect(screen.getByText(/leave type \(vacation\) cannot be changed/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Annual entitlement/)).toHaveValue(12);
    expect(screen.getByLabelText(/^Carry-over limit/)).toHaveValue(5);
    expect(screen.getByLabelText(/^Second approver over/)).toHaveValue(5.5);
    fireEvent.change(screen.getByLabelText(/^Annual entitlement/), { target: { value: "14" } });
    fireEvent.click(screen.getByLabelText(/^Active/));
    submit("Save policy");
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0].slice(0, 2)).toEqual(["co-a", "lp-1"]);
    const sent = entries(action.mock.calls[0][2]);
    expect(sent).toMatchObject({
      name: "Annual leave", accrualMethod: "upfront", annualEntitlementDays: "14", waitingPeriodMonths: "12", carryoverMaxDays: "5",
      carryoverExpiryMonths: "3", minNoticeDays: "7", escalateOverDays: "5.5", prorateFirstYear: "on", excludesHolidays: "on",
    });
    expect(sent).not.toHaveProperty("isActive");
    expect(await screen.findByRole("status")).toHaveTextContent("Leave policy saved.");
  });

  it("shows a refusal as sent", async () => {
    render(<LeavePolicyEditForm tenantId="co-a" policyId="lp-1" initial={initial} action={pickId({ ok: false, error: "leave policy not found" })} />);
    open("Edit this policy");
    submit("Save policy");
    expect(await screen.findByRole("alert")).toHaveTextContent("leave policy not found");
    expect(refresh).toHaveBeenCalled();
  });
});

describe("AssignmentForm", () => {
  const people = [{ value: "u-a", label: "Budi" }];

  it("sends the target, the person or unit, and the dates with the policy id", async () => {
    const action = pickId({ ok: true, notice: "Assignment saved." });
    render(<AssignmentForm tenantId="co-a" policyId="lp-1" people={people} action={action} />);
    open("Assign this policy");
    expect(screen.getByLabelText(/^Applies to/)).toHaveValue("tenant");
    fireEvent.change(screen.getByLabelText(/^Applies to/), { target: { value: "person" } });
    fireEvent.change(screen.getByLabelText(/^Person/), { target: { value: "u-a" } });
    fireEvent.change(screen.getByLabelText(/^From/), { target: { value: "2026-01-01" } });
    submit("Assign");
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0].slice(0, 2)).toEqual(["co-a", "lp-1"]);
    expect(entries(action.mock.calls[0][2])).toMatchObject({ target: "person", subjectUserId: "u-a", unitNodeId: "", effectiveFrom: "2026-01-01", effectiveTo: "" });
    expect(await screen.findByRole("status")).toHaveTextContent("Assignment saved.");
  });

  it("shows the server's refusal as sent", async () => {
    render(<AssignmentForm tenantId="co-a" policyId="lp-1" people={people}
      action={pickId({ ok: false, error: "supply at most one of subjectUserId or unitNodeId (omit both for the tenant default)" })} />);
    open("Assign this policy");
    fireEvent.change(screen.getByLabelText(/^From/), { target: { value: "2026-01-01" } });
    submit("Assign");
    expect(await screen.findByRole("alert")).toHaveTextContent("supply at most one of subjectUserId or unitNodeId");
  });
});

describe("PayGradeForm", () => {
  it("takes decimal band amounts (step any) and sends the typed grade", async () => {
    const action = pick({ ok: true, notice: "Pay grade created." });
    render(<PayGradeForm tenantId="co-a" action={action} defaultCurrency="IDR" />);
    open("Add pay grade");
    for (const label of [/^Band minimum/, /^Band midpoint/, /^Band maximum/]) expect(screen.getByLabelText(label)).toHaveAttribute("step", "any");
    fireEvent.change(screen.getByLabelText(/^Code/), { target: { value: "E3" } });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Engineer 3" } });
    fireEvent.change(screen.getByLabelText(/^Band minimum/), { target: { value: "8000000.50" } });
    fireEvent.change(screen.getByLabelText(/^Band maximum/), { target: { value: "12000000" } });
    submit("Create grade");
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(entries(action.mock.calls[0][1])).toMatchObject({
      code: "E3", name: "Engineer 3", track: "individual", level: "1", minAmount: "8000000.50", maxAmount: "12000000", currency: "IDR", rateBasis: "monthly",
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Pay grade created.");
  });

  it("shows a refusal as sent", async () => {
    render(<PayGradeForm tenantId="co-a" defaultCurrency="IDR" action={pick({ ok: false, error: "maxAmount must be >= minAmount" })} />);
    open("Add pay grade");
    fireEvent.change(screen.getByLabelText(/^Code/), { target: { value: "E3" } });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Engineer 3" } });
    fireEvent.change(screen.getByLabelText(/^Band minimum/), { target: { value: "9" } });
    fireEvent.change(screen.getByLabelText(/^Band maximum/), { target: { value: "1" } });
    submit("Create grade");
    expect(await screen.findByRole("alert")).toHaveTextContent("maxAmount must be >= minAmount");
  });
});

describe("ParameterSetForm", () => {
  it("says a new set is unratified, starts with three parameter rows and adds more on request", () => {
    render(<ParameterSetForm tenantId="co-a" action={pick({ ok: true })} />);
    open("Add parameter set");
    expect(screen.getByText(/UNRATIFIED/)).toBeInTheDocument();
    expect(screen.getAllByLabelText(/^Key \d/)).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Add a parameter row" }));
    expect(screen.getAllByLabelText(/^Key \d/)).toHaveLength(4);
  });

  it("sends the set and its parameter rows as parallel lists, the blank rows included", async () => {
    const action = pick({ ok: true, notice: "Parameter set created with 2 parameters, UNRATIFIED." });
    render(<ParameterSetForm tenantId="co-a" action={action} />);
    open("Add parameter set");
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Indonesia 2026" } });
    fireEvent.change(screen.getByLabelText(/^Effective from/), { target: { value: "2026-01-01" } });
    fireEvent.change(screen.getByLabelText(/^Key 1/), { target: { value: "bpjs.kes.rate" } });
    fireEvent.change(screen.getByLabelText(/^Number 1/), { target: { value: "0.04" } });
    fireEvent.change(screen.getByLabelText(/^Unit 1/), { target: { value: "rate" } });
    fireEvent.change(screen.getByLabelText(/^Key 2/), { target: { value: "tax.brackets" } });
    fireEvent.change(screen.getByLabelText(/^JSON value 2/), { target: { value: "[{\"upTo\":60000000,\"rate\":0.05}]" } });
    submit("Create parameter set");
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const fd = action.mock.calls[0][1];
    expect(fd.get("name")).toBe("Indonesia 2026");
    expect(fd.getAll("paramKey")).toEqual(["bpjs.kes.rate", "tax.brackets", ""]);
    expect(fd.getAll("paramValueNum")).toEqual(["0.04", "", ""]);
    expect(fd.getAll("paramValueJson")).toEqual(["", "[{\"upTo\":60000000,\"rate\":0.05}]", ""]);
    expect(fd.getAll("paramUnit")).toEqual(["rate", "", ""]);
    expect(await screen.findByRole("status")).toHaveTextContent("UNRATIFIED");
  });

  it("shows the server's overlap refusal as sent", async () => {
    const overlap = "conflicting key value violates exclusion constraint \"ex_hr_param_sets_no_overlap\"";
    render(<ParameterSetForm tenantId="co-a" action={pick({ ok: false, error: overlap })} />);
    open("Add parameter set");
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Indonesia 2026" } });
    fireEvent.change(screen.getByLabelText(/^Effective from/), { target: { value: "2026-01-01" } });
    submit("Create parameter set");
    expect(await screen.findByRole("alert")).toHaveTextContent(overlap);
    expect(refresh).toHaveBeenCalled();
  });
});

describe("RatifyButton", () => {
  type RatifyAction = (t: string, id: string, note?: string) => Promise<PolicyResult>;
  const ratified = "Parameter set ratified on 2026-10-15. Payroll will use these parameters without an override from now on.";

  it("asks first, says what ratifying does, and calls nothing until confirmed", async () => {
    const action = vi.fn<RatifyAction>(async () => ({ ok: true, notice: ratified }));
    render(<RatifyButton tenantId="co-a" setId="s-1" setName="Indonesia 2026" action={action} />);
    fireEvent.click(screen.getByRole("button", { name: "Ratify this set" }));
    expect(action).not.toHaveBeenCalled();
    const panel = screen.getByRole("group", { name: "Ratify Indonesia 2026" });
    expect(within(panel).getByText(/Payroll will use these parameters without an override from now on/)).toBeInTheDocument();
    expect(within(panel).getByText(/high assurance/)).toBeInTheDocument();
    fireEvent.change(within(panel).getByRole("textbox"), { target: { value: "PMK 168/2023 verified" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Confirm ratification" }));
    await waitFor(() => expect(action).toHaveBeenCalledWith("co-a", "s-1", "PMK 168/2023 verified"));
    expect(await screen.findByRole("status")).toHaveTextContent(ratified);
    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("Cancel closes the confirmation without calling the server", () => {
    const action = vi.fn<RatifyAction>(async () => ({ ok: true }));
    render(<RatifyButton tenantId="co-a" setId="s-1" setName="Indonesia 2026" action={action} />);
    fireEvent.click(screen.getByRole("button", { name: "Ratify this set" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(action).not.toHaveBeenCalled();
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("shows the server's refusal as sent and still re-reads", async () => {
    const denied = "You don't have permission to ratify statutory parameters. Ratifying is for company administrators and also needs a high-assurance sign-in.";
    const action = vi.fn<RatifyAction>(async () => ({ ok: false, error: denied }));
    render(<RatifyButton tenantId="co-a" setId="s-1" setName="Indonesia 2026" action={action} />);
    fireEvent.click(screen.getByRole("button", { name: "Ratify this set" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm ratification" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(denied);
    expect(action).toHaveBeenCalledWith("co-a", "s-1", "");
    expect(refresh).toHaveBeenCalled();
  });
});
