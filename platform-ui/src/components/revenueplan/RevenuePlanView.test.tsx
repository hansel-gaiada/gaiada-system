import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/revenuePlanActions", () => ({ setRevenuePlanMonth: vi.fn(), clearRevenuePlanMonth: vi.fn() }));

import { clearRevenuePlanMonth, setRevenuePlanMonth } from "@/lib/revenuePlanActions";
import { monthsOfYear, REFUSED_WORDS, type RevenuePlanRead } from "@/lib/revenuePlan";
import { RevenuePlanView } from "./RevenuePlanView";

// DW-7j-5 (BFF §40.6.4): the Revenue plan tab. The grid (twelve months, plan, actual, ratio), a refused or failed read said in words,
// and the editor offered only with the capability, its server refusal shown as a sentence.

const plan = (over: Partial<RevenuePlanRead> = {}): RevenuePlanRead => ({
  currency: "IDR", minorUnit: 0,
  months: monthsOfYear(2026).map((month) => ({
    month,
    amountMinor: month === "2026-08" ? 100_000_000 : month === "2026-09" ? 200_000_000 : null,
    note: month === "2026-08" ? "Q3 start" : null,
    setBy: null, setAt: null,
  })),
  ...over,
});
const actuals = {
  "2026-07": { kind: "ok" as const, data: 5_000_000 },
  "2026-08": { kind: "ok" as const, data: 90_000_000 },
  "2026-09": { kind: "ok" as const, data: 150_000_000 },
};
const view = (over: Partial<Parameters<typeof RevenuePlanView>[0]> = {}) =>
  render(<RevenuePlanView year={2026} deptId="d-gm" plan={{ kind: "ok", data: plan() }} actuals={actuals} canEdit={false} {...over} />);
const row = (name: string) => screen.getByRole("row", { name: new RegExp(`^${name}`) });

beforeEach(() => {
  refresh.mockReset();
  vi.mocked(setRevenuePlanMonth).mockReset();
  vi.mocked(clearRevenuePlanMonth).mockReset();
});

describe("the grid", () => {
  it("lists the twelve months with each plan, its actual revenue and actual ÷ plan", () => {
    view();
    expect(screen.getByRole("heading", { name: "Revenue plan 2026" })).toBeInTheDocument();
    const body = screen.getAllByRole("rowgroup")[1];
    expect(within(body).getAllByRole("row")).toHaveLength(12);
    const aug = within(row("August")).getAllByRole("cell").map((c) => c.textContent);
    expect(aug).toEqual(["IDR 100,000,000", "IDR 90,000,000", "90%"]);
    expect(within(row("September")).getAllByRole("cell").map((c) => c.textContent)).toEqual(["IDR 200,000,000", "IDR 150,000,000", "75%"]);
    expect(within(row("August")).getByRole("rowheader").textContent).toContain("Q3 start");
  });

  it("says 'No plan' and shows no ratio for a month with none, and 'Not yet' for a month that has not started", () => {
    view();
    expect(within(row("July")).getAllByRole("cell").map((c) => c.textContent)).toEqual(["No plan", "IDR 5,000,000", "—"]);
    expect(within(row("December")).getAllByRole("cell").map((c) => c.textContent)).toEqual(["No plan", "Not yet", "—"]);
  });

  it("says in words when a month's revenue could not be read: no access, could not be read, not reported (never a 0)", () => {
    view({ actuals: { "2026-08": { kind: "forbidden" }, "2026-09": { kind: "unavailable", reason: "timeout" }, "2026-10": { kind: "ok", data: null } } });
    expect(within(row("August")).getByText("No access")).toBeInTheDocument();
    expect(within(row("September")).getByText("Could not be read")).toBeInTheDocument();
    expect(within(row("October")).getByText("Not reported")).toBeInTheDocument();
    expect(within(row("August")).getAllByRole("cell")[2].textContent).toBe("—");
  });

  it("the year row adds the planned months and the months read, and the note says what the numbers are", () => {
    view();
    const year = screen.getAllByRole("rowgroup")[2];
    expect(within(year).getAllByRole("cell").map((c) => c.textContent)).toEqual(["IDR 300,000,000", "IDR 245,000,000", ""]);
    expect(screen.getByText(/the company's base currency/)).toBeInTheDocument();
    expect(screen.getByText(/2 of 12 months that have a plan and the 3 months whose revenue was read/)).toBeInTheDocument();
  });

  it("links the neighbouring years", () => {
    view();
    expect(screen.getByRole("link", { name: "2025" })).toHaveAttribute("href", "/departments/d-gm/revenue-plan?year=2025");
    expect(screen.getByRole("link", { name: "2027" })).toHaveAttribute("href", "/departments/d-gm/revenue-plan?year=2027");
    expect(screen.getByRole("link", { name: "2026" })).toHaveAttribute("aria-current", "true");
  });
});

describe("a plan that was not read", () => {
  it("a refused read says the person has no access, not that there is no plan", () => {
    view({ plan: { kind: "forbidden" } });
    expect(screen.getByText(/You don't have access to the revenue plan/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("a failed read says it cannot tell, with the server's reason, and shows no grid", () => {
    view({ plan: { kind: "unavailable", reason: "module finance not enabled for this company" } });
    expect(screen.getByText(/cannot be read right now/)).toBeInTheDocument();
    expect(screen.getByText("module finance not enabled for this company")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("a company with no finance settings says it has no base currency to plan in", () => {
    view({ plan: { kind: "ok", data: plan({ currency: null, minorUnit: null }) } });
    expect(screen.getByText(/no base currency to plan in/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

describe("the editor", () => {
  it("is offered only with the capability; without it the page says it is read-only", () => {
    view({ canEdit: false });
    expect(screen.queryByRole("button", { name: /the plan for/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Only a company administrator can set or clear the plan/)).toBeInTheDocument();
  });

  it("with the capability each month has Set (no plan) or Edit (a plan)", () => {
    view({ canEdit: true });
    expect(screen.getAllByRole("button", { name: /the plan for/ })).toHaveLength(12);
    expect(screen.getByRole("button", { name: "Edit the plan for August" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set the plan for July" })).toBeInTheDocument();
    expect(screen.queryByText(/Only a company administrator can set or clear/)).not.toBeInTheDocument();
  });

  it("saving sends the typed amount, closes the form and refreshes the page", async () => {
    vi.mocked(setRevenuePlanMonth).mockResolvedValue({ ok: true });
    view({ canEdit: true });
    fireEvent.click(screen.getByRole("button", { name: "Set the plan for July" }));
    const form = screen.getByRole("form", { name: "Plan for July" });
    fireEvent.change(within(form).getByLabelText(/Plan for July \(IDR\)/), { target: { value: "120000000" } });
    fireEvent.change(within(form).getByLabelText(/Note/), { target: { value: "Summer" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(setRevenuePlanMonth).toHaveBeenCalledWith("2026-07", "120000000", "Summer"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(screen.queryByRole("form", { name: "Plan for July" })).not.toBeInTheDocument();
  });

  it("shows the server's refusal as a sentence and keeps the form open (a manager holds company.manage and is refused)", async () => {
    vi.mocked(setRevenuePlanMonth).mockResolvedValue({ ok: false, error: REFUSED_WORDS });
    view({ canEdit: true });
    fireEvent.click(screen.getByRole("button", { name: "Edit the plan for September" }));
    const form = screen.getByRole("form", { name: "Plan for September" });
    expect((within(form).getByLabelText(/Plan for September/) as HTMLInputElement).value).toBe("200000000");
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent(REFUSED_WORDS);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("an amount the currency cannot hold is said under the amount field", async () => {
    vi.mocked(setRevenuePlanMonth).mockResolvedValue({ ok: false, error: "This currency has no decimals: enter a whole amount.", field: "amount" });
    view({ canEdit: true });
    fireEvent.click(screen.getByRole("button", { name: "Set the plan for July" }));
    const form = screen.getByRole("form", { name: "Plan for July" });
    fireEvent.change(within(form).getByLabelText(/Plan for July/), { target: { value: "100.5" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save" }));
    expect(await within(form).findByText("This currency has no decimals: enter a whole amount.")).toBeInTheDocument();
  });

  it("Clear is offered only where a plan exists, and clears the month", async () => {
    vi.mocked(clearRevenuePlanMonth).mockResolvedValue({ ok: true });
    view({ canEdit: true });
    fireEvent.click(screen.getByRole("button", { name: "Set the plan for July" }));
    expect(within(screen.getByRole("form", { name: "Plan for July" })).queryByRole("button", { name: /Clear/ })).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("form", { name: "Plan for July" })).getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByRole("button", { name: "Edit the plan for August" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear the plan for August" }));
    await waitFor(() => expect(clearRevenuePlanMonth).toHaveBeenCalledWith("2026-08"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
});
