// DW-10b (BFF §58) — the PURE half of the monthly-targets surface (dept-kpi-batch.ts): the month window, the series shape, the
// shared proposal validation, the batch bodies and the batch decision order. No DB, no clock, no Cerbos. The live half
// (authorization, transactions, sealed months) is dept-kpis-months.controller.db.test.ts.
import { describe, it, expect } from "vitest";
import {
  FieldError,
  MAX_BATCH,
  assembleSeries,
  decisionOrder,
  monthWindow,
  parseBatchItems,
  parseDecideBatchBody,
  parseProposalShape,
  shiftMonth,
  validateBatchItems,
} from "./dept-kpi-batch";
import type { UnitKpis } from "./dept-kpi-targets";

const fieldOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof FieldError) return e.field;
    throw e;
  }
  throw new Error("expected a FieldError");
};

describe("monthWindow (§58.1)", () => {
  const today = "2026-10-16";

  it("a given window lists its months oldest first, with real month ends and the current month partial", () => {
    const w = monthWindow("2026-08", "2026-10", today);
    expect(w).toEqual([
      { month: "2026-08", start: "2026-08-01", end: "2026-08-31", partial: false },
      { month: "2026-09", start: "2026-09-01", end: "2026-09-30", partial: false },
      { month: "2026-10", start: "2026-10-01", end: "2026-10-31", partial: true },
    ]);
  });

  it("without both from and to, it is the 12 months ending with the current month", () => {
    for (const w of [monthWindow(undefined, undefined, today), monthWindow("2026-05", undefined, today), monthWindow(undefined, "2026-05", today)]) {
      expect(w).toHaveLength(12);
      expect(w[0].month).toBe("2025-11");
      expect(w[11]).toMatchObject({ month: "2026-10", partial: true });
      expect(w.slice(0, 11).every((m) => !m.partial)).toBe(true);
    }
  });

  it("12 months is the most: 13 is a 400 on from; February is its own length (leap year)", () => {
    expect(monthWindow("2025-11", "2026-10", today)).toHaveLength(12);
    expect(fieldOf(() => monthWindow("2025-10", "2026-10", today))).toBe("from");
    expect(monthWindow("2024-02", "2024-02", "2026-10-16")[0].end).toBe("2024-02-29");
    expect(monthWindow("2026-02", "2026-02", today)[0].end).toBe("2026-02-28");
  });

  it("from after to is a 400 on from; a future to is a 400 on to; a single month is fine", () => {
    expect(fieldOf(() => monthWindow("2026-09", "2026-08", today))).toBe("from");
    expect(fieldOf(() => monthWindow("2026-09", "2026-11", today))).toBe("to");
    expect(fieldOf(() => monthWindow("2026-11", "2026-11", today))).toBe("to");
    expect(monthWindow("2026-10", "2026-10", today)).toHaveLength(1);
  });

  it("a value that is not a month is a 400 naming it, even when the other is missing", () => {
    expect(fieldOf(() => monthWindow("2026-13", "2026-10", today))).toBe("from");
    expect(fieldOf(() => monthWindow("2026-9", "2026-10", today))).toBe("from");
    expect(fieldOf(() => monthWindow("2026-09-01", "2026-10", today))).toBe("from");
    expect(fieldOf(() => monthWindow("2026-08", "October", today))).toBe("to");
    expect(fieldOf(() => monthWindow(undefined, "nope", today))).toBe("to");
    expect(fieldOf(() => monthWindow(["2026-08", "2026-09"], "2026-10", today))).toBe("from");
  });

  it("the current month moves with today (a year boundary)", () => {
    const w = monthWindow(undefined, undefined, "2027-01-05");
    expect(w[0].month).toBe("2026-02");
    expect(w[11]).toMatchObject({ month: "2027-01", partial: true });
    expect(shiftMonth("2027-01", -11)).toBe("2026-02");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
  });
});

describe("assembleSeries (§58.1)", () => {
  const kpi = (key: string, value: number | null, extra: Record<string, unknown> = {}) => ({
    key, label: key.toUpperCase(), unit: "percent" as const, direction: "up_good" as const, value,
    target: 0.8, tolerance: 0.05, targetSource: "approved" as const, condition: "on_track" as const, ...extra,
  });
  const month = (cond: UnitKpis["condition"], kpis: UnitKpis["kpis"]): UnitKpis => ({ unit: { id: "d-web", name: "Web Dev" }, workspace: "web-dev", condition: cond, kpis });
  const slots = [
    { month: "2026-08", start: "2026-08-01", end: "2026-08-31", partial: false },
    { month: "2026-09", start: "2026-09-01", end: "2026-09-30", partial: true },
  ];

  it("one cell per month under each KPI, in catalogue order; a cell is that month's read and nothing else", () => {
    const view = assembleSeries({ id: "d-web", name: "Web Dev" }, "web-dev", slots, [
      month("unavailable", [kpi("a", null, { condition: "unavailable", reason: "no_data" }), kpi("b", 0.9, { numerator: 9, denominator: 10 })]),
      month("on_track", [kpi("a", 0, { target: 0.9 }), kpi("b", 0.5, { condition: "off_track" })]),
    ]);
    expect(view.unit).toEqual({ id: "d-web", name: "Web Dev" });
    expect(view.workspace).toBe("web-dev");
    expect(view.months).toEqual([
      { ...slots[0], condition: "unavailable" },
      { ...slots[1], condition: "on_track" },
    ]);
    expect(view.kpis.map((k) => [k.key, k.label, k.unit, k.direction])).toEqual([
      ["a", "A", "percent", "up_good"],
      ["b", "B", "percent", "up_good"],
    ]);
    const a = view.kpis[0].cells;
    // a month without data is unavailable with its reason and a null value: never 0, never the other month's number
    expect(a[0]).toEqual({ month: "2026-08", value: null, target: 0.8, tolerance: 0.05, targetSource: "approved", condition: "unavailable", reason: "no_data" });
    // a real 0 stays 0 and carries that month's own target
    expect(a[1]).toEqual({ month: "2026-09", value: 0, target: 0.9, tolerance: 0.05, targetSource: "approved", condition: "on_track" });
    expect(view.kpis[1].cells[0]).toMatchObject({ month: "2026-08", value: 0.9, numerator: 9, denominator: 10 });
    // the KPI's identity is on the row, not repeated in each cell
    expect(Object.keys(a[0])).not.toContain("key");
    expect(Object.keys(a[0])).not.toContain("label");
  });

  it("refuses to invent a cell when a month lacks a KPI", () => {
    expect(() =>
      assembleSeries({ id: "u", name: "U" }, "generic", slots, [month("on_track", [kpi("a", 1)]), month("on_track", [kpi("z", 1)])]),
    ).toThrow(/no read for KPI a/);
  });
});

describe("parseProposalShape (the single propose's checks, shared)", () => {
  const ok = { kpiKey: "projects-on-time", effectiveFrom: "2026-08-01", target: 0.85, tolerance: 0.05 };
  it("accepts a sound proposal and trims the note", () => {
    expect(parseProposalShape({ ...ok, note: "  Q3  " })).toEqual({ ...ok, note: "Q3" });
    expect(parseProposalShape({ ...ok, note: "   " }).note).toBeNull();
    expect(parseProposalShape({ ...ok }).note).toBeNull();
  });
  it("names the first bad field, in the single's order", () => {
    expect(fieldOf(() => parseProposalShape({}))).toBe("kpiKey");
    expect(fieldOf(() => parseProposalShape({ ...ok, effectiveFrom: "2026-08-15" }))).toBe("effectiveFrom");
    expect(fieldOf(() => parseProposalShape({ ...ok, effectiveFrom: "2026-13-01" }))).toBe("effectiveFrom");
    expect(fieldOf(() => parseProposalShape({ ...ok, target: "0.85" }))).toBe("target");
    expect(fieldOf(() => parseProposalShape({ ...ok, target: Number.NaN }))).toBe("target");
    expect(fieldOf(() => parseProposalShape({ ...ok, tolerance: -1 }))).toBe("tolerance");
    expect(fieldOf(() => parseProposalShape({ ...ok, note: "x".repeat(2001) }))).toBe("note");
    expect(fieldOf(() => parseProposalShape({ ...ok, note: 5 }))).toBe("note");
  });
});

describe("batch propose body (§58.2)", () => {
  const item = (over: Record<string, unknown> = {}) => ({ kpiKey: "projects-on-time", effectiveFrom: "2026-08-01", target: 0.85, tolerance: 0.05, ...over });

  it("1 to 36 items: none, a non-list and 37 are a 400 on items; 36 passes", () => {
    expect(fieldOf(() => parseBatchItems(undefined))).toBe("items");
    expect(fieldOf(() => parseBatchItems("x"))).toBe("items");
    expect(fieldOf(() => parseBatchItems([]))).toBe("items");
    expect(fieldOf(() => parseBatchItems(new Array(MAX_BATCH + 1).fill(item())))).toBe("items");
    expect(parseBatchItems(new Array(MAX_BATCH).fill(item()))).toHaveLength(36);
  });

  it("returns every item's fields in order, with the workspace checks when the unit is known", () => {
    const out = validateBatchItems([item(), item({ effectiveFrom: "2026-09-01", target: 0.9, note: "n" })], "web-dev");
    expect(out.map((p) => [p.kpiKey, p.effectiveFrom, p.target, p.note])).toEqual([
      ["projects-on-time", "2026-08-01", 0.85, null],
      ["projects-on-time", "2026-09-01", 0.9, "n"],
    ]);
  });

  it("the first invalid item names its index: items[3].target", () => {
    const items = [item(), item({ effectiveFrom: "2026-09-01" }), item({ effectiveFrom: "2026-10-01" }), item({ effectiveFrom: "2026-11-01", target: "high" }), item({ effectiveFrom: "2026-12-01", tolerance: -1 })];
    expect(fieldOf(() => validateBatchItems(items, "web-dev"))).toBe("items[3].target");
    expect(fieldOf(() => validateBatchItems(items, null))).toBe("items[3].target"); // shape alone already fails it
  });

  it("an item that is not an object names the item itself", () => {
    expect(fieldOf(() => validateBatchItems([item(), null], "web-dev"))).toBe("items[1]");
    expect(fieldOf(() => validateBatchItems([[1]], "web-dev"))).toBe("items[0]");
    expect(fieldOf(() => validateBatchItems(["x"], null))).toBe("items[0]");
  });

  it("a duplicate (kpiKey, effectiveFrom) is a 400 on items[i].effectiveFrom, i being the second one; the same month for another KPI is fine", () => {
    expect(fieldOf(() => validateBatchItems([item(), item({ effectiveFrom: "2026-09-01" }), item()], "web-dev"))).toBe("items[2].effectiveFrom");
    expect(validateBatchItems([item(), item({ kpiKey: "client-site-uptime" })], "web-dev")).toHaveLength(2);
  });

  it("the workspace checks: a KPI outside the unit's set and a percent outside 0..1 name their item; an unknown unit skips them", () => {
    expect(fieldOf(() => validateBatchItems([item(), item({ effectiveFrom: "2026-09-01", kpiKey: "overdue-tasks" })], "web-dev"))).toBe("items[1].kpiKey");
    expect(fieldOf(() => validateBatchItems([item({ target: 85 })], "web-dev"))).toBe("items[0].target");
    expect(fieldOf(() => validateBatchItems([item({ tolerance: 2 })], "web-dev"))).toBe("items[0].target");
    // with no workspace (the unit does not exist) the caller answers 404 after the shape checks, so they do not run
    expect(validateBatchItems([item({ kpiKey: "overdue-tasks", target: 85 })], null)).toHaveLength(1);
  });

  it("the first problem by index wins, whatever its kind", () => {
    // item 0 has a KPI outside the set (a workspace error), item 1 a bad month: index order decides with the unit known
    expect(fieldOf(() => validateBatchItems([item({ kpiKey: "overdue-tasks" }), item({ effectiveFrom: "2026-09-15" })], "web-dev"))).toBe("items[0].kpiKey");
  });
});

describe("batch decide body (§58.3)", () => {
  const ids = ["a", "b"];
  it("accepts approve or reject over 1 to 36 distinct ids, with an optional trimmed note", () => {
    expect(parseDecideBatchBody({ decision: "approve", ids })).toEqual({ decision: "approve", ids, note: null });
    expect(parseDecideBatchBody({ decision: "reject", ids: ["a"], note: " too low " })).toEqual({ decision: "reject", ids: ["a"], note: "too low" });
    expect(parseDecideBatchBody({ decision: "approve", ids: Array.from({ length: 36 }, (_, i) => `id${i}`) }).ids).toHaveLength(36);
  });
  it("names decision, ids or note when they are wrong", () => {
    expect(fieldOf(() => parseDecideBatchBody({ ids }))).toBe("decision");
    expect(fieldOf(() => parseDecideBatchBody({ decision: "decide", ids }))).toBe("decision");
    expect(fieldOf(() => parseDecideBatchBody({ decision: "approve" }))).toBe("ids");
    expect(fieldOf(() => parseDecideBatchBody({ decision: "approve", ids: [] }))).toBe("ids");
    expect(fieldOf(() => parseDecideBatchBody({ decision: "approve", ids: ["a", 7] }))).toBe("ids");
    expect(fieldOf(() => parseDecideBatchBody({ decision: "approve", ids: ["a", ""] }))).toBe("ids");
    expect(fieldOf(() => parseDecideBatchBody({ decision: "approve", ids: ["a", "a"] }))).toBe("ids");
    expect(fieldOf(() => parseDecideBatchBody({ decision: "approve", ids: Array.from({ length: 37 }, (_, i) => `id${i}`) }))).toBe("ids");
    expect(fieldOf(() => parseDecideBatchBody({ decision: "approve", ids, note: 3 }))).toBe("note");
  });
});

describe("decisionOrder (§58.3)", () => {
  const row = (id: string, unitNodeId: string, kpiKey: string, effectiveFrom: string) => ({ id, unitNodeId, kpiKey, effectiveFrom });
  it("orders by unit, KPI, then month ASCENDING (a later month is approved after an earlier one), then id", () => {
    const rows = [
      row("5", "d-web", "uptime", "2026-10-01"),
      row("4", "d-web", "on-time", "2026-10-01"),
      row("3", "d-web", "on-time", "2026-09-01"),
      row("2", "d-seo", "retention", "2026-11-01"),
      row("1", "d-web", "on-time", "2026-09-01"),
    ];
    expect(decisionOrder(rows).map((r) => r.id)).toEqual(["2", "1", "3", "4", "5"]);
    // the input is not touched
    expect(rows[0].id).toBe("5");
  });
});
