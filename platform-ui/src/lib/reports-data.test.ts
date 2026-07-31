import { describe, it, expect } from "vitest";
import { PlatformError } from "./platform";
import { isForbidden, isRangeTooLarge } from "./reports-data";

describe("reports-data — error classifiers (§15 ruling ③)", () => {
  it("isForbidden is true only for a real 403 PlatformError", () => {
    expect(isForbidden(new PlatformError(403, "forbidden"))).toBe(true);
    expect(isForbidden(new PlatformError(404, "not found"))).toBe(false);
    expect(isForbidden(new Error("nope"))).toBe(false);
    expect(isForbidden(null)).toBe(false);
  });

  it("isRangeTooLarge matches only a 422 whose message is the exact `range_too_large` code", () => {
    expect(isRangeTooLarge(new PlatformError(422, "range_too_large", "end"))).toBe(true);
    // the flat {error,field} shape means the message IS the machine-readable code (§15 ruling ③) —
    // a differently-worded 422 (e.g. a generic validation message) must NOT match.
    expect(isRangeTooLarge(new PlatformError(422, "Unprocessable Entity"))).toBe(false);
    expect(isRangeTooLarge(new PlatformError(400, "range_too_large"))).toBe(false);
    expect(isRangeTooLarge(new Error("range_too_large"))).toBe(false);
  });
});
