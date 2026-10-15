import { render, screen, within, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// DW-7f-1 — /hr/payroll wiring: the controls follow the UI capability mirrors (hr.payroll.manage and
// hr.payroll.approve), the override is offered when the run's statutory set is not confirmed ratified,
// and the Timeline shows only the stamps the server set.

vi.mock("next/navigation", () => ({ redirect: vi.fn(() => { throw new Error("redirect"); }), useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock("@/lib/session-server", () => ({ getSessionUserId: vi.fn(async () => "u-1") }));
const me = { userId: "u-1", roles: [] as { role: string; scopeType: string; scopeId: string | null }[], companies: [] };
vi.mock("@/lib/platform", () => ({ getMe: vi.fn(async () => me) }));
vi.mock("@/lib/tenant", () => ({ getActiveTenant: vi.fn(async () => "co-a") }));
vi.mock("@/lib/hrPayrollActions", () => ({
  createPayrollRun: vi.fn(), calculatePayrollRun: vi.fn(), approvePayrollRun: vi.fn(),
  publishPayrollRun: vi.fn(), markPayrollRunPaid: vi.fn(),
}));

const run = (over: Record<string, unknown>) => ({
  id: "r", reference: "R", kind: "regular", periodStart: "2026-09-01", periodEnd: "2026-09-30", payDate: null,
  currency: "IDR", status: "draft", parameterSetId: null, unratifiedOverrideAt: null, totalGross: null,
  totalNet: null, totalEmployerCost: null, employeeCount: null, calculatedAt: null, approvedAt: null,
  paidAt: null, createdAt: "2026-09-01T00:00:00Z", ...over,
});
let runs: ReturnType<typeof run>[] = [];
vi.mock("@/lib/hr-full", () => ({
  listPayrollRuns: vi.fn(async () => runs),
  listParameterSets: vi.fn(async () => [
    { id: "set-ok", name: "ID 2026", countryCode: "ID", effectiveFrom: "2026-01-01", effectiveTo: null, ratifiedBy: "u", ratifiedAt: "2026-02-01T00:00:00Z", sourceNote: null, parameterCount: 3 },
    { id: "set-open", name: "ID 2026 draft", countryCode: "ID", effectiveFrom: "2026-01-01", effectiveTo: null, ratifiedBy: null, ratifiedAt: null, sourceNote: null, parameterCount: 3 },
  ]),
  listSeparations: vi.fn(async () => []),
  formatMoney: (v: string) => `Rp ${v}`,
}));

import HrPayrollPage from "./page";

function as(role: string) {
  me.roles = [{ role, scopeType: "company", scopeId: "co-a" }];
}
async function renderPage() {
  render(await HrPayrollPage());
}
const buttonsIn = (row: HTMLElement) => within(row).queryAllByRole("button").map((b) => b.textContent);
const rowOf = (reference: string) => screen.getByRole("link", { name: reference }).closest(".lux-table__row") as HTMLElement;

beforeEach(() => {
  runs = [
    run({ id: "r1", reference: "DRAFT-1", status: "draft" }),
    run({ id: "r2", reference: "CALC-OK", status: "calculated", parameterSetId: "set-ok", calculatedAt: "2026-10-02T03:00:00Z", totalNet: "100", employeeCount: 3 }),
    run({ id: "r3", reference: "CALC-OPEN", status: "calculated", parameterSetId: "set-open", calculatedAt: "2026-10-02T03:00:00Z" }),
    run({ id: "r4", reference: "APPR-1", status: "approved", approvedAt: "2026-10-03T03:00:00Z", calculatedAt: "2026-10-02T03:00:00Z", parameterSetId: "set-ok" }),
    run({ id: "r5", reference: "PAID-1", status: "paid", paidAt: "2026-10-05T03:00:00Z", approvedAt: "2026-10-03T03:00:00Z", parameterSetId: "set-ok" }),
  ];
});
afterEach(() => cleanup());

describe("/hr/payroll write controls", () => {
  it("an hr_manager (manage + approve) gets the new-run button and each run's buttons for its status", async () => {
    as("hr_manager");
    await renderPage();
    expect(screen.getByRole("button", { name: "New payroll run" })).toBeInTheDocument();
    expect(buttonsIn(rowOf("DRAFT-1"))).toEqual(["Calculate"]);
    expect(buttonsIn(rowOf("CALC-OK"))).toEqual(["Recalculate", "Approve"]);
    expect(buttonsIn(rowOf("APPR-1"))).toEqual(["Publish payslips", "Mark paid"]);
    expect(buttonsIn(rowOf("PAID-1"))).toEqual(["Publish payslips"]);
  });

  it("offers the override only on a run whose parameter set is not confirmed ratified", async () => {
    as("hr_manager");
    await renderPage();
    fireEvent.click(within(rowOf("CALC-OK")).getByRole("button", { name: "Approve" }));
    expect(screen.queryByRole("checkbox")).toBeNull();
    cleanup();
    await renderPage();
    fireEvent.click(within(rowOf("CALC-OPEN")).getByRole("button", { name: "Approve" }));
    expect(screen.getByRole("checkbox", { name: /unratified statutory parameters/ })).toBeInTheDocument();
  });

  it("shows the server's stamps in the Timeline and nothing for steps that have not happened", async () => {
    as("hr_manager");
    await renderPage();
    expect(rowOf("PAID-1")).toHaveTextContent("approved 2026-10-03 · paid 2026-10-05");
    expect(rowOf("PAID-1")).not.toHaveTextContent("calculated");
    expect(rowOf("DRAFT-1")).not.toHaveTextContent("calculated");
  });

  it("a reader without hr.payroll.view sees no payroll at all", async () => {
    as("hr_staff");
    await renderPage();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/Payroll is restricted/)).toBeInTheDocument();
  });
});
