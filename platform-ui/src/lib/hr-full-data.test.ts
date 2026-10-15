import { describe, it, expect, vi, beforeEach } from "vitest";
import { listPayrollRunsResult } from "./hr-full-data";

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
