import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// AIP-17b and AIP-18 (BFF §66.9, §66.11): the owner's edit forms and the lift. The money is checked as the server checks it before the round trip and the
// server's answer is the one that counts: its refusal is said next to the control, and what was typed stays.
vi.mock("@/lib/aiBudgetActions", () => ({
  setCompanyBudgetAction: vi.fn(), setUnitBudgetAction: vi.fn(), setAllowanceAction: vi.fn(), liftStopAction: vi.fn(),
}));

import { liftStopAction, setAllowanceAction, setCompanyBudgetAction, setUnitBudgetAction } from "@/lib/aiBudgetActions";
import { AddUnitBudgetForm, AllowanceCell, CompanyBudgetForm, LiftStopButton, UnitBudgetForm } from "./BudgetForms";

const company = vi.mocked(setCompanyBudgetAction);
const unit = vi.mocked(setUnitBudgetAction);
const allowance = vi.mocked(setAllowanceAction);
const lift = vi.mocked(liftStopAction);
const done = { ok: true as const, changed: true };

beforeEach(() => {
  for (const m of [company, unit, allowance, lift]) m.mockReset().mockResolvedValue(done);
});

const figure = () => screen.getByLabelText(/Monthly (alert )?figure/) as HTMLInputElement;
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

describe("the company's alert figure", () => {
  it("offers 'Set the figure' only for a valid figure, and sends what was typed", async () => {
    render(<CompanyBudgetForm line={null} />);
    const set = screen.getByRole("button", { name: "Set the figure" }) as HTMLButtonElement;
    expect(set.disabled).toBe(true);
    type(figure(), "250.00");
    expect(set.disabled).toBe(false);
    fireEvent.click(set);
    await waitFor(() => expect(company).toHaveBeenCalledWith("250.00"));
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  });
  it("says why a figure is refused before any round trip: five places, zero, a comma", () => {
    render(<CompanyBudgetForm line={null} />);
    for (const [v, words] of [["1.23456", /4 decimal places/], ["0", /more than 0/], ["1,000", /positive number/]] as const) {
      type(figure(), v);
      expect(screen.getByText(words)).toBeInTheDocument();
      expect((screen.getByRole("button", { name: "Set the figure" }) as HTMLButtonElement).disabled).toBe(true);
    }
    expect(company).not.toHaveBeenCalled();
  });
  it("with a figure set, starts from it, offers Change and Remove, and Remove sends null", async () => {
    render(<CompanyBudgetForm line={{ monthlyUsd: "250.0000" }} />);
    expect(figure().value).toBe("250.0000");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(company).toHaveBeenCalledWith(null));
    expect(await screen.findByText("Removed.")).toBeInTheDocument();
    expect(figure().value).toBe("");
  });
  it("says the server's refusal next to the form and keeps what was typed", async () => {
    company.mockResolvedValue({ ok: false, error: "Only the owner can change AI budgets and allowances." });
    render(<CompanyBudgetForm line={null} />);
    type(figure(), "40");
    fireEvent.click(screen.getByRole("button", { name: "Set the figure" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Only the owner can change AI budgets and allowances.");
    expect(figure().value).toBe("40");
  });
  it("says 'Nothing changed.' when the server says nothing moved", async () => {
    company.mockResolvedValue({ ok: true, changed: false });
    render(<CompanyBudgetForm line={{ monthlyUsd: "250.0000" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(await screen.findByText("Nothing changed.")).toBeInTheDocument();
  });
});

describe("a department's budget", () => {
  it("defaults a new budget to Report only (AIP-D7) and sends the mode chosen", async () => {
    render(<UnitBudgetForm unitNodeId="d-web" line={null} label="Web Dev" />);
    const mode = screen.getByLabelText("When it reaches the figure") as HTMLSelectElement;
    expect(mode.value).toBe("report");
    expect(screen.getByText(/The owner and the department's head are told at 80% and at 100%/)).toBeInTheDocument();
    type(figure(), "40");
    fireEvent.click(screen.getByRole("button", { name: "Set the budget" }));
    await waitFor(() => expect(unit).toHaveBeenCalledWith("d-web", "40", "report"));
    type(mode, "soft_stop");
    expect(screen.getByText(/replies for this department continue in a lighter mode/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Set the budget" }));
    await waitFor(() => expect(unit).toHaveBeenLastCalledWith("d-web", "40", "soft_stop"));
  });
  it("starts from the stored figure and mode, and Remove sends null with no mode", async () => {
    render(<UnitBudgetForm unitNodeId="d-web" line={{ monthlyUsd: "1.0000", mode: "soft_stop" }} label="Web Dev" />);
    expect(figure().value).toBe("1.0000");
    expect((screen.getByLabelText("When it reaches the figure") as HTMLSelectElement).value).toBe("soft_stop");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(unit).toHaveBeenCalledWith("d-web", null));
  });
  it("shows a 400 in the server's words", async () => {
    unit.mockResolvedValue({ ok: false, error: "monthlyUsd must be a positive decimal with at most 4 decimal places", field: "monthlyUsd" });
    render(<UnitBudgetForm unitNodeId="d-web" line={null} label="Web Dev" />);
    type(figure(), "5");
    fireEvent.click(screen.getByRole("button", { name: "Set the budget" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("monthlyUsd must be a positive decimal");
  });
});

describe("adding a budget from the company view", () => {
  const options = [{ value: "d-seo", label: "SEO" }, { value: "d-hr", label: "HR" }];
  it("needs a department and a figure, then sets it and resets the form", async () => {
    render(<AddUnitBudgetForm options={options} />);
    const go = screen.getByRole("button", { name: "Set the budget" }) as HTMLButtonElement;
    type(figure(), "10");
    expect(go.disabled).toBe(true); // no department yet
    type(screen.getByLabelText("Department"), "d-seo");
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(unit).toHaveBeenCalledWith("d-seo", "10", "report"));
    await waitFor(() => expect(figure().value).toBe(""));
  });
  it("renders nothing when every department already has a budget", () => {
    const { container } = render(<AddUnitBudgetForm options={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("the allowance cell", () => {
  it("shows the default beside the number when there is no override, with no 'Use the default' button", () => {
    render(<AllowanceCell userId="u-2" name="Made Putra" dailyReplies={200} isDefault />);
    expect(screen.getByText(/200 a day/)).toHaveTextContent("200 a day (default)");
    fireEvent.click(screen.getByRole("button", { name: /Change/ }));
    expect(screen.queryByRole("button", { name: "Use the default" })).not.toBeInTheDocument();
  });
  it("sets an override: the number, no '(default)'", async () => {
    render(<AllowanceCell userId="u-2" name="Made Putra" dailyReplies={200} isDefault />);
    fireEvent.click(screen.getByRole("button", { name: /Change/ }));
    type(screen.getByLabelText("Replies a day for Made Putra"), "350");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(allowance).toHaveBeenCalledWith("u-2", 350));
  });
  it("refuses a bad number before any round trip", () => {
    render(<AllowanceCell userId="u-2" name="Made Putra" dailyReplies={200} isDefault />);
    fireEvent.click(screen.getByRole("button", { name: /Change/ }));
    for (const v of ["0", "100001", "1.5", ""]) {
      type(screen.getByLabelText("Replies a day for Made Putra"), v);
      expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    }
    expect(allowance).not.toHaveBeenCalled();
  });
  it("clears an override with null (back to the default)", async () => {
    render(<AllowanceCell userId="u-2" name="Made Putra" dailyReplies={350} isDefault={false} />);
    expect(screen.getByText(/350 a day/)).not.toHaveTextContent("(default)");
    fireEvent.click(screen.getByRole("button", { name: /Change/ }));
    fireEvent.click(screen.getByRole("button", { name: "Use the default" }));
    await waitFor(() => expect(allowance).toHaveBeenCalledWith("u-2", null));
  });
  it("says a refusal and stays open", async () => {
    allowance.mockResolvedValue({ ok: false, error: "This person is not an active member of this company." });
    render(<AllowanceCell userId="u-2" name="Made Putra" dailyReplies={200} isDefault />);
    fireEvent.click(screen.getByRole("button", { name: /Change/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not an active member");
    expect(screen.getByLabelText("Replies a day for Made Putra")).toBeInTheDocument();
  });
});

describe("the lift (AIP-18)", () => {
  it("asks first, saying what lifting does, and lifts nothing until it is confirmed", async () => {
    render(<LiftStopButton unitNodeId="d-web" monthName="October 2026" />);
    fireEvent.click(screen.getByRole("button", { name: "Lift the stop for the rest of this month" }));
    expect(screen.getByText(/Replies return to normal for this department until the month ends, and waiting agent runs start/)).toBeInTheDocument();
    expect(lift).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm: lift the stop" }));
    await waitFor(() => expect(lift).toHaveBeenCalledWith("d-web"));
    expect(await screen.findByText("The stop is lifted for this month.")).toBeInTheDocument();
  });
  it("cancelling lifts nothing and goes back to the button", () => {
    render(<LiftStopButton unitNodeId="d-web" monthName="October 2026" />);
    fireEvent.click(screen.getByRole("button", { name: "Lift the stop for the rest of this month" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(lift).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Lift the stop for the rest of this month" })).toBeInTheDocument();
  });
  it("says the server's refusal and keeps the confirm open", async () => {
    lift.mockResolvedValue({ ok: false, error: "Only the owner, or the head of this department, can lift its stop." });
    render(<LiftStopButton unitNodeId="d-web" monthName="October 2026" />);
    fireEvent.click(screen.getByRole("button", { name: "Lift the stop for the rest of this month" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm: lift the stop" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("head of this department");
    expect(screen.getByRole("button", { name: "Confirm: lift the stop" })).toBeInTheDocument();
  });
});
