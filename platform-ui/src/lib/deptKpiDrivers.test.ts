import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getKpiDrivers } from "./deptKpiDrivers";
import type { KpiDrivers } from "./deptKpiDriverFormat";

// DW-4j-3 — the honest drivers reader (BFF §43.8a). The four answers a read can give (ok, not yours to read, does not exist, failed) stay four
// different answers, none of them becomes an empty list, and an answer that is not the documented shape is an error. The server is stubbed at
// `fetch`, so the path, the query and the status mapping are the real ones.

const view: KpiDrivers = {
  kpi: { key: "projects-on-time", label: "Projects on time", unit: "percent", direction: "up_good" },
  period: { periodKind: "week", start: "2026-10-05", end: "2026-10-11" },
  drivers: [
    { kind: "project", id: "p-1", name: "Client site redesign", value: 0.6, numerator: 3, denominator: 5 },
    { kind: "project", id: "p-2", name: "Mobile app revamp", value: 4 / 6, numerator: 4, denominator: 6 },
  ],
};
const Q = { unitNodeId: "dept-1", kpiKey: "projects-on-time", periodKind: "week", start: "2026-10-05" };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
let urls: string[];
const answer = (res: () => Response) => {
  urls = [];
  vi.stubGlobal("fetch", vi.fn(async (u: string) => { urls.push(String(u)); return res(); }));
};

let prevDemo: string | undefined;
beforeEach(() => {
  prevDemo = process.env.DEMO_MODE;
  delete process.env.DEMO_MODE;
  process.env.PLATFORM_URL = "http://p.test";
  process.env.PLATFORM_SERVICE_TOKEN = "t";
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (prevDemo === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = prevDemo;
});

describe("getKpiDrivers (GET dept-kpis/drivers)", () => {
  it("returns the drivers from the drivers path, with the four parameters, and end only when given", async () => {
    answer(() => json(200, view));
    expect(await getKpiDrivers("u1", "co-a", Q)).toEqual({ kind: "ok", data: view });
    expect(urls).toEqual(["http://p.test/api/co-a/dept-kpis/drivers?unitNodeId=dept-1&kpiKey=projects-on-time&periodKind=week&start=2026-10-05"]);
    await getKpiDrivers("u1", "co-a", { ...Q, periodKind: "custom", end: "2026-10-20" });
    expect(urls[1]).toBe("http://p.test/api/co-a/dept-kpis/drivers?unitNodeId=dept-1&kpiKey=projects-on-time&periodKind=custom&start=2026-10-05&end=2026-10-20");
  });
  it("encodes the unit id", async () => {
    answer(() => json(200, view));
    await getKpiDrivers("u1", "co-a", { ...Q, unitNodeId: "d/1 &x" });
    const qs = new URL(urls[0]).searchParams;
    expect(qs.get("unitNodeId")).toBe("d/1 &x");
    expect(qs.get("kpiKey")).toBe("projects-on-time");
  });
  it("returns an ok with an empty array when nothing was missed: that is a true answer, not a failure", async () => {
    answer(() => json(200, { ...view, drivers: [] }));
    expect(await getKpiDrivers("u1", "co-a", Q)).toEqual({ kind: "ok", data: { ...view, drivers: [] } });
  });
  it("returns an ok with drivers null and its reason for a KPI that has no breakdown", async () => {
    const none = { ...view, drivers: null, reason: "no_reader" };
    answer(() => json(200, none));
    expect(await getKpiDrivers("u1", "co-a", Q)).toEqual({ kind: "ok", data: none });
  });
  it("says forbidden for a 403 (a unit's staff, another unit's head), never an empty list", async () => {
    answer(() => json(403, { error: "outside your reporting line" }));
    expect(await getKpiDrivers("u1", "co-a", Q)).toEqual({ kind: "forbidden" });
  });
  it("says not_found for the typed unit 404 only", async () => {
    answer(() => json(404, { error: "unit_not_found", field: "unitNodeId" }));
    expect(await getKpiDrivers("u1", "co-a", Q)).toEqual({ kind: "not_found" });
    answer(() => json(404, { error: "unit_not_found" }));
    expect(await getKpiDrivers("u1", "co-a", Q)).toEqual({ kind: "not_found" });
  });
  it("says error for a bare 404 (the reports module is dark), a 400 (a KPI outside the unit's set), a 500 and a network failure", async () => {
    answer(() => json(404, { error: "Not Found" }));
    expect(await getKpiDrivers("u1", "co-a", Q)).toEqual({ kind: "error", reason: "Not Found" });
    answer(() => json(400, { error: "kpiKey is not a KPI of this unit's workspace (web-dev)", field: "kpiKey" }));
    expect(await getKpiDrivers("u1", "co-a", Q)).toEqual({ kind: "error", reason: "kpiKey is not a KPI of this unit's workspace (web-dev)" });
    answer(() => json(500, { error: "boom" }));
    expect(await getKpiDrivers("u1", "co-a", Q)).toEqual({ kind: "error", reason: "boom" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    expect(await getKpiDrivers("u1", "co-a", Q)).toEqual({ kind: "error", reason: "network down" });
  });
  it("says error, never an empty list, for an answer that is not the documented shape", async () => {
    const wrong: unknown[] = [
      [],
      {},
      { ...view, drivers: undefined },
      { ...view, drivers: "none" },
      { ...view, drivers: null }, // null with no reason is not an answer
      { ...view, drivers: [{ kind: "team", id: "t", name: "T", value: 1 }] },
      { ...view, drivers: [{ ...view.drivers![0], value: "60%" }] },
      { ...view, drivers: [{ ...view.drivers![0], id: 7 }] },
      { ...view, drivers: [{ ...view.drivers![0], numerator: "3" }] },
      { ...view, kpi: undefined },
      { ...view, period: { periodKind: "week" } },
    ];
    for (const body of wrong) {
      answer(() => json(200, body));
      expect((await getKpiDrivers("u1", "co-a", Q)).kind).toBe("error");
    }
  });
});
