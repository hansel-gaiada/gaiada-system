import { describe, expect, it } from "vitest";
import {
  AFTER_SIGNING_WARNING, SEND_SCHEDULE_REASON, addMonthsClamped, addedAfterSigningWords, contractActions, dueWords, formatAmountNumber,
  formatMinor, fromMinor, instalmentStateWords, isIsoDate, minorUnitOf, notBilledWhy, presetAllOnSigning, presetFiftyFifty, presetMonthly,
  rowsFromSchedule, scheduleBody, scheduleErrorText, scheduleLine, scheduleSendBlock, splitEvenly, toMinor, validateScheduleRows, valueToMinor,
  type Contract, type ContractSchedule, type ScheduleDraftRow,
} from "./contracts";

// DW-10f-2b (BFF §61.4, §61.9) — the payment schedule's pure rules. The presets are the money rule of this ticket: an even split rounded
// DOWN to the currency's minor unit, the remainder on the FIRST row, month ends clamped, and the rows always adding up exactly. Every sum
// is BigInt over minor units, so these tests include values past 2^53 where a float would have changed the answer.

const k = (over: Partial<Contract> = {}): Contract => ({
  id: "k1", clientId: "cl-1", clientName: "Northwind", projectId: null, projectName: null, title: "Agreement",
  reference: null, version: 1, supersedesId: null, status: "draft", fileId: null, bodyMd: "terms", value: 120_000_000,
  currency: "IDR", startsOn: null, endsOn: null, sentAt: null, signedAt: null, declineReason: null, createdBy: null,
  createdAt: "2026-10-01T00:00:00Z", clientSigned: false, providerSigned: false, termEnded: false, canCountersign: false,
  ...over,
});
const sum = (rows: ScheduleDraftRow[], currency: string) => rows.reduce((n, r) => n + (toMinor(r.amount, minorUnitOf(currency)) as bigint), BigInt(0));

describe("minor units and exact money", () => {
  it("knows the zero- and three-decimal currencies, two otherwise", () => {
    expect(minorUnitOf("IDR")).toBe(0);
    expect(minorUnitOf("jpy")).toBe(0);
    expect(minorUnitOf("USD")).toBe(2);
    expect(minorUnitOf("KWD")).toBe(3);
  });

  it("toMinor takes a plain decimal within the currency's decimals, and nothing else", () => {
    expect(toMinor("1500000", 0)).toBe(BigInt(1500000));
    expect(toMinor("12.5", 2)).toBe(BigInt(1250));
    expect(toMinor("12.50", 0)).toBeNull(); // a real decimal the currency does not have
    expect(toMinor("12.00", 0)).toBe(BigInt(12)); // zeros alone are not a decimal
    expect(toMinor("0.001", 2)).toBeNull();
    for (const bad of ["", " ", "-5", "1e6", "1,000", "abc", "1.", ".5"]) expect(toMinor(bad, 2)).toBeNull();
  });

  it("fromMinor and formatMinor round-trip and group in a fixed locale", () => {
    expect(fromMinor(BigInt(3333334), 0)).toBe("3333334");
    expect(fromMinor(BigInt(1250), 2)).toBe("12.50");
    expect(fromMinor(BigInt(5), 2)).toBe("0.05");
    expect(formatMinor(BigInt(120_000_000), "IDR")).toBe("IDR 120,000,000");
    expect(formatMinor(BigInt(120_000_000), "IDR", false)).toBe("120,000,000");
    expect(formatMinor(BigInt(123450), "usd")).toBe("USD 1,234.50");
    expect(formatAmountNumber(5000, "IDR")).toBe("IDR 5,000");
  });

  it("🔴 stays exact past 2^53, where a float would change the digits", () => {
    const big = "90071992547409931"; // 2^53 + 11
    expect(fromMinor(toMinor(big, 0) as bigint, 0)).toBe(big);
    expect(valueToMinor(120_000_000, "IDR")).toBe(BigInt(120_000_000));
    expect(valueToMinor(null, "IDR")).toBeNull();
    expect(valueToMinor(-1, "IDR")).toBeNull();
  });
});

describe("splitEvenly · rounded down, the remainder on the FIRST part", () => {
  it("10,000,000 in 3 is 3,333,334 + 3,333,333 + 3,333,333", () => {
    expect(splitEvenly(BigInt(10_000_000), 3)).toEqual([BigInt(3_333_334), BigInt(3_333_333), BigInt(3_333_333)]);
  });
  it("an exact split has no remainder, and 1 part is the whole", () => {
    expect(splitEvenly(BigInt(120), 4)).toEqual([BigInt(30), BigInt(30), BigInt(30), BigInt(30)]);
    expect(splitEvenly(BigInt(7), 1)).toEqual([BigInt(7)]);
  });
  it("a remainder bigger than one unit still goes entirely on the first part", () => {
    expect(splitEvenly(BigInt(100), 7)).toEqual([BigInt(16), ...Array(6).fill(BigInt(14))]); // 100 = 14*7 + 2 -> first 14+2
    expect(splitEvenly(BigInt(100), 7).reduce((a, b) => a + b, BigInt(0))).toBe(BigInt(100));
  });
  it("refuses a count below 1 or a fraction", () => {
    expect(splitEvenly(BigInt(10), 0)).toEqual([]);
    expect(splitEvenly(BigInt(10), 2.5)).toEqual([]);
  });
});

describe("addMonthsClamped · the same day next month, or the month's last day", () => {
  it("keeps the day when it exists", () => {
    expect(addMonthsClamped("2026-10-15", 0)).toBe("2026-10-15");
    expect(addMonthsClamped("2026-10-15", 1)).toBe("2026-11-15");
    expect(addMonthsClamped("2026-10-15", 3)).toBe("2027-01-15"); // across the year
  });
  it("🔴 clamps to the month's last day, anchored on the FIRST date (31 Jan, 28 Feb, 31 Mar; never 28 Mar)", () => {
    expect(addMonthsClamped("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsClamped("2026-01-31", 2)).toBe("2026-03-31");
    expect(addMonthsClamped("2026-01-31", 3)).toBe("2026-04-30");
    expect(addMonthsClamped("2026-11-30", 3)).toBe("2027-02-28");
  });
  it("knows leap years", () => {
    expect(addMonthsClamped("2027-12-31", 2)).toBe("2028-02-29");
    expect(addMonthsClamped("2028-01-30", 1)).toBe("2028-02-29");
    expect(addMonthsClamped("2027-01-30", 1)).toBe("2027-02-28");
  });
  it("is null for something that is not a date", () => {
    expect(addMonthsClamped("2026-02-30", 1)).toBeNull();
    expect(addMonthsClamped("soon", 1)).toBeNull();
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2026-02-28")).toBe(true);
  });
});

describe("presets", () => {
  it("All on signing: one row, the whole value, due on signing", () => {
    expect(presetAllOnSigning(120_000_000, "IDR")).toEqual([{ label: "Payment on signing", amount: "120000000", due: "on_signing" }]);
  });

  it("50/50: a deposit on signing and a balance on the picked date, adding up exactly", () => {
    const rows = presetFiftyFifty(120_000_000, "IDR", "2027-03-31");
    expect(rows).toEqual([
      { label: "Deposit (50%)", amount: "60000000", due: "on_signing" },
      { label: "Balance (50%)", amount: "60000000", due: "2027-03-31" },
    ]);
  });

  it("🔴 50/50 of an odd value puts the odd unit on the deposit, and the rows add up", () => {
    const rows = presetFiftyFifty(100_001, "IDR", "2027-01-01");
    expect(rows.map((r) => r.amount)).toEqual(["50001", "50000"]);
    expect(sum(rows, "IDR")).toBe(BigInt(100_001));
    // two decimals: 100.01 -> 50.01 + 50.00
    const usd = presetFiftyFifty(100.01, "USD", "2027-01-01");
    expect(usd.map((r) => r.amount)).toEqual(["50.01", "50.00"]);
  });

  it("50/50 leaves the balance's date BLANK when none is given or it is not a date (required, so the editor asks)", () => {
    expect(presetFiftyFifty(10, "IDR")[1].due).toBe("");
    expect(presetFiftyFifty(10, "IDR", "not a date")[1].due).toBe("");
    expect(presetFiftyFifty(10, "IDR", null)[1].due).toBe("");
  });

  it("Monthly x N: Month 1..N, the remainder on Month 1, month ends clamped", () => {
    const rows = presetMonthly(10_000_000, "IDR", 3, "2026-01-31");
    expect(rows).toEqual([
      { label: "Month 1", amount: "3333334", due: "2026-01-31" },
      { label: "Month 2", amount: "3333333", due: "2026-02-28" },
      { label: "Month 3", amount: "3333333", due: "2026-03-31" },
    ]);
    expect(sum(rows, "IDR")).toBe(BigInt(10_000_000));
  });

  it("Monthly x N with a blank first date leaves every date blank; 60 is the most and 0 or 61 gives nothing", () => {
    expect(presetMonthly(600, "IDR", 3, "").every((r) => r.due === "")).toBe(true);
    expect(presetMonthly(600, "IDR", 60, "2026-01-01")).toHaveLength(60);
    expect(presetMonthly(600, "IDR", 61, "2026-01-01")).toEqual([]);
    expect(presetMonthly(600, "IDR", 0, "2026-01-01")).toEqual([]);
    expect(presetMonthly(600, "IDR", 1, "2026-01-01")).toEqual([{ label: "Month 1", amount: "600", due: "2026-01-01" }]);
  });

  it("🔴 every preset adds up to the value exactly, for awkward values and both currency shapes", () => {
    for (const value of [1, 7, 99_999_999, 123_456_789_012, 3]) {
      for (const n of [1, 2, 3, 7, 12, 60]) {
        expect(sum(presetMonthly(value, "IDR", n, "2026-05-31"), "IDR")).toBe(BigInt(value));
      }
    }
    expect(sum(presetMonthly(1000.01, "USD", 3, "2026-05-31"), "USD")).toBe(BigInt(100_001));
  });

  it("a split finer than the value allows leaves zero rows, which the live line calls invalid (the server refuses a zero amount)", () => {
    expect(scheduleLine(presetMonthly(3, "IDR", 7, "2026-01-01"), 3, "IDR").kind).toBe("invalid");
  });

  it("gives nothing without a value (the editor then asks for one first)", () => {
    for (const v of [null, undefined, 0]) {
      expect(presetAllOnSigning(v, "IDR")).toEqual([]);
      expect(presetFiftyFifty(v, "IDR", "2027-01-01")).toEqual([]);
      expect(presetMonthly(v, "IDR", 3, "2027-01-01")).toEqual([]);
    }
  });
});

describe("scheduleLine · the live 'adds up / short / over' line", () => {
  const rows = (...amounts: string[]): ScheduleDraftRow[] => amounts.map((a, i) => ({ label: `R${i}`, amount: a, due: i === 0 ? "on_signing" : "2027-01-01" }));

  it("says 'Adds up to IDR 120,000,000 of 120,000,000' when it does", () => {
    const l = scheduleLine(rows("60000000", "60000000"), 120_000_000, "IDR");
    expect(l.kind).toBe("ok");
    expect(l.addsUp).toBe(true);
    expect(l.text).toBe("Adds up to IDR 120,000,000 of 120,000,000.");
  });

  it("says 'IDR 5,000 short' and 'IDR 5,000 over', with the figures", () => {
    const short = scheduleLine(rows("60000000", "59995000"), 120_000_000, "IDR");
    expect(short.kind).toBe("short");
    expect(short.addsUp).toBe(false);
    expect(short.text).toContain("IDR 5,000 short");
    expect(short.text).toContain("IDR 119,995,000 of 120,000,000");
    const over = scheduleLine(rows("60000000", "60005000"), 120_000_000, "IDR");
    expect(over.kind).toBe("over");
    expect(over.text).toContain("IDR 5,000 over");
  });

  it("is exact to the cent, and past 2^53", () => {
    expect(scheduleLine(rows("0.10", "0.20"), 0.3, "USD").kind).toBe("ok"); // a float sum would be 0.30000000000000004
    expect(scheduleLine(rows("9007199254740991", "1"), 9007199254740992, "IDR").kind).toBe("ok");
  });

  it("has an empty line, an invalid-amount line and a no-value line, and never a sum over rows the server would refuse", () => {
    expect(scheduleLine([], 100, "IDR").kind).toBe("empty");
    expect(scheduleLine(rows("abc"), 100, "IDR").kind).toBe("invalid");
    expect(scheduleLine(rows("0"), 100, "IDR").kind).toBe("invalid");
    expect(scheduleLine(rows("1.5"), 100, "IDR").kind).toBe("invalid"); // IDR has no decimals
    expect(scheduleLine(rows("100"), null, "IDR").kind).toBe("no_value");
    expect(scheduleLine(rows("100"), 0, "IDR").kind).toBe("no_value");
  });
});

describe("validateScheduleRows · what the browser checks before the round trip", () => {
  const row = (over: Partial<ScheduleDraftRow> = {}): ScheduleDraftRow => ({ label: "Deposit", amount: "100", due: "on_signing", ...over });

  it("accepts a good schedule, and an empty one unless one is required", () => {
    expect(validateScheduleRows([row(), row({ label: "Balance", due: "2027-01-01" })], "IDR")).toBeNull();
    expect(validateScheduleRows([], "IDR")).toBeNull();
    expect(validateScheduleRows([], "IDR", { requireOne: true })).toMatchObject({ field: "rows" });
  });

  it("names the row and the field of each problem", () => {
    expect(validateScheduleRows([row({ label: "  " })], "IDR")).toMatchObject({ index: 0, field: "label" });
    expect(validateScheduleRows([row({ label: "x".repeat(121) })], "IDR")).toMatchObject({ field: "label" });
    expect(validateScheduleRows([row({ amount: "" })], "IDR")).toMatchObject({ index: 0, field: "amount" });
    expect(validateScheduleRows([row({ amount: "0" })], "IDR")).toMatchObject({ field: "amount" });
    expect(validateScheduleRows([row({ amount: "1.5" })], "IDR")).toMatchObject({ field: "amount" });
    expect(validateScheduleRows([row({ due: "" })], "IDR")).toMatchObject({ field: "due" });
    expect(validateScheduleRows([row({ due: "2026-02-30" })], "IDR")).toMatchObject({ field: "due" });
  });

  it("only the first row may be on signing, and the dates may not go backwards", () => {
    expect(validateScheduleRows([row(), row({ due: "on_signing" })], "IDR")).toMatchObject({ index: 1, field: "order" });
    expect(validateScheduleRows([row({ due: "2027-02-01" }), row({ due: "2027-01-01" })], "IDR")).toMatchObject({ index: 1, field: "order" });
    expect(validateScheduleRows([row({ due: "2027-01-01" }), row({ due: "2027-01-01" })], "IDR")).toBeNull(); // the same day is not backwards
  });

  it("at most 60 rows", () => {
    expect(validateScheduleRows(Array.from({ length: 61 }, (_, i) => row({ due: i === 0 ? "on_signing" : "2027-01-01" })), "IDR")).toMatchObject({ field: "rows" });
  });
});

describe("the body and the editor's starting rows", () => {
  it("scheduleBody trims labels and sends amounts as the strings typed (never a float)", () => {
    expect(scheduleBody([{ label: " Deposit ", amount: " 3333334 ", due: "on_signing" }])).toEqual({ instalments: [{ label: "Deposit", amount: "3333334", due: "on_signing" }] });
  });

  it("rowsFromSchedule turns a saved schedule back into rows", () => {
    const s: ContractSchedule = {
      currency: "USD", value: 100, total: 100, matchesValue: true, scheduleSha256: null, addedAfterSigning: null,
      instalments: [
        { id: "i1", position: 1, label: "A", amount: 40, due: { kind: "on_signing", on: null }, state: "scheduled", invoice: null },
        { id: "i2", position: 2, label: "B", amount: 60.5, due: { kind: "date", on: "2027-01-01" }, state: "scheduled", invoice: null },
      ],
    };
    expect(rowsFromSchedule(s)).toEqual([
      { label: "A", amount: "40.00", due: "on_signing" },
      { label: "B", amount: "60.50", due: "2027-01-01" },
    ]);
    expect(rowsFromSchedule(null)).toEqual([]);
  });
});

describe("Send is disabled until the schedule adds up (BFF §61.1 row 3)", () => {
  it("a contract with a value and no schedule cannot be sent; one that matches can; one that does not cannot", () => {
    expect(scheduleSendBlock({ value: 100, scheduleSummary: null })).toBe(SEND_SCHEDULE_REASON);
    expect(scheduleSendBlock({ value: 100, scheduleSummary: { count: 2, total: 100, matchesValue: true } })).toBeNull();
    expect(scheduleSendBlock({ value: 100, scheduleSummary: { count: 2, total: 90, matchesValue: false } })).toBe(SEND_SCHEDULE_REASON);
  });

  it("a contract with no value or a zero value carries no schedule and is not blocked", () => {
    expect(scheduleSendBlock({ value: null, scheduleSummary: null })).toBeNull();
    expect(scheduleSendBlock({ value: 0, scheduleSummary: null })).toBeNull();
  });

  it("an older server that omits the field claims nothing: the server's own check decides", () => {
    expect(scheduleSendBlock({ value: 100, scheduleSummary: undefined })).toBeNull();
  });

  it("🔴 contractActions disables Send with the sentence, and says both reasons when both apply", () => {
    expect(SEND_SCHEDULE_REASON).toBe("The payment schedule must add up to the value before sending.");
    const blocked = contractActions(k({ scheduleSummary: null }));
    expect(blocked.send).toMatchObject({ shown: true, enabled: false, reason: SEND_SCHEDULE_REASON });
    const ok = contractActions(k({ scheduleSummary: { count: 1, total: 120_000_000, matchesValue: true } }));
    expect(ok.send).toMatchObject({ enabled: true, reason: null });
    const both = contractActions(k({ bodyMd: null, scheduleSummary: null }));
    expect(both.send.enabled).toBe(false);
    expect(both.send.reason).toMatch(/Write the terms/);
    expect(both.send.reason).toMatch(/payment schedule must add up/);
  });

  it("a contract without a value is as sendable as it ever was (existing behaviour)", () => {
    expect(contractActions(k({ value: null, scheduleSummary: undefined })).send).toMatchObject({ enabled: true, reason: null });
  });
});

describe("what a row offers for the schedule", () => {
  it("the editor is for a draft; 'Add a payment schedule' is for a signed contract the backend says is addable", () => {
    expect(contractActions(k({ status: "draft" }))).toMatchObject({ editSchedule: true, addSchedule: false });
    expect(contractActions(k({ status: "sent" }))).toMatchObject({ editSchedule: false, addSchedule: false });
    expect(contractActions(k({ status: "signed", scheduleAddable: true }))).toMatchObject({ editSchedule: false, addSchedule: true });
  });

  it("🔴 never offers the addition from anything but the backend's `scheduleAddable: true` on a signed row", () => {
    expect(contractActions(k({ status: "signed", scheduleAddable: false })).addSchedule).toBe(false);
    expect(contractActions(k({ status: "signed" })).addSchedule).toBe(false); // an older server omits it
    expect(contractActions(k({ status: "sent", scheduleAddable: true })).addSchedule).toBe(false);
    expect(contractActions(k({ status: "void", scheduleAddable: true })).addSchedule).toBe(false);
  });
});

describe("the words", () => {
  const date = (iso: string) => `<${iso}>`;

  it("states each instalment state in §61.3's staff words", () => {
    const base = { due: { kind: "date" as const, on: "2027-01-01" }, invoice: null, notBilledReason: null };
    expect(instalmentStateWords({ ...base, state: "scheduled" }, date)).toBe("Scheduled");
    expect(instalmentStateWords({ ...base, state: "upcoming" }, date)).toBe("Upcoming, <2027-01-01>");
    expect(instalmentStateWords({ ...base, state: "due" }, date)).toBe("Due: ready to invoice");
    expect(instalmentStateWords({ ...base, state: "invoicing", invoice: { id: "i", invoiceNo: null, status: "draft" } }, date)).toBe("On a draft invoice");
    expect(instalmentStateWords({ ...base, state: "invoiced", invoice: { id: "i", invoiceNo: "INV/1", status: "sent" } }, date)).toBe("Invoiced, INV/1");
    expect(instalmentStateWords({ ...base, state: "paid" }, date)).toBe("Paid");
    expect(instalmentStateWords({ ...base, state: "not_billed", notBilledReason: "void" }, date)).toBe("Not billed (the agreement was voided)");
    expect(instalmentStateWords({ ...base, state: "mystery" }, date)).toBe("mystery");
  });

  it("says why a not-billed instalment is not billed", () => {
    for (const r of ["superseded", "deleted", "void", "declined", "expired", null, "other"]) expect(notBilledWhy(r as string | null)).toBeTruthy();
    expect(notBilledWhy("superseded")).toMatch(/newer signed version/);
  });

  it("words the due column and the after-signing line", () => {
    expect(dueWords({ kind: "on_signing", on: null }, date)).toBe("On signing");
    expect(dueWords({ kind: "on_signing", on: "2026-10-03" }, date)).toBe("On signing (<2026-10-03>)");
    expect(dueWords({ kind: "date", on: "2027-01-01" }, date)).toBe("Due <2027-01-01>");
    expect(addedAfterSigningWords({ at: "2026-10-18T01:00:00Z", by: { id: "u", name: "Olive Owner" } }, date)).toBe("Added after signing by Olive Owner, <2026-10-18T01:00:00Z>");
    expect(addedAfterSigningWords({ at: "2026-10-18T01:00:00Z", by: { id: "u", name: null } }, date)).toBe("Added after signing, <2026-10-18T01:00:00Z>");
  });

  it("the after-signing warning is §61.9's sentence", () => {
    expect(AFTER_SIGNING_WARNING).toBe("This agreement is already signed. The schedule must restate the payment terms the agreement states. It can be added once and never changed.");
  });
});

describe("scheduleErrorText · every refusal of §61.4 and §61.4a is a sentence, never the raw code", () => {
  const CODES = [
    "contract_not_found", "schedule_frozen", "contract_terms_frozen", "schedule_invalid", "schedule_order_invalid", "currency_unknown",
    "schedule_precision", "schedule_needs_value", "schedule_total_mismatch", "not_allowed_via_automation", "contract_not_signed",
    "contract_closed", "contract_superseded", "schedule_exists", "schedule_changed", "conflict",
  ];

  it("🔴 words every code, and none of them is the code itself or the raw server text", () => {
    for (const code of CODES) {
      const text = scheduleErrorText(409, code, "RAW SERVER TEXT");
      expect(text, code).not.toBe(code);
      expect(text, code).not.toMatch(/RAW SERVER TEXT/);
      expect(text, code).not.toMatch(/_/); // no snake_case code leaks into a sentence
      expect(text.endsWith("."), code).toBe(true);
    }
  });

  it("schedule_total_mismatch uses the server's figures when it sends them", () => {
    expect(scheduleErrorText(400, "schedule_total_mismatch", "x", { value: 120_000_000, total: 115_000_000 }, "IDR"))
      .toBe("The instalments add up to IDR 115,000,000, but the contract's value is IDR 120,000,000. They must match exactly.");
    expect(scheduleErrorText(400, "schedule_total_mismatch", "x")).toMatch(/must add up exactly/);
  });

  it("a 403 is a sentence, and an unknown code keeps the server's message", () => {
    expect(scheduleErrorText(403, undefined, "forbidden")).toMatch(/permission/);
    expect(scheduleErrorText(500, "who_knows", "the server said this")).toBe("the server said this");
  });
});
