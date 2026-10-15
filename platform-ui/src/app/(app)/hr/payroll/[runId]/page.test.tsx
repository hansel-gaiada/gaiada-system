import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// DW-7f-1b — /hr/payroll/[runId]: the run header and timeline, the payslips from the server, an honest
// refusal instead of an empty table, the input form only for an accepting status and the manage
// capability, and a 404 run.
// DW-7f-1c — the two input lists (consumed by this run, waiting for the next calculate) from the inputs
// read, an empty list saying "No inputs", and a refused or failed read said in words.

vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => { throw new Error("redirect"); }),
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
const me = { userId: "u-1", roles: [] as { role: string; scopeType: string; scopeId: string | null }[], companies: [] };
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(async () => me) }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
// No stock role holds hr.payroll.view without hr.payroll.manage, so a capability can be switched off here.
const denied = new Set<string>();
vi.mock("@/lib/rbac", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/rbac")>();
  return { ...real, can: (...a: Parameters<typeof real.can>) => (denied.has(a[1] as string) ? false : real.can(...a)) };
});
vi.mock("@/lib/hrPayrollActions", () => ({
  addPayrollInput: vi.fn(), calculatePayrollRun: vi.fn(), approvePayrollRun: vi.fn(),
  publishPayrollRun: vi.fn(), markPayrollRunPaid: vi.fn(),
}));

type Read = { kind: "ok"; data: unknown } | { kind: "forbidden" } | { kind: "unavailable"; reason: string };
let runRead: Read;
let employeesRead: Read;
let consumedInputsRead: Read;
let waitingInputsRead: Read;
const employeesSpy = vi.fn();
const inputsSpy = vi.fn();
vi.mock("@/lib/hr-full-data", () => ({
  getPayrollRunResult: vi.fn(async () => runRead),
  listEmployeesResult: vi.fn(async () => { employeesSpy(); return employeesRead; }),
  listPayrollInputsResult: vi.fn(async (_u: string, _t: string, filter: { runId?: string; consumed?: boolean }) => {
    inputsSpy(filter);
    return filter.runId ? consumedInputsRead : waitingInputsRead;
  }),
}));
vi.mock("@/lib/hr-full", () => ({
  listParameterSets: vi.fn(async () => [{ id: "set-ok", ratifiedAt: "2026-02-01T00:00:00Z" }]),
  formatMoney: (v: string) => `Rp ${v}`,
}));

const input = (over: Record<string, unknown>) => ({
  id: "i1", employeeId: "e1", employeeName: "Budi", periodStart: "2026-09-01", periodEnd: "2026-09-30",
  category: "overtime", code: null, label: "Overtime September", quantity: "12.500", amount: null,
  taxable: true, note: null, consumedByRunId: null, createdBy: "u-1", createdAt: "2026-09-20T00:00:00Z", ...over,
});
const slip = (over: Record<string, unknown>) => ({
  id: "p1", employeeId: "e1", employeeName: "Budi", gross: "10000000", taxableGross: "10000000",
  employeeDeductions: "400000", taxWithheld: "250000", net: "9350000", employerCost: "11000000",
  status: "final", publishedAt: null, ...over,
});
const run = (over: Record<string, unknown> = {}) => ({
  id: "r1", reference: "PAY-2026-09", kind: "regular", periodStart: "2026-09-01", periodEnd: "2026-09-30",
  payDate: "2026-09-28", currency: "IDR", status: "calculated", parameterSetId: "set-ok",
  unratifiedOverrideAt: null, unratifiedOverrideBy: null, unratifiedOverrideReason: null,
  totalGross: "10000000", totalNet: "9350000", totalEmployerCost: "11000000", employeeCount: 1,
  calculatedAt: "2026-10-02T03:00:00Z", approvedAt: null, paidAt: null, createdAt: "2026-09-01T00:00:00Z",
  parameterSetRatifiedAt: "2026-02-01T00:00:00Z", parameterSetName: "ID 2026", payslips: [slip({})], ...over,
});

import HrPayrollRunPage from "./page";

function as(role: string) {
  me.roles = [{ role, scopeType: "company", scopeId: "co-a" }];
}
async function renderPage() {
  render(await HrPayrollRunPage({ params: Promise.resolve({ runId: "r1" }) }));
}

beforeEach(() => {
  employeesSpy.mockReset();
  inputsSpy.mockReset();
  consumedInputsRead = { kind: "ok", data: [] };
  waitingInputsRead = { kind: "ok", data: [] };
  denied.clear();
  runRead = { kind: "ok", data: run() };
  employeesRead = {
    kind: "ok",
    data: [
      { id: "e1", displayName: "Budi", employmentStatus: "active" },
      { id: "e2", displayName: "Sari", employmentStatus: "on_leave" },
      { id: "e3", displayName: "Gone Person", employmentStatus: "terminated" },
    ],
  };
});
afterEach(() => cleanup());

describe("/hr/payroll/[runId]", () => {
  it("shows the header, the timeline the server stamped, the payslips and the totals", async () => {
    as("hr_manager");
    await renderPage();
    expect(screen.getByText("PAY-2026-09")).toBeInTheDocument();
    expect(screen.getByText("2026-09-01 → 2026-09-30")).toBeInTheDocument();
    expect(screen.getByText("2026-09-28")).toBeInTheDocument();
    expect(screen.getByText("ID 2026 (ratified 2026-02-01)")).toBeInTheDocument();
    expect(screen.getByText("calculated 2026-10-02")).toBeInTheDocument();
    expect(screen.getByText("Budi")).toBeInTheDocument();
    expect(screen.getByText("Rp 9350000", { selector: ".lux-table__row *" })).toBeInTheDocument();
    expect(screen.getByText("not published")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /All payroll runs/ })).toHaveAttribute("href", "/hr/payroll");
  });

  it("reuses the run actions for the run's status", async () => {
    as("hr_manager");
    await renderPage();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(expect.arrayContaining(["Recalculate", "Approve"]));
  });

  it("shows the override and the reason the server recorded", async () => {
    as("hr_manager");
    runRead = { kind: "ok", data: run({ status: "approved", approvedAt: "2026-10-03T03:00:00Z", unratifiedOverrideAt: "2026-10-03T03:00:00Z", unratifiedOverrideReason: "Set awaiting signature" }) };
    await renderPage();
    expect(screen.getByRole("note")).toHaveTextContent("Approved against an unratified statutory parameter set");
    expect(screen.getByRole("note")).toHaveTextContent("Set awaiting signature");
  });

  it("a refused read is a sentence of refusal, not an empty payslip table", async () => {
    as("hr_manager");
    runRead = { kind: "forbidden" };
    await renderPage();
    expect(screen.getByText(/You don't have access to this payroll run and its payslips/)).toBeInTheDocument();
    expect(screen.queryByText("Payslips")).toBeNull();
    expect(screen.queryByText(/no payslips/i)).toBeNull();
  });

  it("a failed read says it cannot tell, with the server's reason", async () => {
    as("hr_manager");
    runRead = { kind: "unavailable", reason: "upstream timeout" };
    await renderPage();
    expect(screen.getByText(/not a statement that there is nothing/)).toBeInTheDocument();
    expect(screen.getByText("upstream timeout")).toBeInTheDocument();
  });

  it("a run with no payslips says why for a draft", async () => {
    as("hr_manager");
    runRead = { kind: "ok", data: run({ status: "draft", payslips: [], calculatedAt: null, totalNet: null, employeeCount: null }) };
    await renderPage();
    expect(screen.getByText(/has not been calculated, so it has no payslips yet/)).toBeInTheDocument();
    expect(screen.getByText("Not calculated yet.")).toBeInTheDocument();
  });

  it("a 404 run is notFound()", async () => {
    as("hr_manager");
    runRead = { kind: "ok", data: null };
    await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("a reader without hr.payroll.view sees no payroll and triggers no read", async () => {
    as("hr_staff");
    await renderPage();
    expect(screen.getByText(/Payroll is restricted/)).toBeInTheDocument();
    expect(screen.queryByText("PAY-2026-09")).toBeNull();
  });
});

describe("/hr/payroll/[runId] — add input", () => {
  it("offers Add input for a manager on a calculated run", async () => {
    as("hr_manager");
    await renderPage();
    expect(screen.getByRole("button", { name: "Add input" })).toBeInTheDocument();
    expect(employeesSpy).toHaveBeenCalledTimes(1);
    // The old "the server offers no read of the inputs" note is gone: the lists replace it.
    expect(screen.queryByText(/offers no read of the inputs/)).toBeNull();
  });

  it("the picker lists only the employees a run can calculate (active, on leave), by name", async () => {
    as("hr_manager");
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Add input" }));
    const picker = screen.getByLabelText("Employee") as HTMLSelectElement;
    expect([...picker.options].map((o) => o.textContent)).toEqual(["Select an employee…", "Budi", "Sari"]);
    expect([...picker.options].map((o) => o.value)).toEqual(["", "e1", "e2"]);
    expect(screen.getByText(/Applies to the period 2026-09-01 to 2026-09-30/)).toBeInTheDocument();
  });

  it("offers it on a draft run too", async () => {
    as("hr_manager");
    runRead = { kind: "ok", data: run({ status: "draft", payslips: [] }) };
    await renderPage();
    expect(screen.getByRole("button", { name: "Add input" })).toBeInTheDocument();
  });

  it.each(["approved", "paid", "pending_approval", "cancelled"])("does not offer it on a %s run, and says why", async (status) => {
    as("hr_manager");
    runRead = { kind: "ok", data: run({ status }) };
    await renderPage();
    expect(screen.queryByRole("button", { name: "Add input" })).toBeNull();
    expect(employeesSpy).not.toHaveBeenCalled();
    expect(screen.getByText(/can no longer be calculated/)).toBeInTheDocument();
  });

  it("does not offer it, nor read the employees, without hr.payroll.manage", async () => {
    as("hr_manager");
    denied.add("hr.payroll.manage");
    await renderPage();
    expect(screen.getByText("PAY-2026-09")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add input" })).toBeNull();
    expect(employeesSpy).not.toHaveBeenCalled();
    expect(screen.queryByText(/can no longer be calculated/)).toBeNull();
  });

  it("says in words when the employee list is refused or unreadable, and shows no form", async () => {
    as("hr_manager");
    employeesRead = { kind: "forbidden" };
    await renderPage();
    expect(screen.getByText(/You don't have access to the employee list/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add input" })).toBeNull();
    cleanup();
    employeesRead = { kind: "unavailable", reason: "db down" };
    await renderPage();
    expect(screen.getByText(/cannot be read right now/)).toBeInTheDocument();
    expect(screen.getByText("db down")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add input" })).toBeNull();
  });
});

describe("/hr/payroll/[runId] — payroll inputs lists", () => {
  const list = (name: string) => within(screen.getByRole("region", { name }));

  it("shows both lists, each from its own filter, with employee, category, label, quantity or amount, taxable and note", async () => {
    as("hr_manager");
    consumedInputsRead = { kind: "ok", data: [
      input({ id: "c1", employeeName: "Budi", label: "Overtime September", quantity: "12.500", amount: null, note: "Month-end close", consumedByRunId: "r1" }),
      input({ id: "c2", employeeName: "Sari", category: "bonus", label: "Spot bonus", quantity: null, amount: "250000", taxable: false, periodStart: "2026-09-15", periodEnd: "2026-09-15", consumedByRunId: "r1" }),
    ] };
    waitingInputsRead = { kind: "ok", data: [
      input({ id: "w1", employeeName: "Dewi", category: "reimbursement", label: "Taxi claim", quantity: null, amount: "75000", note: "Receipt 14" }),
    ] };
    await renderPage();

    expect(inputsSpy).toHaveBeenCalledWith({ runId: "r1" });
    expect(inputsSpy).toHaveBeenCalledWith({ periodStart: "2026-09-01", periodEnd: "2026-09-30", consumed: false });

    const consumed = list("Consumed by this run");
    expect(consumed.getByText("Overtime September")).toBeInTheDocument();
    expect(consumed.getByText("overtime")).toBeInTheDocument();
    expect(consumed.getByText("Qty 12.5")).toBeInTheDocument();      // numeric(12,3) "12.500" reads 12.5
    expect(consumed.getByText("Month-end close")).toBeInTheDocument();
    expect(consumed.getByText("Sari")).toBeInTheDocument();
    expect(consumed.getByText("Rp 250000")).toBeInTheDocument();
    expect(consumed.getByText("2026-09-15")).toBeInTheDocument();    // a one-day period is one date
    expect(consumed.getByText("No")).toBeInTheDocument();            // Sari's bonus is not taxable
    expect(consumed.queryByText("Taxi claim")).toBeNull();

    const waiting = list("Waiting for the next calculate");
    expect(waiting.getByText("Taxi claim")).toBeInTheDocument();
    expect(waiting.getByText("Dewi")).toBeInTheDocument();
    expect(waiting.getByText("Rp 75000")).toBeInTheDocument();
    expect(waiting.getByText("Receipt 14")).toBeInTheDocument();
    expect(waiting.queryByText("Overtime September")).toBeNull();
    expect(waiting.getByText(/The next calculate takes them in/)).toBeInTheDocument();
  });

  it("an empty list says No inputs (the server answered that there are none)", async () => {
    as("hr_manager");
    await renderPage();
    expect(list("Consumed by this run").getByText("No inputs")).toBeInTheDocument();
    expect(list("Waiting for the next calculate").getByText("No inputs")).toBeInTheDocument();
  });

  it("shows the waiting list only while the run can still be calculated", async () => {
    as("hr_manager");
    runRead = { kind: "ok", data: run({ status: "draft", payslips: [] }) };
    await renderPage();
    expect(screen.getByRole("region", { name: "Waiting for the next calculate" })).toBeInTheDocument();
    cleanup();
    inputsSpy.mockReset();
    for (const status of ["approved", "paid", "pending_approval", "cancelled"]) {
      runRead = { kind: "ok", data: run({ status }) };
      await renderPage();
      expect(screen.queryByRole("region", { name: "Waiting for the next calculate" }), status).toBeNull();
      expect(screen.getByRole("region", { name: "Consumed by this run" }), status).toBeInTheDocument();
      cleanup();
    }
    // Only the consumed read was made for the non-accepting statuses.
    expect(inputsSpy).toHaveBeenCalledTimes(4);
    expect(inputsSpy.mock.calls.every(([f]) => (f as { runId?: string }).runId === "r1")).toBe(true);
  });

  it("a refused inputs read is said in words, not shown as an empty list", async () => {
    as("hr_manager");
    consumedInputsRead = { kind: "forbidden" };
    waitingInputsRead = { kind: "forbidden" };
    await renderPage();
    expect(screen.getByText(/You don't have access to the payroll inputs this run consumed/)).toBeInTheDocument();
    expect(screen.getByText(/You don't have access to the payroll inputs waiting for the next calculate/)).toBeInTheDocument();
    expect(screen.queryByText("No inputs")).toBeNull();
    // The run itself still renders: only the inputs read was refused.
    expect(screen.getByText("PAY-2026-09")).toBeInTheDocument();
  });

  it("a failed inputs read says it cannot tell, with the server's reason, and does not say No inputs", async () => {
    as("hr_manager");
    consumedInputsRead = { kind: "unavailable", reason: "inputs upstream timeout" };
    await renderPage();
    const consumed = list("Consumed by this run");
    expect(consumed.getByText(/not a statement that there is nothing/)).toBeInTheDocument();
    expect(consumed.getByText("inputs upstream timeout")).toBeInTheDocument();
    expect(consumed.queryByText("No inputs")).toBeNull();
    // The other list is its own read and still answers.
    expect(list("Waiting for the next calculate").getByText("No inputs")).toBeInTheDocument();
  });
});
