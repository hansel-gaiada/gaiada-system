// PV7-02 — the client health rules, pinned by a golden table (BFF §54.3).
//
// `client-health-golden.json` is the table; the UI's demo mirror (PV7-05) copies the file and runs the same cases, so a
// rule changed on one side fails on the other. This file is pure: no database, no Cerbos, it runs anywhere.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AT_RISK_WAITING_ON_CLIENT_DAYS, AT_RISK_WAITING_ON_US_DAYS, OFF_TRACK_INVOICE_OVERDUE_DAYS, OFF_TRACK_LATE_WORK_DAYS,
  OFF_TRACK_SITE_INCIDENT_HOURS, OFF_TRACK_WAITING_ON_US_DAYS, evaluateClientHealth,
  type HealthReasonCode, type HealthRuleInput, type HealthSource, type HealthState,
} from "./client-health-rules";

interface GoldenCase {
  name: string;
  input: Partial<HealthRuleInput>;
  unavailable: HealthSource[];
  expect: { state: HealthState; reasons: Array<{ code: HealthReasonCode; count: number; since: string | null }> };
}
interface Golden {
  now: string;
  thresholds: Record<string, number>;
  base: HealthRuleInput;
  cases: GoldenCase[];
}

const golden = JSON.parse(readFileSync(join(__dirname, "client-health-golden.json"), "utf8")) as Golden;
const now = new Date(golden.now);

describe("PV7-02 · client health rules: the golden table", () => {
  it.each(golden.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const verdict = evaluateClientHealth({ ...golden.base, ...c.input }, c.unavailable, now);
    expect(verdict).toEqual(c.expect);
  });

  it("the table's thresholds are the named constants the rules use", () => {
    expect(golden.thresholds).toEqual({
      atRiskWaitingOnUsDays: AT_RISK_WAITING_ON_US_DAYS,
      offTrackWaitingOnUsDays: OFF_TRACK_WAITING_ON_US_DAYS,
      atRiskWaitingOnClientDays: AT_RISK_WAITING_ON_CLIENT_DAYS,
      offTrackLateWorkDays: OFF_TRACK_LATE_WORK_DAYS,
      offTrackInvoiceOverdueDays: OFF_TRACK_INVOICE_OVERDUE_DAYS,
      offTrackSiteIncidentHours: OFF_TRACK_SITE_INCIDENT_HOURS,
    });
    // PV7-Q4, the lead's default: the numbers themselves.
    expect([7, 14, 14, 14, 30, 24]).toEqual([
      AT_RISK_WAITING_ON_US_DAYS, OFF_TRACK_WAITING_ON_US_DAYS, AT_RISK_WAITING_ON_CLIENT_DAYS,
      OFF_TRACK_LATE_WORK_DAYS, OFF_TRACK_INVOICE_OVERDUE_DAYS, OFF_TRACK_SITE_INCIDENT_HOURS,
    ]);
  });

  it("the table is not vacuous: every state and every reason code is exercised", () => {
    const states = new Set(golden.cases.map((c) => c.expect.state));
    expect([...states].sort()).toEqual(["at_risk", "off_track", "on_track", "quiet", "unknown"]);
    const codes = new Set(golden.cases.flatMap((c) => c.expect.reasons.map((r) => r.code)));
    expect([...codes].sort()).toEqual([
      "invoice_overdue", "invoice_overdue_30d", "late_work", "late_work_14d", "no_active_work", "site_incident_open",
      "site_incident_open_24h", "source_unavailable", "waiting_on_client_14d", "waiting_on_us_14d", "waiting_on_us_7d",
    ]);
  });

  it("each threshold is pinned on BOTH sides: a case just under it and a case at it", () => {
    // Moving a constant by one makes exactly one of these fail, which is what a golden table is for.
    const byName = (n: string) => golden.cases.find((c) => c.name === n)!;
    expect(byName("waiting on us 6 days 23 hours is not yet at risk").expect.state).toBe("on_track");
    expect(byName("waiting on us exactly 7 days is at risk").expect.state).toBe("at_risk");
    expect(byName("waiting on us 13 days is still at risk").expect.state).toBe("at_risk");
    expect(byName("waiting on us exactly 14 days is off track and is reported once").expect.state).toBe("off_track");
    expect(byName("waiting on the client 13 days is fine").expect.state).toBe("on_track");
    expect(byName("waiting on the client exactly 14 days is at risk, never off track").expect.state).toBe("at_risk");
    expect(byName("work 13 days late is at risk").expect.state).toBe("at_risk");
    expect(byName("work 14 days late is off track").expect.state).toBe("off_track");
    expect(byName("an invoice 29 days overdue is still at risk").expect.state).toBe("at_risk");
    expect(byName("an invoice 30 days overdue is off track").expect.state).toBe("off_track");
    expect(byName("a site incident open 23 hours is at risk").expect.state).toBe("at_risk");
    expect(byName("a site incident open 24 hours is off track").expect.state).toBe("off_track");
  });
});

describe("PV7-02 · client health rules: properties the table cannot show", () => {
  const base = golden.base;

  it("is pure: the same input gives the same verdict and the input is not mutated", () => {
    const input: HealthRuleInput = { ...base, waitingOnUs: { count: 2, oldestSince: "2026-10-01T12:00:00.000Z" } };
    const frozen = JSON.stringify(input);
    expect(evaluateClientHealth(input, ["site"], now)).toEqual(evaluateClientHealth(input, ["site"], now));
    expect(JSON.stringify(input)).toBe(frozen);
  });

  it("depends on `now` only through the argument", () => {
    const input: HealthRuleInput = { ...base, waitingOnUs: { count: 1, oldestSince: "2026-10-08T12:00:00.000Z" } };
    expect(evaluateClientHealth(input, [], now).state).toBe("at_risk");
    expect(evaluateClientHealth(input, [], new Date("2026-10-23T12:00:00.000Z")).state).toBe("off_track");
    expect(evaluateClientHealth(input, [], new Date("2026-10-09T12:00:00.000Z")).state).toBe("on_track");
  });

  it("an unparseable date counts as no age rather than throwing", () => {
    const input: HealthRuleInput = { ...base, waitingOnUs: { count: 1, oldestSince: "not a date" } };
    expect(evaluateClientHealth(input, [], now).state).toBe("on_track");
  });

  it("never returns a number-like score: a verdict is a state and reasons, nothing else", () => {
    const verdict = evaluateClientHealth(base, [], now);
    expect(Object.keys(verdict).sort()).toEqual(["reasons", "state"]);
  });
});
