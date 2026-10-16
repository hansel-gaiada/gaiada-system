// DW-10c (docs/FRONTEND-BFF-CONTRACT.md §59.1) — the PURE rules of dept-calendar.service.ts: the window, the unit id's shape and the leg
// cap. No database, no Cerbos: runs everywhere. The HTTP/DB proof of the same rules is dept-calendar.test.ts, which runs on the Linux gate.
import { describe, it, expect } from "vitest";
import { DeptCalendarRuleError, LEG_CAP, PROJECT_CANDIDATE_CAP, WINDOW_MAX_DAYS, capLeg, checkUnitParam, parseWindow } from "./dept-calendar.service";

function refusal(fn: () => unknown): DeptCalendarRuleError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DeptCalendarRuleError);
    return e as DeptCalendarRuleError;
  }
  throw new Error("expected a DeptCalendarRuleError, but nothing was thrown");
}
const fieldOf = (fn: () => unknown) => refusal(fn).field;

describe("parseWindow (§59.1)", () => {
  it("both dates are required real YYYY-MM-DD days, and the refusal names the field", () => {
    expect(fieldOf(() => parseWindow({ to: "2026-11-15" }))).toBe("from");
    expect(fieldOf(() => parseWindow({ from: "2026-10-05" }))).toBe("to");
    expect(fieldOf(() => parseWindow({ from: "", to: "2026-11-15" }))).toBe("from");
    expect(fieldOf(() => parseWindow({ from: "2026-02-30", to: "2026-11-15" }))).toBe("from");
    expect(fieldOf(() => parseWindow({ from: "2026-10-05", to: "2026-13-01" }))).toBe("to");
    expect(fieldOf(() => parseWindow({ from: "2026-10-05T00:00:00Z", to: "2026-11-15" }))).toBe("from");
    expect(fieldOf(() => parseWindow({ from: "5 Oct", to: "2026-11-15" }))).toBe("from");
    expect(fieldOf(() => parseWindow({ from: ["2026-10-05"], to: "2026-11-15" }))).toBe("from");
    expect(fieldOf(() => parseWindow({ from: 20261005, to: "2026-11-15" }))).toBe("from");
  });

  it("`to` is not before `from`; a one-day window is fine", () => {
    expect(fieldOf(() => parseWindow({ from: "2026-10-06", to: "2026-10-05" }))).toBe("to");
    expect(parseWindow({ from: "2026-10-05", to: "2026-10-05" })).toEqual({ from: "2026-10-05", to: "2026-10-05" });
  });

  it("at most 42 days counting both ends: 42 is fine, 43 is a 400 on `to`", () => {
    expect(WINDOW_MAX_DAYS).toBe(42);
    expect(parseWindow({ from: "2026-10-05", to: "2026-11-15" })).toEqual({ from: "2026-10-05", to: "2026-11-15" }); // 27 + 15 = 42
    expect(fieldOf(() => parseWindow({ from: "2026-10-05", to: "2026-11-16" }))).toBe("to"); // 43
    // across a leap day and a year end
    expect(parseWindow({ from: "2028-02-01", to: "2028-03-13" })).toBeTruthy(); // 29 + 13 = 42
    expect(fieldOf(() => parseWindow({ from: "2028-02-01", to: "2028-03-14" }))).toBe("to");
    expect(parseWindow({ from: "2026-12-01", to: "2027-01-11" })).toBeTruthy(); // 31 + 11 = 42
    expect(fieldOf(() => parseWindow({ from: "2026-12-01", to: "2027-01-12" }))).toBe("to");
  });
});

describe("checkUnitParam", () => {
  it("1 to 200 characters with no control character; anything else is a 400 on unitNodeId", () => {
    expect(checkUnitParam("d-web")).toBe("d-web");
    expect(checkUnitParam("x".repeat(200))).toHaveLength(200);
    for (const bad of ["", "x".repeat(201), "a\nb", "a\u0000b", "a\u007fb"]) expect(fieldOf(() => checkUnitParam(bad))).toBe("unitNodeId");
  });
});

describe("capLeg", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => i);
  it("200 items or fewer are whole and carry no `truncated`; a 201st cuts to 200 and says so", () => {
    expect(LEG_CAP).toBe(200);
    expect(capLeg([])).toEqual({ included: true, items: [] });
    expect(capLeg(rows(200))).toEqual({ included: true, items: rows(200) });
    expect("truncated" in capLeg(rows(200))).toBe(false);
    const over = capLeg(rows(201));
    expect(over).toMatchObject({ included: true, truncated: true });
    expect(over.included && over.items).toEqual(rows(200));
  });
  it("the project candidate cap is well above one department's milestones", () => {
    expect(PROJECT_CANDIDATE_CAP).toBeGreaterThanOrEqual(LEG_CAP);
  });
});
