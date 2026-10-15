// PV7-05 — the UI mirror of the client health rules, run against the SAME golden table as the backend
// (`platform-nest/src/modules/clients/client-health-golden.json`, BFF §54.3). Pure; runs anywhere.
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  AT_RISK_WAITING_ON_CLIENT_DAYS, AT_RISK_WAITING_ON_US_DAYS, OFF_TRACK_INVOICE_OVERDUE_DAYS, OFF_TRACK_LATE_WORK_DAYS,
  OFF_TRACK_SITE_INCIDENT_HOURS, OFF_TRACK_WAITING_ON_US_DAYS, evaluateClientHealth, type HealthRuleInput,
} from "./clientHealthRules";
import golden from "./clientHealthGolden.json";
import type { HealthReason, HealthSource, HealthState } from "./clientHealth";

// Same trick as clientCentre.test.ts: route the path through a variable so Vite leaves it a real file:// read.
function readFileAt(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

interface GoldenCase { name: string; input: Partial<HealthRuleInput>; unavailable: HealthSource[]; expect: { state: HealthState; reasons: HealthReason[] } }
const cases = golden.cases as unknown as GoldenCase[];
const base = golden.base as unknown as HealthRuleInput;
const now = new Date(golden.now);

describe("golden parity with platform-nest", () => {
  it("clientHealthGolden.json is byte-identical to the backend's client-health-golden.json", () => {
    const nestRaw = readFileAt("../../../platform-nest/src/modules/clients/client-health-golden.json");
    const uiRaw = readFileAt("./clientHealthGolden.json");
    expect(uiRaw).toBe(nestRaw);
  });
});

describe("PV7-05 · client health rules mirror: the golden table", () => {
  it("runs a table that is not empty", () => {
    expect(cases.length).toBeGreaterThanOrEqual(35);
  });

  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(evaluateClientHealth({ ...base, ...c.input }, c.unavailable, now)).toEqual(c.expect);
  });

  it("the table's thresholds are the mirror's named constants", () => {
    expect(golden.thresholds).toEqual({
      atRiskWaitingOnUsDays: AT_RISK_WAITING_ON_US_DAYS,
      offTrackWaitingOnUsDays: OFF_TRACK_WAITING_ON_US_DAYS,
      atRiskWaitingOnClientDays: AT_RISK_WAITING_ON_CLIENT_DAYS,
      offTrackLateWorkDays: OFF_TRACK_LATE_WORK_DAYS,
      offTrackInvoiceOverdueDays: OFF_TRACK_INVOICE_OVERDUE_DAYS,
      offTrackSiteIncidentHours: OFF_TRACK_SITE_INCIDENT_HOURS,
    });
  });

  it("is pure and returns only a state and reasons", () => {
    const input: HealthRuleInput = { ...base, waitingOnUs: { count: 2, oldestSince: "2026-10-01T12:00:00.000Z" } };
    const frozen = JSON.stringify(input);
    const a = evaluateClientHealth(input, ["site"], now);
    expect(a).toEqual(evaluateClientHealth(input, ["site"], now));
    expect(JSON.stringify(input)).toBe(frozen);
    expect(Object.keys(a).sort()).toEqual(["reasons", "state"]);
  });
});
