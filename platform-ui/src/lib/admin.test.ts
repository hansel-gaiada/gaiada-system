import { describe, it, expect } from "vitest";
import { formatUptime } from "./admin";

describe("formatUptime", () => {
  it("0 seconds -> 0m", () => {
    expect(formatUptime(0)).toBe("0m");
  });

  it("61 seconds -> 1m", () => {
    expect(formatUptime(61)).toBe("1m");
  });

  it("3661 seconds -> 1h 1m", () => {
    expect(formatUptime(3661)).toBe("1h 1m");
  });

  it("90061 seconds -> 1d 1h 1m", () => {
    expect(formatUptime(90061)).toBe("1d 1h 1m");
  });
});
