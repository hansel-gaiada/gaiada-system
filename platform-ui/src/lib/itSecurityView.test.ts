import { describe, it, expect } from "vitest";
import {
  ALERT_RULES, CONNECTION_WINDOWS, SIGN_IN_WINDOWS, agoFrom, alertLabel, blockEndedAs, countBySeverity, describeDevice,
  hoursPhrase, parseWindow, personOf, signInsStateWords,
} from "./itSecurityView";

// DW-7h: the small rules behind IT > Network. Pure, so they are pinned on their own.
describe("parseWindow", () => {
  it("takes a window the route accepts and falls back to the default for anything else (the server answers 400)", () => {
    expect(parseWindow("15m", CONNECTION_WINDOWS, "24h")).toBe("15m");
    expect(parseWindow("7d", SIGN_IN_WINDOWS, "24h")).toBe("7d");
    expect(parseWindow("15m", SIGN_IN_WINDOWS, "24h")).toBe("24h");
    expect(parseWindow(undefined, CONNECTION_WINDOWS, "24h")).toBe("24h");
    expect(parseWindow("1y", CONNECTION_WINDOWS, "24h")).toBe("24h");
    expect(parseWindow(["7d", "15m"], CONNECTION_WINDOWS, "24h")).toBe("7d");
  });
});

describe("agoFrom", () => {
  const asOf = "2026-10-15T09:00:00Z";
  it("measures from the server's own clock", () => {
    expect(agoFrom(asOf, "2026-10-15T08:59:40Z")).toBe("just now");
    expect(agoFrom(asOf, "2026-10-15T08:59:00Z")).toBe("1 minute ago");
    expect(agoFrom(asOf, "2026-10-15T08:30:00Z")).toBe("30 minutes ago");
    expect(agoFrom(asOf, "2026-10-15T07:00:00Z")).toBe("2 hours ago");
    expect(agoFrom(asOf, "2026-10-12T09:00:00Z")).toBe("3 days ago");
  });
  it("never says a negative time, and says so when it cannot tell", () => {
    expect(agoFrom(asOf, "2026-10-15T09:05:00Z")).toBe("just now");
    expect(agoFrom(asOf, null)).toBe("never");
    expect(agoFrom(asOf, "not a date")).toBe("unknown");
  });
});

describe("blocks", () => {
  it("tells lifted from run out: an expiry the server marked lifted at its own expiry is an expiry", () => {
    expect(blockEndedAs({ liftedAt: "2026-10-12T09:00:00Z", expiresAt: "2026-10-14T09:00:00Z" })).toBe("lifted");
    expect(blockEndedAs({ liftedAt: "2026-10-14T09:00:00Z", expiresAt: "2026-10-14T09:00:00Z" })).toBe("expired");
    expect(blockEndedAs({ liftedAt: null, expiresAt: "2026-10-14T09:00:00Z" })).toBe("expired");
  });
  it("words a duration", () => {
    expect([1, 24, 48, 168, 720].map(hoursPhrase)).toEqual(["1 hour", "24 hours", "2 days", "7 days", "30 days"]);
  });
});

describe("words", () => {
  it("describes a device by what the server could tell", () => {
    expect(describeDevice({ browser: "Chrome 126", os: "macOS 14", kind: "desktop" })).toBe("Chrome 126 on macOS 14");
    expect(describeDevice({ browser: "Chrome 126", os: "Unknown", kind: "desktop" })).toBe("Chrome 126");
    expect(describeDevice({ browser: "", os: "Android", kind: "mobile" })).toBe("Android");
    expect(describeDevice({ browser: "Unknown", os: "Unknown", kind: "unknown" })).toBe("Unknown browser");
  });
  it("names a person by name, then address, then id, never blank", () => {
    expect(personOf({ displayName: "Dewi", email: "d@x", userId: "u" })).toBe("Dewi");
    expect(personOf({ displayName: null, email: "d@x", userId: "u" })).toBe("d@x");
    expect(personOf({ userId: "u" })).toBe("u");
  });
  it("counts alerts by severity", () => {
    expect(countBySeverity([{ severity: "high" }, { severity: "low" }, { severity: "high" }])).toEqual({ high: 2, medium: 0, low: 1 });
  });
  it("labels a known alert rule and shows an unknown one by its code", () => {
    expect(alertLabel("new_device")).toBe(ALERT_RULES.new_device.label);
    expect(alertLabel("something_new")).toBe("something new");
  });
  it("words off and unavailable differently, and neither claims nobody signed in", () => {
    const off = signInsStateWords("off");
    const unavailable = signInsStateWords("unavailable", "role missing");
    expect(off.title).not.toBe(unavailable.title);
    for (const w of [off, unavailable]) expect(w.body).toMatch(/not a statement that nobody signed in/);
    expect(unavailable.body).toContain("role missing");
  });
});
