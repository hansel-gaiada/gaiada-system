import { describe, it, expect } from "vitest";
import { isUuidShaped, parseSinceParam } from "./mailFilters";

// MAIL-34 — pins both crash paths this file closes. Pure functions, no I/O, no mocking needed.

describe("isUuidShaped", () => {
  it("accepts a well-formed uuid, case-insensitively", () => {
    expect(isUuidShaped("3fa85f64-5717-4562-b3fc-2c963f66afa6")).toBe(true);
    expect(isUuidShaped("3FA85F64-5717-4562-B3FC-2C963F66AFA6")).toBe(true);
  });

  it("rejects a non-uuid — the shape a hand-edited /admin/mail/<id> URL can carry", () => {
    expect(isUuidShaped("not-a-uuid")).toBe(false);
    expect(isUuidShaped("../../etc/passwd")).toBe(false);
    expect(isUuidShaped("")).toBe(false);
    expect(isUuidShaped("12345")).toBe(false);
  });
});

describe("parseSinceParam — MAIL-34 defect 1 (the crash one step before the BFF's own 400)", () => {
  it("empty/omitted stays absent and valid — the filter's default 'no since' state", () => {
    expect(parseSinceParam("")).toEqual({ invalid: false });
  });

  it("a real date string normalizes to an ISO instant, matching what the old `new Date(x).toISOString()` produced for the good case", () => {
    const result = parseSinceParam("2026-07-01");
    expect(result.invalid).toBe(false);
    expect(result.iso).toBe(new Date("2026-07-01").toISOString());
  });

  it("an unparseable value is flagged invalid WITHOUT throwing — `new Date(x).toISOString()` would RangeError here", () => {
    expect(() => parseSinceParam("not-a-date")).not.toThrow();
    expect(parseSinceParam("not-a-date")).toEqual({ invalid: true });
    expect(() => parseSinceParam("2026-13-99")).not.toThrow();
  });
});
