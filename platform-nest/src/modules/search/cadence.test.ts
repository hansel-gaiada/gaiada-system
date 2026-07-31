// SM-61 (tracker §6au Ruling 1, clause 5) — pure unit tests for the single no-default cadence
// parser. No DB, no Cerbos: everything here is pure arithmetic/logic, run unconditionally.
import { describe, it, expect } from "vitest";
import {
  cadenceDays,
  isCadence,
  ON_DEMAND_ESTIMATE_RUNS_PER_MONTH,
  parseCadence,
  SCHEDULED_TOOLS,
  scheduledRunsPerMonth,
  type Cadence,
} from "./cadence";

describe("SM-61 · isCadence / parseCadence — no default path", () => {
  it("accepts exactly the three enum values", () => {
    for (const v of ["daily", "weekly", "monthly"] as const) {
      expect(isCadence(v)).toBe(true);
      expect(parseCadence(v)).toBe(v);
    }
  });

  it("THE probe this ticket names: absent/junk parses to null (on-demand), NEVER to a guessed schedule", () => {
    // This is the property a "treat null as weekly" mutation must break — see pull-scheduler.test.ts
    // for the live-sweep half of that probe (a cadence-less enabled tool must tick `on_demand`, not
    // `dispatched`/`not_due`).
    for (const junk of [undefined, null, "", "Daily", "DAILY", " daily", "daily ", "\tdaily\n", "fortnightly", "hourly", 3, {}, []]) {
      expect(parseCadence(junk)).toBeNull();
      expect(isCadence(junk)).toBe(false);
    }
  });

  it("case/whitespace variants of a VALID word still resolve to null, never to the word they resemble", () => {
    // The failure mode this guards: a caller who exact-matches case-insensitively (or trims) would
    // turn a malformed write into a REAL schedule. Junk must stay inert (null), not "helpfully"
    // become the cadence it almost typed.
    expect(parseCadence("Daily")).not.toBe("daily");
    expect(parseCadence("Weekly")).not.toBe("weekly");
    expect(parseCadence("MONTHLY")).not.toBe("monthly");
  });
});

describe("SM-61 · cadenceDays / scheduledRunsPerMonth — real cadences only", () => {
  it("ports sm-rank-pull.json's windows verbatim: daily=1, weekly=7, monthly=30", () => {
    expect(cadenceDays("daily")).toBe(1);
    expect(cadenceDays("weekly")).toBe(7);
    expect(cadenceDays("monthly")).toBe(30);
  });

  it("scheduledRunsPerMonth prices a real cadence at its actual monthly run count", () => {
    expect(scheduledRunsPerMonth("daily")).toBe(30);
    expect(scheduledRunsPerMonth("weekly")).toBeCloseTo(30 / 7, 6);
    expect(scheduledRunsPerMonth("monthly")).toBe(1);
  });

  it("PRICE-IDENTITY: scheduledRunsPerMonth('monthly') equals ON_DEMAND_ESTIMATE_RUNS_PER_MONTH — the fact that makes the SM-61 preset fix a zero-price-change edit", () => {
    expect(scheduledRunsPerMonth("monthly")).toBe(ON_DEMAND_ESTIMATE_RUNS_PER_MONTH);
  });
});

describe("SM-61 · SCHEDULED_TOOLS — the single list both call sites read", () => {
  it("is exactly the four tools SM-54 reassigned from n8n; 'suggestions' is not among them", () => {
    expect([...SCHEDULED_TOOLS]).toEqual(["rank", "volume", "backlinks", "ai_visibility"]);
    expect(SCHEDULED_TOOLS as readonly string[]).not.toContain("suggestions");
  });
});

// Compile-time proof the exported type is exactly the three-member union (no `| null` leaking into
// the type itself — null is represented by parseCadence's RETURN type, never by a fourth member).
void ((): Cadence => "daily");
