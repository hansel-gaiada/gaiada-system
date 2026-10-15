import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { PayrollInputForm } from "./PayrollInputForm";
import type { PayrollResult } from "@/lib/hrPayrollActions";

// DW-7f-1b — the Add input form: it sends the run's own period, the server's sentence is shown as sent
// after a refusal, and the page is re-read after every call.

function setup(result: PayrollResult) {
  const add = vi.fn(async (_t: string, _r: string, _f: FormData) => result);
  render(
    <PayrollInputForm add={add} tenantId="co-a" runId="run-1" periodStart="2026-10-01" periodEnd="2026-10-31"
      employees={[{ id: "e1", name: "Budi" }, { id: "e2", name: "Sari" }]} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add input" }));
  return add;
}
function fill() {
  fireEvent.change(screen.getByLabelText("Employee"), { target: { value: "e2" } });
  fireEvent.change(screen.getByLabelText(/^Category/), { target: { value: "bonus" } });
  fireEvent.change(screen.getByLabelText(/^Label/), { target: { value: "Q3 bonus" } });
  fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: "500000" } });
}
const submit = () => fireEvent.click(screen.getAllByRole("button", { name: "Add input" }).at(-1)!);

beforeEach(() => refresh.mockReset());
afterEach(() => cleanup());

describe("PayrollInputForm", () => {
  it("submits the employee, category, label, amount and the run's period, then refreshes and shows the server's notice", async () => {
    const add = setup({ ok: true, id: "in-1", notice: "Input recorded. It is counted the next time this run is calculated." });
    fill();
    submit();
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    const [tenant, run, fd] = add.mock.calls[0];
    expect([tenant, run]).toEqual(["co-a", "run-1"]);
    expect(Object.fromEntries(fd.entries())).toMatchObject({
      employeeId: "e2", category: "bonus", label: "Q3 bonus", amount: "500000", periodStart: "2026-10-01", periodEnd: "2026-10-31",
    });
    expect(await screen.findByRole("status")).toHaveTextContent("counted the next time this run is calculated");
    expect(refresh).toHaveBeenCalled();
  });

  it("shows the server's refusal as sent and keeps the form open", async () => {
    setup({ ok: false, error: "You don't have permission to add payroll inputs." });
    fill();
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("You don't have permission to add payroll inputs.");
    expect(screen.getByLabelText(/^Label/)).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });
});
