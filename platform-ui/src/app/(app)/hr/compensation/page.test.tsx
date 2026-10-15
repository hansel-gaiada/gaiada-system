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
let onFileAllowancesRead: Read;
let onFileBenefitsRead: Read;
let onFileTaxRead: Read;
const allowanceSpy = vi.fn();
const benefitSpy = vi.fn();
const taxSpy = vi.fn();
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
  listEmployeeAllowancesResult: vi.fn(async (_u: string, _t: string, id: string, opts: unknown) => { allowanceSpy(id, opts); return onFileAllowancesRead; }),
  listEmployeeBenefitsResult: vi.fn(async (_u: string, _t: string, id: string, opts: unknown) => { benefitSpy(id, opts); return onFileBenefitsRead; }),
  getEmployeeTaxProfileResult: vi.fn(async (_u: string, _t: string, id: string) => { taxSpy(id); return onFileTaxRead; }),
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
async function renderPage(employee?: string, history?: string) {
  render(await HrCompensationPage({
    searchParams: Promise.resolve({ ...(employee ? { employee } : {}), ...(history ? { history } : {}) }),
  }));
}
const allowance = (over: Record<string, unknown> = {}) => ({
  id: "a1", employeeId: "e1", allowanceTypeId: "t1", allowanceCode: "TRANSPORT", allowanceLabel: "Transport", direction: "allowance",
  amount: "500000.00", percent: null, effectiveFrom: "2026-09-01", effectiveTo: null, note: "Jakarta commute", createdAt: "2026-09-01T00:00:00Z", ...over,
});
const benefit = (over: Record<string, unknown> = {}) => ({
  id: "b1", employeeId: "e1", planId: "p1", planCode: "BPJS-KES", planName: "BPJS Kesehatan", planKind: "statutory",
  memberNumber: "0001234567890", dependants: 2, status: "active", effectiveFrom: "2026-01-01", effectiveTo: null, note: null,
  createdAt: "2026-01-01T00:00:00Z", ...over,
});
const profile = (over: Record<string, unknown> = {}) => ({
  id: "x1", employeeId: "e1", hasNpwp: true, npwp: "09.254.294.3-407.000", ptkpStatus: "K/1", terCategory: "B", taxResident: true,
  effectiveFrom: "2026-03-01", effectiveTo: null, createdAt: "2026-03-01T00:00:00Z", ...over,
});
const buttons = () => screen.queryAllByRole("button").map((b) => b.textContent);
const FORM_BUTTONS = [
  "Set compensation", "Add allowance type", "Add benefit plan", "Assign an allowance", "Enrol in a benefit plan", "Set a tax profile",
];

beforeEach(() => {
  employeesSpy.mockReset();
  compensationSpy.mockReset();
  allowanceSpy.mockReset();
  benefitSpy.mockReset();
  taxSpy.mockReset();
  onFileAllowancesRead = { kind: "ok", data: [allowance()] };
  onFileBenefitsRead = { kind: "ok", data: [benefit()] };
  onFileTaxRead = {
    kind: "ok",
    data: {
      current: profile(),
      history: [profile(), profile({ id: "x0", hasNpwp: false, npwp: null, ptkpStatus: "TK/0", terCategory: "A", effectiveFrom: "2025-01-01", effectiveTo: "2026-02-28" })],
    },
  };
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
    expect(screen.getByRole("note")).toHaveTextContent("listed under their name");
    expect(screen.getByRole("note")).not.toHaveTextContent("cannot list");
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

  // DW-7f-3b: what is on file for the chosen employee.
  describe("on file for the chosen employee", () => {
    const section = (name: string) => screen.getByRole("region", { name });

    it("reads nothing about an employee until one is chosen", async () => {
      as("hr_manager");
      await renderPage();
      expect(allowanceSpy).not.toHaveBeenCalled();
      expect(benefitSpy).not.toHaveBeenCalled();
      expect(taxSpy).not.toHaveBeenCalled();
      expect(screen.queryByText(/^On file/)).toBeNull();
    });

    it("lists the allowances and benefits in force (read with current=true) and the current tax profile", async () => {
      as("hr_manager");
      await renderPage("e1");
      expect(allowanceSpy).toHaveBeenCalledWith("e1", { current: true });
      expect(benefitSpy).toHaveBeenCalledWith("e1", { current: true });
      expect(taxSpy).toHaveBeenCalledWith("e1");
      expect(screen.getByText(/On file — Budi/)).toBeInTheDocument();

      const allowances = section("Allowances and deductions in force");
      expect(within(allowances).getByText("TRANSPORT · Transport")).toBeInTheDocument();
      expect(within(allowances).getByText("Rp 500000.00")).toBeInTheDocument();
      expect(within(allowances).getByText("Jakarta commute")).toBeInTheDocument();
      expect(within(allowances).getByText("no end date")).toBeInTheDocument();

      const benefits = section("Benefit enrolments in force");
      expect(within(benefits).getByText("BPJS-KES · BPJS Kesehatan")).toBeInTheDocument();
      expect(within(benefits).getByText("0001234567890")).toBeInTheDocument();
      expect(within(benefits).getByText("active")).toBeInTheDocument();

      const tax = section("Tax profile");
      expect(within(tax).getByText("09.254.294.3-407.000")).toBeInTheDocument();
      expect(within(tax).getByText("K/1")).toBeInTheDocument();
      expect(within(tax).getByText("B")).toBeInTheDocument();
      // History stays folded away until asked for.
      expect(within(tax).queryByText("TK/0")).toBeNull();
    });

    it("shows a percent allowance as a percent of base and marks a deduction", async () => {
      as("hr_manager");
      onFileAllowancesRead = {
        kind: "ok",
        data: [
          allowance({ amount: null, percent: "2.500", allowanceCode: "MEAL", allowanceLabel: "Meal" }),
          allowance({ id: "a2", allowanceCode: "LOAN", allowanceLabel: "Loan", direction: "deduction" }),
        ],
      };
      await renderPage("e1");
      expect(screen.getByText("2.5% of base")).toBeInTheDocument();
      expect(screen.getByText("LOAN · Loan (deduction)")).toBeInTheDocument();
    });

    it("links Show history per list, keeping the others as they are", async () => {
      as("hr_manager");
      await renderPage("e1");
      expect(screen.getByRole("link", { name: "Show allowance history" })).toHaveAttribute("href", "/hr/compensation?employee=e1&history=allowances");
      expect(screen.getByRole("link", { name: "Show benefit history" })).toHaveAttribute("href", "/hr/compensation?employee=e1&history=benefits");
      expect(screen.getByRole("link", { name: "Show tax profile history" })).toHaveAttribute("href", "/hr/compensation?employee=e1&history=tax");
    });

    it("with history on, the list is read without the in-force filter and closed rows show with their end date", async () => {
      as("hr_manager");
      onFileAllowancesRead = {
        kind: "ok",
        data: [allowance(), allowance({ id: "a0", effectiveFrom: "2026-01-01", effectiveTo: "2026-08-31", amount: "400000.00" })],
      };
      await renderPage("e1", "allowances,tax");
      // Only the listed one drops the in-force filter.
      expect(allowanceSpy).toHaveBeenCalledWith("e1", { current: false });
      expect(benefitSpy).toHaveBeenCalledWith("e1", { current: true });
      const allowances = section("Allowances and deductions, all");
      expect(within(allowances).getByText("2026-08-31")).toBeInTheDocument();
      expect(within(allowances).getByText("Rp 400000.00")).toBeInTheDocument();
      expect(within(allowances).getByRole("link", { name: "Hide allowance history" })).toHaveAttribute("href", "/hr/compensation?employee=e1&history=tax");
      expect(screen.getByRole("link", { name: "Show benefit history" })).toHaveAttribute("href", "/hr/compensation?employee=e1&history=allowances,benefits,tax");
      // The tax history lists the closed profile with its end date.
      const tax = section("Tax profile");
      expect(within(tax).getByText("TK/0")).toBeInTheDocument();
      expect(within(tax).getByText("2026-02-28")).toBeInTheDocument();
      expect(within(tax).getByRole("link", { name: "Hide tax profile history" })).toHaveAttribute("href", "/hr/compensation?employee=e1&history=allowances");
    });

    it("says an empty list only when the server answered an empty list, in words that differ for in force and history", async () => {
      as("hr_manager");
      onFileAllowancesRead = { kind: "ok", data: [] };
      onFileBenefitsRead = { kind: "ok", data: [] };
      onFileTaxRead = { kind: "ok", data: { current: null, history: [] } };
      await renderPage("e1");
      expect(screen.getByText("No allowance is in force for this employee today.")).toBeInTheDocument();
      expect(screen.getByText("No active benefit enrolment is in force for this employee today.")).toBeInTheDocument();
      expect(screen.getByText("No tax profile is on file for this employee.")).toBeInTheDocument();
      cleanup();
      await renderPage("e1", "allowances,benefits,tax");
      expect(screen.getByText("The server holds no allowance for this employee.")).toBeInTheDocument();
      expect(screen.getByText("The server holds no benefit enrolment for this employee.")).toBeInTheDocument();
      expect(screen.getByText("The server holds no tax profile for this employee.")).toBeInTheDocument();
    });

    it("a tax profile that exists but is not in force today is said so, not shown as none", async () => {
      as("hr_manager");
      onFileTaxRead = { kind: "ok", data: { current: null, history: [profile({ effectiveFrom: "2099-01-01" })] } };
      await renderPage("e1");
      expect(screen.getByText(/No tax profile is in force today/)).toBeInTheDocument();
      expect(screen.queryByText("No tax profile is on file for this employee.")).toBeNull();
    });

    it("a profile without an NPWP says none on file", async () => {
      as("hr_manager");
      onFileTaxRead = { kind: "ok", data: { current: profile({ hasNpwp: false, npwp: null }), history: [] } };
      await renderPage("e1");
      expect(within(section("Tax profile")).getByText("none on file")).toBeInTheDocument();
    });

    it("a refused read is a sentence of refusal in its own list, and the other lists still show", async () => {
      as("hr_manager");
      onFileAllowancesRead = { kind: "forbidden" };
      onFileTaxRead = { kind: "forbidden" };
      await renderPage("e1");
      expect(screen.getByText(/You don't have access to this person's allowances/)).toBeInTheDocument();
      expect(screen.getByText(/You don't have access to this person's tax profile/)).toBeInTheDocument();
      expect(screen.queryByText("No allowance is in force for this employee today.")).toBeNull();
      expect(screen.queryByText(/No tax profile is/)).toBeNull();
      expect(screen.queryByText("09.254.294.3-407.000")).toBeNull();
      expect(within(section("Benefit enrolments in force")).getByText("BPJS-KES · BPJS Kesehatan")).toBeInTheDocument();
    });

    it("a failed read says nobody can tell, with the server's words, never an empty list", async () => {
      as("hr_manager");
      onFileBenefitsRead = { kind: "unavailable", reason: "employee not found" };
      onFileAllowancesRead = { kind: "unavailable", reason: "platform 500" };
      await renderPage("e1");
      expect(screen.getByText(/This person's benefit enrolments cannot be read right now/)).toBeInTheDocument();
      expect(screen.getByText("employee not found")).toBeInTheDocument();
      expect(screen.getByText(/This person's allowances cannot be read right now/)).toBeInTheDocument();
      expect(screen.getByText("platform 500")).toBeInTheDocument();
      expect(screen.queryByText("No active benefit enrolment is in force for this employee today.")).toBeNull();
    });

    it("is shown to a view-only payroll reader too (the reads need hr.payroll.view, not manage)", async () => {
      as("hr_manager");
      denied.add("hr.payroll.manage");
      await renderPage("e1");
      expect(within(section("Allowances and deductions in force")).getByText("TRANSPORT · Transport")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Close" })).toHaveAttribute("href", "/hr/compensation");
    });

    it("a reader without hr.payroll.view reads nothing about an employee", async () => {
      as("hr_staff");
      await renderPage("e1");
      expect(allowanceSpy).not.toHaveBeenCalled();
      expect(taxSpy).not.toHaveBeenCalled();
    });
  });
});
