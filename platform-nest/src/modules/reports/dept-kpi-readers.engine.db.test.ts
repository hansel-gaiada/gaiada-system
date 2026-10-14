// DW-6n0 (docs/FRONTEND-BFF-CONTRACT.md §40.5.1) — the module-reader seam of the department KPI engine, against live Postgres.
// `evaluateUnits` is called directly (the seam is not an HTTP surface). One catalogue entry (web-dev `requests-within-sla`) is
// given a readerId for the length of each test and a fake reader is registered through `setModuleKpiReadersForTests`.
//   (a) a value gives a condition against the approved target, numerator and denominator passed through;
//   (b) null gives no_data;
//   (c) a throwing reader gives read_failed for ITS KPI only: the department's other KPIs still read and its condition is
//       computed; the log names the reader id and the message and nothing else;
//   (d) the reader receives the right ctx, asOf being the earlier of the range's end and today in REPORTS_TZ;
//   (e) the watch stores a read_failed KPI (the widened CHECK) and tells nobody.
// The org tree is written in the REAL stored shape and the closure is built with the PRODUCTION builder, as the sibling suites do.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { config } from "../../config";
import { newId, withGlobal, withTenants } from "../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { addMembership, createCompany, createUser } from "../../testing/fixtures";
import { syncMetricDefinitions } from "../../rollups/engine";
import { rebuildOrgUnitClosure } from "../../core/org-unit-closure";
import { DEPT_KPI_SETS, type KpiReader } from "./dept-kpis";
import { evaluateUnits } from "./dept-kpi-targets";
import { runDeptKpiWatch } from "./dept-kpi-watch";
import { setModuleKpiReadersForTests } from "./dept-kpi-readers";
import type { ModuleKpiReader, ReaderCtx } from "./dept-kpi-readers/types";
import { todayIsoInTz } from "./person-scope";

const READER_ID = "test.requests-delivered";
const KEY = "requests-within-sla";
const WEB = { id: "d-web", name: "Web Dev", kind: "department" };
const OCT = { periodKind: "month" as const, start: "2026-10-01", end: "2026-10-31" };
const SEP = { periodKind: "month" as const, start: "2026-09-01", end: "2026-09-30" };
const AUG = { periodKind: "month" as const, start: "2026-08-01", end: "2026-08-31" };

describe.skipIf(!TEST_URL)("DW-6n0 the module KPI reader seam (live PG)", () => {
  let co: string;
  const webDef = () => DEPT_KPI_SETS["web-dev"].find((d) => d.key === KEY)!;
  const original: KpiReader = webDef().reader;
  const withReader = (reader: ModuleKpiReader) => {
    // Replace the entry's reader object: the catalogue's shared MODULE constant must never be mutated.
    webDef().reader = { kind: "module", readerId: READER_ID };
    setModuleKpiReadersForTests({ [READER_ID]: reader });
  };
  const kpi = async (range: { periodKind: "month"; start: string; end: string } = OCT) => {
    const [r] = await evaluateUnits(co, "agency", [WEB], [WEB], range);
    return { dept: r, k: r.kpis.find((x) => x.key === KEY)! };
  };

  beforeAll(async () => {
    await initTestDb();
    await syncMetricDefinitions();
    co = await createCompany("DW-6n0 Co", ["reports", "pm", "hr"]);
    await withGlobal((c) => c.query(`UPDATE companies SET vertical = 'agency' WHERE id = $1`, [co]));
    const user = await createUser("proposer@dw6n0.test");
    await addMembership(co, user);

    const root = { id: "d-corp", kind: "company", name: "DW-6n0 Co", children: [{ id: "d-web", kind: "department", name: "Web Dev", children: [] }] };
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO company_org_structure (tenant_id, structure, origin_site) VALUES ($1,$2,$3)
         ON CONFLICT (tenant_id) DO UPDATE SET structure = EXCLUDED.structure`,
        [co, JSON.stringify({ root }), config.originSite],
      ),
    );
    await withTenants([co], (c) => rebuildOrgUnitClosure(c, co, root));

    // An approved target for the entry under test, in force from September 2026: 0.9 +/- 0.05.
    await withTenants(
      [co],
      (c) =>
        c.query(
          `INSERT INTO dept_kpi_targets (id, tenant_id, unit_node_id, kpi_key, effective_from, target, tolerance, status, proposed_by, decided_by, decided_at, origin_site)
           VALUES ($1,$2,'d-web',$3,'2026-09-01',0.9,0.05,'approved',$4,$4,now(),$5)`,
          [newId(), co, KEY, user, config.originSite],
        ),
      { modules: ["reports"] },
    );
  }, 60_000);

  afterEach(() => {
    webDef().reader = original;
    setModuleKpiReadersForTests(null);
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it("with no readerId the KPI is unavailable / no_reader, as before", async () => {
    const { k } = await kpi();
    expect(k).toMatchObject({ value: null, condition: "unavailable", reason: "no_reader" });
  });

  it("(a) a value gives a condition against the approved target, parts passed through", async () => {
    withReader(async () => ({ value: 0.92, numerator: 23, denominator: 25 }));
    expect((await kpi()).k).toMatchObject({ value: 0.92, numerator: 23, denominator: 25, target: 0.9, condition: "on_track" });
    withReader(async () => ({ value: 0.82, numerator: 41, denominator: 50 }));
    expect((await kpi()).k).toMatchObject({ value: 0.82, condition: "off_track" });
    withReader(async () => ({ value: 0.87 }));
    const { k } = await kpi();
    expect(k).toMatchObject({ value: 0.87, condition: "at_risk" });
    expect(k.numerator).toBeUndefined();
  });

  it("(b) null gives no_data, before no_target", async () => {
    withReader(async () => null);
    expect((await kpi()).k).toMatchObject({ value: null, condition: "unavailable", reason: "no_data" });
    // a window before the target's month has no target in force: a value then reads no_target, null still no_data
    withReader(async () => ({ value: 0.9 }));
    expect((await kpi(AUG)).k).toMatchObject({ condition: "unavailable", reason: "no_target" });
    withReader(async () => null);
    expect((await kpi(AUG)).k).toMatchObject({ condition: "unavailable", reason: "no_data" });
  });

  it("(c) a throwing reader fails only its own KPI; the department's other KPIs and condition still read", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    withReader(async () => {
      throw new Error("boom");
    });
    const { dept, k } = await kpi();
    expect(k).toMatchObject({ value: null, condition: "unavailable", reason: "read_failed" });
    const other = (key: string) => dept.kpis.find((x) => x.key === key)!;
    expect(other("client-site-uptime")).toMatchObject({ condition: "unavailable", reason: "no_reader" });
    expect(other("projects-on-time").reason).not.toBe("read_failed"); // still read from the report document
    expect(other("reopened-work-rate").reason).not.toBe("read_failed");
    expect(dept.kpis).toHaveLength(DEPT_KPI_SETS["web-dev"].length);
    expect(["on_track", "at_risk", "off_track", "unavailable"]).toContain(dept.condition);
    // the log carries the reader id and the message only
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls[0])).toContain(READER_ID);
    expect(JSON.stringify(log.mock.calls[0])).toContain("boom");
  });

  it("(c) a readerId with no registered reader reads read_failed, never a crash", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    webDef().reader = { kind: "module", readerId: "test.typo" };
    setModuleKpiReadersForTests({});
    expect((await kpi()).k).toMatchObject({ condition: "unavailable", reason: "read_failed" });
  });

  it("(d) the reader receives the unit, the range and asOf = the earlier of the range's end and today", async () => {
    const seen: ReaderCtx[] = [];
    withReader(async (ctx) => {
      seen.push(ctx);
      return null;
    });
    await kpi(OCT);
    await kpi(SEP);
    const today = todayIsoInTz(config.reportsTz);
    const earlier = (end: string) => (end < today ? end : today);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ tenantId: co, unitId: "d-web", periodKind: "month", start: "2026-10-01", end: "2026-10-31", asOf: earlier("2026-10-31") });
    expect(seen[1]).toEqual({ tenantId: co, unitId: "d-web", periodKind: "month", start: "2026-09-01", end: "2026-09-30", asOf: earlier("2026-09-30") });
  });

  it("(e) the watch stores a read_failed KPI with its reason and tells nobody", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const now = new Date("2026-10-15T12:00:00Z");
    withReader(async () => ({ value: 0.95 }));
    await runDeptKpiWatch(co, now);
    withReader(async () => {
      throw new Error("flaky");
    });
    const result = await runDeptKpiWatch(co, now);
    expect(result.told).toEqual([]);
    const rows = await withTenants(
      [co],
      async (c) =>
        (await c.query<{ condition: string; reason: string | null }>(`SELECT condition, reason FROM dept_kpi_conditions WHERE tenant_id = $1 AND unit_node_id = 'd-web' AND kpi_key = $2`, [co, KEY])).rows,
      { modules: ["reports"] },
    );
    expect(rows).toEqual([{ condition: "unavailable", reason: "read_failed" }]);
  });
});
