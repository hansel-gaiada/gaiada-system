// DW-10f-2a / 10f-3a — the pure halves of the schedule and the draft-from-schedule body (no database). The HTTP suites
// (contract-schedule.http.test.ts, modules/invoice/contract-billing.http.test.ts) drive the same code through the routes
// against real Postgres and Cerbos; these pin the validation rules exactly, including the cases a route test would
// only sample.
import { describe, it, expect } from "vitest";
import type { HttpException } from "@nestjs/common";
import { canonicalAmount, decimalsOf, isIsoDate, parseScheduleBody, precisionOk } from "./contract-schedule";
import { parseDraftFromSchedule, sourceOf } from "../modules/invoice/contract-billing";

const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    const r = (e as HttpException).getResponse() as { message?: string };
    return `${(e as HttpException).getStatus()} ${r.message}`;
  }
};
const row = (due: string, amount: unknown = 100, label = "Row") => ({ label, amount, due });

describe("DW-10f-2a · the schedule body (BFF §61.4)", () => {
  it("accepts 0 to 60 rows for PUT; the addition needs at least one", () => {
    expect(parseScheduleBody({ instalments: [] }, { requireOne: false })).toEqual([]);
    expect(codeOf(() => parseScheduleBody({ instalments: [] }, { requireOne: true }))).toBe("400 schedule_invalid");
    const sixty = Array.from({ length: 60 }, (_, i) => row(`2027-01-${String((i % 28) + 1).padStart(2, "0")}`));
    sixty.sort((a, b) => (a.due < b.due ? -1 : 1));
    expect(parseScheduleBody({ instalments: sixty }, { requireOne: false })).toHaveLength(60);
    expect(codeOf(() => parseScheduleBody({ instalments: [...sixty, row("2027-12-31")] }, { requireOne: false }))).toBe("400 schedule_invalid");
  });

  it("schedule_invalid: not an array, a bad label, a bad amount, a bad due", () => {
    for (const body of [
      {}, null, { instalments: "x" }, { instalments: [null] }, { instalments: [[]] },
      { instalments: [{ ...row("on_signing"), label: "   " }] },
      { instalments: [{ ...row("on_signing"), label: "x".repeat(121) }] },
      { instalments: [{ ...row("on_signing"), label: 7 }] },
      { instalments: [row("on_signing", 0)] },
      { instalments: [row("on_signing", -5)] },
      { instalments: [row("on_signing", "1e3")] },
      { instalments: [row("on_signing", "abc")] },
      { instalments: [row("on_signing", Number.NaN)] },
      { instalments: [row("on_signing", "12345678901234567")] }, // 17 integer digits: past numeric(20,4)
      { instalments: [row("tomorrow")] },
      { instalments: [row("2027-02-30")] },
      { instalments: [row("2027-1-5")] },
    ]) {
      expect(codeOf(() => parseScheduleBody(body, { requireOne: false })), JSON.stringify(body)).toBe("400 schedule_invalid");
    }
  });

  it("schedule_order_invalid: on_signing not first, a second one, dates going backwards; equal dates are fine", () => {
    expect(codeOf(() => parseScheduleBody({ instalments: [row("2027-01-01"), row("on_signing")] }, { requireOne: false })))
      .toBe("400 schedule_order_invalid");
    expect(codeOf(() => parseScheduleBody({ instalments: [row("on_signing"), row("on_signing")] }, { requireOne: false })))
      .toBe("400 schedule_order_invalid");
    expect(codeOf(() => parseScheduleBody({ instalments: [row("2027-03-01"), row("2027-02-01")] }, { requireOne: false })))
      .toBe("400 schedule_order_invalid");
    expect(parseScheduleBody({ instalments: [row("on_signing"), row("2027-03-01"), row("2027-03-01")] }, { requireOne: false }))
      .toHaveLength(3);
  });

  it("an invalid row is reported before an order problem (the table's order)", () => {
    expect(codeOf(() => parseScheduleBody({ instalments: [row("2027-03-01"), row("on_signing", -1)] }, { requireOne: false })))
      .toBe("400 schedule_invalid");
  });

  it("rows come back trimmed and typed, amounts as canonical decimal strings", () => {
    expect(parseScheduleBody({ instalments: [{ label: "  Deposit (50%) ", amount: "30000000.00", due: "on_signing" }, row("2027-06-30", 30000000, "Balance")] }, { requireOne: false }))
      .toEqual([
        { label: "Deposit (50%)", amount: "30000000", dueKind: "on_signing", dueOn: null },
        { label: "Balance", amount: "30000000", dueKind: "date", dueOn: "2027-06-30" },
      ]);
  });

  it("amounts: numbers and decimal strings, never exponents or floats with noise hidden", () => {
    expect(canonicalAmount(1500000)).toBe("1500000");
    expect(canonicalAmount("0012.500")).toBe("12.5");
    expect(canonicalAmount(0.1 + 0.2)).toBe("0.30000000000000004"); // kept as sent, so the precision check refuses it
    expect(canonicalAmount("1e21")).toBeNull();
    expect(canonicalAmount(1e21)).toBeNull();
    expect(canonicalAmount("0.000")).toBeNull();
    expect(canonicalAmount(true)).toBeNull();
    expect(decimalsOf("12.5")).toBe(1);
    expect(decimalsOf("12")).toBe(0);
  });

  it("precision: no more decimals than the currency's minor unit (IDR 0, USD 2)", () => {
    const idr = parseScheduleBody({ instalments: [row("on_signing", "100.5")] }, { requireOne: false });
    expect(precisionOk(idr, 0)).toBe(false);
    expect(precisionOk(idr, 2)).toBe(true);
    expect(precisionOk(parseScheduleBody({ instalments: [row("on_signing", "100.00")] }, { requireOne: false }), 0)).toBe(true);
    expect(precisionOk(parseScheduleBody({ instalments: [row("on_signing", 0.1 + 0.2)] }, { requireOne: false }), 2)).toBe(false);
  });

  it("isIsoDate is a real calendar date", () => {
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(isIsoDate("2027-02-29")).toBe(false);
    expect(isIsoDate("2027-13-01")).toBe(false);
    expect(isIsoDate(20270101)).toBe(false);
  });
});

describe("DW-10f-3a · the draft-from-schedule body (BFF §61.5)", () => {
  const ID1 = "0190f5a1-0000-7000-8000-000000000001";
  const ID2 = "0190f5a1-0000-7000-8000-000000000002";
  const CL = "0190f5a1-0000-7000-8000-0000000000aa";

  it("source: hours by default, instalments, anything else source_invalid", () => {
    expect(sourceOf({})).toBe("hours");
    expect(sourceOf(undefined)).toBe("hours");
    expect(sourceOf({ source: "hours" })).toBe("hours");
    expect(sourceOf({ source: "instalments" })).toBe("instalments");
    expect(codeOf(() => sourceOf({ source: "both" }))).toBe("400 source_invalid");
  });

  it("refusals in order: source_fields_mixed, instalment_ids_invalid, due_by_invalid, tax_code_invalid", () => {
    expect(codeOf(() => parseDraftFromSchedule({ clientId: CL, instalmentIds: [ID1], periodStart: "2027-01-01" }))).toBe("400 source_fields_mixed");
    expect(codeOf(() => parseDraftFromSchedule({ clientId: CL, instalmentIds: [ID1], rate: 10 }))).toBe("400 source_fields_mixed");
    expect(codeOf(() => parseDraftFromSchedule({ clientId: CL, instalmentIds: "x", periodEnd: "2027-01-01" }))).toBe("400 source_fields_mixed");
    for (const ids of [undefined, [], ["nope"], [ID1, ID1.toUpperCase()], Array.from({ length: 61 }, () => ID1), [7]]) {
      expect(codeOf(() => parseDraftFromSchedule({ clientId: CL, instalmentIds: ids })), JSON.stringify(ids)).toBe("400 instalment_ids_invalid");
    }
    expect(codeOf(() => parseDraftFromSchedule({ clientId: CL, instalmentIds: [ID1], dueBy: "2027-02-30" }))).toBe("400 due_by_invalid");
    expect(codeOf(() => parseDraftFromSchedule({ clientId: CL, instalmentIds: [ID1], taxCode: "bad code!" }))).toBe("400 tax_code_invalid");
  });

  it("a valid body comes back normalised; a malformed client id becomes the 404's empty id", () => {
    expect(parseDraftFromSchedule({ clientId: CL.toUpperCase(), instalmentIds: [ID1, ID2.toUpperCase()], dueBy: "2027-01-31", taxCode: " PPN11 " }))
      .toEqual({ clientId: CL, instalmentIds: [ID1, ID2], dueBy: "2027-01-31", taxCode: "PPN11" });
    expect(parseDraftFromSchedule({ clientId: "x", instalmentIds: [ID1] })).toEqual({ clientId: "", instalmentIds: [ID1], dueBy: null, taxCode: null });
  });
});
