import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

import {
  SetCompensationForm, AllowanceTypeForm, AssignAllowanceForm, BenefitPlanForm, EnrolBenefitForm, TaxProfileForm,
  type FormApi,
} from "./CompensationForms";
import type { CompensationResult } from "@/lib/hrCompensationActions";

// DW-7f-3 — the compensation forms: each sends what was typed to its action with the tenant, shows the server's
// sentence as sent after a refusal (and keeps the form open), shows the server's notice after a success, and re-reads
// the page after every call.

const employees = [{ value: "e1", label: "Budi" }, { value: "e2", label: "Sari" }];

function pick(result: CompensationResult) {
  return vi.fn<FormApi>(async () => result);
}
const open = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const submit = (name: string) => fireEvent.click(screen.getAllByRole("button", { name }).at(-1)!);

beforeEach(() => refresh.mockReset());
afterEach(() => cleanup());

describe("SetCompensationForm", () => {
  function setup(result: CompensationResult, grades: { value: string; label: string }[] | null = [{ value: "g1", label: "G1 · Staff" }]) {
    const action = pick(result);
    render(<SetCompensationForm tenantId="co-a" action={action} employees={employees} grades={grades} defaultCurrency="IDR" />);
    open("Set compensation");
    return action;
  }
  function fill() {
    fireEvent.change(screen.getByLabelText("Employee"), { target: { value: "e2" } });
    fireEvent.change(screen.getByLabelText(/^Base amount/), { target: { value: "12500000.5" } });
    fireEvent.change(screen.getByLabelText(/^Rate basis/), { target: { value: "annual" } });
    fireEvent.change(screen.getByLabelText(/^Effective from/), { target: { value: "2026-11-01" } });
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: "promotion" } });
  }

  it("sends the typed values, a decimal amount included, shows the server's notice and re-reads", async () => {
    const action = setup({ ok: true, notice: "Compensation recorded for Sari from 2026-11-01." });
    fill();
    submit("Record compensation");
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const [tenant, fd] = action.mock.calls[0];
    expect(tenant).toBe("co-a");
    expect(Object.fromEntries(fd.entries())).toMatchObject({
      employeeId: "e2", baseAmount: "12500000.5", currency: "IDR", rateBasis: "annual", payFrequency: "monthly",
      effectiveFrom: "2026-11-01", changeReason: "promotion",
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Compensation recorded for Sari from 2026-11-01.");
    expect(refresh).toHaveBeenCalled();
  });

  it("takes a decimal money amount (step any)", () => {
    setup({ ok: true });
    expect(screen.getByLabelText(/^Base amount/)).toHaveAttribute("step", "any");
  });

  it("shows the server's refusal as sent, keeps the form open and still re-reads", async () => {
    setup({ ok: false, error: "15000000 is outside grade G3's band (8000000–12000000)" });
    fill();
    submit("Record compensation");
    expect(await screen.findByRole("alert")).toHaveTextContent("15000000 is outside grade G3's band (8000000–12000000)");
    expect(screen.getByLabelText(/^Base amount/)).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it("offers a grade field only when the grades were read, and says why not otherwise", () => {
    setup({ ok: true });
    expect(screen.getByLabelText(/^Pay grade/)).toBeInTheDocument();
    cleanup();
    const action = pick({ ok: true });
    render(<SetCompensationForm tenantId="co-a" action={action} employees={employees} grades={null} gradesNote="You can't read pay grades, so no grade can be chosen here." defaultCurrency="IDR" />);
    open("Set compensation");
    expect(screen.queryByLabelText(/^Pay grade/)).toBeNull();
    expect(screen.getByText("You can't read pay grades, so no grade can be chosen here.")).toBeInTheDocument();
  });
});

describe("AllowanceTypeForm", () => {
  it("warns that an existing code is overwritten and sends the code, label and ticks", async () => {
    const action = pick({ ok: true, notice: "Allowance type TRANSPORT saved." });
    render(<AllowanceTypeForm tenantId="co-a" action={action} />);
    open("Add allowance type");
    expect(screen.getByText(/REPLACES that type's settings/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Code/), { target: { value: "TRANSPORT" } });
    fireEvent.change(screen.getByLabelText(/^Label/), { target: { value: "Transport" } });
    fireEvent.change(screen.getByLabelText(/^Default amount/), { target: { value: "500000.5" } });
    submit("Save allowance type");
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(Object.fromEntries(action.mock.calls[0][1].entries())).toMatchObject({
      code: "TRANSPORT", label: "Transport", direction: "allowance", calcKind: "fixed", defaultAmount: "500000.5", taxable: "on", prorated: "on",
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Allowance type TRANSPORT saved.");
    expect(refresh).toHaveBeenCalled();
  });

  it("shows a refusal as sent", async () => {
    render(<AllowanceTypeForm tenantId="co-a" action={pick({ ok: false, error: "You don't have permission to save allowance types." })} />);
    open("Add allowance type");
    fireEvent.change(screen.getByLabelText(/^Code/), { target: { value: "X" } });
    fireEvent.change(screen.getByLabelText(/^Label/), { target: { value: "X" } });
    submit("Save allowance type");
    expect(await screen.findByRole("alert")).toHaveTextContent("You don't have permission to save allowance types.");
  });
});

describe("AssignAllowanceForm", () => {
  it("sends the employee, type and dates, and shows the server's 409 as sent", async () => {
    const overlap = "this employee already holds that allowance over an overlapping period — close the existing one first";
    const action = pick({ ok: false, error: overlap });
    render(<AssignAllowanceForm tenantId="co-a" action={action} employees={employees} types={[{ value: "t1", label: "TRANSPORT · Transport" }]} />);
    open("Assign an allowance");
    fireEvent.change(screen.getByLabelText("Employee"), { target: { value: "e1" } });
    fireEvent.change(screen.getByLabelText(/^Allowance type/), { target: { value: "t1" } });
    fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: "250000.75" } });
    fireEvent.change(screen.getByLabelText(/^From/), { target: { value: "2026-11-01" } });
    submit("Assign allowance");
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(Object.fromEntries(action.mock.calls[0][1].entries())).toMatchObject({
      employeeId: "e1", allowanceTypeId: "t1", amount: "250000.75", effectiveFrom: "2026-11-01",
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(overlap);
    expect(refresh).toHaveBeenCalled();
  });
});

describe("BenefitPlanForm", () => {
  it("sends the plan and the rates as percent, and shows the notice", async () => {
    const action = pick({ ok: true, notice: "Benefit plan BPJS-KES saved." });
    render(<BenefitPlanForm tenantId="co-a" action={action} defaultCurrency="IDR" />);
    open("Add benefit plan");
    expect(screen.getByText(/REPLACES that plan's settings/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Code/), { target: { value: "BPJS-KES" } });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "BPJS Kesehatan" } });
    fireEvent.change(screen.getByLabelText(/^Statutory code/), { target: { value: "bpjs_kesehatan" } });
    fireEvent.change(screen.getByLabelText(/^Employer rate/), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText(/^Wage cap/), { target: { value: "12000000" } });
    submit("Save benefit plan");
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(Object.fromEntries(action.mock.calls[0][1].entries())).toMatchObject({
      code: "BPJS-KES", name: "BPJS Kesehatan", kind: "statutory", statutoryCode: "bpjs_kesehatan", employerRate: "4", wageCap: "12000000", currency: "IDR",
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Benefit plan BPJS-KES saved.");
  });
});

describe("EnrolBenefitForm", () => {
  it("sends the enrolment and shows a refusal as sent", async () => {
    const action = pick({ ok: false, error: "this employee is already enrolled in that plan over an overlapping period" });
    render(<EnrolBenefitForm tenantId="co-a" action={action} employees={employees} plans={[{ value: "p1", label: "BPJS-KES · BPJS Kesehatan" }]} />);
    open("Enrol in a benefit plan");
    fireEvent.change(screen.getByLabelText("Employee"), { target: { value: "e2" } });
    fireEvent.change(screen.getByLabelText(/^Benefit plan/), { target: { value: "p1" } });
    fireEvent.change(screen.getByLabelText(/^Dependants/), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText(/^From/), { target: { value: "2026-11-01" } });
    submit("Enrol");
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(Object.fromEntries(action.mock.calls[0][1].entries())).toMatchObject({ employeeId: "e2", planId: "p1", dependants: "2", effectiveFrom: "2026-11-01" });
    expect(await screen.findByRole("alert")).toHaveTextContent("already enrolled in that plan");
    expect(refresh).toHaveBeenCalled();
  });
});

describe("TaxProfileForm", () => {
  it("defaults to TK/0 with the server deriving the TER category, and sends the profile", async () => {
    const action = pick({ ok: true, notice: "Tax profile recorded from 2026-11-01." });
    render(<TaxProfileForm tenantId="co-a" action={action} employees={employees} />);
    open("Set a tax profile");
    expect(screen.getByLabelText(/^PTKP status/)).toHaveValue("TK/0");
    expect(screen.getByLabelText(/^TER category/)).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Employee"), { target: { value: "e1" } });
    fireEvent.change(screen.getByLabelText(/^PTKP status/), { target: { value: "K/1" } });
    fireEvent.change(screen.getByLabelText(/^NPWP/), { target: { value: "12.345.678.9-012.000" } });
    fireEvent.change(screen.getByLabelText(/^Effective from/), { target: { value: "2026-11-01" } });
    submit("Record tax profile");
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(Object.fromEntries(action.mock.calls[0][1].entries())).toMatchObject({
      employeeId: "e1", ptkpStatus: "K/1", terCategory: "", npwp: "12.345.678.9-012.000", effectiveFrom: "2026-11-01", taxResident: "on",
    });
    expect(await screen.findByRole("status")).toHaveTextContent("Tax profile recorded from 2026-11-01.");
  });
});
