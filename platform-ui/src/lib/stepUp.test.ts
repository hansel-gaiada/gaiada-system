import { describe, it, expect } from "vitest";
import { ASSURANCE_REQUIRED, STEP_UP_TEXT, hhmm, isAssuranceRefusal, simulatedBadgeText } from "./stepUp";

// PV5-14 / PV-D40 — the simulated second factor's UI words and the refusal code.
describe("stepUp", () => {
  it("only the platform's assurance_required code is an assurance refusal", () => {
    expect(ASSURANCE_REQUIRED).toBe("assurance_required");
    expect(isAssuranceRefusal("assurance_required")).toBe(true);
    for (const r of [undefined, null, "", "step_up_staff_only", "tax_code_immutable"]) expect(isAssuranceRefusal(r)).toBe(false);
  });

  it("the badge reads 'Second factor simulated until HH:MM' while it lasts, and nothing after or without a time", () => {
    const now = Date.parse("2026-10-13T08:00:00Z");
    expect(simulatedBadgeText("2026-10-13T08:15:00Z", now)).toMatch(/^Second factor simulated until \d\d:\d\d$/);
    expect(simulatedBadgeText("2026-10-13T07:59:59Z", now)).toBeNull();
    expect(simulatedBadgeText(null, now)).toBeNull();
    expect(simulatedBadgeText("not a date", now)).toBeNull();
  });

  it("HH:MM is a 24-hour clock in the given locale", () => {
    expect(hhmm("2026-10-13T08:15:00Z", "en-GB")).toMatch(/^\d\d:\d\d$/);
    expect(hhmm("nope")).toBe("");
  });

  it("no text calls the simulation MFA or a real second factor", () => {
    for (const t of Object.values(STEP_UP_TEXT)) expect(t).not.toMatch(/\bMFA\b|real second factor/i);
    expect(STEP_UP_TEXT.button).toBe("Simulate second factor (dev stage)");
    expect(STEP_UP_TEXT.needs).toBe("This action needs a second factor");
  });
});
