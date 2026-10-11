// WSK-61: WEBDESK_SCHEDULE_SUPERSEDE_GRACE_MS. Unset or "" (compose's `${VAR:-}`) means the default;
// anything else outside [1 min, 24 h] refuses boot, because a wrong grace either settles schedules
// before Zone B shows them (no staging rebuild) or never settles them, and neither looks broken.
import { describe, it, expect } from "vitest";
import { SCHEDULE_SUPERSEDE_GRACE_DEFAULT_MS, readScheduleSupersedeGraceMs } from "./config";

describe("readScheduleSupersedeGraceMs", () => {
  it("unset and empty mean the 15-minute default", () => {
    expect(SCHEDULE_SUPERSEDE_GRACE_DEFAULT_MS).toBe(15 * 60_000);
    expect(readScheduleSupersedeGraceMs(undefined)).toBe(SCHEDULE_SUPERSEDE_GRACE_DEFAULT_MS);
    expect(readScheduleSupersedeGraceMs("")).toBe(SCHEDULE_SUPERSEDE_GRACE_DEFAULT_MS);
    expect(readScheduleSupersedeGraceMs("   ")).toBe(SCHEDULE_SUPERSEDE_GRACE_DEFAULT_MS);
  });

  it("accepts an integer inside [60000, 86400000], both ends included", () => {
    expect(readScheduleSupersedeGraceMs("60000")).toBe(60_000);
    expect(readScheduleSupersedeGraceMs("1800000")).toBe(1_800_000);
    expect(readScheduleSupersedeGraceMs("86400000")).toBe(86_400_000);
  });

  it("THROWS (refuses boot) on anything else, never falling back silently", () => {
    for (const raw of ["0", "-1", "59999", "86400001", "15m", "abc", "900000.5", "NaN", "Infinity"]) {
      expect(() => readScheduleSupersedeGraceMs(raw), raw).toThrow(/WEBDESK_SCHEDULE_SUPERSEDE_GRACE_MS/);
    }
  });
});
