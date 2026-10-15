import { describe, it, expect, vi, beforeEach } from "vitest";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { platformFetch, PlatformError } from "./platform";
import {
  setCompensation, saveAllowanceType, assignAllowance, saveBenefitPlan, enrolBenefit, setTaxProfile,
} from "./hrCompensationActions";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./session-server", () => ({ getSessionUserId: vi.fn() }));
vi.mock("./tenant", () => ({ getActiveTenant: vi.fn(async () => "co-active") }));
vi.mock("./platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./platform")>()),
  platformFetch: vi.fn(),
  getMe: vi.fn(async () => ({ userId: "u-1", roles: [], companies: [] })),
}));

// DW-7f-3 — the compensation write actions. Backend: platform-nest payroll.controller.ts (Cerbos kind hr_payroll,
// action create). The routes 400 on a missing field, 404 on an unknown employee or grade, 409 on an overlapping
// allowance or enrolment; the tests carry the server's sentence on each status.

beforeEach(() => {
  vi.mocked(revalidatePath).mockReset();
  vi.mocked(platformFetch).mockReset();
  vi.mocked(getSessionUserId).mockReset();
  vi.mocked(getSessionUserId).mockResolvedValue("u-1");
});

function form(over: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(over)) f.set(k, v);
  return f;
}
const lastCall = () => {
  const [path, user, init] = vi.mocked(platformFetch).mock.calls[0];
  const req = init as RequestInit;
  return { path, user, init: req, body: req.body ? JSON.parse(String(req.body)) : undefined };
};
const revalidated = () => vi.mocked(revalidatePath).mock.calls.map((c) => c[0]);

const comp = (over: Record<string, string> = {}) => form({
  employeeId: "e1", baseAmount: "12500000.50", currency: "idr", rateBasis: "monthly", payFrequency: "monthly",
  fte: "0.5", effectiveFrom: "2026-11-01", changeReason: "promotion", gradeId: "g1", note: "  Promoted  ", ...over,
});

describe("setCompensation", () => {
  it("posts to compensation with a decimal amount, upper-cased currency and only what was filled, then revalidates", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "c-1", effectiveFrom: "2026-11-01", supersededRows: 1, employeeName: "Budi" });
    const r = await setCompensation("co-a", comp());
    expect(r.ok).toBe(true);
    expect(r.id).toBe("c-1");
    // The notice comes from the server's reply (name, date, closed rows), not from the form.
    expect(r.notice).toBe("Compensation recorded for Budi from 2026-11-01. The record in force was closed the day before (1 row).");
    const c = lastCall();
    expect(c.path).toBe("/api/co-a/modules/hr/compensation");
    expect(c.init.method).toBe("POST");
    expect(c.body).toEqual({
      employeeId: "e1", baseAmount: 12500000.5, currency: "IDR", rateBasis: "monthly", payFrequency: "monthly",
      changeReason: "promotion", effectiveFrom: "2026-11-01", fte: 0.5, gradeId: "g1", note: "Promoted",
    });
    expect(revalidated()).toEqual(["/hr/compensation"]);
  });

  it("omits blank fte, grade and note, and says so when there was no earlier record to close", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "c-1", effectiveFrom: "2026-11-01", supersededRows: 0, employeeName: "Sari" });
    const r = await setCompensation("co-a", comp({ fte: "", gradeId: "", note: "" }));
    expect(r.notice).toContain("There was no earlier record in force to close.");
    expect(lastCall().body).not.toHaveProperty("fte");
    expect(lastCall().body).not.toHaveProperty("gradeId");
    expect(lastCall().body).not.toHaveProperty("note");
  });

  it("falls back to monthly, IDR and reason other for blank fields, and to the active company", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "c-1" });
    await setCompensation("", comp({ currency: "", rateBasis: "", payFrequency: "", changeReason: "" }));
    expect(lastCall().path).toBe("/api/co-active/modules/hr/compensation");
    expect(lastCall().body).toMatchObject({ currency: "IDR", rateBasis: "monthly", payFrequency: "monthly", changeReason: "other" });
  });

  it("refuses bad input without calling the server, including values the server would silently swap", async () => {
    for (const over of <Record<string, string>[]>[
      { employeeId: "" }, { baseAmount: "" }, { baseAmount: "-1" }, { baseAmount: "abc" }, { currency: "RUPIAH" },
      { rateBasis: "yearly" }, { payFrequency: "daily" }, { changeReason: "bonus" },
      { fte: "0" }, { fte: "2.5" }, { fte: "0.5555" }, { effectiveFrom: "" }, { effectiveFrom: "01/11/2026" },
    ]) {
      expect((await setCompensation("co-a", comp(over))).ok).toBe(false);
    }
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("words a 403 and passes the server's 400 and 404 sentences back as sent, revalidating nothing", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect(await setCompensation("co-a", comp())).toEqual({ ok: false, error: "You don't have permission to set compensation." });
    const band = "15000000 is outside grade G3's band (8000000–12000000)";
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(400, band));
    expect(await setCompensation("co-a", comp())).toEqual({ ok: false, error: band });
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(404, "employee not found"));
    expect((await setCompensation("co-a", comp())).error).toBe("employee not found");
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("falls back to the raw body's message when the error text is the generic one", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(400, "platform 400", undefined, undefined, undefined, { message: ["baseAmount >= 0 required"] }));
    expect((await setCompensation("co-a", comp())).error).toBe("baseAmount >= 0 required");
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(500, "platform 500"));
    expect((await setCompensation("co-a", comp())).error).toBe("platform 500");
  });

  it("does nothing without a session", async () => {
    vi.mocked(getSessionUserId).mockResolvedValue(null as unknown as string);
    expect((await setCompensation("co-a", comp())).ok).toBe(false);
    expect(platformFetch).not.toHaveBeenCalled();
  });
});

describe("saveAllowanceType", () => {
  const type = (over: Record<string, string> = {}) => form({
    code: "TRANSPORT", label: "Transport", direction: "allowance", calcKind: "fixed", defaultAmount: "500000.5",
    taxable: "on", prorated: "on", ...over,
  });

  it("posts to allowance-types with explicit booleans and says saved, not created", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "t-1", code: "TRANSPORT" });
    const r = await saveAllowanceType("co-a", type());
    expect(r.ok).toBe(true);
    expect(r.notice).toContain("Allowance type TRANSPORT saved");
    expect(r.notice).toContain("updated in place");
    const c = lastCall();
    expect(c.path).toBe("/api/co-a/modules/hr/allowance-types");
    expect(c.body).toEqual({
      code: "TRANSPORT", label: "Transport", direction: "allowance", calcKind: "fixed", defaultAmount: 500000.5,
      taxable: true, bpjsBase: false, prorated: true,
    });
    expect(revalidated()).toEqual(["/hr/compensation"]);
  });

  it("sends an unticked box as false (the server would otherwise default taxable and prorated to true)", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "t-1", code: "X" });
    await saveAllowanceType("co-a", form({ code: "X", label: "X" }));
    expect(lastCall().body).toMatchObject({ taxable: false, bpjsBase: false, prorated: false });
  });

  it("refuses bad input without calling the server", async () => {
    for (const over of <Record<string, string>[]>[
      { code: "" }, { label: " " }, { direction: "bonus" }, { calcKind: "magic" },
      { defaultAmount: "-5" }, { defaultPercent: "101" }, { defaultPercent: "-1" },
    ]) {
      expect((await saveAllowanceType("co-a", type(over))).ok).toBe(false);
    }
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("words a 403 and passes the server's 400 through", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect((await saveAllowanceType("co-a", type())).error).toBe("You don't have permission to save allowance types.");
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(400, "code and label required"));
    expect((await saveAllowanceType("co-a", type())).error).toBe("code and label required");
  });
});

describe("assignAllowance", () => {
  const assign = (over: Record<string, string> = {}) => form({
    employeeId: "e 1", allowanceTypeId: "t1", amount: "250000.75", effectiveFrom: "2026-11-01", effectiveTo: "2027-10-31", note: "Housing", ...over,
  });

  it("posts to the employee's allowances route, encodes the id, and sends decimals", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "a-1" });
    const r = await assignAllowance("co-a", assign());
    expect(r).toMatchObject({ ok: true, id: "a-1" });
    const c = lastCall();
    expect(c.path).toBe("/api/co-a/modules/hr/employees/e%201/allowances");
    expect(c.body).toEqual({ allowanceTypeId: "t1", effectiveFrom: "2026-11-01", effectiveTo: "2027-10-31", amount: 250000.75, note: "Housing" });
    expect(revalidated()).toEqual(["/hr/compensation"]);
  });

  it("lets amount and percent be blank (the type's default applies) and an open end", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "a-1" });
    await assignAllowance("co-a", assign({ amount: "", effectiveTo: "", note: "" }));
    expect(lastCall().body).toEqual({ allowanceTypeId: "t1", effectiveFrom: "2026-11-01" });
  });

  it("refuses bad input without calling the server", async () => {
    for (const over of <Record<string, string>[]>[
      { employeeId: "" }, { allowanceTypeId: "" }, { effectiveFrom: "" }, { effectiveTo: "31/10/2027" },
      { effectiveTo: "2026-10-31" }, { amount: "-1" }, { percent: "150" },
    ]) {
      expect((await assignAllowance("co-a", assign(over))).ok).toBe(false);
    }
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("words a 403 and passes the server's 409 overlap sentence through, revalidating nothing", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect((await assignAllowance("co-a", assign())).error).toBe("You don't have permission to assign allowances.");
    const overlap = "this employee already holds that allowance over an overlapping period — close the existing one first";
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(409, overlap));
    expect(await assignAllowance("co-a", assign())).toEqual({ ok: false, error: overlap });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("saveBenefitPlan", () => {
  const plan = (over: Record<string, string> = {}) => form({
    code: "BPJS-KES", name: "BPJS Kesehatan", kind: "statutory", statutoryCode: "bpjs_kesehatan", currency: "idr",
    employerRate: "4", employeeRate: "1", wageCap: "12000000", ...over,
  });

  it("posts to benefit-plans and sends the rates as the fractions the server stores", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "p-1", code: "BPJS-KES" });
    const r = await saveBenefitPlan("co-a", plan());
    expect(r.ok).toBe(true);
    expect(r.notice).toContain("Benefit plan BPJS-KES saved");
    const c = lastCall();
    expect(c.path).toBe("/api/co-a/modules/hr/benefit-plans");
    expect(c.body).toEqual({
      code: "BPJS-KES", name: "BPJS Kesehatan", kind: "statutory", currency: "IDR", statutoryCode: "bpjs_kesehatan",
      employerRate: 0.04, employeeRate: 0.01, wageCap: 12000000,
    });
    expect(revalidated()).toEqual(["/hr/compensation"]);
  });

  it("converts awkward percentages without float noise", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "p-1" });
    await saveBenefitPlan("co-a", plan({ employerRate: "5.7", employeeRate: "0.24" }));
    expect(lastCall().body).toMatchObject({ employerRate: 0.057, employeeRate: 0.0024 });
  });

  it("refuses bad input without calling the server, including a rate the database would round", async () => {
    for (const over of <Record<string, string>[]>[
      { code: "" }, { name: "" }, { kind: "gift" }, { statutoryCode: "bpjs_x" }, { currency: "RP" },
      { employerRate: "101" }, { employerRate: "-1" }, { employerRate: "4.123" }, { employeeRate: "abc" },
      { wageCap: "-1" }, { wageFloor: "13000000" },
    ]) {
      expect((await saveBenefitPlan("co-a", plan(over))).ok).toBe(false);
    }
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("words a 403 and passes the server's 400 through", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect((await saveBenefitPlan("co-a", plan())).error).toBe("You don't have permission to save benefit plans.");
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(400, "code and name required"));
    expect((await saveBenefitPlan("co-a", plan())).error).toBe("code and name required");
  });
});

describe("enrolBenefit", () => {
  const enrol = (over: Record<string, string> = {}) => form({
    employeeId: "e1", planId: "p1", memberNumber: " 0001234 ", dependants: "2", effectiveFrom: "2026-11-01", effectiveTo: "", ...over,
  });

  it("posts to the employee's benefits route", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "b-1" });
    const r = await enrolBenefit("co-a", enrol());
    expect(r).toMatchObject({ ok: true, id: "b-1", notice: "Employee enrolled." });
    const c = lastCall();
    expect(c.path).toBe("/api/co-a/modules/hr/employees/e1/benefits");
    expect(c.body).toEqual({ planId: "p1", effectiveFrom: "2026-11-01", memberNumber: "0001234", dependants: 2 });
    expect(revalidated()).toEqual(["/hr/compensation"]);
  });

  it("refuses bad input without calling the server", async () => {
    for (const over of <Record<string, string>[]>[
      { employeeId: "" }, { planId: "" }, { effectiveFrom: "" }, { effectiveTo: "2026-10-01" }, { dependants: "-1" }, { dependants: "1.5" },
    ]) {
      expect((await enrolBenefit("co-a", enrol(over))).ok).toBe(false);
    }
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("words a 403 and passes the server's 409 through", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect((await enrolBenefit("co-a", enrol())).error).toBe("You don't have permission to enrol employees in benefit plans.");
    const overlap = "this employee is already enrolled in that plan over an overlapping period";
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(409, overlap));
    expect((await enrolBenefit("co-a", enrol())).error).toBe(overlap);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("setTaxProfile", () => {
  const tax = (over: Record<string, string> = {}) => form({
    employeeId: "e1", ptkpStatus: "K/1", npwp: " 12.345.678.9-012.000 ", effectiveFrom: "2026-11-01", taxResident: "on", ...over,
  });

  it("posts to the employee's tax-profile route and leaves the TER category to the server when none is chosen", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "x-1" });
    const r = await setTaxProfile("co-a", tax());
    expect(r.ok).toBe(true);
    expect(r.notice).toContain("An NPWP was recorded.");
    const c = lastCall();
    expect(c.path).toBe("/api/co-a/modules/hr/employees/e1/tax-profile");
    expect(c.body).toEqual({ ptkpStatus: "K/1", effectiveFrom: "2026-11-01", taxResident: true, npwp: "12.345.678.9-012.000" });
    expect(c.body).not.toHaveProperty("terCategory");
    expect(revalidated()).toEqual(["/hr/compensation"]);
  });

  it("sends a chosen TER category, an unticked resident box as false, and says when there is no NPWP", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "x-1" });
    const r = await setTaxProfile("co-a", tax({ terCategory: "B", npwp: "", taxResident: "" }));
    expect(lastCall().body).toEqual({ ptkpStatus: "K/1", effectiveFrom: "2026-11-01", taxResident: false, terCategory: "B" });
    expect(r.notice).toContain("No NPWP was recorded");
  });

  it("defaults the PTKP status to TK/0 like the server", async () => {
    vi.mocked(platformFetch).mockResolvedValue({ id: "x-1" });
    await setTaxProfile("co-a", tax({ ptkpStatus: "" }));
    expect(lastCall().body).toMatchObject({ ptkpStatus: "TK/0" });
  });

  it("refuses bad input without calling the server", async () => {
    for (const over of <Record<string, string>[]>[
      { employeeId: "" }, { ptkpStatus: "K/9" }, { terCategory: "D" }, { effectiveFrom: "" }, { effectiveFrom: "2026/11/01" },
    ]) {
      expect((await setTaxProfile("co-a", tax(over))).ok).toBe(false);
    }
    expect(platformFetch).not.toHaveBeenCalled();
  });

  it("words a 403 and passes the server's 400 through", async () => {
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(403, "forbidden"));
    expect((await setTaxProfile("co-a", tax())).error).toBe("You don't have permission to set tax profiles.");
    vi.mocked(platformFetch).mockRejectedValueOnce(new PlatformError(400, "effectiveFrom must be an ISO date (YYYY-MM-DD)"));
    expect((await setTaxProfile("co-a", tax())).error).toBe("effectiveFrom must be an ISO date (YYYY-MM-DD)");
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
