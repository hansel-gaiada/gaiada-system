import { describe, it, expect } from "vitest";
import { formatRelativeTime } from "./timeFormat";

describe("formatRelativeTime", () => {
  const NOW = new Date("2026-07-24T12:00:00.000Z").getTime();

  it("just now for < 1s", () => {
    expect(formatRelativeTime(NOW - 500, NOW)).toBe("just now");
    expect(formatRelativeTime(NOW, NOW)).toBe("just now");
  });

  it("seconds", () => {
    expect(formatRelativeTime(NOW - 30_000, NOW)).toBe("30s ago");
  });

  it("minutes", () => {
    expect(formatRelativeTime(NOW - 90_000, NOW)).toBe("1m ago");
  });

  it("hours", () => {
    expect(formatRelativeTime(NOW - 2 * 3_600_000, NOW)).toBe("2h ago");
  });

  it("days (under a week)", () => {
    expect(formatRelativeTime(NOW - 3 * 86_400_000, NOW)).toBe("3d ago");
  });

  it("falls back to a plain date at a week or more", () => {
    const result = formatRelativeTime(NOW - 8 * 86_400_000, NOW);
    expect(result).not.toMatch(/ago$/);
    expect(result).toMatch(/2026/);
  });

  it("non-finite input degrades to an em dash instead of throwing", () => {
    expect(formatRelativeTime(NaN, NOW)).toBe("—");
  });
});
