import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listPayrollRunsResult, getPayrollRunResult, listEmployeesResult, listPayrollInputsResult,
  listRequisitionsResult, listCandidatesResult, listApplicationsResult, listPipelineStagesResult, getFunnelResult, getApplicationResult,
  listCompensationResult, listAllowanceTypesResult, listBenefitPlansResult, listPayGradesResult,
  listEmployeeAllowancesResult, listEmployeeBenefitsResult, getEmployeeTaxProfileResult,
  listReviewCyclesResult, listReviewParticipantsResult, listCalendarsResult, listHolidaysResult, getWorkingDaysResult,
  listLeavePoliciesResult, listPolicyAssignmentsResult, listParameterSetsResult, getParameterSetResult,
} from "./hr-full-data";

// DW-7e: the honest payroll-run list. The route needs the payroll read right, so a 403 is common and must read as a refusal.
const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

beforeEach(() => {
  process.env.PLATFORM_URL = "http://p.test";
  process.env.PLATFORM_SERVICE_TOKEN = "t";
  delete process.env.DEMO_MODE;
});

describe("listPayrollRunsResult", () => {
  it("returns the runs on 200, from the payroll-runs route", async () => {
    const fetchMock = answer(200, [{ id: "r1", status: "calculated" }]);
    vi.stubGlobal("fetch", fetchMock);
    expect(await listPayrollRunsResult("u1", "co-a")).toEqual({ kind: "ok", data: [{ id: "r1", status: "calculated" }] });
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("http://p.test/api/co-a/modules/hr/payroll-runs");
  });

  it("passes a status filter through", async () => {
    const fetchMock = answer(200, []);
    vi.stubGlobal("fetch", fetchMock);
    await listPayrollRunsResult("u1", "co-a", "approved");
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("http://p.test/api/co-a/modules/hr/payroll-runs?status=approved");
  });

  it("is forbidden on 403 and unavailable on 404 or 5xx, never an empty list", async () => {
    vi.stubGlobal("fetch", answer(403, { error: "forbidden" }));
    expect(await listPayrollRunsResult("u1", "co-a")).toEqual({ kind: "forbidden" });
    for (const status of [404, 500, 503]) {
      vi.stubGlobal("fetch", answer(status, { error: "nope" }));
      expect(await listPayrollRunsResult("u1", "co-a")).toMatchObject({ kind: "unavailable" });
    }
  });
});

// DW-7f-1b: one run, and the employees an input can be raised for.
describe("getPayrollRunResult", () => {
  it("returns the run with its payslips from the run route", async () => {
    const fetchMock = answer(200, { id: "r1", payslips: [] });
    vi.stubGlobal("fetch", fetchMock);
    expect(await getPayrollRunResult("u1", "co-a", "r1")).toEqual({ kind: "ok", data: { id: "r1", payslips: [] } });
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("http://p.test/api/co-a/modules/hr/payroll-runs/r1");
  });

  it("a 404 is a real answer (no such run), a 403 is forbidden, anything else is unavailable", async () => {
    vi.stubGlobal("fetch", answer(404, { message: "payroll run not found" }));
    expect(await getPayrollRunResult("u1", "co-a", "r1")).toEqual({ kind: "ok", data: null });
    vi.stubGlobal("fetch", answer(403, { error: "forbidden" }));
    expect(await getPayrollRunResult("u1", "co-a", "r1")).toEqual({ kind: "forbidden" });
    vi.stubGlobal("fetch", answer(500, { message: "boom" }));
    expect((await getPayrollRunResult("u1", "co-a", "r1")).kind).toBe("unavailable");
  });
});

describe("listEmployeesResult", () => {
  it("unwraps the employees and keeps a refusal as a refusal", async () => {
    vi.stubGlobal("fetch", answer(200, { employees: [{ id: "e1" }] }));
    expect(await listEmployeesResult("u1", "co-a")).toEqual({ kind: "ok", data: [{ id: "e1" }] });
    vi.stubGlobal("fetch", answer(403, { error: "forbidden" }));
    expect(await listEmployeesResult("u1", "co-a")).toEqual({ kind: "forbidden" });
  });
});

// DW-7f-1c: the payroll inputs read. A refusal is common (hr_payroll read), so it must read as one.
describe("listPayrollInputsResult", () => {
  it("returns the inputs on 200 from the payroll-inputs route, with no query when no filter is given", async () => {
    const fetchMock = answer(200, [{ id: "i1", label: "Overtime" }]);
    vi.stubGlobal("fetch", fetchMock);
    expect(await listPayrollInputsResult("u1", "co-a")).toEqual({ kind: "ok", data: [{ id: "i1", label: "Overtime" }] });
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("http://p.test/api/co-a/modules/hr/payroll-inputs");
  });

  it("passes the filters through, and consumed=false is sent (not dropped as falsy)", async () => {
    const fetchMock = answer(200, []);
    vi.stubGlobal("fetch", fetchMock);
    await listPayrollInputsResult("u1", "co-a", { runId: "r1" });
    await listPayrollInputsResult("u1", "co-a", { periodStart: "2026-10-01", periodEnd: "2026-10-31", consumed: false });
    await listPayrollInputsResult("u1", "co-a", { employeeId: "e1", consumed: true });
    const urls = fetchMock.mock.calls.map((c) => String((c as unknown[])[0]));
    expect(urls[0]).toBe("http://p.test/api/co-a/modules/hr/payroll-inputs?runId=r1");
    expect(urls[1]).toBe("http://p.test/api/co-a/modules/hr/payroll-inputs?periodStart=2026-10-01&periodEnd=2026-10-31&consumed=false");
    expect(urls[2]).toBe("http://p.test/api/co-a/modules/hr/payroll-inputs?employeeId=e1&consumed=true");
  });

  it("an empty 200 is an ok empty list (the server's own answer)", async () => {
    vi.stubGlobal("fetch", answer(200, []));
    expect(await listPayrollInputsResult("u1", "co-a", { runId: "r1" })).toEqual({ kind: "ok", data: [] });
  });

  it("is forbidden on 403 and unavailable on 404 or 5xx, never an empty list", async () => {
    vi.stubGlobal("fetch", answer(403, { error: "forbidden" }));
    expect(await listPayrollInputsResult("u1", "co-a")).toEqual({ kind: "forbidden" });
    for (const status of [404, 500, 503]) {
      vi.stubGlobal("fetch", answer(status, { error: "nope" }));
      expect(await listPayrollInputsResult("u1", "co-a")).toMatchObject({ kind: "unavailable" });
    }
  });
});

// DW-7f-2: the honest recruitment reads. A refusal is a refusal, never an empty list.
describe("recruitment reads", () => {
  const urlOf = (f: ReturnType<typeof answer>, i = 0) => String((f.mock.calls[i] as unknown[])[0]);

  it("read from the recruitment routes and return the server's rows", async () => {
    const f = answer(200, [{ id: "x" }]);
    vi.stubGlobal("fetch", f);
    expect(await listRequisitionsResult("u1", "co-a")).toEqual({ kind: "ok", data: [{ id: "x" }] });
    await listCandidatesResult("u1", "co-a");
    await listPipelineStagesResult("u1", "co-a");
    await listApplicationsResult("u1", "co-a", { requisitionId: "rq 1", status: "active" });
    await listApplicationsResult("u1", "co-a");
    await getFunnelResult("u1", "co-a", "rq1");
    await getFunnelResult("u1", "co-a");
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => urlOf(f, i))).toEqual([
      "http://p.test/api/co-a/modules/hr/requisitions",
      "http://p.test/api/co-a/modules/hr/candidates",
      "http://p.test/api/co-a/modules/hr/pipeline-stages",
      "http://p.test/api/co-a/modules/hr/applications?requisitionId=rq+1&status=active",
      "http://p.test/api/co-a/modules/hr/applications",
      "http://p.test/api/co-a/modules/hr/recruitment/funnel?requisitionId=rq1",
      "http://p.test/api/co-a/modules/hr/recruitment/funnel",
    ]);
  });

  it("an empty 200 is the server's own answer; 403 is forbidden; 404 and 5xx are unavailable", async () => {
    vi.stubGlobal("fetch", answer(200, []));
    expect(await listRequisitionsResult("u1", "co-a")).toEqual({ kind: "ok", data: [] });
    vi.stubGlobal("fetch", answer(403, { error: "forbidden" }));
    for (const read of [listRequisitionsResult, listCandidatesResult, listApplicationsResult, listPipelineStagesResult, getFunnelResult]) {
      expect(await read("u1", "co-a")).toEqual({ kind: "forbidden" });
    }
    for (const status of [404, 500, 503]) {
      vi.stubGlobal("fetch", answer(status, { error: "nope" }));
      expect(await listRequisitionsResult("u1", "co-a")).toMatchObject({ kind: "unavailable", reason: "nope" });
    }
  });

  it("getApplicationResult: a 404 is a real answer (null), 403 forbidden, anything else unavailable", async () => {
    const f = answer(200, { id: "ap1", interviews: [] });
    vi.stubGlobal("fetch", f);
    expect(await getApplicationResult("u1", "co-a", "ap1")).toEqual({ kind: "ok", data: { id: "ap1", interviews: [] } });
    expect(urlOf(f)).toBe("http://p.test/api/co-a/modules/hr/applications/ap1");
    vi.stubGlobal("fetch", answer(404, { error: "application not found" }));
    expect(await getApplicationResult("u1", "co-a", "ap1")).toEqual({ kind: "ok", data: null });
    vi.stubGlobal("fetch", answer(403, { error: "forbidden" }));
    expect(await getApplicationResult("u1", "co-a", "ap1")).toEqual({ kind: "forbidden" });
    vi.stubGlobal("fetch", answer(500, { error: "boom" }));
    expect(await getApplicationResult("u1", "co-a", "ap1")).toMatchObject({ kind: "unavailable" });
  });
});

// DW-7f-3: the honest compensation reads.
describe("compensation reads", () => {
  const url = (m: ReturnType<typeof answer>) => String((m.mock.calls[0] as unknown[])[0]);

  it("read from the compensation routes and return the server's rows", async () => {
    const reads: [() => Promise<unknown>, string][] = [
      [() => listCompensationResult("u1", "co-a"), "http://p.test/api/co-a/modules/hr/compensation"],
      [() => listAllowanceTypesResult("u1", "co-a"), "http://p.test/api/co-a/modules/hr/allowance-types"],
      [() => listBenefitPlansResult("u1", "co-a"), "http://p.test/api/co-a/modules/hr/benefit-plans"],
      [() => listPayGradesResult("u1", "co-a"), "http://p.test/api/co-a/modules/hr/pay-grades"],
    ];
    for (const [read, expected] of reads) {
      const fetchMock = answer(200, [{ id: "x1" }]);
      vi.stubGlobal("fetch", fetchMock);
      expect(await read()).toEqual({ kind: "ok", data: [{ id: "x1" }] });
      expect(url(fetchMock)).toBe(expected);
    }
  });

  it("passes the compensation filters through (current, employeeId)", async () => {
    let fetchMock = answer(200, []);
    vi.stubGlobal("fetch", fetchMock);
    await listCompensationResult("u1", "co-a", { current: true });
    expect(url(fetchMock)).toBe("http://p.test/api/co-a/modules/hr/compensation?current=true");
    fetchMock = answer(200, []);
    vi.stubGlobal("fetch", fetchMock);
    await listCompensationResult("u1", "co-a", { employeeId: "e 1" });
    expect(url(fetchMock)).toBe("http://p.test/api/co-a/modules/hr/compensation?employeeId=e+1");
  });

  it("an empty 200 is the server's own answer; 403 is forbidden; 404 and 5xx are unavailable, never an empty list", async () => {
    const readers = [
      () => listCompensationResult("u1", "co-a"), () => listAllowanceTypesResult("u1", "co-a"),
      () => listBenefitPlansResult("u1", "co-a"), () => listPayGradesResult("u1", "co-a"),
    ];
    for (const read of readers) {
      vi.stubGlobal("fetch", answer(200, []));
      expect(await read()).toEqual({ kind: "ok", data: [] });
      vi.stubGlobal("fetch", answer(403, { error: "forbidden" }));
      expect(await read()).toEqual({ kind: "forbidden" });
      for (const status of [404, 500]) {
        vi.stubGlobal("fetch", answer(status, { error: "nope" }));
        expect(await read()).toMatchObject({ kind: "unavailable" });
      }
    }
  });
});

// DW-7f-3b (BFF §51): what is on file for one employee. hr_payroll read; a refusal must read as one, and a 404 (the employee is
// not in this company) or a 5xx is `unavailable` with the server's words, never an empty list.
describe("employee allowance, benefit and tax-profile readers (DW-7f-3b)", () => {
  const url = (m: ReturnType<typeof answer>) => String((m.mock.calls[0] as unknown[])[0]);
  const base = "http://p.test/api/co-a/modules/hr/employees";
  const taxBody = { current: null, history: [] };

  it("read from the per-employee routes, with the id encoded", async () => {
    const reads: [() => Promise<unknown>, string, unknown][] = [
      [() => listEmployeeAllowancesResult("u1", "co-a", "e1"), `${base}/e1/allowances`, [{ id: "a1" }]],
      [() => listEmployeeBenefitsResult("u1", "co-a", "e1"), `${base}/e1/benefits`, [{ id: "b1" }]],
      [() => getEmployeeTaxProfileResult("u1", "co-a", "e1"), `${base}/e1/tax-profile`, taxBody],
      [() => listEmployeeAllowancesResult("u1", "co-a", "e 1/x"), `${base}/e%201%2Fx/allowances`, []],
    ];
    for (const [read, expected, body] of reads) {
      const fetchMock = answer(200, body);
      vi.stubGlobal("fetch", fetchMock);
      expect(await read()).toEqual({ kind: "ok", data: body });
      expect(url(fetchMock)).toBe(expected);
    }
  });

  it("asks for what is in force only when told to (current=true), and leaves the flag off otherwise", async () => {
    let fetchMock = answer(200, []);
    vi.stubGlobal("fetch", fetchMock);
    await listEmployeeAllowancesResult("u1", "co-a", "e1", { current: true });
    expect(url(fetchMock)).toBe(`${base}/e1/allowances?current=true`);
    fetchMock = answer(200, []);
    vi.stubGlobal("fetch", fetchMock);
    await listEmployeeBenefitsResult("u1", "co-a", "e1", { current: true });
    expect(url(fetchMock)).toBe(`${base}/e1/benefits?current=true`);
    fetchMock = answer(200, []);
    vi.stubGlobal("fetch", fetchMock);
    await listEmployeeBenefitsResult("u1", "co-a", "e1", { current: false });
    expect(url(fetchMock)).toBe(`${base}/e1/benefits`);
  });

  it("an empty 200 is the server's own answer; 403 is forbidden; 404 and 5xx are unavailable and carry the server's words", async () => {
    const readers: [() => Promise<unknown>, unknown][] = [
      [() => listEmployeeAllowancesResult("u1", "co-a", "e1"), []],
      [() => listEmployeeBenefitsResult("u1", "co-a", "e1"), []],
      [() => getEmployeeTaxProfileResult("u1", "co-a", "e1"), taxBody],
    ];
    for (const [read, empty] of readers) {
      vi.stubGlobal("fetch", answer(200, empty));
      expect(await read()).toEqual({ kind: "ok", data: empty });
      vi.stubGlobal("fetch", answer(403, { error: "forbidden" }));
      expect(await read()).toEqual({ kind: "forbidden" });
      for (const status of [404, 500, 503]) {
        vi.stubGlobal("fetch", answer(status, { message: "employee not found" }));
        expect(await read()).toMatchObject({ kind: "unavailable", reason: expect.any(String) });
      }
    }
  });
});

// DW-7f-4 / DW-7f-5: the honest policy reads. Each goes to its hr_policy route; 200 is the data, 403 is `forbidden`, and a 404 or 5xx
// is `unavailable` (never an empty list); only the single parameter set reads a 404 as "no such set".
describe("policy readers (DW-7f-4, DW-7f-5)", () => {
  const url = (m: ReturnType<typeof answer>) => String((m.mock.calls[0] as unknown[])[0]);
  const base = "http://p.test/api/co-a/modules/hr";
  const lists: [string, () => Promise<unknown>, string][] = [
    ["listReviewCyclesResult", () => listReviewCyclesResult("u1", "co-a"), `${base}/review-cycles`],
    ["listReviewParticipantsResult", () => listReviewParticipantsResult("u1", "co-a", "c1"), `${base}/review-cycles/c1/participants`],
    ["listCalendarsResult", () => listCalendarsResult("u1", "co-a"), `${base}/calendars`],
    ["listHolidaysResult", () => listHolidaysResult("u1", "co-a", "cal1"), `${base}/calendars/cal1/holidays`],
    ["listLeavePoliciesResult", () => listLeavePoliciesResult("u1", "co-a"), `${base}/leave-policies`],
    ["listPolicyAssignmentsResult", () => listPolicyAssignmentsResult("u1", "co-a", "p1"), `${base}/leave-policies/p1/assignments`],
    ["listParameterSetsResult", () => listParameterSetsResult("u1", "co-a"), `${base}/statutory-parameters`],
    ["getWorkingDaysResult", () => getWorkingDaysResult("u1", "co-a", "2026-01-01", "2026-01-31"), `${base}/working-days?from=2026-01-01&to=2026-01-31`],
  ];

  for (const [name, read, path] of lists) {
    it(`${name}: 200 is the data from ${path.replace(base, "")}, 403 is forbidden, 404 and 5xx are unavailable`, async () => {
      const fetchMock = answer(200, [{ id: "x" }]);
      vi.stubGlobal("fetch", fetchMock);
      expect(await read()).toEqual({ kind: "ok", data: [{ id: "x" }] });
      expect(url(fetchMock)).toBe(path);
      vi.stubGlobal("fetch", answer(403, { error: "forbidden" }));
      expect(await read()).toEqual({ kind: "forbidden" });
      for (const status of [404, 500, 503]) {
        vi.stubGlobal("fetch", answer(status, { error: "nope" }));
        expect(await read()).toMatchObject({ kind: "unavailable", reason: "nope" });
      }
    });
  }

  it("passes the status filter, the holiday year and the working-days calendar through", async () => {
    let fetchMock = answer(200, []);
    vi.stubGlobal("fetch", fetchMock);
    await listReviewCyclesResult("u1", "co-a", "open");
    expect(url(fetchMock)).toBe(`${base}/review-cycles?status=open`);
    fetchMock = answer(200, []);
    vi.stubGlobal("fetch", fetchMock);
    await listHolidaysResult("u1", "co-a", "cal1", 2026);
    expect(url(fetchMock)).toBe(`${base}/calendars/cal1/holidays?year=2026`);
    fetchMock = answer(200, {});
    vi.stubGlobal("fetch", fetchMock);
    await getWorkingDaysResult("u1", "co-a", "2026-01-01", "2026-01-31", "cal1");
    expect(url(fetchMock)).toBe(`${base}/working-days?from=2026-01-01&to=2026-01-31&calendarId=cal1`);
  });

  it("getWorkingDaysResult carries the server's words for a bad range", async () => {
    vi.stubGlobal("fetch", answer(400, { error: "to must be >= from" }));
    expect(await getWorkingDaysResult("u1", "co-a", "2026-02-01", "2026-01-01")).toEqual({ kind: "unavailable", reason: "to must be >= from" });
  });

  it("getParameterSetResult reads a 404 as no such set, a 403 as forbidden and a 5xx as unavailable", async () => {
    const fetchMock = answer(200, { id: "s1", parameters: [] });
    vi.stubGlobal("fetch", fetchMock);
    expect(await getParameterSetResult("u1", "co-a", "s1")).toEqual({ kind: "ok", data: { id: "s1", parameters: [] } });
    expect(url(fetchMock)).toBe(`${base}/statutory-parameters/s1`);
    vi.stubGlobal("fetch", answer(404, { error: "parameter set not found" }));
    expect(await getParameterSetResult("u1", "co-a", "s1")).toEqual({ kind: "ok", data: null });
    vi.stubGlobal("fetch", answer(403, { error: "forbidden" }));
    expect(await getParameterSetResult("u1", "co-a", "s1")).toEqual({ kind: "forbidden" });
    vi.stubGlobal("fetch", answer(500, { error: "boom" }));
    expect(await getParameterSetResult("u1", "co-a", "s1")).toMatchObject({ kind: "unavailable" });
  });
});
