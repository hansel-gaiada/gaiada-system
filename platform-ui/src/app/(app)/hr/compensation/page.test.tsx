import { render, screen, cleanup, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// DW-7f-3 — /hr/compensation: the honest lists (a refused or failed read is said in words, never an empty table),
// the pay history on ?employee=, and the write controls per capability (hr.payroll.manage shows all six forms; a
// view-only reader sees none).

vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => { throw new Error("redirect"); }),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
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
vi.mock("@/lib/hrCompensationActions", () => ({
  setCompensation: vi.fn(), saveAllowanceType: vi.fn(), assignAllowance: vi.fn(), saveBenefitPlan: vi.fn(),
  enrolBenefit: vi.fn(), setTaxProfile: vi.fn(),
}));
vi.mock("@/lib/hr-full", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hr-full")>()),
  formatMoney: (v: string | number | null | undefined) => (v === null || v === undefined || v === "" ? "—" : `Rp ${v}`),
}));

type Read = { kind: "ok"; data: unknown } | { kind: "forbidden" } | { kind: "unavailable"; reason: string };
let currentRead: Read;
let historyRead: Read;
let gradesRead: Read;
let allowancesRead: Read;
let plansRead: Read;
let employeesRead: Read;
const employeesSpy = vi.fn();
const compensationSpy = vi.fn();
vi.mock("@/lib/hr-full-data", () => ({
  listCompensationResult: vi.fn(async (_u: string, _t: string, params: { employeeId?: string; current?: boolean }) => {
    compensationSpy(params);
    return params.employeeId ? historyRead : currentRead;
  }),
  listPayGradesResult: vi.fn(async () => gradesRead),
  listAllowanceTypesResult: vi.fn(async () => allowancesRead),
  listBenefitPlansResult: vi.fn(async () => plansRead),
  listEmployeesResult: vi.fn(async () => { employeesSpy(); return employeesRead; }),
}));

const row = (over: Record<string, unknown> = {}) => ({
  id: "c1", employeeId: "e1", employeeName: "Budi", subjectUserId: null, gradeId: "g1", gradeCode: "G1",
  baseAmount: "9000000.50", currency: "IDR", rateBasis: "monthly", payFrequency: "monthly", fte: "1.000",
  effectiveFrom: "2026-01-01", effectiveTo: null, changeReason: "annual_review", approvedAt: null, note: null, ...over,
});
const type = (over: Record<string, unknown> = {}) => ({
  id: "t1", code: "TRANSPORT", label: "Transport", direction: "allowance", calcKind: "fixed", defaultAmount: "500000",
  defaultPercent: null, taxable: true, bpjsBase: false, prorated: true, isActive: true, ...over,
});
const plan = (over: Record<string, unknown> = {}) => ({
  id: "p1", code: "BPJS-KES", name: "BPJS Kesehatan", kind: "statutory", statutoryCode: "bpjs_kesehatan", provider: null,
  employerRate: "0.0400", employeeRate: "0.0100", wageCap: "12000000", wageFloor: null, currency: "IDR", isActive: true, ...over,
});
const grade = (over: Record<string, unknown> = {}) => ({
  id: "g1", code: "G1", name: "Staff", track: "individual", level: 1, minAmount: "5000000", midAmount: null, maxAmount: "12000000",
  currency: "IDR", rateBasis: "monthly", isActive: true, ...over,
});

import HrCompensationPage from "./page";

function as(role: string) {
  me.roles = [{ role, scopeType: "company", scopeId: "co-a" }];
}
async function renderPage(employee?: string) {
  render(await HrCompensationPage({ searchParams: Promise.resolve(employee ? { employee } : {}) }));
}
const buttons = () => screen.queryAllByRole("button").map((b) => b.textContent);
const FORM_BUTTONS = [
  "Set compensation", "Add allowance type", "Add benefit plan", "Assign an allowance", "Enrol in a benefit plan", "Set a tax profile",
];

beforeEach(() => {
  employeesSpy.mockReset();
  compensationSpy.mockReset();
  denied.clear();
  currentRead = { kind: "ok", data: [row()] };
  historyRead = { kind: "ok", data: [] };
  gradesRead = { kind: "ok", data: [grade()] };
  allowancesRead = { kind: "ok", data: [type()] };
  plansRead = { kind: "ok", data: [plan()] };
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

describe("/hr/compensation", () => {
  it("shows what the server returned: in-force rows with the rate basis beside the amount, grades, types and plans", async () => {
    as("hr_manager");
    await renderPage();
    expect(screen.getByText("Budi")).toBeInTheDocument();
    expect(screen.getByText("Rp 9000000.50")).toBeInTheDocument();
    expect(screen.getByText("annual review")).toBeInTheDocument();
    expect(screen.getByText("TRANSPORT · Transport")).toBeInTheDocument();
    expect(screen.getByText("BPJS-KES · BPJS Kesehatan")).toBeInTheDocument();
    expect(screen.getByText("4.00%")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Pay history for Budi" })).toHaveAttribute("href", "/hr/compensation?employee=e1");
    expect(compensationSpy).toHaveBeenCalledWith({ current: true });
  });

  it("says the table is empty only when the server answered an empty list", async () => {
    as("hr_manager");
    currentRead = { kind: "ok", data: [] };
    await renderPage();
    expect(screen.getByText(/Nobody has a compensation record/)).toBeInTheDocument();
  });

  it("a refused read is a sentence of refusal, not an empty table; KPI tiles say they cannot be read", async () => {
    as("hr_manager");
    currentRead = { kind: "forbidden" };
    await renderPage();
    expect(screen.getByText(/You don't have access to the compensation records/)).toBeInTheDocument();
    expect(screen.queryByText(/Nobody has a compensation record/)).toBeNull();
    expect(screen.getAllByText("cannot be read").length).toBeGreaterThanOrEqual(2);
  });

  it("a failed read says nobody can tell, and carries the reason", async () => {
    as("hr_manager");
    allowancesRead = { kind: "unavailable", reason: "platform 500" };
    plansRead = { kind: "unavailable", reason: "platform 503" };
    gradesRead = { kind: "forbidden" };
    await renderPage();
    expect(screen.getAllByText(/The allowance types cannot be read right now/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("platform 500").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/The benefit plans cannot be read right now/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("platform 503").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/You don't have access to the pay grades/)).toBeInTheDocument();
    expect(screen.queryByText("No allowance types defined.")).toBeNull();
    expect(screen.queryByText(/No benefit plans\./)).toBeNull();
    expect(screen.queryByText(/No grade structure defined/)).toBeNull();
  });

  it("offers all six write forms to hr.payroll.manage", async () => {
    as("hr_manager");
    await renderPage();
    expect(buttons()).toEqual(expect.arrayContaining(FORM_BUTTONS));
    expect(screen.getByRole("note")).toHaveTextContent("no read for an employee's allowances, benefit enrolments or tax profile");
  });

  it("offers none of them to a view-only reader, and does not even read the employee list", async () => {
    as("hr_manager");
    denied.add("hr.payroll.manage");
    await renderPage();
    expect(screen.getByText("Budi")).toBeInTheDocument();
    for (const b of FORM_BUTTONS) expect(buttons()).not.toContain(b);
    expect(screen.queryByRole("note")).toBeNull();
    expect(employeesSpy).not.toHaveBeenCalled();
  });

  it("an HR staff member without hr.payroll.view gets the restricted note and no reads", async () => {
    as("hr_staff");
    await renderPage();
    expect(screen.getByText(/Compensation is restricted to the HR manager tier/)).toBeInTheDocument();
    expect(compensationSpy).not.toHaveBeenCalled();
  });

  it("with the employee list refused, says so in place of the employee forms instead of offering an empty picker", async () => {
    as("hr_manager");
    employeesRead = { kind: "forbidden" };
    await renderPage();
    expect(screen.getAllByText(/You don't have access to the employee list/).length).toBeGreaterThanOrEqual(1);
    for (const b of ["Set compensation", "Assign an allowance", "Enrol in a benefit plan", "Set a tax profile"]) {
      expect(buttons()).not.toContain(b);
    }
    // The forms that need no employee are still offered.
    expect(buttons()).toEqual(expect.arrayContaining(["Add allowance type", "Add benefit plan"]));
  });

  it("with the allowance types unreadable, does not offer to assign one", async () => {
    as("hr_manager");
    allowancesRead = { kind: "unavailable", reason: "platform 500" };
    await renderPage();
    expect(buttons()).not.toContain("Assign an allowance");
    expect(buttons()).toContain("Enrol in a benefit plan");
  });

  it("shows the pay history from the per-employee read on ?employee=, closed rows with their end date", async () => {
    as("hr_manager");
    historyRead = {
      kind: "ok",
      data: [
        row({ id: "c2", baseAmount: "11000000", effectiveFrom: "2026-07-01", changeReason: "promotion" }),
        row({ id: "c1", effectiveTo: "2026-06-30" }),
      ],
    };
    await renderPage("e1");
    expect(compensationSpy).toHaveBeenCalledWith({ employeeId: "e1" });
    const card = screen.getByText(/Pay history — Budi/).closest("section, div")!.parentElement!;
    expect(within(card).getByText("in force")).toBeInTheDocument();
    expect(within(card).getByText("2026-06-30")).toBeInTheDocument();
    expect(within(card).getByText("Rp 11000000")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Close history" })).toHaveAttribute("href", "/hr/compensation");
  });

  it("a refused history read is said in words, not an empty history", async () => {
    as("hr_manager");
    historyRead = { kind: "forbidden" };
    await renderPage("e1");
    expect(screen.getByText(/You don't have access to this person's pay history/)).toBeInTheDocument();
    expect(screen.queryByText(/holds no compensation record/)).toBeNull();
  });
});
