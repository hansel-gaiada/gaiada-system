import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CLIENT_SIDE_KINDS, COULD_NOT_BE_LOADED, NOT_ENOUGH_YET, SOURCE_LABEL, STATE_LABEL, STATE_MEANING, TURNAROUND_KIND_LABEL,
  describeReason, formatDays, healthDate, isFinishedProjectStatus, reasonLabel, turnaroundSentence, turnaroundValue,
  type HealthReason, type HealthReasonCode, type HealthSource, type HealthState, type TurnaroundKind,
} from "./clientHealth";

// PV7-03 — the words for client health (BFF §54). The reason labels are pinned against the backend's golden table
// (`client-health-golden.json`), so a code the rules start to emit without a label here fails this file, not a page.

// Routed through a variable on purpose: a string-literal `new URL(..., import.meta.url)` is rewritten by Vite into a
// dev-server path (see clientCentre.test.ts), and `readFileSync` then refuses it.
function readFileAt(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const ALL_CODES: HealthReasonCode[] = [
  "waiting_on_us_7d", "waiting_on_us_14d", "waiting_on_client_14d", "late_work", "late_work_14d",
  "invoice_overdue", "invoice_overdue_30d", "site_incident_open", "site_incident_open_24h", "no_active_work", "source_unavailable",
];

interface GoldenCase { name: string; expect: { state: HealthState; reasons: HealthReason[] } }
const golden = JSON.parse(readFileAt("../../../platform-nest/src/modules/clients/client-health-golden.json")) as { cases: GoldenCase[] };

describe("reason labels", () => {
  it("every code in the golden table has a plain sentence, and the table uses only codes this file knows", () => {
    const used = new Set<string>();
    for (const c of golden.cases) for (const r of c.expect.reasons) used.add(r.code);
    expect([...used].sort()).toEqual([...used].filter((c) => ALL_CODES.includes(c as HealthReasonCode)).sort());
    for (const c of golden.cases) {
      for (const r of c.expect.reasons) {
        const label = reasonLabel(r);
        expect(typeof label, `${c.name}: ${r.code}`).toBe("string");
        expect(label.length).toBeGreaterThan(5);
        expect(label).not.toMatch(/undefined|NaN|null/);
        expect(label).not.toContain("_");
        const line = describeReason(r);
        expect(line.startsWith(label)).toBe(true);
      }
    }
  });

  it("all eleven codes of §54.2 are labelled, even those the golden table does not exercise", () => {
    for (const code of ALL_CODES) {
      const label = reasonLabel({ code, count: 2, since: null });
      expect(label, code).toBeTruthy();
    }
    // The 14-day and 7-day variants say their thresholds, so staff can read which tier fired.
    expect(reasonLabel({ code: "waiting_on_us_7d", count: 2, since: null })).toContain("7 days");
    expect(reasonLabel({ code: "waiting_on_us_14d", count: 2, since: null })).toContain("14 days");
    expect(reasonLabel({ code: "invoice_overdue_30d", count: 1, since: null })).toContain("30 days");
    expect(reasonLabel({ code: "site_incident_open_24h", count: 1, since: null })).toContain("24 hours");
  });

  it("counts are pluralised", () => {
    expect(reasonLabel({ code: "waiting_on_us_7d", count: 1, since: null })).toBe("1 item awaiting us for 7 days or more");
    expect(reasonLabel({ code: "waiting_on_us_7d", count: 3, since: null })).toBe("3 items awaiting us for 7 days or more");
    expect(reasonLabel({ code: "invoice_overdue", count: 1, since: null })).toBe("1 overdue invoice");
    expect(reasonLabel({ code: "source_unavailable", count: 2, since: null })).toBe("2 sources could not be read");
  });

  it("describeReason adds the family's oldest date in a pinned format, and nothing when there is none", () => {
    expect(describeReason({ code: "invoice_overdue", count: 1, since: "2026-09-20" })).toBe("1 overdue invoice (oldest 20 Sep 2026)");
    expect(describeReason({ code: "waiting_on_us_7d", count: 2, since: "2026-10-08T12:00:00.000Z" })).toBe("2 items awaiting us for 7 days or more (oldest 08 Oct 2026)");
    expect(describeReason({ code: "no_active_work", count: 0, since: null })).toBe("No active projects or services");
  });
});

describe("state labels", () => {
  const STATES: HealthState[] = ["on_track", "at_risk", "off_track", "quiet", "unknown"];
  it("every state has a label and a meaning; labels are sentence case, never upper-cased", () => {
    for (const s of STATES) {
      expect(STATE_LABEL[s]).toBeTruthy();
      expect(STATE_MEANING[s]).toBeTruthy();
      expect(STATE_LABEL[s]).not.toBe(STATE_LABEL[s].toUpperCase());
    }
    expect(STATES.map((s) => STATE_LABEL[s])).toEqual(["On track", "At risk", "Off track", "Quiet", "Unknown"]);
  });
  it("every health source and turnaround kind has a label", () => {
    const sources: HealthSource[] = ["projects", "ball", "milestones", "deliverables", "requests", "invoices", "site", "services", "modules", "projectHealth", "turnaround"];
    for (const s of sources) expect(SOURCE_LABEL[s], s).toBeTruthy();
    const kinds: TurnaroundKind[] = ["client_gate", "contract_signed", "post_review", "change_request_triage", "payment_confirmed", "conversation_reply"];
    for (const k of kinds) expect(TURNAROUND_KIND_LABEL[k], k).toBeTruthy();
    expect([...CLIENT_SIDE_KINDS].sort()).toEqual(["client_gate", "contract_signed", "post_review"]);
  });
});

describe("days and turnaround", () => {
  it("formats days with at most one decimal and the right plural", () => {
    expect(formatDays(1)).toBe("1 day");
    expect(formatDays(2)).toBe("2 days");
    expect(formatDays(2.5)).toBe("2.5 days");
    expect(formatDays(0.4)).toBe("0.4 days");
    expect(formatDays(0)).toBe("0 days");
    expect(formatDays(1.04)).toBe("1 day");
    expect(formatDays(3.26)).toBe("3.3 days");
  });

  it("a withheld side reads 'Not enough yet', a measured one reads days, a failed read reads 'Could not be loaded'", () => {
    expect(turnaroundValue({ medianDays: 2.5, withheld: false })).toBe("2.5 days");
    expect(turnaroundValue({ medianDays: null, withheld: true })).toBe(NOT_ENOUGH_YET);
    expect(turnaroundValue(null)).toBe(COULD_NOT_BE_LOADED);
    expect(turnaroundValue(undefined)).toBe(COULD_NOT_BE_LOADED);
  });

  it("never turns a null median into a number, even when `withheld` is false", () => {
    expect(turnaroundValue({ medianDays: null, withheld: false })).toBe(NOT_ENOUGH_YET);
  });

  it("the portal sentences", () => {
    expect(turnaroundSentence("You", { medianDays: 2, withheld: false })).toBe("You usually reply in 2 days");
    expect(turnaroundSentence("We", { medianDays: 1.5, withheld: false })).toBe("We usually reply in 1.5 days");
    expect(turnaroundSentence("We", { medianDays: null, withheld: true })).toBe("Not enough yet to say how quickly we reply");
    expect(turnaroundSentence("You", { medianDays: null, withheld: true })).toBe("Not enough yet to say how quickly you reply");
    expect(turnaroundSentence("You", null)).toBe("Could not be loaded");
  });
});

describe("healthDate and project status", () => {
  it("pins locale and zone, and never throws on nothing", () => {
    expect(healthDate("2026-10-15")).toBe("15 Oct 2026");
    expect(healthDate("2026-10-15T23:30:00.000Z")).toBe("15 Oct 2026");
    expect(healthDate(null)).toBe("—");
    expect(healthDate("not a date")).toBe("—");
  });
  it("finished statuses are the backend's non-active ones", () => {
    for (const s of ["completed", "complete", "archived", "cancelled", "Completed"]) expect(isFinishedProjectStatus(s), s).toBe(true);
    for (const s of ["active", "on_hold", "planning"]) expect(isFinishedProjectStatus(s), s).toBe(false);
  });
});
