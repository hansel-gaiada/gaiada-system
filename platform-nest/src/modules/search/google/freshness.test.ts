// SM-25b — pure unit tests for freshness.ts. No DB, no HTTP: the same split as rank.ts's own
// pure-function tests (rank.test.ts) vs its DB-backed integration coverage.
import { describe, it, expect } from "vitest";
import { clampEndDateToFreshnessLag, isoDateDaysAgo, isRowDateWithinWindow } from "./freshness";

describe("isoDateDaysAgo", () => {
  it("returns today for daysAgo=0, relative to the supplied `now`", () => {
    expect(isoDateDaysAgo(0, new Date("2026-07-30T15:00:00Z"))).toBe("2026-07-30");
  });

  it("subtracts calendar days, crossing a month boundary", () => {
    expect(isoDateDaysAgo(3, new Date("2026-08-01T00:00:00Z"))).toBe("2026-07-29");
  });

  it("is stable regardless of time-of-day (UTC calendar date only)", () => {
    expect(isoDateDaysAgo(1, new Date("2026-07-30T23:59:59Z"))).toBe("2026-07-29");
    expect(isoDateDaysAgo(1, new Date("2026-07-30T00:00:01Z"))).toBe("2026-07-29");
  });
});

describe("clampEndDateToFreshnessLag (the 'a partial day must not read as a drop to zero' guard)", () => {
  // A fixed reference instant, used for the tests where the exact boundary DATE must be asserted
  // literally (never relying on the real wall clock at test-run time).
  const now = new Date("2026-07-30T12:00:00Z");

  it("omitting requestedEndDate ⇒ the boundary itself, and NOT clamped (there was nothing narrower to honour)", () => {
    const c = clampEndDateToFreshnessLag(undefined, 3, now);
    expect(c.effectiveEndDate).toBe("2026-07-27");
    expect(c.requestedEndDate).toBe("2026-07-27");
    expect(c.clamped).toBe(false);
    expect(c.lagDays).toBe(3);
  });

  it("a requested end date INSIDE the lag window is pulled back to the boundary, and disclosed as clamped", () => {
    const c = clampEndDateToFreshnessLag("2026-07-30", 3, now); // "today" relative to `now`
    expect(c.requestedEndDate).toBe("2026-07-30");
    expect(c.effectiveEndDate).toBe("2026-07-27");
    expect(c.clamped).toBe(true);
  });

  it("a requested end date already AT the boundary is a no-op (clamped: false)", () => {
    const c = clampEndDateToFreshnessLag("2026-07-27", 3, now);
    expect(c.effectiveEndDate).toBe("2026-07-27");
    expect(c.clamped).toBe(false);
  });

  it("a requested end date well BEFORE the boundary is a no-op — clamping only ever moves a date EARLIER, never later", () => {
    const c = clampEndDateToFreshnessLag("2026-06-01", 3, now);
    expect(c.effectiveEndDate).toBe("2026-06-01");
    expect(c.clamped).toBe(false);
  });

  it("different lagDays produce different boundaries for the identical request (GSC vs GA4 never share a clamp constant)", () => {
    const gsc = clampEndDateToFreshnessLag("2026-07-30", 3, now);
    const ga4 = clampEndDateToFreshnessLag("2026-07-30", 2, now);
    expect(gsc.effectiveEndDate).toBe("2026-07-27");
    expect(ga4.effectiveEndDate).toBe("2026-07-28");
    expect(gsc.effectiveEndDate < ga4.effectiveEndDate).toBe(true); // longer lag ⇒ earlier boundary
  });
});

// SM-64 — the response-side half (§A14 echo-validation): a returned row's own date, re-verified
// against the range actually requested, before persistence.
describe("isRowDateWithinWindow (SM-64 — the response-side half of the freshness guarantee)", () => {
  it("a date strictly between startDate and effectiveEndDate is within the window", () => {
    expect(isRowDateWithinWindow("2026-07-15", "2026-07-01", "2026-07-27")).toBe(true);
  });

  it("a date exactly AT either boundary is within the window (inclusive)", () => {
    expect(isRowDateWithinWindow("2026-07-01", "2026-07-01", "2026-07-27")).toBe(true);
    expect(isRowDateWithinWindow("2026-07-27", "2026-07-01", "2026-07-27")).toBe(true);
  });

  it("a date one day AFTER effectiveEndDate (the exact 'partial day' shape the ticket names) is OUTSIDE the window", () => {
    expect(isRowDateWithinWindow("2026-07-28", "2026-07-01", "2026-07-27")).toBe(false);
  });

  it("a date BEFORE startDate is OUTSIDE the window", () => {
    expect(isRowDateWithinWindow("2026-06-30", "2026-07-01", "2026-07-27")).toBe(false);
  });

  it("the side-effect positional-integrity tripwire: a non-YYYY-MM-DD value in the date slot fails the bound rather than passing through", () => {
    // '/' sorts after '-' in ASCII, so a slash-shaped date compares as GREATER than any '-'-shaped
    // effectiveEndDate sharing the same year/month prefix — it fails the upper bound, exactly the free
    // tripwire the header describes.
    expect(isRowDateWithinWindow("2026/07/15", "2026-07-01", "2026-07-27")).toBe(false);
    expect(isRowDateWithinWindow("not-a-date", "2026-07-01", "2026-07-27")).toBe(false);
    expect(isRowDateWithinWindow("", "2026-07-01", "2026-07-27")).toBe(false);
  });
});
